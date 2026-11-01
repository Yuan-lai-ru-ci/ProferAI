import { describe, expect, test } from 'bun:test'
import { TaskStatus, deriveTaskState, type AgentTask } from '@profer/agent-fabric'
import {
  AgentRunLedger, createInMemoryRunLedgerPort,
  type RunLedgerPort, type RunLedgerSnapshot, type TaskTrigger,
} from './run-ledger'

function trigger(id: string, kind: TaskTrigger['kind'] = 'user_message'): TaskTrigger {
  return { schemaVersion: 1, id, kind, actor: { type: 'user' }, createdAt: 1 }
}
function setup(port = createInMemoryRunLedgerPort()) {
  let seq = 0
  let now = 100
  const ledger = new AgentRunLedger(port, { now: () => now++, createId: () => `generated-${++seq}` })
  const begin = (id: string, taskId?: string) => ledger.begin({ id, taskId, trigger: trigger(`trigger-${id}`), sessionRef: 'session', executorRef: 'agent-a', runtime: 'pi' }).run
  return { ledger, port, begin }
}

describe('AgentRunLedger 生命周期与持久事实', () => {
  test('无 Task 的普通聊天与同 Task 多 Run 均准入 queued，失败重执行不复活旧 Run', () => {
    const { ledger, begin } = setup()
    expect(begin('chat')).toMatchObject({ schemaVersion: 1, id: 'chat', status: 'queued' })
    expect(ledger.get('chat')?.taskId).toBeUndefined()
    begin('first', 'task')
    expect(ledger.finish('first', { status: 'failed', error: '准备失败' })).toMatchObject({ status: 'failed', failureReason: '准备失败' })
    expect(ledger.get('first')?.startedAt).toBeUndefined()
    begin('second', 'task')
    expect(ledger.list().filter((run) => run.taskId === 'task').map((run) => run.id)).toEqual(['first', 'second'])
  })

  test('追加输入/审批恢复保持同 Run 与原 triggerId，重试 start 不重复记开始', () => {
    const { ledger, port, begin } = setup()
    begin('run', 'task')
    const started = ledger.start('run')
    expect(started).toMatchObject({ status: 'running', executorRef: 'agent-a', runtime: 'pi' })
    expect(ledger.start('run')).toEqual(started)
    expect(ledger.attachInput('run', trigger('follow-up'))).toBe(true)
    expect(ledger.attachInput('run', trigger('follow-up'))).toBe(true)
    const request = { type: 'request', id: 'approval' } as const
    expect(ledger.wait('run', request)).toMatchObject({ status: 'waiting', waitingFor: request })
    expect(ledger.wait('run', request).status).toBe('waiting')
    const resumed = ledger.resume('run', trigger('approved', 'resume'))
    expect(resumed).toMatchObject({ id: 'run', status: 'running', triggerId: 'trigger-run', startedAt: started.startedAt })
    expect(resumed.waitingFor).toBeUndefined()
    expect(ledger.resume('run', trigger('approved', 'resume'))).toEqual(resumed)
    expect(ledger.list()).toHaveLength(1)
    expect(port.load().triggers.map((t) => t.id)).toEqual(['trigger-run', 'follow-up', 'approved'])
    expect(ledger.findByTrigger('follow-up')?.id).toBe('run')
    expect(ledger.findByTrigger('approved')?.id).toBe('run')
    expect(port.load().events.filter((event) => event.type === 'started')).toHaveLength(1)
    expect(port.load().events.filter((event) => event.type === 'input_attached')).toHaveLength(1)
    expect(port.load().events.find((event) => event.type === 'waiting')?.requestRef).toEqual(request)
    expect(port.load().events.find((event) => event.type === 'resumed')?.requestRef).toEqual(request)
  })

  test('重复、冲突和迟到终态只记第一次，后续输入不落库', () => {
    for (const status of ['completed', 'failed', 'stopped'] as const) {
      const { ledger, port, begin } = setup()
      begin('run')
      ledger.start('run')
      ledger.wait('run', { type: 'request', id: 'approval' })
      const finished = ledger.finish('run', { status, error: status === 'failed' ? '失败原因' : undefined })
      const snapshot = port.load()
      expect(finished.finishedAt).toBeNumber()
      expect(finished.waitingFor).toBeUndefined()
      expect(ledger.finish('run', { status: 'completed' })).toEqual(finished)
      expect(ledger.finish('run', { status: 'failed', error: '迟到错误' })).toEqual(finished)
      expect(ledger.start('run')).toEqual(finished)
      expect(ledger.wait('run', { type: 'request', id: 'late' })).toEqual(finished)
      expect(ledger.resume('run', trigger('late-resume', 'resume'))).toEqual(finished)
      expect(ledger.handoff('run', { executorRef: 'late', runtime: 'claude' })).toEqual(finished)
      expect(ledger.attachInput('run', trigger('late-input'))).toBe(false)
      expect(ledger.attachInput('run', trigger('trigger-run'))).toBe(false)
      expect(port.load()).toEqual(snapshot)
    }
  })

  test('stop Run 不取消 Task 的目标', () => {
    const { ledger, begin } = setup()
    const task = { status: TaskStatus.RUNNING, failureReason: '保留任务信息' } as AgentTask
    begin('run', 'task')
    ledger.finish('run', { status: 'stopped' })
    expect(deriveTaskState(task)).toBe('open')
    expect(task.status).toBe(TaskStatus.RUNNING)
  })

  test('重建 ledger 后按初始/追加/恢复 trigger 去重，后建实例的改动不会被旧实例覆盖', () => {
    const { ledger, port, begin } = setup()
    begin('run')
    ledger.start('run')
    ledger.attachInput('run', trigger('input'))
    const restarted = new AgentRunLedger(port)
    expect(restarted.begin({ trigger: trigger('trigger-run'), executorRef: 'other', runtime: 'claude' })).toMatchObject({ deduplicated: true, run: { id: 'run' } })
    expect(restarted.begin({ trigger: trigger('input'), executorRef: 'other', runtime: 'claude' })).toMatchObject({ deduplicated: true, run: { id: 'run' } })
    restarted.wait('run', { type: 'request', id: 'approval' })
    ledger.resume('run', trigger('resume', 'resume'))
    expect(restarted.findByTrigger('resume')?.id).toBe('run')
    expect(restarted.list()).toHaveLength(1)
  })

  test('trigger 不能关联不同 Run，显式 Run ID 不能覆盖既有记录', () => {
    const { ledger, port, begin } = setup()
    begin('a')
    begin('b')
    ledger.start('b')
    ledger.wait('b', { type: 'request', id: 'approval' })
    const before = port.load()
    expect(ledger.attachInput('b', trigger('trigger-a'))).toBe(false)
    expect(() => ledger.resume('b', trigger('trigger-a', 'resume'))).toThrow()
    expect(() => ledger.begin({ id: 'a', trigger: trigger('new'), executorRef: 'agent', runtime: 'pi' })).toThrow()
    expect(port.load()).toEqual(before)
  })

  test('handoff 保留开始执行快照与每次变化，原始来源不改写', () => {
    const { ledger, port, begin } = setup()
    begin('run')
    ledger.start('run')
    const current = ledger.handoff('run', { executorRef: 'agent-b', runtime: 'claude' })
    ledger.handoff('run', { executorRef: 'agent-b', runtime: 'claude' })
    expect(current).toMatchObject({ id: 'run', executorRef: 'agent-b', runtime: 'claude', triggerId: 'trigger-run' })
    expect(port.load().events.filter((e) => e.type === 'started' || e.type === 'handoff').map(({ type, executorRef, runtime }) => ({ type, executorRef, runtime }))).toEqual([
      { type: 'started', executorRef: 'agent-a', runtime: 'pi' },
      { type: 'handoff', executorRef: 'agent-b', runtime: 'claude' },
    ])
  })

  test('崩溃对账保留 queued、结束 running/waiting 并保留明确原因，不重放', () => {
    const { ledger, port, begin } = setup()
    begin('queued')
    begin('running')
    begin('waiting')
    begin('done')
    ledger.start('running')
    ledger.start('waiting')
    ledger.start('done')
    ledger.finish('done', { status: 'completed' })
    const recovered = new AgentRunLedger(port)
    expect(recovered.reconcileInterrupted().map((r) => r.id)).toEqual(['running', 'waiting'])
    for (const id of ['running', 'waiting']) {
      expect(recovered.get(id)).toMatchObject({ status: 'failed' })
      expect(recovered.get(id)?.failureReason).toContain('未确认')
      expect(recovered.get(id)?.failureReason).toContain('重放')
    }
    expect(recovered.get('queued')?.status).toBe('queued')
    expect(recovered.get('done')?.status).toBe('completed')
    const snapshot = port.load()
    expect(recovered.reconcileInterrupted()).toEqual([])
    expect(port.load()).toEqual(snapshot)
    expect(ledger.begin({ trigger: trigger('trigger-running'), executorRef: 'agent', runtime: 'pi' }).deduplicated).toBe(true)
  })

  test('保存失败不可见且不能污染端口原对象；返回值不能绕过端口改写', () => {
    let stored: RunLedgerSnapshot = { schemaVersion: 1, triggers: [], runs: [], events: [] }
    let fail = true
    const port: RunLedgerPort = {
      load: () => stored,
      save(snapshot) { if (fail) throw new Error('disk full'); stored = snapshot },
    }
    const { ledger, begin } = setup(port)
    expect(() => begin('run')).toThrow('disk full')
    expect(stored).toEqual({ schemaVersion: 1, triggers: [], runs: [], events: [] })
    expect(ledger.list()).toEqual([])
    fail = false
    const run = begin('run')
    run.status = 'failed'
    const loaded = ledger.get('run')!
    loaded.executorRef = 'tampered'
    expect(ledger.get('run')).toMatchObject({ status: 'queued', executorRef: 'agent-a' })
    fail = true
    expect(() => ledger.start('run')).toThrow('disk full')
    expect(ledger.get('run')?.status).toBe('queued')
  })

  test('内存端口在 load/save 两端隔离引用，缺失 ID 和无效状态不产生事件', () => {
    const { ledger, port, begin } = setup()
    const input = port.load()
    port.save(input)
    input.runs.push({} as never)
    expect(port.load().runs).toEqual([])
    expect(ledger.get('missing')).toBeUndefined()
    expect(ledger.findByTrigger('missing')).toBeUndefined()
    expect(() => ledger.start('missing')).toThrow()
    begin('queued')
    const snapshot = port.load()
    expect(() => ledger.finish('queued', { status: 'completed' })).toThrow('尚未启动')
    expect(() => ledger.resume('queued', trigger('not-resume'))).toThrow('必须使用 resume')
    expect(() => ledger.resume('queued', trigger('resume', 'resume'))).toThrow()
    expect(() => ledger.wait('queued', { type: 'request', id: 'approval' })).toThrow()
    expect(port.load()).toEqual(snapshot)
  })
})
