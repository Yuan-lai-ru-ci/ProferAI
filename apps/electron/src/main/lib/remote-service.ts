/**
 * Profer Remote Service — 移动端（Pocket）远程接入服务
 *
 * 目标：在不破坏现有桌面版的前提下，为「手机/平板等外部设备」提供
 * 一条独立的 HTTP + WebSocket 通道，用来传输 Agent 工作过程与用户输入，
 * 而非传输图像。
 *
 * 设计要点：
 *  1. 默认绑定 0.0.0.0 以便局域网设备接入，可用 PROFER_REMOTE_HOST=127.0.0.1 收紧到本机回环；
 *  2. 简单 token 鉴权，防止局域网内他人误连；
 *  3. 通过唯一的 agentEventBus（agent-service 单例）订阅 Agent 工作流事件，
 *     广播给所有已连接的移动端（Pocket）客户端 —— 对现有桌面版零侵入；
 *  4. 接收客户端指令：列会话 / 列渠道 / 新建会话 / 发送消息 / 停止任务 / 取历史；
 *  5. 显式开关控制：环境变量 PROFER_REMOTE=1 或设置页「移动模式」开关（settings.pocketModeEnabled）时启动，
 *     默认不启动，确保桌面版行为零变化。
 *
 * 注：本文件**不含静态 UI 服务**（原平板静态页面已随 tablet 线退役移除，2026-09-11）；
 *     当前仅提供 /health 与 /ws（WebSocket 命令通道），供移动端（Profer-pocket）客户端接入。
 *
 * 依赖说明：
 *  本文件使用 Node 原生 http/https + ws 库（已于 apps/electron 安装）。
 *  不依赖 Electron 主窗口 DOM，可在主进程侧独立运行。
 */

import { createServer as createTlsServer, type Server as TlsServer } from 'node:https'
import { RemoteTlsStore, validateTlsIdentity, type TlsIdentity } from './remote-tls-identity'
import { publicMode } from './remote-frp-core'
import { createServer, Server as HttpServer, IncomingMessage } from 'node:http'
import { Server as NetServer } from 'node:net'
import { createProtocolSniffer } from './remote-protocol-sniffer'
import { isTrustedLegacyTransport } from './remote-legacy-trust'
import { readFileSync, existsSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import WebSocket, { WebSocketServer, type RawData } from 'ws'
import type { AddressInfo } from 'node:net'
import { app, BrowserWindow } from 'electron'

import { AGENT_IPC_CHANNELS, canSelectAgentSessionRuntime, AGENT_SESSION_RUNTIME_LOCKED_MESSAGE, normalizeAgentRuntime, isChannelEnabledForRuntime, isProferPermissionMode, type AgentSessionMeta } from '@profer/shared'
import type { AgentRuntime, AgentSendInput } from '@profer/shared'
import { agentEventBus, runAgentHeadless, runAgentRuntimeHeadless, peekAgentRunClaimFailureForSession, describeAgentRunRejection, stopAgent, isAgentSessionActive, listActiveAgentRuntimeContexts, updateAgentPermissionMode, queueAgentMessage, beginAgentSessionDeletion, endAgentSessionDeletion, stopAgentAndWait, rewindAgentSession, regenerateAgentTitle, saveFilesToAgentSession } from './agent-service'
import { publishAgentSessionProjection, setAgentSessionUnread, updateAgentSessionUiMeta } from './agent-session-ui-projection-publisher'
import { buildArchiveToggleUpdates } from './agent-unread-policy'
import { getUserProfile } from './user-profile-service'
import { getAgentUnreadPolicyMode } from './agent-unread-mode'
import {
  listAgentSessions,
  getAgentSessionMeta,
  getAgentSessionDeletionOrder,
  getAgentSessionMessages,
  getAgentSessionSDKMessages,
  createAgentSession,
  ensureProjectDraftAgentSession,
  updateAgentSessionMeta,
  deleteAgentSession,
  migrateChatToAgentSession,
  forkAgentSession,
  moveSessionToWorkspace,
  paginateSDKMessages,
  searchAgentSessionMessages,
} from './agent-session-manager'
import { getAgentSessionsDir, getConfigDir, getAgentSessionWorkspacePath, getAgentWorkspacePath, getWorkspaceFilesDir } from './config-paths'
import { getSettings, updateSettings } from './settings-service'
import { projectAgentPayloadForPocket, projectSdkMessageForPocket } from './pocket-agent-projection'
import {
  listAgentWorkspaces,
  createAgentWorkspace,
  getAgentWorkspace,
  getWorkspaceAttachedDirectories,
  getWorkspaceAttachedFiles,
} from './agent-workspace-manager'
import {
  listAgentPresets,
  getDefaultPresetId,
  setDefaultPresetId,
  createAgentPreset,
  copyAgentPreset,
  updateAgentPreset,
  deleteAgentPreset,
  getAgentPreset,
  presetReferenceForId,
} from './agent-preset-manager'
import type { AgentPresetCreateInput, AgentPresetUpdateInput } from '@profer/shared'
import { AgentSessionDeletionCoordinator } from './agent-session-deletion'
import { resolvePiReasoningCapability } from './adapters/pi-model-registry'
import { searchRemoteWorkspaceFiles } from './remote-workspace-file-search'
import { listSwitchableChannels, getEnabledModels } from './bridge-model-utils'
import { permissionService } from './agent-permission-service'
import { askUserService } from './agent-ask-user-service'
import { exitPlanService } from './agent-exit-plan-service'
import {
  listConversations,
  createConversation,
  getConversationMessages,
  getConversationBranch,
  setActivePath,
  getBranchTree,
  forkBranchAt,
  getMessageContent,
  getRecentMessages,
  updateConversationMeta,
  deleteConversation,
  deleteMessage,
  truncateMessagesFrom,
  updateContextDividers,
  searchConversationMessages,
} from './conversation-manager'
import { sendMessage, stopGeneration, generateTitle, autoTitleConversation, regenerateConversationTitle } from './chat-service'
import { saveAttachment, readAttachmentAsBase64, deleteAttachment } from './attachment-service'
import { chatEventBus } from './chat-stream-bus'
import { resolveAndReadFile, readFileAsDataUrl } from './file-preview-service'
import { resolveAuthorizedRemoteFilePath } from './remote-file-access'
import { loadWorkspaceHeatmapDaily } from './workspace-heatmap-query'
import { getAllToolInfos } from './chat-tool-registry'
import { updateToolState } from './chat-tool-config'
import { RemoteAgentEventLog, type RemoteAgentEventRecord } from './remote-agent-event-log'
import { RemoteAgentReplayRegistry, type RemoteReplayRecord } from './remote-agent-replay-registry'
import { REMOTE_PROTOCOL, createCompactPairingQr, createCompactPairingQrV3, type RemoteProfile } from '@profer/shared'
import { authenticateRemote, getConnectionProfile, listBindings, loadRemoteToken, pairDevice, pairingManager, refreshPairing, revokeBinding, protectSecret, revealSecret } from './remote-identity'
import { getFrpStatus, getFrpPublicEndpoint, startFrp, stopFrp, ensureFrpReady } from './remote-frp-service'
import { ensurePublicTlsIdentity, getPublicEndpoint, getPublicEndpointInfo, type PublicEndpointInfo } from './remote-public-endpoint'
import { RemoteLifecycleQueue, closeOwnedHttp } from './remote-lifecycle'
const remoteLifecycle = new RemoteLifecycleQueue()
import { RemoteRelayClient, type RemoteRelaySink } from './remote-relay-client'
const authenticatedClients = new WeakMap<WebSocket, string>()
let profileTimer: ReturnType<typeof setInterval> | null = null
let tlsServer: TlsServer | null = null
let tlsIdentity: TlsIdentity | null = null
const tlsSockets = new Set<WebSocket>()
/** 手动公网地址（用户自建穿透）的自签 TLS 服务；与内置 FRP 的 tlsServer 互相独立。 */
let publicTlsServer: TlsServer | null = null
let publicTlsCert = ''
/** 走公网自签 TLS 的客户端连接（仅用于「是否可信链路」判定与证书轮换时清理）。 */
const publicTlsSockets = new Set<WebSocket>()
/** 单端口协议嗅探前端：同一端口同时接受明文 ws 与 TLS wss。 */
let frontServer: NetServer | null = null
function closePublicTlsServer(): void {
  for (const ws of publicTlsSockets) { try { ws.terminate() } catch { /* ignore */ } }
  publicTlsSockets.clear()
  publicTlsServer = null
  publicTlsCert = ''
}
/**
 * 确保公网自签 TLS 服务与当前配置一致。
 * 证书只用于用户自建穿透的 IP 端点；域名端点由用户自己的反代终止 TLS，不在这里建服务。
 */
async function ensurePublicTlsServer(): Promise<void> {
  if (!wss) return
  let identity: TlsIdentity | null = null
  try { identity = await ensurePublicTlsIdentity() } catch (error) { console.error('[Remote] 公网自签证书生成失败:', error) }
  if (!identity) { closePublicTlsServer(); return }
  if (publicTlsServer && publicTlsCert === identity.cert) return
  // 证书换了（公网 IP 变更/轮换）：旧连接已经无法再用新证书继续信任，全部断开重连。
  closePublicTlsServer()
  const server = createTlsServer({ key: identity.key, cert: identity.cert, minVersion: 'TLSv1.2' }, (_req, res) => { res.writeHead(404); res.end() })
  server.on('tlsClientError', (error, socket) => {
    console.log('[Remote] 公网 TLS 握手失败:', error.message, '| peer=', socket.remoteAddress ?? '?')
  })
  server.on('upgrade', (req, socket, head) => {
    // 只比 pathname：手动连接是 `/ws?token=...`，整串比较会把带 query 的合法请求直接断掉。
    const pathname = (req.url ?? '').split('?')[0]
    console.log('[Remote] 公网 TLS 升级请求:', req.url, '| protocol=', req.headers['sec-websocket-protocol'] ?? '(legacy)')
    if (pathname !== '/ws' || !wss) { socket.destroy(); return }
    wss.handleUpgrade(req, socket, head, (ws) => {
      // 这条连接端到端是 TLS（手机校验了自签证书指纹），允许走 `?token=` 手动连接路径。
      publicTlsSockets.add(ws)
      ws.once('close', () => publicTlsSockets.delete(ws))
      wss?.emit('connection', ws, req)
    })
  })
  publicTlsServer = server
  publicTlsCert = identity.cert
}
export function getRemoteProfile(): RemoteProfile {
  let valid = false
  try { if (tlsIdentity) { validateTlsIdentity(tlsIdentity.cert, tlsIdentity.key, tlsIdentity.publicIp); valid = true } } catch { /* 过期身份不能进入 QR */ }
  // 公网端点来源：内置 FRP 运行中用它；否则用手动配置的公网 IP/域名（用户自建穿透）。
  const publicEndpoint = getFrpStatus().running
    ? getFrpPublicEndpoint(valid ? tlsIdentity?.pin : undefined, valid ? tlsIdentity?.publicIp : undefined)
    : getPublicEndpoint()
  return getConnectionProfile(getPort(), publicEndpoint)
}
export function getRemoteTlsCertificate(): { cert: string } | undefined { return tlsIdentity && tlsServer ? { cert: tlsIdentity.cert } : undefined }
async function closeRemoteTls(): Promise<void> { const old = tlsServer; tlsServer = null; tlsIdentity = null; for (const ws of tlsSockets) { authenticatedClients.delete(ws); ws.terminate() }; tlsSockets.clear(); if (old) await closeOwnedHttp(old) }
export function startRemoteFrp(rotate = false): Promise<import('./remote-frp-service').FrpStatus> { return remoteLifecycle.run(() => startRemoteFrpNow(rotate)) }
async function startRemoteFrpNow(rotate = false): Promise<import('./remote-frp-service').FrpStatus> {
  if (!listenAddress || !wss) throw new Error('请先开启移动模式')
  const c = await ensureFrpReady()
  if (publicMode(c) === 'system') { await closeRemoteTls(); pairingManager.revoke(); return startFrp(getPort()) }
  await stopFrp(); await closeRemoteTls(); pairingManager.revoke()
  const store = new RemoteTlsStore(join(app.getPath('userData'), 'remote-tls'), protectSecret, revealSecret)
  const id = await store.ensure(c.serverAddr, rotate)
  const server = createTlsServer({ key: id.key, cert: id.cert, minVersion: 'TLSv1.2' }, (_req, res) => { res.writeHead(404); res.end() })
  server.on('upgrade', (req, socket, head) => { const pathname = (req.url ?? '').split('?')[0]; if (pathname !== '/ws' || !wss) { socket.destroy(); return }; wss.handleUpgrade(req, socket, head, (ws) => { tlsSockets.add(ws); ws.once('close', () => tlsSockets.delete(ws)); wss?.emit('connection', ws, req) }) })
  const port = await new Promise<number>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve((server.address() as AddressInfo).port) }) })
  tlsServer = server; tlsIdentity = id
  try { return await startFrp(port) } catch (error) { await closeRemoteTls(); throw error }
}
export function rotateRemoteTls(): Promise<import('./remote-frp-service').FrpStatus> { return startRemoteFrp(true) }
export async function getRemotePairingQr(): Promise<{ dataUrl: string; expiresAt: number }> {
  if (!listenAddress) throw new Error('请先开启移动模式')
  // 公网 IP 场景先确保自签身份存在：二维码里的 pin 与正在监听的证书必须是同一份。
  await ensurePublicTlsServer()
  const profile = getRemoteProfile()
  const qr = refreshPairing(profile)
  const hasPublic = profile.endpoints.some((e) => e.scope === 'public')
  // v2 只带局域网端点；配了公网地址就发 v3（多带 p/k 两个字段），保持旧版 App 仍能读 v2。
  const compact = hasPublic
    ? createCompactPairingQrV3(profile, qr.pairingCode, qr.expiresAt)
    : createCompactPairingQr(profile, qr.pairingCode, qr.expiresAt)
  console.log(
    '[Remote] 配对二维码',
    hasPublic ? 'v3' : 'v2',
    '| 局域网=', (compact as { h?: string }).h ?? '?',
    '| 公网=', (compact as { p?: string }).p ?? '(无)',
    '| 指纹=', (compact as { k?: string }).k ? '有' : '(无)',
  )
  const QRCode = (await import('qrcode')).default
  return { dataUrl: await QRCode.toDataURL(JSON.stringify(compact), { width: hasPublic ? 480 : 320, margin: 2, errorCorrectionLevel: 'M' }), expiresAt: qr.expiresAt }
}
export function getRemotePairingAudit() { return pairingManager.getAudit() }
export function getRemoteBindings() { return listBindings() }
export function removeRemoteBinding(id: string): void {
  revokeBinding(id)
  for (const client of wss?.clients ?? []) if (authenticatedClients.get(client) === id) client.close(4001, 'revoked')
}

