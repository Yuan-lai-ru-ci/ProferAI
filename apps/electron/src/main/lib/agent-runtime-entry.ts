/**
 * agent-runtime-entry — 宿主侧 runtime headless 入口的公共接线（唯一一份）。
 *
 * 为什么要有这个模块：
 * 结构集成之后，「走新 runtime 链」的入口有四条（普通 headless / remote / automation / 直接
 * runtime），它们各自构造 query、各自投影终态、各自处理未读 —— 结果是同一份策略、
 * 同一次失败、同一轮完成在不同入口下表现不同（G3/G4/G5 与 remote/automation 字段集漂移）。
 *
 * 本模块把这四件事收敛成**一条**接线，且刻意保持「无 Electron 单例、无文件系统、无网络」：
 * - 每轮解析并冻结**一份**有效策略快照，挂到 query（权限模式 / 工具组 / skill / MCP / plan）；
 * - 计划模式控制器在同一轮内注册，run 起点投影 `enter_plan_mode` / `plan_mode_changed`；
 * - 终态投影只有一个责任方（`createRuntimeTerminalProjector`），`onError` / `onComplete` 各最多一次；
 * - 凭证 preflight 失败保持旧路径的用户可见语义（TypedError 气泡 + `interruption_record`）；
 * - 原生 session ID 由宿主持久化（provider 只负责回调）；
 * - 终态未读按宿主策略在终态广播之前写入。
 *
 * 依赖全部由 `RuntimeHeadlessEntryDeps` 注入，因此入口级行为可以被真实测试直接驱动，
 * 不需要切片编译 `agent-service.ts`，也不需要在测试里复刻接线。
 *
 * 边界：本模块**不**注册 webContents / backlog（那是 agent-service 的 IPC 责任），
 * 也**不**发 `run_completed`（那由 host event port 用同一份字段集统一投影）。
 */

import type {
  AgentGenerateTitleInput,
  AgentMessage,
  AgentRunInitiator,
  AgentExternalRunSource,
  AgentSendInput,
  AgentSessionMeta,
  ProferPermissionMode,
  SDKMessage,
} from '@profer/shared'
import type {
  AgentRuntime,
  AgentRuntimeCallbacks,
  AgentRuntimeQuery,
  AgentRuntimeRunHandle,
  AgentRunOutcome,
  SessionPort,
} from '@profer/agent-runtime'
import { normalizeAgentRuntime } from '@profer/shared'
import { createAgentRunRejectionError, resolveAgentInputOperationSource } from '@profer/agent-runtime'
import { createElectronAgentRuntimeQuery, clearAgentRuntimeRunFacts, resolveRuntimeSessionWriteLayout, setAgentRuntimeRunFacts } from './agent-runtime-host'
import { resolveCredentialPreflightTypedError } from './agent-preflight-typed-errors'
import {
  agentRuntimePolicyRuns,
  AgentRuntimePolicySnapshotMissingError,
  attachAgentRuntimePolicyToQuery,
  buildPolicyToolAssemblyContext,
  type AgentRuntimePolicyResolutionInput,
  type AgentRuntimePolicySnapshot,
} from './agent-runtime-policy-snapshot'
import {
  clearAgentRuntimePlanMode,
  createAgentRuntimePlanModeFromPolicy,
  registerAgentRuntimePlanMode,
  type AgentRuntimePlanModeController,
  type AgentRuntimePlanModeEvent,
  type AgentRuntimePlanToolPolicy,
} from './agent-runtime-plan-mode'
import { createPlanModeToolPolicy } from './plan-mode-tool-policy'
import { createRuntimeResultSnapshot } from './agent-runtime-result-snapshot'
import {
  createRuntimeTerminalProjector,
  readResultSignal,
  type RuntimeTerminalFields,
} from './agent-runtime-terminal-projection'
import {
  applyPreflightFailureProjection,
  projectPreflightFailure,
} from './agent-runtime-preflight-projection'
import {
  createNativeSessionPersister,
  withNativeSessionCallbacks,
} from './agent-runtime-native-session-persistence'
import { runSessionTitleNaming } from './agent-session-title-naming'
import { buildRewindNoticePrompt } from './agent-rewind-notice'
import { beginWorkspaceShadowTurn, endWorkspaceShadowTurn } from './workspace-shadow-turns'
import { fileWriteChips } from './agent-file-write-chips'
import {
  createShadowEvidenceLedger,
  resolveWriteToolFact,
  type ShadowEvidenceLedger,
} from './workspace-shadow-write-evidence'
import { buildRecoveryPrompt } from './agent-prompt-utils'
import { isSessionNotFoundError } from './agent-retry-utils'

/**
 * 自动命名窗口在本链的日志标签（与旧链 `[Agent 编排]` 区分，但同一份判据与编排）。
 */
const RUNTIME_TITLE_LOG_TAG = '[Agent runtime]'

