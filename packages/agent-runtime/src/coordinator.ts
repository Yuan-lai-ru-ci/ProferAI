import type { ActorRef } from '@profer/agent-fabric'
import type { AgentRuntime, SDKMessage } from '@profer/shared'
import { AgentSessionRuntimeMismatchError, normalizeAgentRuntime } from '@profer/shared'
import type { AgentRuntimeEvent, AgentRunOutcome } from './events'
import { createAgentRunOutcomeReporter } from './outcome'
import { createAgentQueryPreparationPort, AgentRuntimePreparationError } from './query-preparation'
import type { AgentRuntimePreparationFailure } from './query-preparation'
import { createAgentRunOwnershipRegistry, createAgentRunRejectionError } from './run-ownership'
import type { AgentRunOwnershipRegistry, AgentRunOwnershipToken } from './run-ownership'
import { readAgentStreamNext } from './stream-reader'
import { canRetry, getRetryDelayMs, isRetryableError, waitForRetryDelay } from './retry'
import type { RetryPolicy } from './retry'
import type { AgentRuntimeAdapter, AgentRuntimeCallbacks, AgentRuntimePorts, AgentRuntimeQuery, AgentRuntimeRunReference, AgentRuntimeQueuedInput, AgentRuntimeQueuedInputResult } from './contract'
import { createAgentRunContext, stampRunMessage } from './run-context'
import { appendRunOriginPrompt, createRunTriggerMessage } from './run-origin-prompt'
import type { AgentRunLedger, AgentRun, BeginAgentRunInput } from './run-ledger'

/** 保留追加输入、等待审批和恢复的端口；只有真实宿主 hook 才能写入这些状态。 */
export type AgentRuntimeRunLedgerPort = Pick<AgentRunLedger, 'begin' | 'start' | 'finish' | 'attachInput' | 'wait' | 'resume'>

function ledgerOutcome(run: AgentRun): AgentRunOutcome | undefined {
  if (run.status === 'completed' || run.status === 'stopped') return { status: run.status }
  if (run.status === 'failed') return { status: 'failed', error: run.failureReason ?? 'Agent 执行失败' }
  return undefined
}

function withRunIdentity(context: unknown, runId: string): unknown {
  return context && typeof context === 'object' && !Array.isArray(context)
    ? { ...context, runId, sourceRunId: runId } : context
}

/** 准备阶段失败的结构化描述；未知错误归入 `unknown` 阶段但仍如实上报。 */
function preparationFailureFrom(error: unknown, message: string): AgentRuntimePreparationFailure {
  if (error instanceof AgentRuntimePreparationError) {
    return { phase: error.phase, code: error.code, message }
  }
  return { phase: 'unknown', message }
}

/**
 * provider 的「轻量完成」注解：本轮 turn 主体结束但仍有后台任务在飞。
 * 由 adapter 打在 result 消息上（见 claude-agent-adapter 的 `_keepChannelOpenForTasks`）。
 */
function isKeepChannelOpenForTasks(message: SDKMessage): boolean {
  return (message as { _keepChannelOpenForTasks?: unknown })._keepChannelOpenForTasks === true
}

/**
 * 后台任务完成后的续轮首条消息。与旧编排层一致：assistant / user / task_started / task_progress
 * 视为唤醒信号，此时把 UI 从「空闲可输入」拉回运行态。
 */
function isBackgroundWakeMessage(message: SDKMessage): boolean {
  if (message.type === 'assistant' || message.type === 'user') return true
  if (message.type !== 'system') return false
  const subtype = (message as { subtype?: unknown }).subtype
  return subtype === 'task_started' || subtype === 'task_progress'
}

function isPartialRuntimeMessage(message: SDKMessage): boolean {
  return (message as Record<string, unknown>)._partial === true
}

function hasToolResult(message: SDKMessage): boolean {
  if (message.type !== 'user') return false
  const content = (message as { message?: { content?: Array<{ type?: unknown }> } }).message?.content
  return Array.isArray(content) && content.some(block => block?.type === 'tool_result')
}

/** 与旧编排层一致：只把用户可见转录写入历史，内部流控制消息仅实时投影。 */
function isPersistableRuntimeMessage(message: SDKMessage): boolean {
  if (isPartialRuntimeMessage(message) || (message as Record<string, unknown>).isReplay === true) return false
  if (message.type === 'assistant' || message.type === 'result') return true
  if (message.type === 'user') return hasToolResult(message)
  if (message.type !== 'system') return false
  const subtype = (message as { subtype?: unknown }).subtype
  return subtype === 'compact_boundary' || subtype === 'permission_denied'
}

