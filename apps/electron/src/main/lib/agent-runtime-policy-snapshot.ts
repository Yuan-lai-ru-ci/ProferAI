/**
 * Electron 宿主侧的 runtime「有效策略快照」。
 *
 * 责任划分（与旧 orchestrator 对齐，但不复制规则）：
 * - 预设解析、基座合并、组级/单工具禁用、skill/MCP 白名单、权限模式上限，全部由
 *   `@profer/shared` 的 `createEffectiveAgentPresetPolicy` 与既有判定函数唯一实现；
 *   本模块只负责「一轮运行解析一次、冻结、传递到真正消费它的位置」。
 * - runtime core 不持有 Electron 产品策略：策略对象经 `AgentRuntimeQuery.providerInput`
 *   的宿主私有键传递，runtime 只做透传。
 * - 快照一旦生成即不可变；解析后的预设/设置变化只影响下一轮（`AgentRuntimePolicyRunRegistry`）。
 *
 * 为什么要有「run registry」：
 * 一轮运行里 provider preparation、工具装配、MCP/skill 过滤、权限端口会分别读取策略；
 * 如果它们各自解析，就会出现「同一轮里两套规则」。注册表按 runKey 缓存首次解析结果，
 * 保证同一轮始终是同一份对象，且下一轮能读到新配置。
 */

import {
  createEffectiveAgentPresetPolicy,
  getEffectiveDisabledToolNames,
  isEffectiveAgentPresetMcpServerAllowed,
  isEffectiveAgentPresetSkillAllowed,
  withLoadedMcpServerNames,
} from '@profer/shared'
import type {
  AgentPreset,
  EffectiveAgentPresetPolicy,
  PresetReference,
  ProferPermissionMode,
} from '@profer/shared'
import type { AgentRuntimeQuery } from '@profer/agent-runtime'

/** providerInput 中承载冻结策略快照的宿主私有键（runtime 只透传，不解释）。 */
export const AGENT_RUNTIME_POLICY_SNAPSHOT_KEY = 'agentRuntimePolicySnapshot'

/** 快照结构版本；读取端据此拒绝形状不符的旧对象。 */
export const AGENT_RUNTIME_POLICY_SNAPSHOT_VERSION = 1

/** 一轮运行冻结下来的有效策略快照。 */
export interface AgentRuntimePolicySnapshot {
  readonly version: typeof AGENT_RUNTIME_POLICY_SNAPSHOT_VERSION
  /** 共享层解析出的有效策略（已冻结，字段含义见 @profer/shared）。 */
  readonly policy: EffectiveAgentPresetPolicy
  readonly presetReference: Readonly<PresetReference>
  readonly presetName: string
  /** 解析时刻（毫秒）；用于诊断「本轮快照早于配置变更」。 */
  readonly resolvedAt: number
}

/** 解析快照所需的最小输入；权限模式等判定全部委托给共享实现。 */
export interface AgentRuntimePolicyResolutionInput {
  preset: AgentPreset
  presetReference: PresetReference
  /** 调用方请求的权限模式；共享实现只会保持或收紧预设上限。 */
  permissionModeOverride?: ProferPermissionMode
  /** Profer 内部 Goal 循环标记；不改变权限级别。 */
  triggeredBy?: 'goal'
  /** 宿主已判定的会话级 PPT 能力门禁结果（由既有 evaluatePptCapability + 组禁用组合得出）。 */
  pptCapabilityActive?: boolean
  loadedMcpServerNames?: readonly string[]
  /** runtime 理论能力；缺省 false，避免静态信息意外放权。 */
  runtimeSupportsSubagents?: boolean
  /** 可注入时钟，便于测试断言解析时刻。 */
  now?: () => number
}

/** 策略快照缺失：宿主入口必须在发起 run 前挂载，否则不允许静默按未知策略运行。 */
export class AgentRuntimePolicySnapshotMissingError extends Error {
  readonly code = 'AGENT_RUNTIME_POLICY_SNAPSHOT_MISSING'

  constructor(message = 'runtime 运行缺少有效策略快照：宿主入口必须在 run 前解析并挂载预设策略') {
    super(message)
    this.name = 'AgentRuntimePolicySnapshotMissingError'
  }
}

function freezeSnapshot(
  policy: EffectiveAgentPresetPolicy,
  presetReference: PresetReference,
  presetName: string,
  resolvedAt: number,
): AgentRuntimePolicySnapshot {
  return Object.freeze({
    version: AGENT_RUNTIME_POLICY_SNAPSHOT_VERSION,
    policy,
    presetReference: Object.freeze({ ...presetReference }),
    presetName,
    resolvedAt,
  })
}

/**
 * 解析一轮运行的有效策略快照。
 *
 * 唯一规则来源是 `createEffectiveAgentPresetPolicy`；本函数只补运行期元信息并冻结。
 */
