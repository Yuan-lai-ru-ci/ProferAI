import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentRunLedger } from '@profer/agent-runtime'
import { createFileRunLedgerPort } from '@profer/session-store'
import { createCoreAgentRuntime } from './runtime'

test('Core 重启对账结束旧 waiting Run，不恢复可授权的旧请求或重放副作用', async () => {
  const root = await mkdtemp(join(tmpdir(), 'profer-core-permission-restart-'))
  const config = { host: '127.0.0.1', port: 0, configDir: root, workspaceRoot: join(root, 'workspaces'), mockAgent: true }
  let runtime = createCoreAgentRuntime(config)
  try {
    const workspace = runtime.workspaces.createManaged('permission-restart')
    const session = runtime.sessions.create({ title: 'restart fixture', runtime: 'pi', workspaceId: workspace.id, permissionMode: 'auto' })
    const ledger = new AgentRunLedger(createFileRunLedgerPort(join(root, 'core-agent-runs.json')))
    const trigger = { schemaVersion: 1 as const, id: 'fixture-trigger', kind: 'user_message' as const, actor: { type: 'user' as const }, createdAt: Date.now() }
    const { run } = ledger.begin({ trigger, sessionRef: session.id, executorRef: session.id, runtime: 'pi' })
    ledger.start(run.id)
    ledger.wait(run.id, { type: 'request', id: 'old-permission' })
    runtime.dispose()
    runtime = createCoreAgentRuntime(config)
    expect(ledger.get(run.id)).toMatchObject({ status: 'failed', failureReason: expect.stringContaining('未重放副作用') })
    expect(runtime.listPendingPermissions(session.id)).toEqual([])
    expect(runtime.respondToPermission(session.id, 'old-permission', 'allow', true, run.id)).toBe(false)
    const handle = runtime.coordinator.run({ ...runtime.createQuery(runtime.sessions.getMeta(session.id)!, 'do not replay'), trigger, context: { trigger } })
    expect(await handle.promise).toMatchObject({ status: 'failed' })
    expect(ledger.list()).toHaveLength(1)
    expect(runtime.sessions.readMessages(session.id)).toEqual([])
  } finally {
    runtime.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
