/**
 * Profer WebUI —— 「一个会话 = 一个网页」的静态托管层。
 *
 * 设计边界：
 *  - 不新建 HTTP 服务：remote-service 的 requestListener 在 /health 之后把请求转交这里，
 *    页面与 /ws 同源，因此无需 CORS、反向代理或混合内容豁免。
 *  - 不读写会话文件：会话内容、发消息、goal 全部走既有 WS 命令与主进程单写者。
 *  - 不 import remote-service（避免循环依赖）：启停 / 状态编排放在 settings-ipc。
 *  - 默认 0 个网页：开关默认关闭，且已发布会话注册表默认为空；
 *    /s/<id> 仅对白名单内的会话返回页面，其余一律 404。
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'
import { app } from 'electron'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { getSettings } from './settings-service'
import {
  buildPublishedUrls,
  listWebuiInterfaces,
  normalizeBindHost,
  normalizePublishedIds,
  pickAccessibleHost,
  resolveWebuiRoute,
  type WebuiNetworkInterface,
} from './webui-routing'

export interface WebuiConfig {
  enabled: boolean
  bindHost: string
  publishedSessionIds: string[]
}

export interface WebuiLocalState {
  config: WebuiConfig
  interfaces: WebuiNetworkInterface[]
  assetDir: string
  assetReady: boolean
}

export interface WebuiRequestContext {
  isAuthorized: (req: IncomingMessage) => boolean
  token: string | null
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
}

export function getWebuiConfig(): WebuiConfig {
  const settings = getSettings()
  return {
    enabled: settings.webuiEnabled === true,
    bindHost: normalizeBindHost(settings.webuiBindHost),
    publishedSessionIds: normalizePublishedIds(settings.webuiPublishedSessionIds),
  }
}

/**
 * 供 remote-service 决定监听地址。
 * WebUI 关闭时返回 null，保持 Pocket 原有 0.0.0.0 行为不变；
 * 环境变量 PROFER_REMOTE_HOST 仍由调用方优先处理。
 */
export function getWebuiBindHost(): string | null {
  const config = getWebuiConfig()
  return config.enabled ? config.bindHost : null
}

/** 静态产物目录：开发时可用 PROFER_WEBUI_DIR 直接指向 pocket/webui/dist，免去来回拷贝。 */
export function getWebuiAssetDir(): string {
  const override = process.env.PROFER_WEBUI_DIR?.trim()
  if (override) return resolve(override)
  if (app.isPackaged) return join(process.resourcesPath, 'webui')
  // main 由 esbuild 打包到 apps/electron/dist/main.cjs；另兼容直接跑 TS 的目录结构
  const primary = resolve(__dirname, '..', 'resources', 'webui')
  const fallback = resolve(__dirname, '..', '..', 'resources', 'webui')
  return [primary, fallback].find((dir) => existsSync(join(dir, 'index.html'))) ?? primary
}

export function getWebuiLocalState(): WebuiLocalState {
  const assetDir = getWebuiAssetDir()
  return {
    config: getWebuiConfig(),
    interfaces: listWebuiInterfaces(),
    assetDir,
    assetReady: existsSync(join(assetDir, 'index.html')),
  }
}

