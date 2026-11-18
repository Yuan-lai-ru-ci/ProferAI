import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveCorePreset } from './preset-resources'
import { createCoreAgentRuntime } from './runtime'

// 不访问当前用户配置；只使用每例创建的Core fixture。
test('Core严格预设解析隔离作用域、版本、继承与禁用项', async () => {
  const root = await mkdtemp(join(tmpdir(), 'profer-core-presets-'))
  const config = { host: '127.0.0.1', port: 0, configDir: root, workspaceRoot: join(root, 'workspaces') }
  const runtime = createCoreAgentRuntime(config)
  try {
    const workspace = runtime.workspaces.createManaged('preset fixture')
    const directory = join(config.workspaceRoot, workspace.slug)
    const preset = { id: 'fixture-preset', name: 'fixture', description: 'fixture', version: '1', createdAt: 0, updatedAt: 0,
      basePresetId: 'code', permissionMode: 'plan', disabledTools: ['Write'], skillSlugs: [], mcpServerNames: [] }
    await writeFile(join(directory, 'agent-presets.json'), JSON.stringify({ presets: [preset], defaultPresetId: 'standard' }))
    const session = runtime.sessions.create({ title: 'preset', runtime: 'pi', workspaceId: workspace.id, permissionMode: 'bypassPermissions',
      presetReference: { presetId: preset.id, presetScope: 'workspace', workspaceSlug: 'old-workspace', presetVersion: '1' } })
    const resolved = resolveCorePreset(config, session, workspace)
    expect(resolved.policy.permissionMode).toBe('plan')
    await expect(runtime.updateSessionMeta(session.id, { permissionMode: 'bypassPermissions' })).rejects.toThrow('预设权限上限')
    expect(resolved.policy.disabledTools).toContain('Write')
    expect(resolved.policy.disabledToolGroups).toContain('browser')
    expect(resolved.policy.allowedSkillSlugs).toEqual([])
    expect(resolved.policy.allowedMcpServerNames).toEqual([])
    expect(() => resolveCorePreset(config, { ...session, presetReference: { ...session.presetReference!, presetVersion: 'old' } }, workspace)).toThrow('版本已变化')
    expect(() => resolveCorePreset(config, { ...session, presetReference: undefined, presetId: 'missing' }, workspace)).toThrow('Core预设不存在')
    expect(() => resolveCorePreset(config, { ...session, presetReference: { presetId: 'standard', presetScope: 'builtin-meta', workspaceSlug: workspace.slug } }, workspace)).toThrow('全局预设引用不得携带')
    await writeFile(join(directory, 'agent-presets.json'), JSON.stringify({ presets: [preset], disabledWorkspacePresetIds: [preset.id] }))
    expect(() => resolveCorePreset(config, session, workspace)).toThrow('预设不存在')
    await mkdir(join(directory, 'presets'))
    await writeFile(join(directory, 'presets', '_config.json'), JSON.stringify({ schema: 'profer.presets/1', defaultPresetId: 'standard' }))
    await writeFile(join(directory, 'presets', `${preset.id}.json`), JSON.stringify({ ...preset, schema: 'profer.preset/1' }))
    expect(resolveCorePreset(config, session, workspace).preset.id).toBe(preset.id)
  } finally { runtime.dispose(); await rm(root, { recursive: true, force: true }) }
})

test('Core无法取得原预设时在provider前失败，不创建默认替代运行', async () => {
  const root = await mkdtemp(join(tmpdir(), 'profer-core-preset-missing-'))
  const runtime = createCoreAgentRuntime({ host: '127.0.0.1', port: 0, configDir: root, workspaceRoot: join(root, 'workspaces'), mockAgent: true })
  try {
    const session = runtime.sessions.create({ title: 'missing', runtime: 'pi', presetReference: { presetId: 'not-on-core', presetScope: 'user-global' } })
    const handle = runtime.coordinator.run(runtime.createQuery(session, 'must not use standard'))
    expect(await handle.promise).toMatchObject({ status: 'failed', error: expect.stringContaining('预设不存在') })
    expect(runtime.sessions.getMeta(session.id)?.presetReference?.presetId).toBe('not-on-core')
  } finally { runtime.dispose(); await rm(root, { recursive: true, force: true }) }
})