/** 正式版默认监听端口 */
export const DEFAULT_REMOTE_PORT = 7788

/** 开发模式默认监听端口：与正式版（7788）区分，避免与打包版实例并存时 EADDRINUSE */
export const DEV_DEFAULT_REMOTE_PORT = 7789

/**
 * 端口被占时的候选数量：从首选端口向后顺延（7788 → 7789 → …）。
 * 只顺延、不随机：选中后会持久化，手机端保存的地址才能长期有效。
 */
export const REMOTE_PORT_FALLBACK_COUNT = 12

/**
 * 首选端口的重试节奏（毫秒）。关闭窗口/自动更新时旧进程要先把远控服务停干净才退出，
 * 这段时间端口仍被占着；先等一会儿再换端口，绝大多数情况能原地恢复。
 */
const REMOTE_PORT_RETRY_DELAYS_MS = [0, 600, 1800]

/** 访问令牌（首次启动生成并持久化，或由环境变量指定） */
let accessToken: string | null = null

/** HTTP + WebSocket 服务实例 */
let httpServer: HttpServer | null = null
let wss: WebSocketServer | null = null
let remoteRelayClient: RemoteRelayClient | null = null
let remoteRelaySink: RemoteRelaySink | null = null
let remoteRelayCommandContext: RemoteCommandContext = {}

/** 闲置踢人定时器：定期扫描连接，清理长时间无任何入站消息（含 ping）的假死/僵尸连接。 */
let idleSweepTimer: ReturnType<typeof setInterval> | null = null

/** agentEventBus 订阅句柄 */
let eventBusUnsubscribe: (() => void) | null = null

/** chatEventBus 订阅句柄（Chat 流式事件 → WS chat_event 广播） */
let chatBusUnsubscribe: (() => void) | null = null

/** 记录当前监听地址（用于启动日志提示） */
let listenAddress: string | null = null

/** 实际绑定的端口：端口被占而顺延时与配置端口不同，状态/二维码/转发都以它为准。 */
let activeListenPort: number | null = null

/** 服务实例 ID：Pocket 发现主进程重启后清除旧 cursor，改走快照恢复。 */
let serverInstanceId = randomUUID()
const remoteAgentEventLog = new RemoteAgentEventLog()
/**
 * remote（Pocket）侧的会话绑定与回放登记（GAP-3）。
 *
 * 与 `RemoteAgentEventLog` 分工不同：事件日志提供**游标补发**（客户端必须自己记住 cursor），
 * 本登记提供**会话级重建**（刷新后拿不到 cursor 也能拿到正在飞 / 刚结束的一轮）。
 * 两者都不复制桌面的 webContents backlog 机制。
 */
const remoteAgentReplayRegistry = new RemoteAgentReplayRegistry()

type AgentReplayState = {
  /** 本连接的客户端标识：绑定 / 回放登记按它归属，多客户端互不干扰。 */
  clientKey: string
  replaying: boolean
  queuedLiveFrames: RemoteAgentEventRecord[]
  lastSentEventId: number
  fallbackTimer: ReturnType<typeof setTimeout> | null
}

const AGENT_REPLAY_HANDSHAKE_TIMEOUT_MS = 5000

const agentReplayStates = new WeakMap<WebSocket, AgentReplayState>()

/** 是否已执行启动检查（避免重复启动） */
let isStarted = false

/** 由设置页在当前运行期显式开启；启动参数仍保持兼容。 */
let runtimeEnabled = false

/** 移动端会话删除协调器：合并并发删除 + stop-and-wait 成功前绝不清理持久化数据（对齐桌面 IPC 语义） */
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
 * 连续到达的 partial 只广播窗口内最后一个，减少移动端弱网下的传输与渲染抖动。
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

/** 真正把一条 agent_event 帧广播给所有已连接移动端客户端。 */
function broadcastAgentFrame(sessionId: string, payload: import('@profer/shared').AgentStreamPayload): void {
  const record = remoteAgentEventLog.append(sessionId, projectAgentPayloadForPocket(payload))
  // 同一份记录进入会话级回放登记：刷新后的 Pocket 即使没有游标也能重建在飞的一轮。
  remoteAgentReplayRegistry.observe(record)
  const frame = JSON.stringify({
    kind: 'agent_event',
    eventId: record.eventId,
    sessionId: record.sessionId,
    payload: record.payload,
  })
  if (remoteRelaySink?.isOpen()) remoteRelaySink.send(frame)
  for (const client of wss?.clients ?? []) {
    if (client.readyState !== WebSocket.OPEN || !authenticatedClients.has(client)) continue
    const replayState = agentReplayStates.get(client)
    if (replayState?.replaying) {
      replayState.queuedLiveFrames.push(record)
      if (replayState.queuedLiveFrames.length > 2500) {
        try { client.close(1013, 'replay queue overflow') } catch { /* ignore */ }
      }
      continue
    }
    sendAgentEventRecord(client, record)
  }
}

function sendAgentEventRecord(client: WebSocket, record: RemoteAgentEventRecord): void {
  if (client.readyState !== WebSocket.OPEN) return
  client.send(JSON.stringify({
    kind: 'agent_event',
    eventId: record.eventId,
    sessionId: record.sessionId,
    payload: record.payload,
  }))
  const replayState = agentReplayStates.get(client)
  if (replayState) replayState.lastSentEventId = Math.max(replayState.lastSentEventId, record.eventId)
}

function releaseAgentReplayGate(client: WebSocket): void {
  const replayState = agentReplayStates.get(client)
  if (!replayState || !replayState.replaying) return
  if (replayState.fallbackTimer) {
    clearTimeout(replayState.fallbackTimer)
    replayState.fallbackTimer = null
  }
  for (const record of replayState.queuedLiveFrames.sort((a, b) => a.eventId - b.eventId)) {
    sendAgentEventRecord(client, record)
  }
  replayState.queuedLiveFrames = []
  replayState.replaying = false
}

function sendAgentReplayResult(client: WebSocket, requestId: unknown, replay: ReturnType<RemoteAgentEventLog['replayAfter']>): void {
  if (client.readyState !== WebSocket.OPEN) return
  client.send(JSON.stringify({
    kind: 'agent_events_resumed',
    requestId,
    fromEventId: replay.fromEventId,
    toEventId: replay.toEventId,
    replayed: replay.records.length,
    complete: !replay.requiresSnapshot,
    requiresSnapshot: replay.requiresSnapshot,
    oldestEventId: replay.oldestEventId,
    latestEventId: replay.latestEventId,
  }))
}

function replayAgentEvents(client: WebSocket, requestId: unknown, cursor: unknown): void {
  const replayState = agentReplayStates.get(client)
  if (!replayState || client.readyState !== WebSocket.OPEN) return
  if (!replayState.replaying) {
    sendAgentReplayResult(client, requestId, {
      records: [],
      fromEventId: null,
      toEventId: replayState.lastSentEventId || null,
      oldestEventId: remoteAgentEventLog.getOldestEventId(),
      latestEventId: remoteAgentEventLog.getLatestEventId(),
      requiresSnapshot: false,
    })
    return
  }
  if (replayState.fallbackTimer) {
    clearTimeout(replayState.fallbackTimer)
    replayState.fallbackTimer = null
  }
  const normalizedCursor = cursor === null ? null : typeof cursor === 'number' ? cursor : -1
  const replay = remoteAgentEventLog.replayAfter(normalizedCursor)
  if (replay.requiresSnapshot) {
    // 日志窗口已经不完整时，不发送半段事件；客户端随后按快照重建。
    replayState.queuedLiveFrames = []
    replayState.replaying = false
    sendAgentReplayResult(client, requestId, replay)
    return
  }
  const replayedIds = new Set<number>()
  for (const record of replay.records) {
    if (record.eventId <= replayState.lastSentEventId) continue
    sendAgentEventRecord(client, record)
    replayedIds.add(record.eventId)
  }
  for (const record of replayState.queuedLiveFrames.sort((a, b) => a.eventId - b.eventId)) {
    if (record.eventId <= replayState.lastSentEventId || replayedIds.has(record.eventId)) continue
    sendAgentEventRecord(client, record)
  }
  replayState.queuedLiveFrames = []
  replayState.replaying = false
  sendAgentReplayResult(client, requestId, replay)
}

/**
 * 纯函数：根据会话级登记算出「要补发的记录 + 结果帧」。
 *
 * 抽出来的目的：让「刷新回放 / 重连幂等」可以在不启动 WS 的前提下被真实驱动
 * （不重复 registry 逻辑，也不复制连接状态机）。
 *
 * 去重口径：实际下界取 `max(sinceEventId, lastSentEventId)` —— 客户端声明的游标
 * 与本连接已经发出去的最大 eventId 取大值，因此重复调用本命令第二次只会补增量。
 */
export function planAgentStreamsRestore(
  registry: RemoteAgentReplayRegistry,
  clientKey: string,
  request: {
    sessionIds?: readonly string[]
    sinceEventId?: number | null
    lastSentEventId: number
    requestId?: unknown
  },
): { records: RemoteReplayRecord[]; requiresSnapshot: boolean; frame: Record<string, unknown> } {
  const requested = typeof request.sinceEventId === 'number' ? request.sinceEventId : null
  const sinceEventId = requested === null
    ? (request.lastSentEventId || null)
    : Math.max(requested, request.lastSentEventId)
  const batch = registry.replayFor(clientKey, {
    ...(request.sessionIds ? { sessionIds: request.sessionIds } : {}),
    sinceEventId,
  })
  const records = batch.requiresSnapshot
    ? []
    : batch.records.filter((record) => record.eventId > request.lastSentEventId)
  return {
    records,
    requiresSnapshot: batch.requiresSnapshot,
    frame: {
      kind: 'agent_streams_restored',
      requestId: request.requestId ?? null,
      sessions: batch.sessions,
      replayed: records.length,
      requiresSnapshot: batch.requiresSnapshot,
      oldestEventId: batch.oldestEventId,
      latestEventId: batch.latestEventId,
    },
  }
}

/**
 * Pocket 刷新 / 重连后的**会话级回放**：把当前活跃或刚落终态的一轮事件按序补发。
 *
 * 与 `resume_agent_events`（游标补发）的区别：客户端**不需要**记住 cursor。
 * 刷新后的 Pocket 内存状态已丢，旧 cursor 不可用，但通过本命令仍能重建在飞的一轮。
 *
 * 幂等保证：
 * - 事件按 eventId 升序发送，已发送过的 eventId（含回放期间排队的新帧）一律跳过；
 * - 登记不完整（本轮早期事件被容量上限丢弃）时不发送半段事件，只回 `requiresSnapshot: true`；
 * - 重复调用本命令（弱网重连重放）第二次只补增量，不会重复消息或重复终态。
 */
