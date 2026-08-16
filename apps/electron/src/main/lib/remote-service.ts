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
import { basename, join, normalize, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import WebSocket, { WebSocketServer, type RawData } from 'ws'
import type { AddressInfo } from 'node:net'
import { app } from 'electron'

import { agentEventBus, runAgentHeadless, stopAgent, isAgentSessionActive, updateAgentPermissionMode, queueAgentMessage, beginAgentSessionDeletion, endAgentSessionDeletion, stopAgentAndWait, rewindAgentSession } from './agent-service'
import { getUserProfile } from './user-profile-service'
import {
  listAgentSessions,
  getAgentSessionMeta,
  getAgentSessionMessages,
  getAgentSessionSDKMessages,
  createAgentSession,
  ensureProjectDraftAgentSession,
  updateAgentSessionMeta,
  deleteAgentSession,
  forkAgentSession,
  moveSessionToWorkspace,
  paginateSDKMessages,
  searchAgentSessionMessages,
} from './agent-session-manager'
import { getAgentSessionsDir, getConfigDir } from './config-paths'
import { getSettings } from './settings-service'
import { listAgentWorkspaces, createAgentWorkspace } from './agent-workspace-manager'
import { AgentSessionDeletionCoordinator } from './agent-session-deletion'
import { listSwitchableChannels, getEnabledModels } from './bridge-model-utils'
import { permissionService } from './agent-permission-service'
import { askUserService } from './agent-ask-user-service'
import { exitPlanService } from './agent-exit-plan-service'
import {
  listConversations,
  createConversation,
  getConversationMessages,
  getRecentMessages,
  updateConversationMeta,
  deleteConversation,
  deleteMessage,
  truncateMessagesFrom,
  updateContextDividers,
  searchConversationMessages,
} from './conversation-manager'
import { sendMessage, stopGeneration, generateTitle } from './chat-service'
import { saveAttachment, readAttachmentAsBase64, deleteAttachment } from './attachment-service'
import { chatEventBus } from './chat-stream-bus'

/** 正式版默认监听端口 */
export const DEFAULT_REMOTE_PORT = 7788

/** 开发模式默认监听端口：与正式版（7788）区分，避免与打包版实例并存时 EADDRINUSE */
export const DEV_DEFAULT_REMOTE_PORT = 7789

/** 平板 Web UI 静态资源根目录（指向 dist/renderer，涵盖 tablet 子目录与 assets） */
let staticRoot: string | null = null

/** tablet 首页相对于 staticRoot 的入口（dist/renderer/tablet/index.html） */
let tabletIndexRel = 'tablet'

/** 访问令牌（首次启动生成并持久化，或由环境变量指定） */
let accessToken: string | null = null

/**
 * 平板静态页 CSP。
 *  - index.html 含内联主题初始化脚本 + React inline style → 需 unsafe-inline；
 *  - 平板 WebSocket 连接同源（ws://host:port/ws）→ connect-src 需 ws:/wss:；
 *  - Markdown 代码高亮使用 shiki（oniguruma WASM），WebAssembly 编译在 CSP 中属于
 *    eval 类操作 → 必须加 'wasm-unsafe-eval'（仅放行 WASM，不放行 JS eval）。
 *    若缺此项，平板打开含代码块的会话会报 CompileError 且初始化链中断。
 * 仅作用于 remote-service 提供的静态资源；桌面版（vite/打包）不受影响。
 */
const TABLET_STATIC_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws: wss:;"

/** HTTP + WebSocket 服务实例 */
let httpServer: HttpServer | null = null
let wss: WebSocketServer | null = null

/** 闲置踢人定时器：定期扫描连接，清理长时间无任何入站消息（含 ping）的假死/僵尸连接。 */
let idleSweepTimer: ReturnType<typeof setInterval> | null = null

/** agentEventBus 订阅句柄 */
let eventBusUnsubscribe: (() => void) | null = null

/** chatEventBus 订阅句柄（Chat 流式事件 → WS chat_event 广播） */
let chatBusUnsubscribe: (() => void) | null = null

/** 记录当前监听地址（用于启动日志提示） */
let listenAddress: string | null = null

/** 是否已执行启动检查（避免重复启动） */
let isStarted = false

/** 由设置页在当前运行期显式开启；启动参数仍保持兼容。 */
let runtimeEnabled = false

/** 平板会话删除协调器：合并并发删除 + stop-and-wait 成功前绝不清理持久化数据（对齐桌面 IPC 语义） */
const agentSessionDeletionCoordinator = new AgentSessionDeletionCoordinator()

/**
 * send_message 幂等去重表：key = 客户端生成的 clientMessageId，value = 首次接收时间戳。
 * 平移板弱网下重连重放同一逻辑消息时，若该消息已处理过则直接返回 accepted，避免重复启动 run。
 * 有界：保留固定时间窗口（DEDUP_TTL_MS）内的记录，超时后清理，防止长跑内存无限增长。
 */
const SEND_MESSAGE_DEDUP_TTL_MS = 10 * 60 * 1000 // 10 分钟
const SEND_MESSAGE_DEDUP_MAX = 512 // 最大保留条数，超出时清理最早条目
const sendMessageDedup = new Map<string, number>()

/** 服务端闲置踢人阈值：超过此毫秒数无任何入站消息（含 ping）判定假死，terminate 连接。 */
const WS_IDLE_TIMEOUT_MS = 90 * 1000
/** 闲置扫描间隔。 */
const IDLE_SWEEP_INTERVAL_MS = 30 * 1000

/**
 * partial assistant 消息（Pi 的累计全文预览）合并窗口：
 * 连续到达的 partial 只广播窗口内最后一个，减少平板弱网/移动端的传输与渲染抖动。
 * Pi 的 partial 是同 UUID 覆盖式累计全文，final 完整消息总会在 result 前送达，
 * 中间 partial 丢弃不影响最终正确性。
 */
const PARTIAL_MERGE_WINDOW_MS = 60

/** 按 sessionId 的 partial 合并定时器；final/非 partial 到达时取消 pending，保证顺序与正确性。 */
const partialMergeTimers = new Map<string, ReturnType<typeof setTimeout>>()

/** 判断一个 agentEventBus payload 是否为 partial sdk_message（Pi 流式累计预览）。 */
function isPartialSdkPayload(payload: unknown): boolean {
  const p = payload as { kind?: string; message?: Record<string, unknown> } | null
  return p?.kind === 'sdk_message' && p.message?._partial === true
}

/** 真正把一条 agent_event 帧广播给所有已连接平板客户端。 */
function broadcastAgentFrame(sessionId: string, payload: unknown): void {
  const frame = JSON.stringify({ kind: 'agent_event', sessionId, payload })
  for (const client of wss?.clients ?? []) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(frame)
    }
  }
}

