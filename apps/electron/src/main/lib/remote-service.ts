/**
 * Profer Remote Service — 平板版远程接入服务
 *
 * 目标：在不破坏现有桌面版的前提下，为「平板/手机等外部设备」提供
 * 一条独立的 HTTP + WebSocket 通道，用来传输 Agent 工作过程与用户输入，
 * 而非传输图像。
 *
 * 设计要点：
 *  1. 仅绑定 127.0.0.1（本机回环），外部设备通过电脑局域网 IP 访问；
 *  2. 简单 token 鉴权，防止局域网内他人误连；
 *  3. 通过唯一的 agentEventBus（agent-service 单例）订阅 Agent 工作流事件，
 *     广播给所有已连接的平板客户端 —— 对现有桌面版零侵入；
 *  4. 接收客户端指令：列会话 / 列渠道 / 新建会话 / 发送消息 / 停止任务 / 取历史；
 *  5. 显式开关控制：仅当环境变量 PROFER_REMOTE=1 或命令行参数 --tablet 时启动，
 *     默认不启动，确保桌面版行为零变化。
 *
 * 依赖说明：
 *  本文件使用 Node 原生 http/https + ws 库（已于 apps/electron 安装）。
 *  不依赖 Electron 主窗口 DOM，可在主进程侧独立运行。
 */

import { createServer, Server as HttpServer, IncomingMessage } from 'node:http'
import { readFileSync, existsSync, statSync, mkdirSync, writeFileSync } from 'node:fs'
import { basename, join, normalize } from 'node:path'
import { randomUUID } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import { WebSocketServer, WebSocket } from 'ws'
import { AddressInfo } from 'node:net'

import { agentEventBus, runAgentHeadless, stopAgent, isAgentSessionActive, updateAgentPermissionMode } from './agent-service'
import {
  listAgentSessions,
  getAgentSessionMeta,
  getAgentSessionMessages,
  getAgentSessionSDKMessages,
  createAgentSession,
  updateAgentSessionMeta,
} from './agent-session-manager'
import { getAgentSessionsDir } from './config-paths'
import { listSwitchableChannels, getEnabledModels } from './bridge-model-utils'
import { permissionService } from './agent-permission-service'
import { askUserService } from './agent-ask-user-service'
import { exitPlanService } from './agent-exit-plan-service'

/** 默认监听端口 */
export const DEFAULT_REMOTE_PORT = 7788

/** 平板 Web UI 静态资源根目录（指向 dist/renderer，涵盖 tablet 子目录与 assets） */
let staticRoot: string | null = null

/** tablet 首页相对于 staticRoot 的入口（dist/renderer/tablet/index.html） */
let tabletIndexRel = 'tablet'

/** 访问令牌（首次启动生成并持久化，或由环境变量指定） */
let accessToken: string | null = null

/** HTTP + WebSocket 服务实例 */
let httpServer: HttpServer | null = null
let wss: WebSocketServer | null = null

/** agentEventBus 订阅句柄 */
let eventBusUnsubscribe: (() => void) | null = null

/** 记录当前监听地址（用于启动日志提示） */
let listenAddress: string | null = null

/** 是否已执行启动检查（避免重复启动） */
let isStarted = false

/** token 持久化文件（config 目录） */
function getTokenFilePath(): string {
  return join(process.env.PROFER_CONFIG_DIR || '.profer-dev', 'remote-token.json')
}

/** 加载或生成访问令牌 */
function loadOrCreateToken(): string {
  if (process.env.PROFER_REMOTE_TOKEN) {
    return process.env.PROFER_REMOTE_TOKEN
  }
  const tokenPath = getTokenFilePath()
  try {
    if (existsSync(tokenPath)) {
      const raw = JSON.parse(readFileSync(tokenPath, 'utf-8'))
      if (raw?.token) return raw.token
    }
  } catch {
    /* 忽略，重新生成 */
  }
  const token = randomUUID().replace(/-/g, '')
  try {
    const { mkdirSync, writeFileSync } = require('node:fs')
    mkdirSync(process.env.PROFER_CONFIG_DIR || '.profer-dev', { recursive: true })
    writeFileSync(tokenPath, JSON.stringify({ token, createdAt: Date.now() }, null, 2), 'utf-8')
  } catch (e) {
    console.error('[Remote] 无法持久化 token:', e)
  }
  return token
}

