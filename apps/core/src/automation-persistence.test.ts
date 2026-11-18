import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentRunLedger, createInMemoryRunLedgerPort } from '@profer/agent-runtime'
import { CoreAutomationStore } from './automation-store'
import { CoreAutomationService } from './automation-service'
import { createCoreAgentRuntime } from './runtime'

test('Automation写盘失败不发布任务、封锁后续派发，磁盘旧数据保持不变', async () => {
  const root = mkdtempSync(join(tmpdir(), 'profer-auto-disk-'))
  const config = { host: '127.0.0.1', port: 0, configDir: root, workspaceRoot: join(root, 'workspaces'), mockAgent: true, channels: [{ id: 'fixture', name: 'fixture', provider: 'anthropic' as const, apiKey: 'unused' }] }
  const runtime = createCoreAgentRuntime(config)
  class FailingStore extends CoreAutomationStore {
    override write(): void { throw new Error('fixture disk unavailable') }
  }
  const file = join(root, 'failure-fixture.json')
  const previous = JSON.stringify({ version: 4, automations: [], triggers: [] })
  writeFileSync(file, previous)
  const service = new CoreAutomationService(config, new AgentRunLedger(createInMemoryRunLedgerPort()), new FailingStore(file))
  service.bindRuntime(runtime)
  const events: unknown[] = []
  runtime.subscribe(event => { if (event.type === 'automation') events.push(event) })
  try {
    const workspace = runtime.workspaces.createManaged('fixture')
    expect(() => service.command('fixture-op', 'create', { name: 'fixture', prompt: 'fixture', scheduleType: 'interval', intervalMinutes: 10, workspaceId: workspace.id, channelId: 'fixture', agentRuntime: 'pi' })).toThrow('fixture disk unavailable')
    expect(service.list()).toEqual([])
    expect(events).toEqual([])
    expect(readFileSync(file, 'utf8')).toBe(previous)
    expect(() => service.tick()).toThrow('不可调度')
    expect(runtime.sessions.list()).toEqual([])
  } finally { service.dispose(); await runtime.shutdown(); rmSync(root, { recursive: true, force: true }) }
})

test('Automation损坏或未来版本存储显式拒绝，不以空文件覆盖', () => {
  const root = mkdtempSync(join(tmpdir(), 'profer-auto-invalid-'))
  const path = join(root, 'fixture.json'), store = new CoreAutomationStore(path)
  try {
    for (const value of ['{not json', JSON.stringify({ version: 99, automations: [], triggers: [] })]) {
      writeFileSync(path, value)
      expect(() => store.read()).toThrow()
      expect(readFileSync(path, 'utf8')).toBe(value)
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})
