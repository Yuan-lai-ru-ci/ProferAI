import { createHash, randomUUID } from 'node:crypto'
import { isGoalResumableByMessage, isGoalUpdateToolName } from '@profer/shared'
import type { AgentGoalContract, AgentGoalIterationResult, AgentGoalLimitsPatch, AgentGoalState, AgentGoalUsage, AgentRunInitiator, AgentSendInput, SDKMessage } from '@profer/shared'
import { extractApiError, isAutoRetryableCatchError } from './agent-retry-utils'
import { GoalController } from './goal-controller'
import { buildGoalIterationPrompt } from './goal-loop'
import { normalizeGoalToolResult } from './goal-tools'
import { validateGoalUpdatePatch } from './goal-update-validation'

type GoalSession = Partial<Pick<AgentSendInput, 'channelId' | 'modelId' | 'workspaceId' | 'agentRuntime'>> & { title?: string; permissionMode?: AgentSendInput['permissionModeOverride'] }
type GoalPatch = { goal?: string; contract?: AgentGoalContract; limits?: AgentGoalLimitsPatch }

type Dependencies = {
  getSession: (sessionId: string) => GoalSession | undefined
  run: (input: AgentSendInput) => Promise<void>
  isSessionActive: (sessionId: string) => boolean
  stopRun: (sessionId: string, runId: string) => Promise<void>
  /** 计划模式下 Goal 保持 active 但等待，切换为可执行模式后自动继续。 */
  isPlanMode: (sessionId: string) => boolean
  readStates: () => AgentGoalState[]
  saveStates: (states: AgentGoalState[]) => void
  archive: (state: AgentGoalState) => void
  history: (sessionId: string) => AgentGoalState[]
  readMessages: (sessionId: string) => SDKMessage[]
  appendMessages: (sessionId: string, messages: SDKMessage[]) => void
  createBlockedTodo: (state: AgentGoalState, session?: GoalSession) => string
  updateBlockedTodo: (id: string, status: 'open' | 'completed', notes: string) => void
  publish: (state: AgentGoalState) => void
  logError: (error: unknown) => void
}

/** Goal 只读取当前轮 runtime usage；消息正文永远不能成为控制协议。 */
export function collectGoalRunUsage(messages: SDKMessage[]): AgentGoalUsage | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index] as { type?: string; usage?: Record<string, unknown> }
    if (message.type !== 'result' || !message.usage) continue
    const value = (key: string) => {
      const number = Number(message.usage?.[key] ?? 0)
      return Number.isFinite(number) && number >= 0 ? number : 0
    }
    const inputTokens = value('input_tokens') + value('cache_read_input_tokens') + value('cache_creation_input_tokens')
    const outputTokens = value('output_tokens')
    return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens }
  }
  return undefined
}

export type GoalTurnProgress = 'progress' | 'empty' | 'all_tools_failed'

type ContentBlock = { type?: string; text?: string; name?: string; is_error?: boolean }

function contentBlocks(message: SDKMessage): ContentBlock[] {
  const content = (message as { message?: { content?: unknown } }).message?.content
  return Array.isArray(content) ? content as ContentBlock[] : []
}

/**
 * 依据本轮真实 runtime 消息判断有无进展（对齐 Codex 的空回复 / exec 全失败判定）。
 * Goal 内部 update_goal 工具不算工作进展。
 */
export function assessGoalTurnProgress(messages: SDKMessage[]): GoalTurnProgress {
  let hasText = false
  let toolCalls = 0
  let toolResults = 0
  let failedResults = 0
  for (const message of messages) {
    for (const block of contentBlocks(message)) {
      if (message.type === 'assistant' && block.type === 'text' && block.text?.trim()) hasText = true
      if (message.type === 'assistant' && block.type === 'tool_use' && !isGoalUpdateToolName(block.name)) toolCalls++
      if (message.type === 'user' && block.type === 'tool_result') {
        toolResults++
        if (block.is_error) failedResults++
      }
    }
  }
  if (toolCalls === 0) return hasText ? 'progress' : 'empty'
  return toolResults > 0 && failedResults === toolResults ? 'all_tools_failed' : 'progress'
}

