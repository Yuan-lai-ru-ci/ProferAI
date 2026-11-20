import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentRunLedger } from '@profer/agent-runtime'
import { createFileRunLedgerPort } from '@profer/session-store'
import { createCoreAgentRuntime } from './runtime'
import { createClaudeSdkDouble } from '../../../packages/agent-provider-claude/test-hosts/claude-sdk-double'

// 外部SDK和进程替身；真实Core、Coordinator、adapter和文件账本。无网络/真实模型。
test('Core Claude 模式同步成功才保存，失败停止原Run并保留权威模式', async () => {
  const root = await mkdtemp(join(tmpdir(), 'profer-core-claude-mode-'))
  const sdk = createClaudeSdkDouble()
  const runtime = createCoreAgentRuntime({ host: '127.0.0.1', port: 0, configDir: root, workspaceRoot: join(root, 'workspaces'),
    channels: [{ id: 'offline', name: 'offline', provider: 'anthropic', apiKey: 'unused', baseUrl: 'https://api.anthropic.com' }],
  }, { claude: { sdkLoader: async () => sdk.module, spawnProcess: sdk.spawnProcess } })
  const session = runtime.sessions.create({ workspaceId: (runtime.workspaces.list()[0] ?? runtime.workspaces.createManaged('测试工作区')).id, title: 'Claude mode fixture', runtime: 'claude', permissionMode: 'auto', channelId: 'offline' })
  try {
    const handle = runtime.coordinator.run(runtime.createQuery(session, 'offline fixture'))
    const deadline = Date.now() + 3000
    while (!sdk.state.options && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
    expect(sdk.state.options).toBeDefined()
    expect(sdk.state.options!.permissionMode).toBe('auto')
    expect(sdk.state.options!.allowedTools).not.toContain('Write')
    expect(sdk.state.options!.allowedTools).not.toContain('mcp__planning__*')
    const revision = runtime.sessions.getMeta(session.id)?.revision ?? 0
    const changed = await runtime.updateSessionMeta(session.id, { permissionMode: 'plan' }, revision)
    expect(changed.permissionMode).toBe('plan')
    expect(sdk.state.permissionModeCalls).toEqual(['plan'])
    sdk.state.permissionModeError = new Error('fixture SDK mode rejected')
    await expect(runtime.updateSessionMeta(session.id, { permissionMode: 'bypassPermissions' }, changed.revision)).rejects.toThrow('fixture SDK mode rejected')
    expect(runtime.sessions.getMeta(session.id)?.permissionMode).toBe('plan')
    expect(runtime.coordinator.isRunning(session.id)).toBe(false)
    expect((await handle.promise).status).toBe('stopped')
    expect(sdk.state.closeCalls).toBeGreaterThan(0)
  } finally {
    if (runtime.coordinator.isRunning(session.id)) await runtime.coordinator.stopAndWait(session.id)
    runtime.dispose()
    sdk.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('Claude 模式同步迟到失败不停止同会话的新Run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'profer-core-claude-mode-race-'))
  const sdk = createClaudeSdkDouble()
  const runtime = createCoreAgentRuntime({ host: '127.0.0.1', port: 0, configDir: root, workspaceRoot: join(root, 'workspaces'),
    channels: [{ id: 'offline', name: 'offline', provider: 'anthropic', apiKey: 'unused' }],
  }, { claude: { sdkLoader: async () => sdk.module, spawnProcess: sdk.spawnProcess } })
  const session = runtime.sessions.create({ workspaceId: (runtime.workspaces.list()[0] ?? runtime.workspaces.createManaged('测试工作区')).id, title: 'mode race', runtime: 'claude', channelId: 'offline', permissionMode: 'auto' })
  let release = () => {}
  try {
    const first = runtime.coordinator.run(runtime.createQuery(session, 'first'))
    const waitFor = async (check: () => boolean) => {
      const deadline = Date.now() + 2500
      while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
      expect(check()).toBe(true)
    }
    await waitFor(() => sdk.state.options !== undefined)
    sdk.state.permissionModeWait = new Promise<void>(resolve => { release = resolve })
    const updating = runtime.updateSessionMeta(session.id, { permissionMode: 'plan' }, runtime.sessions.getMeta(session.id)?.revision)
    const outcome = updating.then(() => 'unexpected success', error => String(error))
    await waitFor(() => sdk.state.permissionModeCalls.length === 1)
    sdk.push({ type: 'result', subtype: 'success', session_id: 'first-sdk', terminal_reason: 'completed' })
    expect(await first.promise).toEqual({ status: 'completed' })
    const oldOptions = sdk.state.options
    const second = runtime.coordinator.run(runtime.createQuery(runtime.sessions.getMeta(session.id)!, 'second'))
    await waitFor(() => sdk.state.options !== oldOptions)
    release()
    expect(await outcome).toContain('已结束或被替换')
    expect(runtime.coordinator.isRunning(session.id)).toBe(true)
    expect(runtime.sessions.getMeta(session.id)?.permissionMode).toBe('auto')
    sdk.push({ type: 'result', subtype: 'success', session_id: 'second-sdk', terminal_reason: 'completed' })
    expect(await second.promise).toEqual({ status: 'completed' })
    const ledger = new AgentRunLedger(createFileRunLedgerPort(join(root, 'core-agent-runs.json')))
    expect(ledger.list().map(run => run.status)).toEqual(['completed', 'completed'])
  } finally {
    release()
    if (runtime.coordinator.isRunning(session.id)) await runtime.coordinator.stopAndWait(session.id)
    runtime.dispose()
    sdk.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
