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
    const manual = await runtime.updateSessionMeta(session.id, { permissionMode: 'bypassPermissions' })
    expect(manual).toMatchObject({ permissionMode: 'bypassPermissions', permissionModeSource: 'user' })
    expect(runtime.permissions.getMode(session.id)).toBe('bypassPermissions')
    expect(resolveCorePreset(config, manual, workspace).policy.permissionMode).toBe('bypassPermissions')
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
    const workspace = runtime.workspaces.createManaged('missing-preset')
    const session = runtime.sessions.create({ title: 'missing', runtime: 'pi', workspaceId: workspace.id })
    runtime.sessions.updateMeta(session.id, { presetReference: { presetId: 'not-on-core', presetScope: 'user-global' } })
    const handle = runtime.coordinator.run(runtime.createQuery(session, 'must not use standard'))
    expect(await handle.promise).toMatchObject({ status: 'failed', error: expect.stringContaining('预设不存在') })
    expect(runtime.sessions.getMeta(session.id)?.presetReference?.presetId).toBe('not-on-core')
  } finally { runtime.dispose(); await rm(root, { recursive: true, force: true }) }
})

test('新建与重绑采用目标预设默认，手动权限持久化，历史无来源不冒充授权', async () => {
  const root = await mkdtemp(join(tmpdir(), 'profer-core-preset-source-'))
  const config = { host: '127.0.0.1', port: 0, configDir: root, workspaceRoot: join(root, 'workspaces'), mockAgent: true }
  let runtime = createCoreAgentRuntime(config)
  try {
    const workspace = runtime.workspaces.createManaged('source fixture')
    const presets = ['plan', 'bypassPermissions'].map((permissionMode, index) => ({ id: `mode-${index}`, name: `Mode ${index}`, description: 'source fixture', version: '1', createdAt: 0, updatedAt: 0, permissionMode, disabledTools: ['Write'] }))
    await writeFile(join(config.workspaceRoot, workspace.slug, 'agent-presets.json'), JSON.stringify({ presets }))
    const session = runtime.sessions.create({ title: 'defaults', runtime: 'pi', workspaceId: workspace.id, presetId: 'mode-1' })
    expect(session).toMatchObject({ permissionMode: 'bypassPermissions', permissionModeSource: 'preset' })
    const rebound = await runtime.updateSessionMeta(session.id, { presetId: 'mode-0' })
    expect(rebound).toMatchObject({ permissionMode: 'plan', permissionModeSource: 'preset' })
    const manual = await runtime.updateSessionMeta(session.id, { permissionMode: 'bypassPermissions' })
    expect(manual.permissionModeSource).toBe('user')
    expect(runtime.permissions.getMode(session.id)).toBe('bypassPermissions')
    const manualGate = runtime.permissions.createCanUseTool({ sessionId: session.id, sendPermissionRequest: () => {} })
    expect((await manualGate('Write', { file_path: join(root, 'still-disabled.txt') }, { signal: new AbortController().signal })).behavior).toBe('deny')
    runtime.dispose()
    runtime = createCoreAgentRuntime(config)
    expect(runtime.permissions.getMode(session.id)).toBe('bypassPermissions')
    expect(resolveCorePreset(config, { ...manual, permissionModeSource: undefined }, workspace).policy.permissionMode).toBe('plan')
    const loose = await runtime.updateSessionMeta(session.id, { presetId: 'mode-1' })
    expect(loose).toMatchObject({ permissionMode: 'bypassPermissions', permissionModeSource: 'preset' })
    const strict = await runtime.updateSessionMeta(session.id, { presetId: 'mode-0', permissionMode: 'bypassPermissions' })
    expect(strict).toMatchObject({ permissionMode: 'plan', permissionModeSource: 'preset' })
    const gate = runtime.permissions.createCanUseTool({ sessionId: session.id, sendPermissionRequest: () => {} })
    expect((await gate('Write', { file_path: join(root, 'denied.txt') }, { signal: new AbortController().signal })).behavior).toBe('deny')
  } finally { runtime.dispose(); await rm(root, { recursive: true, force: true }) }
})

test('可信手动权限仍不能越过委派父级模式或父级禁用工具', async () => {
  const root = await mkdtemp(join(tmpdir(), 'profer-core-delegated-cap-'))
  const config = { host: '127.0.0.1', port: 0, configDir: root, workspaceRoot: join(root, 'workspaces'), mockAgent: true }
  const runtime = createCoreAgentRuntime(config)
  try {
    const workspace = runtime.workspaces.createManaged('cap fixture')
    const child = runtime.sessions.create({ title: 'child', runtime: 'pi', workspaceId: workspace.id })
    const policy = resolveCorePreset(config, child, workspace).policy
    await writeFile(join(root, 'core-delegations.json'), JSON.stringify({ version: 1, operations: [], records: [{
      schemaVersion: 1, delegationId: 'fixture-delegation', parentSessionId: 'fixture-parent', childSessionId: child.id,
      status: 'completed', blockedEvents: [], parentPolicy: { ...policy, permissionMode: 'auto', disabledTools: ['Write'] },
    }] }))
    runtime.sessions.updateMeta(child.id, { sourceDelegationId: 'fixture-delegation' })
    expect(runtime.permissions.getMode(child.id)).toBe('auto')
    await expect(runtime.updateSessionMeta(child.id, { permissionMode: 'bypassPermissions' })).rejects.toThrow('父级权限上限')
    const manual = await runtime.updateSessionMeta(child.id, { permissionMode: 'auto' })
    expect(manual.permissionModeSource).toBe('user')
    const gate = runtime.permissions.createCanUseTool({ sessionId: child.id, sendPermissionRequest: () => {} })
    expect((await gate('Write', { file_path: join(root, 'disabled.txt') }, { signal: new AbortController().signal })).behavior).toBe('deny')
  } finally { runtime.dispose(); await rm(root, { recursive: true, force: true }) }
})
