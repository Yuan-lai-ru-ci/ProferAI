import { AGENT_IPC_CHANNELS, AUTOMATION_IPC_CHANNELS, PLANNING_IPC_CHANNELS } from '@profer/shared'
import { BrowserWindow, app, safeStorage } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { projectRemoteRunEvent } from './core-run-projection'
import { CoreClient } from './core-client'
import { configureCoreHostConnection } from './core-host-connection'
const relayedSessions = new Set<string>()
export function markCoreRunRelayed(sessionId: string, active: boolean): void {
  if (active) relayedSessions.add(sessionId); else relayedSessions.delete(sessionId)
}
import type { CoreTargetSummary } from '../../types'
import { attachLocalCoreClient, detachLocalCoreClient } from './core-local-bridge'


interface StoredTarget {
  id: string
  name: string
  baseUrl: string
  encryptedToken: string
  coreId?: string
  version?: string
  capabilities?: string[]
  /** 所属 Core 的运行平台（win32/linux/darwin）；老记录可能没有。 */
  platform?: string
}

interface TargetStore {
  currentId: string
  targets: StoredTarget[]
}

const LOCAL_TARGET_ID = 'local'
const PROTOCOL_VERSION = 1
let activeClient: CoreClient | null = null
let localClient: CoreClient | null = null
let unsubscribeLocalPlanning: (() => void) | undefined
let targetStatus: 'connected' | 'disconnected' | 'error' = 'disconnected'
let generation = 0
let selectionQueue: Promise<void> = Promise.resolve()
let beforeTargetSwitch: (() => void | Promise<void>) | undefined

function publishSnapshot(): void {
  const snapshot = listCoreTargets()
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send('core-target:changed', snapshot)
      window.webContents.send(AUTOMATION_IPC_CHANNELS.CHANGED)
    }
  }
}

function storePath(): string {
  return join(app.getPath('userData'), 'core-targets.json')
}

function readStore(): TargetStore {
  const path = storePath()
  if (!existsSync(path)) return { currentId: LOCAL_TARGET_ID, targets: [] }
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as TargetStore
    if (!value || !Array.isArray(value.targets)) return { currentId: LOCAL_TARGET_ID, targets: [] }
    return { currentId: value.currentId || LOCAL_TARGET_ID, targets: value.targets.filter(item => item && typeof item.id === 'string' && typeof item.encryptedToken === 'string') }
  } catch {
    return { currentId: LOCAL_TARGET_ID, targets: [] }
  }
}

function writeStore(store: TargetStore): void {
  const path = storePath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(store, null, 2), { mode: 0o600 })
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