/**
 * agentEventBus → 平板 WS 的广播入口，带 partial 合并：
 * - partial sdk_message：合并到时间窗，只发最后一个（减少传输/渲染抖动）。
 * - 非 partial（含 final 完整消息）：先取消 pending 的 partial 再立即广播，
 *   确保 final 不被延迟到达的旧 partial 覆盖（renderer 按同 UUID 覆盖，顺序必须保证）。
 */
function broadcastAgentEvent(sessionId: string, payload: unknown): void {
  if (isPartialSdkPayload(payload)) {
    const existing = partialMergeTimers.get(sessionId)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      partialMergeTimers.delete(sessionId)
      broadcastAgentFrame(sessionId, payload)
    }, PARTIAL_MERGE_WINDOW_MS)
    partialMergeTimers.set(sessionId, timer)
    return
  }
  const pending = partialMergeTimers.get(sessionId)
  if (pending) {
    clearTimeout(pending)
    partialMergeTimers.delete(sessionId)
  }
  broadcastAgentFrame(sessionId, payload)
}

/**
 * send_message 幂等去重：返回 true 表示该 clientMessageId 已处理过（应静默接受，不重复 run）。
 * 首次见到则登记时间戳并顺带清理过期/超量条目（摊销式，避免每次全表扫描）。
 */
function isSendMessageDuplicate(clientMessageId: string): boolean {
  if (!clientMessageId) return false
  const now = Date.now()
  const seen = sendMessageDedup.get(clientMessageId)
  if (seen !== undefined && now - seen < SEND_MESSAGE_DEDUP_TTL_MS) {
    return true
  }
  // 登记 + 摊销清理：过期条目直接删；超量时删最早的一条（Map 迭代序即插入序）。
  if (sendMessageDedup.size >= SEND_MESSAGE_DEDUP_MAX) {
    const oldest = sendMessageDedup.keys().next().value
    if (oldest !== undefined) sendMessageDedup.delete(oldest)
  }
  sendMessageDedup.set(clientMessageId, now)
  return false
}

/** token 持久化文件（统一存配置目录，与 getConfigDir 一致；不再依赖进程 cwd） */
function getTokenFilePath(): string {
  return join(getConfigDir(), 'remote-token.json')
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
  // 迁移：旧版 token 写在 cwd 相对路径（PROFER_CONFIG_DIR 或 .profer-dev/remote-token.json），
  // 与配置目录不一致会导致换目录启动后重新生成 token。此处检测旧位置并原值迁移，避免平板重新输入。
  const legacyDir = process.env.PROFER_CONFIG_DIR?.trim() || '.profer-dev'
  if (resolve(legacyDir) !== getConfigDir()) {
    try {
      const legacyPath = join(legacyDir, 'remote-token.json')
      if (existsSync(legacyPath)) {
        const raw = JSON.parse(readFileSync(legacyPath, 'utf-8'))
        if (raw?.token) {
          mkdirSync(getConfigDir(), { recursive: true })
          writeFileSync(tokenPath, JSON.stringify({ token: raw.token, createdAt: raw.createdAt ?? Date.now(), migratedFrom: legacyPath }, null, 2), 'utf-8')
          return raw.token
        }
      }
    } catch {
      /* 忽略，继续生成新 token */
    }
  }
  const token = randomUUID().replace(/-/g, '')
  try {
    mkdirSync(getConfigDir(), { recursive: true })
    writeFileSync(tokenPath, JSON.stringify({ token, createdAt: Date.now() }, null, 2), 'utf-8')
  } catch (e) {
    console.error('[Remote] 无法持久化 token:', e)
  }
  return token
}

/** 是否启用远程服务（显式开关） */
export function isRemoteEnabled(): boolean {
  if (process.env.PROFER_REMOTE === '1') return true
  return runtimeEnabled || process.argv.includes('--tablet')
}

export interface RemoteServiceStatus {
  enabled: boolean
  running: boolean
  port: number
  /** 未显式配置时的默认端口（正式版 7788 / 开发版 7789） */
  defaultPort: number
  localUrl: string | null
  lanUrl: string | null
  token: string | null
  /** 最近一次启动失败原因；服务恢复后清空。 */
  error: string | null
}

let remoteError: string | null = null

function getLanUrl(port: number): string | null {
  try {
    for (const name of Object.keys(networkInterfaces())) {
      for (const net of networkInterfaces()[name] || []) {
        if (net.family === 'IPv4' && !net.internal) return `http://${net.address}:${port}`
      }
    }
  } catch { /* ignore */ }
  return null
}