/**
 * 自动命名窗口（GAP-D1）的宿主事实。
 *
 * 判据与编排本身在 `agent-session-title-naming.ts`（旧链同一实现），这里只允许注入
 * 「宿主才知道的事实」：生成器（旧链 `AgentOrchestrator.generateTitle`）、标题更新投影、
 * 两个常量。入口自己不读渠道、不调模型、不发 IPC。
 */
export interface RuntimeEntryTitleNaming {
  /** 旧链同一实现（`AgentOrchestrator.generateTitle`）；测试注入替身，不调真实模型。 */
  generate(input: AgentGenerateTitleInput): Promise<string | null>
  /** 标题更新投影（旧链同一事件类型 / 字段 / 顺序：`profer_event: title_updated` + `TITLE_UPDATED`）。 */
  onTitleUpdated(title: string): void
  /** 默认标题（旧链 `DEFAULT_SESSION_TITLE`，Agent = 「新 Agent 会话」）；`planTitleWindow` 的「人工命名」判定依赖它。 */
  defaultTitle: string
  /** 模型缺省值（旧链 `input.modelId || DEFAULT_MODEL_ID` 的同一个常量）。 */
  defaultModelId: string
}

/** 每轮运行的宿主环境描述（由宿主入口解析，测试可注入）。 */
export interface RuntimeEntryRunContext {
  runtime: AgentRuntime
  cwd?: string
  /**
   * 会话私有存储根（`resolveAgentSessionWriteLayout().storageDir`）。
   *
   * 优先采用：宿主已知时就给出，入口不再重算；缺省时入口按 `toolAssemblyContext.workspaceSlug + sessionId`
   * 从会话写入布局解析（与 `storageDir` 同一真相源），两者都没有时回落旧行为（cwd 语义）。
   */
  storageDir?: string
  /** 工具装配 context 基座（宿主既有字段）；策略字段由本模块合并。 */
  toolAssemblyContext: Record<string, unknown>
  /** 本轮策略上下文；`undefined` = 宿主无法解析预设，保持「不注入权限模式」的缺失语义。 */
  policy?: AgentRuntimePolicyResolutionInput
  /**
   * GAP-2：本轮文件回退检查点（宿主持有）。在 run 起点、provider 启动之前由宿主创建。
   *
   * 入口只把它透传给 `createNativeSessionPersister`，不自己实现创建 / 回收策略，因此保持
   * 「无文件系统」边界；桌面与 headless 共用同一份 `buildRuntimeHeadlessRunContext`，两者都得到它。
   */
  checkpointTurn?: {
    resolveCheckpointPatch(input: {
      bindings: Record<string, string>
      meta: AgentSessionMeta | undefined
    }): Partial<AgentSessionMeta> | undefined
  }
}

export interface RuntimeEntryQueryOptions {
  runtime: AgentRuntime
  cwd?: string
  toolAssemblyContext: Record<string, unknown>
  policy?: AgentRuntimePolicyResolutionInput
  /** 原生会话 id（热启动）；缺省不恢复，provider 会新建会话。 */
  resumeSessionId?: string
  /** 回退后的 provider 截断点（仅在 resumeSessionId 存在时生效）。 */
  resumeSessionAt?: string
  /** 仅本轮的隐藏上下文前缀（回退 notice）。 */
  promptPrefix?: string
  /** 完全替换本轮 prompt（resume 失效时的恢复提示）。 */
  promptOverride?: string
  /** 本轮 Shadow Git 写入证据账本（Pi 受控写入回调会往里记）。 */
  shadowLedger?: import('./workspace-shadow-write-evidence').ShadowEvidenceLedger
  /** 原生 session 持久化器；提供时经 providerInput 挂到 provider 回调上。 */
  persister?: ReturnType<typeof createNativeSessionPersister>
  /** 计划模式：提供时创建并注册本轮控制器。 */
  planMode?: {
    emit(event: AgentRuntimePlanModeEvent): void
    agentCwd?: string
    planToolPolicy?: AgentRuntimePlanToolPolicy
    onPermissionModeChange?(mode: ProferPermissionMode): void
  }
}

export interface RuntimeEntryQueryResult {
  query: AgentRuntimeQuery
  snapshot?: AgentRuntimePolicySnapshot
  controller?: AgentRuntimePlanModeController
}

/**
 * 构造一轮 runtime run 的 query。
 *
 * 顺序（缺一不可）：
 * 1. 先解析并冻结策略快照（`agentRuntimePolicyRuns` 保证一轮一份）；
 * 2. 用快照字段构造工具装配 context（禁用工具组 / PPT 门禁 / 权限模式）；
 * 3. 挂原生 session 回调；
 * 4. 把快照挂到 query 的 `providerInput`（provider preparation 只消费它，不再猜默认权限模式）；
 * 5. 注册计划模式控制器（权限端口按 sessionId 取它）。
 */