function escapeHtml(value: string): string {
  const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
  return value.replace(/[&<>"']/g, (char) => map[char] ?? char)
}

function buildRootPage(publishedIds: readonly string[], token: string): string {
  const items = publishedIds.length === 0
    ? '<li>当前没有已发布会话。请在 Profer「设置 → 远程连接 → Web 会话」里添加。</li>'
    : publishedIds.map((id) => `<li><a href="/s/${encodeURIComponent(id)}?token=${encodeURIComponent(token)}">${escapeHtml(id)}</a></li>`).join('')
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Profer Web 会话</title><style>body{font:14px/1.7 system-ui,sans-serif;background:#101214;color:#e8eaed;margin:0;padding:48px;max-width:720px}li{padding:6px 0}a{color:#7cc4a0}</style></head><body><h1>Profer Web 会话</h1><p>一个会话对应一个网页。只有已发布的会话可以访问。</p><ul>${items}</ul></body></html>`
}

/** 首屏种下的 HttpOnly cookie：页面抹掉 URL 上的 ?token= 后，刷新仍能通过鉴权。 */
function readCookieToken(req: IncomingMessage): string | null {
  const raw = req.headers.cookie
  if (!raw) return null
  for (const part of raw.split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    if (part.slice(0, index).trim() !== 'profer_webui_token') continue
    try {
      return decodeURIComponent(part.slice(index + 1).trim())
    } catch {
      return null
    }
  }
  return null
}

/** 首屏注入会话 id 与 token，页面随后用同源 defaultWsUrl() 连接 /ws。 */
function injectBoot(html: string, sessionId: string, token: string): string {
  const boot = JSON.stringify({ sessionId, token }).replace(/</g, '\\u003c')
  const script = `<script>window.__PROFER_WEBUI_BOOT__=${boot};</script>`
  return html.includes('<head>') ? html.replace('<head>', `<head>${script}`) : `${script}${html}`
}

/**
 * 处理 WebUI 的 HTTP 请求。返回 false 表示该路径不属于 WebUI，
 * 由 remote-service 继续走它原有的 404 逻辑。
 */
export function handleWebuiHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: WebuiRequestContext,
): boolean {
  const pathname = (req.url || '').split('?')[0] ?? '/'
  const config = getWebuiConfig()
  const route = resolveWebuiRoute(pathname, config.publishedSessionIds)
  if (route.kind === 'foreign') return false

  const reply = (status: number, body: string, type = 'text/plain; charset=utf-8', extra?: Record<string, string>): void => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...extra })
    res.end(body)
  }

  if (!config.enabled) {
    reply(404, 'Not Found')
    return true
  }
  if (!ctx.token) {
    reply(503, '访问令牌尚未生成，请稍后重试')
    return true
  }
  // 静态资源是公开的前端产物（JS/CSS 不含会话数据），浏览器加载 <script>/<link>
  // 不会带 token query 或自定义 header，因此这里不鉴权。
  // 真正的访问控制由 /s/<id> 白名单与 /ws 的 token 保证。
  const publicAsset = route.kind === 'asset'
  const authorized = readCookieToken(req) === ctx.token || ctx.isAuthorized(req)
  if (!publicAsset && !authorized) {
    reply(401, 'Unauthorized')
    return true
  }
  if (route.kind === 'invalid') {
    reply(404, 'Not Found')
    return true
  }
  if (route.kind === 'root') {
    reply(200, buildRootPage(config.publishedSessionIds, ctx.token), 'text/html; charset=utf-8')
    return true
  }

  const assetDir = getWebuiAssetDir()
  if (route.kind === 'session') {
    const indexPath = join(assetDir, 'index.html')
    if (!existsSync(indexPath)) {
      reply(503, 'WebUI 静态产物缺失：请把 profer-pocket/webui/dist 拷到 resources/webui，或设置 PROFER_WEBUI_DIR')
      return true
    }
    reply(
      200,
      injectBoot(readFileSync(indexPath, 'utf-8'), route.sessionId, ctx.token),
      'text/html; charset=utf-8',
      { 'set-cookie': `profer_webui_token=${encodeURIComponent(ctx.token)}; Path=/; HttpOnly; SameSite=Strict` },
    )
    return true
  }

  const fullPath = resolve(assetDir, route.relativePath)
  if (fullPath !== assetDir && !fullPath.startsWith(assetDir + sep)) {
    reply(403, 'Forbidden')
    return true
  }
  if (!existsSync(fullPath) || !statSync(fullPath).isFile()) {
    reply(404, 'Not Found')
    return true
  }
  res.writeHead(200, {
    'content-type': CONTENT_TYPES[extname(fullPath).toLowerCase()] ?? 'application/octet-stream',
    'cache-control': 'no-cache',
  })
  res.end(readFileSync(fullPath))
  return true
}

/** 供 settings-ipc 组装面板状态：只做纯拼装，不触发服务启停。 */
export function buildWebuiPublishedUrls(port: number, host: string, token: string | null) {
  const interfaces = listWebuiInterfaces()
  // 监听 0.0.0.0 时用第一张局域网网卡的地址展示，否则复制出来的 127.0.0.1 在手机上必然打不开。
  return buildPublishedUrls(getWebuiConfig().publishedSessionIds, port, host, token, pickAccessibleHost(interfaces))
}
