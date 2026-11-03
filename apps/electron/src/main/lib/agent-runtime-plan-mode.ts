/**
 * Electron 宿主侧的「计划模式」状态与事件适配。
 *
 * 背景：旧 orchestrator 把计划模式拆在三处 ——
 * 1. `sessionPermissionModes` 记录当前权限模式（支持运行中切换）；
 * 2. `emitPlanModeChanged` / `enter_plan_mode` / `exit_plan_mode_request` 三个投影事件；
 * 3. `canUseTool` 里 EnterPlanMode / ExitPlanMode 的拦截与 `handleExitPlanMode` 审批。
 *
 * 新 runtime 路径此前只把 `plan` 透传给 provider，没有责任方，于是出现
 * 「模型被限制、UI 无提示、审批链路缺失」。本模块把上述三件事收敛成一个
 * 运行期控制器 + 一个可注入的门禁包装：
 *
 * - 状态：本轮初始模式来自有效策略快照的 `permissionMode`，审批通过后切到目标模式；
 * - 投影：`start()` / 工具态同步 / 审批结果都返回并发出与旧路径逐字一致的 ProferEvent；
 * - 审批：ExitPlanMode 仍走宿主权限端口（`exitPlanService`），本模块只负责
 *   请求投影、结果解释和模式切换通知，不把 UI 语义下沉到 runtime core；
 * - 只读工具面：策略来自注入的 `planToolPolicy`；未注入时只应用共享 helper 能判定的部分，
 *   其余工具交回宿主既有权限判定（绝不静默放行）。
 */

import type { ExitPlanModeRequest, ProferEvent, ProferPermissionMode } from '@profer/shared'
import type { AgentPlanModeChangeSource } from '@profer/shared'
import type { RuntimeCanUseTool, RuntimePermissionResult } from '@profer/agent-runtime'
import {
  isBrowserToolName,
  isPlanModeMarkdownPath,
  isPlanModeMcpTool,
  resolvePlanModeBrowserPermission,
} from './agent-orchestrator-p0-guards'
import type { AgentRuntimePolicySnapshot } from './agent-runtime-policy-snapshot'

/** 计划模式相关投影事件（ProferEvent 的子集）。 */
export type AgentRuntimePlanModeEvent =
  | Extract<ProferEvent, { type: 'enter_plan_mode' }>
  | Extract<ProferEvent, { type: 'plan_mode_changed' }>
  | Extract<ProferEvent, { type: 'exit_plan_mode_request' }>

export interface AgentRuntimePlanModeEventSink {
  (event: AgentRuntimePlanModeEvent): void
}

/** 计划模式下单个工具的判定；`undefined` 表示本策略不负责该工具。 */
export interface AgentRuntimePlanToolDecision {
  behavior: 'allow' | 'deny'
  message?: string
}

export interface AgentRuntimePlanToolPolicyInput {
  toolName: string
  toolInput: Record<string, unknown>
}

export type AgentRuntimePlanToolPolicy = (input: AgentRuntimePlanToolPolicyInput) => AgentRuntimePlanToolDecision | undefined

export interface AgentRuntimePlanModeOptions {
  sessionId: string
  /** 本轮初始权限模式：必须来自有效策略快照，不接受调用方凭空指定。 */
  initialMode: ProferPermissionMode
  /** 会话工作目录；计划目录内的 Markdown 写入白名单依赖它，缺失时按拒绝处理。 */
  agentCwd?: string
  /**
   * 计划目录真相源（`resolveAgentSessionWriteLayout().plansDir`）。
   * project 下它在会话存储目录内、不在 cwd 内；managed 下等价于 `<agentCwd>/.context/plan`。
   * 缺省时回落旧语义（按 agentCwd 推导）。
   */
  planDir?: string
  /** 宿主计划只读工具策略（由共享只读规则提供时才是完整等价实现）。 */
  planToolPolicy?: AgentRuntimePlanToolPolicy
  /** 审批通过后通知宿主同步 provider 侧权限模式。 */
  onPermissionModeChange?(mode: ProferPermissionMode): void
  emit: AgentRuntimePlanModeEventSink
}

