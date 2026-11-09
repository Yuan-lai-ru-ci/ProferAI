import type {
  AgentMessage,
  AgentSessionMeta,
  AgentRuntime,
  CodexOAuthCredentials,
  ProviderType,
  ProferEvent,
  SDKMessage,
  XaiOAuthCredentials,
  XaiApiProtocol,
  WorkspaceMcpConfig,
  AskUserRequest,
  ExitPlanModeRequest,
  AgentFilePreviewInspectRequest,
  AgentFilePreviewInspectResult,
  AgentFilePreviewReport,
  ProferPermissionMode,
} from '@profer/shared'

export interface RuntimeCredential {
  apiKey: string
  baseUrl: string | undefined
  provider: ProviderType
  forceBearerAuth: boolean
  codexOAuthCredentials?: CodexOAuthCredentials
  xaiOAuthCredentials?: XaiOAuthCredentials
  xaiCredentialMode?: 'api-key' | 'oauth'
  /** xAI API Key 渠道的请求协议；缺失时按 responses 处理。 */
  xaiApiProtocol?: XaiApiProtocol
}

export type RuntimeCredentialResult =
  | { ok: true; credentials: RuntimeCredential }
  | { ok: false; code: 'token_expired' | 'api_key_decrypt_failed' }

/** 同步会话快照接口；运行时消息另走非阻塞 enqueue，不等待磁盘写入。 */
export interface SessionPort {
  getMeta(sessionId: string): AgentSessionMeta | undefined
  appendMessages(sessionId: string, messages: readonly SDKMessage[]): undefined
  enqueueMessages?(sessionId: string, messages: readonly SDKMessage[]): void
  updateMeta(sessionId: string, patch: Partial<AgentSessionMeta>): undefined
  getMessages?(sessionId: string): readonly SDKMessage[]
  getAgentMessages?(sessionId: string): readonly AgentMessage[]
  appendAgentMessages?(sessionId: string, messages: readonly AgentMessage[]): undefined
  lockRuntime?(sessionId: string, runtime: AgentRuntime): AgentSessionMeta
}

export interface CredentialResolutionInput {
  sessionId: string
  runtime: AgentRuntime
  channelId?: string
  modelId?: string
}

export interface CredentialPort {
  resolve(input: CredentialResolutionInput): Promise<RuntimeCredentialResult>
}

export type PermissionDecision = 'allow' | 'deny' | 'ask'

export interface ToolPermissionInput {
  sessionId: string
  toolName: string
  input: unknown
  signal?: AbortSignal
}

export type RuntimePermissionBehavior = 'allow' | 'deny' | 'ask'

export type RuntimePermissionDecisionClassification = 'user_temporary' | 'user_permanent' | 'user_reject'

export type RuntimePermissionUpdateDestination = 'userSettings' | 'projectSettings' | 'localSettings' | 'session' | 'cliArg'

export interface RuntimePermissionRuleValue {
  toolName: string
  ruleContent?: string
}

export type RuntimePermissionUpdate =
  | {
      type: 'addRules' | 'replaceRules' | 'removeRules'
      rules: RuntimePermissionRuleValue[]
      behavior: RuntimePermissionBehavior
      destination: RuntimePermissionUpdateDestination
    }
  | {
      type: 'setMode'
      mode: string
      destination: RuntimePermissionUpdateDestination
    }
  | {
      type: 'addDirectories' | 'removeDirectories'
      directories: string[]
      destination: RuntimePermissionUpdateDestination
    }

export interface RuntimePermissionResultMetadata {
  updatedPermissions?: RuntimePermissionUpdate[]
  toolUseID?: string
  decisionClassification?: RuntimePermissionDecisionClassification
}

export type RuntimePermissionResult =
  | ({
      behavior: 'allow'
      updatedInput?: Record<string, unknown>
      targetMode?: ProferPermissionMode
    } & RuntimePermissionResultMetadata)
  | ({
      behavior: 'deny'
      message: string
      interrupt?: boolean
    } & RuntimePermissionResultMetadata)

