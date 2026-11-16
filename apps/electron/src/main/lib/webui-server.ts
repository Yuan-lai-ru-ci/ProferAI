/**
 * WebUI 的监听层：独立端口、独立网卡、独立凭据。
 *
 * 为什么要独立端口：
 *  - 之前与 Pocket 共用同一个 HTTP/WS 服务，导致「为了网页选 127.0.0.1」会连坐把手机端
 *    挡在门外；反过来，Pocket 的 0.0.0.0 又会让网页暴露在整片局域网。两个功能的安全诉求
 *    本来相反，不能靠一份监听配置同时满足。
 *  - 凭据也必须分开：网页链接是可以分享/收藏的，Pocket 凭据等同于这台机器的远控权。
 *
 * 但**命令层只有一份**：会话单写者、goal 状态机、事件日志都由 remote-service 提供，
 * 这里只负责把已鉴权的连接交给它（`attachRemoteSocket`，角色 webui → 命令白名单收口）。
 */
import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocketServer } from 'ws'
import { getAgentSessionMeta } from './agent-session-manager'
import { loadWebuiToken } from './remote-identity'
import { closeOwnedHttp, RemoteLifecycleQueue } from './remote-lifecycle'
import { equalSecret } from './remote-pairing'
import { acquireRemoteEventBus, attachRemoteSocket, registerRemoteClientSource, releaseRemoteEventBus } from './remote-service'
import { updateSettings } from './settings-service'
import { getDefaultWebuiPort, getWebuiConfig, resolveWebuiPort } from './webui-config'
import { isSessionServableForWebui } from './webui-session-guard'
import { handleWebuiHttpRequest } from './webui-service'

const lifecycle = new RemoteLifecycleQueue()

/** 端口被占时的顺延次数：与移动模式一致的做法，客户端不必改地址太多次。 */
const WEBUI_PORT_FALLBACK_COUNT = 3

let httpServer: HttpServer | null = null
let wss: WebSocketServer | null = null
let webuiToken: string | null = null
let activePort: number | null = null
let serviceError: string | null = null
/**
 * 本服务是否持有一份事件总线订阅。
 *
 * 订阅不能只挂在移动模式的监听流程上：用户可能只开 WebUI —— 那样网页能连上、能发消息，
 * 却收不到任何流式事件（表现为「发了没反应，刷新才看到结果」）。
 */
let eventBusAcquired = false

/** 广播要能找到网页连接：命令层遍历客户端时会把这里并进去。 */
registerRemoteClientSource(() => wss?.clients ?? [])

/** token 通过 query 传递（浏览器 WebSocket 不能自定义 header），与 Pocket ws-client 同一形态。 */
function readQueryToken(req: IncomingMessage): string | null {
  try {
    const url = new URL(req.url || '', 'http://localhost')
    const token = url.searchParams.get('token')
    if (token) return token
  } catch {
    /* 非法 URL 直接当作未授权 */
  }
  const header = req.headers['x-profer-token']
  return typeof header === 'string' ? header : null
}

function isAuthorizedRequest(req: IncomingMessage): boolean {
  if (!webuiToken) return false
  const token = readQueryToken(req)
  return token !== null && equalSecret(token, webuiToken)
}

export interface WebuiServiceStatus {
  running: boolean
  /** 实际监听端口（端口被占顺延后与设置值不同） */
  port: number
  /** 期望端口 / 默认端口，面板展示用 */
  configuredPort: number
  defaultPort: number
  bindHost: string
  token: string | null
  error: string | null
}

export function getWebuiServiceStatus(): WebuiServiceStatus {
  const config = getWebuiConfig()
  return {
    running: httpServer !== null && activePort !== null,
    port: activePort ?? config.port,
    configuredPort: config.port,
    defaultPort: getDefaultWebuiPort(),
    bindHost: config.bindHost,
    token: httpServer ? webuiToken : null,
    error: serviceError,
  }
}

/** 端口候选：首选 + 向后顺延，保证手机端地址长期稳定。 */
function portCandidates(preferred: number): number[] {
  const list: number[] = []
  for (let i = 0; i < WEBUI_PORT_FALLBACK_COUNT; i += 1) {
    const port = preferred + i
    if (port > 65535) break
    list.push(port)
  }
  return list
}

type ListenOutcome = { kind: 'listening' } | { kind: 'error'; code: string | null; message: string }

/**
 * 在指定端口上做一次监听尝试。
 * 端口冲突通过 error 事件返回，不向调用方抛异常 —— 设置页只能拿到一句可读的 error。
 */
