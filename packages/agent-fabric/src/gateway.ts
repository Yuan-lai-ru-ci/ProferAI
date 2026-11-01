/**
 * Local Agent Gateway 核心
 *
 * Phase 1：任务路由、排队、租约、并发限制、事件持久化语义、幂等与结果聚合。
 * 本模块仍是纯逻辑：网络传输、真实 Agent 执行、持久化全部通过注入端口完成，
 * 不 import Electron / Node fs / 任何 runtime。
 *
 * 职责边界：
 * - Gateway 持有任务状态机、事件日志、writer lease、节点注册表；
 * - 执行由 TaskExecutor 端口完成（headless runner / 远程节点适配器）；
 * - 调用方身份（配对校验）由传输层解析为 CallerContext 后传入。
 */

import { assertCapability, Capability, type CapabilityValue, type TrustLevelValue } from './capabilities'
import {
  AgentNodeStatus,
  assertNodeRoutable,
  type AgentNode,
  type AgentRegistry,
} from './node'
import {
  IdempotencyLedger,
  ProtocolError,
  ProtocolErrorCode,
  createEnvelope,
  validateEnvelope,
  type ProtocolActor,
  type ProtocolEnvelope,
} from './protocol'
import { RetryClass, TaskStatus, validateTaskRequest, type AgentTask, type TaskRequest, WorkspaceMode } from './task'
import { isTerminalStatus, transitionTask } from './state-machine'
import {
  TaskEventType,
  type TaskEvent,
  type TaskEventLog,
  type AppendEventInput,
  createInMemoryEventLog,
} from './events'
import { assertArtifactReadable, type ArtifactRef, type TaskResult } from './artifacts'

// ===== 调用方上下文 =====

/**
 * 传输层（HTTP/MCP/进程内）完成认证后解析出的调用方上下文。
 * Gateway 不直接处理 token——token 验证是配对层职责。
 */
export interface CallerContext {
  agentId: string
  trust: TrustLevelValue
  grants: readonly CapabilityValue[]
}

// ===== 存储端口 =====

/** 任务/结果/产物持久化端口。内存实现用于契约测试；文件实现见 Electron 适配层。 */
export interface GatewayTaskStore {
  save(task: AgentTask): void
  get(taskId: string): AgentTask | undefined
  list(): AgentTask[]
  /** 记录 requestId -> taskId 索引（跨重启幂等的基础）。 */
  indexRequestId(requestId: string, taskId: string): void
  /** 跨重启幂等：requestId -> taskId 索引。 */
  findByRequestId(requestId: string): AgentTask | undefined
  saveResult(taskId: string, result: TaskResult): void
  getResult(taskId: string): TaskResult | undefined
  saveArtifact(ref: ArtifactRef): void
  getArtifact(artifactId: string): ArtifactRef | undefined
  listArtifacts(taskId: string): ArtifactRef[]
}

export function createInMemoryTaskStore(): GatewayTaskStore {
  const tasks = new Map<string, AgentTask>()
  const byRequestId = new Map<string, string>()
  const results = new Map<string, TaskResult>()
  const artifacts = new Map<string, ArtifactRef>()

  return {
    save(task) {
      tasks.set(task.request.taskId, task)
    },
    get: (taskId) => tasks.get(taskId),
    list: () => [...tasks.values()],
    indexRequestId: (requestId, taskId) => byRequestId.set(requestId, taskId),
    findByRequestId(requestId) {
      const taskId = byRequestId.get(requestId)
      return taskId ? tasks.get(taskId) : undefined
    },
    saveResult: (taskId, result) => results.set(taskId, result),
    getResult: (taskId) => results.get(taskId),
    saveArtifact: (ref) => artifacts.set(ref.artifactId, ref),
    getArtifact: (artifactId) => artifacts.get(artifactId),
    listArtifacts: (taskId) => [...artifacts.values()].filter((ref) => ref.taskId === taskId),
  }
}

// ===== 执行器端口 =====

