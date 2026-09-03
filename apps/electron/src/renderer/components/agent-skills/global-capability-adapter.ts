/**
 * 全局能力页面的 renderer adapter 契约。
 *
 * renderer 只把领域 manager/preload 的结果映射成展示模型；删除阻塞、引用解析和
 * 作用域校验全部仍在 main-process manager 中完成，不能在这里重算或绕过。
 */

import type {
  AgentPreset,
  AgentWorkspace,
  GlobalSkillDeleteBlockers,
  GlobalSkillMeta,
  PresetReference,
  PresetReferenceReport,
} from '@profer/shared'

export type GlobalCapabilityDomain = 'skill' | 'preset'
export type GlobalCapabilityScope = 'builtin-meta' | 'user-global'

export interface GlobalCapabilityItem {
  id: string
  domain: GlobalCapabilityDomain
  scope: GlobalCapabilityScope
  name: string
  description: string
  version: string
  readOnly: boolean
  updatedAt?: string
}

export type GlobalCapabilityImpact =
  | { domain: 'skill'; blockers: GlobalSkillDeleteBlockers }
  | { domain: 'preset'; report: PresetReferenceReport }

export interface GlobalCapabilityAdapter {
  list(domain: GlobalCapabilityDomain): Promise<GlobalCapabilityItem[]>
  getImpact(item: GlobalCapabilityItem): Promise<GlobalCapabilityImpact>
  delete(item: GlobalCapabilityItem): Promise<void>
  listWorkspaces(): Promise<AgentWorkspace[]>
  copySkillToWorkspace(skillId: string, workspaceSlug: string): Promise<void>
  setSkillEnabled(workspaceSlug: string, skillId: string, enabled: boolean): Promise<void>
  restoreSkill(workspaceSlug: string, skillId: string): Promise<void>
  copyPresetToWorkspace(reference: PresetReference, workspaceSlug: string): Promise<void>
  listPresetCandidates(workspaceSlug: string): Promise<AgentPreset[]>
  setDefaultPreset(workspaceSlug: string, reference: PresetReference): Promise<void>
  rebindSessions(sessionIds: string[], reference: PresetReference): Promise<void>
  rebindAutomations(automationIds: string[], reference: PresetReference | null): Promise<void>
}

function presetReference(preset: AgentPreset): PresetReference {
  const scope = preset.scope ?? (preset.isBuiltin ? 'builtin-meta' : 'workspace')
  return {
    presetId: preset.id,
    presetScope: scope,
    ...(scope === 'workspace' && preset.workspaceSlug ? { workspaceSlug: preset.workspaceSlug } : {}),
  }
}

function skillItem(skill: GlobalSkillMeta): GlobalCapabilityItem {
  return {
    id: skill.skillId,
    domain: 'skill',
    scope: skill.type,
    name: skill.name,
    description: skill.description ?? '',
    version: skill.version,
    readOnly: skill.type === 'builtin-meta',
    updatedAt: skill.updatedAt,
  }
}

function presetItem(preset: AgentPreset): GlobalCapabilityItem {
  const scope = preset.scope ?? (preset.isBuiltin ? 'builtin-meta' : 'workspace')
  if (scope === 'workspace') throw new Error('全局预设列表不应包含 workspace 作用域项')
  return {
    id: preset.id,
    domain: 'preset',
    scope,
    name: preset.name,
    description: preset.description ?? '',
    version: preset.version ?? '—',
    readOnly: scope === 'builtin-meta',
    updatedAt: new Date(preset.updatedAt).toISOString(),
  }
}

/** 真实 preload 映射。若 preload 缺少方法，让 Promise 自然失败并交给页面显示错误。 */
export const globalCapabilityPreloadAdapter: GlobalCapabilityAdapter = {
  async list(domain) {
    if (domain === 'skill') return (await window.electronAPI.globalSkill.list()).map(skillItem)
    return (await window.electronAPI.listGlobalAgentPresets()).map(presetItem)
  },

  async getImpact(item) {
    if (item.domain === 'skill') {
      return { domain: 'skill', blockers: await window.electronAPI.globalSkill.getDeleteBlockers(item.id) }
    }
    return {
      domain: 'preset',
      report: await window.electronAPI.getPresetReferenceReport({ presetId: item.id, presetScope: item.scope }),
    }
  },

  async delete(item) {
    if (item.domain === 'skill') {
      await window.electronAPI.globalSkill.deleteUser(item.id)
      return
    }
    await window.electronAPI.deleteGlobalAgentPreset({ presetId: item.id, presetScope: item.scope })
  },

  listWorkspaces: () => window.electronAPI.listAgentWorkspaces(),
  async copySkillToWorkspace(skillId, workspaceSlug) {
    await window.electronAPI.globalSkill.copyToWorkspace(skillId, workspaceSlug)
  },
  async setSkillEnabled(workspaceSlug, skillId, enabled) {
    await window.electronAPI.globalSkill.setEnabled(workspaceSlug, skillId, enabled)
  },
  async restoreSkill(workspaceSlug, skillId) {
    await window.electronAPI.globalSkill.restore(workspaceSlug, skillId)
  },
  async copyPresetToWorkspace(reference, workspaceSlug) {
    await window.electronAPI.copyPresetToWorkspace(reference, workspaceSlug)
  },
  listPresetCandidates: (workspaceSlug) => window.electronAPI.listAgentPresets(workspaceSlug),
  async setDefaultPreset(workspaceSlug, reference) {
    await window.electronAPI.setDefaultAgentPresetReference(workspaceSlug, reference)
  },
  async rebindSessions(sessionIds, reference) {
    await Promise.all(sessionIds.map((sessionId) => window.electronAPI.rebindAgentSessionPresetReference(sessionId, reference)))
  },
  async rebindAutomations(automationIds, reference) {
    await Promise.all(automationIds.map((automationId) => window.electronAPI.rebindAutomationPresetReference(automationId, reference)))
  },
}

export function referenceForPresetCandidate(preset: AgentPreset): PresetReference {
  return presetReference(preset)
}