/** 是否启用远程服务（显式开关） */
export function isRemoteEnabled(): boolean {
  if (process.env.PROFER_REMOTE === '1') return true
  return process.argv.includes('--tablet')
}

/** 解析监听端口 */
function getPort(): number {
  const p = process.env.PROFER_REMOTE_PORT
  if (p) {
    const n = Number(p)
    if (Number.isInteger(n) && n > 0 && n < 65536) return n
  }
  return DEFAULT_REMOTE_PORT
}

/** 解析静态根目录 */
function resolveStaticRoot(): string | null {
  // 优先环境变量
  if (process.env.PROFER_REMOTE_STATIC) {
    const explicit = process.env.PROFER_REMOTE_STATIC
    try {
      if (existsSync(join(explicit, 'index.html'))) {
        tabletIndexRel = '.'
        return explicit
      }
    } catch { /* ignore */ }
    return explicit
  }
  // 首选：独立 tablet 构建产物 dist/tablet（index.html + assets 同层）
  const candidates = [
    join(__dirname, 'tablet'),
    join(__dirname, '..', 'dist', 'tablet'),
    join(process.cwd(), 'apps', 'electron', 'dist', 'tablet'),
  ]
  for (const c of candidates) {
    try {
      if (existsSync(join(c, 'index.html'))) {
        tabletIndexRel = '.'
        return c
      }
    } catch {
      /* continue */
    }
  }
  // 回退：旧格式 dist/renderer 下的 tablet 子目录
  const oldCandidates = [
    join(__dirname, 'renderer'),
    join(__dirname, '..', 'dist', 'renderer'),
    join(process.cwd(), 'apps', 'electron', 'dist', 'renderer'),
  ]
  for (const c of oldCandidates) {
    try {
      if (existsSync(join(c, 'tablet', 'index.html'))) {
        tabletIndexRel = 'tablet'
        return c
      }
    } catch {
      /* continue */
    }
  }
  return null
}

/** 平板首页文件绝对路径 */
function getTabletIndexPath(): string | null {
  if (!staticRoot) return null
  return join(staticRoot, tabletIndexRel, 'index.html')
}

/**
 * 将请求 URL 路径安全映射到静态根目录下的文件，并处理平板首页入口。
 * 规则：
 *  - '/' 或 '/index.html'（根）→ tablet 首页（tablet/index.html）
 *  - 其余路径（如 /assets/x.js）→ 从静态根解析（assets 在 renderer 根）
 * 路径穿越防护：解析结果必须位于 staticRoot 内。
 */
function safeResolveStatic(rootPath: string, urlPath: string, tabletIndexRel2: string): string | null {
  let relative = decodeURIComponent(urlPath.split('?')[0])
  // 根路径或 index.html → tablet 首页
  if (relative === '/' || relative === '' || relative === '/index.html') {
    const home = join(rootPath, tabletIndexRel2, 'index.html')
    return existsSync(home) ? home : null
  }
  relative = relative.replace(/^\/+/m, '')
  const rootNorm = normalize(rootPath)
  const normalized = normalize(join(rootNorm, relative))
  if (normalized !== rootNorm && !normalized.startsWith(rootNorm + require('node:path').sep)) {
    return null
  }
  try {
    if (!existsSync(normalized)) return null
    if (statSync(normalized).isDirectory()) return null
  } catch {
    return null
  }
  return normalized
}