/** orchestrator 短重试预算（约 5 分钟）用尽后仍可能在分钟级恢复的限额类错误，交给 Goal 的长退避。 */
const RATE_OR_USAGE_LIMIT_PATTERN = /rate.?limit|usage.?limit/i

/** 运行级错误分类：沿用 orchestrator 自动重试判定（429 / 5xx / 网络抖动 / 上游繁忙）并补充限额类；其余直接暂停。 */
export function classifyGoalRunError(error: string | undefined): 'retryable' | 'fatal' {
  if (!error) return 'retryable'
  return isAutoRetryableCatchError(extractApiError(error), error) || RATE_OR_USAGE_LIMIT_PATTERN.test(error) ? 'retryable' : 'fatal'
}

function resultKey(state: AgentGoalState): string {
  return state.lifecycle?.at(-1)?.id ?? `goal:${state.id}:${state.iteration}:${state.status}`
}

function stableUuid(key: string): string {
  const hex = createHash('sha256').update(key).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/** 会话级 Goal 接线：生命周期、消息投影、Todo 与运行归属统一在这里。 */
export class GoalSessionService {
  readonly controller: GoalController
  private readonly projecting = new Set<string>()
  private readonly todoHandled = new Set<string>()
  private readonly publishedRevision = new Map<string, number>()
  private readonly archived = new Map<string, number>()
  private restored = false

  constructor(private readonly deps: Dependencies) {
    this.controller = new GoalController({
      canRun: (sessionId) => !deps.isSessionActive(sessionId),
      waitingReason: (sessionId) => deps.isPlanMode(sessionId) ? 'plan_mode' : undefined,
      runTurn: async ({ sessionId, state, previousSummary, runId }) => {
        const session = deps.getSession(sessionId)
        if (!session?.channelId) throw new Error('Goal 会话缺少渠道配置')
        let report: AgentGoalIterationResult | undefined
        let outcome: { status: 'completed' | 'failed' | 'stopped'; error?: string } | undefined
        const messages: SDKMessage[] = []
        try {
          await deps.run({
            sessionId,
            ...session,
            channelId: session.channelId,
            permissionModeOverride: session.permissionMode,
            userMessage: state.goal,
            // 持久化的 user 消息带 _goalIteration 标记，只渲染为轮次分隔条；runtime 只收 internalPrompt。
            internalPrompt: buildGoalIterationPrompt(state, { previousSummary }),
            triggeredBy: 'goal',
            goalIteration: state.iteration,
            goalRunId: runId,
            titleSourceText: state.goal,
            onRuntimeMessage: (message) => {
              if (!(message as { isReplay?: boolean }).isReplay) messages.push(message)
            },
            reportGoalResult: (result) => { report = normalizeGoalToolResult(result) },
            onRunOutcome: (result) => { outcome = result },
          })
        } catch (error) {
          // 未获得宿主所有权的自动轮次应延后，不把用户当前工作标成失败。
          if (deps.isSessionActive(sessionId)) return { status: 'continue', summary: '等待当前会话空闲', evidence: [], outcome: 'deferred' }
          throw error
        }
        const usage = collectGoalRunUsage(messages)
        if (outcome?.status === 'stopped') return { status: 'continue', summary: '用户已停止 Goal', evidence: [], outcome: 'stopped', usage }
        if (outcome?.status === 'failed') return { status: 'continue', summary: outcome.error || 'Goal 本轮执行失败', error: outcome.error, errorKind: classifyGoalRunError(outcome.error), evidence: [], outcome: 'failed', usage }
        if (!outcome) return { status: 'continue', summary: '运行没有产生终态', error: '运行没有产生终态', errorKind: 'retryable', evidence: [], outcome: 'failed', usage }
        if (report) return { ...report, usage, outcome: report.outcome ?? 'success' }
        // 未汇报不是失败：有真实进展就自动续跑，只有空回复 / 工具全部失败才计入无进展。
        const progress = assessGoalTurnProgress(messages)
        if (progress === 'progress') return { status: 'continue', summary: '本轮已推进，未提交汇报', evidence: [], outcome: 'success', usage }
        const summary = progress === 'empty' ? '本轮没有任何输出或工具调用' : '本轮工具调用全部失败'
        return { status: 'continue', summary, error: summary, evidence: [], outcome: 'failed', usage }
      },
      stopTurn: (sessionId, runId) => runId ? deps.stopRun(sessionId, runId) : Promise.resolve(),
      onStateChange: (state) => this.onStateChange(state),
      onBeforeClear: (state) => this.archive(state),
    })
  }

  restore(states?: AgentGoalState[]): void {
    if (this.restored) return
    // hydrate 不调用 live 投影；所有状态装载完成后一次写入。
    this.controller.restore(states ?? this.deps.readStates())
    this.deps.saveStates(this.controller.list())
    for (const state of this.controller.list()) this.todoHandled.add(resultKey(state))
    this.restored = true
  }

  get(sessionId: string): AgentGoalState | undefined { return this.controller.get(sessionId) }
  list(): AgentGoalState[] { return this.controller.list() }
  history(sessionId: string): AgentGoalState[] {
    const current = this.get(sessionId)
    const states = this.deps.history(sessionId)
    return current ? [current, ...states.filter((state) => state.id !== current.id)] : states
  }

  async start(sessionId: string, goal: string, contract?: AgentGoalContract): Promise<AgentGoalState> {
    if (!goal.trim()) throw new Error('Goal 不能为空')
    if (!this.deps.getSession(sessionId)?.channelId) throw new Error('Goal 会话缺少渠道配置')
    const existing = this.get(sessionId)
    if (existing && existing.status !== 'completed') throw new Error('当前会话有未完成的 Goal，请先恢复或明确清除它')
    if (existing) this.archive(existing)
    const contractLines = [
      contract?.verification ? `\n@verify: ${contract.verification}` : '',
      contract?.constraints ? `\n@constraint: ${contract.constraints}` : '',
      contract?.stopWhen ? `\n@stop: ${contract.stopWhen}` : '',
    ].join('')
    // 先记录用户意图；失败时尚未创建/调度 Goal。
    this.appendUser(sessionId, `/goal ${goal}${contractLines}`)
    return this.controller.start(sessionId, goal, contract)
  }

  async pause(sessionId: string): Promise<AgentGoalState> { return this.controller.pause(sessionId) }
  async resume(sessionId: string): Promise<AgentGoalState> { return this.controller.resume(sessionId) }
  async stop(sessionId: string): Promise<AgentGoalState> { return this.controller.stop(sessionId) }
  /** 普通停止按钮打断 Goal 轮次：只暂停，发消息即可续上。 */
  async pauseForInterrupt(sessionId: string): Promise<AgentGoalState> { return this.controller.pauseForInterrupt(sessionId) }

  /**
   * 人发起的运行（桌面、Pocket、飞书等 IM）结束后：受阻或被中断的 Goal 自动续上，
   * 由 Controller 的空闲等待接着跑（对齐 Codex 空闲续跑 / Claude Code 发消息继续）。
   */
  async onRunFinished(sessionId: string, initiator: AgentRunInitiator | undefined): Promise<void> {
    if (initiator !== 'user' && initiator !== 'external') return
    const goal = this.get(sessionId)
    if (!goal || goal.activeRunId || !isGoalResumableByMessage(goal)) return
    try { await this.controller.resume(sessionId) } catch (error) { this.deps.logError(error) }
  }

  /** 权限模式等外部条件变化后立即唤醒等待中的 Goal。 */
  nudge(sessionId: string): void { this.controller.nudge(sessionId) }

  update(sessionId: string, input: GoalPatch): AgentGoalState {
    const patch = validateGoalUpdatePatch(input)
    const state = this.controller.update(sessionId, patch)
    // 目标与预算修改也是用户的明确操作，保留可追溯记录。
    const changes = [patch.goal ? `目标：${patch.goal}` : '', patch.limits ? `预算：${JSON.stringify(patch.limits)}` : '', patch.contract ? `契约：${JSON.stringify(patch.contract)}` : ''].filter(Boolean).join('\n')
    this.appendUser(sessionId, `/goal update\n${changes}`)
    return state
  }
  clear(sessionId: string): void {
    if (!this.get(sessionId)) return
    this.controller.clear(sessionId)
  }
  stopAll(): void { this.controller.stopAll() }

  private archive(state: AgentGoalState): void {
    const revision = state.revision ?? 0
    if ((this.archived.get(state.id) ?? -1) >= revision) return
    this.deps.archive(state)
    this.archived.set(state.id, revision)
  }

  private appendUser(sessionId: string, text: string): void {
    this.deps.appendMessages(sessionId, [{ type: 'user', message: { content: [{ type: 'text', text }] }, parent_tool_use_id: null, uuid: randomUUID(), _createdAt: Date.now() } as unknown as SDKMessage])
  }

  private onStateChange(state: AgentGoalState): void {
    const current = this.get(state.sessionId)
    if (current && current.id !== state.id) return
    const key = resultKey(state)
    if (!this.projecting.has(key)) {
      this.projecting.add(key)
      try {
        this.persistVisibleResult(state)
        this.syncTodo(state, key)
      } catch (error) {
        this.deps.logError(error)
      } finally {
        this.projecting.delete(key)
      }
    }
    try { this.deps.saveStates(this.controller.list()) } catch (error) { this.deps.logError(error) }
    // Todo patch 可能同步重入；只发送 controller 当前快照，不把外层旧值再次覆盖 UI。
    const latest = state.reasonCode === 'cleared' || state.stopReason === 'cleared' ? state : this.get(state.sessionId)
    if (!latest || latest.id !== state.id) return
    const revision = latest.revision ?? 0
    if ((this.publishedRevision.get(latest.id) ?? -1) >= revision) return
    this.publishedRevision.set(latest.id, revision)
    this.deps.publish(latest)
  }

  private persistVisibleResult(state: AgentGoalState): void {
    if (!['completed', 'blocked', 'failed', 'budget_limited', 'stopped'].includes(state.status) || state.reasonCode === 'cleared' || state.stopReason === 'cleared') return
    const record = state.history?.at(-1)
    const summary = state.reasonDetail || state.stopReason || record?.summary || state.lastSummary
    if (!summary) return
    const key = resultKey(state)
    const uuid = stableUuid(key)
    if (this.deps.readMessages(state.sessionId).some((message) => (message as { uuid?: string }).uuid === uuid || (message as { _goalResultKey?: string })._goalResultKey === key)) return
    const labels: Record<string, string> = { completed: '已完成', blocked: '需要输入', failed: '执行失败', budget_limited: '预算已耗尽', stopped: '已停止' }
    const evidence = record?.evidence ?? state.lastEvidence ?? []
    const text = `Goal ${labels[state.status]}\n\n${summary}${evidence.length ? `\n\n证据：\n${evidence.map((item) => `- ${item}`).join('\n')}` : ''}`
    this.deps.appendMessages(state.sessionId, [{ type: 'assistant', message: { content: [{ type: 'text', text }] }, parent_tool_use_id: null, uuid, _createdAt: state.updatedAt, _goalVisibleResult: true, _goalResultKey: key } as unknown as SDKMessage])
  }

  private syncTodo(state: AgentGoalState, key: string): void {
    if (this.todoHandled.has(key)) return
    if (state.status === 'blocked') {
      if (state.blockedTodoId) this.deps.updateBlockedTodo(state.blockedTodoId, 'open', `最新阻塞原因：${state.stopReason || state.lastSummary || '需要输入'}`)
      else {
        const todoId = this.deps.createBlockedTodo(state, this.deps.getSession(state.sessionId))
        this.controller.patch(state.sessionId, { blockedTodoId: todoId })
      }
      this.todoHandled.add(key)
      return
    }
    if (state.status === 'active' && state.blockedTodoId) {
      this.deps.updateBlockedTodo(state.blockedTodoId, 'completed', 'Goal 已恢复执行')
      this.todoHandled.add(key)
      return
    }
    if (state.blockedTodoId && ['completed', 'failed', 'stopped', 'budget_limited'].includes(state.status)) {
      const reason = state.stopReason === 'cleared' ? '关联 Goal 已由用户清除；历史已归档。' : state.status === 'completed' ? 'Goal 已完成' : state.status === 'budget_limited' ? 'Goal 已达到预算上限' : state.status === 'failed' ? 'Goal 已失败' : 'Goal 已停止'
      this.deps.updateBlockedTodo(state.blockedTodoId, 'completed', reason)
      this.todoHandled.add(key)
    }
  }
}