export interface RuntimeCanUseToolOptions {
  signal: AbortSignal
  suggestions?: RuntimePermissionUpdate[]
  blockedPath?: string
  decisionReason?: string
  decisionReasonType?: string
  classifierApprovable?: boolean
  toolUseID?: string
  agentID?: string
  title?: string
  displayName?: string
  description?: string
  /** Provider transport correlation, optional because Pi does not expose it. */
  requestId?: string
}

export type RuntimeCanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: RuntimeCanUseToolOptions,
) => Promise<RuntimePermissionResult>

export interface PermissionPort {
  canUseTool?(input: ToolPermissionInput): Promise<PermissionDecision> | PermissionDecision
  createCanUseTool?(input: {
    sessionId: string
    sendPermissionRequest: (request: import('@profer/shared').PermissionRequest) => void
    handleAskUser?: (sessionId: string, toolInput: Record<string, unknown>, signal: AbortSignal, sendAskUser: (request: AskUserRequest) => void) => Promise<RuntimePermissionResult>
    sendAskUserRequest?: (request: AskUserRequest) => void
  }): RuntimeCanUseTool
  handleAskUserQuestion?(input: {
    sessionId: string
    toolInput: Record<string, unknown>
    signal: AbortSignal
    sendToRenderer: (request: AskUserRequest) => void
  }): Promise<RuntimePermissionResult>
  handleExitPlanMode?(input: {
    sessionId: string
    toolInput: Record<string, unknown>
    signal: AbortSignal
    sendToRenderer: (request: ExitPlanModeRequest) => void
  }): Promise<RuntimePermissionResult>
  clearSessionPending?(sessionId: string): void
  clearSessionWhitelist?(sessionId: string): void
  setPermissionMode?(sessionId: string, mode: ProferPermissionMode): void
  askUser?(input: unknown): Promise<unknown>
  exitPlan?(input: unknown): Promise<unknown>
}

export interface PreviewPort {
  open(event: Extract<ProferEvent, { type: 'preview_requested' }>): Promise<AgentFilePreviewReport>
  inspect(request: AgentFilePreviewInspectRequest): Promise<AgentFilePreviewInspectResult>
}

export interface ToolAssemblyInput {
  sdk: unknown
  context: unknown
}

export interface ToolAssemblyPort {
  build(input: ToolAssemblyInput): Promise<{ tools: readonly unknown[]; collaborationAvailable?: boolean }>
}

export interface ToolExecutionInput {
  sessionId: string
  toolName: string
  input: unknown
  signal?: AbortSignal
}

export interface ToolExecutionResult {
  output: string
  isError?: boolean
  metadata?: Readonly<Record<string, unknown>>
}

export interface ToolPort {
  execute(input: ToolExecutionInput): Promise<ToolExecutionResult>
  list?(): Promise<readonly string[]> | readonly string[]
}

export interface ResourceRequest {
  sessionId: string
  workspaceId?: string
  workspaceSlug?: string
  cwd?: string
  mentionedSkills?: readonly string[]
  mentionedMcpServers?: readonly string[]
}

export interface RuntimeResources {
  systemPrompt?: string
  skills?: readonly string[]
  mcpResources?: readonly unknown[]
  projectInstructions?: readonly string[]
  /**
   * Skill 目录（`<skill_catalog>` 段）。
   *
   * Pi 没有 SDK 侧 Skill 发现，catalog 必须由宿主提供；Claude 由 SDK 自己发现，宿主不填。
   */
  skillCatalog?: string
}

export interface ResourcePort {
  load(input: ResourceRequest): Promise<RuntimeResources> | RuntimeResources
  getMcpConfig?(input: { sessionId: string; workspaceSlug: string }): WorkspaceMcpConfig
}

export interface ProcessHandle {
  id: string
  wait(): Promise<{ exitCode: number | null; signal?: string }>
  kill?(signal?: string): Promise<void> | void
}