export interface TaskRunAdmission {
  runId: string
  sessionId?: string
  triggerId?: string
}

/** 执行器上报通道：实现方（headless runner 等）必须最终 complete 或 fail 一次。 */
export interface TaskReporter {
  /** 仅受信 executor 从宿主运行事实报告；不从任务正文或远程 metadata 推断。 */
  runAdmitted?(reference: TaskRunAdmission): void
  progress(payload: Record<string, unknown>): void
  artifactCreated(ref: ArtifactRef): void
  complete(result: TaskResult): void
  fail(reason: string): void
}

export interface TaskExecution {
  task: AgentTask
  reporter: TaskReporter
}

/** 任务执行端口。一个节点身份对应一个执行器（本地 headless、远程 Profer 等）。 */
export interface TaskExecutor {
  /** 开始执行；实现必须保证最终调用 reporter.complete/fail，除非任务已被取消。 */
  start(execution: TaskExecution): void
  /** 尽力取消；取不到任务的执行权时静默忽略。 */
  cancel(taskId: string): void
}

// ===== Gateway 依赖 =====

export interface AgentFabricGatewayDeps {
  registry: AgentRegistry
  store: GatewayTaskStore
  eventLog?: TaskEventLog
  /** 按目标节点解析执行器；返回 undefined 表示该节点不可执行（路由失败）。 */
  resolveExecutor: (node: AgentNode) => TaskExecutor | undefined
  now?: () => number
  createEventId?: () => string
}

type TaskEventListener = (event: TaskEvent) => void

/** requestId 幂等结果：首次与重复提交返回同一任务。 */
export interface SubmitTaskOutput {
  task: AgentTask
  /** true 表示命中幂等缓存，本次没有重复执行。 */
  deduplicated: boolean
}

export class AgentFabricGateway {
  private readonly deps: Required<Omit<AgentFabricGatewayDeps, 'eventLog'>> & { eventLog: TaskEventLog }
  private readonly ledger = new IdempotencyLedger<string>()
  private readonly listeners = new Map<string, Set<TaskEventListener>>()
  /** workspaceId -> 持有写租约的 taskId（single-writer 模式）。 */
  private readonly writerLeases = new Map<string, string>()
  /** 节点当前 running 数（并发限制）。 */
  private readonly runningByAgent = new Map<string, number>()

  constructor(deps: AgentFabricGatewayDeps) {
    this.deps = {
      registry: deps.registry,
      store: deps.store,
      eventLog: deps.eventLog ?? createInMemoryEventLog(),
      resolveExecutor: deps.resolveExecutor,
      now: deps.now ?? (() => Date.now()),
      createEventId: deps.createEventId ?? (() => `evt_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`),
    }
  }

  // ===== 节点面（直通注册表） =====

  registerNode(node: AgentNode): void {
    this.deps.registry.register(node)
  }

  heartbeat(agentId: string, instanceId: string): void {
    this.deps.registry.heartbeat(agentId, instanceId, this.deps.now())
  }

  discoverAgents(caller: CallerContext, filter?: { capability?: CapabilityValue }): AgentNode[] {
    // 发现接口只要求配对身份，不授予任何任务能力。
    void caller
    return this.deps.registry.discover({
      capability: filter?.capability,
      status: AgentNodeStatus.ONLINE,
    })
  }

  getAgent(agentId: string): AgentNode | undefined {
    return this.deps.registry.get(agentId)
  }

  // ===== 任务提交 =====