function listenOnce(port: number, host: string): Promise<ListenOutcome> {
  return new Promise<ListenOutcome>((resolve) => {
    let settled = false
    const server = createServer((req, res) => {
      if ((req.url || '').split('?')[0] === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, service: 'webui' }))
        return
      }
      const handled = handleWebuiHttpRequest(req, res, {
        isAuthorized: isAuthorizedRequest,
        token: webuiToken,
        // 首屏 <title> 就用会话名：页面此时还没连上 WS，拿不到会话信息
        sessionTitle: (id) => getAgentSessionMeta(id)?.title,
        // 已归档/已删除的会话不该继续对外提供页面（白名单可能落后于会话状态）
        isSessionServable: isSessionServableForWebui,
      })
      if (handled) return
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('Not Found')
    })

    const socketServer = new WebSocketServer({ server, path: '/ws' })
    socketServer.on('connection', (ws, req) => {
      if (!isAuthorizedRequest(req)) {
        ws.close(4001, 'unauthorized')
        return
      }
      // 交给命令层：角色 webui → 只允许页面用到的命令，且限已发布会话。
      attachRemoteSocket(ws, req, { role: 'webui' })
    })

    const settle = (outcome: ListenOutcome): void => {
      if (settled) return
      settled = true
      server.removeListener('error', onError)
      resolve(outcome)
    }
    const onError = (error: NodeJS.ErrnoException): void => {
      // 监听失败时 wss 还没真正接管 socket，close 可能抛错：吞掉，交给下一次尝试新建
      try { socketServer.close() } catch { /* ignore */ }
      try { server.close() } catch { /* ignore */ }
      settle({ kind: 'error', code: error.code ?? null, message: error.message || '未知错误' })
    }
    server.once('error', onError)
    server.listen(port, host, () => {
      const address = server.address() as AddressInfo | null
      httpServer = server
      wss = socketServer
      activePort = address?.port ?? port
      serviceError = null
      console.log(`[WebUI] 服务已在 ${host}:${activePort} 就绪`)
      settle({ kind: 'listening' })
    })
  })
}

async function startNow(): Promise<void> {
  if (httpServer) return
  const config = getWebuiConfig()
  if (!config.enabled) return
  serviceError = null
  try {
    webuiToken = loadWebuiToken()
  } catch (error) {
    serviceError = error instanceof Error ? error.message : '安全存储失败'
    return
  }
  const preferred = resolveWebuiPort(config.port)
  let lastCode: string | null = null
  let lastMessage = ''
  for (const port of portCandidates(preferred)) {
    const outcome = await listenOnce(port, config.bindHost)
    if (outcome.kind === 'listening') {
      if (!eventBusAcquired) {
        acquireRemoteEventBus()
        eventBusAcquired = true
      }
      // 端口是顺延来的：回写设置，下次启动直接用同一个地址（否则复制出去的链接第二天失效）
      if (activePort !== null && activePort !== preferred && !process.env.PROFER_WEBUI_PORT) {
        try {
          updateSettings({ webuiPort: activePort })
        } catch (error) {
          console.warn('[WebUI] 保存端口失败:', error)
        }
      }
      return
    }
    lastCode = outcome.code
    lastMessage = outcome.message
    if (outcome.code !== 'EADDRINUSE') break
  }
  webuiToken = null
  activePort = null
  serviceError = lastCode === 'EADDRINUSE'
    ? `端口 ${preferred}${WEBUI_PORT_FALLBACK_COUNT > 1 ? `-${preferred + WEBUI_PORT_FALLBACK_COUNT - 1}` : ''} 均已被占用，请在设置中改用其他端口。`
    : `Web 会话服务启动失败：${lastMessage || '未知错误'}`
  console.error('[WebUI]', serviceError)
}

async function stopNow(): Promise<void> {
  const socketServer = wss
  wss = null
  for (const client of socketServer?.clients ?? []) {
    try { client.close(1001, 'service stopped') } catch { /* ignore */ }
    try { client.terminate() } catch { /* ignore */ }
  }
  try { socketServer?.close() } catch { /* ignore */ }
  const server = httpServer
  httpServer = null
  // 关监听同时清掉 keep-alive 连接，否则重启时会因为旧 socket 还在而占着端口。
  if (server) await closeOwnedHttp(server).catch(() => undefined)
  activePort = null
  // 停服后不再对外提供凭据：/s/<id> 会回 503（token 为空），不会拿着旧 token 继续放行。
  webuiToken = null
  if (eventBusAcquired) {
    releaseRemoteEventBus()
    eventBusAcquired = false
  }
}

/** 启动/重启/停止都串行化：设置页连点时不会出现两个监听抢同一端口。 */
export function startWebuiService(): Promise<void> {
  return lifecycle.run(async () => {
    await stopNow()
    await startNow()
  })
}

export function stopWebuiService(): Promise<void> {
  return lifecycle.run(stopNow)
}

export function restartWebuiService(): Promise<void> {
  return lifecycle.run(async () => {
    await stopNow()
    await startNow()
  })
}

/** 设置变了（网卡/端口/开关）之后按最新配置收敛一次；关闭时只停不启。 */
export function applyWebuiService(): Promise<void> {
  return lifecycle.run(async () => {
    await stopNow()
    if (getWebuiConfig().enabled) await startNow()
  })
}
