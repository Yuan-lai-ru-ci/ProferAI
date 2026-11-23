/** 本机运行状态与设备共享状态，供设置页使用。 */
export interface LocalCoreState {
  status: 'starting' | 'running' | 'stopped' | 'failed'
  error?: string
}

export interface CoreBindingSummary {
  id: string
  name: string
  createdAt: number
  expiresAt?: number
}

export interface CoreConnectionState {
  local: LocalCoreState
  sharing: boolean
  coreId?: string
  name?: string
  endpoints: string[]
  bindings: CoreBindingSummary[]
}

export interface CoreInvitationResult {
  url: string
  expiresAt: number
}

export const CORE_CONNECTION_IPC_CHANNELS = {
  STATE: 'core-connection:state',
  RETRY_LOCAL: 'core-connection:retry-local',
  SET_SHARING: 'core-connection:set-sharing',
  INVITE: 'core-connection:invite',
  PAIR: 'core-connection:pair',
  PAIR_AND_SELECT: 'core-connection:pair-and-select',
  REVOKE: 'core-connection:revoke',
} as const
