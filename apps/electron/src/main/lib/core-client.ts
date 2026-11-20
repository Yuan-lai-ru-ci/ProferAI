import WebSocket from 'ws'
import { buildAgentSessionUiProjection, CHAT_IPC_CHANNELS } from '@profer/shared'
import type { AgentWorkspace, ProjectWorkspaceOpenResult } from '@profer/shared'
import type { AgentRuntimeQuery, RuntimeCredential } from '@profer/agent-runtime'

/** 本轮宿主快照只经已鉴权请求传送，不写入持久化配置或事件。 */
export interface CoreMessageOptions {
  channelId?: string
  modelId?: string
  uuid?: string
  rawUserMessage?: string
  /** 渲染进程生成的流式开始时间戳；Core 原样回传终态，跨时钟也不影响竞态保护。 */
  startedAt?: number
  context?: AgentRuntimeQuery['context']
  credentials?: RuntimeCredential
}

export interface CoreChannel {
  id: string
  name: string
  provider: import('@profer/shared').ProviderType
  baseUrl?: string
  agentBaseUrl?: string
  credentialMode?: 'api-key' | 'oauth'
  apiProtocol?: 'responses' | 'chat-completions'
  models?: Array<{ id: string; name: string; enabled: boolean; context1m?: boolean }>
  enabled?: boolean
  agentRuntimes?: Array<'claude' | 'pi'>
}

export interface CoreSession {
  id: string
  title: string
  agentRuntime?: string
  channelId?: string
  modelId?: string
  workspaceId?: string
  presetId?: string
  presetReference?: import('@profer/shared').PresetReference
  permissionMode?: import('@profer/shared').ProferPermissionMode
  createdAt?: number
  updatedAt?: number
  [key: string]: unknown
}

export interface CoreAgentEvent {
  kind: string
  sessionId: string
  payload?: unknown
  [key: string]: unknown
}

export interface CoreChatEvent {
  kind: 'chat_event'
  conversationId: string
  channel: string
  payload: unknown
}

export interface CoreRecoverySnapshot {
  chat?: { conversations: import('@profer/shared').ConversationMeta[]; activeRuns: Array<{ conversationId: string; runId: string }> }
  deletionStatuses?: import('@profer/shared').AgentSessionDeletionStatusPayload[]
  tombstones?: Array<{ sessionId: string; revision: number }>
  sessions: CoreSession[]
  goals: import('@profer/shared').AgentGoalState[]
  automations: import('@profer/shared').Automation[]
  delegations: Array<Record<string, unknown>>
  pending: Array<{ sessionId: string; permissions: import('@profer/shared').PermissionRequest[]; askUsers: import('@profer/shared').AskUserRequest[]; exitPlans: import('@profer/shared').ExitPlanModeRequest[] }>
  runs?: import('@profer/agent-runtime').AgentRun[]
  cursor: string
}
export interface CoreRecoveryResult {
  requiresSnapshot: boolean
  latestEventId: string
  replayed: number
  snapshot?: CoreRecoverySnapshot
}

export interface CoreClientOptions {
  baseUrl: string
  token: string
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>
  webSocketFactory?: (url: string, options: { headers: Record<string, string>; protocols: string[] }) => CoreWebSocket
  reconnect?: boolean
  reconnectDelayMs?: number
  onChatEvent?: (event: CoreChatEvent) => void
  onEvent?: (event: CoreAgentEvent) => void
  onAutomationEvent?: (payload: unknown) => void
  onWorkspaceEvent?: () => void
  onPlanningEvent?: (payload: unknown) => void
  onSnapshot?: (snapshot: CoreRecoverySnapshot) => void
  recoverEvents?: boolean
  onStatus?: (status: CoreConnectionStatus) => void
}

export type CoreConnectionStatus = 'connecting' | 'open' | 'closed' | 'error'

export const REMOTE_STOP_TIMEOUT_MS = 30_000

export function createRemoteStopTimeoutSignal(timeoutMs = REMOTE_STOP_TIMEOUT_MS): AbortSignal {
  return AbortSignal.timeout(timeoutMs)
}


export interface CoreWebSocket {
  readyState: number
  onopen: (() => void) | null
  onerror: ((error: unknown) => void) | null
  onclose: (() => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  send(data: string): void
  close(): void
}

export interface CoreHostIncomingRequest {
  coreId: string
  sessionId: string
  runId: string
  requestId: string
  operation: string
  payload: unknown
}
export type CoreHostOutgoingResponse = Pick<CoreHostIncomingRequest, 'coreId' | 'sessionId' | 'runId' | 'requestId'> & ({ ok: true; value: unknown } | { ok: false; error: string })

export class CoreClientError extends Error {
  readonly status?: number
  readonly code?: string