function clientFor(target: StoredTarget): CoreClient {
  const goalSessions = new Set<string>()
  const client = new CoreClient({
    baseUrl: target.baseUrl,
    token: decryptToken(target.encryptedToken),
    recoverEvents: true,
    onSnapshot: snapshot => {
      if (activeClient !== client || readStore().currentId !== target.id || !target.coreId) return
      const ns = (id: string) => namespaceCoreSessionId(id, target.coreId!)
      goalSessions.clear()
      for (const goal of snapshot.goals) {
        if (goal.status === 'active' || goal.status === 'stopping') goalSessions.add(goal.sessionId)
        for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send(AGENT_IPC_CHANNELS.GOAL_EVENT, { sessionId: ns(goal.sessionId), state: { ...goal, sessionId: ns(goal.sessionId) } })
      }
      for (const pending of snapshot.pending) {
        const requests = [...pending.permissions.map(request => ({ type: 'permission_request', request })), ...pending.askUsers.map(request => ({ type: 'ask_user_request', request })), ...pending.exitPlans.map(request => ({ type: 'exit_plan_mode_request', request }))]
        for (const event of requests) for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send(AGENT_IPC_CHANNELS.STREAM_EVENT, { sessionId: ns(pending.sessionId), payload: { kind: 'profer_event', event: { ...event, request: { ...event.request, sessionId: ns(pending.sessionId) } } } })
      }
      for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send(AUTOMATION_IPC_CHANNELS.CHANGED)
    },
    onEvent: event => {
      if (activeClient !== client || readStore().currentId !== target.id || !target.coreId) return
      const payload = event.payload as { kind?: string; event?: { type?: string; state?: import('@profer/shared').AgentGoalState } }
      const localId = namespaceCoreSessionId(event.sessionId, target.coreId)
      if (payload?.kind === 'profer_event' && payload.event?.type === 'goal_state' && payload.event.state) {
        const state = { ...payload.event.state, sessionId: localId }
        if (state.status === 'active' || state.status === 'stopping') goalSessions.add(event.sessionId)
        else goalSessions.delete(event.sessionId)
        for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send(AGENT_IPC_CHANNELS.GOAL_EVENT, { sessionId: localId, state: state.reasonCode === 'cleared' ? null : state })
        return
      }
      if (relayedSessions.has(event.sessionId)) return
      const projection = projectRemoteRunEvent(event, localId)
      for (const window of BrowserWindow.getAllWindows()) {
        if (window.isDestroyed()) continue
        if (projection?.eventPayload) window.webContents.send(AGENT_IPC_CHANNELS.STREAM_EVENT, { sessionId: localId, payload: projection.eventPayload })
        if (projection?.completion) window.webContents.send(AGENT_IPC_CHANNELS.STREAM_COMPLETE, projection.completion)
      }
    },
    onWorkspaceEvent: () => {
      if (activeClient !== client || readStore().currentId !== target.id || !target.coreId) return
      for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send(AGENT_IPC_CHANNELS.WORKSPACES_CHANGED)
    },
    onAutomationEvent: () => {
      if (activeClient !== client || readStore().currentId !== target.id) return
      for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send(AUTOMATION_IPC_CHANNELS.CHANGED)
    },
    onPlanningEvent: payload => {
      if (activeClient !== client || readStore().currentId !== target.id || !payload || typeof payload !== 'object') return
      const event = payload as { type?: string; resources?: unknown; reminders?: unknown; operation?: unknown }
      const channel = event.type === 'changed' ? PLANNING_IPC_CHANNELS.CHANGED
        : event.type === 'reminders_due' ? PLANNING_IPC_CHANNELS.REMINDER_DUE
        : event.type === 'agent_operation' ? PLANNING_IPC_CHANNELS.AGENT_OPERATION : undefined
      if (!channel || !target.coreId) return
      const data = event.type === 'changed' ? { resources: event.resources }
        : event.type === 'reminders_due' ? event.reminders
        : { ...(event.operation as Record<string, unknown>), sessionId: namespaceCoreSessionId(String((event.operation as { sessionId?: unknown })?.sessionId), target.coreId) }
      for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send(channel, data)
    },
    onStatus: status => {
      // 重选同一目标时旧连接也会晚到 closed/error，只有当前连接能发布状态。
      if (activeClient !== client || readStore().currentId !== target.id) return
      targetStatus = status === 'open' ? 'connected' : status === 'error' || status === 'closed' ? 'error' : 'disconnected'
      publishSnapshot()
      if (status === 'open') for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) {
        window.webContents.send(AUTOMATION_IPC_CHANNELS.CHANGED)
        window.webContents.send(AGENT_IPC_CHANNELS.WORKSPACES_CHANGED)
      }
    },
  })
  return client
}

function summaries(): CoreTargetSummary[] {
  const store = readStore()
  return [
    { id: LOCAL_TARGET_ID, name: '本机内核', kind: 'local', status: activeClient && store.currentId === LOCAL_TARGET_ID ? targetStatus : 'disconnected' },
    ...store.targets.map(target => ({
      id: target.id, name: target.name, kind: 'remote' as const, baseUrl: target.baseUrl,
      status: store.currentId === target.id ? targetStatus : 'disconnected',
      ...(target.version ? { version: target.version } : {}), ...(target.coreId ? { coreId: target.coreId } : {}),
      ...(target.capabilities ? { capabilities: target.capabilities } : {}),
      ...(target.platform ? { platform: target.platform } : {}),
    })),
  ]
}

export function listCoreTargets(): { currentId: string; generation: number; targets: CoreTargetSummary[] } {
  const store = readStore()
  return { currentId: store.currentId, generation, targets: summaries() }
}

export async function testCoreTarget(input: { name: string; baseUrl: string; token: string }): Promise<{ version: string; coreId: string; capabilities: string[]; platform?: string }> {
  const name = input.name.trim()
  const baseUrl = input.baseUrl.trim().replace(/\/+$/, '')
  const token = input.token.trim()
  if (!name || name.length > 80) throw new Error('内核名称不能为空且不能超过 80 个字符')
  if (!token) throw new Error('Core Token 不能为空')
  const parsed = new URL(baseUrl)
  const localHttpAllowed = !app.isPackaged && parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)
  if (parsed.protocol !== 'https:' && !localHttpAllowed) throw new Error('远程 Core 必须使用 HTTPS；开发版仅允许 loopback HTTP 隧道')
  const client = new CoreClient({ baseUrl, token, reconnect: false })
  try {
    const identity = await client.identity()
    if (identity.protocolVersion !== PROTOCOL_VERSION) throw new Error(`Core 协议版本不兼容: ${identity.protocolVersion}`)
    return identity
  } finally { client.close() }
}

export async function addCoreTarget(input: { name: string; baseUrl: string; token: string }): Promise<CoreTargetSummary> {
  const identity = await testCoreTarget(input)
  const store = readStore()
  const baseUrl = input.baseUrl.trim().replace(/\/+$/, '')
  const prior = store.targets.find(target => target.baseUrl === baseUrl)
  const target: StoredTarget = {
    id: prior?.id ?? randomUUID(), name: input.name.trim(), baseUrl,
    encryptedToken: encryptToken(input.token.trim()), ...identity,
  }
  store.targets = [...store.targets.filter(item => item.id !== target.id), target]
  writeStore(store)
  return summaries().find(item => item.id === target.id)!
}