function normalizeRuntimeMessage(message: SDKMessage, modelId: string | undefined, createdAt: number): SDKMessage {
  const record = message as Record<string, unknown>
  const normalized: Record<string, unknown> = {
    ...record,
    ...(typeof record._createdAt === 'number' ? {} : { _createdAt: createdAt }),
  }
  if (message.type === 'assistant' && modelId && !record._channelModelId) {
    normalized._channelModelId = modelId
  }
  return normalized as SDKMessage
}

function addRuntimeDuration(message: SDKMessage, startedAt: number, finishedAt: number): SDKMessage {
  if (message.type !== 'result') return message
  const record = message as Record<string, unknown>
  if (typeof record._durationMs === 'number') return message
  return { ...message, _durationMs: Math.max(0, finishedAt - startedAt) } as SDKMessage
}

async function consumeRuntimeStream(
  stream: AsyncIterable<SDKMessage>,
  signal: AbortSignal,
  callbacks: AgentRuntimeCallbacks,
  context: { sessionId: string; startedAt: number },
): Promise<AgentRunOutcome> {
  const iterator = stream[Symbol.asyncIterator]()
  let terminalResult: SDKMessage | undefined
  // 后台任务等待态：result 走轻量完成后置 true，续轮首条实质消息时发 run_resumed 并置回 false。
  let awaitingBackgroundWake = false
  while (true) {
    const next = await readAgentStreamNext(iterator, { shouldStop: () => signal.aborted })
    if (next.kind === 'stopped') return { status: 'stopped' }
    if (next.kind === 'done') break
    const message = next.value
    if (message.type === 'result') {
      terminalResult = message
      if (isKeepChannelOpenForTasks(message)) {
        // 轻量完成：不是终态。继续 park 在 iterator.next()，等后台任务完成后的续轮消息；
        // 期间不结算 outcome、不释放执行权，因此 UI 空闲可输入但主进程仍持有会话。
        awaitingBackgroundWake = true
        const result = message as { subtype?: unknown; errors?: unknown }
        await callbacks.onBackgroundTasksPending?.({
          startedAt: context.startedAt,
          ...(typeof result.subtype === 'string' ? { resultSubtype: result.subtype } : {}),
          ...(Array.isArray(result.errors)
            ? {
                resultErrors: result.errors.filter(
                  (value): value is string => typeof value === 'string' && value.trim().length > 0,
                ),
              }
            : {}),
        })
      }
    } else if (awaitingBackgroundWake && isBackgroundWakeMessage(message)) {
      // 唤醒先于消息投影：UI 必须先离开空闲态，再渲染续轮内容（与旧编排层顺序一致）。
      awaitingBackgroundWake = false
      await callbacks.onEvent({
        type: 'host_event',
        sessionId: context.sessionId,
        event: { type: 'run_resumed', sessionId: context.sessionId },
      })
    }
    await callbacks.onMessage?.(message)
  }
  if (signal.aborted) return { status: 'stopped' }
  const result = terminalResult as ({ subtype?: unknown; errors?: unknown } | undefined)
  const subtype = typeof result?.subtype === 'string' ? result.subtype : undefined
  const errors = Array.isArray(result?.errors) ? result.errors.filter((value): value is string => typeof value === 'string' && value.trim().length > 0) : []
  if (subtype !== undefined && subtype !== 'success') {
    return { status: 'failed', error: errors.join('\\n') || `Agent stream ended with ${subtype}` }
  }
  return { status: 'completed' }
}
export interface AgentRuntimeCoordinatorOptions {
  adapters: Partial<Record<AgentRuntime, AgentRuntimeAdapter>>
  ports?: AgentRuntimePorts
  retry?: RetryPolicy & { shouldRetry?: (error: string) => boolean }
  now?: () => number
  /** 可选持久化生命周期端口；未注入时不创建业务 Run、不改变原回调形状。 */
  runLedger?: AgentRuntimeRunLedgerPort
  /** 受信宿主补充执行主体与来源；省略时沿用 query.context/trigger 或已有 initiator 映射。 */
  createRunContext?: (input: AgentRuntimeQuery) => AgentRuntimeQuery['context']
  /**
   * 共享执行权登记表。宿主把同一个实例同时注入新旧两条执行链即可获得跨引擎互斥；
   * 不注入时 coordinator 自建一份（只在本协调器内互斥，与改造前等价）。
   */
  ownership?: AgentRunOwnershipRegistry
}


