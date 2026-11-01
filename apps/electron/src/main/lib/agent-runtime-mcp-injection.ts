/**
 * agent-runtime-mcp-injection —— 产品内置 MCP 服务器的注入端口（GAP-4）。
 *
 * 背景：旧编排层在 `promptMode === 'standard'` 分支里直接 `await injectXxxMcpServer(...)`
 * 一串内置服务器（automation / memory-archive / collaboration / task-graph / goal / preset /
 * planning）。新 runtime 路径只把「工作区用户 MCP」经 resource port 转成 `mcpServers`，
 * 产品内置能力对模型完全不可见。
 *
 * 本模块提供三件事，且**不复制**编排层的注入分支：
 * 1. `planBuiltinMcpServers` —— 纯决策函数：给定本轮上下文（提示词模式 / 预设禁用工具组 /
 *    runtime / 上下文可用性），返回「应该注册哪些内置服务器、为什么」。没有任何副作用与宿主依赖。
 * 2. `BuiltinMcpInjectionPort` —— 端口契约：由**宿主**提供实现（`createElectronBuiltinMcpInjectionPort`
 *    是 Electron 宿主的默认实现）。runtime core 与 provider 只透传 `mcpServers`，不认识任何服务器名。
 * 3. `runBuiltinMcpInjection` —— 统一执行器：缺端口、计划失败、单个注入器抛错或静默无产物，
 *    一律按「该能力不可用」记录在 outcome 里，**既不静默放行、也不整体失败**。
 *
 * 行为等价性由 `agent-runtime-mcp-injection.parity.test.ts` 用**真实旧源码切片**逐项对照
 * （比较最终注入的服务器集合与顺序，而不是比较对象里有几个字段）。
 */

import type { AgentGoalIterationResult, AgentRuntime, PresetReference, ProferPermissionMode } from '@profer/shared'
import type {
  AgentPresetMutationOperation,
  AgentPresetOperationSource,
  PendingPresetChange,
} from './agent-preset-operations'

/** Claude Agent SDK 命名空间（in-process MCP 服务器构造器）。类型位置只在编译期使用。 */
export type ClaudeSdkNamespace = typeof import('@anthropic-ai/claude-agent-sdk')

/** 待注册的 MCP 服务器表（键即服务器名）。 */
export type McpServerTable = Record<string, Record<string, unknown>>

/**
 * 产品内置 MCP 服务器 id。
 *
 * 这些 id **同时**是注册进 `mcpServers` 的键（旧链与 provider 都按这个名字可见），
 * 因此 id 与键必须一致；`agent-runtime-mcp-injection.parity.test.ts` 对每条注入断言这一点。
 */
export type BuiltinMcpServerId =
  | 'automation'
  | 'memory-archive'
  | 'collaboration'
  | 'task-graph'
  | 'goal'
  | 'agent-presets'
  | 'planning'

/** 旧编排层的注入顺序（逐条一致，顺序影响 `Object.keys(mcpServers)` 与诊断输出）。 */
export const BUILTIN_MCP_INJECTION_ORDER: readonly BuiltinMcpServerId[] = Object.freeze([
  'automation',
  'memory-archive',
  'collaboration',
  'task-graph',
  'goal',
  'agent-presets',
  'planning',
])

/** 该服务器**不在计划内**的原因（策略结果，不是失败）。 */
export type BuiltinMcpSkipReason =
  /** `promptMode === 'light'`：旧链整块跳过内置注入。 */
  | 'prompt-mode-light'
  /** 预设禁用了对应工具组（automation / memory / collaboration / task-graph）。 */
  | 'tool-group-disabled'
  /** 该服务器只对特定 runtime 可用（goal / planning 目前只注入 claude）。 */
  | 'runtime-unsupported'
  /** 本轮上下文缺少该服务器必需的事实（如 goal 报告回调、工作区 memory-archive 路径）。 */
  | 'context-missing'

/** 计划内但最终**不可用**的原因（失败，必须记录）。 */
export type BuiltinMcpUnavailableReason =
  /** 宿主没有提供注入端口实现。 */
  | 'port-missing'
  /** 端口的计划函数抛错，本轮无法判断该注入什么。 */
  | 'plan-failed'
  /** 单个注入器抛错；其余服务器不受影响。 */
  | 'injector-failed'
  /** 注入器正常返回但没有注册任何服务器（例如缺少必需上下文时的提前 return）。 */
  | 'injector-noop'