/** 生成静态文件响应体 */
function serveStatic(res: {
  writeHead: (code: number, headers: Record<string, string>) => void
  end: (body?: Uint8Array | Buffer | string) => void
}, urlPath: string): void {
  if (!staticRoot) {
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('平板 UI 未构建。请先运行 build:tablet，或通过 PROFER_REMOTE_STATIC 指定静态目录。')
    return
  }
  const rel = tabletIndexRel
  const filePath = safeResolveStatic(staticRoot, urlPath, rel)
  if (!filePath) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('Not Found')
    return
  }
  try {
    const data = readFileSync(filePath)
    const ext = filePath.split('.').pop() || ''
    const mimeMap: Record<string, string> = {
      html: 'text/html; charset=utf-8',
      js: 'text/javascript; charset=utf-8',
      css: 'text/css; charset=utf-8',
      json: 'application/json; charset=utf-8',
      svg: 'image/svg+xml',
      png: 'image/png',
      ico: 'image/x-icon',
      map: 'application/json',
      woff2: 'font/woff2',
      woff: 'font/woff',
      ttf: 'font/ttf',
    }
    res.writeHead(200, { 'content-type': mimeMap[ext] || 'application/octet-stream' })
    res.end(data)
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('Not Found')
  }
}

/** 校验 token（HTTP 或 WS 请求） */
function checkToken(req: IncomingMessage): boolean {
  if (!accessToken) return true // 未设置 token 时放行（fallback）
  const url = new URL(req.url || '', 'http://localhost')
  const queryToken = url.searchParams.get('token')
  if (queryToken === accessToken) return true
  const header = req.headers['x-profer-token']
  if (header === accessToken) return true
  // WS 使用的 header 形式
  if (header === accessToken) return true
  return false
}

// ===== 指令处理：平板客户端 → 主进程 Agent =====

/**
 * 从 SDK 消息对象提取文本（content 可为字符串或 [{type:'text'|'thinking', text|thinking}] 数组）。
 * 与平板前端 parseSdkMessage 保持一致；这里用于服务端把持久化 SDK 消息转成平板可读结构。
 */
function extractSdkText(m: Record<string, unknown>): string {
  const c = m.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) {
    let text = ''
    for (const b of c) {
      if (typeof b === 'string') { text += b; continue }
      if (typeof b === 'object' && b !== null) {
        const blk = b as Record<string, unknown>
        if (typeof blk.text === 'string') text += blk.text
        // thinking / tool_use / tool_result 不进入正文
      }
    }
    return text
  }
  if (typeof m.text === 'string') return m.text
  if (typeof m.message === 'string') return m.message
  return ''
}

/**
 * 把持久化 SDK 消息（getAgentSessionMessages 返回的原生结构）转成平板端可见消息。
 * 真实结构：{ type:'user'|'assistant', message:{ role, content:[{type:'text',text}] }, _createdAt }
 */
