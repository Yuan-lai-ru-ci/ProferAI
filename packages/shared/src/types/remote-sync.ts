/** 双端 Remote Store / WS 协议的共享类型。 */

export type RemoteConnectionPhase =
  | 'disconnected'
  | 'connecting'
  | 'snapshot_loading'
  | 'replaying'
  | 'live'

export interface CommandConflict {
  code: 'REVISION_CONFLICT'
  expectedRevision: number
  actualRevision: number
  sessionId: string
}

export type CommandResult<T = unknown> =
  | { ok: true; commandId: string; data: T }
  | { ok: false; commandId: string; error: string; conflict?: CommandConflict }

export interface RemoteCommandEnvelope {
  type: string
  commandId: string
  expectedRevision?: number
  [key: string]: unknown
}

export interface RemoteHelloFrame {
  kind: 'hello'
  serverTime: number
  serverInstanceId: string
  latestAgentEventId?: number | null
  oldestAgentEventId?: number | null
}

export interface RemoteResumeFrame {
  kind: 'agent_events_resumed'
  requestId: string | null
  fromEventId: number | null
  toEventId: number | null
  replayed: number
  complete: boolean
  requiresSnapshot: boolean
  oldestEventId: number | null
  latestEventId: number | null
}

export interface RemoteCommandPending {
  commandId: string
  expectedRevision?: number
}

export interface RemoteCommandState extends RemoteCommandPending {
  status: 'pending' | 'succeeded' | 'failed'
  error?: string
}