function restoreAgentStreams(
  client: WebSocket,
  requestId: unknown,
  request: { sessionIds?: unknown; sinceEventId?: unknown },
): void {
  const replayState = agentReplayStates.get(client)
  if (!replayState || client.readyState !== WebSocket.OPEN) return
  if (replayState.fallbackTimer) {
    clearTimeout(replayState.fallbackTimer)
    replayState.fallbackTimer = null
  }

  const sessionIds = Array.isArray(request.sessionIds)
    ? request.sessionIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
    : undefined
  if (sessionIds) {
    for (const sessionId of sessionIds) remoteAgentReplayRegistry.bindClient(replayState.clientKey, sessionId)
  }

  const plan = planAgentStreamsRestore(remoteAgentReplayRegistry, replayState.clientKey, {
    ...(sessionIds ? { sessionIds } : {}),
    sinceEventId: typeof request.sinceEventId === 'number' ? request.sinceEventId : null,
    lastSentEventId: replayState.lastSentEventId,
    requestId,
  })

  const replayedIds = new Set<number>()
  if (!plan.requiresSnapshot) {
    for (const record of plan.records) {
      if (record.eventId <= replayState.lastSentEventId) continue
      sendAgentEventRecord(client, record)
      replayedIds.add(record.eventId)
    }
    // 回放期间排队的新帧：按 eventId 补发，已回放过的跳过。
    for (const record of replayState.queuedLiveFrames.sort((a, b) => a.eventId - b.eventId)) {
      if (record.eventId <= replayState.lastSentEventId || replayedIds.has(record.eventId)) continue
      sendAgentEventRecord(client, record)
    }
  }
  replayState.queuedLiveFrames = []
  replayState.replaying = false

  client.send(JSON.stringify(plan.frame))
}

/**
 * agentEventBus → 移动端 WS 的广播入口，带 partial 合并：
 * - partial sdk_message：合并到时间窗，只发最后一个（减少传输/渲染抖动）。
 * - 非 partial（含 final 完整消息）：先取消 pending 的 partial 再立即广播，
 *   确保 final 不被延迟到达的旧 partial 覆盖（renderer 按同 UUID 覆盖，顺序必须保证）。
 */
function broadcastAgentEvent(sessionId: string, payload: import('@profer/shared').AgentStreamPayload): void {
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

/** 是否启用远程服务（显式开关） */
export function isRemoteEnabled(): boolean {
  if (process.env.PROFER_REMOTE === '1') return true
  return runtimeEnabled
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
  /** 用户手动配置的公网连接地址（自建 FRP/端口映射）；未配置为 null。 */
  publicEndpoint: PublicEndpointInfo | null
  /** 最近一次启动失败原因；服务恢复后清空。 */
  error: string | null
  /** 启动时的非致命提示（如端口被占已自动改用其他端口）；不需要提示时为 null。 */
  notice: string | null
}

let remoteError: string | null = null
let remoteNotice: string | null = null

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
    publicEndpoint: getPublicEndpointInfo(),
    error: remoteError,
    notice: remoteNotice,
  }
}

/** 设置页运行时切换开关；不会修改启动参数。 */
export function setRemoteServiceEnabled(enabled: boolean): Promise<RemoteServiceStatus> {
  return remoteLifecycle.run(async () => { runtimeEnabled = enabled; if (enabled) await startRemoteServiceReady(); else await stopRemoteServiceNow(); return getRemoteServiceStatus() })
}

/** 解析监听端口：已监听时以实际绑定端口为准（可能因占用而顺延）；否则设置页保存的端口优先，其次 PROFER_REMOTE_PORT，最后默认 7788。 */
function getPort(): number {
  if (activeListenPort) return activeListenPort
  const saved = getSettings().pocketModePort
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
export function restartRemoteService(): Promise<RemoteServiceStatus> {
  return remoteLifecycle.run(async () => { if (isStarted) { await stopRemoteServiceNow(); await startRemoteServiceReady() }; return getRemoteServiceStatus() })
}

/** 校验 token（HTTP 或 WS 请求） */
function checkToken(req: IncomingMessage): boolean {
  if (!accessToken) return false
  const url = new URL(req.url || '', 'http://localhost')
  const queryToken = url.searchParams.get('token')
  if (queryToken === accessToken) return true
  const header = req.headers['x-profer-token']
  return header === accessToken
}

// ===== 指令处理：移动端客户端 → 主进程 Agent =====

/**
 * 从 SDK 消息对象提取文本（content 可为字符串或 [{type:'text'|'thinking', text|thinking}] 数组）。
 * 与移动端前端 parseSdkMessage 保持一致；这里用于服务端把持久化 SDK 消息转成移动端可读结构。
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
 * 把持久化 SDK 消息（getAgentSessionMessages 返回的原生结构）转成移动端可见消息。
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
  | { ok: false; error: string; conflict?: { code: 'REVISION_CONFLICT'; expectedRevision: number; actualRevision: number; sessionId: string } }

export function validateExpectedRevision(parsed: Record<string, unknown>, sessionId: string): CommandResult | null {
  if (parsed.expectedRevision === undefined) return null
  if (typeof parsed.expectedRevision !== 'number' || !Number.isSafeInteger(parsed.expectedRevision)) {
    return { ok: false, error: 'expectedRevision 必须是整数' }
  }
  const current = getAgentSessionMeta(sessionId)
  if (!current) return { ok: false, error: '会话不存在' }
  const actualRevision = current.revision ?? 0
  if (actualRevision !== parsed.expectedRevision) {
    return {
      ok: false,
      error: '会话状态已更新，请刷新后重试',
      conflict: { code: 'REVISION_CONFLICT', expectedRevision: parsed.expectedRevision, actualRevision, sessionId },
    }
  }
  return null
}

export function validateWorkspaceHeatmapRequest(workspaceId: unknown): string | null {
  if (typeof workspaceId !== 'string' || !workspaceId.trim()) return '缺少 workspaceId'
  return null
}

/** 探索分支的缺省来源标签（对齐桌面「从此处探索」主入口文案）。 */
export const DEFAULT_EXPLORATION_SOURCE_LABEL = '这条 Agent 回复'
/** 来源标签服务端强制截断长度：桌面侧最长来源为选区文本 slice(0, 80)，120 字符足够。 */
export const EXPLORATION_SOURCE_LABEL_MAX_LENGTH = 120

/**
 * 归一化移动端传入的探索来源标签。
 *
 * 该标签会持久化进会话 meta，并随每次 `session_updated` 广播，因此不能只靠客户端自律：
 * 非字符串/空值回落缺省值，其余折叠连续空白（含换行）后截断，避免超长选区文本放大事件体积。
 */
export function normalizeExplorationSourceLabel(raw: unknown): string {
  if (typeof raw !== 'string') return DEFAULT_EXPLORATION_SOURCE_LABEL
  const collapsed = raw.replace(/\s+/g, ' ').trim()
  if (!collapsed) return DEFAULT_EXPLORATION_SOURCE_LABEL
  return collapsed.length > EXPLORATION_SOURCE_LABEL_MAX_LENGTH
    ? collapsed.slice(0, EXPLORATION_SOURCE_LABEL_MAX_LENGTH)
    : collapsed
}

/** 单个会话对象（脱敏，仅暴露移动端需要的字段；与桌面 AgentSessionMeta 移动端所需子集兼容）。
 * 注意：必须包含 id/updatedAt/title/pinned/archived/draft 等完整字段——桌面复用组件
 * （AgentView/LeftSidebar）按桌面 IPC 返回完整对象的契约处理 .then((updated) => updated.id)
 * 等；若缺字段（旧实现只回 { channelId, modelId }）会导致切换模型后列表不更新甚至
 * 在 Promise 回调里读 undefined.updatedAt 报错。
 */
export function buildSessionItem(s: ReturnType<typeof listAgentSessions>[number]) {
  return {
    id: s.id,
    revision: s.revision ?? 0,
    title: s.title,
    channelId: s.channelId,
    modelId: s.modelId,
    presetId: s.presetId,
    presetReference: s.presetReference ?? null,
    workspaceId: s.workspaceId,
    attachedDirectories: s.attachedDirectories ?? [],
    attachedFiles: s.attachedFiles ?? [],
    openAIThinkingLevel: s.openAIThinkingLevel ?? null,
    codexFastMode: s.codexFastMode ?? false,
    agentEffort: s.agentEffort ?? null,
    completedButUnconfirmed: s.completedButUnconfirmed ?? false,
    stoppedByUser: s.stoppedByUser ?? false,
    autoQueueSendEnabled: s.autoQueueSendEnabled ?? true,
    lastInterruptReason: s.lastInterruptReason ?? null,
    lastInterruptLabel: s.lastInterruptLabel ?? null,
    lastInterruptAt: s.lastInterruptAt ?? null,
    rootSessionId: s.rootSessionId,
    delegationRole: s.delegationRole,
    delegationStatus: s.delegationStatus,
    delegationDepth: s.delegationDepth,
    sourceAutomationId: s.sourceAutomationId,
    automationGraduated: s.automationGraduated ?? false,
    // 与桌面 LeftSidebar 相同的父子 Agent 会话关联；仅用于树形导航，不暴露委派内容。
    parentSessionId: s.parentSessionId,
    sourceDelegationId: s.sourceDelegationId,
    // 探索分支血缘：移动端需要它把分支挂回主线，而不是当成独立会话。
    // 与委派血缘是两套独立字段（探索分支不参与委派删除级联），因此必须一并下沉；
    // explorationTitleInitializedAt 是主进程内部的重复请求守卫，属 UI 之外的数据，不下发。
    explorationParentSessionId: s.explorationParentSessionId,
    explorationSourceMessageId: s.explorationSourceMessageId,
    explorationSourceLabel: s.explorationSourceLabel,
    agentRuntime: s.agentRuntime,
    agentRuntimeLocked: !canSelectAgentSessionRuntime(s),
    permissionMode: s.permissionMode,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    pinned: s.pinned,
    archived: s.archived,
    draft: s.draft,
    active: isAgentSessionActive(s.id),
  }
}

/**
 * 会话列表（脱敏，仅暴露移动端需要的字段）。
 *
 * 归档是电脑端的整理动作：Pocket 不展示归档会话，也不传输它们，
 * 避免手机在 800+ 会话里背负一份永远用不到的归档目录。
 * `buildSessionItem` 仍保留 archived 字段，供 projection 表达「刚被归档」。
 */
function buildSessionList() {
  // 归档项目整体收纳：项目行不下发，项目里的会话也不下发（避免它们掉进「未归入项目」）。
  const archivedWorkspaceIds = new Set(
    listAgentWorkspaces()
      .filter((workspace) => workspace.archived)
      .map((workspace) => workspace.id),
  )
  return listAgentSessions(false)
    .filter((session) => !session.workspaceId || !archivedWorkspaceIds.has(session.workspaceId))
    .map(buildSessionItem)
}

/**
 * Pocket 修改会话元数据后，命令响应只会回给发起设备；这里补齐对所有已打开桌面窗口
 * 与其它 Pocket 连接的实时通知，避免置顶、归档等操作必须等待下一条 Agent 事件才显示。
 */
function publishSessionUpdated(session: AgentSessionMeta): void {
  // Compatibility name retained for older command paths; the projection publisher is
  // the only metadata event出口 so desktop and Pocket consume one canonical payload.
  publishAgentSessionProjection(session)
}

function publishSessionDeleted(sessionId: string): void {
  const payload: import('@profer/shared').AgentStreamPayload = {
    kind: 'profer_event',
    event: { type: 'session_deleted', sessionId },
  }
  agentEventBus.emit(sessionId, payload)
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(AGENT_IPC_CHANNELS.STREAM_EVENT, { sessionId, payload })
    }
  }
}

/** 工作区（项目）列表（脱敏，仅暴露移动端侧栏渲染需要的字段；与桌面 AgentWorkspace 形状兼容） */
function buildWorkspaceList() {
  return listAgentWorkspaces()
    .filter((w) => !w.archived)
    .map((w) => ({
    id: w.id,
    name: w.name,
    slug: w.slug,
    type: w.type,
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
  }))
}

/** 渠道列表（脱敏，仅暴露移动端发消息需要的字段） */
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
    managedType: c.managedType,
    familyId: c.familyId,
    agentRuntimes: c.agentRuntimes,
    agentExperimentalEnabled: c.agentExperimentalEnabled,
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

/**
 * 在候选渠道里挑出「新建会话」要用的渠道与模型（纯函数，便于单测）。
 *
 * 优先级：客户端显式指定 → 桌面默认（上次使用的渠道/模型）→ 该内核首个可用渠道。
 * 模型必须属于最终渠道，否则回落到渠道首个启用模型——手机不该带着一个不存在的
 * 模型建出「看着有模型、发消息才报错」的空会话。
 */
export function pickAgentSelection(
  channels: ReadonlyArray<{ id: string; models: ReadonlyArray<{ id: string; enabled: boolean }> }>,
  requested: { channelId?: string; modelId?: string },
  fallback: { channelId?: string; modelId?: string },
): { channelId?: string; modelId?: string } {
  const channel = channels.find((item) => item.id === requested.channelId)
    ?? channels.find((item) => item.id === fallback.channelId)
    ?? channels[0]
  if (!channel) return { channelId: requested.channelId, modelId: requested.modelId }
  const models = channel.models.filter((model) => model.enabled)
  const modelId = [requested.modelId, fallback.modelId]
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
    .find((id) => models.some((model) => model.id === id))
    ?? models[0]?.id
  return { channelId: channel.id, modelId }
}

