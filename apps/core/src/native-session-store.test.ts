import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildAgentSessionUiProjection } from '@profer/shared'
import { createCoreAgentRuntime } from './runtime'
import { createCoreNativeSessionPorts } from './native-session-store'
import { resolveCorePreset } from './preset-resources'

for (const sourceKind of ['user', 'legacy', 'delegated-user', 'delegated-preset', 'delegated-missing'] as const) {
  test(`Core fork ${sourceKind} 的持久权限、来源、UI 与实际执行一致`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'profer-core-fork-permission-'))
    const config = { host: '127.0.0.1', port: 0, configDir: root, workspaceRoot: join(root, 'workspaces'), mockAgent: true }
    let runtime = createCoreAgentRuntime(config)
    try {
      const workspace = runtime.workspaces.createManaged('fork permission')
      const delegated = sourceKind.startsWith('delegated-')
      await writeFile(join(config.workspaceRoot, workspace.slug, 'agent-presets.json'), JSON.stringify({ presets: [{
        id: 'fork-fixture', name: 'Fork fixture', description: 'permission fixture', version: '1', createdAt: 0, updatedAt: 0,
        permissionMode: delegated ? 'bypassPermissions' : 'plan',
      }] }))
      const session = runtime.sessions.create({ workspaceId: workspace.id, title: 'source', runtime: 'pi', presetId: 'fork-fixture' })
      if (sourceKind === 'user') await runtime.updateSessionMeta(session.id, { permissionMode: 'bypassPermissions' })
      else runtime.sessions.updateMeta(session.id, {
        permissionMode: 'bypassPermissions', permissionModeSource: sourceKind === 'delegated-user' ? 'user' : sourceKind === 'legacy' ? undefined : 'preset',
      })
      if (delegated && sourceKind !== 'delegated-missing') {
        const policy = resolveCorePreset(config, runtime.sessions.getMeta(session.id)!, workspace).policy
        await writeFile(join(root, 'core-delegations.json'), JSON.stringify({ version: 1, operations: [], records: [{
          schemaVersion: 1, delegationId: 'fork-delegation', parentSessionId: 'fixture-parent', childSessionId: session.id,
          status: 'completed', blockedEvents: [], parentPolicy: { ...policy, permissionMode: 'auto' },
        }] }))
      }
      if (delegated) runtime.sessions.updateMeta(session.id, { sourceDelegationId: 'fork-delegation' })
      const source = runtime.sessions.getMeta(session.id)!
      const expectedMode = sourceKind === 'user' ? 'bypassPermissions' : delegated ? 'auto' : 'plan'
      const expectedSource = sourceKind === 'user' ? 'user' : 'preset'
      const ports = createCoreNativeSessionPorts({ config, sessions: runtime.sessions, workspaces: runtime.workspaces, busy: () => false })
      if (sourceKind === 'delegated-missing') {
        const before = runtime.sessions.list()
        expect(() => ports.createFork(source, [], {})).toThrow('委派缺少持久化父级能力上限')
        expect(runtime.sessions.list()).toEqual(before)
        return
      }
      // 对方传入的 fork artifact patch 不能覆盖宿主计算的权限来源。
      const fork = ports.createFork(source, [], { permissionMode: 'bypassPermissions', permissionModeSource: 'user' })
      expect(fork).toMatchObject({ permissionMode: expectedMode, permissionModeSource: expectedSource })
      expect(fork.sourceDelegationId).toBeUndefined()
      expect(runtime.sessions.getMeta(source.id)).toEqual(source)
      expect(buildAgentSessionUiProjection(fork)).toMatchObject({ permissionMode: expectedMode, permissionModeSource: expectedSource })
      expect(runtime.permissions.getMode(fork.id)).toBe(expectedMode)
      runtime.dispose()
      runtime = createCoreAgentRuntime(config)
      expect(runtime.sessions.getMeta(fork.id)).toMatchObject({ permissionMode: expectedMode, permissionModeSource: expectedSource })
      expect(runtime.permissions.getMode(fork.id)).toBe(expectedMode)
    } finally { runtime.dispose(); await rm(root, { recursive: true, force: true }) }
  })
}
