/**
 * agent-preset-manager 单元测试（工作区级）
 *
 * 覆盖：内置预设加载、未知 ID 回退、默认预设读写、会话预设规范化、
 * 工作区隔离、无工作区行为。
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentPreset, AgentPresetConfig, PresetReference } from '@profer/shared'
import {
  listAgentPresets,
  getAgentPreset,
  getDefaultPresetId,
  setDefaultPresetId,
  normalizeSessionPresetId,
  createAgentPreset,
  copyAgentPreset,
  updateAgentPreset,
  deleteAgentPreset,
  serializeAgentPresetsForExport,
  importAgentPresets,
  __setAgentPresetsBaseDirForTest,
  __resetAgentPresetsBaseDirForTest,
  listGlobalAgentPresets,
  createGlobalAgentPreset,
  copyPresetToWorkspace,
  normalizePresetReference,
  resolvePresetReference,
  deleteGlobalAgentPreset,
  enableGlobalPresetInWorkspace,
  disableGlobalPresetInWorkspace,
  setWorkspacePresetEnabled,
  getPresetReferenceReport,
  rebindAndDisableGlobalPresetScope,
  type RebindAndDisableDependencies,
  setDefaultPresetReference,
  ensurePresetSystemReady,
  __setAgentPresetMigrationWorkspacesForTest,
} from './agent-preset-manager'
import { AgentPresetError } from '@profer/shared'
import {
  BUILTIN_PRESET_STANDARD,
  BUILTIN_PRESET_CODE,
  BUILTIN_PRESET_MINIMAL,
  BUILTIN_AGENT_PRESETS,
  DEFAULT_PRESET_ID,
  AGENT_PRESET_TOOL_GROUPS,
  AGENT_PRESET_CAPABILITY_GROUPS,
  AGENT_PRESET_TOOL_NAMES,
  getAgentPresetCapabilityTool,
  getAgentPresetCapabilityTools,
} from '@profer/shared'

const WS_A = 'ws-a'
const WS_B = 'ws-b'

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'agent-preset-test-'))
  __setAgentPresetsBaseDirForTest(tmpDir)
})

afterEach(() => {
  __resetAgentPresetsBaseDirForTest()
  rmSync(tmpDir, { recursive: true, force: true })
})

function writeLegacyPresetConfig(workspaceSlug: string, config: Record<string, unknown>): string {
  const dir = join(tmpDir, workspaceSlug)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'agent-presets.json')
  writeFileSync(path, JSON.stringify(config, null, 2))
  return path
}

describe('Capability Registry', () => {
  test('能力组和工具短名来自同一注册表且没有重复项', () => {
    expect(AGENT_PRESET_CAPABILITY_GROUPS.map((group) => group.id)).toEqual([...AGENT_PRESET_TOOL_GROUPS])
    const names = AGENT_PRESET_CAPABILITY_GROUPS.flatMap((group) => group.toolNames)
    expect(new Set(names).size).toBe(names.length)
    expect(new Set(AGENT_PRESET_TOOL_NAMES)).toEqual(new Set(names))
  })

  test('工具级 registry 元数据完整且按 runtime 可查询', () => {
    const tools = getAgentPresetCapabilityTools()
    expect(tools.length).toBe(AGENT_PRESET_TOOL_NAMES.length)
    expect(tools.every((tool) => tool.label && tool.hint && tool.runtimes.length > 0)).toBe(true)
    expect(tools.every((tool) => ['read', 'write', 'external', 'destructive'].includes(tool.risk))).toBe(true)
    expect(getAgentPresetCapabilityTool('mcp__collaboration__delegate_agent')?.risk).toBe('write')
    expect(getAgentPresetCapabilityTools('claude').length).toBe(tools.length)
    expect(getAgentPresetCapabilityTools('pi').length).toBe(tools.length)
  })
})

describe('listAgentPresets', () => {
  test('极简内置预设关闭全部产品能力组，并同步 suppress 可映射的内置段落', () => {
    const presets = listAgentPresets(WS_A)
    const minimal = presets.find((p) => p.id === 'minimal')
    expect(minimal).toBeDefined()
    expect(minimal!.disabledToolGroups).toEqual([...AGENT_PRESET_TOOL_GROUPS])
    expect(minimal!.suppressPromptSections).toEqual(['subagents', 'memory', 'task-graph', 'automation'])
  })

  test('无配置时返回三个内置预设', () => {
    const presets = listAgentPresets(WS_A)
    expect(presets.length).toBe(3)
    const ids = presets.map((p) => p.id)
    expect(ids).toContain(BUILTIN_PRESET_STANDARD)
    expect(ids).toContain(BUILTIN_PRESET_CODE)
    expect(ids).toContain(BUILTIN_PRESET_MINIMAL)
  })

  test('内置预设均标记 isBuiltin，且 standard 无提示词段（行为与默认一致）', () => {
    const presets = listAgentPresets(WS_A)
    for (const preset of presets) {
      expect(preset.isBuiltin).toBe(true)
    }
    const standard = presets.find((p) => p.id === BUILTIN_PRESET_STANDARD)!
    expect(standard.promptSections).toBeUndefined()
    expect(standard.description).toContain('默认工作模式')
    const code = presets.find((p) => p.id === BUILTIN_PRESET_CODE)!
    expect(code.description).toContain('严格研发模式')
    expect(code.effort).toBe('high')
    expect(code.disabledToolGroups).toEqual(['automation', 'browser', 'clipboard', 'ppt-materials'])
    expect(code.disabledTools).toEqual(['generate_image', 'create_skin'])
    expect(code.skillSlugs).toBeUndefined()
    expect(code.mcpServerNames).toBeUndefined()
    expect(code.promptSections?.[0]).toContain('跨边界修改必须检查调用方和契约')
    expect(code.promptSections?.[0]).toContain('网页搜索/抓取与本地图片呈现保留')
    const minimal = presets.find((p) => p.id === BUILTIN_PRESET_MINIMAL)!
    expect(minimal.promptSections?.length).toBeGreaterThan(0)
    expect(minimal.description).toContain('关闭全部产品能力组')
    expect(minimal.promptSections?.[0]).toContain('全部产品能力组已为本会话关闭')
  })

  test('无工作区时仅返回内置三预设', () => {
    expect(listAgentPresets(undefined).length).toBe(3)
    expect(listAgentPresets(undefined).every((p) => p.isBuiltin)).toBe(true)
  })
})

describe('全局预设与作用域引用', () => {
  test('Given builtin-meta When listing Then only one read-only definition exists', () => {
    const presets = listGlobalAgentPresets()
    expect(presets.filter((preset) => preset.scope === 'builtin-meta')).toHaveLength(3)
  })

  test('Given user-global MCP whitelist is empty When creating Then empty whitelist is preserved', () => {
    const created = createGlobalAgentPreset({ name: '全局零 MCP', description: '', mcpServerNames: [] })
    expect(created.mcpServerNames).toEqual([])
    expect(listGlobalAgentPresets().find((preset) => preset.id === created.id)?.mcpServerNames).toEqual([])
  })

  test('Given user-global When resolving Then workspace context cannot change identity', () => {
    const created = createGlobalAgentPreset({ name: '全局代码', description: '' })
    const reference = { presetId: created.id, presetScope: 'user-global' as const }
    expect(resolvePresetReference(reference, WS_A).id).toBe(created.id)
    expect(() => normalizePresetReference({ ...reference, workspaceSlug: WS_A })).toThrow('不得携带 workspaceSlug')
  })

  test('工作区默认的 user-global 预设在 standard 停用时仍出现在工作区列表', () => {
    const projectLead = createGlobalAgentPreset({ name: '项目领航', description: '' })
    const reference = { presetId: projectLead.id, presetScope: 'user-global' as const }
    disableGlobalPresetInWorkspace(WS_A, { presetId: BUILTIN_PRESET_STANDARD, presetScope: 'builtin-meta' })
    setDefaultPresetReference(WS_A, reference)

    expect(getDefaultPresetId(WS_A)).toBe(projectLead.id)
    expect(listAgentPresets(WS_A).find((preset) => preset.id === projectLead.id)).toMatchObject({
      id: projectLead.id,
      scope: 'user-global',
      enabledInWorkspace: true,
    })
    expect(listAgentPresets(WS_A).find((preset) => preset.id === BUILTIN_PRESET_STANDARD)?.enabledInWorkspace).toBe(false)
  })

  test('Given global source When copying Then workspace copy records source', () => {
    const source = createGlobalAgentPreset({ name: '全局研究', description: '跨区' })
    const copied = copyPresetToWorkspace({ presetId: source.id, presetScope: 'user-global' }, WS_A)
    expect(copied.scope).toBe('workspace')
    expect(copied.workspaceSlug).toBe(WS_A)
    expect(copied.sourcePresetId).toBe(source.id)
    expect(copied.sourcePresetScope).toBe('user-global')
  })

  test('Given builtin-meta When deleting Then manager rejects with machine-readable error', () => {
    try { deleteGlobalAgentPreset({ presetId: 'standard', presetScope: 'builtin-meta' }); throw new Error('expected') } catch (error) {
      expect(error).toBeInstanceOf(AgentPresetError)
      expect((error as AgentPresetError).code).toBe('PRESET_READ_ONLY')
    }
  })

  test('全局预设工作区范围可直接移除，不要求替代预设', () => {
    const preset = createGlobalAgentPreset({ name: '可解除范围', description: '' })
    const reference = { presetId: preset.id, presetScope: 'user-global' as const }
    enableGlobalPresetInWorkspace(WS_A, reference)
    expect(listAgentPresets(WS_A).some((item) => item.id === preset.id)).toBe(true)
    disableGlobalPresetInWorkspace(WS_A, reference)
    expect(listAgentPresets(WS_A).some((item) => item.id === preset.id)).toBe(false)
    expect(() => resolvePresetReference(reference, WS_A)).toThrow('解除当前工作区生效范围')
  })

  test('禁用 builtin-meta 默认预设时自动改用首个仍启用的预设', () => {
    setDefaultPresetId(WS_A, BUILTIN_PRESET_CODE)
    disableGlobalPresetInWorkspace(WS_A, { presetId: BUILTIN_PRESET_CODE, presetScope: 'builtin-meta' })
    expect(getDefaultPresetId(WS_A)).toBe(BUILTIN_PRESET_STANDARD)
    expect(JSON.parse(readFileSync(join(tmpDir, WS_A, 'agent-presets.json'), 'utf8')).defaultPresetReference).toMatchObject({
      presetId: BUILTIN_PRESET_STANDARD,
      presetScope: 'builtin-meta',
    })
  })

  test('defaultPresetReference 是有效全局默认时覆盖过时的 standard ID', () => {
    const projectLead = createGlobalAgentPreset({ name: '项目领航', description: '' })
    setDefaultPresetReference(WS_A, { presetId: projectLead.id, presetScope: 'user-global' })
    const path = join(tmpDir, WS_A, 'agent-presets.json')
    const config = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    config.defaultPresetId = BUILTIN_PRESET_STANDARD
    config.disabledGlobalPresetIds = [BUILTIN_PRESET_STANDARD]
    writeFileSync(path, JSON.stringify(config, null, 2))

    expect(getDefaultPresetId(WS_A)).toBe(projectLead.id)
    expect(listAgentPresets(WS_A).find((preset) => preset.id === projectLead.id)?.enabledInWorkspace).toBe(true)
    expect(listAgentPresets(WS_A).find((preset) => preset.id === BUILTIN_PRESET_STANDARD)?.enabledInWorkspace).toBe(false)
  })

  test('显式清空的默认预设不会被过期引用复活', () => {
    const projectLead = createGlobalAgentPreset({ name: '项目领航', description: '' })
    setDefaultPresetReference(WS_A, { presetId: projectLead.id, presetScope: 'user-global' })
    const path = join(tmpDir, WS_A, 'agent-presets.json')
    const config = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    config.defaultPresetId = ''
    config.defaultPresetExplicitlyCleared = true
    writeFileSync(path, JSON.stringify(config, null, 2))

    expect(getDefaultPresetId(WS_A)).toBe('')
  })

  test('关闭元预设的直接选择入口后，基于它的工作区岗位仍可独立选择和解析', () => {
    const derived = createAgentPreset(WS_A, { name: '代码派生岗位', description: '', basePresetId: BUILTIN_PRESET_CODE })
    disableGlobalPresetInWorkspace(WS_A, { presetId: BUILTIN_PRESET_CODE, presetScope: 'builtin-meta' })

    const presets = listAgentPresets(WS_A)
    expect(presets.find((preset) => preset.id === BUILTIN_PRESET_CODE)?.enabledInWorkspace).toBe(false)
    expect(presets.find((preset) => preset.id === derived.id)?.enabledInWorkspace).toBe(true)
    expect(getAgentPreset(WS_A, derived.id).id).toBe(derived.id)
    expect(() => resolvePresetReference({ presetId: BUILTIN_PRESET_CODE, presetScope: 'builtin-meta' }, WS_A))
      .toThrow('当前工作区')
  })

  test('禁用 standard 默认预设时自动改用 code，供加号新建会话继承', () => {
    disableGlobalPresetInWorkspace(WS_A, { presetId: BUILTIN_PRESET_STANDARD, presetScope: 'builtin-meta' })
    expect(getDefaultPresetId(WS_A)).toBe(BUILTIN_PRESET_CODE)
    expect(JSON.parse(readFileSync(join(tmpDir, WS_A, 'agent-presets.json'), 'utf8')).defaultPresetReference).toMatchObject({
      presetId: BUILTIN_PRESET_CODE,
      presetScope: 'builtin-meta',
    })
  })

  test('仅当工作区没有任何可用预设时才清空默认值', () => {
    disableGlobalPresetInWorkspace(WS_A, { presetId: BUILTIN_PRESET_STANDARD, presetScope: 'builtin-meta' })
    disableGlobalPresetInWorkspace(WS_A, { presetId: BUILTIN_PRESET_CODE, presetScope: 'builtin-meta' })
    disableGlobalPresetInWorkspace(WS_A, { presetId: BUILTIN_PRESET_MINIMAL, presetScope: 'builtin-meta' })
    expect(getDefaultPresetId(WS_A)).toBe('')
  })

  test('全局预设尚未在当前工作区生效时仍可直接设为默认', () => {
    const preset = createGlobalAgentPreset({ name: '跨区默认', description: '' })
    const reference = { presetId: preset.id, presetScope: 'user-global' as const }
    enableGlobalPresetInWorkspace(WS_B, reference)
    disableGlobalPresetInWorkspace(WS_A, reference)
    expect(() => setDefaultPresetReference(WS_A, reference)).not.toThrow()
    expect(getDefaultPresetId(WS_A)).toBe(preset.id)
    expect(listAgentPresets(WS_A).some((item) => item.id === preset.id)).toBe(true)
  })

  test('重新启用全局预设时清除工作区的显式禁用 override', () => {
    __setAgentPresetMigrationWorkspacesForTest([WS_A])
    const preset = createGlobalAgentPreset({ name: '可恢复范围', description: '' })
    const reference = { presetId: preset.id, presetScope: 'user-global' as const }
    disableGlobalPresetInWorkspace(WS_A, reference)
    expect(listAgentPresets(WS_A).some((item) => item.id === preset.id)).toBe(false)

    enableGlobalPresetInWorkspace(WS_A, reference)
    expect(listAgentPresets(WS_A).find((item) => item.id === preset.id)?.enabledInWorkspace).toBe(true)
  })

  test('引用报告按 workspaceScopes 展示无对象引用的生效工作区', () => {
    __setAgentPresetMigrationWorkspacesForTest([WS_A, WS_B])
    const preset = createGlobalAgentPreset({ name: '范围报告', description: '' })
    const reference = { presetId: preset.id, presetScope: 'user-global' as const }
    enableGlobalPresetInWorkspace(WS_A, reference)
    disableGlobalPresetInWorkspace(WS_B, reference)

    expect(getPresetReferenceReport(reference)).toMatchObject({
      workspaceScopes: [{ workspaceSlug: WS_A, workspaceName: WS_A }],
      blockers: [],
      totalCount: 0,
      canDelete: true,
    })
    disableGlobalPresetInWorkspace(WS_A, reference)
    expect(getPresetReferenceReport(reference).workspaceScopes).toEqual([])
  })

  test('解除全局范围时将 workspace 默认引用改绑后再移除作用域', () => {
    __setAgentPresetMigrationWorkspacesForTest([WS_A])
    const preset = createGlobalAgentPreset({ name: '默认范围', description: '' })
    const reference = { presetId: preset.id, presetScope: 'user-global' as const }
    setDefaultPresetReference(WS_A, reference)

    expect(getPresetReferenceReport(reference).blockers).toEqual([
      expect.objectContaining({ workspaceSlug: WS_A, reason: 'workspace-default', objectIds: [WS_A] }),
    ])
    expect(() => disableGlobalPresetInWorkspace(WS_A, reference)).not.toThrow()
    expect(getDefaultPresetId(WS_A)).toBe(BUILTIN_PRESET_STANDARD)
    expect(getPresetReferenceReport(reference)).toMatchObject({ workspaceScopes: [], blockers: [], canDelete: true })
  })

  test('Given no references When atomically disabling scope Then no replacement is required', () => {
    __setAgentPresetMigrationWorkspacesForTest([WS_A])
    const preset = createGlobalAgentPreset({ name: '无引用范围', description: '' })
    const source = { presetId: preset.id, presetScope: 'user-global' as const }
    const result = rebindAndDisableGlobalPresetScope(WS_A, source)

    expect(result).toMatchObject({
      workspaceSlug: WS_A,
      source,
      reboundDefaults: 0,
      reboundSessions: 0,
      reboundAutomations: 0,
      scopeDisabled: true,
    })
    expect(getPresetReferenceReport(source).workspaceScopes).toEqual([])
  })

  test('Given mixed references When rebind succeeds Then all references move before scope removal', () => {
    const preset = createGlobalAgentPreset({ name: '事务来源', description: '' })
    const source = { presetId: preset.id, presetScope: 'user-global' as const }
    const replacement = { presetId: 'standard', presetScope: 'builtin-meta' as const }
    let defaultReference: PresetReference = source
    let sessionReference: PresetReference = source
    let automationReference: PresetReference | null = source
    const calls: string[] = []
    const dependencies: RebindAndDisableDependencies = {
      getReport: () => ({
        preset: source,
        workspaceScopes: [{ workspaceSlug: WS_A, workspaceName: WS_A }],
        blockers: [
          { workspaceSlug: WS_A, workspaceName: WS_A, status: 'active', reason: 'workspace-default', objectIds: [WS_A], objectCount: 1, actions: ['rebind'] },
          { workspaceSlug: WS_A, workspaceName: WS_A, status: 'active', reason: 'session', objectIds: ['session-1'], objectCount: 1, actions: ['rebind'] },
          { workspaceSlug: WS_A, workspaceName: WS_A, status: 'active', reason: 'automation', objectIds: ['automation-1'], objectCount: 1, actions: ['rebind'] },
        ],
        totalCount: 3,
        canDelete: false,
      }),
      getDefaultReference: () => defaultReference,
      setDefaultReference: (_workspaceSlug, reference) => { calls.push(`default:${reference.presetId}`); defaultReference = reference },
      getSessionReference: () => sessionReference,
      rebindSession: (_id, reference) => { calls.push(`session:${reference.presetId}`); sessionReference = reference },
      getAutomationReference: () => automationReference,
      rebindAutomation: (_id, reference) => { calls.push(`automation:${reference?.presetId ?? 'default'}`); automationReference = reference },
      disableScope: () => { calls.push('disable') },
    }

    const result = rebindAndDisableGlobalPresetScope(WS_A, source, replacement, dependencies)
    expect(result).toMatchObject({ reboundDefaults: 1, reboundSessions: 1, reboundAutomations: 1, scopeDisabled: true })
    expect(defaultReference).toEqual(replacement)
    expect(sessionReference).toEqual(replacement)
    expect(automationReference).toEqual(replacement)
    expect(calls).toEqual(['default:standard', 'session:standard', 'automation:standard', 'disable'])
  })

  test('Given a mid-transaction failure When rebinding scope Then completed writes roll back and scope stays active', () => {
    const preset = createGlobalAgentPreset({ name: '回滚来源', description: '' })
    const source = { presetId: preset.id, presetScope: 'user-global' as const }
    const replacement = { presetId: 'standard', presetScope: 'builtin-meta' as const }
    let defaultReference: PresetReference = source
    let sessionReference: PresetReference = source
    let scopeDisabled = false
    const dependencies: RebindAndDisableDependencies = {
      getReport: () => ({
        preset: source,
        workspaceScopes: [{ workspaceSlug: WS_A, workspaceName: WS_A }],
        blockers: [
          { workspaceSlug: WS_A, workspaceName: WS_A, status: 'active', reason: 'workspace-default', objectIds: [WS_A], objectCount: 1, actions: ['rebind'] },
          { workspaceSlug: WS_A, workspaceName: WS_A, status: 'active', reason: 'session', objectIds: ['session-1'], objectCount: 1, actions: ['rebind'] },
          { workspaceSlug: WS_A, workspaceName: WS_A, status: 'active', reason: 'automation', objectIds: ['automation-1'], objectCount: 1, actions: ['rebind'] },
        ],
        totalCount: 3,
        canDelete: false,
      }),
      getDefaultReference: () => defaultReference,
      setDefaultReference: (_workspaceSlug, reference) => { defaultReference = reference },
      getSessionReference: () => sessionReference,
      rebindSession: (_id, reference) => { sessionReference = reference },
      getAutomationReference: () => source,
      rebindAutomation: () => { throw new Error('automation write failed') },
      disableScope: () => { scopeDisabled = true },
    }

    expect(() => rebindAndDisableGlobalPresetScope(WS_A, source, replacement, dependencies)).toThrow('automation write failed')
    expect(defaultReference).toEqual(source)
    expect(sessionReference).toEqual(source)
    expect(scopeDisabled).toBe(false)
  })

  test('Given references and an invalid replacement When disabling scope Then validation rejects before writes', () => {
    const preset = createGlobalAgentPreset({ name: '校验来源', description: '' })
    const source = { presetId: preset.id, presetScope: 'user-global' as const }
    let writes = 0
    const dependencies: RebindAndDisableDependencies = {
      getReport: () => ({
        preset: source,
        workspaceScopes: [{ workspaceSlug: WS_A, workspaceName: WS_A }],
        blockers: [{ workspaceSlug: WS_A, workspaceName: WS_A, status: 'active', reason: 'session', objectIds: ['session-1'], objectCount: 1, actions: ['rebind'] }],
        totalCount: 1,
        canDelete: false,
      }),
      getDefaultReference: () => source,
      setDefaultReference: () => { writes += 1 },
      getSessionReference: () => source,
      rebindSession: () => { writes += 1 },
      getAutomationReference: () => source,
      rebindAutomation: () => { writes += 1 },
      disableScope: () => { writes += 1 },
    }

    expect(() => rebindAndDisableGlobalPresetScope(WS_A, source, source, dependencies)).toThrow('替代预设不能与待解除作用域的预设相同')
    expect(writes).toBe(0)
  })

  test('Given no legacy files When ready gate runs Then migration is idempotent', () => {
    const first = ensurePresetSystemReady()
    const second = ensurePresetSystemReady()
    expect(first.status).toBe('completed')
    expect(second.status).toBe('completed')
    expect(second.result).toBe('no-history')
  })

  test('C1/C2/C3/C4/C5：旧用户预设保留为 workspace，默认值、继承和会话/任务引用均带作用域', () => {
    __setAgentPresetMigrationWorkspacesForTest([WS_A])
    const workspacePresetId = 'legacy-workspace-preset'
    const derivedId = 'legacy-derived-preset'
    const path = writeLegacyPresetConfig(WS_A, {
      presets: [
        { id: workspacePresetId, name: '旧工作区预设', description: '用户配置', isBuiltin: false, createdAt: 1, updatedAt: 2 },
        { id: derivedId, name: '继承代码', description: '', isBuiltin: false, basePresetId: workspacePresetId, createdAt: 1, updatedAt: 2 },
      ],
      defaultPresetId: workspacePresetId,
    })
    writeFileSync(join(tmpDir, 'agent-sessions.json'), JSON.stringify({ sessions: [{ id: 'session-1', workspaceId: WS_A, presetId: derivedId }] }))
    writeFileSync(join(tmpDir, 'automations.json'), JSON.stringify({ automations: [{ id: 'automation-1', workspaceId: WS_A, presetId: workspacePresetId }] }))

    const state = ensurePresetSystemReady()
    expect(state.status).toBe('completed')
    expect(state.completedWorkspaces).toEqual([WS_A])
    expect(existsSync(join(tmpDir, WS_A, '.migration-backup'))).toBe(true)
    const migrated = JSON.parse(readFileSync(path, 'utf8')) as AgentPresetConfig
    expect(migrated.presets.every((preset) => preset.scope === 'workspace' && preset.workspaceSlug === WS_A)).toBe(true)
    expect(migrated.defaultPresetReference).toEqual({ presetId: workspacePresetId, presetScope: 'workspace', workspaceSlug: WS_A })
    expect(migrated.presets.find((preset) => preset.id === derivedId)?.basePresetReference).toEqual({ presetId: workspacePresetId, presetScope: 'workspace', workspaceSlug: WS_A })
    expect((JSON.parse(readFileSync(join(tmpDir, 'agent-sessions.json'), 'utf8')) as { sessions: Array<Record<string, unknown>> }).sessions[0]!.presetReference).toEqual({ presetId: derivedId, presetScope: 'workspace', workspaceSlug: WS_A })
    expect((JSON.parse(readFileSync(join(tmpDir, 'automations.json'), 'utf8')) as { automations: Array<Record<string, unknown>> }).automations[0]!.presetReference).toEqual({ presetId: workspacePresetId, presetScope: 'workspace', workspaceSlug: WS_A })
  })

  test('C6：无效基座保留原始字段并记录诊断，不静默改为 standard', () => {
    __setAgentPresetMigrationWorkspacesForTest([WS_A])
    const path = writeLegacyPresetConfig(WS_A, {
      presets: [{ id: 'broken-base', name: '损坏基座', description: '', isBuiltin: false, basePresetId: 'removed-base', createdAt: 1, updatedAt: 2 }],
      defaultPresetId: 'broken-base',
    })
    const state = ensurePresetSystemReady()
    const migrated = JSON.parse(readFileSync(path, 'utf8')) as AgentPresetConfig
    expect(state.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ presetId: 'broken-base', status: 'invalid-base' })]))
    expect(migrated.presets[0]?.basePresetId).toBe('removed-base')
    expect(migrated.presets[0]?.migrationStatus).toBe('invalid-base')
    expect(migrated.defaultPresetId).toBe('broken-base')
    expect(() => resolvePresetReference({ presetId: 'broken-base', presetScope: 'workspace', workspaceSlug: WS_A }, WS_A)).toThrow('非法派生基座')
  })

  test('C6：自引用和双节点循环在运行时返回机器可读错误，不发生递归溢出', () => {
    writeLegacyPresetConfig(WS_A, {
      presets: [
        { id: 'self-cycle', name: '自引用', description: '', isBuiltin: false, basePresetId: 'self-cycle', createdAt: 1, updatedAt: 2 },
        { id: 'cycle-a', name: '循环 A', description: '', isBuiltin: false, basePresetId: 'cycle-b', createdAt: 1, updatedAt: 2 },
        { id: 'cycle-b', name: '循环 B', description: '', isBuiltin: false, basePresetId: 'cycle-a', createdAt: 1, updatedAt: 2 },
      ],
      defaultPresetId: 'self-cycle',
    })
    ensurePresetSystemReady()
    for (const presetId of ['self-cycle', 'cycle-a', 'cycle-b']) {
      try {
        resolvePresetReference({ presetId, presetScope: 'workspace', workspaceSlug: WS_A }, WS_A)
        throw new Error('expected cycle error')
      } catch (error) {
        expect(error).toBeInstanceOf(AgentPresetError)
        expect((error as AgentPresetError).code).toBe('PRESET_INVALID_BASE')
      }
    }
  })

  test('旧 version 2 完成状态会重跑 D1/D2，且保留旧内置副本的禁用状态', () => {
    __setAgentPresetMigrationWorkspacesForTest([WS_A])
    const builtin = { ...BUILTIN_AGENT_PRESETS.find((preset) => preset.id === BUILTIN_PRESET_CODE)!, enabledInWorkspace: false }
    const path = writeLegacyPresetConfig(WS_A, { presets: [builtin], defaultPresetId: BUILTIN_PRESET_CODE })
    writeFileSync(join(tmpDir, 'agent-preset-migration.json'), JSON.stringify({ version: 2, status: 'completed', startedAt: '2026-01-01T00:00:00.000Z', completedWorkspaces: [WS_A], remappedIds: [], diagnostics: [], failures: [] }))

    const state = ensurePresetSystemReady()
    const migrated = JSON.parse(readFileSync(path, 'utf8')) as AgentPresetConfig
    expect(state.version).toBe(3)
    expect(migrated.presets).toHaveLength(0)
    expect(migrated.disabledGlobalPresetIds).toEqual([BUILTIN_PRESET_CODE])
    expect(listAgentPresets(WS_A).find((preset) => preset.id === BUILTIN_PRESET_CODE)?.enabledInWorkspace).toBe(false)
  })

  test('D1/D2：正常内置副本不落为 workspace 实体，引用改为 builtin-meta', () => {
    __setAgentPresetMigrationWorkspacesForTest([WS_A])
    const builtin = BUILTIN_AGENT_PRESETS.find((preset) => preset.id === BUILTIN_PRESET_CODE)!
    writeLegacyPresetConfig(WS_A, { presets: [{ ...builtin }], defaultPresetId: BUILTIN_PRESET_CODE })
    const state = ensurePresetSystemReady()
    const migrated = JSON.parse(readFileSync(join(tmpDir, WS_A, 'agent-presets.json'), 'utf8')) as AgentPresetConfig
    expect(state.status).toBe('completed')
    expect(migrated.presets).toHaveLength(0)
    expect(migrated.defaultPresetReference?.presetScope).toBe('builtin-meta')
    expect(migrated.defaultPresetReference?.presetId).toBe(BUILTIN_PRESET_CODE)
  })

  test('D3/D5：内置 ID 内容异常时生成 workspace UUID，保护原文并记录映射', () => {
    __setAgentPresetMigrationWorkspacesForTest([WS_A])
    const path = writeLegacyPresetConfig(WS_A, {
      presets: [{ id: BUILTIN_PRESET_STANDARD, name: '用户改过的标准', description: '保留', isBuiltin: true, createdAt: 1, updatedAt: 2 }],
      defaultPresetId: BUILTIN_PRESET_STANDARD,
    })
    const state = ensurePresetSystemReady()
    const migrated = JSON.parse(readFileSync(path, 'utf8')) as AgentPresetConfig
    expect(migrated.presets).toHaveLength(1)
    expect(migrated.presets[0]?.scope).toBe('workspace')
    expect(migrated.presets[0]?.migrationStatus).toBe('builtin-corrupt')
    expect(state.remappedIds).toEqual(expect.arrayContaining([expect.objectContaining({ oldId: BUILTIN_PRESET_STANDARD, reason: 'builtin-conflict' })]))
    expect(migrated.defaultPresetReference?.presetScope).toBe('workspace')
  })

  test('C7/D5：重复旧 ID 无法精确消歧时失败并保留源配置，不把引用指向最后一个副本', () => {
    __setAgentPresetMigrationWorkspacesForTest([WS_A])
    const path = writeLegacyPresetConfig(WS_A, {
      presets: [
        { id: 'same-id', name: '重复一', description: '', isBuiltin: false, createdAt: 1, updatedAt: 2 },
        { id: 'same-id', name: '重复二', description: '', isBuiltin: false, createdAt: 1, updatedAt: 2 },
      ],
      defaultPresetId: 'same-id',
    })
    const state = ensurePresetSystemReady()
    expect(state.status).toBe('failed')
    expect(state.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'id-conflict' })]))
    const original = JSON.parse(readFileSync(path, 'utf8')) as { presets: AgentPreset[] }
    expect(original.presets).toHaveLength(2)
    expect(original.presets.every((preset) => preset.scope === undefined)).toBe(true)
  })

  test('D4：损坏配置迁移失败、保留源文件和备份，并允许修复后重试', () => {
    __setAgentPresetMigrationWorkspacesForTest([WS_A])
    const path = writeLegacyPresetConfig(WS_A, { presets: [{ id: 'missing-name', description: '', isBuiltin: false, createdAt: 1, updatedAt: 2 }], defaultPresetId: 'missing-name' })
    const first = ensurePresetSystemReady()
    expect(first.status).toBe('failed')
    expect(JSON.parse(readFileSync(path, 'utf8')).presets[0].id).toBe('missing-name')
    expect(existsSync(join(tmpDir, WS_A, '.migration-backup'))).toBe(true)
    expect(readdirSync(join(tmpDir, WS_A, '.migration-backup')).some((entry) => entry.startsWith('preset-system-'))).toBe(true)
    writeFileSync(path, JSON.stringify({ presets: [{ id: 'fixed', name: '修复后', description: '', isBuiltin: false, createdAt: 1, updatedAt: 2 }], defaultPresetId: 'fixed' }))
    const retried = ensurePresetSystemReady()
    expect(retried.status).toBe('completed')
    expect((JSON.parse(readFileSync(path, 'utf8')) as AgentPresetConfig).presets[0]?.scope).toBe('workspace')
  })
})

describe('getAgentPreset', () => {
  test('未知/缺失 ID 回退 standard', () => {
    expect(getAgentPreset(WS_A, undefined).id).toBe(BUILTIN_PRESET_STANDARD)
    expect(getAgentPreset(WS_A, 'nonexistent').id).toBe(BUILTIN_PRESET_STANDARD)
  })

  test('按 ID 返回对应预设', () => {
    expect(getAgentPreset(WS_A, BUILTIN_PRESET_MINIMAL).id).toBe(BUILTIN_PRESET_MINIMAL)
  })
})

describe('默认预设', () => {
  test('无配置时保持 standard 默认预设', () => {
    expect(getDefaultPresetId(WS_A)).toBe(DEFAULT_PRESET_ID)
    expect(getDefaultPresetId(undefined)).toBe(DEFAULT_PRESET_ID)
  })

  test('setDefaultPresetId 持久化、支持清除并拒绝未知 ID', () => {
    expect(setDefaultPresetId(WS_A, BUILTIN_PRESET_CODE)).toBe(BUILTIN_PRESET_CODE)
    expect(getDefaultPresetId(WS_A)).toBe(BUILTIN_PRESET_CODE)
    expect(() => setDefaultPresetId(WS_A, 'bad-id')).toThrow('预设不存在')
    expect(setDefaultPresetId(WS_A, '')).toBe('')
    expect(getDefaultPresetId(WS_A)).toBe('')
    expect(existsSync(join(tmpDir, WS_A, 'agent-presets.json'))).toBe(true)
    const raw = JSON.parse(readFileSync(join(tmpDir, WS_A, 'agent-presets.json'), 'utf-8'))
    expect(raw.defaultPresetId).toBe('')
  })
})

describe('normalizeSessionPresetId', () => {
  test('兼容旧会话缺省预设时使用 standard', () => {
    expect(normalizeSessionPresetId(WS_A, undefined)).toBe(DEFAULT_PRESET_ID)
  })

  test('已知内置 ID 原样返回', () => {
    expect(normalizeSessionPresetId(WS_A, BUILTIN_PRESET_MINIMAL)).toBe(BUILTIN_PRESET_MINIMAL)
  })

  test('未知 ID 回退 standard', () => {
    expect(normalizeSessionPresetId(WS_A, 'legacy-custom')).toBe(DEFAULT_PRESET_ID)
  })

  test('已知自定义预设 ID 原样保留（不被误回退 standard）', () => {
    const created = createAgentPreset(WS_A, { name: '岗位A', description: '' })
    expect(normalizeSessionPresetId(WS_A, created.id)).toBe(created.id)
    // 重读配置后仍保留
    expect(normalizeSessionPresetId(WS_A, created.id)).toBe(created.id)
  })

  test('其他工作区的自定义 ID 在本工作区回退 standard（隔离）', () => {
    const other = createAgentPreset(WS_B, { name: 'B区岗位', description: '' })
    expect(normalizeSessionPresetId(WS_A, other.id)).toBe(DEFAULT_PRESET_ID)
    expect(normalizeSessionPresetId(WS_B, other.id)).toBe(other.id)
  })
})

describe('自定义预设 CRUD', () => {
  test('createAgentPreset 新建并持久化，list 可见', () => {
    const created = createAgentPreset(WS_A, {
      name: '研究模式',
      description: '只读调研',
      skillSlugs: ['web-search'],
      modelId: 'bound-model',
      effort: 'high',
    })
    expect(created.id).toBeTruthy()
    expect(created.isBuiltin).toBe(false)

    const presets = listAgentPresets(WS_A)
    expect(presets.length).toBe(4)
    expect(presets.find((p) => p.id === created.id)?.name).toBe('研究模式')
    expect(getAgentPreset(WS_A, created.id).id).toBe(created.id)
    expect(getAgentPreset(WS_A, created.id).modelId).toBe('bound-model')
  })

  test('名称为空拒绝创建', () => {
    expect(() => createAgentPreset(WS_A, { name: '  ', description: '' })).toThrow('预设名称不能为空')
  })

  test('派生预设保留自身模型绑定，并可更新绑定', () => {
    const created = createAgentPreset(WS_A, {
      name: '模型岗位',
      description: '',
      modelId: 'base-model',
      basePresetId: BUILTIN_PRESET_CODE,
    })
    expect(getAgentPreset(WS_A, created.id).modelId).toBe('base-model')
    updateAgentPreset(WS_A, created.id, { modelId: 'override-model' })
    expect(getAgentPreset(WS_A, created.id).modelId).toBe('override-model')
  })


  test('工作区隔离：A 区自定义预设对 B 区不可见', () => {
    createAgentPreset(WS_A, { name: 'A区专属', description: '' })
    expect(listAgentPresets(WS_A).length).toBe(4)
    expect(listAgentPresets(WS_B).length).toBe(3)
  })

  test('无工作区创建自定义预设被拒绝', () => {
    expect(() => createAgentPreset(undefined, { name: '无区预设', description: '' })).toThrow()
  })

  test('copyAgentPreset 复制内置并保留配置字段', () => {
    const copy = copyAgentPreset(WS_A, BUILTIN_PRESET_MINIMAL, '我的极简')
    expect(copy.name).toBe('我的极简')
    expect(copy.id).not.toBe(BUILTIN_PRESET_MINIMAL)
    expect(copy.isBuiltin).toBe(false)
    expect(copy.promptSections).toEqual(getAgentPreset(WS_A, BUILTIN_PRESET_MINIMAL).promptSections)
    expect(listAgentPresets(WS_A).some((p) => p.id === copy.id)).toBe(true)
  })

  test('复制极简预设保留全部能力组禁用与 suppressPromptSections（三层一致）', () => {
    const copy = copyAgentPreset(WS_A, BUILTIN_PRESET_MINIMAL, '极简副本')
    expect(copy.suppressPromptSections).toEqual(['subagents', 'memory', 'task-graph', 'automation'])
    expect(copy.disabledToolGroups).toEqual([...AGENT_PRESET_TOOL_GROUPS])
  })

  test('创建自定义预设支持 suppressPromptSections 与 disabledToolGroups', () => {
    const created = createAgentPreset(WS_A, {
      name: '轻量',
      description: '只保留核心能力',
      suppressPromptSections: ['subagents', 'memory', 'task-graph'],
      disabledToolGroups: ['task-graph', 'memory', 'collaboration'],
    })
    expect(created.suppressPromptSections).toEqual(['subagents', 'memory', 'task-graph'])
    expect(created.disabledToolGroups).toEqual(['task-graph', 'memory', 'collaboration'])
  })

  test('创建预设拒绝非法 suppress key 与工具组（含具体非法项）', () => {
    expect(() => createAgentPreset(WS_A, {
      name: '脏数据',
      description: '',
      suppressPromptSections: ['memory', 'bad-key'] as unknown as AgentPreset['suppressPromptSections'],
    })).toThrow(/非法的提示词段 key: bad-key/)
    expect(() => createAgentPreset(WS_A, {
      name: '脏数据2',
      description: '',
      disabledToolGroups: ['memory', 'bad-group'] as unknown as AgentPreset['disabledToolGroups'],
    })).toThrow(/非法的工具组: bad-group/)
    // 拒绝后不残留任何记录
    expect(listAgentPresets(WS_A).some((p) => p.name === '脏数据' || p.name === '脏数据2')).toBe(false)
  })

  test('更新预设拒绝非法 suppress key（传 null 清除不受影响）', () => {
    const created = createAgentPreset(WS_A, { name: '校验目标', description: '' })
    expect(() => updateAgentPreset(WS_A, created.id, {
      suppressPromptSections: ['automation', 'ghost'] as unknown as AgentPreset['suppressPromptSections'],
    })).toThrow(/非法的提示词段 key: ghost/)
    // null 清除路径不受校验影响
    const cleared = updateAgentPreset(WS_A, created.id, { suppressPromptSections: null })
    expect(cleared.suppressPromptSections).toBeUndefined()
  })

  test('读取配置时过滤历史脏数据中的非法 suppress key 与工具组', () => {
    const dir = join(tmpDir, WS_A)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'agent-presets.json'), JSON.stringify({
      defaultPresetId: 'standard',
      presets: [{
        id: 'dirty-preset',
        name: '历史脏数据',
        description: '',
        isBuiltin: false,
        createdAt: 0,
        updatedAt: 0,
        suppressPromptSections: ['memory', 'bogus-key'],
        disabledToolGroups: ['task-graph', 'bogus-group'],
      }],
    }))
    const presets = listAgentPresets(WS_A)
    const dirty = presets.find((p) => p.id === 'dirty-preset')
    expect(dirty).toBeDefined()
    expect(dirty?.suppressPromptSections).toEqual(['memory'])
    expect(dirty?.disabledToolGroups).toEqual(['task-graph'])
  })

  test('mcpServerNames 空数组=禁用全部用户 MCP（保留），null=清除', () => {
    const created = createAgentPreset(WS_A, { name: '零 MCP', description: 'd', mcpServerNames: [] })
    expect(created.mcpServerNames).toEqual([])
    expect(listAgentPresets(WS_A).find((preset) => preset.id === created.id)?.mcpServerNames).toEqual([])

    const copied = copyAgentPreset(WS_A, created.id, '零 MCP 副本')
    expect(copied.mcpServerNames).toEqual([])

    const cleared = updateAgentPreset(WS_A, created.id, { mcpServerNames: null })
    expect(cleared.mcpServerNames).toBeUndefined()
  })

  test('updateAgentPreset 更新字段；skillSlugs 空数组=禁用全部 skill（保留），null=清除', () => {
    const created = createAgentPreset(WS_A, { name: '原始', description: 'd', skillSlugs: ['a'] })
    const updated = updateAgentPreset(WS_A, created.id, {
      name: '改名',
      skillSlugs: [],
      effort: 'low',
    })
    expect(updated.name).toBe('改名')
    expect(updated.skillSlugs).toEqual([])
    expect(updated.effort).toBe('low')
    expect(listAgentPresets(WS_A).find((p) => p.id === created.id)?.name).toBe('改名')

    // null = 清除，回退为不裁剪
    const cleared = updateAgentPreset(WS_A, created.id, { skillSlugs: null })
    expect(cleared.skillSlugs).toBeUndefined()
  })

  test('updateAgentPreset 传 null 清除 effort/permissionMode/allowSubagents 与工具组', () => {
    const created = createAgentPreset(WS_A, {
      name: '全配置',
      description: 'd',
      effort: 'high',
      permissionMode: 'plan',
      allowSubagents: false,
      disabledToolGroups: ['task-graph', 'memory'],
      suppressPromptSections: ['memory'],
      promptSections: ['## 段1'],
    })
    const updated = updateAgentPreset(WS_A, created.id, {
      effort: null,
      permissionMode: null,
      allowSubagents: null,
      disabledToolGroups: null,
      suppressPromptSections: null,
      promptSections: null,
    })
    expect(updated.effort).toBeUndefined()
    expect(updated.permissionMode).toBeUndefined()
    expect(updated.allowSubagents).toBeUndefined()
    expect(updated.disabledToolGroups).toBeUndefined()
    expect(updated.suppressPromptSections).toBeUndefined()
    expect(updated.promptSections).toBeUndefined()
  })

  test('内置预设拒绝更新与删除', () => {
    expect(() => updateAgentPreset(WS_A, BUILTIN_PRESET_CODE, { name: 'x' })).toThrow('内置预设不可修改或删除')
    expect(() => deleteAgentPreset(WS_A, BUILTIN_PRESET_CODE)).toThrow('内置预设不可修改或删除')
  })

  test('删除自定义默认预设时自动改用首个仍启用的预设', () => {
    const created = createAgentPreset(WS_A, { name: '临时', description: '' })
    setDefaultPresetId(WS_A, created.id)
    expect(getDefaultPresetId(WS_A)).toBe(created.id)

    deleteAgentPreset(WS_A, created.id)
    expect(listAgentPresets(WS_A).some((p) => p.id === created.id)).toBe(false)
    expect(getDefaultPresetId(WS_A)).toBe(BUILTIN_PRESET_STANDARD)
  })

  test('自定义预设可设为默认并在重读后保持', () => {
    const created = createAgentPreset(WS_A, { name: '默认候选', description: '' })
    expect(setDefaultPresetId(WS_A, created.id)).toBe(created.id)
    // 重新读配置（模拟重启）后仍是自定义默认
    expect(getDefaultPresetId(WS_A)).toBe(created.id)
  })

  test('停用工作区默认预设时自动改用首个仍启用的预设', () => {
    const created = createAgentPreset(WS_A, { name: '临时默认', description: '' })
    setDefaultPresetId(WS_A, created.id)
    setWorkspacePresetEnabled(WS_A, created.id, false)
    expect(getDefaultPresetId(WS_A)).toBe(BUILTIN_PRESET_STANDARD)
  })

  test('不存在预设的更新/删除抛错', () => {
    expect(() => updateAgentPreset(WS_A, 'no-such-id', { name: 'x' })).toThrow('预设不存在')
    expect(() => deleteAgentPreset(WS_A, 'no-such-id')).toThrow('预设不存在')
  })

  test('跨工作区更新/删除被拒绝（预设不存在）', () => {
    const created = createAgentPreset(WS_A, { name: 'A区', description: '' })
    expect(() => updateAgentPreset(WS_B, created.id, { name: 'x' })).toThrow('预设不存在')
    expect(() => deleteAgentPreset(WS_B, created.id)).toThrow('预设不存在')
  })
})

describe('预设导出 / 导入文件', () => {
  test('导出剥离本地元数据（id/isBuiltin/时间戳），能力字段完整保留', () => {
    const created = createAgentPreset(WS_A, {
      name: '研究模式',
      description: '只读调研',
      promptSections: ['## 研究模式'],
      suppressPromptSections: ['task-graph'],
      disabledToolGroups: ['task-graph'],
      effort: 'high',
      permissionMode: 'plan',
      skillSlugs: ['web-search'],
      mcpServerNames: ['filesystem'],
      allowSubagents: false,
    })
    const json = serializeAgentPresetsForExport([created])
    const parsed = JSON.parse(json) as { format: string; version: number; presets: Array<Record<string, unknown>> }
    expect(parsed.format).toBe('profer-agent-presets')
    expect(parsed.version).toBe(1)
    expect(parsed.presets).toHaveLength(1)
    const entry = parsed.presets[0]!
    expect(entry.name).toBe('研究模式')
    expect(entry.effort).toBe('high')
    expect(entry.permissionMode).toBe('plan')
    expect(entry.allowSubagents).toBe(false)
    expect(entry.skillSlugs).toEqual(['web-search'])
    expect(entry.mcpServerNames).toEqual(['filesystem'])
    expect(entry.id).toBeUndefined()
    expect(entry.isBuiltin).toBeUndefined()
    expect(entry.createdAt).toBeUndefined()
  })

  test('导出后导入到另一个工作区：空 MCP 白名单保持为禁用全部用户 MCP', () => {
    const created = createAgentPreset(WS_A, {
      name: '零 MCP 导出',
      description: '不加载用户 MCP',
      mcpServerNames: [],
    })
    const result = importAgentPresets(WS_B, serializeAgentPresetsForExport([created]))
    expect(result.imported[0]?.mcpServerNames).toEqual([])
    expect(listAgentPresets(WS_B).find((preset) => preset.id === result.imported[0]?.id)?.mcpServerNames).toEqual([])
  })

  test('导出后导入到另一个工作区：新 UUID、能力字段保留', () => {
    const created = createAgentPreset(WS_A, {
      name: '研究模式',
      description: '只读调研',
      effort: 'high',
      skillSlugs: ['web-search'],
      disabledToolGroups: ['task-graph'],
    })
    const json = serializeAgentPresetsForExport([created])
    const result = importAgentPresets(WS_B, json)

    expect(result.imported).toHaveLength(1)
    const imported = result.imported[0]!
    expect(imported.id).not.toBe(created.id)
    expect(imported.isBuiltin).toBe(false)
    expect(imported.name).toBe('研究模式')
    expect(imported.effort).toBe('high')
    expect(imported.skillSlugs).toEqual(['web-search'])
    expect(imported.disabledToolGroups).toEqual(['task-graph'])
    expect(result.renamedNames).toEqual([])
    // 落盘可重读
    expect(listAgentPresets(WS_B).some((p) => p.id === imported.id)).toBe(true)
  })

  test('内置预设可导出，导入后转为自定义预设', () => {
    const json = serializeAgentPresetsForExport(listAgentPresets(WS_A))
    const result = importAgentPresets(WS_B, json)
    // 内置三预设 + 重名冲突：WS_B 本就有三个同名内置预设，全部追加「（导入）」后缀
    expect(result.imported).toHaveLength(3)
    expect(result.renamedNames.sort()).toEqual(['代码', '极简', '标准'])
    for (const preset of result.imported) {
      expect(preset.isBuiltin).toBe(false)
      expect(preset.name.endsWith('（导入）')).toBe(true)
    }
  })

  test('非法文件整体拒绝：坏 JSON / 坏 format / 坏版本 / 坏条目 / 空列表', () => {
    expect(() => importAgentPresets(WS_A, 'not json')).toThrow('不是合法的 JSON')
    expect(() => importAgentPresets(WS_A, JSON.stringify({ format: 'other', version: 1, presets: [] }))).toThrow('不是 Profer 预设导出文件')
    expect(() => importAgentPresets(WS_A, JSON.stringify({ format: 'profer-agent-presets', version: 99, presets: [] }))).toThrow('版本不受支持')
    expect(() => importAgentPresets(WS_A, JSON.stringify({ format: 'profer-agent-presets', version: 1, presets: 'x' }))).toThrow('缺少 presets 数组')
    expect(() => importAgentPresets(WS_A, JSON.stringify({ format: 'profer-agent-presets', version: 1, presets: [] }))).toThrow('不包含任何预设')
    expect(() => importAgentPresets(WS_A, JSON.stringify({
      format: 'profer-agent-presets',
      version: 1,
      presets: [{ name: '' }],
    }))).toThrow('name 缺失或为空')
    expect(() => importAgentPresets(WS_A, JSON.stringify({
      format: 'profer-agent-presets',
      version: 1,
      presets: [{ name: 'x', disabledToolGroups: ['不存在组'] }],
    }))).toThrow('含非法工具组')
  })

  test('非法条目导致整体拒绝：合法条目也不落盘（原子性）', () => {
    const json = JSON.stringify({
      format: 'profer-agent-presets',
      version: 1,
      presets: [
        { name: '合法', description: 'ok' },
        { name: '非法', effort: 'super-mega' },
      ],
    })
    expect(() => importAgentPresets(WS_A, json)).toThrow('effort 非法')
    expect(listAgentPresets(WS_A).some((p) => p.name === '合法')).toBe(false)
  })

  test('未知字段被忽略（前向兼容），重复导入重名追加后缀', () => {
    const json = JSON.stringify({
      format: 'profer-agent-presets',
      version: 1,
      exportedAt: '2026-08-16T00:00:00.000Z',
      presets: [{ name: '迁移预设', description: '', futureField: { nested: true } }],
    })
    const first = importAgentPresets(WS_A, json)
    expect(first.imported).toHaveLength(1)
    expect(first.renamedNames).toEqual([])
    // 再次导入同名 → 追加后缀
    const second = importAgentPresets(WS_A, json)
    expect(second.imported[0]!.name).toBe('迁移预设（导入）')
    expect(second.renamedNames).toEqual(['迁移预设'])
  })
})

describe('派生预设（basePresetId）', () => {
  test('Given 基于 code 创建派生预设 When 读取 Then 列表保留差异、生效配置合并基座提示词段', () => {
    const created = createAgentPreset(WS_A, {
      name: '代码·测试强化',
      description: '在代码预设上追加测试要求',
      basePresetId: BUILTIN_PRESET_CODE,
      promptSections: ['## 测试强化\n\n每个改动必须补单测。'],
    })

    // 存储态只存差异
    const raw = listAgentPresets(WS_A).find((p) => p.id === created.id)!
    expect(raw.basePresetId).toBe(BUILTIN_PRESET_CODE)
    expect(raw.promptSections).toEqual(['## 测试强化\n\n每个改动必须补单测。'])
    expect(raw.isBuiltin).toBe(false)

    // 生效态 = 基座提示词段在前 + 子预设追加
    const resolved = getAgentPreset(WS_A, created.id)
    expect(resolved.id).toBe(created.id)
    expect(resolved.promptSections).toHaveLength(2)
    expect(resolved.promptSections![0]).toContain('代码任务模式')
    expect(resolved.promptSections![1]).toContain('测试强化')
  })

  test('Given 基于 minimal 派生并追加禁用 When 合并 Then suppress 与工具组为并集且映射兜底补全', () => {
    const created = createAgentPreset(WS_A, {
      name: '极简·无自动化',
      description: '',
      basePresetId: BUILTIN_PRESET_MINIMAL,
      // 只禁用工具组、不显式 suppress：验证生效路径按映射表自动补全（三层一致兜底）
      disabledToolGroups: ['automation'],
    })
    const resolved = getAgentPreset(WS_A, created.id)
    expect(resolved.suppressPromptSections).toEqual(['subagents', 'memory', 'task-graph', 'automation'])
    expect(resolved.disabledToolGroups).toEqual([...AGENT_PRESET_TOOL_GROUPS])
  })

  test('mergeAgentPreset 纯函数：标量字段子预设定义则覆盖、未定义继承基座', async () => {
    const { mergeAgentPreset } = await import('@profer/shared')
    const base: AgentPreset = {
      id: 'base', name: '基座', description: '', isBuiltin: true,
      effort: 'high', permissionMode: 'plan', skillSlugs: ['a', 'b'],
      mcpServerNames: ['m1'], allowSubagents: false, createdAt: 0, updatedAt: 0,
    }
    const child: AgentPreset = {
      id: 'child', name: '派生', description: '', isBuiltin: false,
      effort: 'low', permissionMode: 'auto',
      createdAt: 1, updatedAt: 1,
    }
    const merged = mergeAgentPreset(base, child)
    expect(merged.id).toBe('child')
    expect(merged.effort).toBe('low')
    expect(merged.permissionMode).toBe('auto')
    // 未定义字段继承基座
    expect(merged.skillSlugs).toEqual(['a', 'b'])
    expect(merged.mcpServerNames).toEqual(['m1'])
    expect(merged.allowSubagents).toBe(false)
  })

  test('Given 非内置 basePresetId When 创建 Then 拒绝（含自定义 ID 与未知字符串）', () => {
    const existing = createAgentPreset(WS_A, { name: '普通', description: '' })
    expect(() => createAgentPreset(WS_A, { name: 'x', description: '', basePresetId: existing.id }))
      .toThrow('派生基座必须是内置预设')
    expect(() => createAgentPreset(WS_A, { name: 'y', description: '', basePresetId: 'not-exist' }))
      .toThrow('派生基座必须是内置预设')
  })

  test('Given 切换基座 When update basePresetId Then 生效配置跟随新基座', () => {
    const created = createAgentPreset(WS_A, {
      name: '会漂移的预设',
      description: '',
      basePresetId: BUILTIN_PRESET_CODE,
    })
    expect(getAgentPreset(WS_A, created.id).promptSections?.[0]).toContain('代码任务模式')

    updateAgentPreset(WS_A, created.id, { basePresetId: BUILTIN_PRESET_MINIMAL })
    const resolved = getAgentPreset(WS_A, created.id)
    expect(resolved.promptSections?.[0]).toContain('极简模式')
    expect(resolved.suppressPromptSections).toEqual(['subagents', 'memory', 'task-graph', 'automation'])
  })

  test('Given 脱离基座 When update basePresetId=null Then 冻结当前生效配置且不再跟随内置', () => {
    const created = createAgentPreset(WS_A, {
      name: '先派生后独立',
      description: '',
      basePresetId: BUILTIN_PRESET_CODE,
      disabledToolGroups: ['automation'],
    })
    const before = getAgentPreset(WS_A, created.id)

    updateAgentPreset(WS_A, created.id, { basePresetId: null })
    const raw = listAgentPresets(WS_A).find((p) => p.id === created.id)!
    expect(raw.basePresetId).toBeUndefined()
    // 脱离前后生效配置一致（差异已冻结进存储字段）
    const after = getAgentPreset(WS_A, created.id)
    expect(after.promptSections).toEqual(before.promptSections)
    expect(after.disabledToolGroups).toEqual(before.disabledToolGroups)
  })

  test('Given 复制派生预设 When copyAgentPreset Then 副本保留基座继续跟随内置升级', () => {
    const created = createAgentPreset(WS_A, {
      name: '派生源',
      description: '',
      basePresetId: BUILTIN_PRESET_CODE,
      promptSections: ['## 追加段'],
    })
    const copy = copyAgentPreset(WS_A, created.id, '派生副本')
    expect(copy.basePresetId).toBe(BUILTIN_PRESET_CODE)
    const resolved = getAgentPreset(WS_A, copy.id)
    expect(resolved.promptSections).toHaveLength(2)
    expect(resolved.promptSections![0]).toContain('代码任务模式')
  })

  test('旧版本的元预设引用仍能解析，并跟随当前元预设定义', () => {
    expect(() => resolvePresetReference({
      presetId: BUILTIN_PRESET_CODE,
      presetScope: 'builtin-meta',
      presetVersion: '1.0.0',
    }, WS_A)).not.toThrow()
    expect(resolvePresetReference({
      presetId: BUILTIN_PRESET_CODE,
      presetScope: 'builtin-meta',
      presetVersion: '1.0.0',
    }, WS_A).version).toBe('1.4.0')
  })

  test('基于代码元预设的岗位会跟随基座 Prompt 变化，但保留自己的描述和追加段', () => {
    const created = createAgentPreset(WS_A, {
      name: '代码派生岗位',
      description: '我的专用代码流程',
      basePresetId: BUILTIN_PRESET_CODE,
      promptSections: ['## 子岗位要求'],
    })
    const code = BUILTIN_AGENT_PRESETS.find((preset) => preset.id === BUILTIN_PRESET_CODE)!
    const originalSections = code.promptSections
    try {
      code.promptSections = [...(originalSections ?? []), '## 元预设后续补充']
      const resolved = getAgentPreset(WS_A, created.id)
      expect(resolved.description).toBe('我的专用代码流程')
      expect(resolved.promptSections).toEqual([
        ...(originalSections ?? []),
        '## 元预设后续补充',
        '## 子岗位要求',
      ])
    } finally {
      code.promptSections = originalSections
    }
  })

  test('脱离基座后冻结当前状态，后续元预设变化不会改写工作区岗位', () => {
    const created = createAgentPreset(WS_A, {
      name: '冻结代码岗位',
      description: '',
      basePresetId: BUILTIN_PRESET_CODE,
      promptSections: ['## 冻结时的要求'],
    })
    const beforeDetach = getAgentPreset(WS_A, created.id)
    updateAgentPreset(WS_A, created.id, { basePresetId: null })

    const code = BUILTIN_AGENT_PRESETS.find((preset) => preset.id === BUILTIN_PRESET_CODE)!
    const originalSections = code.promptSections
    try {
      code.promptSections = [...(originalSections ?? []), '## 元预设新版本要求']
      const resolved = getAgentPreset(WS_A, created.id)
      expect(resolved.promptSections).toEqual(beforeDetach.promptSections)
      expect(listAgentPresets(WS_A).find((preset) => preset.id === created.id)?.basePresetId).toBeUndefined()
    } finally {
      code.promptSections = originalSections
    }
  })

  test('Given 手工写入非法 basePresetId 的配置 When 读取 Then 保留原始基座并标记 invalid-base', () => {
    mkdirSync(join(tmpDir, WS_A), { recursive: true })
    writeFileSync(join(tmpDir, WS_A, 'agent-presets.json'), JSON.stringify({
      presets: [{
        id: 'dirty-derived',
        name: '脏派生',
        description: '',
        isBuiltin: false,
        basePresetId: 'removed-builtin',
        createdAt: 1,
        updatedAt: 1,
      }],
      defaultPresetId: DEFAULT_PRESET_ID,
    }))
    const raw = listAgentPresets(WS_A).find((p) => p.id === 'dirty-derived')!
    expect(raw.basePresetId).toBe('removed-builtin')
    expect(raw.migrationStatus).toBe('invalid-base')
    expect(() => getAgentPreset(WS_A, 'dirty-derived')).toThrow('非法派生基座')
  })

  test('Given 导出派生预设 When 跨机器导入 Then 保留基座引用；非法基座导入被拒绝', () => {
    const created = createAgentPreset(WS_A, {
      name: '跨机器派生',
      description: '',
      basePresetId: BUILTIN_PRESET_CODE,
      promptSections: ['## 跨机器段'],
    })
    const json = serializeAgentPresetsForExport([created])
    expect(json).toContain(`"basePresetId": "${BUILTIN_PRESET_CODE}"`)

    // 合法基座：导入后为派生预设（内置 ID 跨机器通用）
    const result = importAgentPresets(WS_B, json)
    expect(result.imported[0]!.basePresetId).toBe(BUILTIN_PRESET_CODE)
    expect(getAgentPreset(WS_B, result.imported[0]!.id).promptSections).toHaveLength(2)

    // 非法基座：整体拒绝
    const badJson = JSON.stringify({
      format: 'profer-agent-presets',
      version: 1,
      presets: [{ name: '坏基座', basePresetId: 'custom-base' }],
    })
    expect(() => importAgentPresets(WS_A, badJson)).toThrow('basePresetId 必须是内置预设 ID')
  })
})

describe('单工具裁剪（disabledTools）', () => {
  test('Given 合法短名 When 创建预设 Then 落盘并在生效配置中可见', () => {
    const created = createAgentPreset(WS_A, {
      name: '无委派精简',
      description: '',
      disabledTools: ['delegate_agent', 'run_automation_now'],
    })
    const raw = listAgentPresets(WS_A).find((p) => p.id === created.id)!
    expect(raw.disabledTools).toEqual(['delegate_agent', 'run_automation_now'])
    expect(getAgentPreset(WS_A, created.id).disabledTools).toEqual(['delegate_agent', 'run_automation_now'])
  })

  test('Given 非法短名 When 创建或更新 Then 拒绝（含具体非法项）', () => {
    expect(() => createAgentPreset(WS_A, { name: 'x', description: '', disabledTools: ['不存在的工具'] }))
      .toThrow('非法的单工具短名')
    const created = createAgentPreset(WS_A, { name: 'y', description: '' })
    expect(() => updateAgentPreset(WS_A, created.id, { disabledTools: ['fake_tool'] }))
      .toThrow('非法的单工具短名')
  })

  test('Given 派生预设 When 合并 Then disabledTools 取并集去重', () => {
    const created = createAgentPreset(WS_A, {
      name: '派生叠加裁剪',
      description: '',
      basePresetId: BUILTIN_PRESET_CODE,
      disabledTools: ['delegate_agent', 'run_automation_now'],
    })
    // 基座 code 关闭 AI 生图与皮肤创建；子预设的单工具禁用在其基础上做并集。
    expect(getAgentPreset(WS_A, created.id).disabledTools).toEqual(['generate_image', 'create_skin', 'delegate_agent', 'run_automation_now'])
  })

  test('Given 更新清空 When disabledTools=null Then 恢复完整工具集', () => {
    const created = createAgentPreset(WS_A, {
      name: '先裁后放',
      description: '',
      disabledTools: ['delegate_agent'],
    })
    updateAgentPreset(WS_A, created.id, { disabledTools: null })
    expect(getAgentPreset(WS_A, created.id).disabledTools).toBeUndefined()
  })

  test('Given 手工写入非法短名 When 读取 Then 净化剔除非法项', () => {
    mkdirSync(join(tmpDir, WS_A), { recursive: true })
    writeFileSync(join(tmpDir, WS_A, 'agent-presets.json'), JSON.stringify({
      presets: [{
        id: 'dirty-tools',
        name: '脏工具',
        description: '',
        isBuiltin: false,
        disabledTools: ['delegate_agent', 'ghost_tool'],
        createdAt: 1,
        updatedAt: 1,
      }],
      defaultPresetId: DEFAULT_PRESET_ID,
    }))
    const raw = listAgentPresets(WS_A).find((p) => p.id === 'dirty-tools')!
    expect(raw.disabledTools).toEqual(['delegate_agent'])
  })

  test('Given 导出/导入 When 携带 disabledTools Then 跨机器保留；非法短名导入整体拒绝', () => {
    const created = createAgentPreset(WS_A, {
      name: '跨机器裁工具',
      description: '',
      disabledTools: ['delegate_agent'],
    })
    const json = serializeAgentPresetsForExport([created])
    expect(json).toContain('"disabledTools"')
    const result = importAgentPresets(WS_B, json)
    expect(result.imported[0]!.disabledTools).toEqual(['delegate_agent'])

    const badJson = JSON.stringify({
      format: 'profer-agent-presets',
      version: 1,
      presets: [{ name: '坏工具', disabledTools: ['ghost_tool'] }],
    })
    expect(() => importAgentPresets(WS_A, badJson)).toThrow('disabledTools 含非法单工具短名')
  })

  test('filterDisabledTools 纯函数：短名与 mcp__server__tool 两种口径都能过滤', async () => {
    const { filterDisabledTools } = await import('@profer/shared')
    const claudeTools = [{ name: 'delegate_agent' }, { name: 'delegate_agents' }]
    const piTools = [{ name: 'mcp__collaboration__delegate_agent' }, { name: 'mcp__collaboration__delegate_agents' }]
    expect(filterDisabledTools(claudeTools, ['delegate_agent']).map((t) => t.name)).toEqual(['delegate_agents'])
    expect(filterDisabledTools(piTools, ['delegate_agent']).map((t) => t.name)).toEqual(['mcp__collaboration__delegate_agents'])
    // 未传禁用列表时原样返回（不复制）
    expect(filterDisabledTools(claudeTools, undefined)).toBe(claudeTools)
  })
})
