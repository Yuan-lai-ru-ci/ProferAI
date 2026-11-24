import { sendCoreWindowEvent, isSessionWindowHandoff } from './window-handoff-buffer'
import type { WebContents } from 'electron'
import { invalidatesAgentActivity, invalidateAgentActivity, isAgentCatalogPayload, sessionWebContents } from './agent-window-delivery'
import { getAppWindowSummaries, getPrimaryMainWindow, isSecondaryWindowSessionOwner } from './main-app-windows'
import { isIndependentLocalCore } from './core-local-mode'
import { AGENT_IPC_CHANNELS, AUTOMATION_IPC_CHANNELS, PLANNING_IPC_CHANNELS } from '@profer/shared'
import { BrowserWindow, app, safeStorage } from 'electron'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { projectRemoteRunEvent } from './core-run-projection'
import { projectCoreChatEvent } from './core-chat-projection'
import { pushChatStream } from './chat-stream-bus'
import { getLocalCoreState } from './core-local-service'
import { discoverPairedCore } from './core-discovery'
import { CoreClient, CoreClientError, type CoreChatEvent } from './core-client'
import { configureCoreHostConnection } from './core-host-connection'
import type { CoreEndpointInput, CoreTargetInput, CoreTargetSummary, CoreTargetsSnapshot } from '../../types'
import { attachLocalCoreClient, detachLocalCoreClient } from './core-local-bridge'
import { readCoreTargetStore, writeCoreTargetStore, type CoreTargetStore, type StoredCoreEndpoint, type StoredCoreTarget } from './core-target-store'

import { currentCoreWindow, runCoreWindow } from './core-window-scope'

export interface PairedCoreTargetInput {
  tunnel?: boolean
  expiresAt?: number
  name: string
  coreId: string
  endpoints: string[]
  identityPin: string
  bindingId: string
  credential: string
}
// 不同 WebSocket 对同一终态的到达时间可能跨过移窗 commit。即使 owner 已变也只交付一次。
const deliveredRemoteTerminals = new Set<string>()
function takeRemoteTerminal(sessionId: string, eventId: unknown): boolean {
  if (typeof eventId !== 'string') return true
  const key = `${sessionId}\0${eventId}`
  if (deliveredRemoteTerminals.has(key)) return false
  deliveredRemoteTerminals.add(key)
  if (deliveredRemoteTerminals.size > 1024) deliveredRemoteTerminals.delete(deliveredRemoteTerminals.values().next().value!)
  return true
}

type CoreIdentity = Awaited<ReturnType<CoreClient['identity']>>