/** 供设置页显示的最小连接状态；Token 仅在服务实际监听后返回。 */
export function getRemoteServiceStatus(): RemoteServiceStatus {
  const port = getPort()
  return {
    enabled: isRemoteEnabled(),
    running: isStarted && listenAddress !== null,
    port,
    defaultPort: getDefaultPort(),
    localUrl: listenAddress,
    lanUrl: listenAddress ? getLanUrl(port) : null,
    token: listenAddress ? accessToken : null,
    error: remoteError,
  }
}

/** 设置页运行时切换开关；不会修改启动参数。 */
export function setRemoteServiceEnabled(enabled: boolean): RemoteServiceStatus {
  runtimeEnabled = enabled
  if (enabled) startRemoteService()
  else stopRemoteService()
  return getRemoteServiceStatus()
}

/** 解析监听端口：设置页保存的端口优先，其次 PROFER_REMOTE_PORT 环境变量，最后默认 7788。 */
function getPort(): number {
  const saved = getSettings().tabletModePort
  if (saved) {
    if (Number.isInteger(saved) && saved > 0 && saved < 65536) return saved
  }
  const p = process.env.PROFER_REMOTE_PORT
  if (p) {
    const n = Number(p)
    if (Number.isInteger(n) && n > 0 && n < 65536) return n
  }
  return getDefaultPort()
}

/** 未显式配置时的默认端口：开发模式（未打包）用 7789，正式版用 7788，避免同时运行互相抢占端口 */
export function getDefaultPort(): number {
  return app.isPackaged ? DEFAULT_REMOTE_PORT : DEV_DEFAULT_REMOTE_PORT
}

/**
 * 热应用新端口：服务运行中则先停后启（保留启用状态，不改变启动参数）。
 * 服务未运行时仅返回当前状态（新端口会在下次启动时生效）。
 */
