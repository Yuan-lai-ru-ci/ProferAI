import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentRunLedger, AgentRuntimeCoordinator, type AgentRuntimeQuery, type AgentRuntimeCallbacks } from '@profer/agent-runtime'
import type { SDKMessage } from '@profer/shared'
import { createFileRunLedgerPort } from './run-ledger-store'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'profer-run-ledger-'))
  directories.push(directory)
  return join(directory, 'nested', 'runs.json')
}

describe('Run ledger file port', () => {
  test.each(['pi', 'claude'] as const)('Given %s 文件端口最小headless装配 When 重建宿主投递同trigger Then 不重复provider且来源已持久化', async runtime => {
    const path = fixture()
    const trigger = { schemaVersion: 1 as const, id: `headless:${runtime}`, kind: 'automation' as const, actor: { type: 'automation' as const, id: 'scheduled' }, createdAt: 1 }
    const messages: SDKMessage[] = []
    let calls = 0
    const host = () => new AgentRuntimeCoordinator({
      runLedger: new AgentRunLedger(createFileRunLedgerPort(path)),
      adapters: { [runtime]: { runtime, query: async (_input: AgentRuntimeQuery, callbacks: AgentRuntimeCallbacks) => { calls++; await callbacks.onMessage?.({ type: 'assistant', uuid: 'answer', message: { content: [{ type: 'text', text: '完成' }] } }); return { status: 'completed' } } } },
      ports: { sessions: { getMeta: () => undefined, updateMeta() {}, appendMessages: (_id, next) => { messages.push(...next) } } },
    })
    const input = { sessionId: 'logical-session', runtime, prompt: '执行任务', context: { trigger, messageAuthor: { type: 'user' as const } }, persistedUserMessage: { type: 'user', uuid: 'original', message: { content: [{ type: 'text', text: '定时正文' }] } } as SDKMessage }
    expect(await host().run(input).promise).toEqual({ status: 'completed' })
    expect(await host().run(input).promise).toEqual({ status: 'completed' })
    expect(calls).toBe(1)
    expect(messages[0]).toMatchObject({ type: 'system', subtype: 'task_trigger', _provenance: { author: { type: 'automation' } } })
    expect(messages[1]).toMatchObject({ uuid: 'original', _provenance: { author: { type: 'user' } } })
    expect(new AgentRunLedger(createFileRunLedgerPort(path)).list()).toHaveLength(1)
  })

  test('Given one durable trigger When another host reloads Then it reuses the run without replaying work', () => {
    const path = fixture()
    const first = new AgentRunLedger(createFileRunLedgerPort(path))
    const trigger = { schemaVersion: 1 as const, id: 'automation:daily:123', kind: 'automation' as const, actor: { type: 'automation' as const, id: 'daily' }, createdAt: 123 }
    const accepted = first.begin({ trigger, sessionRef: 'logical-session', executorRef: 'local', runtime: 'pi' })
    first.start(accepted.run.id)
    const next = new AgentRunLedger(createFileRunLedgerPort(path))
    expect(next.begin({ trigger, sessionRef: 'logical-session', executorRef: 'local', runtime: 'pi' })).toMatchObject({ deduplicated: true, run: { id: accepted.run.id } })
    next.reconcileInterrupted()
    expect(first.get(accepted.run.id)).toMatchObject({ status: 'failed' })
    expect(JSON.parse(readFileSync(path, 'utf8')).schemaVersion).toBe(1)
  })

  test('Given corrupt or unknown persisted data When loading Then it fails closed instead of returning an empty ledger', () => {
    const path = fixture()
    const port = createFileRunLedgerPort(path)
    port.save({ schemaVersion: 1, triggers: [], runs: [], events: [] })
    writeFileSync(path, '{interrupted')
    expect(() => port.load()).toThrow()
    writeFileSync(path, JSON.stringify({ schemaVersion: 99, triggers: [], runs: [], events: [] }))
    expect(() => port.load()).toThrow()
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, triggers: [], runs: [{}], events: [] }))
    expect(() => port.load()).toThrow()
  })

  test('Given a failed write When committing Then the last committed ledger remains readable', () => {
    const path = fixture()
    const port = createFileRunLedgerPort(path)
    const committed = { schemaVersion: 1 as const, triggers: [], runs: [], events: [] }
    port.save(committed)
    expect(() => port.save({ ...committed, schemaVersion: 99 } as never)).toThrow()
    expect(port.load()).toEqual(committed)
  })
})
