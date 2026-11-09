import type {
  AgentEvent,
  AgentMessage,
  AgentRuntime,
  AgentRuntimeCapabilities,
  AgentSessionMeta,
  AgentSendInput,
  AgentRunInitiator,
  AgentStreamPayload,
  SDKMessage,
  TypedError,
} from '@profer/shared'
import type { AgentRuntimeEvent, AgentRunOutcome } from './events'
import type { AgentRunContext } from './run-context'
import type { TaskTrigger } from './run-ledger'
import type {
  RuntimeCredential,
  RuntimeResources,
  RuntimeCanUseTool,
  RuntimeHostPort,
  SessionPort,
  ToolPort,
  CredentialPort,
  FilePort,
  PermissionPort,
  ProcessPort,
  ResourcePort,
} from './ports'

export type RuntimeSystemPrompt = string | { type: 'preset'; preset: 'claude_code'; append?: string }

export interface AgentRuntimePreparedContext {
  systemPrompt?: RuntimeSystemPrompt
  /**
   * 本轮交给 provider 的最终 prompt（已含动态上下文 / 引用 / 任务 SOP / 历史回填）。
   *
   * 为什么在 prepared 阶段而不是 query 构造时定：这些块依赖 `resources`（实际加载的 MCP 名单）
   * 与「本轮消息是否已落盘」，两者都只在准备阶段才成立。宿主写在这里，`provider-bridge`
   * 是唯一把它转成 provider 输入的地方。
   */
  prompt?: string
  credentials?: RuntimeCredential
  resources?: RuntimeResources
  canUseTool?: RuntimeCanUseTool
  tools?: readonly unknown[]
  collaborationAvailable?: boolean
  /** Provider SDK 就绪后由 adapter 延迟执行的宿主工具装配；runtime 不持有 SDK。 */
  deferredToolAssembly?: {
    build(sdk: unknown): Promise<{ tools: readonly unknown[]; collaborationAvailable?: boolean }>
  }
  mcpServers?: Record<string, unknown>
  plugins?: readonly { type: 'local'; path: string }[]
  skills?: readonly string[]
  allowedTools?: readonly string[]
  disallowedTools?: readonly string[]
}

export interface AgentRuntimeQueryPreparationPort {
  prepare(input: AgentRuntimeQuery, signal: AbortSignal): Promise<AgentRuntimePreparedContext>
}

export interface AgentRuntimeProviderQueryPreparationPort {
  prepare(
    input: AgentRuntimeQuery,
    prepared: AgentRuntimePreparedContext,
    signal: AbortSignal,
  ): Promise<Readonly<Record<string, unknown>>>
}


export interface AgentRuntimeQuery {
  sessionId: string
  /** 业务 Run 身份，与 ownershipToken、Provider 会话或进程身份无关。 */
  runId?: string
  taskId?: string
  trigger?: TaskTrigger
  /** 由受信宿主入口解析的来源上下文；runtime 不从 Provider role 或正文推断身份。 */
  context?: AgentRunContext & { executorRef?: string }
  prompt: string
  runtime: AgentRuntime
  modelId?: string
  title?: string
  workspaceId?: string
  initiator?: AgentRunInitiator
  channelId?: string
  cwd?: string
  additionalDirectories?: readonly string[]
  runtimeSessionId?: string
  isolatedRuntimeSession?: boolean
  abortSignal?: AbortSignal
  metadata?: Readonly<Record<string, unknown>>
  /** 宿主为 shared provider 提供的 provider-specific options；runtime 不解释其内部字段。 */
  providerInput?: Readonly<Record<string, unknown>>
  toolAssemblyContext?: import('./ports').ToolAssemblyInput
  /** 延迟到 provider adapter 拿到 SDK 后再装配宿主工具的 opaque context。 */
  deferredToolAssemblyContext?: unknown
  prepared?: AgentRuntimePreparedContext
  /** Ledger 准入后的宿主回写；先于资源加载，不创建或猜测 Run 身份。 */
  onRunAdmitted?(input: AgentRuntimeQuery & { runId: string }): void | Promise<void>
  /** 仅真实宿主权限请求与其完成回调调用；不按工具名称或等待时长推断。 */
  runLifecycle?: {
    wait(requestId: string): void
    resume(requestId: string): void
  }
  /** 可选的宿主已构造输入；准备成功后、provider 启动前按真实作者标记并落盘一次。 */
  persistedUserMessage?: SDKMessage
  /**
   * 上层入口已经持有的执行权 token（嵌套入口用，例如 runAgentHeadless 委派到 runtime 入口）。
   * 与当前 owner 的 token 相同时 coordinator 视为同一次请求，不重复 claim、不改 owner；
   * 不传则由 coordinator 自己生成 token。
   */
  ownershipToken?: import('./run-ownership').AgentRunOwnershipToken
}

/** 可选 ledger 关联；未注入 ledger 时回调保持原有形状。 */
export interface AgentRuntimeRunReference {
  runId?: string
  taskId?: string
  triggerId?: string
}

