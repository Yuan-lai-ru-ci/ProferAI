import { AGENT_IPC_CHANNELS, AUTOMATION_IPC_CHANNELS, PLANNING_IPC_CHANNELS } from '@profer/shared'
import { BrowserWindow, app, safeStorage } from 'electron'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { projectRemoteRunEvent } from './core-run-projection'
import { projectCoreChatEvent } from './core-chat-projection'
import { pushChatStream } from './chat-stream-bus'
import { CoreClient, type CoreChatEvent } from './core-client'
import { configureCoreHostConnection } from './core-host-connection'
import type { CoreEndpointInput, CoreTargetInput, CoreTargetSummary, CoreTargetsSnapshot } from '../../types'
import { attachLocalCoreClient, detachLocalCoreClient } from './core-local-bridge'
import { readCoreTargetStore, writeCoreTargetStore, type CoreTargetStore, type StoredCoreEndpoint, type StoredCoreTarget } from './core-target-store'

const relayedSessions = new WeakMap<CoreClient, Set<string>>()
export function markCoreRunRelayed(client: CoreClient, sessionId: string, active: boolean): void {
  let sessions = relayedSessions.get(client)
  if (active && !sessions) relayedSessions.set(client, sessions = new Set())
  if (active) sessions?.add(sessionId)
  else sessions?.delete(sessionId)
}

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
let explicitSelection = 0
let generation = 0
let revision = 0
let selectionQueue: Promise<void> = Promise.resolve()

function storePath(): string { return join(app.getPath('userData'), 'core-targets.json') }
function readStore(): CoreTargetStore { return readCoreTargetStore(storePath()) }
function writeStore(store: CoreTargetStore): void { writeCoreTargetStore(storePath(), store) }
function activeId(store?: CoreTargetStore): string { return selectedId ?? (store ?? readStore()).preferredId }

function serialize<T>(fn: () => Promise<T> | T): Promise<T> {
  const operation = selectionQueue.then(fn)
  selectionQueue = operation.then(() => undefined, () => undefined)
  return operation
}

function publishSnapshot(): void {
  revision += 1
  const snapshot = listCoreTargets()
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('core-target:changed', snapshot)
  }
}