  /**
   * 提交任务。
   * 幂等语义：同一 envelope.requestId 重复提交返回同一任务（deduplicated=true），绝不重复执行。
   */
  submitTask(envelope: ProtocolEnvelope<TaskRequest>, caller: CallerContext): SubmitTaskOutput {
    validateEnvelope(envelope)
    if (envelope.actor.agentId !== caller.agentId) {
      throw new ProtocolError(ProtocolErrorCode.CALLER_NOT_PAIRED, 'envelope.actor 与认证调用方不一致')
    }

    // 1) 跨重启幂等：存储层已有同 requestId 的任务，直接返回。
    const persisted = this.deps.store.findByRequestId(envelope.requestId)
    if (persisted) {
      const owner = persisted.request.origin?.actor.id ?? persisted.request.requesterAgentId
      if (owner !== caller.agentId) {
        throw new ProtocolError(ProtocolErrorCode.CALLER_NOT_PAIRED, 'requestId 已属于其他认证调用方')
      }
      return { task: persisted, deduplicated: true }
    }
    // 2) 进程内幂等：执行中并发重试 / 已完成重试。
    const cached = this.ledger.begin(envelope.requestId)
    if (cached) {
      const task = this.deps.store.get(cached.result ?? '')
      if (task) {
        const owner = task.request.origin?.actor.id ?? task.request.requesterAgentId
        if (owner !== caller.agentId) {
          throw new ProtocolError(ProtocolErrorCode.CALLER_NOT_PAIRED, 'requestId 已属于其他认证调用方')
        }
        return { task, deduplicated: true }
      }
    }

    try {
      const task = this.acceptNewTask(envelope, caller)
      this.ledger.complete(envelope.requestId, task.request.taskId)
      return { task, deduplicated: false }
    } catch (error) {
      this.ledger.release(envelope.requestId)
      throw error
    }
  }

  private acceptNewTask(envelope: ProtocolEnvelope<TaskRequest>, caller: CallerContext): AgentTask {
    // 当前 Gateway 是 Agent 认证入口。payload 的用户身份/确认文字不能成为真实来源或授权。
    const source = { type: 'request', id: envelope.requestId } as const
    const request: TaskRequest = {
      ...envelope.payload,
      schemaVersion: 1,
      requesterAgentId: caller.agentId,
      origin: { actor: { type: 'external', id: caller.agentId }, source },
      authorization: { kind: 'external', sourceRef: source },
    }
    validateTaskRequest(request)

    // 路由：目标只能来自注册表，payload 不允许自带 endpoint。
    const node = assertNodeRoutable(this.deps.registry.get(request.targetAgentId), request.targetAgentId)

    // 能力：submit 本身要求 task.submit；工作区写意图在提交时同样校验写能力。
    const capabilityInput = {
      callerGrants: caller.grants,
      callerTrust: caller.trust,
      nodeCapabilities: node.capabilities,
      policyAllowedCapabilities: request.policy.allowedCapabilities,
    }
    assertCapability(capabilityInput, Capability.TASK_SUBMIT)
    if (request.policy.workspaceMode !== WorkspaceMode.READ_SHARED) {
      assertCapability(capabilityInput, Capability.WORKSPACE_WRITE)
    }

    const now = this.deps.now()
    let task: AgentTask = {
      request,
      status: TaskStatus.CREATED,
      createdAt: now,
      updatedAt: now,
    }
    this.deps.store.save(task)
    this.deps.store.indexRequestId(envelope.requestId, request.taskId)
    this.appendEvent(task.request.taskId, TaskEventType.CREATED, envelope.actor.agentId, {
      targetAgentId: request.targetAgentId,
      workspaceId: request.workspaceId,
    })

    task = this.move(task, TaskStatus.QUEUED, node.agentId)
    this.deps.store.save(task)
    this.pump()
    return this.deps.store.get(task.request.taskId) ?? task
  }

  // ===== 查询 =====

  getTask(caller: CallerContext, taskId: string): AgentTask {
    const task = this.deps.store.get(taskId)
    if (!task) {
      throw new ProtocolError(ProtocolErrorCode.TASK_NOT_FOUND, `任务 ${taskId} 不存在`)
    }
    this.assertTaskCapability(caller, task, Capability.TASK_READ)
    return task
  }

  listTasks(): AgentTask[] {
    return this.deps.store.list()
  }

  getTaskResult(caller: CallerContext, taskId: string): TaskResult | undefined {
    const task = this.getTask(caller, taskId)
    this.assertTaskCapability(caller, task, Capability.TASK_READ)
    return this.deps.store.getResult(taskId)
  }

