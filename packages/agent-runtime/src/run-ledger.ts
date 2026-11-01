import type { ActorRef, ResourceRef, TaskAuthorization } from '@profer/agent-fabric'

export interface TaskTrigger {
  schemaVersion: 1
  id: string
  kind: 'user_message' | 'delegation' | 'automation' | 'external_request' | 'resume'
  actor: ActorRef
  source?: ResourceRef
  authorization?: TaskAuthorization
  createdAt: number
}

export interface AgentRun {
  schemaVersion: 1
  id: string
  taskId?: string
  /** 始终保留初始触发；追加输入/恢复通过事件关联。 */
  triggerId: string
  sessionRef?: string
  executorRef: string
  runtime: string
  status: 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'stopped'
  createdAt: number
  startedAt?: number
  finishedAt?: number
  resultRef?: string
  failureReason?: string
  waitingFor?: ResourceRef
}

export interface RunEvent {
  schemaVersion: 1
  id: string
  runId: string
  triggerId?: string
  type: string
  at: number
  executorRef?: string
  runtime?: string
  reason?: string
  requestRef?: ResourceRef
}

export interface RunLedgerSnapshot {
  schemaVersion: 1
  triggers: TaskTrigger[]
  runs: AgentRun[]
  events: RunEvent[]
}

/**
 * 同步原子端口：save 成功才发布完整快照；失败必须保留原快照。
 * 宿主负责文件原子替换及跨进程写入协调；Ledger 不做异步 I/O 或副作用重放。
 */
export interface RunLedgerPort {
  load(): RunLedgerSnapshot
  save(snapshot: RunLedgerSnapshot): void
}

export function createInMemoryRunLedgerPort(): RunLedgerPort {
  let stored: RunLedgerSnapshot = { schemaVersion: 1, triggers: [], runs: [], events: [] }
  return {
    load: () => structuredClone(stored),
    save(snapshot) { stored = structuredClone(snapshot) },
  }
}

export interface AgentRunLedgerOptions {
  now?: () => number
  createId?: () => string
}

export interface BeginAgentRunInput {
  id?: string
  taskId?: string
  trigger: TaskTrigger
  sessionRef?: string
  executorRef: string
  runtime: string
}

export interface RunFinishOutcome {
  status: 'completed' | 'failed' | 'stopped'
  error?: string
}

function isTerminal(run: AgentRun): boolean {
  return run.status === 'completed' || run.status === 'failed' || run.status === 'stopped'
}

/** 无宿主依赖的运行事实账本；不缓存端口状态，也不拥有 Task/Session/Provider 生命周期。 */
export class AgentRunLedger {
  private readonly now: () => number
  private readonly createId: () => string

  constructor(private readonly port: RunLedgerPort, options: AgentRunLedgerOptions = {}) {
    this.now = options.now ?? Date.now
    this.createId = options.createId ?? (() => globalThis.crypto.randomUUID())
  }

  begin(input: BeginAgentRunInput): { run: AgentRun; deduplicated: boolean } {
    const snapshot = this.read()
    const existing = this.runForTrigger(snapshot, input.trigger.id)
    if (existing) return { run: existing, deduplicated: true }
    const id = input.id ?? this.createId()
    if (snapshot.runs.some((run) => run.id === id)) throw new Error(`Run ${id} 已存在，不能覆盖`)
    if (!id.trim() || !input.trigger.id.trim() || !input.executorRef.trim() || !input.runtime.trim()) {
      throw new Error('Run、Trigger、执行者和 Runtime 必须具有稳定身份')
    }
    const run: AgentRun = {
      schemaVersion: 1,
      id,
      ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
      triggerId: input.trigger.id,
      ...(input.sessionRef !== undefined ? { sessionRef: input.sessionRef } : {}),
      executorRef: input.executorRef,
      runtime: input.runtime,
      status: 'queued',
      createdAt: this.now(),
    }
    snapshot.triggers.push(structuredClone(input.trigger))
    snapshot.runs.push(run)
    this.event(snapshot, run, 'queued', { triggerId: input.trigger.id })
    this.save(snapshot)
    return { run: structuredClone(run), deduplicated: false }
  }

  start(runId: string): AgentRun {
    const snapshot = this.read()
    const run = this.requireRun(snapshot, runId)
    if (run.status !== 'queued') return run
    run.status = 'running'
    run.startedAt = this.now()
    this.event(snapshot, run, 'started')
    return this.saveRun(snapshot, run)
  }

  /** 终态拒绝；同 Trigger 在同 Run 上重复投递视为已接收，不能转移到另一个 Run。 */
  attachInput(runId: string, trigger: TaskTrigger): boolean {
    const snapshot = this.read()
    const run = this.requireRun(snapshot, runId)
    if (isTerminal(run)) return false
    const existing = this.runForTrigger(snapshot, trigger.id)
    if (existing) return existing.id === run.id
    snapshot.triggers.push(structuredClone(trigger))
    this.event(snapshot, run, 'input_attached', { triggerId: trigger.id })
    this.save(snapshot)
    return true
  }