export function selectCoreTarget(id: string): Promise<ReturnType<typeof listCoreTargets>> {
  const operation = selectionQueue.then(() => selectCoreTargetNow(id))
  selectionQueue = operation.then(() => undefined, () => undefined)
  return operation
}

async function selectCoreTargetNow(id: string): Promise<ReturnType<typeof listCoreTargets>> {
  const store = readStore()
  if (id !== store.currentId) await beforeTargetSwitch?.()
  const nextGeneration = generation + 1
  if (id === LOCAL_TARGET_ID) {
    if (activeClient !== localClient) activeClient?.close()
    detachLocalCoreClient(false)
    localClient = localClient ?? null
    if (localClient) {
      activeClient = localClient
      attachLocalCoreClient(localClient)
      targetStatus = 'connected'
    } else {
      activeClient = null
      targetStatus = 'disconnected'
    }
    store.currentId = LOCAL_TARGET_ID
    writeStore(store)
    generation = nextGeneration
    publishSnapshot()
    return listCoreTargets()
  }
  const target = store.targets.find(item => item.id === id)
  if (!target) throw new Error('找不到指定的 Core 内核')
  const client = clientFor(target)
  try {
    const identity = await client.identity()
    if (target.coreId && identity.coreId !== target.coreId) throw new Error('远程 Core 身份已变化，请重新验证该连接')
    if (identity.protocolVersion !== PROTOCOL_VERSION) throw new Error(`Core 协议版本不兼容: ${identity.protocolVersion}`)
    await client.connect()
    if (activeClient !== localClient) activeClient?.close()
    detachLocalCoreClient(false)
    activeClient = client
    configureCoreHostConnection(client, {
      coreId: identity.coreId,
      contentRoot: join(app.getPath('temp'), 'profer-core-host'),
      sessionId: raw => namespaceCoreSessionId(raw, identity.coreId),
      isCurrent: () => activeClient === client && readStore().currentId === id,
      emitPreview: (sessionId, payload) => {
        for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send(AGENT_IPC_CHANNELS.STREAM_EVENT, { sessionId: namespaceCoreSessionId(sessionId, identity.coreId), payload })
      },
    })
    targetStatus = 'connected'
    store.currentId = id
    Object.assign(target, identity)
    writeStore(store)
    generation = nextGeneration
    publishSnapshot()
    if (identity.capabilities.includes('agent.events.resume')) await client.refreshSnapshot()
    return listCoreTargets()
  } catch (error) {
    client.close()
    if (activeClient !== localClient) activeClient?.close()
    detachLocalCoreClient(false)
    activeClient = null
    store.currentId = id
    targetStatus = 'error'
    generation = nextGeneration
    writeStore(store)
    publishSnapshot()
    throw error
  }
}

export function setLocalCoreClient(client: CoreClient): void {
  unsubscribeLocalPlanning?.()
  unsubscribeLocalPlanning = client.addPlanningEventListener(payload => {
    if (activeClient !== client || readStore().currentId !== LOCAL_TARGET_ID || !payload || typeof payload !== 'object') return
    const event = payload as { type?: string; resources?: unknown; operation?: unknown }
    const channel = event.type === 'changed' ? PLANNING_IPC_CHANNELS.CHANGED : event.type === 'agent_operation' ? PLANNING_IPC_CHANNELS.AGENT_OPERATION : undefined
    if (!channel) return
    for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send(channel, event.type === 'changed' ? { resources: event.resources } : event.operation)
  })
  localClient = client
  if (readStore().currentId === LOCAL_TARGET_ID) {
    if (activeClient && activeClient !== client) activeClient.close()
    activeClient = client
    attachLocalCoreClient(client)
    targetStatus = 'connected'
    publishSnapshot()
  }
}

export async function activateSavedCoreTarget(): Promise<void> {
  const store = readStore()
  if (store.currentId === LOCAL_TARGET_ID) return
  try { await selectCoreTarget(store.currentId) }
  catch (error) {
    targetStatus = 'error'
    console.error('[Core] 已保存的当前远程内核连接失败:', error instanceof Error ? error.message : String(error))
  }
}

export function setBeforeCoreTargetSwitch(guard: (() => void | Promise<void>) | undefined): void {
  beforeTargetSwitch = guard
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
  if (store.currentId === LOCAL_TARGET_ID) return undefined
  return store.targets.find(target => target.id === store.currentId)?.coreId
}

export function getCoreTargetGeneration(): number { return generation }
export function getCurrentCoreTargetId(): string { return readStore().currentId }

export async function removeCoreTarget(id: string): Promise<ReturnType<typeof listCoreTargets>> {
  const store = readStore()
  if (store.currentId === id) await selectCoreTarget(LOCAL_TARGET_ID)
  store.targets = store.targets.filter(target => target.id !== id)
  writeStore(store)
  return listCoreTargets()
}