/** 计划输入：只包含**决定是否注入**的事实，不含任何宿主状态。 */
export interface BuiltinMcpPlanInput {
  /** 提示词模式；旧链只在 standard 下注入内置 MCP。 */
  promptMode: 'light' | 'standard'
  runtime: AgentRuntime
  /** 预设解析出的禁用工具组（`EffectiveAgentPresetPolicy.disabledToolGroups`）。 */
  disabledToolGroups: readonly string[]
  /** 本轮是否存在工作区 memory-archive 路径（旧链由 workspaceSlug 决定）。 */
  hasMemoryArchive: boolean
  /** 本轮是否提供 Goal 报告回调（新路径不迁移 Goal 回调面，缺省即不注入）。 */
  hasGoalReport: boolean
}

/** 单个内置服务器的计划条目。 */
export interface BuiltinMcpPlanEntry {
  id: BuiltinMcpServerId
  /** 策略是否允许注册。注意：`enabled` 只表达策略结论，最终是否可用见 outcome。 */
  enabled: boolean
  reason: 'enabled' | BuiltinMcpSkipReason
}

/**
 * 纯决策函数：本轮应该注册哪些产品内置 MCP 服务器。
 *
 * 规则与旧编排层逐条对齐（见 `plan-mode` 无关的注入块）：
 * - `automation`：standard 且未禁用 `automation` 组；
 * - `memory-archive`：standard、未禁用 `memory` 组、且存在 memory-archive 路径；
 * - `collaboration`：standard 且未禁用 `collaboration` 组；
 * - `task-graph`：standard 且未禁用 `task-graph` 组；
 * - `goal`：standard、runtime 为 claude、且提供 Goal 报告回调；
 * - `agent-presets`：standard（无条件；注册键就是 `agent-presets`，不是 `preset`）；
 * - `planning`：standard、runtime 为 claude、且未禁用 `automation` 组（规划工具属该组）。
 */
export function planBuiltinMcpServers(input: BuiltinMcpPlanInput): readonly BuiltinMcpPlanEntry[] {
  const standard = input.promptMode === 'standard'
  const disabled = new Set(input.disabledToolGroups)
  const isClaude = input.runtime === 'claude'

  const decide = (
    id: BuiltinMcpServerId,
    enabled: boolean,
    reason: BuiltinMcpSkipReason,
  ): BuiltinMcpPlanEntry => ({ id, enabled, reason: enabled ? 'enabled' : reason })

  const entries: Record<BuiltinMcpServerId, BuiltinMcpPlanEntry> = {
    automation: decide('automation', standard && !disabled.has('automation'), standard ? 'tool-group-disabled' : 'prompt-mode-light'),
    'memory-archive': decide(
      'memory-archive',
      standard && !disabled.has('memory') && input.hasMemoryArchive,
      !standard ? 'prompt-mode-light' : disabled.has('memory') ? 'tool-group-disabled' : 'context-missing',
    ),
    collaboration: decide('collaboration', standard && !disabled.has('collaboration'), standard ? 'tool-group-disabled' : 'prompt-mode-light'),
    'task-graph': decide('task-graph', standard && !disabled.has('task-graph'), standard ? 'tool-group-disabled' : 'prompt-mode-light'),
    goal: decide('goal', standard && isClaude && input.hasGoalReport, !standard ? 'prompt-mode-light' : !isClaude ? 'runtime-unsupported' : 'context-missing'),
    'agent-presets': decide('agent-presets', standard, 'prompt-mode-light'),
    planning: decide('planning', standard && isClaude && !disabled.has('automation'), !standard ? 'prompt-mode-light' : !isClaude ? 'runtime-unsupported' : 'tool-group-disabled'),
  }

  return Object.freeze(BUILTIN_MCP_INJECTION_ORDER.map(id => entries[id]))
}