/**
 * 新建会话时解析渠道/模型：候选渠道按会话内核过滤，默认值取桌面设置里的「上次使用」。
 *
 * 移动端没有默认模型设置页，也不该自己猜第一个渠道：桌面每次切换模型都会写进
 * settings.agentChannelId / agentModelId，新会话继承的正是这份记录。
 */
function resolveRemoteAgentSelection(
  requestedChannelId: string | undefined,
  requestedModelId: string | undefined,
  agentRuntime: AgentRuntime,
): { channelId?: string; modelId?: string } {
  const runtimeChannels = listSwitchableChannels(agentRuntime)
  const channels = runtimeChannels.length > 0 ? runtimeChannels : listSwitchableChannels()
  const settings = getSettings()
  return pickAgentSelection(
    channels,
    { channelId: requestedChannelId, modelId: requestedModelId },
    { channelId: settings.agentChannelId, modelId: settings.agentModelId },
  )
}

/**
 * Chat 工具列表（脱敏）：移动端只需要「开关 + 名称 + 说明」。
 * 不下发 params / httpConfig / systemPromptAppend：自定义工具的 headers 可能带 API Key。
 */
function buildChatToolList() {
  return getAllToolInfos().map((info) => ({
    id: info.meta.id,
    name: info.meta.name,
    description: info.meta.description,
    icon: info.meta.icon,
    category: info.meta.category,
    enabled: info.enabled,
    available: info.available,
  }))
}

/** 单条 WS 连接已声明的最近活动会话，仅用于兼容旧 Pocket 文件预览请求。 */
interface RemoteCommandContext {
  activeSessionId?: string
}

