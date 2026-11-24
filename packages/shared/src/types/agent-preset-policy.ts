/**
 * Agent 预设的有效运行策略。
 *
 * 该模块只包含与运行时无关的策略解释，不读取文件、不访问 Electron 或 MCP。
 * Manager 负责解析/合并预设；runtime 在一次 query 开始时创建并冻结本快照，
 * 后续会话切换只影响下一轮 query。
 */

import type {
  AgentPreset,
  AgentPresetScope,
  AgentPresetToolGroup,
  AgentPresetSuppressKey,
  PresetReference,
} from './agent-preset'
import type { AgentEffort, ProferPermissionMode } from './agent'
import { PROFER_DEFAULT_PERMISSION_MODE } from './agent'
import {
  AGENT_PRESET_CAPABILITY_GROUPS,
  AGENT_PRESET_TOOL_GROUP_SUPPRESS_MAP,
} from './agent-preset'

export type EffectiveAgentPresetPolicySource =
  | 'builtin'
  | 'global'
  | 'workspace'

export type EffectiveAgentPresetSnapshot = Omit<
  AgentPreset,
  'promptSections' | 'suppressPromptSections' | 'disabledToolGroups' | 'disabledTools' | 'skillSlugs' | 'mcpServerNames'
> & {
  readonly promptSections?: readonly string[]
  readonly suppressPromptSections?: readonly AgentPresetSuppressKey[]
  readonly disabledToolGroups?: readonly AgentPresetToolGroup[]
  readonly disabledTools?: readonly string[]
  readonly skillSlugs?: readonly string[]
  readonly mcpServerNames?: readonly string[]
}

export interface EffectiveAgentPresetPolicy {
  /** 当前运行使用的、已经完成基座合并的预设快照。 */
  readonly preset: EffectiveAgentPresetSnapshot
  /** 解析该预设时使用的稳定引用。 */
  readonly presetReference: Readonly<PresetReference>
  /** 组级禁用结果；allowSubagents=false 会统一折算为 collaboration。 */
  readonly disabledToolGroups: readonly AgentPresetToolGroup[]
  /** 单工具禁用结果；undefined 与空数组均表示没有单工具额外禁用。 */
  readonly disabledTools?: readonly string[]
  /** 预设显式隐藏段与组级禁用自动映射的并集。 */
  readonly suppressPromptSections: readonly AgentPresetSuppressKey[]
  /** undefined=不裁剪，空数组=不加载任何 Skill，非空数组=白名单。 */
  readonly allowedSkillSlugs?: readonly string[]
  /** undefined=不裁剪，空数组=不加载任何用户 MCP，非空数组=白名单。 */
  readonly allowedMcpServerNames?: readonly string[]
  /** 当前运行已经加载的 MCP 名称；由 runtime 注入完成后替换为新快照。 */
  readonly loadedMcpServerNames?: readonly string[]
  /** 预设对协作子 Agent 的策略意图；false 会统一禁用 collaboration 组。 */
  readonly allowSubagents: boolean
  /** runtime 理论能力；由编排器注入，不受预设本身伪造。 */
  readonly runtimeSupportsSubagents: boolean
  /** 当前 session 在 runtime 与预设门禁共同作用下的实际能力。 */
  readonly sessionCanUseSubagents: boolean
  readonly permissionMode: ProferPermissionMode
  readonly effort?: AgentEffort
  /** 会话级 PPT gate 结果；策略快照生成后不再随 UI 改变。 */
  readonly pptCapabilityActive: boolean
  readonly source: EffectiveAgentPresetPolicySource
}

export interface EffectiveAgentPresetPolicyOptions {
  /** 调用方请求的权限模式；只能保持或收紧预设声明的上限。 */
  permissionMode?: ProferPermissionMode
  /** 仅可信宿主根据已持久化的用户授权传入；可替换预设模式，不改变能力禁用。 */
  userPermissionMode?: ProferPermissionMode
  /** Profer 内部 Goal 循环需要保持无人值守权限语义。 */
  triggeredBy?: 'goal'
  pptCapabilityActive?: boolean
  loadedMcpServerNames?: readonly string[]
  /** runtime 理论上是否支持子 Agent；默认 false，避免静态信息意外放权。 */
  runtimeSupportsSubagents?: boolean
}

/**
 * 解析预设与调用方请求的最终权限模式。
 * 权限等级按 plan（最严格）→ auto → bypassPermissions（最宽松）排序，
 * 因此外部入口不能借由 override 静默放宽预设权限。
 */
export function resolveEffectivePermissionMode(
  presetPermissionMode: ProferPermissionMode | undefined,
  requestedOverride?: ProferPermissionMode,
): ProferPermissionMode {
  const presetMode = presetPermissionMode ?? PROFER_DEFAULT_PERMISSION_MODE
  if (!requestedOverride) return presetMode
  const strictness: Record<ProferPermissionMode, number> = {
    plan: 0,
    auto: 1,
    bypassPermissions: 2,
  }
  return strictness[requestedOverride] < strictness[presetMode] ? requestedOverride : presetMode
}

function sourceForScope(
  scope: AgentPresetScope | undefined,
): EffectiveAgentPresetPolicySource {
  if (scope === 'user-global') return 'global'
  if (scope === 'workspace') return 'workspace'
  return 'builtin'
}

function uniqueStrings(values: readonly string[] | undefined): readonly string[] {
  if (!values || values.length === 0) return Object.freeze([]) as readonly string[]
  return Object.freeze([...new Set(values)])
}