/** 本轮注入所需的完整上下文（决定项之外的「构造参数」都在这里）。 */
export interface BuiltinMcpInjectionContext {
  sessionId: string
  /** Ledger 准入后注入的业务 Run 引用；不接受任务正文自述。 */
  sourceRunId?: string
  channelId: string
  modelId?: string
  workspaceId?: string
  workspaceSlug?: string
  runtime: AgentRuntime
  /** 运行来源；同时作为预设操作的 source（旧链 `input.triggeredBy ?? 'user'`）。 */
  triggeredBy?: AgentPresetOperationSource
  /** 显式权限模式覆盖（旧链把它透传给 collaboration 上下文）。 */
  permissionModeOverride?: ProferPermissionMode
  /** 预设禁用的单工具短名。 */
  disabledTools?: readonly string[]
  /** 预设操作上下文（preset 服务器专用）。 */
  preset: {
    source: AgentPresetOperationSource
    allowedOperations: readonly AgentPresetMutationOperation[]
    currentPresetReference?: PresetReference
    userMessage?: string
    pendingChange?: PendingPresetChange
  }
  /** Goal 报告回调；仅 claude + 提供时注入 goal 服务器。 */
  goal?: {
    iteration: number
    report: (result: AgentGoalIterationResult) => void
  }
}

/** 由上下文推导计划输入（把「构造参数」与「决定项」分开，避免调用方各自解释规则）。 */
export function builtinMcpPlanInputFromContext(
  context: BuiltinMcpInjectionContext,
  promptMode: 'light' | 'standard',
  disabledToolGroups: readonly string[],
): BuiltinMcpPlanInput {
  return {
    promptMode,
    runtime: context.runtime,
    disabledToolGroups,
    hasMemoryArchive: typeof context.workspaceSlug === 'string' && context.workspaceSlug.length > 0,
    hasGoalReport: context.goal !== undefined,
  }
}

/** 单轮注入请求。 */
export interface BuiltinMcpInjectionRequest {
  context: BuiltinMcpInjectionContext
  /** 待写入的 MCP 服务器表（就地修改，与旧链同一张表）。 */
  mcpServers: McpServerTable
  /** Claude Agent SDK 命名空间；由宿主加载（旧链同样在 provider 前加载）。 */
  sdk: ClaudeSdkNamespace
  /** 计划输入；缺省由 `context` + 调用方给出的 promptMode/禁用组推导。 */
  planInput: BuiltinMcpPlanInput
}

/**
 * 注入端口契约。
 *
 * 由宿主提供实现：`plan` 决定注册哪些服务器，`inject` 负责把单个服务器写进 `mcpServers`。
 * 端口实现不得自行吞掉失败（抛错由执行器统一记录），也不得改动其他服务器的产物。
 */
export interface BuiltinMcpInjectionPort {
  plan(input: BuiltinMcpPlanInput): readonly BuiltinMcpPlanEntry[]
  inject(entry: BuiltinMcpPlanEntry, request: BuiltinMcpInjectionRequest): Promise<void>
}

/** 单轮注入结果：计划内 / 未启用 / 计划内但不可用，三者互斥且可逐条审计。 */
export interface BuiltinMcpInjectionOutcome {
  /** 宿主是否提供注入端口。 */
  portAvailable: boolean
  /** 实际注册进 `mcpServers` 的服务器（按注入顺序）。 */
  injected: readonly BuiltinMcpServerId[]
  /** 策略不允许、因此未注册的服务器。 */
  skipped: readonly { id: BuiltinMcpServerId; reason: BuiltinMcpSkipReason }[]
  /** 策略允许、但最终不可用的服务器（必须记录，不得静默当作已注入）。 */
  unavailable: readonly { id: BuiltinMcpServerId; reason: BuiltinMcpUnavailableReason; detail?: string }[]
}

/** 端口缺失时的日志前缀，保证「能力不可用」在宿主日志里可被检索。 */
export const BUILTIN_MCP_UNAVAILABLE_LOG_PREFIX = '[Agent 内置 MCP] 能力不可用'

/** 默认空计划：端口缺失 / 计划失败时使用，避免调用方各自构造。 */
const EMPTY_PLAN: readonly BuiltinMcpPlanEntry[] = Object.freeze([])