export function createRuntimeEntryQuery(
  input: AgentSendInput,
  options: RuntimeEntryQueryOptions,
): RuntimeEntryQueryResult {
  const snapshot = options.policy
    ? agentRuntimePolicyRuns.resolveForRun(input.sessionId, options.policy)
    : undefined

  // 内置 MCP 注入所需的运行事实（GAP-4）：与策略快照同一生命周期（入口写 / `resources.load` 读 /
  // run 结束清理）。不把这些字段加进 `ResourceRequest` / `AgentRuntimeQuery`，避免改 runtime 契约。
  setAgentRuntimeRunFacts(input.sessionId, {
    triggeredBy: resolveAgentInputOperationSource(input),
    userMessage: input.userMessage,
    ...(snapshot
      ? { permissionModeOverride: snapshot.policy.permissionMode }
      : input.permissionModeOverride
        ? { permissionModeOverride: input.permissionModeOverride }
        : {}),
  })

  const toolAssemblyContext = snapshot
    ? buildPolicyToolAssemblyContext(snapshot, options.toolAssemblyContext)
    : options.toolAssemblyContext

  const providerInput = {
    ...(options.persister ? withNativeSessionCallbacks(undefined, options.persister) : {}),
    ...(options.resumeSessionAt ? { resumeSessionAt: options.resumeSessionAt } : {}),
  }
  const hasProviderInput = Object.keys(providerInput).length > 0

  const queryInput = snapshot
    ? { ...input, permissionModeOverride: snapshot.policy.permissionMode }
    : input
  let query = createElectronAgentRuntimeQuery(queryInput, {
    runtime: options.runtime,
    ...(options.cwd ? { cwd: options.cwd } : {}),
    // 本轮权限模式必须带进 query：宿主据此决定 provider 的 permissionMode。
    // 漏掉这一项时，显式 `bypassPermissions` 会在新链里失效（automation / 飞书 / 调试通道
    // 都会因此停成「等待批准」，而无人值守入口没有界面可以点）。旧链一直传同一个字段。
    ...(input.permissionModeOverride ? { permissionModeOverride: input.permissionModeOverride } : {}),
    ...(hasProviderInput ? { providerInput } : {}),
    ...(options.resumeSessionId ? { runtimeSessionId: options.resumeSessionId } : {}),
    ...(options.promptPrefix ? { promptPrefix: options.promptPrefix } : {}),
    ...(options.promptOverride ? { promptOverride: options.promptOverride } : {}),
    ...(options.shadowLedger ? { shadowLedger: options.shadowLedger } : {}),
    toolAssemblyContext,
  })
  if (snapshot) query = attachAgentRuntimePolicyToQuery(query, snapshot)

  const controller = snapshot && options.planMode
    ? createAgentRuntimePlanModeFromPolicy({
        sessionId: input.sessionId,
        snapshot,
        emit: options.planMode.emit,
        ...(options.planMode.agentCwd ? { agentCwd: options.planMode.agentCwd } : {}),
        ...(options.planMode.planToolPolicy ? { planToolPolicy: options.planMode.planToolPolicy } : {}),
        ...(options.planMode.onPermissionModeChange ? { onPermissionModeChange: options.planMode.onPermissionModeChange } : {}),
      })
    : undefined
  if (controller) registerAgentRuntimePlanMode(controller)

  return {
    query,
    ...(snapshot ? { snapshot } : {}),
    ...(controller ? { controller } : {}),
  }
}

export interface RuntimeHeadlessEntryDeps {
  /** 解析每轮运行环境（runtime / cwd / 工具装配基座 / 策略上下文）。 */
  resolveRunContext(input: AgentSendInput): RuntimeEntryRunContext
  /** 产品宿主与 coordinator 共用同一所有权表；保护 claim 前的上下文与检查点副作用。 */
  execution?: {
    ownership: import('@profer/agent-runtime').AgentRunOwnershipRegistry
    isRunning(sessionId: string): boolean
  }
  /** 执行一轮 run；生产实现是真实 coordinator，测试可注入真实 coordinator + fixture 端口。 */
  run(query: AgentRuntimeQuery, callbacks: AgentRuntimeCallbacks): AgentRuntimeRunHandle
  /** 会话端口：原生 session 持久化 + preflight transcript 落盘 + 标题来源读取（旧链 `sessionPort.getMessages`）。 */
  sessions: Pick<SessionPort, 'getMeta' | 'appendMessages' | 'updateMeta' | 'getMessages'>
  /** 终态消息载荷（旧 `onComplete(messages, opts)` 第一参语义）。 */
  messages(sessionId: string): AgentMessage[]
  /** owner 释放后的空闲通知；协作框架此时才可安全唤醒父会话。 */
  onIdle?(sessionId: string): void
  /** 计划模式事件出口（host port 的 host_event → profer_event）。 */
  emitPlanModeEvent(sessionId: string, event: AgentRuntimePlanModeEvent): void
  /** 审批通过后同步 provider 侧权限模式。 */
  setProviderPermissionMode?(sessionId: string, mode: ProferPermissionMode): void
  /** run 真正启动（未读清除 / draft 晋升 / external_run_started 广播）。 */
  onRunStarted(input: AgentSendInput, startedAt: number): void | Promise<void>
  /** 终态未读（宿主策略，在终态广播之前执行）。 */
  applyCompletionUnread(input: AgentSendInput, fields: RuntimeTerminalFields, started: boolean): void
  /**
   * GAP-2：宿主持有的检查点生命周期。
   *
   * 返回 `undefined` 表示本轮不做文件回退（例如非 pi 运行或缺少 cwd）；返回对象时必须提供
   * `resolveCheckpointPatch`（与 `createNativeSessionPersister({ checkpointLifecycle })` 同形）。
   * 入口只负责在 provider 启动**之前**调用它，不自己实现创建 / 回收策略。
   */
  beginCheckpointTurn?: (
    input: AgentSendInput,
    context: RuntimeEntryRunContext,
  ) => {
    resolveCheckpointPatch(input: {
      bindings: Record<string, string>
      meta: AgentSessionMeta | undefined
    }): Partial<AgentSessionMeta> | undefined
  } | undefined
  /** 终态投递目标。 */
  sink: {
    onError(error: string): void
    onComplete(messages: AgentMessage[] | undefined, fields: RuntimeTerminalFields): void
  }
  /**
   * GAP-D1：自动命名窗口。提供时按旧链同一判据 / 同一时机（成功轮、终态广播之前）自动命名；
   * 缺省时本入口不产生任何标题事件（旧链仍有自己的实现，因此不会出现双重命名）。
   */
  titleNaming?: RuntimeEntryTitleNaming
  /** 本轮运行来源（委派取消等语义依赖它）。 */
  source?: AgentExternalRunSource
  /** 规范化发起者（未读口径依赖它）。 */
  initiator?: AgentRunInitiator
}