function sdkMessagesToViewMessages(rawMessages: Array<Record<string, unknown>>): Array<{
  id: string
  role: string
  content: string
  createdAt: number
  model?: string
}> {
  const out: Array<{ id: string; role: string; content: string; createdAt: number; model?: string }> = []
  for (const m of rawMessages) {
    let role: string | undefined
    let content: string = ''
    let model: string | undefined
    let ts = typeof m._createdAt === 'number' ? m._createdAt : Date.now()

    const outerType = m.type
    const inner = m.message && typeof m.message === 'object' ? (m.message as Record<string, unknown>) : null
    if (inner) {
      role = (inner.role as string) || (outerType as string)
      content = extractSdkText(inner)
      model = inner.model as string | undefined
    } else {
      role = outerType as string
      content = extractSdkText(m)
    }
    // 工具结果块(tool_result)角色标记为 user，但其内容是工具输出，通常不作为对话文本展示；
    // 这里对含 tool_result 且无文本的消息跳过，避免污染对话。
    const hasUserText = role === 'user' && content.trim().length > 0 && !content.includes('[tool_result')
    if (role !== 'assistant' && !hasUserText) continue
    if (!content && role !== 'assistant') continue
    out.push({
      id: (m.uuid as string) || `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      role: role === 'user' ? 'user' : 'assistant',
      content,
      createdAt: ts,
      model,
    })
  }
  return out
}
/** 轻量封装的 JSON 响应交互类型 */
type CommandResult =
  | { ok: true; data: unknown }
  | { ok: false; error: string }

/** 会话列表（脱敏，仅暴露平板端需要的字段） */
function buildSessionList() {
  return listAgentSessions().map((s) => ({
    id: s.id,
    title: s.title,
    channelId: s.channelId,
    modelId: s.modelId,
    workspaceId: s.workspaceId,
    // 与桌面 LeftSidebar 相同的父子 Agent 会话关联；仅用于树形导航，不暴露委派内容。
    parentSessionId: s.parentSessionId,
    sourceDelegationId: s.sourceDelegationId,
    agentRuntime: s.agentRuntime,
    permissionMode: s.permissionMode,
    updatedAt: s.updatedAt,
    pinned: s.pinned,
    archived: s.archived,
    active: isAgentSessionActive(s.id),
  }))
}

/** 渠道列表（脱敏，仅暴露平板端发消息需要的字段） */
function buildChannelList() {
  return listSwitchableChannels().map((c) => ({
    id: c.id,
    name: c.name,
    provider: c.provider,
    baseUrl: c.baseUrl,
    enabled: c.enabled,
    models: getEnabledModels(c).map((m) => ({ id: m.id, name: m.name, displayName: m.name })),
  }))
}

/** 处理来自平板客户端的一条 JSON 指令消息 */
async function handleCommand(message: string, requestId: unknown = null): Promise<CommandResult> {
  let parsed: { type?: string } & Record<string, unknown>
  try {
    parsed = JSON.parse(message)
  } catch {
    return { ok: false, error: '无效的 JSON' }
  }

  const type = parsed?.type as string
  switch (type) {
    case 'ping': {
      return { ok: true, data: { pong: true, time: Date.now() } }
    }

    case 'list_sessions': {
      return { ok: true, data: buildSessionList() }
    }

    case 'list_channels': {
      return { ok: true, data: buildChannelList() }
    }

    case 'get_pending_interactions': {
      const sessionId = parsed.sessionId as string | undefined
      const belongsToSession = (request: { sessionId: string }) => !sessionId || request.sessionId === sessionId
      return {
        ok: true,
        data: {
          permissions: permissionService.getPendingRequests().filter(belongsToSession),
          askUsers: askUserService.getPendingRequests().filter(belongsToSession),
          exitPlans: exitPlanService.getPendingRequests().filter(belongsToSession),
        },
      }
    }

    case 'respond_permission': {
      const requestId = parsed.requestId as string
      const behavior = parsed.behavior === 'allow' ? 'allow' : parsed.behavior === 'deny' ? 'deny' : null
      if (!requestId || !behavior) return { ok: false, error: '缺少有效 requestId 或 behavior' }
      const sessionId = permissionService.respondToPermission(requestId, behavior, parsed.alwaysAllow === true)
      if (!sessionId) return { ok: false, error: '权限请求不存在或已处理' }
      agentEventBus.emit(sessionId, { kind: 'profer_event', event: { type: 'permission_resolved', requestId, behavior } })
      return { ok: true, data: { sessionId } }
    }

    case 'respond_ask_user': {
      const requestId = parsed.requestId as string
      const answers = parsed.answers
      if (!requestId || !answers || typeof answers !== 'object' || Array.isArray(answers)) return { ok: false, error: '缺少有效 requestId 或 answers' }
      const sessionId = askUserService.respondToAskUser(requestId, answers as Record<string, string>)
      if (!sessionId) return { ok: false, error: '提问请求不存在或已处理' }
      agentEventBus.emit(sessionId, { kind: 'profer_event', event: { type: 'ask_user_resolved', requestId } })
      return { ok: true, data: { sessionId } }
    }

    case 'respond_exit_plan_mode': {
      const requestId = parsed.requestId as string
      const action = parsed.action as import('@profer/shared').ExitPlanModeAction
      if (!requestId || !['approve_auto', 'approve_edit', 'deny', 'feedback'].includes(action)) return { ok: false, error: '缺少有效 requestId 或 action' }
      const result = exitPlanService.respondToExitPlanMode({ requestId, action, feedback: typeof parsed.feedback === 'string' ? parsed.feedback : undefined })
      if (!result) return { ok: false, error: '计划审批不存在或已处理' }
      agentEventBus.emit(result.sessionId, { kind: 'profer_event', event: { type: 'exit_plan_mode_resolved', requestId } })
      if (result.targetMode) {
        updateAgentSessionMeta(result.sessionId, { permissionMode: result.targetMode })
        agentEventBus.emit(result.sessionId, { kind: 'profer_event', event: { type: 'permission_mode_changed', mode: result.targetMode } })
      }
      return { ok: true, data: { sessionId: result.sessionId } }
    }

    case 'get_sdk_messages': {
      const id = parsed.sessionId as string
      if (!id) return { ok: false, error: '缺少 sessionId' }
      // 返回原始 SDKMessage 数组，供桌面式 AgentMessages 渲染（与持久化格式一致）
      return { ok: true, data: getAgentSessionSDKMessages(id) }
    }

    case 'session_detail': {
      const id = parsed.sessionId as string
      if (!id) return { ok: false, error: '缺少 sessionId' }
      const meta = getAgentSessionMeta(id)
      if (!meta) return { ok: false, error: '会话不存在' }
      const messages = getAgentSessionMessages(id)
      return {
        ok: true,
        data: {
          meta: {
            id: meta.id,
            title: meta.title,
            channelId: meta.channelId,
            modelId: meta.modelId,
            agentRuntime: meta.agentRuntime,
            permissionMode: meta.permissionMode,
            active: isAgentSessionActive(id),
          },
          messages: sdkMessagesToViewMessages(messages as unknown as Array<Record<string, unknown>>),
        },
      }
    }

    case 'update_session_model': {
      const sessionId = parsed.sessionId as string
      const channelId = parsed.channelId as string
      const modelId = typeof parsed.modelId === 'string' ? parsed.modelId : undefined
      if (!sessionId || !channelId) return { ok: false, error: '缺少有效 sessionId 或 channelId' }
      if (isAgentSessionActive(sessionId)) return { ok: false, error: 'Agent 正在运行，完成后再切换模型' }
      if (!getAgentSessionMeta(sessionId)) return { ok: false, error: '会话不存在' }
      const channel = listSwitchableChannels().find((item) => item.id === channelId)
      if (!channel) return { ok: false, error: '渠道不可用或不存在' }
      if (modelId && !getEnabledModels(channel).some((model) => model.id === modelId)) return { ok: false, error: '模型不属于当前渠道或未启用' }
      const updated = updateAgentSessionMeta(sessionId, { channelId, modelId })
      return { ok: true, data: { channelId: updated.channelId, modelId: updated.modelId } }
    }

    case 'update_session_runtime': {
      const sessionId = parsed.sessionId as string
      const runtime = parsed.runtime === 'pi' ? 'pi' : parsed.runtime === 'claude' ? 'claude' : null
      if (!sessionId || !runtime) return { ok: false, error: '缺少有效 sessionId 或 runtime' }
      if (isAgentSessionActive(sessionId)) return { ok: false, error: 'Agent 正在运行，完成后再切换内核' }
      const meta = getAgentSessionMeta(sessionId)
      if (!meta) return { ok: false, error: '会话不存在' }
      const updated = updateAgentSessionMeta(sessionId, { agentRuntime: runtime })
      return { ok: true, data: { agentRuntime: updated.agentRuntime } }
    }

    case 'update_permission_mode': {
      const sessionId = parsed.sessionId as string
      const mode = parsed.mode as import('@profer/shared').ProferPermissionMode
      if (!sessionId || !['auto', 'plan', 'bypassPermissions'].includes(mode)) return { ok: false, error: '缺少有效 sessionId 或权限模式' }
      if (!getAgentSessionMeta(sessionId)) return { ok: false, error: '会话不存在' }
      const updated = updateAgentSessionMeta(sessionId, { permissionMode: mode })
      if (isAgentSessionActive(sessionId)) await updateAgentPermissionMode(sessionId, mode)
      agentEventBus.emit(sessionId, { kind: 'profer_event', event: { type: 'permission_mode_changed', mode } })
      return { ok: true, data: { permissionMode: updated.permissionMode } }
    }

    case 'upload_attachment': {
      const sessionId = parsed.sessionId as string
      const filename = typeof parsed.filename === 'string' ? basename(parsed.filename).replace(/[\\/]/g, '_') : ''
      const base64 = typeof parsed.base64 === 'string' ? parsed.base64 : ''
      if (!sessionId || !filename || !base64) return { ok: false, error: '缺少有效附件数据' }
      if (!getAgentSessionMeta(sessionId)) return { ok: false, error: '会话不存在' }
      const bytes = Buffer.from(base64, 'base64')
      if (bytes.length > 10 * 1024 * 1024) return { ok: false, error: '附件不能超过 10 MB' }
      const uploadDir = join(getAgentSessionsDir(), 'remote-uploads', sessionId)
      mkdirSync(uploadDir, { recursive: true })
      const targetPath = join(uploadDir, `${Date.now()}-${filename}`)
      writeFileSync(targetPath, bytes)
      return { ok: true, data: { filename, path: targetPath, size: bytes.length } }
    }

    case 'rename_session': {
      const sessionId = parsed.sessionId as string
      const title = typeof parsed.title === 'string' ? parsed.title.trim() : ''
      if (!sessionId || !title) return { ok: false, error: '缺少 sessionId 或 title' }
      const meta = updateAgentSessionMeta(sessionId, { title })
      if (!meta) return { ok: false, error: '会话不存在' }
      return { ok: true, data: { id: meta.id, title: meta.title } }
    }

    case 'create_session': {
      const title = (parsed.title as string) || undefined
      const channelId = parsed.channelId as string | undefined
      const workspaceId = parsed.workspaceId as string | undefined
      const modelId = parsed.modelId as string | undefined
      const meta = createAgentSession(title, channelId, workspaceId, modelId)
      return { ok: true, data: { sessionId: meta.id, title: meta.title } }
    }

    case 'send_message': {
      const sessionId = parsed.sessionId as string
      const userMessage = parsed.userMessage as string
      const channelId = parsed.channelId as string
      if (!sessionId || !userMessage) return { ok: false, error: '缺少 sessionId 或 userMessage' }
      if (!channelId) return { ok: false, error: '缺少 channelId（无法确定 API Key）' }
      const modelId = parsed.modelId as string | undefined
      const workspaceId = parsed.workspaceId as string | undefined

      // 异步执行，不阻塞 WS 响应；结果通过事件流返回
      void runAgentHeadless(
        { sessionId, userMessage, channelId, modelId, workspaceId, startedAt: Date.now() },
        {
          source: 'bridge',
          onError: () => {},
          onComplete: () => {},
          onTitleUpdated: () => {},
        },
      ).catch((e) => {
        console.error('[Remote] send_message 执行异常:', e)
      })
      return { ok: true, data: { accepted: true } }
    }

    case 'stop_agent': {
      const sessionId = parsed.sessionId as string
      if (!sessionId) return { ok: false, error: '缺少 sessionId' }
      stopAgent(sessionId)
      return { ok: true, data: { stopped: true } }
    }

    default: {
      return { ok: false, error: `未知指令: ${type}` }
    }
  }
}

// ===== 生命周期 =====

/**
 * 启动 Profer Remote Service。
 * 仅当 isRemoteEnabled() 为真时才会真正启动；否则为 no-op。
 * @returns 启动后的监听地址（未启用时返回 null）
 */
export function startRemoteService(): string | null {
  if (isStarted) return listenAddress
  if (!isRemoteEnabled()) {
    console.log('[Remote] 未启用（PROFER_REMOTE 未设置 且 无 --tablet）')
    return null
  }
  isStarted = true

  // 初始化 token
  accessToken = loadOrCreateToken()

  // 初始化静态根
  staticRoot = resolveStaticRoot()
  console.log(`[Remote] 平板 UI 静态目录: ${staticRoot || '(未构建)'}`)

  const port = getPort()
  httpServer = createServer((req, res) => {
    // 健康检查
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, time: Date.now() }))
      return
    }
    // 静态资源（token 表单页必须无鉴权可达，否则用户无法填写 token）。
    // 安全性由 WS /ws 连接的 token 鉴权保障（见下方 connection 处理）。
    serveStatic(res, req.url || '/')
  })

  wss = new WebSocketServer({ server: httpServer, path: '/ws' })

  wss.on('connection', (ws, req) => {
    // 鉴权：WS 连接同样校验 token（query 或 header）
    if (!checkToken(req)) {
      ws.close(4001, 'unauthorized')
      return
    }
    console.log('[Remote] 平板客户端已连接')

    // 收到指令
    ws.on('message', (raw) => {
      let reqId: unknown = null
      let body: string
      try {
        const parsed = JSON.parse(raw.toString())
        reqId = parsed?.requestId ?? null
        body = raw.toString()
      } catch {
        body = raw.toString()
      }
      void handleCommand(body, reqId).then((result) => {
        // 将指令响应作为 "command_result" 事件回给客户端
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({ kind: 'command_result', requestId: reqId, ...result }),
          )
        }
      })
    })

    ws.on('close', () => {
      console.log('[Remote] 平板客户端断开')
    })

    // 连接建立后推送一条握手
    ws.send(JSON.stringify({ kind: 'hello', serverTime: Date.now() }))
  })

  // 订阅 agentEventBus，把工作流事件广播给所有平板客户端
  eventBusUnsubscribe = agentEventBus.on((sessionId, payload) => {
    const frame = JSON.stringify({ kind: 'agent_event', sessionId, payload })
    for (const client of wss?.clients ?? []) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(frame)
      }
    }
  })

  // 监听地址：默认 0.0.0.0（局域网设备可访问，平板通过电脑局域网 IP:端口 访问）。
  // 安全性由 accessToken 鉴权保障。可用 PROFER_REMOTE_HOST 覆盖（如设为 127.0.0.1 即仅本机）。
  const HOST = process.env.PROFER_REMOTE_HOST || '0.0.0.0'
  httpServer.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[Remote] 端口 ${port} 被占用，请通过 PROFER_REMOTE_PORT 更换端口`)
    } else {
      console.error('[Remote] 服务错误:', err)
    }
  })

  httpServer.listen(port, HOST, () => {
    const addr = httpServer?.address() as AddressInfo | null
    const actualPort = addr?.port ?? port
    listenAddress = `http://127.0.0.1:${actualPort}`
    // 探测局域网 IP（仅供日志提示，不保证一定成功）
    let lanIp = '局域网IP'
    try {
      for (const name of Object.keys(networkInterfaces())) {
        for (const net of networkInterfaces()[name] || []) {
          if (net.family === 'IPv4' && !net.internal) { lanIp = net.address; break }
        }
        if (lanIp !== '局域网IP') break
      }
    } catch { /* ignore */ }
    console.log('\n════════════════════════════════════════════════════')
    console.log('[Remote] Profer 平板版已启动')
    console.log(`[Remote] 本机访问:  ${listenAddress}`)
    console.log(`[Remote] 平板访问:  http://${lanIp}:${actualPort}`)
    console.log(`[Remote] 访问 Token: ${accessToken}（首次在平板输入一次）`)
    console.log('════════════════════════════════════════════════════\n')
  })

  // Electron 主进程可能因 GUI/生命周期时序影响异步 bind，做一次就绪校验告警
  httpServer.on('listening', () => {
    console.log(`[Remote] 服务已在 ${HOST}:${port} 就绪`)
  })

  return listenAddress
}

/** 停止 Profer Remote Service */
export function stopRemoteService(): void {
  eventBusUnsubscribe?.()
  eventBusUnsubscribe = null
  try {
    wss?.close()
  } catch { /* ignore */ }
  wss = null
  try {
    httpServer?.close()
  } catch { /* ignore */ }
  httpServer = null
  isStarted = false
  listenAddress = null
  console.log('[Remote] 平板版服务已停止')
}
