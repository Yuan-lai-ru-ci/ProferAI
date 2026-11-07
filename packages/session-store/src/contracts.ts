import type { AgentMessage, AgentRuntime, AgentSessionMeta, SDKMessage } from '@profer/shared'

export interface AgentSessionsIndex {
  version: number
  sessions: AgentSessionMeta[]
}

export interface SessionStorePaths {
  configDir: string
  sessionsIndex: string
  sessionsDir: string
  blobsDir: string
  graphDir: string
  harnessDir: string
  checkpointsDir: string
  rewindDir: string
  sdkConfigDir?: string
  workspaceRoot?: string
}

export interface SessionMessagePage {
  messages: SDKMessage[]
  total: number
  startIndex: number
  endIndex: number
  hasMore: boolean
}

export interface SyncSessionIndexStore {
  read(): AgentSessionsIndex
  write(index: AgentSessionsIndex): void
  list(includeArchived?: boolean): AgentSessionMeta[]
  countArchived(): number
  get(sessionId: string): AgentSessionMeta | undefined
}

export interface SessionIndexStore {
  read(): Promise<AgentSessionsIndex>
  write(index: AgentSessionsIndex): Promise<void>
  list(includeArchived?: boolean): Promise<AgentSessionMeta[]>
  countArchived(): Promise<number>
  get(sessionId: string): Promise<AgentSessionMeta | undefined>
}

export interface SyncSessionMessageStoreOptions {
  serializeMessage?: (sessionId: string, message: SDKMessage) => string
  parseMessage?: (sessionId: string, line: string) => SDKMessage | undefined
}

export interface SyncSessionMessageStore {
  append(sessionId: string, messages: readonly SDKMessage[]): void
  read(sessionId: string): SDKMessage[]
  readPage(sessionId: string, options: { tail?: number; before?: number }): SessionMessagePage
  replace(sessionId: string, messages: readonly SDKMessage[]): void
  clear(sessionId: string): void
}

export interface SessionMessageStore {
  append(sessionId: string, messages: readonly SDKMessage[]): Promise<void>
  read(sessionId: string): Promise<SDKMessage[]>
  readPage(sessionId: string, options: { tail?: number; before?: number }): Promise<SessionMessagePage>
  replace(sessionId: string, messages: readonly SDKMessage[]): Promise<void>
  clear(sessionId: string): Promise<void>
}

export interface SessionMetadataStore {
  create(input: {
    title: string
    channelId?: string
    workspaceId?: string
    modelId?: string
    agentRuntime?: AgentRuntime
    draft?: boolean
  }): Promise<AgentSessionMeta>
  update(sessionId: string, patch: Partial<AgentSessionMeta>): Promise<AgentSessionMeta>
  restore(meta: AgentSessionMeta): Promise<AgentSessionMeta>
  remove(sessionId: string): Promise<AgentSessionMeta | undefined>
}

export interface SessionFileStore {
  remove(sessionId: string): Promise<void>
  copy(sourceSessionId: string, destinationSessionId: string, options?: {
    upToMessageUuid?: string
    transformMessage?: (message: SDKMessage) => SDKMessage
    serializeMessage?: (message: SDKMessage) => string
    onProgress?: (completed: number) => void
  }): Promise<number>
}

export type SessionOperationPhase =
  | 'stopping'
  | 'reading'
  | 'copying'
  | 'rewriting'
  | 'persisting'
  | 'cleaning'
  | 'completed'
  | 'failed'

export interface SessionOperationProgress {
  operationId: string
  operation: 'delete' | 'fork' | 'rewind'
  sessionId: string
  phase: SessionOperationPhase
  completed?: number
  total?: number
  detail?: string
}

export interface SessionOperationContext {
  operationId: string
  onProgress?: (progress: SessionOperationProgress) => void
}

export interface SessionOperationHost {
  getDeletionOrder(sessionId: string): Promise<string[]>
  stopAndWait(sessionId: string): Promise<void>
  clearRuntimeState?(sessionId: string): Promise<void> | void
  getArtifactAdapter?(meta: AgentSessionMeta): NativeSessionArtifactAdapter | undefined
}

export interface DeleteSessionInput extends SessionOperationContext {
  sessionId: string
  cascade?: boolean
}

export interface ForkSessionInput extends SessionOperationContext {
  sessionId: string
  upToMessageUuid?: string
  titleSuffix?: string
  transformMessage?: (message: SDKMessage) => SDKMessage
}

export interface RewindSessionInput extends SessionOperationContext {
  sessionId: string
  assistantMessageUuid?: string
}

export interface SessionOperationService {
  delete(input: DeleteSessionInput): Promise<{ deletedSessionIds: string[] }>
  fork(input: ForkSessionInput): Promise<AgentSessionMeta>
  rewind(input: RewindSessionInput): Promise<{ remainingMessages: number }>
}

export interface NativeSessionArtifactAdapter {
  readonly runtime: AgentRuntime
  fork(input: {
    sessionId: string
    upToMessageUuid?: string
    destinationSessionId: string
    sourceMeta: AgentSessionMeta
    destinationMeta: AgentSessionMeta
  }): Promise<{ nativeSessionId?: string; nativeSessionFile?: string }>
  rewind?(input: {
    sessionId: string
    assistantMessageUuid?: string
    meta: AgentSessionMeta
  }): Promise<{ remainingNativeEntries?: number }>
  removeOwnedArtifact?(meta: AgentSessionMeta): Promise<void>
}

export interface SessionStore {
  paths: SessionStorePaths
  index: SessionIndexStore
  metadata: SessionMetadataStore
  messages: SessionMessageStore
  files: SessionFileStore
  getAgentMessages?(sessionId: string): Promise<AgentMessage[]>
}

export interface SessionOperationErrorOptions {
  cause?: unknown
  operation?: string
  sessionId?: string
}

export class SessionOperationError extends Error {
  readonly code: string
  readonly operation?: string
  readonly sessionId?: string

  constructor(code: string, message: string, options: SessionOperationErrorOptions = {}) {
    super(message, { cause: options.cause })
    this.name = 'SessionOperationError'
    this.code = code
    this.operation = options.operation
    this.sessionId = options.sessionId
  }
}