/** 处理来自移动端客户端的一条 JSON 指令消息 */
export async function handleRemoteCommand(
  message: string,
  requestId: unknown = null,
  context?: RemoteCommandContext,
): Promise<CommandResult> {
  let parsed: { type?: string } & Record<string, unknown>
  try {
    parsed = JSON.parse(message)
  } catch {
    return { ok: false, error: '无效的 JSON' }
  }

  const type = parsed?.type as string
  // 旧 Pocket 的 FilePreviewDialog 没有把 sessionId 传给 WS 文件读取命令。
  // 它在打开会话时已经通过 get_sdk_messages/session_detail 等命令声明过会话，
  // 因此仅在同一条受 token 保护的连接内保存该会话作为严格授权的回退上下文。
  if (typeof parsed.sessionId === 'string' && parsed.sessionId) {
    context && (context.activeSessionId = parsed.sessionId)
  }
  switch (type) {
    case 'ping': {
      return { ok: true, data: { pong: true, time: Date.now() } }
    }

    case 'list_sessions': {
      return { ok: true, data: buildSessionList() }
    }

    // 运行中上下文窗口为瞬时运行状态，不能只依赖客户端恰好在线时收到 context_window 事件。
    // Pocket 在首次连接、重连或事件日志过期后的快照恢复时调用此命令水合。
    case 'get_agent_runtime_contexts': {
      const sessionIds = Array.isArray(parsed.sessionIds)
        ? parsed.sessionIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
        : undefined
      // 以 orchestrator 的即时 active 状态二次过滤：即使进程在清理 run_idle 前收到命令，
      // 也绝不把已结束 run 的短暂残留快照作为历史会话能力返回。
      return {
        ok: true,
        data: listActiveAgentRuntimeContexts(sessionIds)
          .filter((snapshot) => isAgentSessionActive(snapshot.sessionId)),
      }
    }

    case 'delete_session': {
      const sessionId = typeof parsed.sessionId === 'string' ? parsed.sessionId : ''
      if (!sessionId) return { ok: false, error: '缺少 sessionId' }
      try {
        await agentSessionDeletionCoordinator.delete(sessionId, {
          getDeletionOrder: getAgentSessionDeletionOrder,
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
        // 会话已删：同时释放它的回放登记，避免刷新后的 Pocket 拿到已删会话的在飞事件。
        remoteAgentReplayRegistry.clearSession(sessionId)
        publishSessionDeleted(sessionId)
        return { ok: true, data: { sessionId } }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : '删除会话失败' }
      }
    }

    case 'list_workspaces': {
      return { ok: true, data: buildWorkspaceList() }
    }

    case 'get_workspace_heatmap_daily': {
      const requestedWorkspaceId = parsed.workspaceId
      const validationError = validateWorkspaceHeatmapRequest(requestedWorkspaceId)
      if (validationError) return { ok: false, error: validationError }
      if (typeof requestedWorkspaceId !== 'string') {
        return { ok: false, error: '缺少 workspaceId' }
      }
      return { ok: true, data: loadWorkspaceHeatmapDaily(requestedWorkspaceId.trim()) }
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

    // 桌面「上次使用的渠道/模型」：移动端新建会话继承它，而不是自己猜第一个渠道。
    // 旧版桌面不认识本命令（返回 ok:false），移动端按「首个可用渠道」兜底。
    case 'get_agent_defaults': {
      const settings = getSettings()
      const runtime = normalizeAgentRuntime(settings.agentRuntime)
      const selection = resolveRemoteAgentSelection(undefined, undefined, runtime)
      return { ok: true, data: { channelId: selection.channelId ?? null, modelId: selection.modelId ?? null } }
    }

    // Chat 工具（function calling）：与桌面共用 ~/.profer/chat-tools.json 的开关。
    // 移动端只读展示与切换开关，不接触工具凭据、HTTP 执行器配置或系统提示词。
    case 'list_chat_tools': {
      return { ok: true, data: buildChatToolList() }
    }

    case 'update_chat_tool': {
      const toolId = typeof parsed.toolId === 'string' ? parsed.toolId : ''
      const enabled = parsed.enabled === true
      if (!toolId) return { ok: false, error: '缺少 toolId' }
      const known = getAllToolInfos().some((info) => info.meta.id === toolId)
      if (!known) return { ok: false, error: `工具不存在: ${toolId}` }
      try {
        updateToolState(toolId, { enabled })
        return { ok: true, data: buildChatToolList() }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : '更新工具开关失败' }
      }
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
      const sessionId = await askUserService.respondToAskUser(requestId, answers as Record<string, string>)
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
        updateAgentSessionUiMeta(result.sessionId, { permissionMode: result.targetMode })
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
        // Pocket 只接收正文、工具名称和必要 usage，不接收思考正文、工具入参或工具结果。
        return { ok: true, data: messages.map(projectSdkMessageForPocket) }
      }
      const page = paginateSDKMessages(messages, {
        before: typeof parsed.before === 'number' ? parsed.before : undefined,
        targetMessages: typeof parsed.targetMessages === 'number' ? parsed.targetMessages : undefined,
      })
      return {
        ok: true,
        data: {
          ...page,
          messages: page.messages.map(projectSdkMessageForPocket),
        },
      }
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
            revision: meta.revision ?? 0,
            title: meta.title,
            channelId: meta.channelId,
            modelId: meta.modelId,
            workspaceId: meta.workspaceId,
            agentRuntime: meta.agentRuntime,
            permissionMode: meta.permissionMode,
            pinned: meta.pinned ?? false,
            archived: meta.archived ?? false,
            draft: meta.draft ?? false,
            completedButUnconfirmed: meta.completedButUnconfirmed ?? false,
            createdAt: meta.createdAt,
            updatedAt: meta.updatedAt,
            active: isAgentSessionActive(id),
          },
          messages: sdkMessagesToViewMessages(messages as unknown as Array<Record<string, unknown>>),
        },
      }
    }

    // 查询某 Pi 模型可用的推理档位能力（Pocket 思考档位菜单与服务端同源，避免两端快照漂移）。
    // baseUrl 可选，旧版 Pocket 不传时仍按 provider 的静态默认协议处理。
    case 'get_pi_reasoning_capability': {
      const provider = typeof parsed.provider === 'string' ? parsed.provider : ''
      const modelId = typeof parsed.modelId === 'string' ? parsed.modelId : undefined
      const baseUrl = typeof parsed.baseUrl === 'string' ? parsed.baseUrl : undefined
      if (!provider) return { ok: false, error: '缺少 provider' }
      // resolvePiReasoningCapability 是异步的（需读 pi-ai 目录），必须 await，
      // 否则 data 会变成 Promise 而被 JSON 序列化成 {}。
      return { ok: true, data: await resolvePiReasoningCapability(provider as import('@profer/shared').ProviderType, modelId, baseUrl) }
    }

    // 工作区文件检索（Pocket `@` 引用）：桌面端由 renderer 提交 rootPath/additionalPaths
    // 后本地扫描；远程端没有本地 fs，因此**不接受客户端提交的 rootPath / candidateBasePaths**，
    // roots 一律由服务端从会话 meta 推导（与 resolve_and_read_file 同一授权策略），
    // 保证搜索返回的条目一定能被后续的 read_file_as_data_url 再校验通过。
    case 'search_workspace_files': {
      const sessionId = typeof parsed.sessionId === 'string' ? parsed.sessionId : ''
      const query = typeof parsed.query === 'string' ? parsed.query : ''
      const limit = typeof parsed.limit === 'number' ? parsed.limit : undefined
      if (!sessionId) return { ok: false, error: '缺少 sessionId' }
      const session = getAgentSessionMeta(sessionId)
      if (!session?.workspaceId) return { ok: false, error: '会话不存在或未绑定工作区' }
      const workspace = getAgentWorkspace(session.workspaceId)
      if (!workspace) return { ok: false, error: '会话工作区不存在' }
      return {
        ok: true,
        data: searchRemoteWorkspaceFiles({
          query,
          limit,
          sessionRoot: getAgentSessionWorkspacePath(workspace.slug, sessionId),
          workspaceRoot: getWorkspaceFilesDir(workspace.slug),
          sessionAttachedPaths: [
            ...(session.attachedDirectories ?? []),
            ...(session.attachedFiles ?? []),
          ],
          workspaceAttachedPaths: [
            ...getWorkspaceAttachedDirectories(workspace.slug),
            ...getWorkspaceAttachedFiles(workspace.slug),
          ],
        }),
      }
    }

    case 'update_session_model': {
      const sessionId = parsed.sessionId as string
      const channelId = typeof parsed.channelId === 'string' && parsed.channelId ? parsed.channelId : undefined
      const modelId = typeof parsed.modelId === 'string' && parsed.modelId ? parsed.modelId : undefined
      if (!sessionId) return { ok: false, error: '缺少有效 sessionId' }
      if (modelId && !channelId) return { ok: false, error: '模型必须绑定到有效渠道' }
      const modelRevisionError = validateExpectedRevision(parsed, sessionId)
      if (modelRevisionError) return modelRevisionError
      if (isAgentSessionActive(sessionId)) return { ok: false, error: 'Agent 正在运行，完成后再切换模型' }
      const session = getAgentSessionMeta(sessionId)
      if (!session) return { ok: false, error: '会话不存在' }
      if (channelId) {
        const channel = listSwitchableChannels().find((item) => item.id === channelId)
        if (!channel) return { ok: false, error: '渠道不可用或不存在' }
        if (!isChannelEnabledForRuntime(channel, session.agentRuntime ?? 'claude')) {
          return { ok: false, error: `当前会话内核不支持该渠道: ${session.agentRuntime ?? 'claude'}` }
        }
        if (modelId && !getEnabledModels(channel).some((model) => model.id === modelId)) return { ok: false, error: '模型不属于当前渠道或未启用' }
      }
      const updated = updateAgentSessionUiMeta(sessionId, { channelId, modelId })
      // 与桌面 ModelSelector 一致：切换模型同时更新全局默认（新会话继承）。
      // 移动端没有本地设置页，不写回 settings 的话「上次使用的模型」只在桌面生效，
      // 手机上连建两个会话就会回到第一个渠道的首个模型。
      if (updated.channelId && updated.modelId) {
        const current = getSettings()
        if (current.agentChannelId !== updated.channelId || current.agentModelId !== updated.modelId) {
          updateSettings({ agentChannelId: updated.channelId, agentModelId: updated.modelId })
        }
      }
      return { ok: true, data: buildSessionItem(updated) }
    }

    case 'update_session_runtime': {
      const sessionId = parsed.sessionId as string
      const runtime = parsed.runtime === 'pi' ? 'pi' : parsed.runtime === 'claude' ? 'claude' : null
      if (!sessionId || !runtime) return { ok: false, error: '缺少有效 sessionId 或 runtime' }
      const runtimeRevisionError = validateExpectedRevision(parsed, sessionId)
      if (runtimeRevisionError) return runtimeRevisionError
      const meta = getAgentSessionMeta(sessionId)
      if (!meta) return { ok: false, error: '会话不存在' }
      if (normalizeAgentRuntime(meta.agentRuntime) === runtime) return { ok: true, data: buildSessionItem(meta) }
      if (!canSelectAgentSessionRuntime(meta)) return { ok: false, error: AGENT_SESSION_RUNTIME_LOCKED_MESSAGE }
      if (isAgentSessionActive(sessionId)) return { ok: false, error: 'Agent 已开始运行，内核选择已固定' }
      const updated = updateAgentSessionUiMeta(sessionId, { agentRuntime: runtime })
      return { ok: true, data: buildSessionItem(updated) }
    }

    case 'update_permission_mode': {
      const sessionId = parsed.sessionId as string
      const mode = parsed.mode as import('@profer/shared').ProferPermissionMode
      if (!sessionId || !['auto', 'plan', 'bypassPermissions'].includes(mode)) return { ok: false, error: '缺少有效 sessionId 或权限模式' }
      const permissionRevisionError = validateExpectedRevision(parsed, sessionId)
      if (permissionRevisionError) return permissionRevisionError
      if (!getAgentSessionMeta(sessionId)) return { ok: false, error: '会话不存在' }
      const current = getAgentSessionMeta(sessionId)
      if (!current) return { ok: false, error: '会话不存在' }
      const updated = updateAgentSessionMeta(sessionId, { permissionMode: mode })
      try {
        if (isAgentSessionActive(sessionId)) await updateAgentPermissionMode(sessionId, mode)
      } catch (error) {
        const restored = updateAgentSessionMeta(sessionId, { permissionMode: current.permissionMode })
        publishAgentSessionProjection(restored)
        return { ok: false, error: error instanceof Error ? error.message : '切换权限模式失败' }
      }
      publishAgentSessionProjection(updated)
      agentEventBus.emit(sessionId, { kind: 'profer_event', event: { type: 'permission_mode_changed', mode } })
      return { ok: true, data: buildSessionItem(updated) }
    }

    // Agent 预设（对齐桌面 AGENT_PRESET_IPC_CHANNELS；pocket 无 Electron IPC，走 WS 读写预设）
    case 'list_presets': {
      const workspaceSlug = typeof parsed.workspaceSlug === 'string' ? parsed.workspaceSlug : undefined
      try {
        return { ok: true, data: listAgentPresets(workspaceSlug) }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : '获取预设列表失败' }
      }
    }

    case 'get_default_preset': {
      const workspaceSlug = typeof parsed.workspaceSlug === 'string' ? parsed.workspaceSlug : undefined
      try {
        return { ok: true, data: getDefaultPresetId(workspaceSlug) }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : '获取默认预设失败' }
      }
    }

    case 'set_default_preset': {
      const workspaceSlug = typeof parsed.workspaceSlug === 'string' ? parsed.workspaceSlug : undefined
      const presetId = typeof parsed.presetId === 'string' ? parsed.presetId : ''
      if (!presetId) return { ok: false, error: '缺少 presetId' }
      try {
        return { ok: true, data: setDefaultPresetId(workspaceSlug, presetId) }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : '设置默认预设失败' }
      }
    }

    case 'update_session_preset': {
      const sessionId = typeof parsed.sessionId === 'string' ? parsed.sessionId : ''
      const presetId = typeof parsed.presetId === 'string' ? parsed.presetId : ''
      if (!sessionId || !presetId) return { ok: false, error: '缺少 sessionId 或 presetId' }
      const session = getAgentSessionMeta(sessionId)
      if (!session) return { ok: false, error: '会话不存在' }
      const presetRevisionError = validateExpectedRevision(parsed, sessionId)
      if (presetRevisionError) return presetRevisionError
      // 按会话所属工作区解析；存在性校验：未知 ID 报错而非静默回退 standard（与桌面 UPDATE_SESSION_PRESET 同语义）
      const workspaceSlug = session.workspaceId ? getAgentWorkspace(session.workspaceId)?.slug : undefined
      const resolved = getAgentPreset(workspaceSlug, presetId)
      if (resolved.id !== presetId) return { ok: false, error: `预设不存在: ${presetId}` }
      const updated = updateAgentSessionUiMeta(sessionId, { presetId, presetReference: presetReferenceForId(workspaceSlug, presetId) })
      return { ok: true, data: buildSessionItem(updated) }
    }

    case 'create_preset': {
      const workspaceSlug = typeof parsed.workspaceSlug === 'string' ? parsed.workspaceSlug : undefined
      const input = parsed.input as AgentPresetCreateInput | undefined
      if (!input) return { ok: false, error: '缺少 input' }
      try {
        return { ok: true, data: createAgentPreset(workspaceSlug, input) }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : '创建预设失败' }
      }
    }

    case 'copy_preset': {
      const workspaceSlug = typeof parsed.workspaceSlug === 'string' ? parsed.workspaceSlug : undefined
      const fromId = typeof parsed.fromId === 'string' ? parsed.fromId : ''
      const name = typeof parsed.name === 'string' ? parsed.name : undefined
      if (!fromId) return { ok: false, error: '缺少 fromId' }
      try {
        return { ok: true, data: copyAgentPreset(workspaceSlug, fromId, name) }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : '复制预设失败' }
      }
    }

    case 'update_preset': {
      const workspaceSlug = typeof parsed.workspaceSlug === 'string' ? parsed.workspaceSlug : undefined
      const presetId = typeof parsed.presetId === 'string' ? parsed.presetId : ''
      const updates = parsed.updates as AgentPresetUpdateInput | undefined
      if (!presetId || !updates) return { ok: false, error: '缺少 presetId 或 updates' }
      try {
        return { ok: true, data: updateAgentPreset(workspaceSlug, presetId, updates) }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : '更新预设失败' }
      }
    }

    case 'delete_preset': {
      const workspaceSlug = typeof parsed.workspaceSlug === 'string' ? parsed.workspaceSlug : undefined
      const presetId = typeof parsed.presetId === 'string' ? parsed.presetId : ''
      if (!presetId) return { ok: false, error: '缺少 presetId' }
      try {
        deleteAgentPreset(workspaceSlug, presetId)
        return { ok: true, data: null }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : '删除预设失败' }
      }
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

    // 移动端图片附件：保存到会话工作目录（与桌面 saveFilesToAgentSession 同源），
    // 由客户端在消息前拼 <attached_files>，Agent 通过 Read 直接读图。
    // 不把 base64 塞进消息体，避免 WS 与 JSONL 体积膨胀。
    case 'save_agent_attachment': {
      const sessionId = typeof parsed.sessionId === 'string' ? parsed.sessionId : ''
      const filename = typeof parsed.filename === 'string' ? basename(parsed.filename).replace(/[\\/]/g, '_') : ''
      const base64 = typeof parsed.base64 === 'string' ? parsed.base64 : ''
      if (!sessionId || !filename || !base64) return { ok: false, error: '缺少有效附件数据' }
      const session = getAgentSessionMeta(sessionId)
      if (!session) return { ok: false, error: '会话不存在' }
      if (!session.workspaceId) return { ok: false, error: '会话未绑定工作区' }
      const workspace = getAgentWorkspace(session.workspaceId)
      if (!workspace) return { ok: false, error: '会话工作区不存在' }
      const bytes = Buffer.from(base64, 'base64')
      if (bytes.length === 0) return { ok: false, error: '附件数据为空' }
      if (bytes.length > 10 * 1024 * 1024) return { ok: false, error: '附件不能超过 10 MB' }
      const saved = saveFilesToAgentSession({
        workspaceSlug: workspace.slug,
        sessionId,
        files: [{ filename, data: base64 }],
      })
      const file = saved[0]
      if (!file) return { ok: false, error: '附件保存失败' }
      return { ok: true, data: { filename: file.filename, path: file.targetPath, size: bytes.length } }
    }

    case 'rename_session': {
      const sessionId = parsed.sessionId as string
      const title = typeof parsed.title === 'string' ? parsed.title.trim() : ''
      if (!sessionId || !title) return { ok: false, error: '缺少 sessionId 或 title' }
      const meta = updateAgentSessionUiMeta(sessionId, { title, titleLockedAt: Date.now() })
      return { ok: true, data: buildSessionItem(meta) }
    }

    case 'regenerate_session_title': {
      const sessionId = typeof parsed.sessionId === 'string' ? parsed.sessionId : ''
      if (!sessionId) return { ok: false, error: '缺少 sessionId' }
      const meta = getAgentSessionMeta(sessionId)
      if (!meta) return { ok: false, error: '会话不存在' }
      const channelId = typeof parsed.channelId === 'string' ? parsed.channelId : meta.channelId
      const modelId = typeof parsed.modelId === 'string' ? parsed.modelId : meta.modelId
      if (!channelId) return { ok: false, error: '重新生成标题失败：当前会话没有可用渠道，请先选择模型' }
      if (!modelId) return { ok: false, error: '重新生成标题失败：当前会话没有可用模型，请先选择模型' }
      const channel = listSwitchableChannels().find((item) => item.id === channelId)
      if (!channel) return { ok: false, error: '重新生成标题失败：当前模型渠道不存在或已禁用' }
      if (!getEnabledModels(channel).some((model) => model.id === modelId)) {
        return { ok: false, error: '重新生成标题失败：当前模型不存在或已禁用' }
      }
      try {
        const result = await regenerateAgentTitle(sessionId, channelId, modelId)
        if (!result) return { ok: false, error: '重新生成标题失败：当前会话没有可用于生成标题的有效用户消息' }
        const updated = getAgentSessionMeta(sessionId)
        return updated ? { ok: true, data: buildSessionItem(updated) } : { ok: false, error: '重新生成标题后会话不存在' }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : '重新生成标题失败' }
      }
    }

    case 'mark_session_unread': {
      const sessionId = typeof parsed.sessionId === 'string' ? parsed.sessionId : ''
      if (!sessionId) return { ok: false, error: '缺少 sessionId' }
      const meta = getAgentSessionMeta(sessionId)
      if (!meta) return { ok: false, error: '会话不存在' }
      // 与侧边栏「标记未读」同一语义，统一走唯一写入口。
      const updated = setAgentSessionUnread(sessionId, true) ?? meta
      return { ok: true, data: buildSessionItem(updated) }
    }

    case 'mark_session_read': {
      const sessionId = typeof parsed.sessionId === 'string' ? parsed.sessionId : ''
      if (!sessionId) return { ok: false, error: '缺少 sessionId' }
      const meta = getAgentSessionMeta(sessionId)
      if (!meta) return { ok: false, error: '会话不存在' }
      // 开启态下「已读」只能由用户显式确认触发（桌面按钮 / 显式标记）。
      // Pocket 关闭标签页时会自动调本命令，那是导航副作用而不是用户意图，必须 no-op，
      // 否则手机上一划就把桌面未读吃掉且无处恢复（requirements §3.2-5）。
      // 关闭态保持原行为：无条件清（现状回归）。
      if (getAgentUnreadPolicyMode() === 'manual' && parsed.explicit !== true) {
        return { ok: true, data: buildSessionItem(meta) }
      }
      const updated = setAgentSessionUnread(sessionId, false) ?? meta
      return { ok: true, data: buildSessionItem(updated) }
    }

    case 'create_session': {
      const title = (parsed.title as string) || undefined
      const workspaceId = typeof parsed.workspaceId === 'string' ? parsed.workspaceId : undefined
      const requestedPresetId = typeof parsed.presetId === 'string' ? parsed.presetId : undefined
      const workspaceSlug = workspaceId ? getAgentWorkspace(workspaceId)?.slug : undefined
      const presetId = requestedPresetId ?? getDefaultPresetId(workspaceSlug)
      // 缺省渠道/模型时继承桌面「上次使用」：手机只发 title 也能建出可发消息的会话。
      const agentRuntime = normalizeAgentRuntime(getSettings().agentRuntime)
      const selection = resolveRemoteAgentSelection(
        typeof parsed.channelId === 'string' ? parsed.channelId : undefined,
        typeof parsed.modelId === 'string' ? parsed.modelId : undefined,
        agentRuntime,
      )
      let meta = createAgentSession(
        title,
        selection.channelId,
        workspaceId,
        selection.modelId,
        agentRuntime,
        false,
        presetId,
      )
      if (typeof parsed.permissionMode === 'string' && isProferPermissionMode(parsed.permissionMode)) {
        meta = updateAgentSessionMeta(meta.id, { permissionMode: parsed.permissionMode })
      }
      publishSessionUpdated(meta)
      // 完整 item 让移动端无需再拉一次 800+ 会话的全量列表；sessionId/title/draft 保留给旧客户端。
      return {
        ok: true,
        data: { ...buildSessionItem(meta), sessionId: meta.id, title: meta.title, draft: meta.draft ?? false },
      }
    }

    // Chat 与 Agent 共用电脑端持久化目录，直接复用桌面迁移逻辑，避免移动端复制一份转换规则。
    case 'migrate_chat_to_agent': {
      const conversationId = typeof parsed.conversationId === 'string' ? parsed.conversationId : ''
      const agentSessionId = typeof parsed.agentSessionId === 'string' ? parsed.agentSessionId : ''
      if (!conversationId || !agentSessionId) return { ok: false, error: '缺少 conversationId 或 agentSessionId' }
      if (!listConversations(true).some((conversation) => conversation.id === conversationId)) {
        return { ok: false, error: '对话不存在' }
      }
      if (!getAgentSessionMeta(agentSessionId)) return { ok: false, error: 'Agent 会话不存在' }
      try {
        migrateChatToAgentSession(conversationId, agentSessionId)
        return { ok: true, data: { migrated: true } }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    }

    // 语义对齐桌面 ensureProjectDraftAgentSession：项目已有草稿会话则复用（发过消息则晋升正式），否则创建
    case 'ensure_project_draft_session': {
      const workspaceId = parsed.workspaceId as string
      if (!workspaceId) return { ok: false, error: '缺少 workspaceId' }
      const agentRuntime = normalizeAgentRuntime(getSettings().agentRuntime)
      const selection = resolveRemoteAgentSelection(
        typeof parsed.channelId === 'string' ? parsed.channelId : undefined,
        typeof parsed.modelId === 'string' ? parsed.modelId : undefined,
        agentRuntime,
      )
      const meta = ensureProjectDraftAgentSession(
        workspaceId,
        selection.channelId,
        selection.modelId,
        agentRuntime,
      )
      publishSessionUpdated(meta)
      // 与 create_session 同一形状；draft 仍显式保留，旧客户端依赖该字段判断草稿复用。
      return {
        ok: true,
        data: { ...buildSessionItem(meta), sessionId: meta.id, title: meta.title, draft: meta.draft ?? true },
      }
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
      // 渲染进程预生成的流式开始时间戳 / 消息 UUID：原样透传到 AgentSendInput，
      // 让 run_completed.startedAt 与前端流状态同源（消除跨机时钟比较），
      // 并让持久化消息可按 uuid 与前端乐观气泡匹配去重。两者均缺省回退现有行为。
      const startedAt = typeof parsed.startedAt === 'number' ? parsed.startedAt : Date.now()
      const uuid = typeof parsed.uuid === 'string' ? parsed.uuid : undefined

      // 弱网重连重放幂等：移动端断线后按原 clientMessageId 重发同一逻辑消息，这里去重，避免重复启动 run。
      if (isSendMessageDuplicate(clientMessageId)) {
        return { ok: true, data: { accepted: true, deduped: true } }
      }

      // 异步执行，不阻塞 WS 响应；结果通过事件流返回。
      // onComplete 不再空置：orchestrator 会在 run 真正结束时回调「已持久化的完整消息列表」，
      // 这里把 completion 标记（携带最终消息 + 完成元数据）通过 agentEventBus 广播给移动端，
      // 让移动端能确定性地拿到"结果已落盘"的完成信号，而不是只依赖 run_idle 的间接触发。
      // run 失败原因：orchestrator / agent-service 的 onError 一定先于 onComplete 触发，
      // 这里暂存并并入 completion 的 resultErrors，让 Pocket 能看到真实错误文案（而非只有「执行出错」）。
      let runErrorMessage: string | null = null
      // runtime coordinator opt-in：默认仍保留旧 headless 路径，便于逐步迁移和回退。
      // 开关只读一次：既保证「全仓只有本入口读它」的可审计性，也让预检与分支使用同一个值。
      const useRuntimeRemote = process.env.PROFER_RUNTIME_REMOTE === '1'
      const headlessInput: AgentSendInput = {
        sessionId, userMessage, channelId, modelId, workspaceId, startedAt,
        initiator: 'user',
        ...(uuid ? { uuid } : {}),
      }
      // 取得执行权之前不做任何副作用：被拒绝的请求不是一次运行，失败必须同步返回，
      // 否则客户端已经收到 `accepted: true` 却永远等不到 `run_completed`。
      // 预检与 runAgentRuntimeHeadless 之间全是同步语句，互斥由 coordinator 的 claim 最终保证。
      const remoteBlocked = useRuntimeRemote
        ? peekAgentRunClaimFailureForSession(sessionId, normalizeAgentRuntime(getAgentSessionMeta(sessionId)?.agentRuntime))
        : undefined
      if (remoteBlocked) return { ok: false, error: describeAgentRunRejection(remoteBlocked) }
      // cwd 不再由入口覆写：统一 host/context 按 `getAgentSessionWorkspacePath(workspaceSlug, sessionId)`
      // 推导（与旧链同源），否则多个 remote session 会共享 workspace 根 cwd 与 Pi checkpoint。
      const runtimeRun = useRuntimeRemote
        ? runAgentRuntimeHeadless(
            headlessInput,
            {
              source: 'bridge',
              onError: error => {
                runErrorMessage = error
                console.error('[Remote] runtime send_message 运行失败:', runErrorMessage)
              },
              onComplete: () => {},
              onTitleUpdated: () => {},
            },
          )
        : runAgentHeadless(headlessInput, {
            source: 'bridge',
            onError: error => {
              runErrorMessage = error
              console.error('[Remote] send_message 运行失败:', error)
            },
            onComplete: (_messages, opts) => {
              agentEventBus.emit(sessionId, { kind: 'profer_event', event: { type: 'run_completed', sessionId, stoppedByUser: opts?.stoppedByUser ?? false, startedAt: opts?.startedAt ?? startedAt, resultSubtype: opts?.resultSubtype, resultErrors: opts?.resultErrors ?? (runErrorMessage ? [runErrorMessage] : undefined), backgroundTasksPending: opts?.backgroundTasksPending ?? false, endReason: opts?.endReason, endReasonLabel: opts?.endReasonLabel } })
            },
            onTitleUpdated: () => {},
          })
      void runtimeRun.catch((e) => console.error('[Remote] send_message 执行异常:', e))
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
        publishSessionUpdated(meta)
        return { ok: true, data: buildSessionItem(meta) }
      } catch (error) {
        console.error('[Remote] fork_session 失败:', error)
        return { ok: false, error: error instanceof Error ? error.message : '分叉会话失败' }
      }
    }

    // 探索分支：从指定 assistant 消息处分叉出一条 Pi `/tree` 探索分支。
    // 与 fork_session 是两种语义（fork = 重建独立顶层会话；explore = 挂在主线血缘下的分支），
    // 因此独立成命令，不给 fork_session 加可选参数以免把「可选字段」变成隐式模式开关。
    // 失败路径由 forkPiAgentSession 内部的 deleteAgentSession 回滚，不留半成品会话。
    case 'create_exploration_session': {
      const sessionId = typeof parsed.sessionId === 'string' ? parsed.sessionId.trim() : ''
      const upToMessageUuid = typeof parsed.upToMessageUuid === 'string' ? parsed.upToMessageUuid.trim() : ''
      if (!sessionId || !upToMessageUuid) return { ok: false, error: '缺少 sessionId 或 upToMessageUuid' }
      try {
        const meta = await forkAgentSession({
          sessionId,
          upToMessageUuid,
          // 不传 modelId：探索必须继承源会话渠道与模型（与桌面入口一致）。
          explorationSourceLabel: normalizeExplorationSourceLabel(parsed.explorationSourceLabel),
        })
        publishSessionUpdated(meta)
        return { ok: true, data: buildSessionItem(meta) }
      } catch (error) {
        console.error('[Remote] create_exploration_session 失败:', error)
        return { ok: false, error: error instanceof Error ? error.message : '创建探索分支失败' }
      }
    }

    // 快照回退 / 清空对话（同一会话内回退到指定点；无 assistantMessageUuid 时清空整段对话）
    case 'rewind_session': {
      const sessionId = typeof parsed.sessionId === 'string' ? parsed.sessionId : ''
      const assistantMessageUuid = typeof parsed.assistantMessageUuid === 'string' && parsed.assistantMessageUuid
        ? parsed.assistantMessageUuid
        : undefined
      if (!sessionId) return { ok: false, error: '缺少 sessionId' }
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
      // 与桌面 TOGGLE_PIN 同口径：置顶不刷新 updatedAt，不改变「最近」排序
      const updated = updateAgentSessionUiMeta(sessionId, updates, { touchUpdatedAt: false })
      return { ok: true, data: buildSessionItem(updated) }
    }

    // 归档/取消归档（对齐桌面 TOGGLE_ARCHIVE）：归档时自动取消置顶；开启态下归档视作已读，一并清未读。
    case 'toggle_session_archive': {
      const sessionId = typeof parsed.sessionId === 'string' ? parsed.sessionId : ''
      if (!sessionId) return { ok: false, error: '缺少 sessionId' }
      const current = listAgentSessions(true).find((s) => s.id === sessionId)
      if (!current) return { ok: false, error: `Agent 会话不存在: ${sessionId}` }
      // 与桌面 TOGGLE_ARCHIVE 共用同一纯函数，保证「归档＝已读」口径不分端（移动端归档清未读属开启态策略，保留）。
      // 归档不刷新 updatedAt：与置顶同口径，状态切换不算会话活跃。
      const updated = updateAgentSessionUiMeta(sessionId, buildArchiveToggleUpdates({
        archived: current.archived ?? false,
        pinned: current.pinned ?? false,
        completedButUnconfirmed: current.completedButUnconfirmed ?? false,
      }, getAgentUnreadPolicyMode()), { touchUpdatedAt: false })
      return { ok: true, data: buildSessionItem(updated) }
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
        const updated = moveSessionToWorkspace(sessionId, targetWorkspaceId)
        publishAgentSessionProjection(updated)
        return { ok: true, data: buildSessionItem(updated) }
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
      const validLevels = [null, 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
      if (level !== null && !validLevels.includes(level)) {
        return { ok: false, error: `无效的推理档位: ${String(level)}` }
      }
      if (!getAgentSessionMeta(sessionId)) return { ok: false, error: `Agent 会话不存在: ${sessionId}` }
      if (isAgentSessionActive(sessionId)) return { ok: false, error: 'Agent 正在运行，完成后再切换推理档位' }
      const updated = updateAgentSessionUiMeta(sessionId, { openAIThinkingLevel: level as import('@profer/shared').AgentThinkingLevel | null })
      return { ok: true, data: buildSessionItem(updated) }
    }

    // 设置会话推理强度覆盖（对齐桌面 UPDATE_SESSION_AGENT_EFFORT：null=清除覆盖，运行中拒绝）
    case 'update_session_agent_effort': {
      const sessionId = typeof parsed.sessionId === 'string' ? parsed.sessionId : ''
      const effort = parsed.effort as string | null
      if (!sessionId) return { ok: false, error: '缺少 sessionId' }
      const validEfforts = [null, 'low', 'medium', 'high', 'max']
      if (effort !== null && !validEfforts.includes(effort)) {
        return { ok: false, error: `无效的推理强度: ${String(effort)}` }
      }
      if (!getAgentSessionMeta(sessionId)) return { ok: false, error: `Agent 会话不存在: ${sessionId}` }
      if (isAgentSessionActive(sessionId)) return { ok: false, error: 'Agent 正在运行，完成后再切换思考强度' }
      const updated = updateAgentSessionUiMeta(sessionId, { agentEffort: effort as import('@profer/shared').AgentEffort | null })
      return { ok: true, data: buildSessionItem(updated) }
    }

    // 队列消息：向正在运行的 Agent 注入（interrupt=true 时软打断当前 turn 立即插入）。
    // 桌面端 queueAgentMessage IPC 的等价物；会话未运行时返回 "会话未运行" 错误，
    // 移动端 stub 据此降级为 send_message 新建 run（与桌面 isQueueTargetNoLongerActiveError 一致）。
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
          // 桌面 IPC 的 webContents 仅用于把事件转发到渲染进程；移动端走 EventBus → WS，无需指定
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
      return { ok: true, data: updateConversationMeta(id, { title, titleLockedAt: Date.now() }) }
    }

    case 'regenerate_conversation_title': {
      const conversationId = typeof parsed.conversationId === 'string' ? parsed.conversationId : ''
      if (!conversationId) return { ok: false, error: '缺少 conversationId' }
      const meta = listConversations(true).find((conversation) => conversation.id === conversationId)
      if (!meta) return { ok: false, error: '对话不存在' }
      const channelId = typeof parsed.channelId === 'string' ? parsed.channelId : meta.channelId
      const modelId = typeof parsed.modelId === 'string' ? parsed.modelId : meta.modelId
      if (!channelId || !modelId) return { ok: false, error: '重新生成标题失败：当前对话没有可用模型' }
      const updated = await regenerateConversationTitle(conversationId, channelId, modelId)
      return updated
        ? { ok: true, data: updated }
        : { ok: false, error: '重新生成标题失败：当前对话没有有效消息或模型不可用' }
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
      // 与桌面 TOGGLE_PIN 同口径：置顶不刷新 updatedAt，不改变「最近」排序
      return { ok: true, data: updateConversationMeta(id, updates, { touchUpdatedAt: false }) }
    }

    case 'toggle_conversation_archive': {
      const id = parsed.conversationId as string
      if (!id) return { ok: false, error: '缺少 conversationId' }
      const current = listConversations(true).find((c) => c.id === id)
      if (!current) return { ok: false, error: '对话不存在' }
      const newArchived = !current.archived
      const updates: { archived: boolean; pinned?: boolean } = { archived: newArchived }
      if (newArchived && current.pinned) updates.pinned = false
      // 与桌面 TOGGLE_ARCHIVE 同口径：归档不刷新 updatedAt
      return { ok: true, data: updateConversationMeta(id, updates, { touchUpdatedAt: false }) }
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
          runId: randomUUID(),
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
      console.warn('[远程] chat_truncate_messages_from 已废弃，建议改用 forkBranchAt + setActivePath')
      return { ok: true, data: truncateMessagesFrom(conversationId, messageId, parsed.preserveFirstMessageAttachments === true) }
    }

    case 'chat_get_branch': {
      const conversationId = parsed.conversationId as string
      if (!conversationId) return { ok: false, error: '缺少 conversationId' }
      return { ok: true, data: getConversationBranch(conversationId) }
    }

    case 'chat_set_active_path': {
      const conversationId = parsed.conversationId as string
      const path = Array.isArray(parsed.path) ? parsed.path as string[] : null
      if (!conversationId || !path) return { ok: false, error: '缺少 conversationId 或 path' }
      try {
        setActivePath(conversationId, path)
        return { ok: true, data: getConversationBranch(conversationId) }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    }

    case 'chat_get_branch_tree': {
      const conversationId = parsed.conversationId as string
      if (!conversationId) return { ok: false, error: '缺少 conversationId' }
      return { ok: true, data: getBranchTree(conversationId) }
    }

    case 'chat_fork_branch_at': {
      const conversationId = parsed.conversationId as string
      const anchorId = parsed.anchorId as string
      const payload = (parsed.payload ?? {}) as Parameters<typeof forkBranchAt>[2]
      // PR #121 review by Copilot：必须用 typeof 判断 content，不能用 truthy——空字符串
      // 是合法的"只更新附件/引用而内容为空"的编辑分叉场景，!payload?.content 会误判缺失。
      if (!conversationId || !anchorId || !payload || typeof payload.content !== 'string') {
        return { ok: false, error: '缺少 conversationId / anchorId / payload.content' }
      }
      try {
        return { ok: true, data: forkBranchAt(conversationId, anchorId, payload) }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    }

    case 'chat_get_message_content': {
      const conversationId = parsed.conversationId as string
      const messageId = parsed.messageId as string
      if (!conversationId || !messageId) return { ok: false, error: '缺少 conversationId 或 messageId' }
      return { ok: true, data: getMessageContent(conversationId, messageId) }
    }

    case 'chat_update_context_dividers': {
      const conversationId = parsed.conversationId as string
      const dividers = Array.isArray(parsed.dividers) ? parsed.dividers as string[] : null
      if (!conversationId || !dividers) return { ok: false, error: '缺少 conversationId 或 dividers' }
      if (!listConversations(true).some((c) => c.id === conversationId)) return { ok: false, error: '对话不存在' }
      return { ok: true, data: updateContextDividers(conversationId, dividers) }
    }

    case 'chat_auto_title': {
      const conversationId = typeof parsed.conversationId === 'string' ? parsed.conversationId : ''
      const channelId = typeof parsed.channelId === 'string' ? parsed.channelId : ''
      const modelId = typeof parsed.modelId === 'string' ? parsed.modelId : ''
      if (!conversationId || !channelId || !modelId) return { ok: false, error: '缺少 conversationId / channelId / modelId' }
      const updated = await autoTitleConversation({ conversationId, channelId, modelId })
      return { ok: true, data: updated }
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

    // ---- 文件预览：移动端经 WS 读取电脑端文件内容（Pocket 文件预览 MVP） ----
    // Remote token 可在非受信网络泄露，因此权限必须严格绑定到现有会话。
    // 客户端提交的 candidateBasePaths 不参与授权或路径解析。
    case 'resolve_and_read_file':
    case 'read_file_as_data_url': {
      const filePath = typeof parsed.filePath === 'string' ? parsed.filePath : ''
      // Pocket 0.1.4 及更早版本沿用桌面 FileAccessOptions，将 sessionId
      // 嵌套在 access 中。兼容该传输形状，但绝不采纳其 candidateBasePaths。
      const legacyAccess = parsed.access as { sessionId?: unknown } | undefined
      const sessionId = typeof parsed.sessionId === 'string'
        ? parsed.sessionId
        : typeof legacyAccess?.sessionId === 'string'
          ? legacyAccess.sessionId
          : context?.activeSessionId ?? ''
      if (!filePath || !sessionId) return { ok: false, error: '缺少 filePath 或 sessionId' }
      const session = getAgentSessionMeta(sessionId)
      if (!session?.workspaceId) return { ok: false, error: '会话不存在或未绑定工作区' }
      const workspace = getAgentWorkspace(session.workspaceId)
      if (!workspace) return { ok: false, error: '会话工作区不存在' }

      const resolvedPath = resolveAuthorizedRemoteFilePath(filePath, {
        directoryRoots: [
          getAgentSessionWorkspacePath(workspace.slug, sessionId),
          getAgentWorkspacePath(workspace.slug),
          getWorkspaceFilesDir(workspace.slug),
          ...(session.attachedDirectories ?? []),
          ...getWorkspaceAttachedDirectories(workspace.slug),
        ],
        exactFiles: [
          ...(session.attachedFiles ?? []),
          ...getWorkspaceAttachedFiles(workspace.slug),
        ],
      })
      if (!resolvedPath) return { ok: false, error: '文件不存在或不在当前会话授权范围内' }

      try {
        const result = type === 'resolve_and_read_file'
          ? resolveAndReadFile(resolvedPath)
          : readFileAsDataUrl(resolvedPath)
        if (!result) return { ok: false, error: '文件不可读或超过大小限制' }
        return { ok: true, data: result }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : '文件读取失败' }
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
export function startRemoteService(): Promise<string | null> { return remoteLifecycle.run(startRemoteServiceReady) }

/**
 * 启动远程服务：先试首选端口，被占则按候选序列顺延，选中后持久化。
 * 全程不向外抛异常：失败只写入 status.error，由设置页呈现，不能变成主进程崩溃框。
 */
async function startRemoteServiceReady(): Promise<string | null> {
  if (isStarted && listenAddress) return listenAddress
  if (!isRemoteEnabled()) {
    console.log('[Remote] 未启用（设置页未开启移动模式，且 PROFER_REMOTE 未设置）')
    return null
  }
  isStarted = true
  remoteError = null
  remoteNotice = null

  // 初始化 token
  accessToken = null
  try { accessToken = loadRemoteToken() } catch (e) {
    isStarted = false
    remoteError = e instanceof Error ? e.message : '安全存储失败'
    return null
  }

  const preferred = getPort()
  const candidates = remotePortCandidates(preferred)
  let lastCode: string | null = null
  let lastMessage = ''

  for (const [index, port] of candidates.entries()) {
    // 首选端口多等几次（旧进程可能正在退出）；后续候选只试一次，避免启动被拖太久。
    const delays = index === 0 ? REMOTE_PORT_RETRY_DELAYS_MS : [0]
    for (const delay of delays) {
      if (delay > 0) await sleep(delay)
      let outcome: RemoteListenOutcome
      try {
        outcome = await startRemoteServiceAttempt(port)
      } catch (error) {
        // 建 server/sniffer 本身抛错也不能冒泡成主进程崩溃。
        const err = error as NodeJS.ErrnoException
        outcome = { kind: 'error', code: err?.code ?? null, message: err?.message || '未知错误' }
      }
      if (outcome.kind === 'listening') {
        await adoptRemotePort(port, preferred)
        return listenAddress
      }
      lastCode = outcome.code
      lastMessage = outcome.message
      // 不是端口冲突（地址非法/权限不足等），换端口也没用。
      if (outcome.code !== 'EADDRINUSE') break
    }
    if (lastCode !== 'EADDRINUSE') break
  }

  isStarted = false
  listenAddress = null
  remoteError = lastCode === 'EADDRINUSE'
    ? `端口 ${preferred}${candidates.length > 1 ? `-${candidates[candidates.length - 1]}` : ''} 均已被占用，请在设置中改用其他端口。`
    : `移动模式服务启动失败：${lastMessage || '未知错误'}`
  console.error('[Remote]', remoteError)
  return null
}

/** 端口候选：首选端口 + 向后顺延的若干端口。不随机，手机端才能长期复用同一地址。 */
function remotePortCandidates(preferred: number): number[] {
  const list: number[] = []
  for (let i = 0; i < REMOTE_PORT_FALLBACK_COUNT; i += 1) {
    const port = preferred + i
    if (port > 65535) break
    list.push(port)
  }
  return list
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 顺延到其他端口后持久化，并给出「需要重新扫码」的提示；下次启动直接复用该端口。 */
async function adoptRemotePort(port: number, preferred: number): Promise<void> {
  if (port === preferred) return
  remoteNotice = `端口 ${preferred} 已被占用，已自动改用 ${port}。请在手机上重新扫码配对。`
  console.warn('[Remote]', remoteNotice)
  // 端口来自环境变量时以环境变量为准，不覆盖用户设置。
  if (process.env.PROFER_REMOTE_PORT) return
  try {
    updateSettings({ pocketModePort: port })
  } catch (error) {
    console.error('[Remote] 保存端口失败:', error)
  }
}

type RemoteListenOutcome = { kind: 'listening' } | { kind: 'error'; code: string | null; message: string }

/**
 * 在指定端口上做一次监听尝试。
 * 端口冲突通过 error 事件返回；即使 listen 同步抛错也收进返回值，不冒泡。
 */
function startRemoteServiceAttempt(port: number): Promise<RemoteListenOutcome> {
  httpServer = createServer((req, res) => {
    // 健康检查（容忍 query，如 /health?token=xxx）
    if ((req.url || '').split('?')[0] === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      return
    }
    // 本机不再提供静态 UI 服务（原平板页面已随 tablet 线退役移除，2026-09-11）：非 /health 的 HTTP 请求一律 404。
    // WS 客户端（Profer-pocket）直接连 /ws，不依赖 HTTP 根路径。
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('Not Found')
  })

  wss = new WebSocketServer({ server: httpServer, path: '/ws' })

  // 闲置踢人：定期扫描，清除长时间（含心跳 ping）无任何活跃的假死连接。
  // 移动端 WebView 可能因网络切换/后台冻结形成半开连接，TCP 不报错但不再通信；
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

  const establish = (ws: WebSocket, req: IncomingMessage): void => {
    console.log('[Remote] 移动端客户端已鉴权')
    ;(ws as WebSocket & { __lastAlive?: number }).__lastAlive = Date.now()
    const commandContext: RemoteCommandContext = {}
    const replayState: AgentReplayState = {
      clientKey: randomUUID(),
      replaying: true,
      queuedLiveFrames: [],
      lastSentEventId: 0,
      fallbackTimer: null,
    }
    replayState.fallbackTimer = setTimeout(() => {
      // 兼容未实现 resume_agent_events 的旧 Pocket：握手超时后恢复普通实时广播。
      releaseAgentReplayGate(ws)
    }, AGENT_REPLAY_HANDSHAKE_TIMEOUT_MS)
    agentReplayStates.set(ws, replayState)

    // 收到指令
    ws.on('message', (raw: RawData) => {
      let reqId: unknown = null
      let body: string
      let parsedRaw: { type?: unknown } | null = null
      try {
        const parsed = JSON.parse(raw.toString())
        parsedRaw = parsed
        // 命令追踪 ID：优先 _cmdId（移动端 ws-client 新协议），兼容旧的 requestId
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

      if (parsedRaw?.type === 'resume_agent_events') {
        replayAgentEvents(ws, reqId, (parsedRaw as { cursor?: unknown }).cursor ?? null)
        return
      }

      // 刷新后的会话级回放（不依赖 cursor）。同时把本连接绑定到请求的会话，
      // 之后的实时帧与后续回放都按这个绑定归属。
      if (parsedRaw?.type === 'restore_agent_streams') {
        restoreAgentStreams(ws, reqId, parsedRaw as { sessionIds?: unknown; sinceEventId?: unknown })
        return
      }

      // 任何带 sessionId 的会话级命令都顺带声明关注：绑定是幂等的。
      const scopedSessionId = (parsedRaw as { sessionId?: unknown } | null)?.sessionId
      if (typeof scopedSessionId === 'string' && scopedSessionId.length > 0) {
        remoteAgentReplayRegistry.bindClient(replayState.clientKey, scopedSessionId)
      }

      void handleRemoteCommand(body, reqId, commandContext).then((result) => {
        // commandId 与 requestId 同源：新客户端按 commandId 幂等，旧客户端继续读取 requestId。
        const commandId = typeof reqId === 'string' && reqId.length > 0 ? reqId : randomUUID()
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ kind: 'command_result', requestId: reqId, commandId, ...result }))
        }
      })
    })

    ws.on('close', () => {
      const replayState = agentReplayStates.get(ws)
      if (replayState?.fallbackTimer) clearTimeout(replayState.fallbackTimer)
      if (replayState) remoteAgentReplayRegistry.unbindClient(replayState.clientKey)
      agentReplayStates.delete(ws)
      console.log('[Remote] 移动端客户端断开')
    })

    // 连接建立后推送握手。客户端可据此判断旧 cursor 是否跨越了服务重启。
    ws.send(JSON.stringify({
      kind: 'hello',
      serverTime: Date.now(),
      serverInstanceId,
      latestAgentEventId: remoteAgentEventLog.getLatestEventId(),
      oldestAgentEventId: remoteAgentEventLog.getOldestEventId(),
      protocolVersion: 1,
      deviceId: getRemoteProfile().deviceId,
      profile: getRemoteProfile(),
    }))
  }

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const peer = req.socket.remoteAddress?.replace(/^::ffff:/, '') ?? ''
    const legacy = ws.protocol !== REMOTE_PROTOCOL
    console.log('[Remote] 新连接 peer=', peer, '| protocol=', ws.protocol || '(legacy)', '| tls=', tlsSockets.has(ws) || publicTlsSockets.has(ws))
    if (legacy) {
      // 旧 query 路径只接受可信传输：
      // - 端到端 TLS（自建穿透的 pinned 链路 / 内置 FRP）；
      // - 私网直连；
      // - 本机反代（域名场景由 Caddy/Nginx 终止 TLS 后转发到本机）。
      // 公网明文永不接受旧协议：token 是共享凭据，不能在明文链路上传。
      const hasProxyHeaders = Boolean(req.headers.forwarded || req.headers['x-forwarded-for'] || req.headers['x-forwarded-proto'])
      const trustedTransport = isTrustedLegacyTransport({
        peer,
        encrypted: tlsSockets.has(ws) || publicTlsSockets.has(ws),
        hasProxyHeaders,
      })
      if (!trustedTransport || !checkToken(req)) { ws.close(4001, 'unauthorized'); return }
      authenticatedClients.set(ws, 'legacy')
      establish(ws, req)
      return
    }
    ws.send(JSON.stringify({ kind: 'remote_hello', protocolVersion: 1, deviceId: getRemoteProfile().deviceId }))
    const timer = setTimeout(() => { pairingManager.record('authentication_rejected', peer); ws.close(4001, 'authentication timeout') }, 8000)
    ws.once('close', () => clearTimeout(timer))
    ws.once('message', (raw: RawData) => {
      clearTimeout(timer)
      try {
        if (raw.toString().length > 8192) throw new Error('invalid request')
        const body = JSON.parse(raw.toString()) as { type?: string; deviceId?: string; pairingCode?: string; credential?: string; deviceName?: string }
        if (body.deviceId !== getRemoteProfile().deviceId) { pairingManager.record('identity_rejected', peer); throw new Error('device mismatch') }
        if (body.type === 'pair') {
          if (body.deviceId !== getRemoteProfile().deviceId || typeof body.pairingCode !== 'string') throw new Error('invalid pairing')
          const result = pairDevice(body.pairingCode, peer, body.deviceName && typeof body.deviceName === 'string' ? body.deviceName : 'Pocket')
          ws.send(JSON.stringify({ kind: 'paired', ...result, profile: getRemoteProfile() }))
          ws.close(1000, 'paired')
          return
        }
        const binding = body.type === 'authenticate' && typeof body.credential === 'string' ? authenticateRemote(body.credential, accessToken) : null
        if (!binding) throw new Error('unauthorized')
        authenticatedClients.set(ws, binding)
        establish(ws, req)
      } catch {
        pairingManager.record('authentication_rejected', peer)
        ws.close(4001, 'authentication failed')
      }
    })
  })
  profileTimer = setInterval(() => {
    const profile = getRemoteProfile()
    for (const client of wss?.clients ?? []) if (client.readyState === WebSocket.OPEN && authenticatedClients.has(client)) client.send(JSON.stringify({ kind: 'connection_profile', profile }))
  }, 15_000)
  profileTimer.unref()

  // 订阅 agentEventBus，把工作流事件广播给所有移动端客户端
  eventBusUnsubscribe = agentEventBus.on((sessionId, payload) => {
    // run_complete / run_error 是桌面终态的补充通道：移动端已有 run_completed /
    // 自身 completion 事件表达同一语义，不下发它们可避免旧版 Pocket 客户端
    // 处理未知 payload.kind，也避免事件日志里出现重复终态。
    if (payload.kind === 'run_complete' || payload.kind === 'run_error') return
    broadcastAgentEvent(sessionId, payload)
  })

  // 订阅 chatEventBus，把 Chat 流式事件（chunk/reasoning/complete/error/tool-activity）
  // 广播给所有移动端客户端；channel 使用桌面 CHAT_IPC_CHANNELS 同名通道，
  // 移动端 stub 按通道名分发到 onStreamChunk 等注册器。
  chatBusUnsubscribe = chatEventBus.on((conversationId, channel, payload) => {
    const frame = JSON.stringify({ kind: 'chat_event', conversationId, channel, payload })
    if (remoteRelaySink?.isOpen()) remoteRelaySink.send(frame)
    for (const client of wss?.clients ?? []) {
      if (client.readyState === WebSocket.OPEN && authenticatedClients.has(client)) {
        client.send(frame)
      }
    }
  })

  // 中心 relay 仅在显式开启时连接；默认仍保持本地 LAN 远程行为不变。
  if (process.env.PROFER_REMOTE_RELAY === '1') {
    remoteRelayClient = new RemoteRelayClient({
      onOpen: (sink) => {
        remoteRelaySink = sink
        remoteRelayCommandContext = {}
        // 让 Relay 后面的 Pocket 继续使用现有 WsClient 握手/快照协议。
        sink.send(JSON.stringify({
          kind: 'hello',
          serverTime: Date.now(),
          serverInstanceId,
          latestAgentEventId: remoteAgentEventLog.getLatestEventId(),
          oldestAgentEventId: remoteAgentEventLog.getOldestEventId(),
        }))
      },
      onClose: () => {
        remoteRelaySink = null
        remoteRelayCommandContext = {}
      },
      onMessage: (raw, sink) => {
        let parsed: { kind?: unknown; type?: unknown; _cmdId?: unknown; requestId?: unknown; cursor?: unknown }
        try { parsed = JSON.parse(raw) } catch { return }
        if (parsed.kind === 'relay_hello') return
        if (parsed.kind === 'pong') return
        if (parsed.type === 'ping') {
          sink.send(JSON.stringify({ kind: 'pong', serverTime: Date.now() }))
          return
        }
        if (parsed.type === 'resume_agent_events') {
          // Relay 是透明转发层；桌面端不把 viewer 的 cursor 与本机 LAN viewer 状态混用。
          // 当前最小实现要求 Pocket 重新取快照，避免跨连接 cursor 污染。
          sink.send(JSON.stringify({
            kind: 'agent_events_resumed',
            requestId: parsed._cmdId ?? parsed.requestId ?? null,
            requiresSnapshot: true,
            latestEventId: remoteAgentEventLog.getLatestEventId(),
          }))
          return
        }
        if (parsed.type === 'restore_agent_streams') {
          // 同理：relay 背后可能是多个 viewer，不在透明层做会话级回放，一律要求取快照。
          sink.send(JSON.stringify({
            kind: 'agent_streams_restored',
            requestId: parsed._cmdId ?? parsed.requestId ?? null,
            sessions: [],
            replayed: 0,
            requiresSnapshot: true,
            oldestEventId: remoteAgentEventLog.getOldestEventId(),
            latestEventId: remoteAgentEventLog.getLatestEventId(),
          }))
          return
        }
        if (typeof parsed.type !== 'string') return
        const requestId = parsed._cmdId ?? parsed.requestId ?? null
        void handleRemoteCommand(raw, requestId, remoteRelayCommandContext).then((result) => {
          const commandId = typeof requestId === 'string' && requestId.length > 0 ? requestId : randomUUID()
          if (sink.isOpen()) sink.send(JSON.stringify({ kind: 'command_result', requestId, commandId, ...result }))
        })
      },
    })
    remoteRelayClient.start()
  }

  // 监听地址：默认 0.0.0.0（局域网设备可访问，移动端通过电脑局域网 IP:端口 访问）。
  // 安全性由 accessToken 鉴权保障。可用 PROFER_REMOTE_HOST 覆盖（如设为 127.0.0.1 即仅本机）。
  const HOST = process.env.PROFER_REMOTE_HOST || '0.0.0.0'
  // 单端口双协议：首字节 0x16 是 TLS 握手，交给公网自签服务；其余走明文 HTTP/ws。
  // 这样用户自建 FRP 只需把公网端口映射到本机端口，不必额外开端口。
  const front = createProtocolSniffer((tls) => {
    const target = tls ? publicTlsServer : httpServer
    if (!target) return null
    // Electron 主进程跑在 Node 上，http/https server 会从 `connection` 事件接管 socket。
    return (socket) => { target.emit('connection', socket) }
  })
  frontServer = front

  return new Promise<RemoteListenOutcome>((resolve) => {
    let settled = false
    const settle = (outcome: RemoteListenOutcome): void => {
      if (settled) return
      settled = true
      front.removeListener('listening', onListening)
      front.removeListener('error', onError)
      resolve(outcome)
    }
    const onListening = (): void => {
      const addr = front.address() as AddressInfo | null
      const actualPort = addr?.port ?? port
      listenAddress = `http://127.0.0.1:${actualPort}`
      activeListenPort = actualPort
      remoteError = null
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
      console.log('[Remote] 连接凭据已保护，请从设置页配对')
      console.log('════════════════════════════════════════════════════\n')
      console.log(`[Remote] 服务已在 ${HOST}:${actualPort} 就绪`)
      // 公网自签证书异步准备，不阻塞明文监听；二维码生成前还会再确保一次。
      void ensurePublicTlsServer()
      settle({ kind: 'listening' })
    }
    const onError = (err: NodeJS.ErrnoException): void => {
      // listen() 是异步的；端口冲突不能冒泡成 Electron 主进程未捕获异常。
      teardownRemoteAttempt(front)
      settle({ kind: 'error', code: err.code ?? null, message: err.message || '未知错误' })
    }
    front.once('listening', onListening)
    front.once('error', onError)
    try {
      front.listen(port, HOST)
    } catch (err) {
      // 极端情况（端口非法/无权限）listen 可能同步抛错，同样只能收进状态。
      const error = err as NodeJS.ErrnoException
      teardownRemoteAttempt(front)
      settle({ kind: 'error', code: error.code ?? null, message: error.message || '未知错误' })
    }
  })
}