  listArtifacts(caller: CallerContext, taskId: string): ArtifactRef[] {
    const task = this.getTask(caller, taskId)
    this.assertTaskCapability(caller, task, Capability.ARTIFACT_READ)
    return this.deps.store.listArtifacts(taskId)
  }

  /** 读取产物元数据（内容读取由适配层受控执行）；校验权限与有效期。 */
  getArtifact(caller: CallerContext, artifactId: string): ArtifactRef {
    const ref = this.deps.store.getArtifact(artifactId)
    if (!ref) {
      throw new ProtocolError(ProtocolErrorCode.ARTIFACT_NOT_FOUND, `产物 ${artifactId} 不存在`)
    }
    const task = this.getTask(caller, ref.taskId)
    this.assertTaskCapability(caller, task, Capability.ARTIFACT_READ)
    assertArtifactReadable(ref, this.deps.now())
    return ref
  }

  // ===== 取消 =====

  cancelTask(caller: CallerContext, taskId: string): AgentTask {
    const task = this.getTask(caller, taskId)
    this.assertTaskCapability(caller, task, Capability.TASK_CANCEL)
    if (isTerminalStatus(task.status)) {
      throw new ProtocolError(ProtocolErrorCode.TASK_TERMINAL, `任务 ${taskId} 已处于终态 ${task.status}`)
    }

    const wasRunning = task.status === TaskStatus.RUNNING
    const node = this.deps.registry.get(task.request.targetAgentId)
    // 先封存，再通知 executor；stop 可能同步投递完成/关联回调。
    const cancelled = this.move(task, TaskStatus.CANCELLED, caller.agentId)
    this.deps.store.save(cancelled)
    if (wasRunning && node) this.releaseRunning(node.agentId)
    this.releaseWriterLease(cancelled)
    try {
      if (wasRunning && node) this.deps.resolveExecutor(node)?.cancel(taskId)
    } finally {
      this.pump()
    }
    return cancelled
  }

  /**
   * 节点重启后的孤儿任务恢复（设计文档 §12）。
   * 语义：涉及副作用的任务不自动重试——除「从未开始执行且声明 safe-to-retry 的排队任务」
   * 外，所有非终态任务标记为 expired，恢复决策留给人或调用方显式重提。
   */
  expireOrphanedTasks(producerAgentId: string, reason: string): number {
    let count = 0
    for (const task of this.deps.store.list()) {
      if (isTerminalStatus(task.status)) continue
      if (task.status === TaskStatus.QUEUED && task.request.policy.retryClass === RetryClass.SAFE_TO_RETRY) continue
      const expired = this.move(task, TaskStatus.EXPIRED, producerAgentId, { failureReason: reason })
      this.deps.store.save(expired)
      count++
    }
    this.pump()
    return count
  }

  // ===== 事件订阅 =====

  /** 实时订阅：返回取消函数。重放用 resumeEvents。 */
  onTaskEvent(taskId: string, listener: TaskEventListener): () => void {
    let set = this.listeners.get(taskId)
    if (!set) {
      set = new Set()
      this.listeners.set(taskId, set)
    }
    set.add(listener)
    return () => {
      set.delete(listener)
      if (set.size === 0) this.listeners.delete(taskId)
    }
  }

  /** 断线恢复：游标之后的事件按序返回。 */
  resumeEvents(taskId: string, lastEventSequence: number): TaskEvent[] {
    return this.deps.eventLog.resumeAfter({ taskId, lastEventSequence })
  }

  // ===== 调度 =====