/**
 * 统一执行器。
 *
 * 语义（逐条对应 GAP-4 要求 3）：
 * - 端口缺失：`portAvailable=false`，计划内的服务器全部记为 `port-missing`；不抛错、不静默。
 * - 计划抛错：记为 `plan-failed`（逐条），不整体失败。
 * - 单个注入器抛错：只把该条记为 `injector-failed`，其余继续。
 * - 注入器无产物：记为 `injector-noop`（例如缺少必需上下文时的提前 return）。
 *
 * 判定「是否真的注册了」用的是 `mcpServers` 的实际键，而不是注入器返回值，
 * 因此「看起来调用了、实际没注册」不会被当成成功。
 */
export async function runBuiltinMcpInjection(
  port: BuiltinMcpInjectionPort | undefined,
  request: BuiltinMcpInjectionRequest,
): Promise<BuiltinMcpInjectionOutcome> {
  const planInput = request.planInput

  if (!port) {
    const planned = planBuiltinMcpServers(planInput).filter(entry => entry.enabled)
    return {
      portAvailable: false,
      injected: [],
      skipped: skippedOf(planBuiltinMcpServers(planInput)),
      unavailable: planned.map(entry => ({ id: entry.id, reason: 'port-missing' as const })),
    }
  }

  let plan: readonly BuiltinMcpPlanEntry[]
  try {
    plan = port.plan(planInput)
  } catch (error) {
    plan = EMPTY_PLAN
    return {
      portAvailable: true,
      injected: [],
      skipped: [],
      unavailable: BUILTIN_MCP_INJECTION_ORDER.map(id => ({
        id,
        reason: 'plan-failed' as const,
        detail: describeError(error),
      })),
    }
  }

  const injected: BuiltinMcpServerId[] = []
  const unavailable: Array<{ id: BuiltinMcpServerId; reason: BuiltinMcpUnavailableReason; detail?: string }> = []

  for (const entry of plan) {
    if (!entry.enabled) continue
    try {
      await port.inject(entry, request)
    } catch (error) {
      unavailable.push({ id: entry.id, reason: 'injector-failed', detail: describeError(error) })
      continue
    }
    if (Object.prototype.hasOwnProperty.call(request.mcpServers, entry.id)) {
      injected.push(entry.id)
    } else {
      unavailable.push({ id: entry.id, reason: 'injector-noop' })
    }
  }

  return { portAvailable: true, injected, skipped: skippedOf(plan), unavailable }
}

