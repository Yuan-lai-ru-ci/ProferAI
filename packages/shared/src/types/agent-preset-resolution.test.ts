import { describe, expect, test } from 'bun:test'
import { BUILTIN_AGENT_PRESETS } from './agent-preset'
import type { AgentPreset, PresetReference } from './agent-preset'
import { resolveAgentPresetReference, selectNewDelegationPreset, type PresetResolutionStore } from './agent-preset-resolution'

function store(options: { only?: string; local?: AgentPreset[]; disabledLocal?: string[] } = {}): PresetResolutionStore {
  return {
    readGlobal: () => ({ version: 1, presets: [] }),
    readWorkspace: () => ({
      presets: options.local ?? [],
      disabledGlobalPresetIds: options.only ? BUILTIN_AGENT_PRESETS.filter(preset => preset.id !== options.only).map(preset => preset.id) : [],
      disabledWorkspacePresetIds: options.disabledLocal,
    }),
  }
}

const target: PresetReference = { presetId: 'standard', presetScope: 'builtin-meta' }
const local: AgentPreset = {
  id: 'reviewer', name: '审查岗位', description: 'fixture', isBuiltin: false, scope: 'workspace', workspaceSlug: 'demo',
  version: '2', createdAt: 0, updatedAt: 0,
}

describe('新建委派预设选择', () => {
  test('多个可用岗位时拒绝省略，显式选择父岗位仍然允许', () => {
    expect(() => selectNewDelegationPreset(undefined, 'demo', store())).toThrow('必须按职责显式选择')
    expect(selectNewDelegationPreset(target, 'demo', store())).toEqual(target)
  })

  test('只有一个可用岗位时选该岗位，不依赖父会话默认值', () => {
    expect(selectNewDelegationPreset(undefined, 'demo', store({ only: 'standard' }))).toMatchObject(target)
  })

  test('没有可用岗位明确拒绝，不回退standard', () => {
    expect(() => selectNewDelegationPreset(undefined, 'demo', store({ only: 'not-present' }))).toThrow('没有可用于派工的预设')
  })

  test('工作区目标必须显式指向父工作区且不能被禁用', () => {
    const reference: PresetReference = { presetId: local.id, presetScope: 'workspace', workspaceSlug: 'demo', presetVersion: '2' }
    const enabled = store({ local: [local] })
    expect(selectNewDelegationPreset(reference, 'demo', enabled)).toEqual(reference)
    for (const workspaceSlug of [undefined, 'other']) {
      expect(() => selectNewDelegationPreset({ ...reference, workspaceSlug }, 'demo', enabled)).toThrow('父工作区')
    }
    expect(() => selectNewDelegationPreset(reference, 'demo', store({ local: [local], disabledLocal: [local.id] }))).toThrow('禁用')
  })

  test('选择结果仍须严格解析版本和继承，不能凭schema创建', () => {
    const source = store({ local: [local] })
    const stale = selectNewDelegationPreset({ presetId: local.id, presetScope: 'workspace', workspaceSlug: 'demo', presetVersion: 'old' }, 'demo', source)
    expect(() => resolveAgentPresetReference(stale, 'demo', source)).toThrow('版本已变化')
    const invalid = store({ local: [{ ...local, basePresetId: 'missing-base' }] })
    const reference = selectNewDelegationPreset({ presetId: local.id, presetScope: 'workspace', workspaceSlug: 'demo' }, 'demo', invalid)
    expect(() => resolveAgentPresetReference(reference, 'demo', invalid)).toThrow('预设不存在')
  })

  test('配置读取失败保留根因，不当成无岗位或自动选默认', () => {
    const broken: PresetResolutionStore = { ...store(), readGlobal: () => { throw new Error('fixture config is corrupt') } }
    expect(() => selectNewDelegationPreset(undefined, 'demo', broken)).toThrow('fixture config is corrupt')
  })
})