export function restartRemoteService(): RemoteServiceStatus {
  if (isStarted) {
    stopRemoteService()
    startRemoteService()
  }
  return getRemoteServiceStatus()
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
  // 首选（2026-08-05 起）：vite 多入口产物 dist/renderer/tablet。
  // 这是唯一权威产物 —— build:renderer 一次构建桌面+平板两套入口。
  // ⚠️ 之前 dist/tablet（vite.tablet.config.ts 独立构建）排在前面，
  // 曾出现陈旧独立产物长期抢占、平板一直加载旧 UI 的事故，故必须让多入口产物优先。
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
  // 弃用路径：独立构建产物 dist/tablet（仅兼容历史部署，新代码不应再生成）
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
  let relative = decodeURIComponent(urlPath.split('?')[0] ?? '')
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
    res.end('移动端 UI 未构建。请先运行 build:tablet，或通过 PROFER_REMOTE_STATIC 指定静态目录。')
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
    res.writeHead(200, {
      'content-type': mimeMap[ext] || 'application/octet-stream',
      // 消除 Electron “Insecure Content-Security-Policy” 警告（仅静态资源，含平板首页与 assets）
      'content-security-policy': TABLET_STATIC_CSP,
      // html 不缓存（dev 迭代频繁，避免平板 WebView 一直加载旧页面/旧 hash 包）；
      // hash 命名的 assets 天然不可变，缓存一年
      'cache-control': ext === 'html' ? 'no-cache' : 'public, max-age=31536000, immutable',
    })
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
  return header === accessToken
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

/** 单个会话对象（脱敏，仅暴露平板端需要的字段；与桌面 AgentSessionMeta 平板所需子集兼容）。
 * 注意：必须包含 id/updatedAt/title/pinned/archived/draft 等完整字段——桌面复用组件
 * （AgentView/LeftSidebar）按桌面 IPC 返回完整对象的契约处理 .then((updated) => updated.id)
 * 等；若缺字段（旧实现只回 { channelId, modelId }）会导致切换模型后列表不更新甚至
 * 在 Promise 回调里读 undefined.updatedAt 报错。
 */
function buildSessionItem(s: ReturnType<typeof listAgentSessions>[number]) {
  return {
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
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    pinned: s.pinned,
    archived: s.archived,
    draft: s.draft,
    active: isAgentSessionActive(s.id),
  }
}

/** 会话列表（脱敏，仅暴露平板端需要的字段） */
function buildSessionList() {
  return listAgentSessions(true).map(buildSessionItem)
}

/** 工作区（项目）列表（脱敏，仅暴露平板端侧栏渲染需要的字段；与桌面 AgentWorkspace 形状兼容） */
function buildWorkspaceList() {
  return listAgentWorkspaces().map((w) => ({
    id: w.id,
    name: w.name,
    slug: w.slug,
    type: w.type,
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
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
    // 桌面版后续引入的官方渠道标记（merge official channel health）与模型定价分组。
    // 缺 serverManaged 会让 ModelSelector 的 getChannelSource 把所有渠道都当作 self-configured，
    // 同名模型（如多个渠道的 gpt-5.6-terra）去重互相覆盖，导致模型列表缩水。
    serverManaged: c.serverManaged,
    models: getEnabledModels(c).map((m) => ({
      id: m.id,
      name: m.name,
      displayName: m.name,
      enabled: m.enabled,
      multiplier: m.multiplier,
      source: m.source,
    })),
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

    case 'delete_session': {
      const sessionId = typeof parsed.sessionId === 'string' ? parsed.sessionId : ''
      if (!sessionId) return { ok: false, error: '缺少 sessionId' }
      try {
        await agentSessionDeletionCoordinator.delete(sessionId, {
          beginDeletion: beginAgentSessionDeletion,
          endDeletion: endAgentSessionDeletion,
          stopAndWait: stopAgentAndWait,
          // 运行已完全结束后再撤销交互状态并删除持久化数据（与桌面 DELETE_SESSION IPC 同语义）
          clearState: (id) => {
            permissionService.clearSessionWhitelist(id)
            permissionService.clearSessionPending(id)
            askUserService.clearSessionPending(id)
            exitPlanService.clearSessionPending(id)
          },
          deleteSession: deleteAgentSession,
        })
        return { ok: true, data: { sessionId } }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : '删除会话失败' }
      }
    }

    case 'list_workspaces': {
      return { ok: true, data: buildWorkspaceList() }
    }

    case 'create_workspace': {
      const name = typeof parsed.name === 'string' ? parsed.name.trim() : ''
      if (!name) return { ok: false, error: '工作区名称必填' }
      try {
        const ws = createAgentWorkspace(name)
        return {
          ok: true,
          data: {
            id: ws.id,
            name: ws.name,
            slug: ws.slug,
            type: ws.type,
            createdAt: ws.createdAt,
            updatedAt: ws.updatedAt,
          },
        }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : '创建工作区失败' }
      }
    }

    case 'get_user_profile': {
      return { ok: true, data: getUserProfile() }
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
      const messages = getAgentSessionSDKMessages(id)
      // 分页参数存在时返回分页结构（移动端传输层懒加载）；否则返回原始数组（兼容旧端/全文加载）。
      const wantsPaged =
        parsed.before !== undefined ||
        parsed.targetMessages !== undefined
      if (!wantsPaged) {
        // 返回原始 SDKMessage 数组，供桌面式 AgentMessages 渲染（与持久化格式一致）
        return { ok: true, data: messages }
      }
      const page = paginateSDKMessages(messages, {
        before: typeof parsed.before === 'number' ? parsed.before : undefined,
        targetMessages: typeof parsed.targetMessages === 'number' ? parsed.targetMessages : undefined,
      })
      return { ok: true, data: page }
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
      return { ok: true, data: buildSessionItem(updated) }
    }

    case 'update_session_runtime': {
      const sessionId = parsed.sessionId as string
      const runtime = parsed.runtime === 'pi' ? 'pi' : parsed.runtime === 'claude' ? 'claude' : null
      if (!sessionId || !runtime) return { ok: false, error: '缺少有效 sessionId 或 runtime' }
      if (isAgentSessionActive(sessionId)) return { ok: false, error: 'Agent 正在运行，完成后再切换内核' }
      const meta = getAgentSessionMeta(sessionId)
      if (!meta) return { ok: false, error: '会话不存在' }
      const updated = updateAgentSessionMeta(sessionId, { agentRuntime: runtime })
      return { ok: true, data: buildSessionItem(updated) }
    }

    case 'update_permission_mode': {
      const sessionId = parsed.sessionId as string
      const mode = parsed.mode as import('@profer/shared').ProferPermissionMode
      if (!sessionId || !['auto', 'plan', 'bypassPermissions'].includes(mode)) return { ok: false, error: '缺少有效 sessionId 或权限模式' }
      if (!getAgentSessionMeta(sessionId)) return { ok: false, error: '会话不存在' }
      const updated = updateAgentSessionMeta(sessionId, { permissionMode: mode })
      if (isAgentSessionActive(sessionId)) await updateAgentPermissionMode(sessionId, mode)
      agentEventBus.emit(sessionId, { kind: 'profer_event', event: { type: 'permission_mode_changed', mode } })
      return { ok: true, data: buildSessionItem(updated) }
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
      return { ok: true, data: buildSessionItem(meta) }
    }

    case 'create_session': {
      const title = (parsed.title as string) || undefined
      const channelId = parsed.channelId as string | undefined
      const workspaceId = parsed.workspaceId as string | undefined
      const modelId = parsed.modelId as string | undefined
      const meta = createAgentSession(title, channelId, workspaceId, modelId)
      return { ok: true, data: { sessionId: meta.id, title: meta.title } }
    }

    // 语义对齐桌面 ensureProjectDraftAgentSession：项目已有草稿会话则复用（发过消息则晋升正式），否则创建
    case 'ensure_project_draft_session': {
      const workspaceId = parsed.workspaceId as string
      const channelId = parsed.channelId as string | undefined
      const modelId = parsed.modelId as string | undefined
      if (!workspaceId) return { ok: false, error: '缺少 workspaceId' }
      const meta = ensureProjectDraftAgentSession(
        workspaceId,
        channelId,
        modelId,
        getSettings().agentRuntime ?? 'claude',
      )
      return { ok: true, data: { sessionId: meta.id, title: meta.title, draft: meta.draft ?? true } }
    }

    case 'send_message': {
      const sessionId = parsed.sessionId as string
      const userMessage = parsed.userMessage as string
      const channelId = parsed.channelId as string
      if (!sessionId || !userMessage) return { ok: false, error: '缺少 sessionId 或 userMessage' }
      if (!channelId) return { ok: false, error: '缺少 channelId（无法确定 API Key）' }
      const modelId = parsed.modelId as string | undefined
      const workspaceId = parsed.workspaceId as string | undefined
      const clientMessageId = typeof parsed.clientMessageId === 'string' ? parsed.clientMessageId : ''

      // 弱网重连重放幂等：平板断线后按原 clientMessageId 重发同一逻辑消息，这里去重，避免重复启动 run。
      if (isSendMessageDuplicate(clientMessageId)) {
        return { ok: true, data: { accepted: true, deduped: true } }
      }

      // 异步执行，不阻塞 WS 响应；结果通过事件流返回。
      // onComplete 不再空置：orchestrator 会在 run 真正结束时回调「已持久化的完整消息列表」，
      // 这里把 completion 标记（携带最终消息 + 完成元数据）通过 agentEventBus 广播给平板，
      // 让平板端能确定性地拿到"结果已落盘"的完成信号，而不是只依赖 run_idle 的间接触发。
      void runAgentHeadless(
        { sessionId, userMessage, channelId, modelId, workspaceId, startedAt: Date.now() },
        {
          source: 'bridge',
          onError: () => {},
          onComplete: (_messages, opts) => {
            agentEventBus.emit(sessionId, {
              kind: 'profer_event',
              event: {
                type: 'run_completed',
                sessionId,
                stoppedByUser: opts?.stoppedByUser ?? false,
                startedAt: opts?.startedAt ?? Date.now(),
                resultSubtype: opts?.resultSubtype,
                resultErrors: opts?.resultErrors,
                backgroundTasksPending: opts?.backgroundTasksPending ?? false,
              },
            })
          },
          onTitleUpdated: () => {},
        },
      ).catch((e) => {
        console.error('[Remote] send_message 执行异常:', e)
      })
      return { ok: true, data: { accepted: true } }
    }

    // 分叉会话：从指定消息处创建新会话继续（对齐桌面 forkAgentSession IPC）。
    // 返回桌面同构会话元数据（AgentView fork 后 openSession 新会话 tab）。
    case 'fork_session': {
      const sessionId = typeof parsed.sessionId === 'string' ? parsed.sessionId : ''
      const upToMessageUuid = typeof parsed.upToMessageUuid === 'string' ? parsed.upToMessageUuid : undefined
      if (!sessionId) return { ok: false, error: '缺少 sessionId' }
      try {
        const meta = await forkAgentSession({ sessionId, upToMessageUuid })
        return { ok: true, data: buildSessionItem(meta) }
      } catch (error) {
        console.error('[Remote] fork_session 失败:', error)
        return { ok: false, error: error instanceof Error ? error.message : '分叉会话失败' }
      }
    }

    // 快照回退：同一会话内回退到指定点（恢复文件 + 截断对话；对齐桌面 REWIND_SESSION IPC）
    case 'rewind_session': {
      const sessionId = typeof parsed.sessionId === 'string' ? parsed.sessionId : ''
      const assistantMessageUuid = typeof parsed.assistantMessageUuid === 'string' ? parsed.assistantMessageUuid : ''
      if (!sessionId || !assistantMessageUuid) return { ok: false, error: '缺少 sessionId 或 assistantMessageUuid' }
      try {
        const result = await rewindAgentSession(sessionId, assistantMessageUuid)
        return { ok: true, data: result }
      } catch (error) {
        console.error('[Remote] rewind_session 失败:', error)
        return { ok: false, error: error instanceof Error ? error.message : '会话回退失败' }
      }
    }

    // 置顶/取消置顶（对齐桌面 TOGGLE_PIN：置顶时自动取消归档）
    case 'toggle_session_pin': {
      const sessionId = typeof parsed.sessionId === 'string' ? parsed.sessionId : ''
      if (!sessionId) return { ok: false, error: '缺少 sessionId' }
      const current = listAgentSessions(true).find((s) => s.id === sessionId)
      if (!current) return { ok: false, error: `Agent 会话不存在: ${sessionId}` }
      const newPinned = !current.pinned
      const updates: { pinned: boolean; archived?: boolean } = { pinned: newPinned }
      if (newPinned && current.archived) updates.archived = false
      return { ok: true, data: buildSessionItem(updateAgentSessionMeta(sessionId, updates)) }
    }

    // 归档/取消归档（对齐桌面 TOGGLE_ARCHIVE：归档时自动取消置顶）
    case 'toggle_session_archive': {
      const sessionId = typeof parsed.sessionId === 'string' ? parsed.sessionId : ''
      if (!sessionId) return { ok: false, error: '缺少 sessionId' }
      const current = listAgentSessions(true).find((s) => s.id === sessionId)
      if (!current) return { ok: false, error: `Agent 会话不存在: ${sessionId}` }
      const newArchived = !current.archived
      const updates: { archived: boolean; pinned?: boolean } = { archived: newArchived }
      if (newArchived && current.pinned) updates.pinned = false
      return { ok: true, data: buildSessionItem(updateAgentSessionMeta(sessionId, updates)) }
    }

    // 移动会话到项目（对齐桌面 MOVE_SESSION_TO_WORKSPACE：运行中拒绝）
    case 'move_session_to_workspace': {
      const sessionId = typeof parsed.sessionId === 'string' ? parsed.sessionId : ''
      const targetWorkspaceId = typeof parsed.targetWorkspaceId === 'string' ? parsed.targetWorkspaceId : ''
      if (!sessionId || !targetWorkspaceId) return { ok: false, error: '缺少 sessionId 或 targetWorkspaceId' }
      if (isAgentSessionActive(sessionId)) {
        await new Promise((r) => setTimeout(r, 500))
        if (isAgentSessionActive(sessionId)) return { ok: false, error: '会话正在运行中，请停止后再迁移' }
      }
      try {
        return { ok: true, data: buildSessionItem(moveSessionToWorkspace(sessionId, targetWorkspaceId)) }
      } catch (error) {
        console.error('[Remote] move_session_to_workspace 失败:', error)
        return { ok: false, error: error instanceof Error ? error.message : '移动会话失败' }
      }
    }

    // 设置会话推理档位（对齐桌面 UPDATE_SESSION_OPENAI_THINKING：null=恢复全局默认，运行中拒绝）
    case 'update_session_thinking_level': {
      const sessionId = typeof parsed.sessionId === 'string' ? parsed.sessionId : ''
      const level = parsed.level as string | null
      if (!sessionId) return { ok: false, error: '缺少 sessionId' }
      const validLevels = [null, 'off', 'minimal', 'low', 'medium', 'high', 'xhigh']
      if (level !== null && !validLevels.includes(level)) {
        return { ok: false, error: `无效的推理档位: ${String(level)}` }
      }
      if (!getAgentSessionMeta(sessionId)) return { ok: false, error: `Agent 会话不存在: ${sessionId}` }
      if (isAgentSessionActive(sessionId)) return { ok: false, error: 'Agent 正在运行，完成后再切换推理档位' }
      return { ok: true, data: buildSessionItem(updateAgentSessionMeta(sessionId, { openAIThinkingLevel: level as import('@profer/shared').AgentThinkingLevel | null })) }
    }

    // 队列消息：向正在运行的 Agent 注入（interrupt=true 时软打断当前 turn 立即插入）。
    // 桌面端 queueAgentMessage IPC 的等价物；会话未运行时返回 "会话未运行" 错误，
    // 平板端 stub 据此降级为 send_message 新建 run（与桌面 isQueueTargetNoLongerActiveError 一致）。
    case 'queue_message': {
      const sessionId = parsed.sessionId as string
      const userMessage = typeof parsed.userMessage === 'string' ? parsed.userMessage : ''
      if (!sessionId || !userMessage) return { ok: false, error: '缺少 sessionId 或 userMessage' }
      try {
        const uuid = await queueAgentMessage(
          {
            sessionId,
            userMessage,
            rawUserMessage: typeof parsed.rawUserMessage === 'string' ? parsed.rawUserMessage : undefined,
            uuid: typeof parsed.uuid === 'string' ? parsed.uuid : undefined,
            interrupt: parsed.interrupt === true,
            mentionedSkills: Array.isArray(parsed.mentionedSkills) ? parsed.mentionedSkills as string[] : undefined,
            mentionedMcpServers: Array.isArray(parsed.mentionedMcpServers) ? parsed.mentionedMcpServers as string[] : undefined,
            mentionedSessionIds: Array.isArray(parsed.mentionedSessionIds) ? parsed.mentionedSessionIds as string[] : undefined,
          } as import('@profer/shared').AgentQueueMessageInput,
          // 桌面 IPC 的 webContents 仅用于把事件转发到渲染进程；平板走 EventBus → WS，无需指定
          null as never,
        )
        return { ok: true, data: { accepted: true, uuid } }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    }

    case 'stop_agent': {
      const sessionId = parsed.sessionId as string
      if (!sessionId) return { ok: false, error: '缺少 sessionId' }
      stopAgent(sessionId)
      return { ok: true, data: { stopped: true } }
    }

    // ===== Chat（聊天工具）指令 =====

    case 'list_conversations': {
      return { ok: true, data: listConversations(true) }
    }

    case 'create_conversation': {
      const title = typeof parsed.title === 'string' ? parsed.title : undefined
      const modelId = typeof parsed.modelId === 'string' ? parsed.modelId : undefined
      const channelId = typeof parsed.channelId === 'string' ? parsed.channelId : undefined
      const meta = createConversation(title, modelId, channelId)
      return { ok: true, data: meta }
    }

    case 'get_conversation_messages': {
      const id = parsed.conversationId as string
      if (!id) return { ok: false, error: '缺少 conversationId' }
      if (!listConversations(true).some((c) => c.id === id)) return { ok: false, error: '对话不存在' }
      return { ok: true, data: getConversationMessages(id) }
    }

    case 'get_recent_messages': {
      const id = parsed.conversationId as string
      const limit = Number.isInteger(parsed.limit) ? (parsed.limit as number) : 50
      if (!id) return { ok: false, error: '缺少 conversationId' }
      if (!listConversations(true).some((c) => c.id === id)) return { ok: false, error: '对话不存在' }
      return { ok: true, data: getRecentMessages(id, Math.max(1, Math.min(500, limit))) }
    }

    case 'update_conversation_title': {
      const id = parsed.conversationId as string
      const title = typeof parsed.title === 'string' ? parsed.title.trim() : ''
      if (!id || !title) return { ok: false, error: '缺少 conversationId 或 title' }
      if (!listConversations(true).some((c) => c.id === id)) return { ok: false, error: '对话不存在' }
      return { ok: true, data: updateConversationMeta(id, { title }) }
    }

    case 'update_conversation_model': {
      const id = parsed.conversationId as string
      const modelId = typeof parsed.modelId === 'string' ? parsed.modelId : undefined
      const channelId = typeof parsed.channelId === 'string' ? parsed.channelId : undefined
      if (!id) return { ok: false, error: '缺少 conversationId' }
      if (!listConversations(true).some((c) => c.id === id)) return { ok: false, error: '对话不存在' }
      return { ok: true, data: updateConversationMeta(id, { modelId, channelId }) }
    }

    case 'delete_conversation': {
      const id = parsed.conversationId as string
      if (!id) return { ok: false, error: '缺少 conversationId' }
      if (!listConversations(true).some((c) => c.id === id)) return { ok: false, error: '对话不存在' }
      deleteConversation(id)
      return { ok: true, data: { deleted: true } }
    }

    case 'toggle_conversation_pin': {
      const id = parsed.conversationId as string
      if (!id) return { ok: false, error: '缺少 conversationId' }
      const current = listConversations(true).find((c) => c.id === id)
      if (!current) return { ok: false, error: '对话不存在' }
      const newPinned = !current.pinned
      const updates: { pinned: boolean; archived?: boolean } = { pinned: newPinned }
      if (newPinned && current.archived) updates.archived = false
      return { ok: true, data: updateConversationMeta(id, updates) }
    }

    case 'toggle_conversation_archive': {
      const id = parsed.conversationId as string
      if (!id) return { ok: false, error: '缺少 conversationId' }
      const current = listConversations(true).find((c) => c.id === id)
      if (!current) return { ok: false, error: '对话不存在' }
      const newArchived = !current.archived
      const updates: { archived: boolean; pinned?: boolean } = { archived: newArchived }
      if (newArchived && current.pinned) updates.pinned = false
      return { ok: true, data: updateConversationMeta(id, updates) }
    }

    case 'search_chat_messages': {
      const query = typeof parsed.query === 'string' ? parsed.query.trim() : ''
      if (!query) return { ok: false, error: '缺少查询词' }
      return { ok: true, data: searchConversationMessages(query) }
    }

    case 'search_agent_session_messages': {
      const query = typeof parsed.query === 'string' ? parsed.query.trim() : ''
      if (!query) return { ok: false, error: '缺少查询词' }
      try {
        return { ok: true, data: await searchAgentSessionMessages(query) }
      } catch (e) {
        return { ok: false, error: String(e) }
      }
    }

    case 'chat_send_message': {
      const conversationId = parsed.conversationId as string
      const userMessage = typeof parsed.userMessage === 'string' ? parsed.userMessage : ''
      const channelId = parsed.channelId as string
      if (!conversationId || !userMessage) return { ok: false, error: '缺少 conversationId 或 userMessage' }
      if (!channelId) return { ok: false, error: '缺少 channelId（无法确定 API Key）' }
      if (!listConversations(true).some((c) => c.id === conversationId)) return { ok: false, error: '对话不存在' }
      // 异步执行，不阻塞 WS 响应；流式事件通过 chat_event 推回客户端
      void sendMessage(
        {
          conversationId,
          userMessage,
          messageHistory: [],
          channelId,
          modelId: parsed.modelId as string,
          contextLength: typeof parsed.contextLength === 'number' ? parsed.contextLength : undefined,
          contextDividers: Array.isArray(parsed.contextDividers) ? parsed.contextDividers as string[] : undefined,
          attachments: Array.isArray(parsed.attachments) ? parsed.attachments as never : undefined,
          knowledgeReferences: Array.isArray(parsed.knowledgeReferences) ? parsed.knowledgeReferences as never : undefined,
          thinkingEnabled: parsed.thinkingEnabled === true ? true : undefined,
          systemMessage: typeof parsed.systemMessage === 'string' ? parsed.systemMessage : undefined,
          enabledToolIds: Array.isArray(parsed.enabledToolIds) ? parsed.enabledToolIds as string[] : undefined,
        },
        null,
      ).catch((e) => {
        console.error('[Remote] chat_send_message 执行异常:', e)
      })
      return { ok: true, data: { accepted: true } }
    }

    case 'chat_stop_generation': {
      const conversationId = parsed.conversationId as string
      if (!conversationId) return { ok: false, error: '缺少 conversationId' }
      stopGeneration(conversationId)
      return { ok: true, data: { stopped: true } }
    }

    case 'chat_delete_message': {
      const conversationId = parsed.conversationId as string
      const messageId = parsed.messageId as string
      if (!conversationId || !messageId) return { ok: false, error: '缺少 conversationId 或 messageId' }
      if (!listConversations(true).some((c) => c.id === conversationId)) return { ok: false, error: '对话不存在' }
      return { ok: true, data: deleteMessage(conversationId, messageId) }
    }

    case 'chat_truncate_messages_from': {
      const conversationId = parsed.conversationId as string
      const messageId = parsed.messageId as string
      if (!conversationId || !messageId) return { ok: false, error: '缺少 conversationId 或 messageId' }
      if (!listConversations(true).some((c) => c.id === conversationId)) return { ok: false, error: '对话不存在' }
      return { ok: true, data: truncateMessagesFrom(conversationId, messageId, parsed.preserveFirstMessageAttachments === true) }
    }

    case 'chat_update_context_dividers': {
      const conversationId = parsed.conversationId as string
      const dividers = Array.isArray(parsed.dividers) ? parsed.dividers as string[] : null
      if (!conversationId || !dividers) return { ok: false, error: '缺少 conversationId 或 dividers' }
      if (!listConversations(true).some((c) => c.id === conversationId)) return { ok: false, error: '对话不存在' }
      return { ok: true, data: updateContextDividers(conversationId, dividers) }
    }

    case 'chat_generate_title': {
      const userMessage = typeof parsed.userMessage === 'string' ? parsed.userMessage : ''
      const channelId = parsed.channelId as string
      const modelId = parsed.modelId as string
      if (!userMessage || !channelId || !modelId) return { ok: false, error: '缺少 userMessage / channelId / modelId' }
      return { ok: true, data: await generateTitle({ userMessage, channelId, modelId }) }
    }

    case 'chat_save_attachment': {
      const conversationId = parsed.conversationId as string
      const filename = typeof parsed.filename === 'string' ? parsed.filename : ''
      const mediaType = typeof parsed.mediaType === 'string' ? parsed.mediaType : ''
      const data = typeof parsed.data === 'string' ? parsed.data : ''
      if (!conversationId || !filename || !mediaType || !data) return { ok: false, error: '缺少附件数据' }
      if (!listConversations(true).some((c) => c.id === conversationId)) return { ok: false, error: '对话不存在' }
      try {
        return { ok: true, data: saveAttachment({ conversationId, filename, mediaType, data }) }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : '附件保存失败' }
      }
    }

    case 'chat_delete_attachment': {
      const localPath = parsed.localPath as string
      if (!localPath) return { ok: false, error: '缺少 localPath' }
      try {
        deleteAttachment(localPath)
        return { ok: true, data: { deleted: true } }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : '附件删除失败' }
      }
    }

    case 'chat_read_attachment': {
      const localPath = parsed.localPath as string
      if (!localPath) return { ok: false, error: '缺少 localPath' }
      try {
        return { ok: true, data: readAttachmentAsBase64(localPath) }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : '附件读取失败' }
      }
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
  remoteError = null

  // 初始化 token
  accessToken = loadOrCreateToken()

  // 初始化静态根
  staticRoot = resolveStaticRoot()
  console.log(`[Remote] 移动端 UI 静态目录: ${staticRoot || '(未构建)'}`)

  const port = getPort()
  httpServer = createServer((req, res) => {
    // 健康检查（容忍 query，如 /health?token=xxx）
    if ((req.url || '').split('?')[0] === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, time: Date.now() }))
      return
    }
    // 静态资源（token 表单页必须无鉴权可达，否则用户无法填写 token）。
    // 安全性由 WS /ws 连接的 token 鉴权保障（见下方 connection 处理）。
    serveStatic(res, req.url || '/')
  })

  wss = new WebSocketServer({ server: httpServer, path: '/ws' })

  // 闲置踢人：定期扫描，清除长时间（含心跳 ping）无任何活跃的假死连接。
  // 平板 WebView 可能因网络切换/后台冻结形成半开连接，TCP 不报错但不再通信；
  // 不清理会让这些连接永久占用，且客户端也因无 pong 而无法自愈。
  if (idleSweepTimer) clearInterval(idleSweepTimer)
  idleSweepTimer = setInterval(() => {
    const now = Date.now()
    for (const client of wss?.clients ?? []) {
      const c = client as WebSocket & { __lastAlive?: number }
      if (c.__lastAlive !== undefined && now - c.__lastAlive > WS_IDLE_TIMEOUT_MS) {
        try { c.terminate() } catch { /* ignore */ }
      }
    }
  }, IDLE_SWEEP_INTERVAL_MS)
  if (typeof idleSweepTimer?.unref === 'function') idleSweepTimer.unref()

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    // 鉴权：WS 连接同样校验 token（query 或 header）
    if (!checkToken(req)) {
      ws.close(4001, 'unauthorized')
      return
    }
    console.log('[Remote] 平板客户端已连接')
    ;(ws as WebSocket & { __lastAlive?: number }).__lastAlive = Date.now()

    // 收到指令
    ws.on('message', (raw: RawData) => {
      let reqId: unknown = null
      let body: string
      let parsedRaw: { type?: unknown } | null = null
      try {
        const parsed = JSON.parse(raw.toString())
        parsedRaw = parsed
        // 命令追踪 ID：优先 _cmdId（平板 ws-client 新协议），兼容旧的 requestId
        reqId = parsed?._cmdId ?? parsed?.requestId ?? null
        body = raw.toString()
      } catch {
        body = raw.toString()
      }
      // 更新存活时间（任何入站消息都算活跃，用于服务端闲置踢人）。
      ;(ws as WebSocket & { __lastAlive?: number }).__lastAlive = Date.now()

      // 心跳 ping：不回 command_result（避免 command_result 走 FIFO 兑底污染 pendingCommands），
      // 直接回一个明确的 pong 帧，客户端据此做假死检测。
      if (parsedRaw?.type === 'ping') {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ kind: 'pong', serverTime: Date.now() }))
        }
        return
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
    broadcastAgentEvent(sessionId, payload)
  })

  // 订阅 chatEventBus，把 Chat 流式事件（chunk/reasoning/complete/error/tool-activity）
  // 广播给所有平板客户端；channel 使用桌面 CHAT_IPC_CHANNELS 同名通道，
  // 平板 stub 按通道名分发到 onStreamChunk 等注册器。
  chatBusUnsubscribe = chatEventBus.on((conversationId, channel, payload) => {
    const frame = JSON.stringify({ kind: 'chat_event', conversationId, channel, payload })
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
    // listen() 是异步的；端口冲突不能冒泡成 Electron 主进程未捕获异常。
    isStarted = false
    listenAddress = null
    remoteError = err.code === 'EADDRINUSE'
      ? `端口 ${port} 已被占用，请关闭占用它的 Profer 实例，或在设置中改用其他端口。`
      : `移动模式服务启动失败：${err.message || '未知错误'}`
    console.error('[Remote]', remoteError, err)

    eventBusUnsubscribe?.()
    eventBusUnsubscribe = null
    chatBusUnsubscribe?.()
    chatBusUnsubscribe = null
    try { wss?.close() } catch { /* ignore */ }
    wss = null
    const failedServer = httpServer
    httpServer = null
    try { failedServer?.close() } catch { /* ignore */ }
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
    console.log('[Remote] Profer 移动版已启动')
    console.log(`[Remote] 本机访问:  ${listenAddress}`)
    console.log(`[Remote] 移动端访问:  http://${lanIp}:${actualPort}`)
    console.log(`[Remote] 访问 Token: ${accessToken}（首次在平板输入一次）`)
    console.log('════════════════════════════════════════════════════\n')
  })

  // Electron 主进程可能因 GUI/生命周期时序影响异步 bind，做一次就绪校验告警
  httpServer.on('listening', () => {
    remoteError = null
    console.log(`[Remote] 服务已在 ${HOST}:${port} 就绪`)
  })

  return listenAddress
}

/** 停止 Profer Remote Service */
export function stopRemoteService(): void {
  eventBusUnsubscribe?.()
  eventBusUnsubscribe = null
  chatBusUnsubscribe?.()
  chatBusUnsubscribe = null
  if (idleSweepTimer) {
    clearInterval(idleSweepTimer)
    idleSweepTimer = null
  }
  for (const t of partialMergeTimers.values()) {
    clearTimeout(t)
  }
  partialMergeTimers.clear()
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
  remoteError = null
  console.log('[Remote] 移动版服务已停止')
}