function skippedOf(plan: readonly BuiltinMcpPlanEntry[]): readonly { id: BuiltinMcpServerId; reason: BuiltinMcpSkipReason }[] {
  return plan
    .filter((entry): entry is BuiltinMcpPlanEntry & { reason: BuiltinMcpSkipReason } => !entry.enabled)
    .map(entry => ({ id: entry.id, reason: entry.reason }))
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 单个内置注入器的调用签名。
 *
 * `sdk` 与 `mcpServers` 是公共前两位；其余位置参数与真实注入函数一一对应，
 * 由 `buildBuiltinMcpInjectorArgs` 构造（上下文构造的唯一实现）。
 */
export type BuiltinMcpInjector = (
  sdk: ClaudeSdkNamespace,
  mcpServers: McpServerTable,
  ...args: readonly unknown[]
) => Promise<void>

export interface ElectronBuiltinMcpInjectionDeps {
  /** 覆盖默认注入器（测试取证 / 宿主替换）。7 条全部提供时不会加载生产注入器模块。 */
  injectors?: Partial<Record<BuiltinMcpServerId, BuiltinMcpInjector>>
  /** memory-archive 路径解析；缺省使用真实工作区实现。 */
  resolveMemoryArchivePath?(workspaceSlug: string): string | Promise<string>
}

function disabledToolsOf(context: BuiltinMcpInjectionContext): string[] | undefined {
  return context.disabledTools !== undefined ? [...context.disabledTools] : undefined
}

/**
 * 构造某个内置注入器的位置参数（= 真实注入函数签名去掉前两位）。
 *
 * 逐条与旧编排层传入的对象一致（旧链的字段是**无条件**给出的，undefined 也占位）：
 * - `automation`：`[{sessionId, channelId, modelId, workspaceId, triggeredBy}, disabledTools]`
 * - `memory-archive`：`[{memoryArchivePath, workspaceSlug}, disabledTools]`
 * - `collaboration`：`[{sessionId, channelId, modelId, workspaceId, permissionMode, triggeredBy}, disabledTools]`
 * - `task-graph`：`[{sessionId}, disabledTools]`
 * - `goal`：`[{iteration, report}]`
 * - `preset`：`[{sessionId, workspaceSlug, source, allowedOperations, currentPresetReference, userMessage, pendingChange}]`（注册键为 `agent-presets`）
 * - `planning`：`[{sessionId, workspaceId, disabledTools}]`
 *
 * 这是宿主适配层与测试取证**共用**的构造器：测试可以比较真实注入函数收到的参数，
 * 而不是比较一份适配层副本。
 */
export async function buildBuiltinMcpInjectorArgs(
  id: BuiltinMcpServerId,
  request: BuiltinMcpInjectionRequest,
  resolveMemoryArchivePath: (workspaceSlug: string) => string | Promise<string>,
): Promise<readonly unknown[]> {
  const ctx = request.context
  const disabledTools = disabledToolsOf(ctx)

  switch (id) {
    case 'automation':
      return [
        {
          sessionId: ctx.sessionId,
          ...(ctx.sourceRunId ? { sourceRunId: ctx.sourceRunId } : {}),
          channelId: ctx.channelId,
          modelId: ctx.modelId,
          workspaceId: ctx.workspaceId,
          // 旧链按运行时值原样透传（`as 'user' | 'automation' | undefined` 只是类型收窄）。
          triggeredBy: ctx.triggeredBy as 'user' | 'automation' | undefined,
        },
        disabledTools,
      ]
    case 'memory-archive': {
      const memoryArchivePath = ctx.workspaceSlug ? await resolveMemoryArchivePath(ctx.workspaceSlug) : undefined
      return [{ memoryArchivePath, workspaceSlug: ctx.workspaceSlug }, disabledTools]
    }
    case 'collaboration':
      return [
        {
          sessionId: ctx.sessionId,
          ...(ctx.sourceRunId ? { sourceRunId: ctx.sourceRunId } : {}),
          channelId: ctx.channelId,
          modelId: ctx.modelId,
          workspaceId: ctx.workspaceId,
          permissionMode: ctx.permissionModeOverride,
          triggeredBy: ctx.triggeredBy,
        },
        disabledTools,
      ]
    case 'task-graph':
      return [{ sessionId: ctx.sessionId }, disabledTools]
    case 'goal':
      return [{ iteration: ctx.goal?.iteration ?? 0, report: ctx.goal?.report }]
    case 'agent-presets':
      return [
        {
          sessionId: ctx.sessionId,
          workspaceSlug: ctx.workspaceSlug,
          source: ctx.preset.source,
          allowedOperations: [...ctx.preset.allowedOperations],
          currentPresetReference: ctx.preset.currentPresetReference,
          userMessage: ctx.preset.userMessage,
          pendingChange: ctx.preset.pendingChange,
        },
      ]
    case 'planning':
      return [{ sessionId: ctx.sessionId, workspaceId: ctx.workspaceId, disabledTools }]
    default: {
      const exhaustive: never = id
      throw new Error(`未知内置 MCP 服务器: ${String(exhaustive)}`)
    }
  }
}

/**
 * 生产注入器（懒加载）。
 *
 * 为什么必须懒加载而不是模块顶层 import：`agent-orchestrator → agent-collaboration-tools →
 * agent-service → agent-orchestrator` 是已知的模块循环（GAP-7 E3）。以
 * `agent-collaboration-tools` 为入口进入循环会在 `new AgentOrchestrator()` 处抛 TDZ 错误；
 * 生产上入口始终是 `agent-service`（已完整求值），因此调用期动态 import 一定安全，
 * 同时让本模块「只 import 而不调用」时保持零副作用（测试可直接加载）。
 */
async function loadDefaultInjectors(): Promise<Record<BuiltinMcpServerId, BuiltinMcpInjector>> {
  const [automation, memoryArchive, collaboration, taskGraph, goal, preset, planning] = await Promise.all([
    import('./automation-agent-tools'),
    import('./memory-archive-agent-tools'),
    import('./agent-collaboration-tools'),
    import('./task-graph-agent-tools'),
    import('./goal-tools'),
    import('./agent-preset-tools'),
    import('./planning-agent-tools'),
  ])

  return {
    automation: (sdk, mcpServers, ...args) => automation.injectAutomationMcpServer(
      sdk,
      mcpServers,
      args[0] as Parameters<typeof automation.injectAutomationMcpServer>[2],
      args[1] as Parameters<typeof automation.injectAutomationMcpServer>[3],
    ),
    'memory-archive': (sdk, mcpServers, ...args) => memoryArchive.injectMemoryArchiveMcpServer(
      sdk,
      mcpServers,
      args[0] as Parameters<typeof memoryArchive.injectMemoryArchiveMcpServer>[2],
      args[1] as Parameters<typeof memoryArchive.injectMemoryArchiveMcpServer>[3],
    ),
    collaboration: (sdk, mcpServers, ...args) => collaboration.injectAgentCollaborationMcpServer(
      sdk,
      mcpServers,
      args[0] as Parameters<typeof collaboration.injectAgentCollaborationMcpServer>[2],
      args[1] as Parameters<typeof collaboration.injectAgentCollaborationMcpServer>[3],
    ),
    'task-graph': (sdk, mcpServers, ...args) => taskGraph.injectTaskGraphMcpServer(
      sdk,
      mcpServers,
      args[0] as Parameters<typeof taskGraph.injectTaskGraphMcpServer>[2],
      args[1] as Parameters<typeof taskGraph.injectTaskGraphMcpServer>[3],
    ),
    goal: (sdk, mcpServers, ...args) => goal.injectGoalMcpServer(
      sdk,
      mcpServers,
      args[0] as Parameters<typeof goal.injectGoalMcpServer>[2],
    ),
    'agent-presets': (sdk, mcpServers, ...args) => preset.injectAgentPresetMcpServer(
      sdk,
      mcpServers,
      args[0] as Parameters<typeof preset.injectAgentPresetMcpServer>[2],
    ),
    planning: (sdk, mcpServers, ...args) => planning.injectPlanningMcpServer(
      sdk,
      mcpServers,
      args[0] as Parameters<typeof planning.injectPlanningMcpServer>[2],
    ),
  }
}

/**
 * Electron 宿主的默认端口实现。
 *
 * - `plan` 直接复用纯函数 `planBuiltinMcpServers`（规则唯一来源，宿主不得再写一份条件）；
 * - `inject` 用 `buildBuiltinMcpInjectorArgs` 构造参数后调用注入器；
 * - 注入器模块懒加载（见 `loadDefaultInjectors` 说明），因此本工厂本身零副作用。
 */
export function createElectronBuiltinMcpInjectionPort(
  deps: ElectronBuiltinMcpInjectionDeps = {},
): BuiltinMcpInjectionPort {
  const resolveMemoryArchivePath = deps.resolveMemoryArchivePath
    ?? (async (workspaceSlug: string): Promise<string> => {
      const { getWorkspaceMemoryArchivePath } = await import('./agent-workspace-manager')
      return getWorkspaceMemoryArchivePath(workspaceSlug)
    })

  let injectorsPromise: Promise<Record<BuiltinMcpServerId, BuiltinMcpInjector>> | undefined
  const loadInjectors = (): Promise<Record<BuiltinMcpServerId, BuiltinMcpInjector>> => {
    injectorsPromise ??= (async () => {
      const overrides = deps.injectors ?? {}
      const missing = BUILTIN_MCP_INJECTION_ORDER.filter(id => !overrides[id])
      const defaults = missing.length > 0 ? await loadDefaultInjectors() : undefined
      return Object.fromEntries(
        BUILTIN_MCP_INJECTION_ORDER.map(id => [id, overrides[id] ?? defaults?.[id]]),
      ) as Record<BuiltinMcpServerId, BuiltinMcpInjector>
    })()
    return injectorsPromise
  }

  return {
    plan: input => planBuiltinMcpServers(input),
    async inject(entry, request) {
      const injector = (await loadInjectors())[entry.id]
      if (!injector) throw new Error(`内置 MCP 服务器缺少注入器: ${entry.id}`)
      const args = await buildBuiltinMcpInjectorArgs(entry.id, request, resolveMemoryArchivePath)
      await injector(request.sdk, request.mcpServers, ...args)
    },
  }
}
