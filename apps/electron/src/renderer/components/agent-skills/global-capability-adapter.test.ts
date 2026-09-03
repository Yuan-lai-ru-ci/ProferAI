import { describe, expect, test } from 'bun:test'
import type { AgentPreset } from '@profer/shared'
import { globalCapabilityPreloadAdapter, referenceForPresetCandidate } from './global-capability-adapter'

describe('全局能力 renderer adapter', () => {
  test('保留全局预设的显式 scope，避免 renderer 把同 ID 误解析为工作区预设', () => {
    const preset: AgentPreset = {
      id: 'global-review', scope: 'user-global', version: '1.2.0', name: '全局审查', description: '', isBuiltin: false, createdAt: 1, updatedAt: 2,
    }
    expect(referenceForPresetCandidate(preset)).toEqual({ presetId: 'global-review', presetScope: 'user-global' })
  })

  test('工作区候选引用携带来源 workspace slug', () => {
    const preset: AgentPreset = {
      id: 'local-review', scope: 'workspace', workspaceSlug: 'demo', name: '本地审查', description: '', isBuiltin: false, createdAt: 1, updatedAt: 2,
    }
    expect(referenceForPresetCandidate(preset)).toEqual({ presetId: 'local-review', presetScope: 'workspace', workspaceSlug: 'demo' })
  })

  test('真实 adapter 直接委派 preload 的全局列表、blocker 与写操作', async () => {
    const calls: string[] = []
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        electronAPI: {
          globalSkill: {
            list: async () => [{ skillId: 'skill-1', type: 'user-global', version: '1.0.0', name: 'Skill A', description: '测试', createdAt: '', updatedAt: '', schemaVersion: 1 }],
            getDeleteBlockers: async (id: string) => ({ skillId: id, skillType: 'user-global', references: [] }),
            deleteUser: async (id: string) => { calls.push(`delete-skill:${id}`) },
            copyToWorkspace: async (id: string, slug: string) => { calls.push(`copy-skill:${id}:${slug}`) },
            setEnabled: async (slug: string, id: string, enabled: boolean) => { calls.push(`enabled:${slug}:${id}:${enabled}`) },
            restore: async (slug: string, id: string) => { calls.push(`restore:${slug}:${id}`) },
          },
          listGlobalAgentPresets: async () => [],
          listAgentWorkspaces: async () => [],
          getPresetReferenceReport: async () => ({ preset: { presetId: 'x', presetScope: 'user-global' }, blockers: [], totalCount: 0, canDelete: true }),
          deleteGlobalAgentPreset: async () => { calls.push('delete-preset') },
          copyPresetToWorkspace: async () => { calls.push('copy-preset') },
          listAgentPresets: async () => [],
          setDefaultAgentPresetReference: async () => { calls.push('default-preset') },
          rebindAgentSessionPresetReference: async () => { calls.push('session-rebind') },
          rebindAutomationPresetReference: async () => { calls.push('automation-rebind') },
        },
      },
    })
    const [skill] = await globalCapabilityPreloadAdapter.list('skill')
    expect(skill).toMatchObject({ id: 'skill-1', domain: 'skill', scope: 'user-global', readOnly: false })
    await globalCapabilityPreloadAdapter.getImpact(skill!)
    await globalCapabilityPreloadAdapter.copySkillToWorkspace('skill-1', 'workspace-a')
    await globalCapabilityPreloadAdapter.setSkillEnabled('workspace-a', 'skill-1', false)
    await globalCapabilityPreloadAdapter.restoreSkill('workspace-a', 'skill-1')
    await globalCapabilityPreloadAdapter.delete(skill!)
    expect(calls).toEqual(['copy-skill:skill-1:workspace-a', 'enabled:workspace-a:skill-1:false', 'restore:workspace-a:skill-1', 'delete-skill:skill-1'])
  })
})
