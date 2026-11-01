import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentRunLedger } from '@profer/agent-runtime'
import { createFileRunLedgerPort } from '@profer/session-store'
import { createDesktopRunLedger } from './agent-run-ledger-host'

const directories: string[] = []
const path = () => { const directory = mkdtempSync(join(tmpdir(), 'profer-run-host-')); directories.push(directory); return join(directory, 'runs.json') }
const trigger = (id: string) => ({ schemaVersion: 1 as const, id, kind: 'user_message' as const, actor: { type: 'user' as const }, createdAt: 1 })
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

describe('桌面共享 Run 账本', () => {
  test('Given 上进程的运行与排队记录 When 首次初始化 Then 只结束中断运行且不重放排队', () => {
    const file = path()
    const old = new AgentRunLedger(createFileRunLedgerPort(file))
    const running = old.begin({ trigger: trigger('running'), runtime: 'pi', executorRef: 's' }).run
    old.start(running.id)
    const queued = old.begin({ trigger: trigger('queued'), runtime: 'claude', executorRef: 'q' }).run
    const host = createDesktopRunLedger(() => file)
    host.initialize()
    expect(host.ledger.get(running.id)).toMatchObject({ status: 'failed' })
    expect(host.ledger.get(queued.id)?.status).toBe('queued')
    expect(host.ledger.get(queued.id)?.startedAt).toBeUndefined()
    const next = host.ledger.begin({ trigger: trigger('next'), runtime: 'pi', executorRef: 'n' }).run
    host.ledger.start(next.id)
    host.initialize()
    expect(host.ledger.get(next.id)?.status).toBe('running')
  })
  test('Given 损坏文件 When 初始化及后续执行 Then 持续失败关闭并保留文件', () => {
    const file = path()
    writeFileSync(file, '{broken')
    const host = createDesktopRunLedger(() => file)
    expect(() => host.initialize()).toThrow()
    expect(() => host.ledger.begin({ trigger: trigger('new'), runtime: 'pi', executorRef: 's' })).toThrow()
    expect(readFileSync(file, 'utf8')).toBe('{broken')
  })
})
