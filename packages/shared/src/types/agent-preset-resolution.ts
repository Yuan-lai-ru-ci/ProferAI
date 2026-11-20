import { AgentPresetError, BUILTIN_AGENT_PRESETS, mergeAgentPreset, AGENT_PRESET_TOOL_GROUP_SUPPRESS_MAP } from './agent-preset'
import type { AgentPreset, AgentPresetConfig, GlobalAgentPresetConfig, PresetReference, AgentPresetSuppressKey } from './agent-preset'

/** 宿主只提供所属Core/工作区的数据，严格引用与继承规则由此唯一实现。 */
export interface PresetResolutionStore {
  readGlobal(): GlobalAgentPresetConfig
  readWorkspace(slug: string): Pick<AgentPresetConfig, 'presets' | 'disabledGlobalPresetIds' | 'disabledWorkspacePresetIds'>
}

export function normalizeAgentPresetReference(reference: PresetReference, contextWorkspaceSlug?: string): PresetReference {
  if (!reference || typeof reference.presetId !== 'string' || !reference.presetId.trim()) throw new AgentPresetError('PRESET_UNKNOWN_REFERENCE', '预设引用缺少有效 presetId')
  if (!['builtin-meta', 'user-global', 'workspace'].includes(reference.presetScope)) throw new AgentPresetError('PRESET_UNKNOWN_REFERENCE', `未知预设作用域: ${String(reference.presetScope)}`)
  if (reference.presetScope === 'workspace') {
    const workspaceSlug = contextWorkspaceSlug || reference.workspaceSlug
    if (!workspaceSlug) throw new AgentPresetError('PRESET_WORKSPACE_REQUIRED', '工作区预设引用必须提供 workspaceSlug')
    return { ...reference, presetId: reference.presetId.trim(), workspaceSlug }
  }
  if (reference.workspaceSlug !== undefined) throw new AgentPresetError('PRESET_SCOPE_MISMATCH', '全局预设引用不得携带 workspaceSlug，请删除该字段或改用 workspace 作用域')
  return { ...reference, presetId: reference.presetId.trim() }
}

function suppressMapping(preset: AgentPreset): AgentPreset {
  const mapped = (preset.disabledToolGroups ?? []).map(group => AGENT_PRESET_TOOL_GROUP_SUPPRESS_MAP[group]).filter((key): key is AgentPresetSuppressKey => key !== undefined)
  const suppress = [...new Set([...(preset.suppressPromptSections ?? []), ...mapped])]
  return suppress.length ? { ...preset, suppressPromptSections: suppress } : preset
}

/** 提取自Electron resolvePresetReferenceInternal；未知引用不回退standard。 */
export function resolveAgentPresetReference(reference: PresetReference, contextWorkspaceSlug: string | undefined, store: PresetResolutionStore): AgentPreset {
  const resolve = (ref: PresetReference, context: string | undefined, visiting: Set<string>, enforceAvailability: boolean): AgentPreset => {
    const normalized = normalizeAgentPresetReference(ref, context)
    const identity = `${normalized.presetScope}:${normalized.workspaceSlug ?? ''}:${normalized.presetId}`
    if (visiting.has(identity)) throw new AgentPresetError('PRESET_INVALID_BASE', `检测到预设继承循环: ${identity}`, { identity })
    const next = new Set(visiting)
    next.add(identity)
    if (enforceAvailability && normalized.presetScope !== 'workspace' && context) {
      const scopes = store.readGlobal().workspaceScopes?.[normalized.presetId]
      if (scopes && !scopes.includes(context)) throw new AgentPresetError('PRESET_UNKNOWN_REFERENCE', `全局预设已解除当前工作区生效范围: ${normalized.presetId}`)
      if (store.readWorkspace(context).disabledGlobalPresetIds?.includes(normalized.presetId)) throw new AgentPresetError('PRESET_NOT_FOUND', `预设已在当前工作区禁用: ${normalized.presetId}`)
    }
    const candidates = normalized.presetScope === 'builtin-meta' ? BUILTIN_AGENT_PRESETS
      : normalized.presetScope === 'user-global' ? store.readGlobal().presets : store.readWorkspace(normalized.workspaceSlug!).presets
    const raw = candidates.find(preset => preset.id === normalized.presetId)
    if (!raw) throw new AgentPresetError('PRESET_NOT_FOUND', `预设不存在: ${normalized.presetScope}/${normalized.presetId}`)
    if (raw.migrationStatus === 'invalid-base') throw new AgentPresetError('PRESET_INVALID_BASE', raw.migrationReason ?? `预设基座无效: ${normalized.presetId}`, { presetId: normalized.presetId })
    if (normalized.presetScope !== 'builtin-meta' && normalized.presetVersion && raw.version && normalized.presetVersion !== raw.version) throw new AgentPresetError('PRESET_CONCURRENT_UPDATE', `预设版本已变化: ${normalized.presetId}`)
    const base = raw.basePresetReference ?? (raw.basePresetId ? { presetId: raw.basePresetId, presetScope: 'builtin-meta' as const } : undefined)
    return suppressMapping(base ? mergeAgentPreset(resolve(base, normalized.workspaceSlug, next, false), raw) : raw)
  }
  return resolve(reference, contextWorkspaceSlug, new Set(), true)
}