/** 一次监听尝试失败后的清理：只回收本次尝试创建的资源，isStarted 由调用方决定。 */
function teardownRemoteAttempt(front: NetServer): void {
  eventBusUnsubscribe?.()
  eventBusUnsubscribe = null
  chatBusUnsubscribe?.()
  chatBusUnsubscribe = null
  if (idleSweepTimer) {
    clearInterval(idleSweepTimer)
    idleSweepTimer = null
  }
  try { wss?.close() } catch { /* ignore */ }
  wss = null
  closePublicTlsServer()
  remoteRelayClient?.stop()
  remoteRelayClient = null
  remoteRelaySink = null
  if (frontServer === front) frontServer = null
  try { front.close() } catch { /* ignore */ }
  activeListenPort = null
  const failedServer = httpServer
  httpServer = null
  try { failedServer?.close() } catch { /* ignore */ }
}

/** 停止 Profer Remote Service */
export function stopRemoteService(): Promise<void> { return remoteLifecycle.run(stopRemoteServiceNow) }
async function stopRemoteServiceNow(): Promise<void> {
  pairingManager.revoke()
  if (profileTimer) clearInterval(profileTimer)
  profileTimer = null
  const frpExit = stopFrp()
  // 先停监听、立刻把端口让出来：退出/重启期间新进程马上就要 bind 同一端口。
  const front = frontServer
  frontServer = null
  try { front?.close() } catch { /* ignore */ }
  for (const client of wss?.clients ?? []) { authenticatedClients.delete(client); client.close(1001, 'service stopped'); client.terminate() }
  remoteRelayClient?.stop()
  remoteRelayClient = null
  remoteRelaySink = null
  remoteRelayCommandContext = {}
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
  closePublicTlsServer()
  const server = httpServer
  httpServer = null
  await Promise.all([frpExit, server ? closeOwnedHttp(server) : Promise.resolve(), closeRemoteTls()])
  remoteAgentEventLog.clear()
  serverInstanceId = randomUUID()
  isStarted = false
  listenAddress = null
  activeListenPort = null
  remoteError = null
  remoteNotice = null
  console.log('[Remote] 移动版服务已停止')
}
