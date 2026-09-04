/** Lark/飞书用户云端能力相关类型。仅包含可安全展示的状态，不包含 token/secret。 */

export type LarkAuthState = 'unknown' | 'logged_out' | 'logged_in' | 'reauthorization_required'

export interface LarkCliStatus {
  node: { available: boolean; version: string | null; path: string | null }
  npm: { available: boolean; version: string | null; path: string | null }
  npx: { available: boolean; version: string | null; path: string | null }
  cli: { available: boolean; version: string | null; path: string | null }
  auth: {
    state: LarkAuthState
    userLabel: string | null
    scopeCount: number | null
    checkedAt: number | null
  }
  checkedAt: number
  error: string | null
}

export interface LarkLoginStartResult {
  started: boolean
  authorizationUrl: string | null
  message: string
}

export interface LarkCliOperationResult {
  success: boolean
  message: string
}

export interface LarkDiagnostics {
  nodeVersion: string | null
  npmVersion: string | null
  npxVersion: string | null
  cliVersion: string | null
  cliPath: string | null
  authState: LarkAuthState
  userLabel: string | null
  scopeCount: number | null
  checkedAt: number
  error: string | null
}

export interface LarkMcpCredentialsInput {
  appId: string
  appSecret: string
}

/** Safe MCP credential summary. The app secret never leaves the main process. */
export interface LarkMcpStatus {
  configured: boolean
  appId: string | null
  configuredAt: number | null
  enabledWorkspaces: string[]
}

export interface LarkMcpSetupResult {
  success: boolean
  message: string
  workspaceSlug?: string
}

export const LARK_IPC_CHANNELS = {
  GET_STATUS: 'lark:get-status',
  GET_MCP_STATUS: 'lark:get-mcp-status',
  SAVE_MCP_CREDENTIALS: 'lark:save-mcp-credentials',
  ENABLE_MCP_FOR_WORKSPACE: 'lark:enable-mcp-for-workspace',
  DISABLE_MCP_FOR_WORKSPACE: 'lark:disable-mcp-for-workspace',
  START_MCP_LOGIN: 'lark:start-mcp-login',
  CANCEL_MCP_LOGIN: 'lark:cancel-mcp-login',
  TEST_MCP_CONNECTION: 'lark:test-mcp-connection',
  MCP_LOGIN_EVENT: 'lark:mcp-login-event',
  REFRESH_STATUS: 'lark:refresh-status',
  INSTALL_CLI: 'lark:install-cli',
  START_LOGIN: 'lark:start-login',
  CANCEL_LOGIN: 'lark:cancel-login',
  LOGIN_EVENT: 'lark:login-event',
} as const

export interface LarkLoginEvent {
  type: 'url' | 'completed' | 'failed'
  authorizationUrl?: string
  message: string
}