export function resolveAgentRuntimePolicySnapshot(
  input: AgentRuntimePolicyResolutionInput,
): AgentRuntimePolicySnapshot {
  const policy = createEffectiveAgentPresetPolicy(input.preset, input.presetReference, {
    ...(input.permissionModeOverride ? { permissionMode: input.permissionModeOverride } : {}),
    ...(input.triggeredBy ? { triggeredBy: input.triggeredBy } : {}),
    ...(input.pptCapabilityActive !== undefined ? { pptCapabilityActive: input.pptCapabilityActive } : {}),
    ...(input.loadedMcpServerNames !== undefined ? { loadedMcpServerNames: input.loadedMcpServerNames } : {}),
    ...(input.runtimeSupportsSubagents !== undefined ? { runtimeSupportsSubagents: input.runtimeSupportsSubagents } : {}),
  })
  return freezeSnapshot(policy, input.presetReference, input.preset.name, input.now?.() ?? Date.now())
}

/** MCP 注入完成后刷新快照里的「已加载 MCP 名称」，其余字段保持同一份冻结策略。 */
export function withPolicyLoadedMcpServers(
  snapshot: AgentRuntimePolicySnapshot,
  loadedMcpServerNames: readonly string[],
): AgentRuntimePolicySnapshot {
  return freezeSnapshot(
    withLoadedMcpServerNames(snapshot.policy, loadedMcpServerNames),
    snapshot.presetReference,
    snapshot.presetName,
    snapshot.resolvedAt,
  )
}

/**
 * 把冻结快照挂到 query 上。
 *
 * - `permissionMode` 使用快照解析出的最终值（预设上限与合法覆盖的收敛结果）；
 * - 完整快照放在宿主私有键下，供工具装配 / MCP / skill / 权限端口读取同一份规则。
 */
export function attachAgentRuntimePolicyToQuery<T extends AgentRuntimeQuery>(
  query: T,
  snapshot: AgentRuntimePolicySnapshot,
): T {
  return {
    ...query,
    providerInput: {
      ...(query.providerInput ?? {}),
      permissionMode: snapshot.policy.permissionMode,
      [AGENT_RUNTIME_POLICY_SNAPSHOT_KEY]: snapshot,
    },
  }
}

function isPolicySnapshot(value: unknown): value is AgentRuntimePolicySnapshot {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<AgentRuntimePolicySnapshot>
  if (candidate.version !== AGENT_RUNTIME_POLICY_SNAPSHOT_VERSION) return false
  const policy = candidate.policy as EffectiveAgentPresetPolicy | undefined
  return !!policy && typeof policy === 'object' && typeof policy.permissionMode === 'string'
}

/** 读取宿主挂载的冻结快照；形状不符（含旧版本）一律视为缺失。 */
export function readAgentRuntimePolicySnapshot(
  providerInput: Readonly<Record<string, unknown>> | undefined,
): AgentRuntimePolicySnapshot | undefined {
  const value = providerInput?.[AGENT_RUNTIME_POLICY_SNAPSHOT_KEY]
  return isPolicySnapshot(value) ? value : undefined
}

/** 入口侧守卫：没有快照就明确失败，而不是按未知策略继续跑。 */
export function requireAgentRuntimePolicySnapshot(
  providerInput: Readonly<Record<string, unknown>> | undefined,
): AgentRuntimePolicySnapshot {
  const snapshot = readAgentRuntimePolicySnapshot(providerInput)
  if (!snapshot) throw new AgentRuntimePolicySnapshotMissingError()
  return snapshot
}

const PERMISSION_MODES: readonly ProferPermissionMode[] = ['plan', 'auto', 'bypassPermissions']

/** 读取调用方显式给出的权限模式；仅接受三个合法值，其余（含缺失）返回 undefined。 */
export function readExplicitPermissionMode(
  providerInput: Readonly<Record<string, unknown>> | undefined,
): ProferPermissionMode | undefined {
  const value = providerInput?.permissionMode
  return typeof value === 'string' && (PERMISSION_MODES as readonly string[]).includes(value)
    ? (value as ProferPermissionMode)
    : undefined
}

/**
 * 去掉宿主私有快照键，得到可以交给 provider 的 options。
 *
 * 快照只在宿主内部（runtime query / 工具装配 / 资源过滤 / 权限端口）使用；
 * provider 边界只保留 `permissionMode` 这类 provider 能理解的字段，
 * 避免把产品策略对象泄露给 provider 实现。
 */