export interface ProcessLifecyclePort {
  onSpawn?(sessionId: string, pid: number, runtime: 'pi' | 'claude'): void
  onTaskEvent?(sessionId: string, event: { taskId: string; type?: 'agent' | 'shell'; status: 'running' | 'completed' | 'failed' | 'stopped'; summary?: string; outputFile?: string }): void
  getTaskOutput?(sessionId: string, taskId: string, options?: { block?: boolean; timeoutMs?: number }): Promise<import('@profer/shared').GetTaskOutputResult>
  /** 先校验任务归属和类型，再执行 providerStop；成功后才记录 stopped。 */
  stopTask?(sessionId: string, taskId: string, expectedType?: 'agent' | 'shell', providerStop?: () => Promise<void>): Promise<void>
  onExit?(sessionId: string): void
}
export interface ProcessRegistrationInput {
  sessionId: string
  command: string
  cwd: string
  launcher: 'bash' | 'powershell' | 'wsl'
}

export interface ProcessRegistrationShellInput extends ProcessRegistrationInput {
  pid: number
}

export interface RuntimeProcessRegistration {
  id: string
  startTime?: number
}

/** 宿主持有 registry/PID 校验；runtime 只请求登记，不读取或终止进程。 */
export interface ProcessRegistrationPort {
  registerPending(input: ProcessRegistrationInput): RuntimeProcessRegistration | undefined
  registerShell(input: ProcessRegistrationShellInput): RuntimeProcessRegistration | undefined
}


export interface ProcessPort {
  spawn(command: string, args: readonly string[], options?: {
    cwd?: string
    env?: Readonly<Record<string, string | undefined>>
    signal?: AbortSignal
  }): Promise<ProcessHandle>
  exec?(command: string, options?: {
    cwd?: string
    env?: Readonly<Record<string, string | undefined>>
    signal?: AbortSignal
  }): Promise<{ stdout: string; stderr: string; exitCode: number | null }>
}

export interface FilePort {
  read(path: string): Promise<Uint8Array> | Uint8Array
  write(path: string, data: Uint8Array | string): Promise<void> | void
  copy?(from: string, to: string): Promise<void> | void
  remove?(path: string): Promise<void> | void
}

/** 宿主解析后的 shell 环境；runtime 不读取配置路径或系统设置。 */
export interface CommandRuntimeEnvironment {
  env: Record<string, string>
  shellKind?: 'posix' | 'git-bash' | 'wsl'
  shellPath?: string
  wslCommand?: string
  wslDistro?: string
}

export interface CommandExecutionCallbacks {
  onStdout?: (data: Buffer) => void
  onStderr?: (data: Buffer) => void
  onSpawn?: (pid: number) => void
}

export interface CommandExecutionRequest {
  sessionId: string
  command: string
  cwd: string
  shell: string
  runtime?: 'pi' | 'claude'
  launcher?: 'bash' | 'powershell' | 'wsl' | 'claude'
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  signal?: AbortSignal
  maxOutputBytes?: number
  handleId?: string
  runtimeEnv?: CommandRuntimeEnvironment
  callbacks?: CommandExecutionCallbacks
}

export interface CommandExecutionResult {
  stdout: string
  stderr: string
  exitCode: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
  aborted: boolean
  durationMs: number
  shell: string
  cwd: string
  truncated: boolean
  errorKind?: 'shell_not_found' | 'working_directory_error' | 'spawn_error'
  errorCode?: string
}

export interface CommandExecutionPort {
  execute(request: CommandExecutionRequest): Promise<CommandExecutionResult>
  cancel(handleId: string): Promise<void>
  get(handleId: string): unknown
}

export interface BackgroundTaskPort {
  begin(sessionId: string, taskId: string, command: string): void
  append(sessionId: string, taskId: string, chunk: Buffer | string): void
  attachProcess(sessionId: string, taskId: string, pid: number, startTime?: number): void
  complete(sessionId: string, taskId: string, status: 'completed' | 'failed' | 'stopped', summary?: string): void
  getOutput(sessionId: string, taskId: string, options?: { block?: boolean; timeoutMs?: number }): Promise<import('@profer/shared').GetTaskOutputResult>
  stop(sessionId: string, taskId: string): Promise<void>
}

export interface EventPort {
  emit(sessionId: string, payload: import('@profer/shared').AgentStreamPayload): void
}

export interface RuntimeHostPort {
  emit(event: import('./events').AgentRuntimeEvent): void | Promise<void>
  emitProferEvent?(event: ProferEvent): void | Promise<void>
  isStopping?(sessionId: string): boolean
  now?(): number
}