/**
 * 从 assistant 消息的 `tool_use` 块里采集 Shadow Git 写入证据。
 *
 * 两个 runtime 共用：Claude 只能从 tool_use 取路径；Pi 的受控写入回调在部分渠道不触发，
 * 但 `Write` / `Edit` 这类工具调用一定会在消息流里出现。回调能触发时，
 * `ShadowEvidenceLedger` 会按「同一 toolUseId + 同一路径」把同一条证据合并，不会记两次。
 */
function collectShadowWriteEvidence(message: SDKMessage, ledger: ShadowEvidenceLedger): void {
  const content = (message as { message?: { content?: unknown } }).message?.content
  if (!Array.isArray(content)) return
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const record = block as { type?: unknown; id?: unknown; name?: unknown; input?: unknown }
    if (record.type !== 'tool_use') continue
    const name = typeof record.name === 'string' ? record.name : ''
    const toolInput = record.input && typeof record.input === 'object'
      ? record.input as Record<string, unknown>
      : {}
    const fact = resolveWriteToolFact(name, toolInput)
    if (!fact) continue
    ledger.push({
      ...(typeof record.id === 'string' ? { toolUseId: record.id } : {}),
      ...(name ? { toolName: name } : {}),
      path: fact.path,
      source: fact.source,
    })
  }
}

/**
 * 运行一轮 runtime headless。
 *
 * 返回 runtime 的终态 outcome；被并发 / 内核不匹配拒绝时**抛出具名错误**且不投递任何终态。
 */
export async function runRuntimeHeadlessEntry(
  input: AgentSendInput,
  callbacks: AgentRuntimeCallbacks,
  deps: RuntimeHeadlessEntryDeps,
): Promise<AgentRunOutcome> {
  const execution = deps.execution
  const token = execution ? Symbol(`runtime-entry:${input.sessionId}`) : undefined
  if (execution && token) {
    const runtime = normalizeAgentRuntime(input.agentRuntime ?? deps.sessions.getMeta(input.sessionId)?.agentRuntime)
    const claim = execution.ownership.claim({ sessionId: input.sessionId, runtime, token })
    if (!claim.ok) throw createAgentRunRejectionError(claim, { stopping: execution.isRunning(input.sessionId) })
  }
  let hostFinished!: () => void
  const hostCompletion = new Promise<void>(resolve => { hostFinished = resolve })
  try {
    return await runOwnedRuntimeHeadlessEntry(input, callbacks, deps, token, hostCompletion)
  } finally {
    hostFinished()
    // 正常运行由入口在终态投影/清理后释放。停止未退出的资源仍由 coordinator 隔离，不能抢先解锁。
    if (execution && token && !execution.isRunning(input.sessionId)
      && (execution.ownership.getOwner(input.sessionId)?.token === token || !execution.ownership.isOwned(input.sessionId))) {
      clearAgentRuntimePlanMode(input.sessionId)
      agentRuntimePolicyRuns.releaseRun(input.sessionId)
      clearAgentRuntimeRunFacts(input.sessionId)
      fileWriteChips.dropSession(input.sessionId)
      execution.ownership.release(input.sessionId, token)
      deps.onIdle?.(input.sessionId)
    }
  }
}