export interface AgentRuntimePlanModeController {
  readonly sessionId: string
  getMode(): ProferPermissionMode
  getAgentCwd(): string | undefined
  /** 计划目录（storageDir 内的 `.context/plan`）；缺省时调用方按 cwd 推导。 */
  getPlanDir(): string | undefined
  isPlanActive(): boolean
  /** 是否已注入宿主计划只读策略；未注入时门禁只覆盖共享 helper 可判定的部分。 */
  hasHostPlanToolPolicy(): boolean
  /** 宿主计划只读策略（由入口随控制器一并注册，门禁优先使用它）。 */
  getPlanToolPolicy(): AgentRuntimePlanToolPolicy | undefined
  /** 本轮开始时的投影：plan 模式发 enter_plan_mode + plan_mode_changed(active=true, source='initial')。 */
  start(): readonly AgentRuntimePlanModeEvent[]
  /** EnterPlanMode / ExitPlanMode 的工具态同步（与旧编排同名同义）。 */
  syncPlanModeFromToolUse(toolName: string): readonly AgentRuntimePlanModeEvent[]
  /** auto/plan 下 EnterPlanMode：plan_mode_changed(true,'tool') + enter_plan_mode。 */
  enterPlanModeFromTool(): readonly AgentRuntimePlanModeEvent[]
  /** 运行中切换权限模式（含运行中模式表语义）。 */
  setMode(mode: ProferPermissionMode, source?: AgentPlanModeChangeSource): readonly AgentRuntimePlanModeEvent[]
  /** ExitPlanMode 审批结果 → 模式切换与投影；拒绝/反馈不改变计划态。 */
  applyExitPlanApproval(result: RuntimePermissionResult): {
    targetMode?: ProferPermissionMode
    events: readonly AgentRuntimePlanModeEvent[]
  }
  /** 把审批请求投影到 UI（宿主 exitPlan 服务的 sendToRenderer）。 */
  emitExitPlanRequest(request: ExitPlanModeRequest): void
  /** 运行结束 / 取消：停止投影；挂起的审批由宿主权限端口统一拒绝。 */
  dispose(): void
}

export function createAgentRuntimePlanModeController(
  options: AgentRuntimePlanModeOptions,
): AgentRuntimePlanModeController {
  let mode: ProferPermissionMode = options.initialMode
  let planActive = mode === 'plan'
  let disposed = false

  const emitAll = (events: readonly AgentRuntimePlanModeEvent[]): readonly AgentRuntimePlanModeEvent[] => {
    if (disposed) return events
    for (const event of events) options.emit(event)
    return events
  }

  const planModeChanged = (active: boolean, source: AgentPlanModeChangeSource): AgentRuntimePlanModeEvent => ({
    type: 'plan_mode_changed',
    sessionId: options.sessionId,
    active,
    source,
  })

  return {
    sessionId: options.sessionId,
    getMode: () => mode,
    getAgentCwd: () => options.agentCwd,
    getPlanDir: () => options.planDir,
    isPlanActive: () => planActive,
    hasHostPlanToolPolicy: () => typeof options.planToolPolicy === 'function',
    getPlanToolPolicy: () => options.planToolPolicy,
    start() {
      if (!planActive) return []
      return emitAll([
        { type: 'enter_plan_mode', sessionId: options.sessionId },
        planModeChanged(true, 'initial'),
      ])
    },
    syncPlanModeFromToolUse(toolName) {
      if (toolName === 'EnterPlanMode') {
        planActive = true
        return emitAll([planModeChanged(true, 'tool')])
      }
      if (toolName === 'ExitPlanMode' && mode === 'bypassPermissions') {
        planActive = false
        return emitAll([planModeChanged(false, 'tool')])
      }
      return []
    },
    enterPlanModeFromTool() {
      planActive = true
      return emitAll([
        planModeChanged(true, 'tool'),
        { type: 'enter_plan_mode', sessionId: options.sessionId },
      ])
    },
    setMode(nextMode, source = 'permission') {
      const wasPlanActive = planActive
      mode = nextMode
      planActive = nextMode === 'plan'
      if (wasPlanActive === planActive) return []
      return emitAll([planModeChanged(planActive, source)])
    },
    applyExitPlanApproval(result) {
      if (result.behavior !== 'allow' || !result.targetMode) return { events: [] }
      mode = result.targetMode
      planActive = false
      options.onPermissionModeChange?.(result.targetMode)
      return { targetMode: result.targetMode, events: emitAll([planModeChanged(false, 'permission')]) }
    },
    emitExitPlanRequest(request) {
      if (disposed) return
      options.emit({ type: 'exit_plan_mode_request', request })
    },
    dispose() {
      disposed = true
    },
  }
}

/**
 * 用共享 helper 能判定的部分构成默认计划只读策略。
 *
 * 明确不做的事：不在这里重新实现「允许只读工具清单 / Bash 只读命令 / 延迟工具」——
 * 那些规则目前只存在于旧 orchestrator 内部，必须提取为共享模块后由宿主注入
 * （见交付物 integration-requests.md 的 PLAN-TOOL-POLICY 项）。因此本函数对
 * 无法分类的工具返回 `undefined`，由门禁交回宿主既有权限判定。
 */
export function createSharedPlanModeToolPolicy(agentCwd?: string, planDir?: string): AgentRuntimePlanToolPolicy {
  return ({ toolName, toolInput }) => {
    if (isBrowserToolName(toolName)) {
      const decision = resolvePlanModeBrowserPermission(toolName)
      return decision.behavior === 'allow'
        ? { behavior: 'allow' }
        : { behavior: 'deny', message: decision.message }
    }
    if (isPlanModeMcpTool(toolName)) {
      return { behavior: 'deny', message: '计划模式下不允许调用 MCP 工具；请在计划审批通过后执行可能具有副作用的外部操作' }
    }
    if (toolName === 'Write' || toolName === 'Edit') {
      const filePath = typeof toolInput.file_path === 'string'
        ? toolInput.file_path
        : typeof toolInput.path === 'string'
          ? toolInput.path
          : ''
      if (agentCwd && filePath && isPlanModeMarkdownPath(agentCwd, filePath, planDir)) return { behavior: 'allow' }
      return { behavior: 'deny', message: '计划模式下仅允许写入当前会话 .context/plan/ 目录内的 Markdown 计划文件' }
    }
    return undefined
  }
}