/** coordinator 自己的 owner 控制表：执行权归 registry，stop/wait 路由归这里。 */
interface AgentRunControlEntry {
  token: AgentRunOwnershipToken
  /** 已经进入停止流程（stop() 已调用、run 尚未 settle）；只影响拒绝文案。 */
  stopping: boolean
  stop(reason: string): Promise<void>
  queue?(input: AgentRuntimeQueuedInput): Promise<AgentRuntimeQueuedInputResult>
  wait?: Promise<AgentRunOutcome>
}


export interface AgentRuntimeRunHandle {
  readonly sessionId: string
  readonly runtime: AgentRuntime
  readonly promise: Promise<AgentRunOutcome>
  stop(reason?: string): Promise<void>
}

/**
 * Host-neutral run coordinator. Ownership is claimed synchronously before the
 * first provider await; session persistence and event projection remain ports.
 */
function enqueueSessionMessages(session: NonNullable<AgentRuntimePorts['sessions']> | undefined, sessionId: string, messages: readonly SDKMessage[]): void {
  if (!session || messages.length === 0) return
  if (session.enqueueMessages) {
    try { session.enqueueMessages(sessionId, messages) } catch (error) {
      console.error(`[Agent runtime] 消息持久化旁路失败，运行继续: session=${sessionId}`, error)
    }
    return
  }
  // Compatibility for non-Electron hosts. Production Electron provides enqueueMessages.
  // Defer and isolate this legacy write so provider callbacks do not observe its failure.
  queueMicrotask(() => {
    try { session.appendMessages(sessionId, messages) } catch (error) {
      console.error(`[Agent runtime] 延迟持久化失败，运行继续: session=${sessionId}`, error)
    }
  })
}

export class AgentRuntimeCoordinator {
  private readonly active = new Map<string, AgentRunControlEntry>()
  private readonly now: () => number
  /** 单一执行权登记表；默认实例只服务本协调器。 */
  readonly ownership: AgentRunOwnershipRegistry

  constructor(private readonly options: AgentRuntimeCoordinatorOptions) {
    this.now = options.now ?? Date.now
    this.ownership = options.ownership ?? createAgentRunOwnershipRegistry({ now: this.now })
  }