async function runOwnedRuntimeHeadlessEntry(
  input: AgentSendInput,
  callbacks: AgentRuntimeCallbacks,
  deps: RuntimeHeadlessEntryDeps,
  token?: import('@profer/agent-runtime').AgentRunOwnershipToken,
  hostCompletion: Promise<void> = Promise.resolve(),
): Promise<AgentRunOutcome> {
  const context = deps.resolveRunContext(input)
  // 产品入口不能以缺策略的 neutral host 语义继续执行；独立包测试宿主仍可显式不注入 execution。
  if (deps.execution && !context.policy) throw new AgentRuntimePolicySnapshotMissingError()
  // GAP-2：检查点必须在 provider 启动之前创建（否则快照到的不是本轮改动前的工作区基线）。
  // 显式 `beginCheckpointTurn` 优先（测试 / 特殊宿主），否则用宿主随运行上下文注入的检查点。
  const checkpointTurn = deps.beginCheckpointTurn?.(input, context) ?? context.checkpointTurn
  /**
   * 热启动事实（只读一次）。
   *
   * 新链曾经完全不读会话元数据：每轮都是新建 provider session，历史与缓存全部重建。
   * 这里把旧链的续写语义补齐：非隔离会话一律恢复自己的原生 session，
   * 回退后的截断点与一次性 notice 也从同一份元数据取。
   */
  const entryMeta = deps.sessions.getMeta(input.sessionId)
  const resumeSessionId = input.isolatedRuntimeSession ? input.runtimeSessionId : entryMeta?.sdkSessionId
  const rewindResumeAt = input.isolatedRuntimeSession ? undefined : entryMeta?.resumeAtMessageUuid
  const pendingRewindNotice = input.isolatedRuntimeSession ? undefined : entryMeta?.pendingRewindNotice
  const noticePrefix = pendingRewindNotice ? buildRewindNoticePrompt(pendingRewindNotice) : undefined

  // 会话写入布局（唯一真相源）：
  // - 优先宿主已给出的 `storageDir`（run context / 装配 context，二者同源）；
  // - 否则按 `workspaceSlug + sessionId` 从会话写入布局解析；
  // - 无工作区或解析失败时返回 undefined，计划策略回落旧语义（cwd/.context/plan）。
  // 为什么不自己拼 `join(cwd, '.context', 'plan')`：project 下 cwd 是用户项目根，
  // 这样拼会把计划文件判可写、写进仓库，正是 A3-3c 遗留的缺陷。
  const assemblyStorageDir = typeof context.toolAssemblyContext.storageDir === 'string'
    ? context.toolAssemblyContext.storageDir
    : undefined
  const assemblyWorkspaceSlug = typeof context.toolAssemblyContext.workspaceSlug === 'string'
    ? context.toolAssemblyContext.workspaceSlug
    : undefined
  const sessionWriteLayout = resolveRuntimeSessionWriteLayout({
    sessionId: input.sessionId,
    ...(context.storageDir ?? assemblyStorageDir ? { storageDir: context.storageDir ?? assemblyStorageDir } : {}),
    ...(assemblyWorkspaceSlug ? { workspaceSlug: assemblyWorkspaceSlug } : {}),
  })

  // Shadow Git 的 turn 边界（与旧链同一份实现）：
  // 本轮第一次写文件之前把基线采下来，终态后把「树差异 × 写入证据」落成归属记录。
  // 纯旁路：`beginWorkspaceShadowTurn` 内部已吞掉所有异常，不会阻断本轮。
  const shadowWorkspaceId = entryMeta?.workspaceId
  const shadowSessionAttached = entryMeta?.attachedDirectories
  // 会话级附加目录只对这个会话可见，采集与记录都要用它，
  // 否则 Agent 写到附加目录里的文件会被当成「工作区外」。
  const shadowBegin = beginWorkspaceShadowTurn(shadowWorkspaceId, {
    ...(shadowSessionAttached?.length ? { sessionAttachedDirectories: shadowSessionAttached } : {}),
  })
  // 本轮 before 边界：轮中任何外部采集都会把 turn-after 的 previousCommitId 推后，
  // 必须把 begin 采出来的基线显式带到 end。
  let shadowBaseline: Awaited<NonNullable<ReturnType<typeof beginWorkspaceShadowTurn>>> | undefined
  const awaitShadowBaseline = async () => { shadowBaseline = shadowBegin ? await shadowBegin : undefined }
  const shadowLedger = createShadowEvidenceLedger()

  const buildQuery = (params: { resumeSessionId?: string; resumeSessionAt?: string; promptOverride?: string }) => {
    const persister = createNativeSessionPersister({
      sessions: deps.sessions,
      sessionId: input.sessionId,
      ...(checkpointTurn ? { checkpointLifecycle: checkpointTurn } : {}),
      ...(input.isolatedRuntimeSession !== undefined ? { isolatedRuntimeSession: input.isolatedRuntimeSession } : {}),
      ...(input.onRuntimeSessionId ? { onRuntimeSessionId: input.onRuntimeSessionId } : {}),
    })
    const built = createRuntimeEntryQuery(input, {
      runtime: context.runtime,
      ...(context.cwd ? { cwd: context.cwd } : {}),
      ...(context.policy ? { policy: context.policy } : {}),
      ...(params.resumeSessionId ? { resumeSessionId: params.resumeSessionId } : {}),
      ...(params.resumeSessionAt ? { resumeSessionAt: params.resumeSessionAt } : {}),
      ...(noticePrefix ? { promptPrefix: noticePrefix } : {}),
      ...(params.promptOverride ? { promptOverride: params.promptOverride } : {}),
      shadowLedger,
      toolAssemblyContext: context.toolAssemblyContext,
      persister,
      planMode: {
        emit: event => deps.emitPlanModeEvent(input.sessionId, event),
        ...(context.cwd ? { agentCwd: context.cwd } : {}),
        // GAP-5：计划模式只读工具面的完整规则（与旧编排层共享同一实现）。
        // 计划目录真相源：project 下计划文件落 storageDir（不在项目根），managed 下等价于 cwd/.context/plan。
        planToolPolicy: createPlanModeToolPolicy(context.cwd, sessionWriteLayout?.plansDir),
        ...(deps.setProviderPermissionMode
          ? { onPermissionModeChange: (mode: ProferPermissionMode) => deps.setProviderPermissionMode?.(input.sessionId, mode) }
          : {}),
      },
    })
    const onRunAdmitted = built.query.onRunAdmitted
    built.query = {
      ...built.query,
      onRunAdmitted: async admitted => {
        await onRunAdmitted?.(admitted)
        await awaitShadowBaseline()
      },
    }
    if (token) built.query = {
      ...built.query,
      ownershipToken: token,
      retainOwnership: true,
      onOwnerReleased: () => deps.onIdle?.(input.sessionId),
      onResourcesDrained: async () => {
        await hostCompletion
        if (deps.execution?.ownership.getOwner(input.sessionId)?.token !== token) return
        clearAgentRuntimePlanMode(input.sessionId)
        agentRuntimePolicyRuns.releaseRun(input.sessionId)
        clearAgentRuntimeRunFacts(input.sessionId)
        fileWriteChips.dropSession(input.sessionId)
      },
    }
    return built
  }

  let built = buildQuery({ resumeSessionId, ...(rewindResumeAt ? { resumeSessionAt: rewindResumeAt } : {}) })

  let started = false
  let startedAt: number | undefined
  let preparationFailure: { phase: string; code?: string; message: string } | undefined
  /**
   * 本轮流里最后一个 `result` 消息。
   *
   * 旧链用它取 `capturedResultErrors`（`!wasStoppedByUser && !capturedResultErrors?.length` 才命名），
   * 新链必须用同一份事实：`outcome.status === 'completed'` 不足以排除「流正常结束但 result 带 errors」
   * （例如自动压缩续跑达上限）。解析走终态投影的同一个 `readResultSignal`，不另写一套。
   */
  let lastResultMessage: SDKMessage | undefined
  const resultSnapshot = createRuntimeResultSnapshot()
  const titleNaming = deps.titleNaming
  const readSessionMessages = deps.sessions.getMessages?.bind(deps.sessions)

  const projector = createRuntimeTerminalProjector({
    ...(deps.source !== undefined ? { source: deps.source } : {}),
    messages: () => resultSnapshot.messages(),
    sink: {
      onError: error => deps.sink.onError(error),
      onComplete: (fields, messages) => {
        // 未读必须先于终态广播落盘（与旧路径 runAgent 的顺序一致）：
        // 渲染层收到 STREAM_COMPLETE 时侧边栏绿标与角标必须已就绪。
        // `started` 透传：从未真正启动的请求（并发拒绝 / 准备失败）不得写未读。
        deps.applyCompletionUnread(input, fields, started)
        deps.sink.onComplete(messages, { ...fields, messagesScope: 'run' })
      },
    },
  })

  /**
   * 一次性回退状态（resume 截断点 / 回退 notice）只在 provider 真正接上后消费。
   *
   * 与旧链同一口径：首条 assistant/user 消息 = resume 已被接受。在发送前就清，
   * 本轮若在 provider 启动前失败，下一次 resume 会越界到 provider 自己的末尾。
   */
  let pendingRewindStateConsumed = !rewindResumeAt && !pendingRewindNotice
  const consumePendingRewindState = (): void => {
    if (pendingRewindStateConsumed) return
    pendingRewindStateConsumed = true
    try {
      const current = deps.sessions.getMeta(input.sessionId)
      if (rewindResumeAt && current?.resumeAtMessageUuid === rewindResumeAt) {
        deps.sessions.updateMeta(input.sessionId, { resumeAtMessageUuid: undefined })
      }
      if (pendingRewindNotice && current?.pendingRewindNotice?.createdAt === pendingRewindNotice.createdAt) {
        deps.sessions.updateMeta(input.sessionId, { pendingRewindNotice: undefined })
      }
    } catch (error) {
      console.warn('[Agent Runtime] 清理一次性回退状态失败:', error)
    }
  }

  /**
   * 第一次尝试的失败先压住：resume 失效要静默重试一次。
   * 不是 resume 失效时再把同一条失败原样重放，用户可见语义与原来一致。
   */
  let suppressAttemptFailure = true
  let suppressedError: string | undefined
  let suppressedPreparation: Parameters<NonNullable<AgentRuntimeCallbacks['onPreparationFailure']>>[0] | undefined

  const runtimeCallbacks: AgentRuntimeCallbacks = {
    ...callbacks,
    onRunStarted: async ({ startedAt: runStartedAt, runId }) => {
      started = true
      startedAt = runStartedAt
      await awaitShadowBaseline()
      projector.observeRunStarted(runStartedAt, runId)
      built.controller?.start()
      await deps.onRunStarted(input, runStartedAt)
      await callbacks.onRunStarted?.({ startedAt: runStartedAt, ...(runId ? { runId } : {}) })
    },
    onPersistence: state => {
      projector.observePersistence(state)
      callbacks.onPersistence?.(state)
    },
    onMessage: message => {
      resultSnapshot.observe(message)
      projector.observeMessage(message)
      const type = (message as { type?: unknown }).type
      // 首条实质消息 = provider 已接受本轮请求（含回退后的 resume 分支）。
      if (type === 'assistant' || type === 'user') consumePendingRewindState()
      // Shadow Git 写入证据：两个 runtime 都从 tool_use 取路径。
      // Pi 在部分渠道下用 `Write` 工具执行写入，不走受控写入回调；只靠回调会把真实改动记成 unconfirmed。
      if (type === 'assistant') collectShadowWriteEvidence(message, shadowLedger)
      if (type === 'result') lastResultMessage = message
      void callbacks.onMessage?.(message)
    },
    onError: error => {
      // 只记录，不立即投递：终态统一由 projector.settle 决定，避免同一轮两次 onError。
      if (suppressAttemptFailure) {
        suppressedError = typeof error === 'string' ? error : String(error)
        return
      }
      projector.observeProviderError(error)
      void callbacks.onError?.(error)
    },
    onPreparationFailure: async failure => {
      if (suppressAttemptFailure) {
        suppressedPreparation = failure
        return
      }
      preparationFailure = failure
      await callbacks.onPreparationFailure?.(failure)
    },
    onBackgroundTasksPending: signal => {
      // 轻量完成不是终态：只投递 `backgroundTasksPending: true` 的 `run_completed`
      // （UI 进入空闲可输入态），真终态仍由 `projector.settle` 给出，且保持不含该标记。
      projector.settleBackgroundTasksPending(signal)
      void callbacks.onBackgroundTasksPending?.(signal)
    },
    onComplete: outcome => {
      if (outcome.runId) projector.observeRunIdentity(outcome.runId)
      void callbacks.onComplete?.(outcome)
    },
  }

  try {
    let outcome: AgentRunOutcome
    try {
      outcome = await deps.run(built.query, runtimeCallbacks).promise
    } catch (error) {
      // 请求从未取得执行权（并发 / 内核不匹配）：不是一次运行 —— 不投递任何终态，向上抛具名错误。
      projector.rejectBeforeStart()
      throw error
    }

    // resume 失效（provider 里那个 session 已经不在了）：清掉原生会话，按截断后的历史重建一次。
    // 只在本轮尚未真正开始前重试：已产生工具副作用的轮次不能重跑。
    const failureText = (outcome.status === 'failed' ? outcome.error : undefined) ?? suppressedError
    if (outcome.status === 'failed' && resumeSessionId && !started && isSessionNotFoundError(failureText ?? '')) {
      console.warn(`[Agent Runtime] resume 失效，清除原生会话并重建一轮: ${input.sessionId}（${failureText ?? ''}）`)
      try {
        deps.sessions.updateMeta(input.sessionId, { sdkSessionId: undefined, resumeAtMessageUuid: undefined })
      } catch (error) {
        console.warn('[Agent Runtime] 清除失效 sdkSessionId 失败:', error)
      }
      // 重建会重新注册计划模式控制器：先释放旧的，避免遗留一个不归本轮管的控制器。
      clearAgentRuntimePlanMode(input.sessionId)
      resultSnapshot.clear()
      suppressAttemptFailure = false
      suppressedError = undefined
      suppressedPreparation = undefined
      // 新链没有旧链的自动上下文回填：用与旧链同一份恢复提示，让模型自己去读会话历史文件。
      const basePrompt = input.automationContext
        ? `${input.automationContext}\n\n${input.internalPrompt ?? input.userMessage}`
        : input.internalPrompt ?? input.userMessage
      built = buildQuery({
        promptOverride: buildRecoveryPrompt(input.sessionId, basePrompt, { agentCwd: context.cwd ?? '' }),
      })
      try {
        outcome = await deps.run(built.query, runtimeCallbacks).promise
      } catch (error) {
        projector.rejectBeforeStart()
        throw error
      }
    } else {
      // 不重试：把压住的失败原样重放，保持旧语义（含下面的 credentials 特判）。
      suppressAttemptFailure = false
      if (suppressedPreparation) {
        preparationFailure = suppressedPreparation
        await callbacks.onPreparationFailure?.(suppressedPreparation)
      }
      if (suppressedError) {
        projector.observeProviderError(suppressedError)
        void callbacks.onError?.(suppressedError)
      }
    }

    // 凭证 / 环境 preflight 失败：保持旧路径的用户可见语义。
    // 顺序关键：必须在 settle 之前把用户可见文案写进 projector，否则终态会带上 runtime 的机械文本。
    if (outcome.status === 'failed' && preparationFailure?.phase === 'credentials') {
      const typedError = resolveCredentialPreflightTypedError(preparationFailure.code)
      if (typedError) {
        const projection = projectPreflightFailure({
          typedError,
          ...(startedAt !== undefined ? { startedAt } : {}),
        })
        // 凭证失败发生在用户消息落盘之前（coordinator 的顺序保证），因此这里无需回滚用户气泡。
        applyPreflightFailureProjection({ sessions: deps.sessions, sessionId: input.sessionId, projection })
        projector.observeProviderError(projection.errorText)
      }
    }

    // GAP-D1：自动命名窗口 —— 与旧链**同一判据、同一去重与重试语义**，但不再阻塞终态。
    //
    // 标题是增强能力：标题模型偶发慢请求/重试时，正文早已停止而 UI 仍显示
    // 「Agent Running」。先 `projector.settle()` 广播终态，再用 setImmediate 启动命名；
    // 标题完成后仍通过 `onTitleUpdated` 正常投影。终态顺序不再依赖标题请求耗时。
    //
    // 条件（与旧链逐条对齐）：旧链为 `!wasStoppedByUser && !capturedResultErrors?.length`，
    // 新链等价为「outcome 为 completed（未停止且未抛错）+ 最后一个 result 消息无 errors」。
    //
    // 失败不阻断：`runSessionTitleNaming` 内部整体兜底，任何异常只记日志。
    projector.settle(outcome)

    if (titleNaming && outcome.status === 'completed' && (readResultSignal(lastResultMessage).errors ?? []).length === 0) {
      setImmediate(() => {
        void runSessionTitleNaming({
          sessionId: input.sessionId,
          // 与旧链同一来源：Goal 等机器注入的 prompt 不用作命名来源（`titleSourceText` 覆盖）。
          userMessage: input.titleSourceText ?? input.userMessage,
          // 旧链的渠道/模型解析：`input.channelId` + `input.modelId || DEFAULT_MODEL_ID`。
          channelId: input.channelId,
          modelId: input.modelId ?? titleNaming.defaultModelId,
          defaultTitle: titleNaming.defaultTitle,
          getMeta: sessionId => deps.sessions.getMeta(sessionId),
          updateMeta: (sessionId, patch) => { deps.sessions.updateMeta(sessionId, patch) },
          // 与旧链同一个转录读取器（`agentRuntimeHost.sessions.getMessages`）；缺省只用本轮消息。
          ...(readSessionMessages ? { readMessages: sessionId => readSessionMessages(sessionId) ?? [] } : {}),
          generate: titleInput => titleNaming.generate(titleInput),
          onTitleUpdated: title => titleNaming.onTitleUpdated(title),
          logTag: RUNTIME_TITLE_LOG_TAG,
        }).catch(error => {
          // 自动命名永远不能变成未处理 rejection；失败只记日志。
          console.warn(`${RUNTIME_TITLE_LOG_TAG} 自动标题生成失败:`, error)
        })
      })
    }

    return outcome
  } finally {
    // 本轮终态已交付：后台补一次 turn-after，作为下一轮的「之前」状态，
    // 同时把「树差异 × 写入证据」落成这个 turn 的归属记录。
    // 没真正开始（并发拒绝 / 内核不匹配）的请求不记 turn：否则会多出一个空 turn，
    // 回退时把它当成「没改过任何东西的一轮」。
    if (started) {
      await awaitShadowBaseline()
      endWorkspaceShadowTurn(shadowWorkspaceId, {
        sessionId: input.sessionId,
        ...(typeof input.uuid === 'string' && input.uuid ? { turnId: input.uuid } : {}),
        runtime: context.runtime,
        ...(startedAt !== undefined ? { startedAt } : {}),
        evidence: shadowLedger.list(),
        ...(shadowBaseline ? { baseline: shadowBaseline } : {}),
        ...(shadowSessionAttached?.length ? { sessionAttachedDirectories: shadowSessionAttached } : {}),
      })
    }
    // 只有仍持有本轮 token 的入口可清；资源未退出时保留到 onResourcesDrained。
    if (!deps.execution || (token && !deps.execution.isRunning(input.sessionId)
      && deps.execution.ownership.getOwner(input.sessionId)?.token === token)) {
      clearAgentRuntimePlanMode(input.sessionId)
      agentRuntimePolicyRuns.releaseRun(input.sessionId)
      clearAgentRuntimeRunFacts(input.sessionId)
      fileWriteChips.dropSession(input.sessionId)
    }
  }
}