  constructor(message: string, options?: { status?: number; code?: string }) {
    super(message)
    this.name = 'CoreClientError'
    this.status = options?.status
    this.code = options?.code
  }
}

const OPEN = 1

function normalizeBaseUrl(value: string): string {
  const base = value.trim().replace(/\/+$/, '')
  if (!/^https?:\/\//.test(base)) throw new CoreClientError('Core 地址必须使用 http 或 https')
  return base
}

function parseResponseBody(text: string): unknown {
  if (!text.trim()) return undefined
  try { return JSON.parse(text) as unknown } catch { return text }
}

function wsUrlFromHttp(baseUrl: string): string {
  return `${baseUrl.replace(/^http/i, 'ws')}/ws`
}

export class CoreClient {
  private readonly baseUrl: string
  private readonly token: string
  private readonly fetchImpl: (input: string, init?: RequestInit) => Promise<Response>
  private readonly webSocketFactory: (url: string, options: { headers: Record<string, string>; protocols: string[] }) => CoreWebSocket
  private readonly reconnect: boolean
  private readonly reconnectDelayMs: number
  private readonly onChatEvent?: (event: CoreChatEvent) => void
  private readonly chatEventListeners = new Set<(event: CoreChatEvent) => void>()
  private readonly onEvent?: (event: CoreAgentEvent) => void
  private readonly onAutomationEvent?: (payload: unknown) => void
  private readonly onWorkspaceEvent?: () => void
  private readonly onPlanningEvent?: (payload: unknown) => void
  private readonly onSnapshot?: (snapshot: CoreRecoverySnapshot) => void
  private readonly recoverEvents: boolean
  private connecting?: Promise<void>
  private recovery?: Promise<void>
  private eventCursor: string | null = null
  private bufferedEvents: Record<string, unknown>[] | undefined
  private readonly onStatus?: (status: CoreConnectionStatus) => void
  private readonly snapshotListeners = new Set<(snapshot: CoreRecoverySnapshot) => void>()
  private readonly automationEventListeners = new Set<(payload: unknown) => void>()
  private readonly workspaceEventListeners = new Set<() => void>()
  private latestSnapshot?: CoreRecoverySnapshot
  private readonly planningEventListeners = new Set<(payload: unknown) => void>()
  private readonly eventListeners = new Set<(event: CoreAgentEvent) => void>()
  private readonly pendingCommands = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private socket: CoreWebSocket | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private closedByUser = false
  private readonly hostSessionIds = new Set<string>()
  private hostRegistration?: Promise<unknown>
  private hostRequestHandler?: (request: CoreHostIncomingRequest) => Promise<CoreHostOutgoingResponse>

  constructor(options: CoreClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl)
    this.token = options.token
    if (!this.token.trim()) throw new CoreClientError('Core token 不能为空')
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init))
    this.webSocketFactory = options.webSocketFactory ?? ((url, connectionOptions) => new WebSocket(url, connectionOptions.protocols, { headers: connectionOptions.headers }) as unknown as CoreWebSocket)
    this.reconnect = options.reconnect ?? true
    this.reconnectDelayMs = options.reconnectDelayMs ?? 500
    this.onChatEvent = options.onChatEvent
    this.onEvent = options.onEvent
    this.onAutomationEvent = options.onAutomationEvent
    this.onWorkspaceEvent = options.onWorkspaceEvent
    this.onPlanningEvent = options.onPlanningEvent
    this.onSnapshot = options.onSnapshot
    this.recoverEvents = options.recoverEvents ?? false
    this.onStatus = options.onStatus
  }

  setHostRequestHandler(handler: (request: CoreHostIncomingRequest) => Promise<CoreHostOutgoingResponse>): void {
    this.hostRequestHandler = handler
    const socket = this.socket
    if (socket?.readyState === OPEN) {
      this.hostRegistration = this.sendOnSocket(socket, { type: 'register_desktop_host', sessionIds: [...this.hostSessionIds] })
      void this.hostRegistration.catch(error => console.error('[Core] 桌面宿主注册失败:', error))
    }
  }

  async health(): Promise<{ status: string; service: string; version: string }> {
    return this.request('/health', { auth: false }) as Promise<{ status: string; service: string; version: string }>
  }

  async identity(): Promise<{ protocolVersion: number; coreId: string; version: string; capabilities: string[]; platform?: string }> {
    return this.request('/identity') as Promise<{ protocolVersion: number; coreId: string; version: string; capabilities: string[]; platform?: string }>
  }

  /** Core 的文件浏览起点；仅非本机内核的选择器使用。 */
  async getFileSystemOverview(): Promise<import('@profer/shared').CoreFsOverview> {
    return this.request('/fs/roots') as Promise<import('@profer/shared').CoreFsOverview>
  }

  async listDirectories(path: string, includeFiles = false): Promise<import('@profer/shared').CoreDirectoryListing> {
    return this.request(`/fs/entries?path=${encodeURIComponent(path)}${includeFiles ? '&includeFiles=1' : ''}`) as Promise<import('@profer/shared').CoreDirectoryListing>
  }

  /** 系统文件操作：rename/move/copy/trash/preview。 */
  async fileOp(input: import('@profer/shared').CoreFsOpInput): Promise<{ path: string } | import('@profer/shared').CoreFilePreview | null> {
    if (input.op === 'rename') return this.request('/fs/rename', { method: 'POST', body: { path: input.path, name: input.name ?? '' } }) as Promise<{ path: string }>
    if (input.op === 'move') return this.request('/fs/move', { method: 'POST', body: { path: input.path, toDir: input.toDir ?? '', overwrite: input.overwrite === true } }) as Promise<{ path: string }>
    if (input.op === 'copy') return this.request('/fs/copy', { method: 'POST', body: { path: input.path, toDir: input.toDir ?? '', overwrite: input.overwrite === true } }) as Promise<{ path: string }>
    if (input.op === 'trash') return this.request('/fs/trash', { method: 'POST', body: { path: input.path } }) as Promise<{ path: string }>
    try {
      return await this.request(`/fs/preview?path=${encodeURIComponent(input.path)}`) as import('@profer/shared').CoreFilePreview
    } catch (error) {
      if (error instanceof CoreClientError && error.status === 415) return null
      throw error
    }
  }

  /** 会话授权范围内的文件操作。 */
  async sessionFileOp(input: import('@profer/shared').CoreSessionFsOpInput): Promise<{ path: string } | import('@profer/shared').CoreFilePreview | null> {
    const base = `/sessions/${encodeURIComponent(input.sessionId)}/files`
    if (input.op === 'rename') return this.request(`${base}/rename`, { method: 'POST', body: { path: input.path, name: input.name ?? '' } }) as Promise<{ path: string }>
    if (input.op === 'move') return this.request(`${base}/move`, { method: 'POST', body: { path: input.path, toDir: input.toDir ?? '', overwrite: input.overwrite === true } }) as Promise<{ path: string }>
    if (input.op === 'copy') return this.request(`${base}/copy`, { method: 'POST', body: { path: input.path, toDir: input.toDir ?? '', overwrite: input.overwrite === true } }) as Promise<{ path: string }>
    if (input.op === 'trash') return this.request(`${base}/trash`, { method: 'POST', body: { path: input.path } }) as Promise<{ path: string }>
    try {
      return await this.request(`${base}/preview?path=${encodeURIComponent(input.path)}`) as import('@profer/shared').CoreFilePreview
    } catch (error) {
      if (error instanceof CoreClientError && error.status === 415) return null
      throw error
    }
  }

  async probeDirectory(path: string): Promise<import('@profer/shared').CoreDirectoryProbe> {
    return this.request(`/fs/probe?path=${encodeURIComponent(path)}`) as Promise<import('@profer/shared').CoreDirectoryProbe>
  }

  async planProject(input: { basePath: string; projectName?: string }): Promise<import('@profer/shared').CoreProjectPlan> {
    return this.request('/fs/plan', { method: 'POST', body: input }) as Promise<import('@profer/shared').CoreProjectPlan>
  }

  async createDirectory(path: string): Promise<{ path: string }> {
    return this.request('/fs/dirs', { method: 'POST', body: { path } }) as Promise<{ path: string }>
  }

  async getSessionFileRoots(sessionId: string): Promise<import('@profer/shared').CoreSessionFileRoots> {
    return this.request(`/sessions/${encodeURIComponent(sessionId)}/files/roots`) as Promise<import('@profer/shared').CoreSessionFileRoots>
  }

  async listSessionDirectory(sessionId: string, dirPath: string): Promise<import('@profer/shared').CoreFsEntry[]> {
    const body = await this.request(`/sessions/${encodeURIComponent(sessionId)}/files/entries?path=${encodeURIComponent(dirPath)}`) as { entries?: import('@profer/shared').CoreFsEntry[] }
    return body.entries ?? []
  }

  async listChannels(): Promise<CoreChannel[]> {
    const body = await this.request('/channels') as { channels?: CoreChannel[] }
    return body.channels ?? []
  }

  async createChannel(input: import('@profer/shared').ChannelCreateInput): Promise<CoreChannel> {
    return this.request('/channels', { method: 'POST', body: input }) as Promise<CoreChannel>
  }

  async updateChannel(id: string, input: import('@profer/shared').ChannelUpdateInput): Promise<CoreChannel> {
    return this.request(`/channels/${encodeURIComponent(id)}`, { method: 'PATCH', body: input }) as Promise<CoreChannel>
  }

  async deleteChannel(id: string): Promise<void> {
    await this.request(`/channels/${encodeURIComponent(id)}`, { method: 'DELETE' })
  }

  async fetchChannelModels(input: import('@profer/shared').FetchModelsInput): Promise<import('@profer/shared').FetchModelsResult> {
    return this.request('/channels/discover', { method: 'POST', body: input }) as Promise<import('@profer/shared').FetchModelsResult>
  }

  async testChannel(input: import('@profer/shared').FetchModelsInput): Promise<import('@profer/shared').ChannelTestResult> {
    return this.request('/channels/test', { method: 'POST', body: input }) as Promise<import('@profer/shared').ChannelTestResult>
  }

  async listWorkspaces(): Promise<AgentWorkspace[]> {
    const body = await this.request('/workspaces') as { workspaces?: AgentWorkspace[] }
    return body.workspaces ?? []
  }

  async updateWorkspace(id: string, updates: { name?: string; archived?: boolean }): Promise<AgentWorkspace> {
    return this.request(`/workspaces/${encodeURIComponent(id)}`, { method: 'PATCH', body: updates }) as Promise<AgentWorkspace>
  }

  async reorderWorkspaces(orderedIds: string[]): Promise<AgentWorkspace[]> {
    const result = await this.request('/workspaces/reorder', { method: 'POST', body: { orderedIds } }) as { workspaces: AgentWorkspace[] }
    return result.workspaces
  }

  async relocateProjectWorkspace(input: { id: string; rootPath: string }): Promise<ProjectWorkspaceOpenResult> {
    return await this.request('/workspaces/projects/relocate', { method: 'POST', body: input }) as ProjectWorkspaceOpenResult
  }

  async removeProjectWorkspace(id: string): Promise<void> {
    // 专用解绑路径禁止旧 Core 将 managed 工作区误当普通删除。
    await this.request(`/workspaces/projects/${encodeURIComponent(id)}`, { method: 'DELETE' })
  }

  async deleteWorkspace(id: string): Promise<void> {
    await this.request(`/workspaces/${encodeURIComponent(id)}`, { method: 'DELETE' })
  }

  async createManagedWorkspace(name: string): Promise<AgentWorkspace> {
    return this.request('/workspaces', { method: 'POST', body: { name } }) as Promise<AgentWorkspace>
  }

  async bindProjectWorkspace(input: { rootPath: string; name?: string; open?: boolean }): Promise<ProjectWorkspaceOpenResult> {
    return this.request('/workspaces/projects', { method: 'POST', body: input }) as Promise<ProjectWorkspaceOpenResult>
  }

  async listSessions(): Promise<CoreSession[]> {
    const body = await this.request('/sessions') as { sessions?: CoreSession[] }
    return body.sessions ?? []
  }

  async ensureProjectDraftSession(input: { workspaceId: string; channelId?: string; modelId?: string; useCoreDefaults?: boolean }): Promise<CoreSession> {
    // 旧 Core 不提供原子草稿语义时明确失败，不改用普通 create 或桌面写入。
    return await this.request(input.useCoreDefaults ? '/project-draft-sessions/configured' : '/project-draft-sessions', { method: 'POST', body: input }) as CoreSession
  }

  async ensureWorkspaceSession(input: { workspaceId: string; channelId?: string; modelId?: string }): Promise<CoreSession> {
    try {
      return await this.request('/workspace-sessions', { method: 'POST', body: input }) as CoreSession
    } catch (error) {
      if (!(error instanceof CoreClientError) || error.status !== 404 || (error.code ?? error.message) !== 'not_found') throw error

      // 旧版 Core 没有原子 ensure 接口时，兼容其 sessions API；新版本始终走原子接口。
      const existing = (await this.listSessions()).find(session => session.workspaceId === input.workspaceId)
      if (existing) return existing
      throw this.legacyWorkspaceUnsupportedError()
    }
  }

  async createSession(input?: { useCoreDefaults?: boolean; title?: string; runtime?: 'claude' | 'pi'; channelId?: string; modelId?: string; workspaceId?: string; presetId?: string; presetReference?: import('@profer/shared').PresetReference; permissionMode?: import('@profer/shared').ProferPermissionMode }): Promise<CoreSession> {
    try {
      return await this.request(input?.useCoreDefaults ? '/sessions/configured' : '/sessions', { method: 'POST', body: input ?? {} }) as CoreSession
    } catch (error) {
      if (!(error instanceof CoreClientError) || error.status !== 404 || (error.code ?? error.message) !== 'not_found') throw error
      if (input?.workspaceId || input?.useCoreDefaults) throw this.legacyWorkspaceUnsupportedError()
      return await this.sendCommand({ type: 'create_session', ...input }) as CoreSession
    }
  }

  private legacyWorkspaceUnsupportedError(): CoreClientError {
    return new CoreClientError('远程 Core 版本过旧，无法在指定工作区创建会话。请更新服务器上的 Profer Core 后重试。', { status: 404, code: 'core_version_unsupported' })
  }

  private async sendCommand(command: Record<string, unknown>): Promise<unknown> {
    await this.connect()
    const socket = this.socket
    if (!socket || socket.readyState !== OPEN) throw new CoreClientError('远程 Core WebSocket 未连接')
    if (this.recovery && command.type !== 'resume_agent_events') await this.recovery
    return this.sendOnSocket(socket, command)
  }

  private sendOnSocket(socket: CoreWebSocket, command: Record<string, unknown>): Promise<unknown> {
    const commandId = crypto.randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCommands.delete(commandId)
        reject(new CoreClientError('远程 Core 命令超时'))
      }, 15_000)
      this.pendingCommands.set(commandId, { resolve, reject, timer })
      socket.send(JSON.stringify({ ...command, _cmdId: commandId }))
    })
  }

  /** 发送前连接事件流；connect/recovery异步等待后必须重新核对调用目标。 */
  async chatOperation<T>(operation: string, args: unknown[] = [], assertCurrent?: () => void): Promise<T> {
    assertCurrent?.()
    if (operation === 'chat:send-message') {
      await this.connect()
      assertCurrent?.()
    }
    const body = await this.request('/chat/operations', { method: 'POST', body: { operation, args } }) as { result: T }
    assertCurrent?.()
    return body.result
  }

  addChatEventListener(listener: (event: CoreChatEvent) => void): () => void {
    this.chatEventListeners.add(listener)
    return () => this.chatEventListeners.delete(listener)
  }

  async resourceOperation<T>(operation: string, args: unknown[] = []): Promise<T> {
    const body = await this.request('/resources/operations', { method: 'POST', body: { operation, args } }) as { result: T }
    return body.result
  }

  async planningOperation<T>(operation: string, args: unknown[] = []): Promise<T> {
    const body = await this.request('/planning/operations', { method: 'POST', body: { operation, args } }) as { result: T }
    return body.result
  }

  async respondPermission(input: { sessionId: string; requestId: string; runId?: string; behavior: 'allow' | 'deny'; alwaysAllow?: boolean }): Promise<boolean> {
    return await this.sendCommand({ type: 'respond_permission', ...input }) as boolean
  }

  async listPendingRequests(sessionId: string): Promise<import('@profer/shared').PendingRequestsSnapshot> {
    return await this.sendCommand({ type: 'list_pending_requests', sessionId }) as import('@profer/shared').PendingRequestsSnapshot
  }

  async nativeSnapshot(sessionId: string, since?: string): Promise<import('./core-native-routing').CoreNativeSnapshot> {
    return await this.sendCommand({ type: 'native_snapshot', sessionId, since }) as import('./core-native-routing').CoreNativeSnapshot
  }

  async nativeOperation<T>(sessionId: string, operation: string, input: Record<string, unknown> = {}): Promise<T> {
    return await this.sendCommand({ type: 'native_operation', sessionId, operation, input }) as T
  }

  async automationRequest<T>(operation: string, input: Record<string, unknown> = {}): Promise<T> {
    return await this.sendCommand({ type: `automation_${operation}`, ...input }) as T
  }

  async syncDesktopChannels(channels: Array<CoreChannel & { apiKey: string; codexOAuthCredentials?: unknown; xaiOAuthCredentials?: unknown }>): Promise<void> {
    await this.sendCommand({ type: 'desktop_channels_snapshot', channels })
  }

  async delegationRequest<T>(sessionId: string, operation: string, input: Record<string, unknown> = {}, operationId = crypto.randomUUID()): Promise<T> {
    return await this.sendCommand({ type: 'delegation_operation', sessionId, operation, input, operationId }) as T
  }

  async restoreState(cursor: string | null = null): Promise<CoreRecoveryResult> {
    return await this.sendCommand({ type: 'resume_agent_events', cursor }) as CoreRecoveryResult
  }

  async goalRequest<T>(operation: string, input: Record<string, unknown> = {}): Promise<T> {
    return await this.sendCommand({ type: `goal_${operation}`, ...input }) as T
  }

  async startGoal(input: { sessionId: string; goal: string; limits?: import('@profer/shared').AgentGoalLimits; contract?: import('@profer/shared').AgentGoalContract }): Promise<import('@profer/shared').AgentGoalState> { return await this.sendCommand({ type: 'goal_start', ...input }) as import('@profer/shared').AgentGoalState }
  async listGoals(sessionId?: string): Promise<import('@profer/shared').AgentGoalState[]> { return await this.sendCommand({ type: 'goal_list', ...(sessionId ? { sessionId } : {}) }) as import('@profer/shared').AgentGoalState[] }
  async goalControl(type: 'goal_pause' | 'goal_resume' | 'goal_stop', goalId: string): Promise<import('@profer/shared').AgentGoalState> { return await this.sendCommand({ type, goalId }) as import('@profer/shared').AgentGoalState }

  async respondExitPlan(input: import('@profer/shared').ExitPlanModeResponse & { sessionId: string }): Promise<boolean> {
    return await this.sendCommand({ type: 'respond_exit_plan_mode', ...input }) as boolean
  }

  async respondAskUser(input: { sessionId: string; requestId: string; runId?: string; answers: Record<string, string> }): Promise<boolean> {
    return await this.sendCommand({ type: 'respond_ask_user', ...input }) as boolean
  }

  async listPendingPermissions(sessionId: string): Promise<import('@profer/shared').PermissionRequest[]> {
    return await this.sendCommand({ type: 'list_pending_permissions', sessionId }) as import('@profer/shared').PermissionRequest[]
  }

  async updateSessionMeta(sessionId: string, patch: { channelId?: string; modelId?: string; presetId?: string; presetReference?: import('@profer/shared').PresetReference; permissionMode?: import('@profer/shared').ProferPermissionMode; agentRuntime?: 'claude' | 'pi'; codexFastMode?: boolean; openAIThinkingLevel?: import('@profer/shared').AgentThinkingLevel | null; agentEffort?: import('@profer/shared').AgentEffort | null; title?: string; expectedRevision?: number }): Promise<CoreSession> {
    return this.request(`/sessions/${encodeURIComponent(sessionId)}`, { method: 'PATCH', body: patch }) as Promise<CoreSession>
  }

  async deleteSession(sessionId: string): Promise<{ requestId: string; sessionIds: string[] }> {
    return await this.sendCommand({ type: 'delete_session', sessionId }) as { requestId: string; sessionIds: string[] }
  }

  async importLegacyDeletion(input: { sourceRequestId: string; sessionId: string; sessionIds: string[]; workspaceId?: string; requestedAt?: number; reason?: 'user' | 'workspace' | 'resume' }): Promise<{ requestId: string; sessionIds: string[] }> {
    return await this.sendCommand({ type: 'import_legacy_deletion', ...input }) as { requestId: string; sessionIds: string[] }
  }

  async applySessionUiAction(sessionId: string, action: import('@profer/shared').AgentSessionUiAction, expectedRevision?: number): Promise<CoreSession> {
    return await this.sendCommand({ type: 'session_ui_action', sessionId, action, expectedRevision }) as CoreSession
  }

  async getSessionDetail(sessionId: string): Promise<{ session: CoreSession; active: boolean }> {
    return await this.request(`/sessions/${encodeURIComponent(sessionId)}/detail`) as { session: CoreSession; active: boolean }
  }

  async stopAgent(sessionId: string): Promise<{ stopped: boolean; sessionId: string }> {
    return await this.sendCommand({ type: 'stop_agent', sessionId }) as { stopped: boolean; sessionId: string }
  }

  async saveAttachment(sessionId: string, filename: string, base64: string): Promise<{ filename: string; path: string; size: number }> {
    return await this.request(`/sessions/${encodeURIComponent(sessionId)}/attachments`, { method: 'POST', body: { filename, base64 } }) as { filename: string; path: string; size: number }
  }

  async searchFiles(sessionId: string, query: string, limit?: number): Promise<import('@profer/shared').FileSearchResult> {
    const params = new URLSearchParams({ query, ...(limit !== undefined ? { limit: String(limit) } : {}) })
    return await this.request(`/sessions/${encodeURIComponent(sessionId)}/files/search?${params}`) as Promise<import('@profer/shared').FileSearchResult>
  }

  async readFile(sessionId: string, filePath: string): Promise<{ resolvedPath: string; base64: string; mime: string; version: { revision: string; mtimeMs: number; size: number; hash: string } }> {
    return await this.request(`/sessions/${encodeURIComponent(sessionId)}/files/read?path=${encodeURIComponent(filePath)}`) as { resolvedPath: string; base64: string; mime: string; version: { revision: string; mtimeMs: number; size: number; hash: string } }
  }

  async getMessages(sessionId: string): Promise<readonly unknown[]> {
    const body = await this.request(`/sessions/${encodeURIComponent(sessionId)}/messages`) as { messages?: readonly unknown[] }
    return body.messages ?? []
  }

  async sendMessage(sessionId: string, prompt: string, options: CoreMessageOptions = {}, assertCurrent: () => void = () => {}): Promise<{ accepted: boolean; sessionId: string }> {
    assertCurrent()
    if (this.hostRequestHandler) {
      this.hostSessionIds.add(sessionId)
      await this.connect()
      assertCurrent()
      await this.hostRegistration
      assertCurrent()
      await this.sendCommand({ type: 'bind_desktop_host', sessionId })
      assertCurrent()
    }
    assertCurrent()
    return this.request(`/sessions/${encodeURIComponent(sessionId)}/messages`, { method: 'POST', body: { ...options, prompt } }) as Promise<{ accepted: boolean; sessionId: string }>
  }

  async generateTitle(input: import('@profer/shared').AgentGenerateTitleInput): Promise<string | null> {
    return await this.sendCommand({ type: 'generate_title', ...input }) as string | null
  }

  async regenerateTitle(sessionId: string): Promise<CoreSession> {
    return await this.sendCommand({ type: 'regenerate_title', sessionId }) as CoreSession
  }

  async getTaskOutput(sessionId: string, taskId: string, options: { block?: boolean; timeoutMs?: number } = {}): Promise<import('@profer/shared').GetTaskOutputResult> {
    return await this.sendCommand({ type: 'get_task_output', sessionId, taskId, ...options }) as import('@profer/shared').GetTaskOutputResult
  }

  async stopTask(sessionId: string, taskId: string, taskType: 'agent' | 'shell'): Promise<void> {
    await this.sendCommand({ type: 'stop_task', sessionId, taskId, taskType })
  }

  async queueMessage(sessionId: string, prompt: string, options: { uuid?: string; rawUserMessage?: string; interrupt?: boolean } = {}): Promise<import('@profer/agent-runtime').AgentRuntimeQueuedInputResult> {
    return await this.sendCommand({ type: 'queue_message', sessionId, prompt, ...options }) as import('@profer/agent-runtime').AgentRuntimeQueuedInputResult
  }

  async stop(sessionId: string): Promise<{ stopped: boolean; sessionId: string }> {
    return this.request(`/sessions/${encodeURIComponent(sessionId)}/stop`, { method: 'POST', timeoutMs: REMOTE_STOP_TIMEOUT_MS }) as Promise<{ stopped: boolean; sessionId: string }>
  }

  addSnapshotListener(listener: (snapshot: CoreRecoverySnapshot) => void): () => void {
    this.snapshotListeners.add(listener)
    if (this.latestSnapshot) listener(this.latestSnapshot)
    return () => this.snapshotListeners.delete(listener)
  }

  addWorkspaceEventListener(listener: () => void): () => void {
    this.workspaceEventListeners.add(listener)
    return () => this.workspaceEventListeners.delete(listener)
  }

  private notifyWorkspaceChanged(): void {
    this.onWorkspaceEvent?.()
    for (const listener of this.workspaceEventListeners) listener()
  }

  addAutomationEventListener(listener: (payload: unknown) => void): () => void {
    this.automationEventListeners.add(listener)
    return () => this.automationEventListeners.delete(listener)
  }

  async refreshSnapshot(): Promise<void> {
    const snapshot = await this.sendCommand({ type: 'core_snapshot' }) as CoreRecoverySnapshot
    this.applySnapshot(snapshot)
  }

  private applySnapshot(snapshot: CoreRecoverySnapshot): void {
    this.latestSnapshot = snapshot
    if (this.hostRequestHandler && this.socket?.readyState === OPEN) {
      this.hostSessionIds.clear()
      for (const session of snapshot.sessions) this.hostSessionIds.add(session.id)
      this.hostRegistration = this.sendOnSocket(this.socket, { type: 'register_desktop_host', sessionIds: [...this.hostSessionIds] })
      void this.hostRegistration.catch(error => console.error('[Core] 会话宿主恢复绑定失败:', error))
    }
    this.onSnapshot?.(snapshot)
    for (const listener of this.snapshotListeners) listener(snapshot)
    for (const tombstone of snapshot.tombstones ?? []) {
      this.deliverFrame({ kind: 'agent_event', sessionId: tombstone.sessionId, recovered: true,
        payload: { kind: 'session_projection', operation: 'delete', ...tombstone } })
    }
    for (const status of snapshot.deletionStatuses ?? []) {
      this.deliverFrame({ kind: 'agent_event', sessionId: status.sessionId, recovered: true, payload: status })
    }
    // Core权威metadata随快照投影，包含断线期间新建的子会话及UI状态。
    for (const session of snapshot.sessions) {
      this.deliverFrame({ kind: 'agent_event', sessionId: session.id, recovered: true,
        payload: { kind: 'session_projection', operation: 'upsert', session: buildAgentSessionUiProjection({ ...session, agentRuntime: session.agentRuntime === 'pi' ? 'pi' : 'claude', permissionMode: session.permissionMode ?? 'auto' } as import('@profer/shared').AgentSessionMeta) } })
    }
    // 连接中断期间可能已落终态；不能仅恢复列表而让原发送Promise永远等待。
    const latestRuns = new Map<string, import('@profer/agent-runtime').AgentRun>()
    const tombstones = new Set((snapshot.tombstones ?? []).map(item => item.sessionId))
    for (const run of snapshot.runs ?? []) {
      if (!run.sessionRef || tombstones.has(run.sessionRef)) continue
      const current = latestRuns.get(run.sessionRef)
      if (!current || run.createdAt >= current.createdAt) latestRuns.set(run.sessionRef, run)
    }
    for (const [sessionId, run] of latestRuns) {
      const terminal = ['completed', 'failed', 'stopped'].includes(run.status)
      const event = terminal
        ? { type: 'run_completed', sessionId, runId: run.id, triggerId: run.triggerId, taskId: run.taskId, outcomeStatus: run.status, startedAt: run.startedAt, stoppedByUser: run.status === 'stopped', resultSubtype: run.status === 'completed' ? 'success' : 'error_during_execution', resultErrors: run.failureReason ? [run.failureReason] : undefined }
        : { type: 'runtime_started', sessionId, runId: run.id, triggerId: run.triggerId, taskId: run.taskId, startedAt: run.startedAt ?? run.createdAt, runtime: run.runtime }
      this.deliverFrame({ kind: 'agent_event', sessionId, recovered: true, payload: { kind: 'profer_event', event } })
    }
  }

  addPlanningEventListener(listener: (payload: unknown) => void): () => void {
    this.planningEventListeners.add(listener)
    return () => this.planningEventListeners.delete(listener)
  }

  addEventListener(listener: (event: CoreAgentEvent) => void): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  connect(): Promise<void> {
    if (this.connecting) return this.connecting
    const connecting = this.connectInternal()
    this.connecting = connecting
    void connecting.finally(() => { if (this.connecting === connecting) this.connecting = undefined }).catch(() => {})
    return connecting
  }

  private connectInternal(): Promise<void> {
    this.closedByUser = false
    const socket = this.socket
    if (socket?.readyState === OPEN) return this.recovery ?? Promise.resolve()
    this.clearReconnectTimer()
    this.onStatus?.('connecting')
    return new Promise((resolve, reject) => {
      const socket = this.webSocketFactory(wsUrlFromHttp(this.baseUrl), {
        protocols: ['profer.v1'],
        headers: { authorization: `Bearer ${this.token}` },
      })
      this.socket = socket
      let settled = false
      socket.onopen = () => {
        if (this.socket !== socket) return
        settled = true
        this.closedByUser = false
        if (this.hostRequestHandler) {
          this.hostRegistration = this.sendOnSocket(socket, { type: 'register_desktop_host', sessionIds: [...this.hostSessionIds] })
          void this.hostRegistration.catch(error => console.error('[Core] 桌面宿主重连注册失败:', error))
        }
        if (this.recoverEvents) {
          this.bufferedEvents = []
          this.recovery = this.recover(socket).finally(() => { this.recovery = undefined })
          this.recovery.then(() => { if (this.socket === socket) this.onStatus?.('open'); resolve() }, error => { reject(error); if (this.socket === socket) socket.close() })
        } else {
          this.onStatus?.('open')
          resolve()
        }
      }
      socket.onmessage = event => { if (this.socket === socket) this.handleMessage(event.data) }
      socket.onerror = error => {
        if (this.socket !== socket) return
        this.onStatus?.('error')
        if (!settled) { settled = true; reject(new CoreClientError(`Core WebSocket 连接失败: ${String(error)}`)) }
      }
      socket.onclose = () => {
        if (this.socket !== socket) return
        this.socket = null
        this.hostRegistration = undefined
        this.bufferedEvents = undefined
        for (const pending of this.pendingCommands.values()) {
          clearTimeout(pending.timer)
          pending.reject(new CoreClientError('Core连接中断，操作结果需从目标Core重新查询'))
        }
        this.pendingCommands.clear()
        this.onStatus?.('closed')
        if (!settled) { settled = true; reject(new CoreClientError('Core WebSocket 在建立连接前关闭')) }
        this.scheduleReconnect()
      }
    })
  }

  close(): void {
    this.closedByUser = true
    this.clearReconnectTimer()
    const socket = this.socket
    this.socket = null
    socket?.close()
    for (const pending of this.pendingCommands.values()) {
      clearTimeout(pending.timer)
      pending.reject(new CoreClientError('远程 Core 连接已关闭'))
    }
    this.pendingCommands.clear()
    this.onStatus?.('closed')
  }

  private async request(pathname: string, options: { method?: string; body?: unknown; auth?: boolean; timeoutMs?: number } = {}): Promise<unknown> {
    const response = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
      method: options.method ?? 'GET',
      headers: {
        ...(options.auth === false ? {} : { authorization: `Bearer ${this.token}` }),
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      ...(options.timeoutMs ? { signal: createRemoteStopTimeoutSignal(options.timeoutMs) } : {}),
    })
    const body = parseResponseBody(await response.text())
    if (!response.ok) {
      const record = body && typeof body === 'object' ? body as Record<string, unknown> : undefined
      throw new CoreClientError(typeof record?.error === 'string' ? record.error : `Core 请求失败 (${response.status})`, {
        status: response.status,
        code: typeof record?.code === 'string' ? record.code : undefined,
      })
    }
    return body
  }

  private async recover(socket: CoreWebSocket): Promise<void> {
    const result = await this.sendOnSocket(socket, { type: 'resume_agent_events', cursor: this.eventCursor }) as CoreRecoveryResult
    if (this.socket !== socket) throw new CoreClientError('恢复过程中Core连接已变化')
    if (result.requiresSnapshot) {
      if (!result.snapshot) throw new CoreClientError('Core恢复缺少权威快照')
      this.applySnapshot(result.snapshot)
      this.eventCursor = result.snapshot.cursor
    }
    const buffered = this.bufferedEvents ?? []
    this.bufferedEvents = undefined
    // 实时帧可能先于补发帧到达，按同一epoch的序号排序再去重，不能先推进到较新游标。
    buffered.sort((a, b) => {
      const left = typeof a.eventId === 'string' ? Number(a.eventId.slice(a.eventId.lastIndexOf(':') + 1)) : 0
      const right = typeof b.eventId === 'string' ? Number(b.eventId.slice(b.eventId.lastIndexOf(':') + 1)) : 0
      return left - right
    })
    for (const frame of buffered) this.deliverFrame(frame)
    if (!this.eventCursor) this.eventCursor = result.latestEventId
    // 快照或重放均可能覆盖离线期间的工作区修改；统一从所属 Core 重新读取。
    this.notifyWorkspaceChanged()
  }

  private handleMessage(raw: unknown): void {
    let message: unknown
    try { message = JSON.parse(typeof raw === 'string' ? raw : String(raw)) as unknown } catch { return }
    if (!message || typeof message !== 'object') return
    const record = message as Record<string, unknown>
    if (record.kind === 'host_request') {
      const request = record.request as CoreHostIncomingRequest | undefined
      const socket = this.socket
      if (!request || !socket || socket.readyState !== OPEN || !this.hostRequestHandler) return
      void this.hostRequestHandler(request).then(response => {
        if (this.socket === socket && socket.readyState === OPEN) socket.send(JSON.stringify({ type: 'desktop_host_response', response }))
      }).catch(error => {
        if (this.socket === socket && socket.readyState === OPEN) socket.send(JSON.stringify({ type: 'desktop_host_response', response: {
          coreId: request.coreId, sessionId: request.sessionId, runId: request.runId, requestId: request.requestId,
          ok: false, error: error instanceof Error ? error.message : String(error),
        } }))
      })
      return
    }
    if (record.kind !== 'command_result' && this.bufferedEvents) {
      this.bufferedEvents.push(record)
      return
    }
    this.deliverFrame(record)
  }

  private deliverFrame(record: Record<string, unknown>): void {
    if (typeof record.eventId === 'string') {
      const split = record.eventId.lastIndexOf(':'), oldSplit = this.eventCursor?.lastIndexOf(':') ?? -1
      if (this.eventCursor && record.eventId.slice(0, split) === this.eventCursor.slice(0, oldSplit)
        && Number(record.eventId.slice(split + 1)) <= Number(this.eventCursor.slice(oldSplit + 1))) return
      this.eventCursor = record.eventId
    }
    if (record.kind === 'chat_event' && typeof record.conversationId === 'string' && typeof record.channel === 'string') {
      // Core事件只可转发既有Chat流通道，不能借channel字段调用任意桌面IPC事件。
      if (!record.channel.startsWith('chat:stream:') || !(Object.values(CHAT_IPC_CHANNELS) as string[]).includes(record.channel)) return
      const event = record as unknown as CoreChatEvent
      this.onChatEvent?.(event)
      for (const listener of this.chatEventListeners) listener(event)
      return
    }
    if (record.kind === 'workspace_event') {
      this.notifyWorkspaceChanged()
      return
    }
    if (record.kind === 'automation_event') {
      this.onAutomationEvent?.(record.payload)
      for (const listener of this.automationEventListeners) listener(record.payload)
      return
    }
    if (record.kind === 'planning_event') {
      this.onPlanningEvent?.(record.payload)
      for (const listener of this.planningEventListeners) listener(record.payload)
      return
    }
    if (record.kind === 'command_result') {
      const commandId = typeof record.commandId === 'string' ? record.commandId : typeof record.requestId === 'string' ? record.requestId : ''
      const pending = this.pendingCommands.get(commandId)
      if (pending) {
        clearTimeout(pending.timer)
        this.pendingCommands.delete(commandId)
        if (record.ok === true) pending.resolve(record.data)
        else pending.reject(new CoreClientError(typeof record.error === 'string' ? record.error : '远程 Core 命令失败'))
      }
      return
    }
    if (record.kind === 'agent_event' && typeof record.sessionId === 'string') {
      const event = record as CoreAgentEvent
      this.onEvent?.(event)
      for (const listener of this.eventListeners) listener(event)
    }
  }

  private scheduleReconnect(): void {
    if (!this.reconnect || this.closedByUser || this.reconnectTimer !== undefined) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      void this.connect().catch(() => this.scheduleReconnect())
    }, this.reconnectDelayMs)
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer === undefined) return
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
  }
}
