import { describe, expect, test } from 'bun:test'
import {
  createEffectiveAgentPresetPolicy,
  getEffectiveDisabledToolNames,
  isEffectiveAgentPresetMcpServerAllowed,
  isEffectiveAgentPresetSkillAllowed,
  isEffectiveAgentPresetToolDisabled,
  isEffectiveAgentPresetToolGroupDisabled,
  withLoadedMcpServerNames,
  resolveEffectivePermissionMode,
} from './agent-preset-policy'
import type { AgentPreset } from './agent-preset'

const reference = { presetId: 'research', presetScope: 'workspace' as const, workspaceSlug: 'demo' }

function preset(overrides: Partial<AgentPreset> = {}): AgentPreset {
  return {
    id: 'research',
    name: 'Research',
    description: 'test',
    isBuiltin: false,
    scope: 'workspace',
    workspaceSlug: 'demo',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

describe('EffectiveAgentPresetPolicy', () => {
  test('外部 override 只能保持或收紧预设权限，不能静默升级', () => {
    expect(resolveEffectivePermissionMode('plan', 'bypassPermissions')).toBe('plan')
    expect(resolveEffectivePermissionMode('auto', 'bypassPermissions')).toBe('auto')
    expect(resolveEffectivePermissionMode('bypassPermissions', 'plan')).toBe('plan')
    expect(resolveEffectivePermissionMode('bypassPermissions', 'auto')).toBe('auto')
    expect(resolveEffectivePermissionMode('plan', 'auto')).toBe('plan')
  })

  test('可信用户模式可以突破预设默认，但不解除工具禁用', () => {
    const policy = createEffectiveAgentPresetPolicy(preset({ permissionMode: 'plan', disabledTools: ['Write'], disabledToolGroups: ['browser'] }), reference, {
      userPermissionMode: 'bypassPermissions',
    })
    expect(policy.permissionMode).toBe('bypassPermissions')
    expect(isEffectiveAgentPresetToolDisabled(policy, 'Write')).toBe(true)
    expect(isEffectiveAgentPresetToolGroupDisabled(policy, 'browser')).toBe(true)
    expect(createEffectiveAgentPresetPolicy(preset({ permissionMode: 'plan' }), reference, {
      userPermissionMode: 'bypassPermissions', permissionMode: 'auto',
    }).permissionMode).toBe('auto')
  })

  test('Goal 沿用预设/会话权限交集，不因持续执行提升 Plan/auto', () => {
    for (const permissionMode of ['plan', 'auto', 'bypassPermissions'] as const) {
      expect(createEffectiveAgentPresetPolicy(preset({ permissionMode }), reference, {
        permissionMode: 'bypassPermissions',
        triggeredBy: 'goal',
      }).permissionMode).toBe(permissionMode)
    }
    expect(createEffectiveAgentPresetPolicy(preset({ permissionMode: 'bypassPermissions' }), reference, {
      permissionMode: 'plan', triggeredBy: 'goal',
    }).permissionMode).toBe('plan')
  })

  test('Goal 与普通入口在禁用组/单工具/Skill/MCP 白名单组合上完全一致', () => {
    for (const permissionMode of ['plan', 'auto', 'bypassPermissions'] as const) {
      for (const runtimeSupportsSubagents of [true, false]) {
        const source = preset({
          permissionMode,
          disabledToolGroups: ['browser', 'automation'],
          disabledTools: ['WebFetch'],
          skillSlugs: ['code-honor'],
          mcpServerNames: ['memory-archive'],
        })
        const options = { permissionMode: 'bypassPermissions' as const, runtimeSupportsSubagents }
        const normal = createEffectiveAgentPresetPolicy(source, reference, options)
        const goal = createEffectiveAgentPresetPolicy(source, reference, { ...options, triggeredBy: 'goal' })
        expect(goal).toEqual(normal)
        for (const name of ['BrowserObserve', 'mcp__browser__BrowserObserve', 'WebFetch']) {
          expect(isEffectiveAgentPresetToolDisabled(goal, name)).toBe(true)
        }
        expect(isEffectiveAgentPresetToolGroupDisabled(goal, 'automation')).toBe(true)
        expect(isEffectiveAgentPresetSkillAllowed(goal, 'code-honor')).toBe(true)
        expect(isEffectiveAgentPresetSkillAllowed(goal, 'other')).toBe(false)
        expect(isEffectiveAgentPresetMcpServerAllowed(goal, 'memory-archive')).toBe(true)
        expect(isEffectiveAgentPresetMcpServerAllowed(goal, 'other')).toBe(false)
      }
    }
  })

  test('normalizes group policy and maps allowSubagents=false to collaboration', () => {
    const policy = createEffectiveAgentPresetPolicy(
      preset({ disabledToolGroups: ['browser'], allowSubagents: false }),
      reference,
      { permissionMode: 'plan', pptCapabilityActive: true },
    )

    expect(policy.disabledToolGroups).toEqual(['browser', 'collaboration'])
    expect(policy.allowSubagents).toBe(false)
    expect(policy.runtimeSupportsSubagents).toBe(false)
    expect(policy.sessionCanUseSubagents).toBe(false)
    expect(policy.permissionMode).toBe('plan')
    expect(policy.pptCapabilityActive).toBe(true)
    expect(policy.source).toBe('workspace')
    expect(isEffectiveAgentPresetToolGroupDisabled(policy, 'browser')).toBe(true)
    expect(isEffectiveAgentPresetToolGroupDisabled(policy, 'memory')).toBe(false)
  })

  test('runtime 不支持子 Agent 时会同步禁用协作组，而静态能力字段保持可区分', () => {
    const policy = createEffectiveAgentPresetPolicy(preset(), reference, { runtimeSupportsSubagents: false })
    expect(policy.runtimeSupportsSubagents).toBe(false)
    expect(policy.sessionCanUseSubagents).toBe(false)
    expect(policy.disabledToolGroups).toContain('collaboration')
    expect(policy.allowSubagents).toBe(false)
  })

  test('preserves undefined and empty whitelist semantics while de-duplicating values', () => {
    const unrestricted = createEffectiveAgentPresetPolicy(preset(), reference, { runtimeSupportsSubagents: true })
    expect(unrestricted.runtimeSupportsSubagents).toBe(true)
    expect(unrestricted.sessionCanUseSubagents).toBe(true)
    expect(unrestricted.allowedSkillSlugs).toBeUndefined()
    expect(unrestricted.allowedMcpServerNames).toBeUndefined()
    expect(isEffectiveAgentPresetSkillAllowed(unrestricted, 'any')).toBe(true)
    expect(isEffectiveAgentPresetMcpServerAllowed(unrestricted, 'any')).toBe(true)

    const restricted = createEffectiveAgentPresetPolicy(
      preset({ skillSlugs: [], mcpServerNames: ['filesystem', 'filesystem'] }),
      reference,
    )
    expect(restricted.allowedSkillSlugs).toEqual([])
    expect(restricted.allowedMcpServerNames).toEqual(['filesystem'])
    expect(isEffectiveAgentPresetSkillAllowed(restricted, 'any')).toBe(false)
    expect(isEffectiveAgentPresetMcpServerAllowed(restricted, 'filesystem')).toBe(true)
    expect(isEffectiveAgentPresetMcpServerAllowed(restricted, 'other')).toBe(false)
  })

  test('combines group and single-tool deny rules for Claude and Pi names', () => {
    const policy = createEffectiveAgentPresetPolicy(
      preset({ disabledToolGroups: ['browser'], disabledTools: ['WebFetch', 'delegate_agent'] }),
      reference,
    )

    expect(isEffectiveAgentPresetToolDisabled(policy, 'WebFetch')).toBe(true)
    expect(isEffectiveAgentPresetToolDisabled(policy, 'mcp__collaboration__delegate_agent')).toBe(true)
    expect(isEffectiveAgentPresetToolDisabled(policy, 'BrowserObserve')).toBe(true)
    expect(getEffectiveDisabledToolNames(policy)).toEqual(expect.arrayContaining([
      'WebFetch',
      'delegate_agent',
      'BrowserObserve',
      'BrowserNavigate',
    ]))
  })

  test('freezes nested policy arrays and loaded MCP updates create a new snapshot', () => {
    const source = preset({ promptSections: ['a'], skillSlugs: ['s1'] })
    const policy = createEffectiveAgentPresetPolicy(source, reference)
    source.promptSections?.push('mutated')
    source.skillSlugs?.push('mutated')

    expect(policy.preset.promptSections).toEqual(['a'])
    expect(policy.allowedSkillSlugs).toEqual(['s1'])
    expect(Object.isFrozen(policy)).toBe(true)
    expect(Object.isFrozen(policy.preset)).toBe(true)
    expect(Object.isFrozen(policy.preset.promptSections)).toBe(true)

    const loaded = withLoadedMcpServerNames(policy, ['a', 'a', 'b'])
    expect(policy.loadedMcpServerNames).toBeUndefined()
    expect(loaded.loadedMcpServerNames).toEqual(['a', 'b'])
    expect(Object.isFrozen(loaded)).toBe(true)
  })

  test('maps explicit suppress sections and disabled groups without duplicates', () => {
    const policy = createEffectiveAgentPresetPolicy(
      preset({ suppressPromptSections: ['memory'], disabledToolGroups: ['task-graph', 'memory'] }),
      reference,
    )
    expect(policy.suppressPromptSections).toEqual(['memory', 'task-graph'])
  })
})