function publishConnectedResources(): void {
  for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) {
    window.webContents.send(AUTOMATION_IPC_CHANNELS.CHANGED)
    window.webContents.send(AGENT_IPC_CHANNELS.WORKSPACES_CHANGED)
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
  pushChatStream(null, projected.conversationId, projected.channel, projected.payload)
}
function publishChatSnapshot(chat: import('./core-client').CoreRecoverySnapshot['chat'], coreId: string): void {
  if (!chat) return
  const state = listCoreTargets()
  const payload = { targetId: state.currentId, generation: state.generation, ...chat, conversations: chat.conversations.map(meta => ({ ...meta, id: `core-chat:${encodeURIComponent(coreId)}:${meta.id}` })),
    activeRuns: chat.activeRuns.map(run => ({ ...run, conversationId: `core-chat:${encodeURIComponent(coreId)}:${run.conversationId}` })) }
  for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send('core-chat:snapshot', payload)
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

function clientFor(target: StoredCoreTarget, endpoint: StoredCoreEndpoint): CoreClient {
  const client = new CoreClient({
    baseUrl: endpoint.baseUrl,
    token: decryptToken(endpoint.encryptedToken),
    deferEventRecovery: true,
    recoverEvents: true,
    onChatEvent: event => {
      if (activeClient !== client || activeId() !== target.id || !target.coreId) return
      publishCoreChat(event, target.coreId)
    },
    onSnapshot: snapshot => {
      if (activeClient !== client || activeId() !== target.id || !target.coreId) return
      const ns = (id: string) => namespaceCoreSessionId(id, target.coreId!)
      publishChatSnapshot(snapshot.chat, target.coreId)
      for (const goal of snapshot.goals) {
        for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send(AGENT_IPC_CHANNELS.GOAL_EVENT, { sessionId: ns(goal.sessionId), state: { ...goal, sessionId: ns(goal.sessionId) } })
      }
      for (const pending of snapshot.pending) {
        const requests = [...pending.permissions.map(request => ({ type: 'permission_request', request })), ...pending.askUsers.map(request => ({ type: 'ask_user_request', request })), ...pending.exitPlans.map(request => ({ type: 'exit_plan_mode_request', request }))]
        for (const event of requests) for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send(AGENT_IPC_CHANNELS.STREAM_EVENT, { sessionId: ns(pending.sessionId), payload: { kind: 'profer_event', event: { ...event, request: { ...event.request, sessionId: ns(pending.sessionId) } } } })
      }
      for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send(AUTOMATION_IPC_CHANNELS.CHANGED)
    },
    onEvent: event => {
      if (activeClient !== client || activeId() !== target.id || !target.coreId) return
      const payload = event.payload as { kind?: string; event?: { type?: string; state?: import('@profer/shared').AgentGoalState } }
      const localId = namespaceCoreSessionId(event.sessionId, target.coreId)
      if (payload?.kind === 'profer_event' && payload.event?.type === 'goal_state' && payload.event.state) {
        const state = { ...payload.event.state, sessionId: localId }
        for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send(AGENT_IPC_CHANNELS.GOAL_EVENT, { sessionId: localId, state: state.reasonCode === 'cleared' ? null : state })
        return
      }
      if (relayedSessions.get(client)?.has(event.sessionId)) return
      const projection = projectRemoteRunEvent(event, localId)
      for (const window of BrowserWindow.getAllWindows()) {
        if (window.isDestroyed()) continue
        if (projection?.eventPayload) window.webContents.send(AGENT_IPC_CHANNELS.STREAM_EVENT, { sessionId: localId, payload: projection.eventPayload })
        if (projection?.completion) window.webContents.send(AGENT_IPC_CHANNELS.STREAM_COMPLETE, projection.completion)
        if (projection?.error) window.webContents.send(AGENT_IPC_CHANNELS.STREAM_ERROR, { sessionId: localId, error: projection.error })
      }
    },
    onWorkspaceEvent: () => {
      if (activeClient !== client || activeId() !== target.id || !target.coreId) return
      for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send(AGENT_IPC_CHANNELS.WORKSPACES_CHANGED)
    },
    onAutomationEvent: () => {
      if (activeClient !== client || activeId() !== target.id) return
      for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send(AUTOMATION_IPC_CHANNELS.CHANGED)
    },
    onPlanningEvent: payload => {
      if (activeClient !== client || activeId() !== target.id || !payload || typeof payload !== 'object') return
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
          if (activeClient !== client || activeId() !== target.id) return
          for (const reminder of event.reminders as import('@profer/shared').ActivePlanningReminder[] ?? []) showPlanningSystemNotification(reminder)
        }).catch(error => console.error('[Core Planning] 通知失败', error))
      }
      for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send(channel, data)
    },
    onStatus: status => {
      // 重选同一目标时旧连接也会晚到 closed/error，只有当前连接能发布状态。
      if (activeClient !== client || activeId() !== target.id) return
      targetStatus = status === 'open' ? 'connected' : status === 'connecting' ? 'disconnected' : 'error'
      clearLatency()
      publishSnapshot()
      if (status === 'open') observeLatency(client)
      if (status === 'open') publishConnectedResources()
    },
  })
  return client
}

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
  return [
    { id: LOCAL_TARGET_ID, name: '本机内核', kind: 'local', status: currentId === LOCAL_TARGET_ID && activeClient ? targetStatus : 'disconnected',
      ...(localIdentity ? { coreId: localIdentity.coreId, version: localIdentity.version, capabilities: localIdentity.capabilities, platform: localIdentity.platform } : {}) },
    ...store.targets.map(target => ({
      id: target.id, name: target.name, kind: 'remote' as const, baseUrl: selectedEndpoint(target).baseUrl,
      endpoints: target.endpoints.map(({ id, label, baseUrl }) => ({ id, label, baseUrl })),
      selectedEndpointId: target.selectedEndpointId,
      status: currentId === target.id ? targetStatus : 'disconnected' as const,
      ...(currentId === target.id && targetStatus === 'connected' && latencyMs !== undefined ? { latencyMs } : {}),
      coreId: target.coreId, version: target.version, capabilities: target.capabilities, platform: target.platform,
    })),
  ]
}

