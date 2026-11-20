import { assertSafeSkillSegment } from '@profer/agent-provider-pi/skills/skill-path-security'
import { join } from 'node:path'
import { BUILTIN_AGENT_PRESETS, normalizeAgentPresetReference, AGENT_PRESET_SUPPRESS_KEYS, AGENT_PRESET_TOOL_NAMES, AGENT_PRESET_CAPABILITY_GROUPS } from '@profer/shared'
import type { AgentPreset, GlobalAgentPresetConfig, PresetReference } from '@profer/shared'
import { readResourceObject, resourceObject, resourceText } from './resource-paths'
import type { CoreResourceOperationContext } from './resource-paths'

export const lists = ['promptSections', 'suppressPromptSections', 'disabledToolGroups', 'disabledTools', 'skillSlugs', 'mcpServerNames']
export function validateFields(value: Record<string, unknown>): void {
  for (const key of lists) if (value[key] !== undefined) {
    const items = value[key]
    if (!Array.isArray(items) || items.length > 512 || items.some(item => typeof item !== 'string' || item.length > 100_000)) throw new Error(`Core预设字段无效：${key}`)
  }
  for (const key of ['name','description','channelId','modelId','basePresetId']) if (value[key] !== undefined) resourceText(value[key], key === 'description' ? 8192 : 512)
  if (value.name !== undefined && !String(value.name).trim()) throw new Error('Core预设名称不能为空')
  for (const [key, allowed] of [['suppressPromptSections', AGENT_PRESET_SUPPRESS_KEYS], ['disabledTools', [...AGENT_PRESET_TOOL_NAMES, 'Read','Write','Edit','Bash','Glob','Grep','WebFetch','WebSearch','Task','Skill','NotebookEdit']] , ['disabledToolGroups', AGENT_PRESET_CAPABILITY_GROUPS.map(group => group.id)]] as const) {
    if (Array.isArray(value[key]) && value[key].some(item => !(allowed as readonly unknown[]).includes(item))) throw new Error(`Core预设包含未知能力：${key}`)
  }
  if (value.effort !== undefined && !['low','medium','high','max'].includes(String(value.effort))) throw new Error('Core预设推理档位无效')
  if (value.permissionMode !== undefined && !['auto','plan','bypassPermissions'].includes(String(value.permissionMode))) throw new Error('Core预设权限模式无效')
  if (value.allowSubagents !== undefined && typeof value.allowSubagents !== 'boolean') throw new Error('Core预设allowSubagents无效')
  if (value.basePresetId !== undefined && !BUILTIN_AGENT_PRESETS.some(item => item.id === value.basePresetId)) throw new Error('Core预设基座无效')
  if (value.basePresetReference !== undefined) reference(value.basePresetReference)
}
export function preset(value: unknown): AgentPreset {
  const raw = resourceObject(value); validateFields(raw)
  if (typeof raw.id !== 'string' || typeof raw.name !== 'string' || typeof raw.description !== 'string' || (raw.isBuiltin !== undefined && typeof raw.isBuiltin !== 'boolean') || typeof raw.createdAt !== 'number' || typeof raw.updatedAt !== 'number') throw new Error('Core预设实体损坏')
  assertSafeSkillSegment(raw.id, 'presetId')
  return raw as unknown as AgentPreset
}
export function reference(value: unknown, slug?: string): PresetReference {
  const raw = resourceObject(value)
  if (raw.workspaceSlug !== undefined && slug && raw.workspaceSlug !== slug) throw new Error('Core预设引用越过工作区')
  return normalizeAgentPresetReference({ presetId: resourceText(raw.presetId), presetScope: resourceText(raw.presetScope) as PresetReference['presetScope'], ...(raw.workspaceSlug !== undefined ? { workspaceSlug: resourceText(raw.workspaceSlug) } : {}) }, slug)
}
export function globalConfig(context: Pick<CoreResourceOperationContext, 'config'>): GlobalAgentPresetConfig {
  const raw = readResourceObject(join(context.config.configDir, 'agent-presets.json')) ?? { version: 1, presets: [] }
  if (raw.version !== undefined && raw.version !== 1 || !Array.isArray(raw.presets)) throw new Error('Core全局预设配置版本或列表错误')
  return { ...raw, version: 1, presets: raw.presets.map(value => ({ ...preset(value), scope: 'user-global' })) } as GlobalAgentPresetConfig
}