  run(input: AgentRuntimeQuery, callbacks: AgentRuntimeCallbacks = { onEvent() {} }): AgentRuntimeRunHandle {
    const adapter = this.options.adapters[input.runtime]
    if (!adapter) {
      const promise = Promise.resolve<AgentRunOutcome>({ status: 'failed', error: `${input.runtime} runtime unavailable` })
      return { sessionId: input.sessionId, runtime: input.runtime, promise, stop: async () => {} }
    }

    const session = this.options.ports?.sessions
    // 嵌套入口（runAgentHeadless → runtime 入口）会把上层已持有的 token 传下来；
    // 同一 token 的 claim 是幂等的，不会把自己当成并发请求拒绝。
    const token: AgentRunOwnershipToken = input.ownershipToken ?? Symbol(`runtime-run:${input.sessionId}`)
    const claim = this.ownership.claim({ sessionId: input.sessionId, runtime: input.runtime, token })
    if (!claim.ok) {
      // 被拒绝的请求不是一次运行：不落盘、不发事件、不产生 failed 伪终态，也不清理 owner。
      const stopping = this.active.get(input.sessionId)?.stopping === true
      const promise = Promise.reject<AgentRunOutcome>(createAgentRunRejectionError(claim, { stopping }))
      return { sessionId: input.sessionId, runtime: input.runtime, promise, stop: async () => {} }
    }

    const ledger = this.options.runLedger
    const existingControl = this.active.get(input.sessionId)
    if (ledger && claim.adopted && existingControl?.token === token && existingControl.wait) {
      return { sessionId: input.sessionId, runtime: input.runtime, promise: existingControl.wait, stop: existingControl.stop }
    }
    if (!ledger) {
      // 兼容既有入口的同步元数据读取与 mismatch 拒绝行为。
      const boundRuntime = session?.getMeta(input.sessionId)?.agentRuntime
      if (session && !session.lockRuntime && boundRuntime !== undefined && normalizeAgentRuntime(boundRuntime) !== input.runtime) {
        this.ownership.release(input.sessionId, token)
        const promise = Promise.reject<AgentRunOutcome>(
          new AgentSessionRuntimeMismatchError(normalizeAgentRuntime(boundRuntime), input.runtime),
        )
        return { sessionId: input.sessionId, runtime: input.runtime, promise, stop: async () => {} }
      }
    }
    let run: AgentRun | undefined
    let ownsLedgerRun = false
    let admissionFailed = false
    let admissionError: unknown
    let deduplicatedOutcome: AgentRunOutcome | undefined
    // claim 成功后、任何异步准备或可见开始事件之前同步落下 queued。
    if (ledger) {
      try {
        const context: NonNullable<AgentRuntimeQuery['context']> = this.options.createRunContext?.(input) ?? input.context
          ?? (input.trigger ? { trigger: input.trigger, taskId: input.taskId }
            : createAgentRunContext(input, () => globalThis.crypto.randomUUID(), this.now))
        const begin: BeginAgentRunInput = {
          id: input.runId,
          taskId: input.taskId ?? context.taskId,
          trigger: context.trigger,
          sessionRef: input.sessionId,
          executorRef: context.executorRef ?? input.sessionId,
          runtime: input.runtime,
        }
        const result = ledger.begin(begin)
        run = result.run
        input = {
          ...input, runId: run.id, taskId: run.taskId, trigger: context.trigger, context,
          prompt: appendRunOriginPrompt(input.prompt, context),
          ...(input.toolAssemblyContext ? { toolAssemblyContext: { ...input.toolAssemblyContext, context: withRunIdentity(input.toolAssemblyContext.context, run.id) } } : {}),
          ...(input.deferredToolAssemblyContext !== undefined ? { deferredToolAssemblyContext: withRunIdentity(input.deferredToolAssemblyContext, run.id) } : {}),
        }
        if (result.deduplicated) {
          // 重复触发不能重放副作用；运行中的旧记录必须由宿主确认接管，不能凭 claim 推断可恢复。
          deduplicatedOutcome = ledgerOutcome(run)
          if (!deduplicatedOutcome) throw new Error(`Run ${run.id} 已存在且尚未结束，需由宿主确认恢复`)
        } else {
          ownsLedgerRun = true
        }
      } catch (error) {
        admissionFailed = true
        admissionError = error
      }
    }
    const runReference: AgentRuntimeRunReference = run
      ? { runId: run.id, ...(run.taskId !== undefined ? { taskId: run.taskId } : {}), triggerId: run.triggerId }
      : {}
    const controller = new AbortController()

    // 无 ledger 保留原有同步 lock 失败拒绝；有 ledger 的准入失败统一走终态清理。
    try {
      if (!admissionFailed && !deduplicatedOutcome) {
        // SessionPort 没有 lockRuntime 时由核心拒绝跨内核请求；存在时仍由端口在写盘前判定。
        if (ledger) {
          const boundRuntime = session?.getMeta(input.sessionId)?.agentRuntime
          if (session && !session.lockRuntime && boundRuntime !== undefined && normalizeAgentRuntime(boundRuntime) !== input.runtime) {
            throw new AgentSessionRuntimeMismatchError(normalizeAgentRuntime(boundRuntime), input.runtime)
          }
        }
        session?.lockRuntime?.(input.sessionId, input.runtime)
      }
    } catch (error) {
      if (!ledger) {
        this.ownership.release(input.sessionId, token)
        const promise = Promise.reject<AgentRunOutcome>(error)
        return { sessionId: input.sessionId, runtime: input.runtime, promise, stop: async () => {} }
      }
      admissionFailed = true
      admissionError = error
    }

    const reporter = createAgentRunOutcomeReporter()
    let providerAttemptActive = false
    let finished = false
    let acceptingInput = false
    const pendingInputs = new Set<Promise<AgentRuntimeQueuedInputResult>>()
    const queuedInputs = new Map<string, Promise<AgentRuntimeQueuedInputResult>>()
    let inputRecordingError: unknown
    const messageIds = new WeakMap<SDKMessage, string>()
    const logicalMessageIds = new Map<string, string>()
    let pendingAssistantId: string | undefined
    const stamp = (message: SDKMessage, author?: ActorRef, context = input.context): SDKMessage => {
      if (!run || !context) return message
      const record = message as SDKMessage & { uuid?: string; message?: { id?: string }; _partial?: boolean; error?: unknown; _errorCode?: unknown }
      const key = record.message?.id ? `${message.type}:${record.message.id}` : undefined
      let id = messageIds.get(message) ?? (key ? logicalMessageIds.get(key) : undefined)
        ?? (record.uuid ? logicalMessageIds.get(`uuid:${record.uuid}`) : undefined)
      if (!id && message.type === 'assistant') id = pendingAssistantId
      id ??= record.uuid ?? globalThis.crypto.randomUUID()
      messageIds.set(message, id)
      if (key) logicalMessageIds.set(key, id)
      if (record.uuid) logicalMessageIds.set(`uuid:${record.uuid}`, id)
      if (message.type === 'assistant') pendingAssistantId = record._partial ? id : undefined
      const stamped = stampRunMessage(message, run, author ?? (message.type === 'assistant' && !record.error && !record._errorCode
        ? { type: 'agent', id: input.sessionId } : { type: 'system' }), () => id, context.trigger)
      // 部分帧可能没有 UUID，终稿才有。Provider UUID 原样保留，产品消息身份沿用已分配的 ID。
      const sourced = { ...stamped, _provenance: { ...stamped._provenance!, messageId: id } }
      messageIds.set(sourced, id)
      return sourced
    }
    const stop = async (reason: string): Promise<void> => {
      if (finished || this.active.get(input.sessionId)?.token !== token || controller.signal.aborted) return
      const control = this.active.get(input.sessionId)
      if (control) control.stopping = true
      reporter.onComplete({ stoppedByUser: true, endReason: reason })
      controller.abort(reason)
      if (providerAttemptActive) await adapter.stop?.(reason, input.sessionId)
    }
    this.active.set(input.sessionId, { token, stopping: false, stop })
    const abort = () => {
      // EventTarget 不等待 async listener；停止失败记录为执行错误，避免未处理 rejection。
      stop(String(input.abortSignal?.reason ?? 'stopped_by_user')).catch(error => {
        reporter.onError(error instanceof Error ? error.message : String(error))
      })
    }
    if (input.abortSignal?.aborted) abort()
    else input.abortSignal?.addEventListener('abort', abort, { once: true })
    const startedAt = typeof input.metadata?.startedAt === 'number' && Number.isFinite(input.metadata.startedAt)
      ? input.metadata.startedAt
      : this.now()
    const emit = (event: AgentRuntimeEvent): void | Promise<void> => this.options.ports?.host?.emit({ ...event, ...runReference })
    const runCallbacks: AgentRuntimeCallbacks = {
      onEvent: async (event) => {
        if (finished) return
        const sourced = event.type === 'message' ? { ...event, sessionId: input.sessionId, message: stamp(event.message) }
          : event.type === 'stream_payload' && event.payload.kind === 'sdk_message'
            ? { ...event, sessionId: input.sessionId, payload: { ...event.payload, message: stamp(event.payload.message) } } : event
        await emit(sourced)
        await callbacks.onEvent({ ...sourced, ...runReference })
      },
      onMessage: async (message: SDKMessage) => {
        if (finished) return
        // 先用原对象分配来源 ID，再附加运行耗时，避免重复 result 投影丢失稳定 ID。
        const runtimeMessage = addRuntimeDuration(stamp(message), startedAt, this.now())
        // 路由键用本轮 run 的 agent 会话 id（`input.sessionId`），不能用 `runtimeMessage.session_id`：
        // 后者是内核原生会话 id，宿主 EventBus 转发层按 agent 会话 id 找绑定 webContents。
        await emit({ type: 'message', sessionId: input.sessionId, message: runtimeMessage })
        await callbacks.onMessage?.(runtimeMessage)
        if (isPersistableRuntimeMessage(runtimeMessage)) {
          enqueueSessionMessages(session, input.sessionId, [normalizeRuntimeMessage(runtimeMessage, input.modelId, this.now())])
        }
      },
      onError: async () => {
        // provider 的中间错误只由 retry loop 判断；最终 outcome 统一回调宿主。
      },
      onComplete: async () => {
        // provider 的中间终态只由 retry loop 判断；最终 outcome 统一回调宿主。
      },
      onBackgroundTasksPending: async (signal) => {
        // 轻量完成不是终态：只转发给宿主投影，不参与 outcome 判定。
        if (finished) return
        await callbacks.onBackgroundTasksPending?.(signal)
      },
    }

    const current = () => !finished && !controller.signal.aborted && this.active.get(input.sessionId)?.token === token
      && this.ownership.getOwner(input.sessionId)?.token === token
    const permissionRequests = new Set<string>()
    if (ledger && run && ownsLedgerRun) input = { ...input, runLifecycle: {
      wait: requestId => {
        if (!current() || !run || permissionRequests.has(requestId)) return
        run = ledger.wait(run.id, { type: 'request', id: requestId })
        permissionRequests.add(requestId)
      },
      resume: requestId => {
        if (!current() || !run || !permissionRequests.has(requestId)) return
        run = ledger.resume(run.id, { schemaVersion: 1, id: `resume:${run.id}:${requestId}`, kind: 'resume',
          actor: { type: 'system' }, source: { type: 'request', id: requestId }, createdAt: this.now() })
        permissionRequests.delete(requestId)
        const remaining = [...permissionRequests].at(-1)
        if (remaining) run = ledger.wait(run.id, { type: 'request', id: remaining })
      },
    } }
    const ownerControl = this.active.get(input.sessionId)!
    ownerControl.queue = queued => {
      if (!current() || !acceptingInput || ownerControl.stopping) return Promise.reject(new Error('当前 Run 已结束或未接收输入'))
      if (queued.ownershipToken !== undefined && queued.ownershipToken !== token) return Promise.reject(new Error('追加输入的执行权 token 已过期'))
      const record = queued.message as SDKMessage & { uuid?: string }
      const key = record.uuid ?? queued.context.trigger.id
      const existing = queuedInputs.get(key)
      if (existing) return existing
      if (!session) return Promise.reject(new Error('追加输入持久化需要 SessionPort'))
      const sourceRun = run
      const message = stamp(queued.message, queued.context.messageAuthor ?? queued.context.trigger.actor, queued.context)
      let accepted = false
      const delivery = Promise.resolve().then(async () => {
        if (!current() || !acceptingInput || ownerControl.stopping) throw new Error('当前 Run 已结束或未接收输入')
        await queued.receive({ ...runReference, message, isCurrent: () => current() && acceptingInput && !ownerControl.stopping })
        accepted = true
        // 接收后即使 stop/settle，仍保存到捕获的原 Run；绝不按 session 查找新 Run。
        let attachError: unknown
        if (ledger && sourceRun) {
          try {
            if (!ledger.attachInput(sourceRun.id, queued.context.trigger)) throw new Error('已接收输入无法关联原 Run，需对账')
          } catch (error) { attachError = error }
        }
        // Transcript 是运行结果的旁路副本；先投影已接收输入，再异步入队持久化。
        await emit({ type: 'message', sessionId: input.sessionId, message })
        await callbacks.onMessage?.(message)
        enqueueSessionMessages(session, input.sessionId, [message])
        if (attachError) throw attachError
        return { ...runReference, messageId: message._provenance?.messageId ?? record.uuid ?? queued.context.trigger.id }
      })
      queuedInputs.set(key, delivery)
      pendingInputs.add(delivery)
      void delivery.then(() => { pendingInputs.delete(delivery) }, () => {
        pendingInputs.delete(delivery)
        if (!accepted) queuedInputs.delete(key)
      })
      return delivery
    }

    const rawPromise = (async (): Promise<AgentRunOutcome> => {
      if (admissionFailed) throw admissionError
      if (deduplicatedOutcome) return deduplicatedOutcome
      if (run) await input.onRunAdmitted?.({ ...input, runId: run.id })
      // claim/active 与「provider 真正启动」是两件事：先只声明执行权已被本轮 run 取得。
      // 凭证 / 资源 / 工具装配可能失败，此时 provider 从未参与，宿主不得据此清未读、晋升 draft
      // 或建立 UI running 态（那些副作用统一挂在下面的 `runtime_started` 上）。
      await emit({ type: 'runtime_claimed', sessionId: input.sessionId, runtime: input.runtime, startedAt, title: input.title, workspaceId: input.workspaceId, modelId: input.modelId, initiator: input.initiator })
      if (controller.signal.aborted) return { status: 'stopped' }
      let retryCount = 0
      let retryWaitedMs = 0
      /** provider 启动语义（`runtime_started` + `onRunStarted`）每次 run 只投递一次：重试不重复宣告。 */
      let providerStarted = false
      /** 用户消息每次 run 至多落盘一次：重试只重做准备与 provider attempt，不重复写 transcript。 */
      let userMessagePersisted = false
      while (true) {
        if (controller.signal.aborted) return { status: 'stopped' }
        const preparation = this.options.ports?.queryPreparation
        const preparedContext = preparation
          ? await preparation.prepare(input, controller.signal)
          : (await this.prepare(input, controller.signal)).prepared ?? {}
        if (controller.signal.aborted) return { status: 'stopped' }
        const providerInput = this.options.ports?.providerQueryPreparation
          ? await this.options.ports.providerQueryPreparation.prepare(input, preparedContext, controller.signal)
          : input.providerInput
        const prepared = { ...input, abortSignal: controller.signal, prepared: { ...input.prepared, ...preparedContext }, ...(providerInput ? { providerInput } : {}) }
        if (controller.signal.aborted) return { status: 'stopped' }
        // 准备成功后，用户输入立即进入运行态投影与异步持久化旁路，不等待写盘。
        if (input.persistedUserMessage && !userMessagePersisted) {
          if (!session) throw new AgentRuntimePreparationError('Persisted user message requires a SessionPort', 'session_port_missing', 'persistence')
          const notice = run && input.context ? createRunTriggerMessage(run, input.context, () => globalThis.crypto.randomUUID(), this.now()) : undefined
          if (notice) {
            await emit({ type: 'message', sessionId: input.sessionId, message: notice })
            enqueueSessionMessages(session, input.sessionId, [notice])
          }
          input.persistedUserMessage = stamp(input.persistedUserMessage, input.context?.messageAuthor ?? input.context?.trigger.actor)
          await emit({ type: 'message', sessionId: input.sessionId, message: input.persistedUserMessage })
          enqueueSessionMessages(session, input.sessionId, [input.persistedUserMessage])
          userMessagePersisted = true
        }
        if (!providerStarted) {
          // 先保存 running，再发布开始副作用；保存失败时 provider 从未启动。
          if (ledger && run && ownsLedgerRun) {
            run = ledger.start(run.id)
            if (run.status !== 'running') return ledgerOutcome(run) ?? { status: 'failed', error: `Run ${run.id} 未进入运行态` }
          }
          // 「真正运行开始」的唯一触发点：准备已经成功，provider 随即启动。
          providerStarted = true
          await emit({ type: 'runtime_started', sessionId: input.sessionId, runtime: input.runtime, startedAt, title: input.title, workspaceId: input.workspaceId, modelId: input.modelId, initiator: input.initiator })
          await callbacks.onRunStarted?.({ startedAt, ...runReference })
          if (controller.signal.aborted) return { status: 'stopped' }
        }
        providerAttemptActive = true
        acceptingInput = true
        let outcome: AgentRunOutcome
        try {
          outcome = await (adapter.stream
            ? consumeRuntimeStream(adapter.stream(prepared), controller.signal, runCallbacks, {
                sessionId: input.sessionId,
                startedAt,
              })
            : adapter.query(prepared, runCallbacks))
        } catch (error) {
          outcome = { status: 'failed', error: error instanceof Error ? error.message : String(error) }
        } finally {
          acceptingInput = false
          providerAttemptActive = false
          // Provider 接收与 settle 竞态时，先保存已接收的输入，再封存原 Run。
          await Promise.allSettled([...pendingInputs])
        }
        if (outcome.status !== 'failed' || controller.signal.aborted) return controller.signal.aborted ? { status: 'stopped' } : outcome

        const shouldRetry = this.options.retry?.shouldRetry ?? ((error: string) => isRetryableError({ message: error }))
        const policy: RetryPolicy = { ...this.options.retry, maxRetries: this.options.retry?.maxRetries ?? 0 }
        if (!shouldRetry(outcome.error) || !canRetry(retryCount + 1, retryWaitedMs, policy)) return outcome
        retryCount += 1
        const delayMs = getRetryDelayMs(retryCount, retryWaitedMs, policy)
        await runCallbacks.onEvent({ type: 'retry', attempt: retryCount, delayMs, reason: outcome.error })
        if (await waitForRetryDelay(delayMs, { signal: controller.signal }) === 'stopped') return { status: 'stopped' }
        retryWaitedMs += delayMs
      }
    })()
      .then(async (outcome) => {
        if (outcome.status === 'completed') reporter.onComplete()
        else if (outcome.status === 'stopped') reporter.onComplete({ stoppedByUser: true })
        else {
          reporter.onError(outcome.error)
          await callbacks.onError?.(outcome.error)
        }
        return reporter.finish() ?? outcome
      })
      .catch(async (error): Promise<AgentRunOutcome> => {
        const message = error instanceof Error ? error.message : String(error)
        reporter.onError(message)
        if (!ledger) {
          await callbacks.onPreparationFailure?.(preparationFailureFrom(error, message))
          return reporter.finish() ?? { status: 'failed', error: message }
        }
        // 失败通知异常也不能跳过账本终态或 owner 清理；同时保留两项错误。
        try {
          await callbacks.onPreparationFailure?.(preparationFailureFrom(error, message))
        } catch (notificationError) {
          return { status: 'failed', error: `${message}\n${notificationError instanceof Error ? notificationError.message : String(notificationError)}` }
        }
        return reporter.finish() ?? ({ status: 'failed', error: message } satisfies AgentRunOutcome)
      })
    let finalOutcome: AgentRunOutcome | undefined
    const promise = rawPromise
      .then(async (outcome) => {
        finished = true
        // 唯一的 finish 调用点；保存失败不能报告成功，也不能重跑 provider 或重试终态副作用。
        if (ledger && run && ownsLedgerRun) {
          try {
            const recorded = ledger.finish(run.id, outcome)
            outcome = ledgerOutcome(recorded) ?? outcome
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            outcome = { status: 'failed', error: outcome.status === 'failed' ? `${outcome.error}\n${message}` : message }
            try { await callbacks.onError?.(message) } catch { /* 账本错误仍由最终 outcome 可见。 */ }
          }
        }
        finalOutcome = outcome
        try {
          await callbacks.onComplete?.(run ? { ...outcome, ...runReference } : outcome)
        } catch {
          // 终态观察者异常不撤销已经确定的 outcome。
        }
        return outcome
      })
      .finally(async () => {
        input.abortSignal?.removeEventListener('abort', abort)
        // 释放必须校验 token：旧 run 的 finally 不能清掉已被新 run 接管的会话。
        this.ownership.release(input.sessionId, token)
        if (this.active.get(input.sessionId)?.token === token) this.active.delete(input.sessionId)
        try {
          await emit({ type: 'runtime_finished', sessionId: input.sessionId, runtime: input.runtime, outcome: finalOutcome ?? { status: 'failed', error: 'Agent 未产生运行终态' }, finishedAt: this.now(), title: input.title, workspaceId: input.workspaceId, modelId: input.modelId, initiator: input.initiator })
        } catch {
          // 宿主终态投影失败不能使已完成的 run 重新失败；owner 已释放。
        }
      })

    const owner = this.active.get(input.sessionId)
    if (owner?.token === token) owner.wait = promise
    return {
      sessionId: input.sessionId,
      runtime: input.runtime,
      promise,
      stop: async (reason = 'stopped_by_user') => stop(reason),
    }
  }