function createCoreContext(windowId?: number) {
  let disposed = false
  function recipientWindows() { return disposed ? [] : BrowserWindow.getAllWindows().filter(window => windowId === undefined ? !windowContexts.has(window.webContents.id) : window.webContents.id === windowId) }
const LOCAL_TARGET_ID = 'local'
const PROTOCOL_VERSION = 1
const CONNECTION_TIMEOUT_MS = 5_000
const STARTUP_TIMEOUT_MS = 15_000
let selectedId: string | undefined
let activeClient: CoreClient | null = null
let localClient: CoreClient | null = null
let localIdentity: Awaited<ReturnType<CoreClient['identity']>> | undefined
let unsubscribeLocalPlanning: (() => void) | undefined
let unsubscribeLocalChat: (() => void) | undefined
let unsubscribeLocalChatSnapshot: (() => void) | undefined
let targetStatus: CoreTargetSummary['status'] = 'disconnected'
let latencyMs: number | undefined
let probeTimer: ReturnType<typeof setTimeout> | undefined
let startup: CoreTargetsSnapshot['startup']
let startupRestore: Promise<void> | undefined
let startupRetry: ReturnType<typeof setTimeout> | undefined
let pairedRecoveryTimer: ReturnType<typeof setTimeout> | undefined
let explicitSelection = 0
let generation = 0
let revision = 0
let selectionQueue: Promise<void> = Promise.resolve()

function storePath(): string { return join(app.getPath('userData'), 'core-targets.json') }
function readStore(): CoreTargetStore { return readCoreTargetStore(storePath()) }
function writeStore(store: CoreTargetStore): void { writeCoreTargetStore(storePath(), store) }
function activeId(store?: CoreTargetStore): string { return selectedId ??= (store ?? readStore()).preferredId }

function serialize<T>(fn: () => Promise<T> | T): Promise<T> {
  const operation = selectionQueue.then(() => { if (disposed) throw new Error('Core 窗口已关闭'); return runCoreWindow(windowId, fn) })
  selectionQueue = operation.then(() => undefined, () => undefined)
  return operation
}

function publishSnapshot(): void {
  revision += 1
  const snapshot = listCoreTargets()
  for (const window of recipientWindows()) {
    if (!window.isDestroyed()) window.webContents.send('core-target:changed', snapshot)
  }
}

function publishConnectedResources(): void {
  for (const window of recipientWindows()) if (!window.isDestroyed()) {
    window.webContents.send(AUTOMATION_IPC_CHANNELS.CHANGED)
    sendCoreWindowEvent(window.webContents, AGENT_IPC_CHANNELS.WORKSPACES_CHANGED)
  }
}

function clearLatency(): void {
  clearTimeout(probeTimer)
  probeTimer = undefined
  latencyMs = undefined
}

function observeLatency(client: CoreClient): void {
  const probe = async (): Promise<void> => {
    if (client !== activeClient || targetStatus !== 'connected') return
    const epoch = generation
    let result: number | undefined
    try { result = Math.round(await client.probeLatency()) } catch { /* 无有效样本时不显示旧数值 */ }
    if (client !== activeClient || epoch !== generation || targetStatus !== 'connected') return
    if (latencyMs !== result) { latencyMs = result; publishSnapshot() }
    probeTimer = setTimeout(() => { void probe() }, 5_000)
    probeTimer.unref?.()
  }
  void probe()
}

function publishCoreChat(event: CoreChatEvent, coreId: string): void {
  const projected = projectCoreChatEvent(event, coreId)
  for (const window of recipientWindows()) pushChatStream(window.webContents, projected.conversationId, projected.channel, projected.payload)
}
function publishChatSnapshot(chat: import('./core-client').CoreRecoverySnapshot['chat'], coreId: string): void {
  if (!chat) return
  const state = listCoreTargets()
  const payload = { targetId: state.currentId, generation: state.generation, ...chat, conversations: chat.conversations.map(meta => ({ ...meta, id: `core-chat:${encodeURIComponent(coreId)}:${meta.id}` })),
    activeRuns: chat.activeRuns.map(run => ({ ...run, conversationId: `core-chat:${encodeURIComponent(coreId)}:${run.conversationId}` })) }
  for (const window of recipientWindows()) if (!window.isDestroyed()) window.webContents.send('core-chat:snapshot', payload)
}

function encryptToken(token: string): string {
  if (!safeStorage.isEncryptionAvailable() || (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')) {
    throw new Error('系统安全存储不可用，不能安全保存 Core Token')
  }
  return safeStorage.encryptString(token).toString('base64')
}

function decryptToken(value: string): string {
  if (!safeStorage.isEncryptionAvailable() || (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')) {
    throw new Error('系统安全存储不可用，无法读取 Core Token')
  }
  return safeStorage.decryptString(Buffer.from(value, 'base64'))
}

/** WebSocket 回调不继承注册时的 ALS，显式绑定连接所属窗口。 */
function bindCallbacks<T extends object>(options: T): T {
  return Object.fromEntries(Object.entries(options).map(([key, value]) => [key,
    typeof value === 'function' ? (...args: unknown[]) => runCoreWindow(windowId, () => value(...args)) : value,
  ])) as T
}

function clientFor(target: StoredCoreTarget, endpoint: StoredCoreEndpoint): CoreClient {
  const client = new CoreClient(bindCallbacks({
    baseUrl: endpoint.baseUrl,
    token: decryptToken(endpoint.encryptedToken),
    identityPin: endpoint.identityPin,
    // 已配对设备由目标恢复流程先检查 HTTP 身份，避免独立 WS 重试绕过授权拒绝。
    reconnect: !endpoint.bindingId,
    deferEventRecovery: true,
    recoverEvents: true,
    onChatEvent: event => {
      if (disposed || activeClient !== client || activeId() !== target.id || !target.coreId) return
      publishCoreChat(event, target.coreId)
    },
    onSnapshot: snapshot => {
      if (disposed || activeClient !== client || activeId() !== target.id || !target.coreId) return
      const ns = (id: string) => namespaceCoreSessionId(id, target.coreId!)
      publishChatSnapshot(snapshot.chat, target.coreId)
      for (const goal of snapshot.goals) {
        for (const window of recipientWindows()) if (!window.isDestroyed()) sendCoreWindowEvent(window.webContents, AGENT_IPC_CHANNELS.GOAL_EVENT, { sessionId: ns(goal.sessionId), state: { ...goal, sessionId: ns(goal.sessionId) } })
      }
      const peers = agentWindowsForTarget(target.id)
      for (const pending of snapshot.pending) {
        if (!pending.permissions.length && !pending.askUsers.length && !pending.exitPlans.length) continue
        const id = ns(pending.sessionId)
        const owner = agentStreamOwner(peers, id)
        const recipients = recipientWindows().filter(win => !win.isDestroyed() && peers.includes(win.webContents)
          && (win.webContents === owner || isSessionWindowHandoff(win.webContents.id, id)))
        const requests = [...pending.permissions.map(request => ({ type: 'permission_request', request })), ...pending.askUsers.map(request => ({ type: 'ask_user_request', request })), ...pending.exitPlans.map(request => ({ type: 'exit_plan_mode_request', request }))]
        for (const event of requests) for (const window of recipients) sendCoreWindowEvent(window.webContents, AGENT_IPC_CHANNELS.STREAM_EVENT, { sessionId: id, payload: { kind: 'profer_event', event: { ...event, request: { ...event.request, sessionId: ns(pending.sessionId) } } } })
      }
      for (const window of recipientWindows()) if (!window.isDestroyed()) window.webContents.send(AUTOMATION_IPC_CHANNELS.CHANGED)
    },
    onEvent: event => {
      if (disposed || activeClient !== client || activeId() !== target.id || !target.coreId) return
      const payload = event.payload as { kind?: string; event?: { type?: string; state?: import('@profer/shared').AgentGoalState } }
      const localId = namespaceCoreSessionId(event.sessionId, target.coreId)
      if (payload?.kind === 'profer_event' && payload.event?.type === 'goal_state' && payload.event.state) {
        const state = { ...payload.event.state, sessionId: localId }
        for (const window of recipientWindows()) if (!window.isDestroyed()) sendCoreWindowEvent(window.webContents, AGENT_IPC_CHANNELS.GOAL_EVENT, { sessionId: localId, state: state.reasonCode === 'cleared' ? null : state })
        return
      }
      // 独立连接各自只通知所属窗口；只有当前完整应用窗口且仍选中本目标才可收到提示。
      const peers = agentWindowsForTarget(target.id)
      const recipients = recipientWindows().map(win => win.webContents).filter(wc => peers.includes(wc))
      if (invalidatesAgentActivity(payload)) invalidateAgentActivity(recipients, localId)
      const owner = agentStreamOwner(peers, localId)
      const projection = projectRemoteRunEvent(event, localId)
      for (const wc of recipients) {
        if (!isAgentCatalogPayload(payload) && owner !== wc && !isSessionWindowHandoff(wc.id, localId)) continue
        if (projection?.eventPayload) sendCoreWindowEvent(wc, AGENT_IPC_CHANNELS.STREAM_EVENT, { sessionId: localId, payload: projection.eventPayload })
        if (wc !== owner || (!projection?.completion && !projection?.error) || !takeRemoteTerminal(localId, event.eventId)) continue
        if (projection.completion) sendCoreWindowEvent(wc, AGENT_IPC_CHANNELS.STREAM_COMPLETE, projection.completion)
        if (projection.error) sendCoreWindowEvent(wc, AGENT_IPC_CHANNELS.STREAM_ERROR, { sessionId: localId, error: projection.error })
      }
    },
    onWorkspaceEvent: () => {
      if (disposed || activeClient !== client || activeId() !== target.id || !target.coreId) return
      for (const window of recipientWindows()) if (!window.isDestroyed()) sendCoreWindowEvent(window.webContents, AGENT_IPC_CHANNELS.WORKSPACES_CHANGED)
    },
    onAutomationEvent: () => {
      if (disposed || activeClient !== client || activeId() !== target.id) return
      for (const window of recipientWindows()) if (!window.isDestroyed()) window.webContents.send(AUTOMATION_IPC_CHANNELS.CHANGED)
    },
    onPlanningEvent: payload => {
      if (disposed || activeClient !== client || activeId() !== target.id || !payload || typeof payload !== 'object') return
      const event = payload as { type?: string; resources?: unknown; reminders?: unknown; operation?: unknown }
      const channel = event.type === 'changed' ? PLANNING_IPC_CHANNELS.CHANGED
        : event.type === 'reminders_due' ? PLANNING_IPC_CHANNELS.REMINDER_DUE
        : event.type === 'agent_operation' ? PLANNING_IPC_CHANNELS.AGENT_OPERATION : undefined
      if (!channel || !target.coreId) return
      const data = event.type === 'changed' ? { resources: event.resources }
        : event.type === 'reminders_due' ? event.reminders
        : { ...(event.operation as Record<string, unknown>), sessionId: namespaceCoreSessionId(String((event.operation as { sessionId?: unknown })?.sessionId), target.coreId) }
      if (event.type === 'reminders_due') {
        // 仅通知端口；不查询或领取提醒。异步加载后再次确认目标，拒绝旧连接晚到。
        void import('./planning-reminder-scheduler').then(({ showPlanningSystemNotification }) => {
          if (disposed || activeClient !== client || activeId() !== target.id) return
          for (const reminder of event.reminders as import('@profer/shared').ActivePlanningReminder[] ?? []) showPlanningSystemNotification(reminder)
        }).catch(error => console.error('[Core Planning] 通知失败', error))
      }
      for (const window of recipientWindows()) if (!window.isDestroyed()) window.webContents.send(channel, data)
    },
    onStatus: status => {
      // 重选同一目标时旧连接也会晚到 closed/error，只有当前连接能发布状态。
      if (disposed || activeClient !== client || activeId() !== target.id) return
      targetStatus = status === 'open' ? 'connected' : status === 'connecting' ? 'disconnected' : 'error'
      clearLatency()
      publishSnapshot()
      if (status === 'open') observeLatency(client)
      if (status === 'open') publishConnectedResources()
      if (endpoint.identityPin) {
        if (status === 'open') { clearTimeout(pairedRecoveryTimer); pairedRecoveryTimer = undefined }
        else schedulePairedRecovery(client, target.id)
      }
    },
  }))
  return client
}

function schedulePairedRecovery(client: CoreClient, targetId: string): void {
  if (pairedRecoveryTimer) return
  pairedRecoveryTimer = setTimeout(() => {
    pairedRecoveryTimer = undefined
    if (disposed || activeClient !== client || activeId() !== targetId || client.isConnected) return
    void serialize(async () => {
      if (disposed || activeClient !== client || activeId() !== targetId || client.isConnected) return
      const store = readStore()
      const target = requireTarget(store, targetId)
      try {
        await connectTarget(store, target, { accept: () => activeClient === client && activeId() === targetId && !client.isConnected })
      } catch (error) {
        if (error instanceof PairedBindingRejected) return
        if (activeClient === client && activeId() === targetId && !client.isConnected) schedulePairedRecovery(client, targetId)
      }
    })
  }, 3_000)
  pairedRecoveryTimer.unref?.()
}

class PairedBindingRejected extends Error {}

function selectedEndpoint(target: StoredCoreTarget): StoredCoreEndpoint {
  const endpoint = target.endpoints.find(item => item.id === target.selectedEndpointId)
  if (!endpoint) throw new Error('找不到首选 Core 地址')
  return endpoint
}

function requireTarget(store: CoreTargetStore, id: string): StoredCoreTarget {
  const target = store.targets.find(item => item.id === id)
  if (!target) throw new Error('找不到指定的 Core 内核')
  return target
}

function summaries(store: CoreTargetStore): CoreTargetSummary[] {
  const currentId = activeId(store)
  const local = getLocalCoreState()
  const localName = local.status === 'failed' ? '本机 Core（启动失败）' : local.status === 'starting' ? '本机 Core（启动中）' : local.status === 'stopped' ? '本机 Core（已停止）' : '本机 Core'
  return [
    { id: LOCAL_TARGET_ID, name: localName, kind: 'local', status: currentId === LOCAL_TARGET_ID && activeClient && local.status === 'running' ? targetStatus : local.status === 'failed' ? 'error' : 'disconnected',
      ...(isIndependentLocalCore() ? { independent: true } : {}),
      ...(localIdentity ? { coreId: localIdentity.coreId, version: localIdentity.version, capabilities: localIdentity.capabilities, platform: localIdentity.platform, osId: localIdentity.osId } : {}) },
    ...store.targets.map(target => ({
      id: target.id, name: target.name, kind: 'remote' as const, baseUrl: selectedEndpoint(target).baseUrl,
      endpoints: target.endpoints.map(({ id, label, baseUrl }) => ({ id, label, baseUrl })),
      selectedEndpointId: target.selectedEndpointId,
      status: currentId === target.id ? targetStatus : 'disconnected' as const,
      ...(currentId === target.id && targetStatus === 'connected' && latencyMs !== undefined ? { latencyMs } : {}),
      expiresAt: target.expiresAt, coreId: target.coreId, version: target.version, capabilities: target.capabilities, platform: target.platform, osId: target.osId,
    })),
  ]
}

function listCoreTargets(): CoreTargetsSnapshot {
  const store = readStore()
  const currentId = activeId(store)
  const startupState = currentId === LOCAL_TARGET_ID
    ? (getLocalCoreState().status === 'starting' ? 'restoring' : undefined)
    : startup ?? (!selectedId ? 'restoring' : undefined)
  return { currentId, generation, revision, startup: startupState, targets: summaries(store) }
}

function validName(value: string): string {
  const name = value?.trim()
  if (!name || name.length > 80) throw new Error('内核名称不能为空且不能超过 80 个字符')
  return name
}

function validLabel(value?: string): string | undefined {
  const label = value?.trim()
  if (label && label.length > 80) throw new Error('线路名称不能超过 80 个字符')
  return label || undefined
}

function normalizeUrl(input: string): string {
  let parsed: URL
  try { parsed = new URL(input.trim()) }
  catch { throw new Error('Core 地址无效，请填写完整的 HTTPS 地址') }
  const loopbackAllowed = parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
  if (parsed.protocol !== 'https:' && !loopbackAllowed) throw new Error('远程 Core 必须使用 HTTPS；内部测试版仅对 loopback HTTP 隧道放宽')
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('Core 地址不能包含用户名、密码、查询参数或片段')
  return parsed.href.replace(/\/+$/, '')
}


function assertIdentity(identity: CoreIdentity, coreId?: string): void {
  if (identity.protocolVersion !== PROTOCOL_VERSION) throw new Error(`Core 协议版本不兼容: ${identity.protocolVersion}`)
  if (!identity.coreId?.trim()) throw new Error('远程 Core 未返回有效身份')
  if (coreId && identity.coreId !== coreId) throw new Error('这是另一台内核，请添加为新连接')
}

async function verifyEndpoint(baseUrl: string, token: string, coreId?: string, identityPin?: string): Promise<CoreIdentity> {
  if (!token) throw new Error('Core Token 不能为空')
  const client = new CoreClient({ baseUrl, token, identityPin, reconnect: false })
  try {
    const identity = await client.identity(CONNECTION_TIMEOUT_MS)
    assertIdentity(identity, coreId)
    await client.connect(CONNECTION_TIMEOUT_MS)
    return identity
  } finally { client.close() }
}

function testCoreTarget(input: CoreTargetInput): Promise<CoreIdentity> {
  validName(input.name)
  return verifyEndpoint(normalizeUrl(input.baseUrl), input.token?.trim(), input.expectedCoreId)
}

async function addCoreTarget(input: CoreTargetInput): Promise<CoreTargetSummary> {
  const name = validName(input.name)
  const baseUrl = normalizeUrl(input.baseUrl)
  const label = validLabel(input.label)
  const token = input.token?.trim()
  const identity = await verifyEndpoint(baseUrl, token, input.expectedCoreId)
  return serialize(async () => {
    const store = readStore()
    if (store.targets.some(target => target.endpoints.some(endpoint => endpoint.baseUrl === baseUrl))) {
      throw new Error('该地址已保存，请在现有连接中编辑，或为新内核使用不同地址')
    }
    const existing = store.targets.find(target => target.coreId === identity.coreId)
    const knownPin = existing?.endpoints.find(item => item.identityPin)?.identityPin
    if (knownPin) await verifyEndpoint(baseUrl, token, existing!.coreId, knownPin)
    const endpoint = { id: randomUUID(), label: label ?? (existing ? '备用地址' : '默认地址'), baseUrl, encryptedToken: encryptToken(token), ...(knownPin ? { identityPin: knownPin } : {}) }
    const target = existing ?? { id: randomUUID(), name, coreId: identity.coreId, selectedEndpointId: endpoint.id, endpoints: [] }
    target.endpoints.push(endpoint)
    Object.assign(target, { version: identity.version, capabilities: identity.capabilities, platform: identity.platform, osId: identity.osId })
    if (!existing) store.targets.push(target)
    writeStore(store)
    publishSnapshot()
    return summaries(store).find(item => item.id === target.id)!
  })
}



/** 配对服务已固定身份，再验证业务协议后一次保存整组线路。 */
async function savePairedCoreTarget(input: PairedCoreTargetInput): Promise<CoreTargetSummary> {
  const name = validName(input.name)
  if (!/^sha256\/[A-Za-z0-9+/]{43}=$/.test(input.identityPin) || !input.bindingId || !input.credential) throw new Error('Core 配对结果无效')
  const endpoints = [...new Set(input.endpoints.map(normalizeUrl))]
  if (!endpoints.length) throw new Error('Core 邀请缺少连接地址')
  const known = readStore().targets.find(target => target.coreId === input.coreId)
  const knownPin = known?.endpoints.find(endpoint => endpoint.identityPin)?.identityPin
  if (knownPin && knownPin !== input.identityPin) throw new Error('Core 身份与已有配对不一致，请先移除旧连接')
  let identity: CoreIdentity | undefined
  let preferred = ''
  for (const baseUrl of endpoints) {
    try { identity = await verifyEndpoint(baseUrl, input.credential, input.coreId, input.identityPin); preferred = baseUrl; break }
    catch { /* 配对已成功，离线时仍保存授权，稍后通过固定身份重试。 */ }
  }
  const verified = identity
  return serialize(() => {
    const store = readStore()
    const existing = store.targets.find(target => target.coreId === input.coreId)
    const pin = existing?.endpoints.find(endpoint => endpoint.identityPin)?.identityPin
    if (pin && pin !== input.identityPin) throw new Error('Core 身份与已有配对不一致')
    const target: StoredCoreTarget = existing ?? { id: randomUUID(), name, coreId: input.coreId, selectedEndpointId: '', endpoints: [] }
    target.expiresAt = input.expiresAt
    const encryptedToken = encryptToken(input.credential)
    for (const baseUrl of endpoints) {
      const old = target.endpoints.find(endpoint => endpoint.baseUrl === baseUrl)
      const endpoint: StoredCoreEndpoint = { id: old?.id ?? randomUUID(), label: input.tunnel ? '隧道' : '局域网', baseUrl, encryptedToken, identityPin: input.identityPin, bindingId: input.bindingId, ...(input.tunnel ? { tunnel: true } : {}) }
      if (old) target.endpoints = target.endpoints.map(item => item.id === old.id ? endpoint : item)
      else target.endpoints.push(endpoint)
      if (baseUrl === preferred || !target.selectedEndpointId || input.tunnel) target.selectedEndpointId = endpoint.id
    }
    if (verified) Object.assign(target, { version: verified.version, capabilities: verified.capabilities, platform: verified.platform, osId: verified.osId })
    if (!existing) store.targets.push(target)
    writeStore(store)
    publishSnapshot()
    return summaries(store).find(item => item.id === target.id)!
  })
}

function updateCoreTarget(id: string, input: { name: string }): Promise<CoreTargetsSnapshot> {
  return serialize(() => {
    const store = readStore()
    requireTarget(store, id).name = validName(input.name)
    writeStore(store)
    publishSnapshot()
    return listCoreTargets()
  })
}

function saveCoreEndpoint(id: string, input: CoreEndpointInput): Promise<CoreTargetsSnapshot> {
  return serialize(async () => {
    const store = readStore()
    const target = requireTarget(store, id)
    const old = input.endpointId ? target.endpoints.find(item => item.id === input.endpointId) : undefined
    if (input.endpointId && !old) throw new Error('找不到要编辑的 Core 地址')
    const baseUrl = normalizeUrl(input.baseUrl)
    if (store.targets.some(item => item.endpoints.some(e => e.baseUrl === baseUrl && e.id !== old?.id))) throw new Error('该 Core 地址已保存')
    const token = input.token?.trim() || (old ? decryptToken(old.encryptedToken) : '')
    if (!token) throw new Error('Core Token 不能为空')
    const knownPin = old?.identityPin ?? target.endpoints.find(item => item.identityPin)?.identityPin
    const endpoint = { id: old?.id ?? randomUUID(), label: validLabel(input.label) ?? old?.label ?? '备用地址', baseUrl,
      ...(old?.tunnel ? { tunnel: true } : {}),
      ...(knownPin ? { identityPin: knownPin, bindingId: old?.bindingId } : {}),
      encryptedToken: input.token?.trim() || !old ? encryptToken(token) : old.encryptedToken }
    const activeEndpointEdited = old && activeId(store) === id && target.selectedEndpointId === old.id
      && (old.baseUrl !== baseUrl || Boolean(input.token?.trim()))
    if (old) target.endpoints = target.endpoints.map(item => item.id === old.id ? endpoint : item)
    else target.endpoints.push(endpoint)
    if (activeEndpointEdited) return changeRemoteConnection(store, target, endpoint)
    await verifyEndpoint(baseUrl, token, target.coreId, endpoint.identityPin)
    writeStore(store)
    publishSnapshot()
    return listCoreTargets()
  })
}

function selectCoreEndpoint(id: string, endpointId: string): Promise<CoreTargetsSnapshot> {
  return serialize(async () => {
    const store = readStore()
    const target = requireTarget(store, id)
    const endpoint = target.endpoints.find(item => item.id === endpointId)
    if (!endpoint) throw new Error('找不到指定的 Core 地址')
    if (target.selectedEndpointId === endpoint.id) return listCoreTargets()
    if (activeId(store) === id) return changeRemoteConnection(store, target, endpoint)
    await verifyEndpoint(endpoint.baseUrl, decryptToken(endpoint.encryptedToken), target.coreId, endpoint.identityPin)
    target.selectedEndpointId = endpoint.id
    writeStore(store)
    publishSnapshot()
    return listCoreTargets()
  })
}

function removeCoreEndpoint(id: string, endpointId: string): Promise<CoreTargetsSnapshot> {
  return serialize(() => {
    const store = readStore()
    const target = requireTarget(store, id)
    if (target.selectedEndpointId === endpointId) throw new Error('请先选用另一条地址，再移除此地址')
    target.endpoints = target.endpoints.filter(item => item.id !== endpointId)
    writeStore(store)
    publishSnapshot()
    return listCoreTargets()
  })
}

function activateLocal(store: CoreTargetStore, persist: boolean): CoreTargetsSnapshot {
  const changed = activeId(store) !== LOCAL_TARGET_ID
  if (persist) { if (windowId === undefined) { store.preferredId = LOCAL_TARGET_ID; writeStore(store) }; startup = undefined }
  const previous = activeClient
  selectedId = LOCAL_TARGET_ID
  activeClient = localClient
  targetStatus = localClient ? 'connected' : 'disconnected'
  clearLatency()
  if (changed) generation += 1
  if (windowId === undefined && localClient && (changed || previous !== localClient)) attachLocalCoreClient(localClient, publishLocalAgentEvent)
  if (previous && previous !== localClient) previous.close()
  publishSnapshot()
  if (changed) publishConnectedResources()
  if (localClient && changed && localIdentity?.capabilities.includes('chat')) {
    void localClient.refreshSnapshot().catch(error => console.error('[Core] 本机会话刷新失败:', error))
  }
  return listCoreTargets()
}

function selectCoreTarget(id: string, options: { reconnect?: boolean } = {}): Promise<CoreTargetsSnapshot> {
  explicitSelection += 1
  clearTimeout(startupRetry)
  startupRetry = undefined
  return serialize(() => {
    const store = readStore()
    if (id === LOCAL_TARGET_ID) return activateLocal(store, true)
    const target = requireTarget(store, id)
    if (!options.reconnect && id === activeId(store) && targetStatus === 'connected') return listCoreTargets()
    return connectTarget(store, target, { remember: true })
  })
}

interface ConnectOptions {
  remember?: boolean
  timeoutMs?: number
  accept?: () => boolean
}

async function connectTarget(store: CoreTargetStore, target: StoredCoreTarget, options: ConnectOptions = {}): Promise<CoreTargetsSnapshot> {
  const selected = selectedEndpoint(target)
  const candidates = selected.tunnel ? [selected] : [selected, ...target.endpoints.filter(endpoint => endpoint.id !== selected.id && endpoint.identityPin === selected.identityPin && !endpoint.tunnel)]
  let failure: unknown
  for (const endpoint of candidates) {
    if (options.accept?.() === false) throw new Error('Core 连接已被替换')
    try { return await changeRemoteConnection(store, target, endpoint, options) }
    catch (error) {
      if (error instanceof PairedBindingRejected && endpoint.bindingId === selected.bindingId) throw error
      failure = error
    }
  }
  if (!selected.tunnel && selected.identityPin && options.accept?.() !== false) {
    const found = await discoverPairedCore({ coreId: target.coreId, pin: { algorithm: 'spki-sha256', value: selected.identityPin }, timeoutMs: 1_500 })
    for (const baseUrl of found?.endpoints ?? []) {
      if (candidates.some(endpoint => endpoint.baseUrl === baseUrl)) continue
      const endpoint = { ...selected, id: randomUUID(), baseUrl: normalizeUrl(baseUrl) }
      target.endpoints.push(endpoint)
      try { return await changeRemoteConnection(store, target, endpoint, options) }
      catch (error) {
        target.endpoints = target.endpoints.filter(item => item.id !== endpoint.id)
        if (error instanceof PairedBindingRejected) throw error
        failure = error
      }
    }
  }
  throw failure ?? new Error('Core 不可达')
}

async function changeRemoteConnection(store: CoreTargetStore, target: StoredCoreTarget, endpoint: StoredCoreEndpoint,
  options: ConnectOptions = {}): Promise<CoreTargetsSnapshot> {
  const until = Date.now() + (options.timeoutMs ?? CONNECTION_TIMEOUT_MS)
  const remaining = () => {
    const value = until - Date.now()
    if (disposed || value <= 0 || options.accept?.() === false) throw new Error('Core 连接超时或已被取消')
    return value
  }
  const old = activeClient
  const sameCore = activeId(store) === target.id && old !== localClient
  const client = clientFor(target, endpoint)
  let committed = false
  try {
    const identity = await client.identity(remaining()).catch(error => {
      if (endpoint.bindingId && error instanceof CoreClientError && error.status === 401) {
        throw new PairedBindingRejected('Core 设备授权已被拒绝，请重新配对', { cause: error })
      }
      throw error
    })
    assertIdentity(identity, target.coreId)
    await client.connect(remaining())
    if (sameCore && old) await old.waitForHostIdle(remaining())
    remaining()
    if (!client.isConnected) throw new Error('远程 Core 已断开')
    target.selectedEndpointId = endpoint.id
    Object.assign(target, { version: identity.version, capabilities: identity.capabilities, platform: identity.platform, osId: identity.osId })
    const changed = activeId() !== target.id
    if (options.remember && windowId === undefined) store.preferredId = target.id
    writeStore(store)
    selectedId = target.id
    if (changed) generation += 1
    // 本机桥属于进程，窗口切换不可拆除其他窗口使用的桥。
    activeClient = client
    clearLatency()
    targetStatus = 'connected'
    startup = undefined
    configureCoreHostConnection(client, {
      coreId: target.coreId,
      contentRoot: join(app.getPath('temp'), 'profer-core-host'),
      sessionId: raw => namespaceCoreSessionId(raw, target.coreId),
      isCurrent: () => activeClient === client && activeId() === target.id,
      emitPreview: (sessionId, payload) => {
        for (const window of recipientWindows()) if (!window.isDestroyed()) sendCoreWindowEvent(window.webContents, AGENT_IPC_CHANNELS.STREAM_EVENT, { sessionId, payload })
      },
    })
    // 先让 preload 接到新的路由世代，再投递已恢复的事件和审批。
    publishSnapshot()
    client.startEventRecovery()
    publishConnectedResources()
    observeLatency(client)
    committed = true
    if (old && old !== localClient) old.close()
    return listCoreTargets()
  } finally {
    if (!committed) client.close()
  }
}

function clearLocalCoreTargetClient(): void {
  const wasActive = activeClient === localClient && localClient !== null
  unsubscribeLocalChat?.(); unsubscribeLocalChat = undefined
  unsubscribeLocalChatSnapshot?.(); unsubscribeLocalChatSnapshot = undefined
  unsubscribeLocalPlanning?.(); unsubscribeLocalPlanning = undefined
  localClient = null
  localIdentity = undefined
  if (wasActive) { activeClient = null; targetStatus = 'error' }
  if (windowId === undefined) detachLocalCoreClient(false)
  publishSnapshot()
}

function setLocalCoreClient(client: CoreClient, identity?: Awaited<ReturnType<CoreClient['identity']>>): void {
  localIdentity = identity
  if (windowId === undefined) attachLocalCoreClient(client, publishLocalAgentEvent)
  unsubscribeLocalChat?.()
  unsubscribeLocalChat = client.addChatEventListener(bindCallbacks({ event: (event: CoreChatEvent) => {
    if (disposed || activeClient !== client || activeId() !== LOCAL_TARGET_ID || !localIdentity?.coreId) return
    publishCoreChat(event, localIdentity.coreId)
  } }).event)
  unsubscribeLocalChatSnapshot?.()
  unsubscribeLocalChatSnapshot = client.addSnapshotListener(snapshot => {
    if (disposed || activeClient !== client || activeId() !== LOCAL_TARGET_ID || !localIdentity?.coreId) return
    publishChatSnapshot(snapshot.chat, localIdentity.coreId)
  })
  unsubscribeLocalPlanning?.()
  unsubscribeLocalPlanning = client.addPlanningEventListener(payload => {
    if (disposed || activeClient !== client || activeId() !== LOCAL_TARGET_ID || !payload || typeof payload !== 'object') return
    const event = payload as { type?: string; resources?: unknown; operation?: unknown; reminders?: import('@profer/shared').ActivePlanningReminder[] }
    const channel = event.type === 'changed' ? PLANNING_IPC_CHANNELS.CHANGED : event.type === 'agent_operation' ? PLANNING_IPC_CHANNELS.AGENT_OPERATION : event.type === 'reminders_due' ? PLANNING_IPC_CHANNELS.REMINDER_DUE : undefined
    if (!channel) return
    if (event.type === 'reminders_due' && windowId === undefined) {
      void import('./planning-reminder-scheduler').then(({ showPlanningSystemNotification }) => {
        if (disposed || activeClient !== client || activeId() !== LOCAL_TARGET_ID) return
        for (const reminder of event.reminders ?? []) showPlanningSystemNotification(reminder)
      }).catch(error => console.error('[Core Planning] 通知失败', error))
    }
    const data = event.type === 'changed' ? { resources: event.resources } : event.type === 'reminders_due' ? event.reminders : event.operation
    for (const window of recipientWindows()) if (!window.isDestroyed()) window.webContents.send(channel, data)
  })
  localClient = client
  if (activeId() === LOCAL_TARGET_ID) {
    if (activeClient && activeClient !== client) activeClient.close()
    activeClient = client
    targetStatus = 'connected'
    publishSnapshot()
    if (identity?.capabilities.includes('chat')) void client.refreshSnapshot().catch(error => console.error('[Core Chat] 本机快照恢复失败：', error))
  }
}

async function activateSavedCoreTarget(): Promise<void> {
  if (startupRestore) return startupRestore
  const saved = readStore()
  if (saved.preferredId === LOCAL_TARGET_ID) return Promise.resolve()
  const preferred = saved.preferredId
  selectedId ??= preferred
  const request = explicitSelection
  startup = 'restoring'
  publishSnapshot()
  startupRestore = (async () => {
    let bindingRejected = false
    const deadline = Date.now() + STARTUP_TIMEOUT_MS
    while (request === explicitSelection && startup === 'restoring' && Date.now() < deadline) {
      try {
        await serialize(() => {
          if (request !== explicitSelection || startup !== 'restoring') return
          const store = readStore()
          const target = requireTarget(store, preferred)
          return connectTarget(store, target, {
            timeoutMs: Math.min(CONNECTION_TIMEOUT_MS, Math.max(1, deadline - Date.now())),
            accept: () => request === explicitSelection,
          })
        })
        return
      } catch (error) {
        console.warn('[Core] 启动时连接上次内核失败:', error instanceof Error ? error.message : String(error))
        if (error instanceof PairedBindingRejected) { bindingRejected = true; break }
      }
      const delay = Math.min(1_000, deadline - Date.now())
      if (delay > 0 && request === explicitSelection) await new Promise(resolve => setTimeout(resolve, delay))
    }
    if (request !== explicitSelection || startup !== 'restoring') return
    await serialize(() => {
      if (request !== explicitSelection || startup !== 'restoring') return
      startup = 'offline'
      targetStatus = 'error'
      publishSnapshot()
      if (bindingRejected) return
      startupRetry = setTimeout(() => {
        if (request !== explicitSelection || activeId() !== preferred) return
        startupRestore = undefined
        void activateSavedCoreTarget().catch(error => console.warn('[Core] 重新连接失败:', error instanceof Error ? error.message : String(error)))
      }, 5_000)
      startupRetry.unref?.()
    })
  })()
  return startupRestore
}

function publishCoreTargetsSnapshot(): void { publishSnapshot() }

function getActiveCoreClient(): CoreClient | null { return activeClient }
function getManagedLocalCoreClient(): CoreClient | null { return localClient }

function namespaceCoreSessionId(sessionId: string, coreId: string): string {
  return `core:${encodeURIComponent(coreId)}:${sessionId}`
}

function parseCoreSessionId(value: string): { coreId: string; sessionId: string } | null {
  const match = /^core:([^:]+):(.+)$/.exec(value)
  if (!match) return null
  try { return { coreId: decodeURIComponent(match[1]!), sessionId: match[2]! } }
  catch { return null }
}

function currentCoreId(): string | undefined {
  const store = readStore()
  return store.targets.find(target => target.id === activeId(store))?.coreId
}

function getCoreTargetGeneration(): number { return generation }
function getCurrentCoreTargetId(): string { return activeId() }

function removeCoreTarget(id: string): Promise<CoreTargetsSnapshot> {
  return serialize(() => {
    const store = readStore()
    requireTarget(store, id)
    if ([defaultContext, ...windowContexts.values()].some(target => target.getCurrentCoreTargetId() === id)) throw new Error('请先切回本机内核，再移除此连接')
    store.targets = store.targets.filter(target => target.id !== id)
    if (store.preferredId === id) store.preferredId = LOCAL_TARGET_ID
    writeStore(store)
    publishSnapshot()
    return listCoreTargets()
  })
}

function inheritTarget(id: string): void {
  // 首次 LIST 之前固定继承目标；不临时暴露本机目录，也不共享远端连接。
  selectedId = id
  if (id !== LOCAL_TARGET_ID) {
    requireTarget(readStore(), id)
    startup = 'restoring'
    targetStatus = 'disconnected'
    generation += 1
  }
}

function restoreInheritedTarget(): Promise<void> {
  const id = activeId()
  const pending = selectCoreTarget(id)
  const request = explicitSelection
  return pending.then(() => undefined, error => {
    if (!disposed && request === explicitSelection) { startup = 'offline'; targetStatus = 'error'; publishSnapshot() }
    throw error
  })
}

return { inheritTarget, restoreInheritedTarget, listCoreTargets, testCoreTarget, addCoreTarget, savePairedCoreTarget, updateCoreTarget, saveCoreEndpoint, selectCoreEndpoint, removeCoreEndpoint, selectCoreTarget, clearLocalCoreTargetClient, setLocalCoreClient, activateSavedCoreTarget, publishCoreTargetsSnapshot, getActiveCoreClient, getManagedLocalCoreClient, namespaceCoreSessionId, parseCoreSessionId, currentCoreId, getCoreTargetGeneration, getCurrentCoreTargetId, removeCoreTarget, dispose() {
 disposed = true
 explicitSelection += 1
 clearTimeout(probeTimer); clearTimeout(startupRetry); clearTimeout(pairedRecoveryTimer)
 unsubscribeLocalPlanning?.(); unsubscribeLocalChat?.(); unsubscribeLocalChatSnapshot?.()
 if (activeClient && activeClient !== localClient) activeClient.close()
 activeClient = null
 }, localIdentityValue() { return localIdentity } }
}
const windowContexts = new Map<number, ReturnType<typeof createCoreContext>>()
const defaultContext = createCoreContext()
const primaryWindows = new Set<number>()
function context() {
 const id = currentCoreWindow()
 if (id === undefined || primaryWindows.has(id)) return defaultContext
 const target = windowContexts.get(id)
 if (!target) throw new Error('Core 窗口已关闭或尚未初始化')
 return target
}
export function initializeWindowCore(id: number, sourceId?: number, primary = false): Promise<void> {
 if (primary) { primaryWindows.add(id); return Promise.resolve() }
 const source = sourceId === undefined ? defaultContext : windowContexts.get(sourceId) ?? defaultContext
 const target = createCoreContext(id)
 windowContexts.set(id, target)
 target.inheritTarget(source.getCurrentCoreTargetId())
 const local = defaultContext.getManagedLocalCoreClient()
 if (local) target.setLocalCoreClient(local, defaultContext.localIdentityValue())
 return target.restoreInheritedTarget()
}
export function disposeWindowCore(id: number): void { windowContexts.get(id)?.dispose(); windowContexts.delete(id); primaryWindows.delete(id) }
export const listCoreTargets: ReturnType<typeof createCoreContext>["listCoreTargets"] = (...args) => context().listCoreTargets(...args)
export const testCoreTarget: ReturnType<typeof createCoreContext>["testCoreTarget"] = (...args) => context().testCoreTarget(...args)
export const addCoreTarget: ReturnType<typeof createCoreContext>["addCoreTarget"] = async (...args) => { const result = await context().addCoreTarget(...args); publishAllContextSnapshots(); return result }
export const savePairedCoreTarget: ReturnType<typeof createCoreContext>["savePairedCoreTarget"] = async (...args) => { const result = await context().savePairedCoreTarget(...args); publishAllContextSnapshots(); return result }
export const updateCoreTarget: ReturnType<typeof createCoreContext>["updateCoreTarget"] = async (...args) => { const result = await context().updateCoreTarget(...args); publishAllContextSnapshots(); return result }
export const saveCoreEndpoint: ReturnType<typeof createCoreContext>["saveCoreEndpoint"] = async (...args) => { const result = await context().saveCoreEndpoint(...args); publishAllContextSnapshots(); return result }
export const selectCoreEndpoint: ReturnType<typeof createCoreContext>["selectCoreEndpoint"] = (...args) => context().selectCoreEndpoint(...args)
export const removeCoreEndpoint: ReturnType<typeof createCoreContext>["removeCoreEndpoint"] = async (...args) => { const result = await context().removeCoreEndpoint(...args); publishAllContextSnapshots(); return result }
export const selectCoreTarget: ReturnType<typeof createCoreContext>["selectCoreTarget"] = (...args) => context().selectCoreTarget(...args)
export const clearLocalCoreTargetClient: ReturnType<typeof createCoreContext>["clearLocalCoreTargetClient"] = (...args) => {
 defaultContext.clearLocalCoreTargetClient(...args)
 for (const target of windowContexts.values()) target.clearLocalCoreTargetClient(...args)
}
export const setLocalCoreClient: ReturnType<typeof createCoreContext>["setLocalCoreClient"] = (...args) => {
 defaultContext.setLocalCoreClient(...args)
 for (const target of windowContexts.values()) target.setLocalCoreClient(...args)
}
export const activateSavedCoreTarget: ReturnType<typeof createCoreContext>["activateSavedCoreTarget"] = (...args) => context().activateSavedCoreTarget(...args)
export const publishCoreTargetsSnapshot: ReturnType<typeof createCoreContext>["publishCoreTargetsSnapshot"] = (...args) => context().publishCoreTargetsSnapshot(...args)
export const getActiveCoreClient: ReturnType<typeof createCoreContext>["getActiveCoreClient"] = (...args) => context().getActiveCoreClient(...args)
export const getManagedLocalCoreClient: ReturnType<typeof createCoreContext>["getManagedLocalCoreClient"] = (...args) => context().getManagedLocalCoreClient(...args)
export const namespaceCoreSessionId: ReturnType<typeof createCoreContext>["namespaceCoreSessionId"] = (...args) => context().namespaceCoreSessionId(...args)
export const parseCoreSessionId: ReturnType<typeof createCoreContext>["parseCoreSessionId"] = (...args) => context().parseCoreSessionId(...args)
export const currentCoreId: ReturnType<typeof createCoreContext>["currentCoreId"] = (...args) => context().currentCoreId(...args)
export const getCoreTargetGeneration: ReturnType<typeof createCoreContext>["getCoreTargetGeneration"] = (...args) => context().getCoreTargetGeneration(...args)
export const getCurrentCoreTargetId: ReturnType<typeof createCoreContext>["getCurrentCoreTargetId"] = (...args) => context().getCurrentCoreTargetId(...args)
export const removeCoreTarget: ReturnType<typeof createCoreContext>["removeCoreTarget"] = async (...args) => { const result = await context().removeCoreTarget(...args); publishAllContextSnapshots(); return result }

export function windowUsesLocalCore(id: number): boolean { return (windowContexts.get(id) ?? defaultContext).getCurrentCoreTargetId() === "local" }

/** 完整解析两种命名空间，选择目标窗口路由之后才允许注入 Tab。 */
export async function selectCoreForWindowSession(sessionId: string): Promise<void> {
 const match = /^core(?:-chat)?:([^:]+):(.+)$/.exec(sessionId)
 if (!match) { await selectCoreTarget('local'); return }
 let coreId: string
 try { coreId = decodeURIComponent(match[1]!) } catch { throw new Error('Core 会话标识无效') }
 const target = listCoreTargets().targets.find(value => value.coreId === coreId)
 if (!target) throw new Error('会话所属 Core 未配置')
 await selectCoreTarget(target.id)
}

/** 连接配置共享，快照仍按各窗口选择分别投递。 */
function publishAllContextSnapshots(): void {
 defaultContext.publishCoreTargetsSnapshot()
 for (const target of windowContexts.values()) target.publishCoreTargetsSnapshot()
}

/** 只向完整应用窗口发送；预览/设置等辅助窗口没有 Core 窗口上下文。 */
function agentWindowsForTarget(targetId: string): WebContents[] {
  return BrowserWindow.getAllWindows().filter(win => !win.isDestroyed()).map(win => win.webContents).filter(wc => {
    const ctx = primaryWindows.has(wc.id) ? defaultContext : windowContexts.get(wc.id)
    return !wc.isDestroyed() && ctx?.getCurrentCoreTargetId() === targetId
  })
}
export function localAgentWindows(): WebContents[] { return agentWindowsForTarget('local') }

/** 标签归属优先，已有流绑定次之；外部后台运行默认交付给同 Core 的主窗口。 */
export function agentStreamOwner(peers: readonly WebContents[], sessionId: string): WebContents | undefined {
  if (peers.length < 2) return peers[0]
  const eligible = peers.filter(wc => !isSessionWindowHandoff(wc.id, sessionId))
  const secondary = eligible.find(wc => isSecondaryWindowSessionOwner(wc, { type: 'agent', sessionId }))
  if (secondary) return secondary
  const primary = getPrimaryMainWindow()?.webContents
  if (primary && eligible.includes(primary)) {
    const record = getAppWindowSummaries().find(window => window.isPrimary)
    if (record?.sessions.some(session => session.type === 'agent' && session.sessionId === sessionId)) return primary
  }
  return eligible.find(wc => wc === sessionWebContents.get(sessionId))
    ?? eligible.find(wc => wc === primary) ?? eligible[0]
}

function publishLocalAgentEvent(channel: string, sessionId: string, payload: unknown): void {
  const peers = localAgentWindows()
  if (channel === AGENT_IPC_CHANNELS.SESSION_ACTIVITY_INVALIDATED) {
    invalidateAgentActivity(peers, sessionId)
    return
  }
  const owner = agentStreamOwner(peers, sessionId)
  if (owner) sendCoreWindowEvent(owner, channel, payload)
}