function clonePreset(preset: AgentPreset): EffectiveAgentPresetSnapshot {
  // 复制策略中会被 runtime 读取的数组，避免 Manager/UI 后续修改原对象污染当前 query。
  return Object.freeze({
    ...preset,
    ...(preset.promptSections !== undefined && {
      promptSections: Object.freeze([...preset.promptSections]),
    }),
    ...(preset.suppressPromptSections !== undefined && {
      suppressPromptSections: Object.freeze([...preset.suppressPromptSections]),
    }),
    ...(preset.disabledToolGroups !== undefined && {
      disabledToolGroups: Object.freeze([...preset.disabledToolGroups]),
    }),
    ...(preset.disabledTools !== undefined && {
      disabledTools: Object.freeze([...preset.disabledTools]),
    }),
    ...(preset.skillSlugs !== undefined && {
      skillSlugs: Object.freeze([...preset.skillSlugs]),
    }),
    ...(preset.mcpServerNames !== undefined && {
      mcpServerNames: Object.freeze([...preset.mcpServerNames]),
    }),
  })
}

/**
 * 从 Manager 已解析的预设创建一次 query 的不可变策略快照。
 *
 * 注意：这里刻意保留 undefined 与 [] 的区别，供 Skill/MCP loader 正确表达
 * “不裁剪”与“全部禁用”。permissionMode 的默认值与现有编排器一致。
 */
export function createEffectiveAgentPresetPolicy(
  preset: AgentPreset,
  presetReference: PresetReference,
  options: EffectiveAgentPresetPolicyOptions = {},
): EffectiveAgentPresetPolicy {
  const disabledToolGroups = new Set<AgentPresetToolGroup>(preset.disabledToolGroups ?? [])
  if (preset.allowSubagents === false || options.runtimeSupportsSubagents === false) {
    disabledToolGroups.add('collaboration')
  }

  const policy: EffectiveAgentPresetPolicy = {
    preset: clonePreset(preset),
    presetReference: Object.freeze({ ...presetReference }),
    disabledToolGroups: Object.freeze([...disabledToolGroups]),
    ...(preset.disabledTools !== undefined && {
      disabledTools: uniqueStrings(preset.disabledTools),
    }),
    suppressPromptSections: Object.freeze([
      ...new Set([
        ...(preset.suppressPromptSections ?? []),
        ...[...disabledToolGroups]
          .map((group) => AGENT_PRESET_TOOL_GROUP_SUPPRESS_MAP[group])
          .filter((key): key is AgentPresetSuppressKey => key !== undefined),
      ]),
    ]),
    ...(preset.skillSlugs !== undefined && {
      allowedSkillSlugs: uniqueStrings(preset.skillSlugs),
    }),
    ...(preset.mcpServerNames !== undefined && {
      allowedMcpServerNames: uniqueStrings(preset.mcpServerNames),
    }),
    ...(options.loadedMcpServerNames !== undefined && {
      loadedMcpServerNames: uniqueStrings(options.loadedMcpServerNames),
    }),
    allowSubagents: !disabledToolGroups.has('collaboration'),
    runtimeSupportsSubagents: options.runtimeSupportsSubagents === true,
    sessionCanUseSubagents: options.runtimeSupportsSubagents === true && !disabledToolGroups.has('collaboration'),
    // Goal 持续执行不改变用户或预设授予的权限级别。
    permissionMode: resolveEffectivePermissionMode(options.userPermissionMode ?? preset.permissionMode, options.permissionMode),
    ...(preset.effort !== undefined && { effort: preset.effort }),
    pptCapabilityActive: options.pptCapabilityActive === true,
    source: sourceForScope(presetReference.presetScope ?? preset.scope),
  }
  return Object.freeze(policy)
}

export function withLoadedMcpServerNames(
  policy: EffectiveAgentPresetPolicy,
  loadedMcpServerNames: readonly string[],
): EffectiveAgentPresetPolicy {
  return Object.freeze({
    ...policy,
    loadedMcpServerNames: uniqueStrings(loadedMcpServerNames),
  })
}

export function isEffectiveAgentPresetToolGroupDisabled(
  policy: EffectiveAgentPresetPolicy,
  group: AgentPresetToolGroup,
): boolean {
  return policy.disabledToolGroups.includes(group)
}

function shortToolName(toolName: string): string {
  return toolName.split('__').at(-1) ?? toolName
}

export function isEffectiveAgentPresetToolDisabled(
  policy: EffectiveAgentPresetPolicy,
  toolName: string,
): boolean {
  const shortName = shortToolName(toolName)
  if (policy.disabledTools?.includes(shortName) === true) return true
  return AGENT_PRESET_CAPABILITY_GROUPS.some(
    (group) => policy.disabledToolGroups.includes(group.id) && (group.toolNames as readonly string[]).includes(shortName),
  )
}

/** 返回包含组级禁用和单工具禁用的统一短名集合。 */
export function getEffectiveDisabledToolNames(
  policy: EffectiveAgentPresetPolicy,
): readonly string[] {
  const names = new Set(policy.disabledTools ?? [])
  for (const group of AGENT_PRESET_CAPABILITY_GROUPS) {
    if (policy.disabledToolGroups.includes(group.id)) {
      for (const toolName of group.toolNames) names.add(toolName)
    }
  }
  return Object.freeze([...names])
}

export function isEffectiveAgentPresetSkillAllowed(
  policy: EffectiveAgentPresetPolicy,
  skillSlug: string,
): boolean {
  return policy.allowedSkillSlugs === undefined || policy.allowedSkillSlugs.includes(skillSlug)
}

export function isEffectiveAgentPresetMcpServerAllowed(
  policy: EffectiveAgentPresetPolicy,
  serverName: string,
): boolean {
  return policy.allowedMcpServerNames === undefined || policy.allowedMcpServerNames.includes(serverName)
}