  /**
   * 尝试推进所有排队任务。
   * 推进条件：节点 online 且未达并发上限；写任务还需拿到 writer lease。
   * 写冲突策略：fail 在提交期不冲突，调度期拿不到 lease 时标记失败；
   * queue 则留在 queued 等下次 pump。
   */
  private pump(): void {
    for (const task of this.deps.store.list()) {
      if (task.status !== TaskStatus.QUEUED) continue
      const node = this.deps.registry.get(task.request.targetAgentId)
      if (!node || node.status !== AgentNodeStatus.ONLINE) continue

      // 写租约冲突先于并发判断：fail 策略要求“有冲突即拒绝”，
      // 不能因为执行槽满把任务挂在 queued 等到超时。
      if (task.request.policy.workspaceMode !== WorkspaceMode.READ_SHARED) {
        const holder = this.writerLeases.get(task.request.workspaceId)
        if (holder && holder !== task.request.taskId) {
          if (task.request.policy.writeIntent?.conflictStrategy === 'fail') {
            const failed = this.move(task, TaskStatus.FAILED, node.agentId, {
              failureReason: `工作区 ${task.request.workspaceId} 的写租约被任务 ${holder} 持有`,
            })
            this.deps.store.save(failed)
          }
          // queue 策略：保持 queued 等待下次 pump
          continue
        }
      }

      const running = this.runningByAgent.get(node.agentId) ?? 0
      if (running >= node.maxConcurrency) continue

      const executor = this.deps.resolveExecutor(node)
      if (!executor) {
        const failed = this.move(task, TaskStatus.FAILED, node.agentId, {
          failureReason: `节点 ${node.agentId} 没有可用执行器`,
        })
        this.deps.store.save(failed)
        continue
      }

      if (task.request.policy.workspaceMode !== WorkspaceMode.READ_SHARED) {
        this.writerLeases.set(task.request.workspaceId, task.request.taskId)
      }

      this.startExecution(task, node, executor)
    }
  }

  private startExecution(task: AgentTask, node: AgentNode, executor: TaskExecutor): void {
    let current = this.move(task, TaskStatus.ROUTING, node.agentId)
    current = this.move(current, TaskStatus.ACCEPTED, node.agentId)
    current = this.move(current, TaskStatus.RUNNING, node.agentId)
    this.deps.store.save(current)
    this.runningByAgent.set(node.agentId, (this.runningByAgent.get(node.agentId) ?? 0) + 1)

    const reporter = this.createReporter(current, node)
    try {
      executor.start({ task: current, reporter })
    } catch (error) {
      // start 同步抛错视为执行失败，由 reporter 统一释放一次。
      reporter.fail(error instanceof Error ? error.message : String(error))
    }
  }

  private createReporter(task: AgentTask, node: AgentNode): TaskReporter {
    const taskId = task.request.taskId
    let settled = false

    const liveTask = (): AgentTask | undefined => {
      const current = this.deps.store.get(taskId)
      return !settled && current && !isTerminalStatus(current.status) ? current : undefined
    }
    const settle = (fn: (current: AgentTask) => void): void => {
      const current = liveTask()
      if (!current) return
      settled = true
      fn(current)
      this.finishRunning(this.requireTask(taskId), node)
      this.pump()
    }

    return {
      runAdmitted: (reference) => {
        const current = liveTask()
        if (!current || typeof reference.runId !== 'string' || !reference.runId.trim()
          || reference.runId.length > 256 || /[\u0000-\u001f\u007f]/.test(reference.runId)
          || current.runIds?.includes(reference.runId)) return
        // 在当前权威记录上追加，不能用 executor 启动时的旧快照覆写状态和策略。
        this.deps.store.save({ ...current, runIds: [...(current.runIds ?? []), reference.runId], updatedAt: this.deps.now() })
        this.appendEvent(taskId, TaskEventType.PROGRESS, node.agentId, {
          kind: 'run_admitted',
          runId: reference.runId,
          ...(typeof reference.sessionId === 'string' && reference.sessionId.trim() ? { sessionId: reference.sessionId } : {}),
          ...(typeof reference.triggerId === 'string' && reference.triggerId.trim() ? { triggerId: reference.triggerId } : {}),
        })
      },
      progress: (payload) => {
        if (!liveTask()) return
        this.appendEvent(taskId, TaskEventType.PROGRESS, node.agentId, payload)
      },
      artifactCreated: (ref) => {
        if (!liveTask()) return
        this.deps.store.saveArtifact(ref)
        this.appendEvent(taskId, TaskEventType.ARTIFACT_CREATED, node.agentId, {
          artifactId: ref.artifactId,
          kind: ref.kind,
          label: ref.label,
        })
      },
      complete: (result) => {
        settle((task) => {
          const current = this.move(task, TaskStatus.COMPLETED, node.agentId)
          this.deps.store.saveResult(taskId, result)
          this.deps.store.save(current)
        })
      },
      fail: (reason) => {
        settle((task) => {
          const current = this.move(task, TaskStatus.FAILED, node.agentId, { failureReason: reason })
          this.deps.store.save(current)
        })
      },
    }
  }