export interface AgentRuntimePlanModeGateOptions {
  controller: AgentRuntimePlanModeController
  /** 宿主既有权限判定（权限端口 / 权限服务）；未分类工具与放行工具都走它。 */
  inner: RuntimeCanUseTool
  /** ExitPlanMode 审批通道：宿主权限端口的 handleExitPlanMode。 */
  requestExitPlanApproval(input: {
    toolInput: Record<string, unknown>
    signal: AbortSignal
  }): Promise<RuntimePermissionResult>
  /** 宿主计划只读策略；缺省时回落到控制器携带的策略，再回落到共享 helper 可判定的部分。 */
  planToolPolicy?: AgentRuntimePlanToolPolicy
}

/**
 * 计划模式门禁包装。
 *
 * 顺序与旧 orchestrator 的 `canUseTool` 一致：
 * EnterPlanMode/ExitPlanMode（含 bypassPermissions 的透明语义）→ plan 只读工具面 → 宿主判定。
 */
export function createPlanModeGatedCanUseTool(
  options: AgentRuntimePlanModeGateOptions,
): RuntimeCanUseTool {
  const { controller, inner, requestExitPlanApproval } = options
  const sharedPolicy = createSharedPlanModeToolPolicy(controller.getAgentCwd(), controller.getPlanDir())
  const hostPolicy = options.planToolPolicy ?? controller.getPlanToolPolicy()
  const planToolPolicy: AgentRuntimePlanToolPolicy = input =>
    hostPolicy?.(input) ?? sharedPolicy(input)

  return async (toolName, toolInput, canUseToolOptions) => {
    const mode = controller.getMode()

    if (toolName === 'EnterPlanMode' || toolName === 'ExitPlanMode') {
      // 完全自动模式：计划进入/退出透明化，保持无人值守语义。
      if (mode === 'bypassPermissions') {
        controller.syncPlanModeFromToolUse(toolName)
        return { behavior: 'allow', updatedInput: toolInput }
      }
      if (toolName === 'EnterPlanMode') {
        controller.enterPlanModeFromTool()
        return { behavior: 'allow', updatedInput: toolInput }
      }
      // auto/plan 下退出计划必须由用户审批；审批结果决定是否切换模式。
      const result = await requestExitPlanApproval({ toolInput, signal: canUseToolOptions.signal })
      controller.applyExitPlanApproval(result)
      return result
    }

    if (mode !== 'plan') return inner(toolName, toolInput, canUseToolOptions)

    const decision = planToolPolicy({ toolName, toolInput })
    if (!decision) return inner(toolName, toolInput, canUseToolOptions)
    if (decision.behavior === 'allow') return { behavior: 'allow', updatedInput: toolInput }
    return { behavior: 'deny', message: decision.message ?? '计划模式下不允许该操作' }
  }
}

/** 从有效策略快照创建本轮计划模式控制器（初始模式只能来自快照）。 */
export function createAgentRuntimePlanModeFromPolicy(options: {
  sessionId: string
  snapshot: AgentRuntimePolicySnapshot
  emit: AgentRuntimePlanModeEventSink
  agentCwd?: string
  planToolPolicy?: AgentRuntimePlanToolPolicy
  onPermissionModeChange?(mode: ProferPermissionMode): void
}): AgentRuntimePlanModeController {
  return createAgentRuntimePlanModeController({
    sessionId: options.sessionId,
    initialMode: options.snapshot.policy.permissionMode,
    emit: options.emit,
    ...(options.agentCwd ? { agentCwd: options.agentCwd } : {}),
    ...(options.planToolPolicy ? { planToolPolicy: options.planToolPolicy } : {}),
    ...(options.onPermissionModeChange ? { onPermissionModeChange: options.onPermissionModeChange } : {}),
  })
}

/**
 * 运行期控制器注册表。
 *
 * 权限端口按 sessionId 读取：入口注册即接线，运行结束/取消时清理。
 * 使用注册表而不是改 runtime 端口签名，是为了让「计划模式责任方」留在宿主侧，
 * 同时不需要改 runtime 公共契约。
 */
const planModeControllers = new Map<string, AgentRuntimePlanModeController>()

export function registerAgentRuntimePlanMode(controller: AgentRuntimePlanModeController): void {
  planModeControllers.set(controller.sessionId, controller)
}

export function getAgentRuntimePlanMode(sessionId: string): AgentRuntimePlanModeController | undefined {
  return planModeControllers.get(sessionId)
}

export function clearAgentRuntimePlanMode(sessionId: string): void {
  const controller = planModeControllers.get(sessionId)
  controller?.dispose()
  planModeControllers.delete(sessionId)
}

/** 仅测试用：清空注册表。 */
export function resetAgentRuntimePlanModeRegistry(): void {
  for (const controller of planModeControllers.values()) controller.dispose()
  planModeControllers.clear()
}