export function listCoreTargets(): CoreTargetsSnapshot {
  const store = readStore()
  return { currentId: activeId(store), generation, revision, startup: startup ?? (!selectedId && store.preferredId !== LOCAL_TARGET_ID ? 'restoring' : undefined), targets: summaries(store) }
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

type CoreIdentity = Awaited<ReturnType<CoreClient['identity']>>
function assertIdentity(identity: CoreIdentity, coreId?: string): void {
  if (identity.protocolVersion !== PROTOCOL_VERSION) throw new Error(`Core 协议版本不兼容: ${identity.protocolVersion}`)
  if (!identity.coreId?.trim()) throw new Error('远程 Core 未返回有效身份')
  if (coreId && identity.coreId !== coreId) throw new Error('这是另一台内核，请添加为新连接')
}

async function verifyEndpoint(baseUrl: string, token: string, coreId?: string): Promise<CoreIdentity> {
  if (!token) throw new Error('Core Token 不能为空')
  const client = new CoreClient({ baseUrl, token, reconnect: false })
  try {
    const identity = await client.identity(CONNECTION_TIMEOUT_MS)
    assertIdentity(identity, coreId)
    await client.connect(CONNECTION_TIMEOUT_MS)
    return identity
  } finally { client.close() }
}

export function testCoreTarget(input: CoreTargetInput): Promise<CoreIdentity> {
  validName(input.name)
  return verifyEndpoint(normalizeUrl(input.baseUrl), input.token?.trim(), input.expectedCoreId)
}

export async function addCoreTarget(input: CoreTargetInput): Promise<CoreTargetSummary> {
  const name = validName(input.name)
  const baseUrl = normalizeUrl(input.baseUrl)
  const label = validLabel(input.label)
  const token = input.token?.trim()
  const identity = await verifyEndpoint(baseUrl, token, input.expectedCoreId)
  return serialize(() => {
    const store = readStore()
    if (store.targets.some(target => target.endpoints.some(endpoint => endpoint.baseUrl === baseUrl))) {
      throw new Error('该地址已保存，请在现有连接中编辑，或为新内核使用不同地址')
    }
    const existing = store.targets.find(target => target.coreId === identity.coreId)
    const endpoint = { id: randomUUID(), label: label ?? (existing ? '备用地址' : '默认地址'), baseUrl, encryptedToken: encryptToken(token) }
    const target = existing ?? { id: randomUUID(), name, coreId: identity.coreId, selectedEndpointId: endpoint.id, endpoints: [] }
    target.endpoints.push(endpoint)
    Object.assign(target, { version: identity.version, capabilities: identity.capabilities, platform: identity.platform })
    if (!existing) store.targets.push(target)
    writeStore(store)
    publishSnapshot()
    return summaries(store).find(item => item.id === target.id)!
  })
}

export function updateCoreTarget(id: string, input: { name: string }): Promise<CoreTargetsSnapshot> {
  return serialize(() => {
    const store = readStore()
    requireTarget(store, id).name = validName(input.name)
    writeStore(store)
    publishSnapshot()
    return listCoreTargets()
  })
}

export function saveCoreEndpoint(id: string, input: CoreEndpointInput): Promise<CoreTargetsSnapshot> {
  return serialize(async () => {
    const store = readStore()
    const target = requireTarget(store, id)
    const old = input.endpointId ? target.endpoints.find(item => item.id === input.endpointId) : undefined
    if (input.endpointId && !old) throw new Error('找不到要编辑的 Core 地址')
    const baseUrl = normalizeUrl(input.baseUrl)
    if (store.targets.some(item => item.endpoints.some(e => e.baseUrl === baseUrl && e.id !== old?.id))) throw new Error('该 Core 地址已保存')
    const token = input.token?.trim() || (old ? decryptToken(old.encryptedToken) : '')
    if (!token) throw new Error('Core Token 不能为空')
    const endpoint = { id: old?.id ?? randomUUID(), label: validLabel(input.label) ?? old?.label ?? '备用地址', baseUrl,
      encryptedToken: input.token?.trim() || !old ? encryptToken(token) : old.encryptedToken }
    const activeEndpointEdited = old && activeId(store) === id && target.selectedEndpointId === old.id
      && (old.baseUrl !== baseUrl || Boolean(input.token?.trim()))
    if (old) target.endpoints = target.endpoints.map(item => item.id === old.id ? endpoint : item)
    else target.endpoints.push(endpoint)
    if (activeEndpointEdited) return changeRemoteConnection(store, target, endpoint)
    await verifyEndpoint(baseUrl, token, target.coreId)
    writeStore(store)
    publishSnapshot()
    return listCoreTargets()
  })
}

export function selectCoreEndpoint(id: string, endpointId: string): Promise<CoreTargetsSnapshot> {
  return serialize(async () => {
    const store = readStore()
    const target = requireTarget(store, id)
    const endpoint = target.endpoints.find(item => item.id === endpointId)
    if (!endpoint) throw new Error('找不到指定的 Core 地址')
    if (target.selectedEndpointId === endpoint.id) return listCoreTargets()
    if (activeId(store) === id) return changeRemoteConnection(store, target, endpoint)
    await verifyEndpoint(endpoint.baseUrl, decryptToken(endpoint.encryptedToken), target.coreId)
    target.selectedEndpointId = endpoint.id
    writeStore(store)
    publishSnapshot()
    return listCoreTargets()
  })
}

export function removeCoreEndpoint(id: string, endpointId: string): Promise<CoreTargetsSnapshot> {
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
  if (persist) { store.preferredId = LOCAL_TARGET_ID; writeStore(store); startup = undefined }
  const previous = activeClient
  selectedId = LOCAL_TARGET_ID
  activeClient = localClient
  targetStatus = localClient ? 'connected' : 'disconnected'
  clearLatency()
  if (changed) generation += 1
  if (localClient && (changed || previous !== localClient)) attachLocalCoreClient(localClient)
  if (previous && previous !== localClient) previous.close()
  publishSnapshot()
  if (changed) publishConnectedResources()
  if (localClient && changed && localIdentity?.capabilities.includes('chat')) {
    void localClient.refreshSnapshot().catch(error => console.error('[Core] 本机会话刷新失败:', error))
  }
  return listCoreTargets()
}

export function selectCoreTarget(id: string): Promise<CoreTargetsSnapshot> {
  if (id === LOCAL_TARGET_ID) explicitSelection += 1
  return serialize(() => {
    const store = readStore()
    if (id === LOCAL_TARGET_ID) return activateLocal(store, true)
    const target = requireTarget(store, id)
    if (id === activeId(store) && targetStatus === 'connected') return listCoreTargets()
    return changeRemoteConnection(store, target, selectedEndpoint(target), { remember: true })
  })
}

interface ConnectOptions {
  remember?: boolean
  timeoutMs?: number
  accept?: () => boolean
}

async function changeRemoteConnection(store: CoreTargetStore, target: StoredCoreTarget, endpoint: StoredCoreEndpoint,
  options: ConnectOptions = {}): Promise<CoreTargetsSnapshot> {
  const until = Date.now() + (options.timeoutMs ?? CONNECTION_TIMEOUT_MS)
  const remaining = () => {
    const value = until - Date.now()
    if (value <= 0 || options.accept?.() === false) throw new Error('Core 连接超时或已被取消')
    return value
  }
  const old = activeClient
  const sameCore = activeId(store) === target.id && old !== localClient
  const client = clientFor(target, endpoint)
  let committed = false
  try {
    const identity = await client.identity(remaining())
    assertIdentity(identity, target.coreId)
    await client.connect(remaining())
    if (sameCore && old) await old.waitForHostIdle(remaining())
    remaining()
    if (!client.isConnected) throw new Error('远程 Core 已断开')
    target.selectedEndpointId = endpoint.id
    Object.assign(target, { version: identity.version, capabilities: identity.capabilities, platform: identity.platform })
    const changed = activeId() !== target.id
    if (options.remember) store.preferredId = target.id
    writeStore(store)
    selectedId = target.id
    if (changed) generation += 1
    if (old && old === localClient) detachLocalCoreClient(false)
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
        for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send(AGENT_IPC_CHANNELS.STREAM_EVENT, { sessionId: namespaceCoreSessionId(sessionId, target.coreId), payload })
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

export function setLocalCoreClient(client: CoreClient, identity?: Awaited<ReturnType<CoreClient['identity']>>): void {
  localIdentity = identity
  unsubscribeLocalChat?.()
  unsubscribeLocalChat = client.addChatEventListener(event => {
    if (activeClient !== client || activeId() !== LOCAL_TARGET_ID || !localIdentity?.coreId) return
    publishCoreChat(event, localIdentity.coreId)
  })
  unsubscribeLocalChatSnapshot?.()
  unsubscribeLocalChatSnapshot = client.addSnapshotListener(snapshot => {
    if (activeClient !== client || activeId() !== LOCAL_TARGET_ID || !localIdentity?.coreId) return
    publishChatSnapshot(snapshot.chat, localIdentity.coreId)
  })
  unsubscribeLocalPlanning?.()
  unsubscribeLocalPlanning = client.addPlanningEventListener(payload => {
    if (activeClient !== client || activeId() !== LOCAL_TARGET_ID || !payload || typeof payload !== 'object') return
    const event = payload as { type?: string; resources?: unknown; operation?: unknown; reminders?: import('@profer/shared').ActivePlanningReminder[] }
    const channel = event.type === 'changed' ? PLANNING_IPC_CHANNELS.CHANGED : event.type === 'agent_operation' ? PLANNING_IPC_CHANNELS.AGENT_OPERATION : event.type === 'reminders_due' ? PLANNING_IPC_CHANNELS.REMINDER_DUE : undefined
    if (!channel) return
    if (event.type === 'reminders_due') {
      void import('./planning-reminder-scheduler').then(({ showPlanningSystemNotification }) => {
        if (activeClient !== client || activeId() !== LOCAL_TARGET_ID) return
        for (const reminder of event.reminders ?? []) showPlanningSystemNotification(reminder)
      }).catch(error => console.error('[Core Planning] 通知失败', error))
    }
    const data = event.type === 'changed' ? { resources: event.resources } : event.type === 'reminders_due' ? event.reminders : event.operation
    for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send(channel, data)
  })
  localClient = client
  if (activeId() === LOCAL_TARGET_ID) {
    if (activeClient && activeClient !== client) activeClient.close()
    activeClient = client
    attachLocalCoreClient(client)
    targetStatus = 'connected'
    publishSnapshot()
    if (identity?.capabilities.includes('chat')) void client.refreshSnapshot().catch(error => console.error('[Core Chat] 本机快照恢复失败：', error))
  }
}

export async function activateSavedCoreTarget(): Promise<void> {
  if (startupRestore) return startupRestore
  const saved = readStore()
  if (saved.preferredId === LOCAL_TARGET_ID) return Promise.resolve()
  const preferred = saved.preferredId
  selectedId ??= preferred
  const request = explicitSelection
  startup = 'restoring'
  publishSnapshot()
  startupRestore = (async () => {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS
    while (request === explicitSelection && startup === 'restoring' && Date.now() < deadline) {
      try {
        await serialize(() => {
          if (request !== explicitSelection || startup !== 'restoring') return
          const store = readStore()
          const target = requireTarget(store, preferred)
          return changeRemoteConnection(store, target, selectedEndpoint(target), {
            timeoutMs: Math.min(CONNECTION_TIMEOUT_MS, Math.max(1, deadline - Date.now())),
            accept: () => request === explicitSelection,
          })
        })
        return
      } catch (error) {
        console.warn('[Core] 启动时连接上次内核失败:', error instanceof Error ? error.message : String(error))
      }
      const delay = Math.min(1_000, deadline - Date.now())
      if (delay > 0 && request === explicitSelection) await new Promise(resolve => setTimeout(resolve, delay))
    }
    if (request !== explicitSelection || startup !== 'restoring') return
    await serialize(() => {
      if (request !== explicitSelection || startup !== 'restoring') return
      startup = 'fallback'
      activateLocal(readStore(), false)
    })
  })()
  return startupRestore
}

export function getActiveCoreClient(): CoreClient | null { return activeClient }

export function namespaceCoreSessionId(sessionId: string, coreId: string): string {
  return `core:${encodeURIComponent(coreId)}:${sessionId}`
}

export function parseCoreSessionId(value: string): { coreId: string; sessionId: string } | null {
  const match = /^core:([^:]+):(.+)$/.exec(value)
  if (!match) return null
  try { return { coreId: decodeURIComponent(match[1]!), sessionId: match[2]! } }
  catch { return null }
}

export function currentCoreId(): string | undefined {
  const store = readStore()
  return store.targets.find(target => target.id === activeId(store))?.coreId
}

export function getCoreTargetGeneration(): number { return generation }
export function getCurrentCoreTargetId(): string { return activeId() }

export function removeCoreTarget(id: string): Promise<CoreTargetsSnapshot> {
  return serialize(() => {
    const store = readStore()
    requireTarget(store, id)
    if (activeId(store) === id) throw new Error('请先切回本机内核，再移除此连接')
    store.targets = store.targets.filter(target => target.id !== id)
    if (store.preferredId === id) store.preferredId = LOCAL_TARGET_ID
    writeStore(store)
    publishSnapshot()
    return listCoreTargets()
  })
}