  /** 只向当前活跃 Provider 追加；不建立 Run，也不在 settled 后排队下一轮。 */
  queueMessage(input: AgentRuntimeQueuedInput): Promise<AgentRuntimeQueuedInputResult> {
    const control = this.active.get(input.sessionId)
    if (!control?.queue) return Promise.reject(new Error('会话未运行，无法追加消息'))
    return control.queue(input)
  }

  private async prepare(input: AgentRuntimeQuery, signal: AbortSignal): Promise<AgentRuntimeQuery> {
    return {
      ...input,
      abortSignal: signal,
      prepared: await createAgentQueryPreparationPort(this.options.ports ?? {}).prepare(input, signal),
    }
  }
  isRunning(sessionId: string): boolean {
    return this.active.has(sessionId)
  }

  async stop(sessionId: string, reason = 'stopped_by_user'): Promise<void> {
    const active = this.active.get(sessionId)
    if (!active) return
    await active.stop(reason)
  }
  async stopAndWait(sessionId: string, reason = 'stopped_by_user'): Promise<void> {
    const active = this.active.get(sessionId)
    if (!active) return
    await active.stop(reason)
    await active.wait
  }

  async stopAll(reason = 'stopped_by_user'): Promise<void> {
    const active = [...this.active.values()]
    await Promise.all(active.map(async owner => {
      await owner.stop(reason)
      await owner.wait
    }))
  }
}

export function createAgentRuntimeCoordinator(options: AgentRuntimeCoordinatorOptions): AgentRuntimeCoordinator {
  return new AgentRuntimeCoordinator(options)
}