export function stripAgentRuntimePolicyFromProviderInput(
  providerInput: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> {
  if (!providerInput) return {}
  const rest: Record<string, unknown> = { ...providerInput }
  delete rest[AGENT_RUNTIME_POLICY_SNAPSHOT_KEY]
  return rest
}

/**
 * 交给 provider 的权限模式：优先取冻结策略（已包含合法覆盖），否则只认显式合法覆盖。
 *
 * 两者都没有时返回 undefined —— 本模块刻意不提供任何默认值：
 * 既不能凭空放宽（禁止策略缺失即放行），也不能用 provider preparation 猜一个默认值。
 */
export function resolveProviderPermissionMode(
  providerInput: Readonly<Record<string, unknown>> | undefined,
): ProferPermissionMode | undefined {
  const snapshot = readAgentRuntimePolicySnapshot(providerInput)
  if (snapshot) return snapshot.policy.permissionMode
  return readExplicitPermissionMode(providerInput)
}

/** 工具装配 context 中由策略决定的字段（其余字段由宿主按原样透传）。 */
export interface AgentRuntimePolicyToolAssemblyFields {
  allowedMcpServerNames?: readonly string[]
  permissionMode: ProferPermissionMode
  disabledToolGroups: readonly string[]
  disabledTools: readonly string[]
  pptCapabilityActive: boolean
  /** 供 `PiBuiltinToolsContext.disabledToolGroups` 等消费方使用的组级禁用快照。 */
  policyPresetName: string
}

/**
 * 把策略字段并入工具装配 context。
 *
 * 这是「策略 → 最终注册工具」的唯一接缝：装配实现（PiBuiltinToolsContext 等）读取这些
 * 字段决定注册哪些工具，因此必须在装配前合并，而不是在 provider preparation 里另算一遍。
 */
export function buildPolicyToolAssemblyContext<T extends Record<string, unknown>>(
  snapshot: AgentRuntimePolicySnapshot,
  base: T,
): T & AgentRuntimePolicyToolAssemblyFields {
  return {
    ...base,
    allowedMcpServerNames: snapshot.policy.allowedMcpServerNames,
    permissionMode: snapshot.policy.permissionMode,
    disabledToolGroups: [...snapshot.policy.disabledToolGroups],
    disabledTools: snapshot.policy.disabledTools ? [...snapshot.policy.disabledTools] : [],
    pptCapabilityActive: snapshot.policy.pptCapabilityActive,
    policyPresetName: snapshot.presetName,
  }
}

/** Skill 可见性：只暴露预设白名单内的 slug（undefined = 不裁剪）。 */
export function filterPolicySkills(
  snapshot: AgentRuntimePolicySnapshot,
  skills: readonly string[],
): readonly string[] {
  return Object.freeze(skills.filter(skill => isEffectiveAgentPresetSkillAllowed(snapshot.policy, skill)))
}

/** MCP 可见性：预设白名单裁剪，产品内置 MCP 不在本函数管辖范围（由注入点决定）。 */
export function filterPolicyMcpResources<T extends { name?: string }>(
  snapshot: AgentRuntimePolicySnapshot,
  resources: readonly T[],
): readonly T[] {
  return Object.freeze(resources.filter(resource =>
    typeof resource?.name !== 'string' || isEffectiveAgentPresetMcpServerAllowed(snapshot.policy, resource.name),
  ))
}

/**
 * Claude 侧 `disallowedTools`：组级禁用 + 单工具禁用的统一短名集合。
 * 与 Pi 的「不注册」等价，避免两套 runtime 对同一预设给出不同工具面。
 */
export function collectPolicyDisallowedTools(snapshot: AgentRuntimePolicySnapshot): readonly string[] {
  return getEffectiveDisabledToolNames(snapshot.policy)
}

/** 一轮运行的策略注册表：按 runKey 冻结，同一轮重复读取不会重新解析。 */
export interface AgentRuntimePolicyRunRegistry {
  /** 首次解析后缓存；同一 runKey 再次调用直接返回同一对象。 */
  resolveForRun(runKey: string, input: AgentRuntimePolicyResolutionInput): AgentRuntimePolicySnapshot
  getForRun(runKey: string): AgentRuntimePolicySnapshot | undefined
  /** 运行结束 / 取消时释放，避免长期持有快照。 */
  releaseRun(runKey: string): void
  /** 累计解析次数（诊断与「一轮只解析一次」断言）。 */
  resolutionCount(): number
  clear(): void
}

export function createAgentRuntimePolicyRunRegistry(): AgentRuntimePolicyRunRegistry {
  const runs = new Map<string, AgentRuntimePolicySnapshot>()
  let resolutions = 0
  return {
    resolveForRun(runKey, input) {
      const existing = runs.get(runKey)
      if (existing) return existing
      resolutions += 1
      const snapshot = resolveAgentRuntimePolicySnapshot(input)
      runs.set(runKey, snapshot)
      return snapshot
    },
    getForRun(runKey) {
      return runs.get(runKey)
    },
    releaseRun(runKey) {
      runs.delete(runKey)
    },
    resolutionCount() {
      return resolutions
    },
    clear() {
      runs.clear()
    },
  }
}

/** 默认注册表实例：宿主入口（agent-service / runtime host）使用同一实例即可获得「一轮一份」语义。 */
export const agentRuntimePolicyRuns: AgentRuntimePolicyRunRegistry = createAgentRuntimePolicyRunRegistry()