  wait(runId: string, requestRef: ResourceRef): AgentRun {
    const snapshot = this.read()
    const run = this.requireRun(snapshot, runId)
    if (isTerminal(run)) return run
    if (run.status !== 'running' && run.status !== 'waiting') throw new Error(`Run ${runId} 尚未开始，不能等待`)
    if (run.status === 'waiting' && run.waitingFor?.type === requestRef.type && run.waitingFor.id === requestRef.id) return run
    run.status = 'waiting'
    run.waitingFor = structuredClone(requestRef)
    this.event(snapshot, run, 'waiting', { requestRef: structuredClone(requestRef) })
    return this.saveRun(snapshot, run)
  }

  resume(runId: string, trigger: TaskTrigger): AgentRun {
    if (trigger.kind !== 'resume') throw new Error('恢复 Run 必须使用 resume Trigger')
    const snapshot = this.read()
    const run = this.requireRun(snapshot, runId)
    if (isTerminal(run)) return run
    const existing = this.runForTrigger(snapshot, trigger.id)
    if (existing && existing.id !== run.id) throw new Error(`Trigger ${trigger.id} 已属于另一个 Run`)
    if (snapshot.events.some((event) => event.runId === run.id && event.type === 'resumed' && event.triggerId === trigger.id)) return run
    if (run.status !== 'waiting') throw new Error(`Run ${runId} 未处于等待状态，不能恢复`)
    if (!existing) snapshot.triggers.push(structuredClone(trigger))
    const requestRef = run.waitingFor
    run.status = 'running'
    delete run.waitingFor
    this.event(snapshot, run, 'resumed', { triggerId: trigger.id, ...(requestRef ? { requestRef } : {}) })
    return this.saveRun(snapshot, run)
  }

  finish(runId: string, outcome: RunFinishOutcome): AgentRun {
    const snapshot = this.read()
    const run = this.requireRun(snapshot, runId)
    if (isTerminal(run)) return run
    if (run.status === 'queued' && outcome.status === 'completed') throw new Error(`排队中的 Run ${runId} 尚未启动，不能完成`)
    run.status = outcome.status
    run.finishedAt = this.now()
    if (outcome.error !== undefined) run.failureReason = outcome.error
    delete run.waitingFor
    this.event(snapshot, run, outcome.status, outcome.error !== undefined ? { reason: outcome.error } : {})
    return this.saveRun(snapshot, run)
  }

  handoff(runId: string, executor: { executorRef: string; runtime: string }): AgentRun {
    const snapshot = this.read()
    const run = this.requireRun(snapshot, runId)
    if (isTerminal(run) || (run.executorRef === executor.executorRef && run.runtime === executor.runtime)) return run
    if (!executor.executorRef.trim() || !executor.runtime.trim()) throw new Error('接管执行者与 Runtime 不能为空')
    run.executorRef = executor.executorRef
    run.runtime = executor.runtime
    this.event(snapshot, run, 'handoff')
    return this.saveRun(snapshot, run)
  }

  get(runId: string): AgentRun | undefined {
    return this.read().runs.find((run) => run.id === runId)
  }

  findByTrigger(triggerId: string): AgentRun | undefined {
    return this.runForTrigger(this.read(), triggerId)
  }

  list(): AgentRun[] {
    return this.read().runs
  }

  /** 宿主先确认可接管者；对剩余中断记录调用本方法。保留排队项，不自动执行。 */
  reconcileInterrupted(): AgentRun[] {
    const snapshot = this.read()
    const interrupted = snapshot.runs.filter((run) => run.status === 'running' || run.status === 'waiting')
    for (const run of interrupted) {
      const reason = `运行中断：原状态 ${run.status}，未确认可接管的执行者；已结束旧 Run，未重放副作用`
      run.status = 'failed'
      run.failureReason = reason
      run.finishedAt = this.now()
      delete run.waitingFor
      this.event(snapshot, run, 'failed', { reason })
    }
    if (interrupted.length > 0) this.save(snapshot)
    return structuredClone(interrupted)
  }

  private read(): RunLedgerSnapshot {
    const snapshot = structuredClone(this.port.load())
    if (snapshot.schemaVersion !== 1) throw new Error(`不支持的 Run Ledger 版本：${snapshot.schemaVersion}`)
    return snapshot
  }

  private save(snapshot: RunLedgerSnapshot): void {
    this.port.save(structuredClone(snapshot))
  }

  private saveRun(snapshot: RunLedgerSnapshot, run: AgentRun): AgentRun {
    this.save(snapshot)
    return structuredClone(run)
  }

  private requireRun(snapshot: RunLedgerSnapshot, runId: string): AgentRun {
    const run = snapshot.runs.find((candidate) => candidate.id === runId)
    if (!run) throw new Error(`Run ${runId} 不存在`)
    return run
  }

  private runForTrigger(snapshot: RunLedgerSnapshot, triggerId: string): AgentRun | undefined {
    const initial = snapshot.runs.find((run) => run.triggerId === triggerId)
    if (initial) return initial
    const event = snapshot.events.find((candidate) => candidate.triggerId === triggerId)
    return event ? snapshot.runs.find((run) => run.id === event.runId) : undefined
  }

  /** 事件保留当时的执行快照；后续 handoff 不覆盖旧记录。 */
  private event(snapshot: RunLedgerSnapshot, run: AgentRun, type: string, fields: Partial<Pick<RunEvent, 'triggerId' | 'reason' | 'requestRef'>> = {}): void {
    snapshot.events.push({
      schemaVersion: 1, id: this.createId(), runId: run.id, type, at: this.now(),
      executorRef: run.executorRef, runtime: run.runtime, ...fields,
    })
  }
}