export interface AgentRuntimeQueuedInput {
  sessionId: string
  ownershipToken?: import('./run-ownership').AgentRunOwnershipToken
  context: AgentRunContext
  /** 对话中持久化的原始输入；Provider prompt 可由 receive 闭包自行装配。 */
  message: SDKMessage
  /** resolve 表示 Provider 已接收；拒绝或 settled 必须 reject，不能转为新 Run。 */
  receive(input: AgentRuntimeRunReference & { message: SDKMessage; isCurrent(): boolean }): Promise<void>
}

export interface AgentRuntimeQueuedInputResult extends AgentRuntimeRunReference {
  messageId: string
}

/** Runtime 执行过程中可观察的回调；回调不携带窗口对象或渲染层对象。 */
export interface AgentRuntimeCallbacks {
  onEvent(event: AgentRuntimeEvent): void | Promise<void>
  onRunStarted?(input: { startedAt: number } & AgentRuntimeRunReference): void | Promise<void>
  onMessage?(message: SDKMessage): void | Promise<void>
  onError?(error: unknown): void | Promise<void>
  onComplete?(outcome: AgentRunOutcome & AgentRuntimeRunReference): void | Promise<void>
  /**
   * 准备阶段失败（provider 未启动）的结构化通知：凭证解析 / 资源加载 / 工具装配 / 权限宿主缺失。
   *
   * 与 `onError` 的分工：`onError` 只报「运行阶段」的错误（provider 已经参与）；
   * 准备失败在 provider 之前发生，宿主需要它的结构化失败码才能把 runtime 的
   * `Credential resolution failed: token_expired` 翻译成产品文案。
   * 终态仍由 `onComplete` 统一给出（本回调不产生终态，也不替代 onComplete）。
   */
  onPreparationFailure?(failure: import('./query-preparation').AgentRuntimePreparationFailure): void | Promise<void>
  /**
   * provider 的「轻量完成」信号：本轮 turn 主体已结束，但仍有后台任务在飞。
   *
   * **不是终态**：本回调不结束 run、不释放执行权，也不替代 `onComplete`。宿主据此把 UI 置为
   * 「空闲可输入」（`run_completed{backgroundTasksPending:true}`），同时保留 provider 通道；
   * 后台任务完成后的续轮消息会让 coordinator 发 `run_resumed`，UI 从空闲态恢复运行态。
   * 与旧编排层 `idleComplete` 语义一致。
   */
  onBackgroundTasksPending?(signal: {
    startedAt?: number
    resultSubtype?: string
    resultErrors?: readonly string[]
  }): void | Promise<void>
}

export interface AgentRuntimeAdapter {
  readonly runtime: AgentRuntime
  query(input: AgentRuntimeQuery, callbacks: AgentRuntimeCallbacks): Promise<AgentRunOutcome>
  /** 可选的真实 provider async iterable；coordinator 会负责 drain、消息投影和 stop。 */
  stream?(input: AgentRuntimeQuery, callbacks?: AgentRuntimeCallbacks): AsyncIterable<SDKMessage>
  stop?(reason?: string, sessionId?: string): Promise<void> | void
  dispose?(): Promise<void> | void
  getCapabilities?(): AgentRuntimeCapabilities
}

/** 一次 run 可用的宿主端口集合；实现由桌面宿主、CLI 或 headless host 注入。 */
export interface AgentRuntimePorts {
  sessions?: SessionPort
  credentials?: CredentialPort
  permissions?: PermissionPort
  tools?: ToolPort
  resources?: ResourcePort
  process?: ProcessPort
  processLifecycle?: import('./ports').ProcessLifecyclePort
  files?: FilePort
  host?: RuntimeHostPort
  events?: import('./ports').EventPort
  commands?: import('./ports').CommandExecutionPort
  backgroundTasks?: import('./ports').BackgroundTaskPort
  processRegistration?: import('./ports').ProcessRegistrationPort
  toolAssembly?: import('./ports').ToolAssemblyPort
  preview?: import('./ports').PreviewPort
  queryPreparation?: AgentRuntimeQueryPreparationPort
  providerQueryPreparation?: AgentRuntimeProviderQueryPreparationPort
}

/** 编排器依赖的共享输入，后续迁移可直接由 AgentSendInput 映射而来。 */
export type AgentRuntimeInput = Pick<
  AgentSendInput,
  'sessionId' | 'userMessage' | 'channelId' | 'modelId' | 'workspaceId' | 'agentRuntime'
> & {
  prompt?: string
}

/** 兼容宿主事件投影时所需的最小消息形状。 */
export type AgentRuntimeMessage = SDKMessage | AgentMessage | AgentEvent | AgentStreamPayload
export type AgentRuntimeError = TypedError | Error | unknown
export type { AgentRuntime, AgentRuntimeCapabilities, AgentSessionMeta }