  // ===== 内部工具 =====

  private requireTask(taskId: string): AgentTask {
    const task = this.deps.store.get(taskId)
    if (!task) {
      throw new ProtocolError(ProtocolErrorCode.TASK_NOT_FOUND, `任务 ${taskId} 不存在`)
    }
    return task
  }

  private finishRunning(task: AgentTask, node: AgentNode): void {
    this.releaseRunning(node.agentId)
    this.releaseWriterLease(task)
  }

  private releaseRunning(agentId: string): void {
    const running = (this.runningByAgent.get(agentId) ?? 1) - 1
    if (running <= 0) this.runningByAgent.delete(agentId)
    else this.runningByAgent.set(agentId, running)
  }

  private releaseWriterLease(task: AgentTask): void {
    if (this.writerLeases.get(task.request.workspaceId) === task.request.taskId) {
      this.writerLeases.delete(task.request.workspaceId)
    }
  }

  private assertTaskCapability(caller: CallerContext, task: AgentTask, capability: CapabilityValue): void {
    const node = this.deps.registry.get(task.request.targetAgentId)
    assertCapability(
      {
        callerGrants: caller.grants,
        callerTrust: caller.trust,
        nodeCapabilities: node?.capabilities ?? [],
        policyAllowedCapabilities: task.request.policy.allowedCapabilities,
      },
      capability,
    )
  }

  /** 状态迁移 + 对应事件。事件 producer 为触发方（节点或调用方）。 */
  private move(task: AgentTask, to: (typeof TaskStatus)[keyof typeof TaskStatus], producerAgentId: string, opts?: { failureReason?: string }): AgentTask {
    const next = transitionTask(task, to, this.deps.now(), opts)
    const eventType =
      to === TaskStatus.ACCEPTED ? TaskEventType.ACCEPTED
      : to === TaskStatus.RUNNING ? TaskEventType.STARTED
      : to === TaskStatus.COMPLETED ? TaskEventType.COMPLETED
      : to === TaskStatus.FAILED ? TaskEventType.FAILED
      : to === TaskStatus.CANCELLED ? TaskEventType.CANCELLED
      : to === TaskStatus.EXPIRED ? TaskEventType.EXPIRED
      : to === TaskStatus.PAUSED ? TaskEventType.PAUSED
      : undefined
    if (eventType) {
      this.appendEvent(task.request.taskId, eventType, producerAgentId, {
        status: next.status,
        ...(opts?.failureReason ? { failureReason: opts.failureReason } : {}),
      })
    }
    return next
  }

  private appendEvent(taskId: string, type: AppendEventInput['type'], producerAgentId: string, payload: Record<string, unknown>): TaskEvent {
    const event = this.deps.eventLog.append({
      eventId: this.deps.createEventId(),
      taskId,
      type,
      occurredAt: this.deps.now(),
      producerAgentId,
      payload,
    })
    for (const listener of this.listeners.get(taskId) ?? []) {
      try {
        listener(event)
      } catch {
        // 监听器异常不影响事件落库
      }
    }
    return event
  }
}

/** 便捷方法：构造本 Gateway 内的提交 envelope。 */
export function buildSubmitEnvelope(actor: ProtocolActor, requestId: string, request: TaskRequest): ProtocolEnvelope<TaskRequest> {
  return createEnvelope(actor, requestId, request)
}
