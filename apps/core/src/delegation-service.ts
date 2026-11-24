import { randomUUID } from 'node:crypto'
import type { AgentSessionMeta, SDKMessage, DelegationBlockedEvent, PermissionRequest, AskUserRequest } from '@profer/shared'
import { getEffectiveDisabledToolNames, resolveEffectivePermissionMode, selectNewDelegationPreset } from '@profer/shared'
import { createAgentRunContext, DelegationBlockedRegistry, waitForDelegationProgress, decideDelegationBlockedWake, type AgentRunLedger, type AgentRuntimeRunHandle } from '@profer/agent-runtime'
import { resolveDelegationArrangement, resolveDelegationPermissionMode, buildDelegationDispatchFacts, buildDelegationPrompt, buildDelegationTaskWithSharedContext, MAX_RUNNING_DELEGATIONS_PER_PARENT } from '@profer/agent-runtime/delegation-tools'
import { DEFAULT_WAIT_SECONDS, MAX_WAIT_SECONDS, type DelegationContext, type DelegateInput, type DelegateBatchInput, type DelegationWaitInput, type DelegationAnswerInput, type DelegationToolOperations } from '@profer/agent-runtime/delegation-tool-operations'
import { corePresetStore, resolveCorePreset } from './preset-resources'
import type { CoreConfig } from './config'
import type { CoreAgentRuntime, CoreEvent } from './runtime'
import { CoreDelegationStore, type CoreDelegationRecord } from './delegation-store'

interface Active { handle: AgentRuntimeRunHandle; done: Promise<void> }
/** Core持有关系和结果；子会话、父级续跑均通过已有Coordinator取得执行权。 */
export class CoreDelegationService implements DelegationToolOperations {
  private runtime?: CoreAgentRuntime
  private readonly active = new Map<string, Active>()
  private readonly blocked = new DelegationBlockedRegistry()
  private readonly waking = new Set<string>()
  private unsubscribe?: () => void
  private closed = false
  private failure?: unknown
  constructor(private readonly config: CoreConfig, private readonly store: CoreDelegationStore, private readonly ledger: AgentRunLedger) {}

  bindRuntime(runtime: CoreAgentRuntime): void {
    this.runtime = runtime
    // 启动对账只收敛旧运行，不重放上一轮工具。
    for (const record of this.records()) {
      if (record.status !== 'running') continue
      const run = this.ledger.findByTrigger(record.triggerId)
      const status = run?.status === 'completed' ? 'completed' : run?.status === 'failed' ? 'failed'
        : run?.status === 'stopped' && record.cancelRequested ? 'cancelled' : 'interrupted'
      this.finish(record, status, run?.failureReason ?? (status === 'interrupted' ? 'Core重启，旧运行未确认；未自动重放' : undefined), record.resultSummary, run?.id, false)
    }
    this.unsubscribe = runtime.subscribe(event => {
      try { this.observe(event) }
      catch (error) { this.failure = error; console.error('[Core Delegation] 状态登记失败，已暂停派发：', error) }
    })
    // 重启不自动唤醒旧轮结果；用户显式续跑或读取后再推进。

  }
  snapshot(parentId?: string): CoreDelegationRecord[] {
    return structuredClone(this.records().filter(r => !parentId || r.parentSessionId === parentId))
  }
  private parent(ctx: DelegationContext, creating = false): AgentSessionMeta {
    this.assertAvailable()
    ctx.signal?.throwIfAborted()
    const parent = this.runtime?.sessions.getMeta(ctx.sessionId)
    if (!parent || !parent.workspaceId || parent.workspaceId !== ctx.workspaceId || this.runtime?.deletions.isDeleting(ctx.sessionId)) throw new Error('父会话或工作区不属于当前Core，或正在删除')
    if (creating && (parent.sourceDelegationId || (parent.delegationDepth ?? 0) > 0)) throw new Error('委派子会话不能继续派工')
    return parent
  }
  private assertWrite(ctx: DelegationContext, name: string): AgentSessionMeta {
    const parent = this.parent(ctx)
    if (this.runtime!.permissions.getMode(parent.id) === 'plan') throw new Error('计划模式禁止委派写操作')
    const workspace = this.runtime!.workspaces.list().find(w => w.id === parent.workspaceId)
    const resources = resolveCorePreset(this.config, parent, workspace)
    if (getEffectiveDisabledToolNames(resources.policy).includes(name)) throw new Error('当前预设已禁用此委派操作')
    return parent
  }
  private records(): CoreDelegationRecord[] { return this.store.read().records }
  private get(parentId: string, id: string): CoreDelegationRecord {
    const record = this.records().find(r => r.parentSessionId === parentId && r.delegationId === id)
    if (!record) throw new Error('委派不存在或不属于当前父会话')
    return record
  }
  private mutate(id: string, apply: (record: CoreDelegationRecord) => void): CoreDelegationRecord {
    const index = this.store.read(), record = index.records.find(r => r.delegationId === id)
    if (!record) throw new Error('委派不存在')
    apply(record)
    record.updatedAt = Date.now()
    try { this.store.write(index) } catch (error) { this.failure = error; throw error }
    return record
  }
  private resources(parent: AgentSessionMeta, target: DelegateInput['presetReference'], mode: 'create' | 'continue') {
    const workspace = this.runtime!.workspaces.list().find(w => w.id === parent.workspaceId)
    if (!workspace) throw new Error('父工作区不存在')
    const source = resolveCorePreset(this.config, parent, workspace)
    if (mode === 'create') target = selectNewDelegationPreset(target, workspace.slug, corePresetStore(this.config, workspace))
    const selected = target ? resolveCorePreset(this.config, { ...parent, presetId: target.presetId, presetReference: target, permissionMode: undefined, permissionModeSource: undefined }, workspace) : source
    return { source, selected }
  }
  listAvailableModels(ctx: DelegationContext): Record<string, unknown> {
    const parent = this.parent(ctx), channel = this.runtime!.listChannelConfigs().find(c => c.id === parent.channelId)
    if (!channel || channel.enabled === false) throw new Error('当前Core渠道不可用')
    return { channelId: channel.id, currentModelId: parent.modelId, models: channel.models?.filter(m => m.enabled) ?? [] }
  }
  private async once(ctx: DelegationContext, operation: string, supplied: string | undefined, input: unknown, execute: () => Promise<Record<string, unknown>>): Promise<Record<string, unknown>> {
    const id = supplied ?? ctx.operationId
    if (!id) return execute()
    if (typeof id !== 'string' || !id.trim() || id.length > 200) throw new Error('委派operationId无效')
    const operationId = `command:${ctx.sessionId}:${ctx.sourceRunId ?? 'host'}:${operation}:${id}`
    const fingerprint = JSON.stringify(input)
    const index = this.store.read(), existing = index.operations.find(item => item.operationId === operationId)
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new Error('委派operationId不能复用于不同参数')
      const result = existing.result as { state?: string; value?: Record<string, unknown>; error?: string }
      if (result.state === 'completed' && result.value) return structuredClone(result.value)
      throw new Error(result.error ?? '此委派操作已经接收，结果尚未确认；请查询委派列表，不会自动重复派发')
    }
    // 先占据操作身份再做创建/续跑。进程中断后的pending不盲重放，防止副作用重复。
    index.operations.push({ operationId, fingerprint, result: { state: 'pending' } })
    this.store.write(index)
    try {
      const value = await execute()
      const latest = this.store.read(), record = latest.operations.find(item => item.operationId === operationId)!
      record.result = { state: 'completed', value }
      this.store.write(latest)
      return value
    } catch (error) {
      try {
        const latest = this.store.read(), record = latest.operations.find(item => item.operationId === operationId)!
        record.result = { state: 'uncertain', error: `委派操作未确认：${error instanceof Error ? error.message : String(error)}；请查询状态，不重复派发` }
        this.store.write(latest)
      } catch (persistError) { this.failure = persistError }
      throw error
    }
  }
  async delegate(ctx: DelegationContext, input: DelegateInput): Promise<Record<string, unknown>> {
    this.parent(ctx, true)
    const { operationId, ...fields } = input
    return this.once(ctx, 'delegate', operationId, fields, async () => {
      const record = this.start(ctx, fields)
      return { delegation: this.view(record), effectivePermissionMode: record.permissionMode, effectiveModelId: record.modelId, effectivePresetReference: record.presetReference }
    })
  }
  async delegateBatch(ctx: DelegationContext, input: DelegateBatchInput): Promise<Record<string, unknown>> {
    this.parent(ctx, true)
    const { operationId, ...fields } = input
    return this.once(ctx, 'batch', operationId, fields, () => this.createBatch(ctx, fields))
  }
  private async createBatch(ctx: DelegationContext, input: DelegateBatchInput): Promise<Record<string, unknown>> {
    this.parent(ctx, true)
    if (!Array.isArray(input.items) || !input.items.length || input.items.length > MAX_RUNNING_DELEGATIONS_PER_PARENT) throw new Error('批量委派数量无效')
    if (this.records().filter(r => r.parentSessionId === ctx.sessionId && r.status === 'running').length + input.items.length > MAX_RUNNING_DELEGATIONS_PER_PARENT) throw new Error('父会话运行中委派超过上限')
    const created: CoreDelegationRecord[] = [], failures: Array<{ index: number; error: string }> = []
    input.items.forEach((item, index) => {
      try { created.push(this.start(ctx, { ...item, task: buildDelegationTaskWithSharedContext({ sharedContext: input.sharedContext, task: item.task }) })) }
      catch (error) { failures.push({ index, error: String(error) }) }
    })
    return { delegations: created.map(r => this.view(r)), failures }
  }
  private start(ctx: DelegationContext, input: DelegateInput): CoreDelegationRecord {
    const parent = this.assertWrite(ctx, 'delegate_agent'), runtime = this.runtime!
    this.parent(ctx, true)
    if (typeof input.task !== 'string' || !input.task.trim()) throw new Error('任务不能为空')
    if (input.role && !['explore', 'research', 'implement', 'review', 'custom'].includes(input.role)) throw new Error('委派角色无效')
    if (this.records().filter(r => r.parentSessionId === parent.id && r.status === 'running').length >= MAX_RUNNING_DELEGATIONS_PER_PARENT) throw new Error('运行中委派超过上限')
    const arrangement = resolveDelegationArrangement(input), { source, selected } = this.resources(parent, input.presetReference, 'create')
    const channelId = selected.preset.channelId?.trim() || parent.channelId
    const channel = runtime.listChannelConfigs().find(c => c.id === channelId)
    const agentRuntime = parent.agentRuntime ?? 'claude'
    if (!channel || channel.enabled === false || channel.agentRuntimes && !channel.agentRuntimes.includes(agentRuntime)) throw new Error('目标Core渠道或runtime不可用')
    const modelId = input.modelId ?? selected.preset.modelId ?? parent.modelId
    if (!modelId || !channel.models?.some(m => m.id === modelId && m.enabled)) throw new Error('委派模型不在所属Core的可用目录')
    const permissionMode = resolveDelegationPermissionMode(runtime.permissions.getMode(parent.id), selected.preset.permissionMode, agentRuntime)
    if (!source.policy.sessionCanUseSubagents) throw new Error('父级预设已禁用委派能力')
    const id = randomUUID(), now = Date.now(), task = input.task.trim(), title = (input.title?.trim() || `协作：${task}`).slice(0, 80)
    const child = runtime.sessions.create({ title, runtime: agentRuntime, workspaceId: parent.workspaceId, channelId, modelId, permissionMode, presetId: selected.preset.id, presetReference: selected.reference })
    // 继承父级能力上限，目标预设只可进一步收窄。
    runtime.sessions.updateMeta(child.id, {
      parentSessionId: arrangement.relation === 'subtask' ? parent.id : undefined, sourceSessionId: parent.id,
      sourceRunId: ctx.sourceRunId, sourceDelegationId: id, delegationRelation: arrangement.relation, delegationPlacement: arrangement.placement,
      rootSessionId: parent.rootSessionId ?? parent.id, sourceAutomationId: parent.sourceAutomationId,
      delegationRole: input.role ?? 'custom', delegationStatus: 'running', delegationDepth: (parent.delegationDepth ?? 0) + 1, delegationGoal: task.slice(0, 1000),
    })
    const record: CoreDelegationRecord = {
      schemaVersion: 1, delegationId: id, triggerId: `delegation:${id}`, sourceRunId: ctx.sourceRunId, parentSessionId: parent.id,
      ...arrangement, childSessionId: child.id, workspaceId: parent.workspaceId!, channelId: channel.id, modelId, title, role: input.role ?? 'custom',
      goal: task.slice(0, 1000), permissionMode, presetReference: selected.reference, status: 'running', startedAt: now, updatedAt: now,
      rootSessionId: parent.rootSessionId ?? parent.id, blockedEvents: [], parentPolicy: source.policy,
    }
    const index = this.store.read(); index.records.push(record)
    try { this.store.write(index) } catch (error) { this.failure = error; runtime.sessions.updateMeta(child.id, { delegationStatus: 'failed' }); throw error }
    this.publishSession(record)
    try { this.run(record, buildDelegationPrompt({ parentSessionId: parent.id, delegationId: id, role: record.role, task, expectedOutput: input.expectedOutput, relation: record.relation })) }
    catch (error) { this.finish(record, 'failed', String(error), undefined, undefined, false); throw error }
    return record
  }
  private run(record: CoreDelegationRecord, prompt: string): void {
    const runtime = this.runtime!, session = runtime.sessions.getMeta(record.childSessionId)
    if (!session) throw new Error('委派子会话不存在')
    const facts = buildDelegationDispatchFacts({ sessionId: record.parentSessionId, sourceRunId: record.sourceRunId, delegationId: record.delegationId, triggerId: record.triggerId })
    const context = createAgentRunContext({ ...facts, sessionId: session.id, initiator: 'delegation' }, randomUUID)
    const handle = runtime.coordinator.run({ ...runtime.createQuery(session, prompt, { context }), runId: randomUUID(), initiator: 'delegation', taskId: record.delegationId, context })
    const done = handle.promise.then(outcome => {
      const current = this.get(record.parentSessionId, record.delegationId), run = this.ledger.findByTrigger(record.triggerId)
      const status = outcome.status === 'completed' ? 'completed' : outcome.status === 'failed' ? 'failed' : current.cancelRequested ? 'cancelled' : 'interrupted'
      this.finish(current, status, outcome.status === 'failed' ? outcome.error : undefined, this.summary(session.id, run?.id), run?.id)
    }).catch(error => {
      // 账本结算失败不是provider失败；封锁后续派发并保留原持久事实供重启对账。
      this.failure = error
      console.error('[Core Delegation] 运行结算失败，已暂停派发：', error)
    }).finally(() => { this.active.delete(record.delegationId) })
    this.active.set(record.delegationId, { handle, done })
  }
  private summary(sessionId: string, runId?: string): string {
    const messages = this.runtime!.sessions.readMessages(sessionId)
    const text: string[] = []
    for (const message of messages) {
      const candidate = message as SDKMessage & { _provenance?: { runId?: string }; message?: { content?: unknown } }
      if (candidate.type !== 'assistant' || runId && candidate._provenance?.runId !== runId) continue
      const content = candidate.message?.content
      if (Array.isArray(content)) for (const block of content) if (block?.type === 'text' && typeof block.text === 'string') text.push(block.text)
    }
    return text.join('\n\n').slice(-12000) || '本轮已结束，没有可摘要的assistant文本。'
  }
  private finish(record: CoreDelegationRecord, status: CoreDelegationRecord['status'], error?: string, summary?: string, runId?: string, wake = true): void {
    const current = this.get(record.parentSessionId, record.delegationId)
    if (current.status !== 'running') return
    const settled = this.mutate(current.delegationId, r => {
      r.status = status; r.completedAt = Date.now(); r.error = error; r.resultSummary = summary
      for (const b of r.blockedEvents) if (!b.resolvedAt) { b.resolvedAt = Date.now(); b.escalatedAt = Date.now() }
    })
    this.runtime?.sessions.updateMeta(settled.childSessionId, { delegationStatus: status, delegationResult: { summary: summary ?? error ?? '本轮已结束', executionRunId: runId, updatedAt: settled.updatedAt } })
    this.active.delete(settled.delegationId); this.blocked.clearDelegation(settled.delegationId); this.publishSession(settled)
    if (wake && settled.relation === 'subtask' && status !== 'cancelled') this.nudgeParent(settled.parentSessionId)
  }
  private publishSession(record: CoreDelegationRecord): void {
    if (!this.runtime || this.runtime.deletions.isDeleting(record.childSessionId) || this.runtime.deletions.isDeleting(record.parentSessionId)) return
    this.runtime.publish({ type: 'runtime', sessionId: record.parentSessionId, payload: { kind: 'profer_event', event: { type: 'delegation_session_updated', session: this.runtime.sessions.getMeta(record.childSessionId) } } })
  }
  private view(record: CoreDelegationRecord): Record<string, unknown> {
    const { parentPolicy: _policy, blockedEvents, ...fields } = record
    return { ...fields, taskId: record.delegationId, sourceSessionId: record.parentSessionId,
      projection: record.placement === 'current' ? { sessionId: record.parentSessionId, executionSessionId: record.childSessionId, taskId: record.delegationId } : undefined,
      pendingBlockedEvents: blockedEvents.filter(b => !b.resolvedAt) }
  }
  list(ctx: DelegationContext, input: { includeCompleted?: boolean }): Record<string, unknown> {
    this.parent(ctx)
    return { delegations: this.records().filter(r => r.parentSessionId === ctx.sessionId && (input.includeCompleted !== false || r.status === 'running')).map(r => this.view(r)) }
  }
  getResults(ctx: DelegationContext, ids: string[]): Record<string, unknown> {
    this.parent(ctx); this.validateIds(ids)
    const records = ids.map(id => this.get(ctx.sessionId, id))
    for (const r of records) if (r.status !== 'running') this.mutate(r.delegationId, item => { item.resultConsumedAt ??= Date.now() })
    return { delegations: records.map(r => this.view(r)) }
  }
  async wait(ctx: DelegationContext, input: DelegationWaitInput): Promise<Record<string, unknown>> {
    this.parent(ctx)
    const ids = input.delegationIds ?? this.records().filter(r => r.parentSessionId === ctx.sessionId && r.status === 'running').map(r => r.delegationId)
    if (ids.length) this.validateIds(ids)
    const timeout = input.timeoutSeconds ?? DEFAULT_WAIT_SECONDS
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > MAX_WAIT_SECONDS) throw new Error('等待时限无效')
    const records = ids.map(id => this.get(ctx.sessionId, id))
    if (input.mode !== undefined && !['all', 'any'].includes(input.mode)) throw new Error('等待模式无效')
    if (input.minCompleted !== undefined && (!Number.isInteger(input.minCompleted) || input.minCompleted < 1 || input.minCompleted > 50)) throw new Error('等待完成数量无效')
    const target = input.mode === 'any' ? Math.max(1, Math.min(input.minCompleted ?? 1, records.length)) : records.length
    const complete = () => ids.filter(id => this.get(ctx.sessionId, id).status !== 'running').length >= target
    if (complete()) return { status: 'completed', delegations: records.map(r => this.view(r)) }
    let resolveDone!: () => void
    const completed = new Promise<void>(resolve => { resolveDone = resolve })
    const check = () => { if (complete()) resolveDone() }
    for (const r of records) this.active.get(r.delegationId)?.done.then(check)
    check()
    const outcome = await waitForDelegationProgress({ registry: this.blocked, delegationIds: ids, completed, isCompleted: complete,
      timeoutMs: timeout * 1000, signal: ctx.signal, initialBlocked: records.flatMap(r => r.blockedEvents.filter(b => !b.resolvedAt)) })
    const fresh = ids.map(id => this.get(ctx.sessionId, id))
    for (const r of fresh) if (r.status !== 'running') this.mutate(r.delegationId, item => { item.resultConsumedAt ??= Date.now() })
    return { status: outcome.status, blockedEvent: outcome.status === 'blocked' ? outcome.event : undefined, delegations: fresh.map(r => this.view(r)) }
  }
  private validateIds(ids: string[]): void { if (!Array.isArray(ids) || !ids.length || ids.length > 50 || ids.some(id => typeof id !== 'string' || !id)) throw new Error('委派ID列表无效') }
  async stop(ctx: DelegationContext, id: string): Promise<Record<string, unknown>> {
    this.assertWrite(ctx, 'stop_delegation')
    const record = this.get(ctx.sessionId, id)
    if (record.status !== 'running') return { stopped: false, delegation: this.view(record) }
    this.mutate(id, r => { r.cancelRequested = 'delegation_cancel' })
    await this.runtime!.coordinator.stopAndWait(record.childSessionId, 'delegation_cancel')
    await this.active.get(id)?.done
    return { stopped: true, delegation: this.view(this.get(ctx.sessionId, id)) }
  }
  async stopMany(ctx: DelegationContext, ids?: string[]): Promise<Record<string, unknown>> {
    this.assertWrite(ctx, 'stop_delegations')
    const targets = ids ?? this.records().filter(r => r.parentSessionId === ctx.sessionId && r.status === 'running').map(r => r.delegationId)
    if (targets.length) this.validateIds(targets)
    targets.forEach(id => this.get(ctx.sessionId, id))
    const results = await Promise.all(targets.map(id => this.stop(ctx, id)))
    return { stopped: results.filter(r => r.stopped).length, delegations: targets.map(id => this.view(this.get(ctx.sessionId, id))) }
  }
  async stopParent(parentId: string): Promise<number> {
    const records = this.records().filter(r => r.parentSessionId === parentId && r.relation === 'subtask' && r.status === 'running')
    if (!this.runtime!.sessions.getMeta(parentId)) throw new Error('父会话不存在')
    // 先设置父停止事实，子任务终态不能再次唤醒父任务。
    this.runtime!.sessions.updateMeta(parentId, { stoppedByUser: true })
    for (const record of records) this.mutate(record.delegationId, r => { r.cancelRequested = 'parent_cancel' })
    await Promise.all(records.map(async r => { await this.runtime!.coordinator.stopAndWait(r.childSessionId, 'parent_cancel'); await this.active.get(r.delegationId)?.done }))
    return records.length
  }
  async answer(ctx: DelegationContext, input: DelegationAnswerInput): Promise<Record<string, unknown>> {
    this.assertWrite(ctx, 'answer_delegation_question')
    const record = this.records().find(r => r.parentSessionId === ctx.sessionId && r.blockedEvents.some(b => b.id === input.blockedEventId))
    if (!record || record.status !== 'running') throw new Error('阻塞不存在或不属于当前父会话')
    const blocked = record.blockedEvents.find(b => b.id === input.blockedEventId)!
    if (blocked.resolvedAt) throw new Error('阻塞已解决')
    const runtime = this.runtime!
    const answered = blocked.kind === 'permission'
      ? runtime.respondToPermission(record.childSessionId, blocked.requestId, input.permissionBehavior ?? 'deny', false, blocked.runId)
      : !!await runtime.askUser.respondToAskUser(blocked.requestId, input.answers ?? {}, { sessionId: record.childSessionId, runId: blocked.runId })
    if (answered) {
      this.mutate(record.delegationId, r => { const b = r.blockedEvents.find(b => b.id === blocked.id)!; b.resolvedAt = Date.now(); b.resolution = 'answered_by_parent' })
      this.blocked.resolve(blocked.id, 'answered_by_parent')
      runtime.publish({ type: 'runtime', sessionId: record.childSessionId, payload: { kind: 'profer_event', event: { type: blocked.kind === 'permission' ? 'permission_resolved' : 'ask_user_resolved', requestId: blocked.requestId } } })
    }
    return { answered }
  }
  async continue(ctx: DelegationContext, input: { operationId?: string; delegationId: string; message: string }): Promise<Record<string, unknown>> {
    this.parent(ctx)
    const { operationId, ...fields } = input
    return this.once(ctx, 'continue', operationId, fields, () => this.continueTurn(ctx, fields))
  }
  private async continueTurn(ctx: DelegationContext, input: { delegationId: string; message: string }): Promise<Record<string, unknown>> {
    const parent = this.assertWrite(ctx, 'continue_delegation'), previous = this.get(parent.id, input.delegationId)
    if (previous.status === 'running') throw new Error('委派正在运行')
    if (typeof input.message !== 'string' || !input.message.trim()) throw new Error('追加指令不能为空')
    const child = this.runtime!.sessions.getMeta(previous.childSessionId)
    if (!child || child.workspaceId !== parent.workspaceId) throw new Error('原委派子会话不存在或工作区不符')
    const { selected, source } = this.resources(parent, previous.presetReference, 'continue')
    const channel = this.runtime!.listChannelConfigs().find(c => c.id === previous.channelId)
    if (!channel || channel.enabled === false || !channel.models?.some(m => m.id === previous.modelId && m.enabled)) throw new Error('委派原渠道或模型已不可用')
    if (this.runtime!.coordinator.ownership.getOwner(child.id)) throw new Error('原子会话仍有运行占用，不能续跑')
    if (child.agentRuntime !== parent.agentRuntime) throw new Error('子会话runtime与父级已不匹配')
    if (channel.agentRuntimes && !channel.agentRuntimes.includes(child.agentRuntime ?? 'claude')) throw new Error('原渠道已禁用当前runtime')
    const mode = resolveEffectivePermissionMode(selected.preset.permissionMode, this.runtime!.permissions.getMode(parent.id))
    this.runtime!.sessions.updateMeta(child.id, { permissionMode: mode, permissionModeSource: 'preset', delegationStatus: 'running' })
    const record = this.mutate(previous.delegationId, r => {
      r.status = 'running'; r.triggerId = `delegation:${r.delegationId}:${randomUUID()}`; r.permissionMode = mode; r.sourceRunId = ctx.sourceRunId
      r.startedAt = Date.now(); r.parentPolicy = source.policy; r.completedAt = undefined; r.error = undefined; r.resultSummary = undefined; r.cancelRequested = undefined; r.resultConsumedAt = undefined; r.blockedEvents = []
    })
    this.run(record, input.message)
    return { delegation: this.view(record) }
  }
  private observe(event: CoreEvent): void {
    if (this.closed) return
    const payload = event.payload as { type?: string; event?: { type?: string; request?: PermissionRequest | AskUserRequest; requestId?: string } }
    const record = this.records().find(r => r.childSessionId === event.sessionId && r.status === 'running')
    const inner = payload?.event
    if (record && inner?.request && ['permission_request', 'ask_user_request'].includes(inner.type ?? '')) {
      const request = inner.request
      if (!request.runId) return
      const ask = inner.type === 'ask_user_request' ? request as AskUserRequest : undefined
      const blocked = this.blocked.register({ delegationId: record.delegationId, childSessionId: record.childSessionId,
        kind: ask ? 'ask_user' : 'permission', requestId: request.requestId, toolName: ask ? undefined : (request as PermissionRequest).toolName,
        questions: ask?.questions.map(q => ({ question: q.question, header: q.header, options: q.options.map(o => ({ label: o.label, description: o.description })) })) })
      this.mutate(record.delegationId, r => { if (!r.blockedEvents.some(b => b.id === blocked.id)) r.blockedEvents.push({ ...blocked, runId: request.runId! }) })
      this.runtime!.publish({ type: 'runtime', sessionId: record.parentSessionId, payload: { kind: 'profer_event', event: { type: 'delegation_blocked', delegationId: record.delegationId, blockedEvent: blocked } } })
      this.nudgeParent(record.parentSessionId)
    }
    if (record && inner?.requestId && ['permission_resolved', 'ask_user_resolved'].includes(inner.type ?? '')) {
      const id = inner.requestId
      this.blocked.resolveByRequestId(id, 'answered_by_user')
      this.mutate(record.delegationId, r => { for (const b of r.blockedEvents) if (b.requestId === id && !b.resolvedAt) { b.resolvedAt = Date.now(); b.resolution = 'answered_by_user' } })
    }
    if (payload?.type === 'runtime_finished') {
      const outcome = (event.payload as { outcome?: { status?: string } }).outcome
      if (outcome?.status === 'stopped' && this.runtime!.sessions.getMeta(event.sessionId) && !this.runtime!.deletions.isDeleting(event.sessionId)) {
        void this.stopParent(event.sessionId).catch(error => { this.failure = error; console.error('[Core Delegation] 停止级联失败：', error) })
        return
      }
    }
    if (payload?.type === 'runtime_idle' || payload?.type === 'runtime_finished' || inner?.type === 'run_idle') this.nudgeParent(event.sessionId)
  }
  private nudgeParent(parentId: string): void {
    if (this.closed || this.failure || this.waking.has(parentId)) return
    queueMicrotask(() => { void this.wakeParent(parentId).catch(error => { this.failure = error; console.error('[Core Delegation] 父会话恢复失败：', error) }) })
  }
  private async wakeParent(parentId: string): Promise<void> {
    const runtime = this.runtime!, parent = runtime.sessions.getMeta(parentId)
    if (!parent || parent.stoppedByUser || !parent.channelId || runtime.coordinator.ownership.getOwner(parentId) || this.waking.has(parentId) || this.closed) return
    const records = this.records().filter(r => r.parentSessionId === parentId && r.relation === 'subtask')
    const pending = records.flatMap(r => r.blockedEvents.filter(b => !b.resolvedAt))
    const decision = decideDelegationBlockedWake(pending, { parentActive: false, parentHasChannel: true })
    const results = records.filter(r => r.status !== 'running' && r.status !== 'cancelled' && !r.resultConsumedAt)
    if (decision.action !== 'wake' && (records.some(r => r.status === 'running') || !results.length)) return
    const triggerId = `delegation-return:${parentId}:${decision.action === 'wake' ? decision.eventIds.sort().join(',') : results.map(r => r.triggerId).sort().join(',')}`
    const prompt = decision.action === 'wake' ? decision.prompt : `以下协作任务已结束，请核实结果后继续原任务。interrupted表示中断，并未完成，需要显式决定是否续跑。\n${results.map(r => `${r.title} [${r.status}] ${r.delegationId}\n${r.resultSummary ?? r.error ?? '无摘要'}`).join('\n\n')}`
    const index = this.store.read()
    if (index.operations.some(op => op.operationId === triggerId)) return
    index.operations.push({ operationId: triggerId, fingerprint: triggerId, result: { parentId, status: 'admitted' } })
    if (decision.action === 'wake') {
      for (const r of index.records) for (const b of r.blockedEvents) if (decision.eventIds.includes(b.id)) b.wokenAt = Date.now()
    } else {
      for (const r of index.records) if (results.some(item => item.delegationId === r.delegationId)) r.resultConsumedAt = Date.now()
    }
    this.store.write(index)
    this.waking.add(parentId)
    const context = createAgentRunContext({ sessionId: parentId, initiator: 'delegation', triggerId,
      taskOrigin: { actor: { type: 'system' }, source: { type: 'session', id: parentId } }, taskAuthorization: { kind: 'inherited', sourceRef: { type: 'session', id: parentId } }, messageAuthor: { type: 'system' } }, randomUUID)
    try {
      await runtime.coordinator.run({ ...runtime.createQuery(parent, prompt, { context }), initiator: 'delegation', context }).promise
    } finally {
      this.waking.delete(parentId)
      if (!this.closed) this.nudgeParent(parentId)
    }
  }
  private assertAvailable(): void { if (this.closed || this.failure) throw new Error(`Core Delegation不可用：${this.closed ? '服务关闭' : String(this.failure)}`) }
  dispose(): void { this.closed = true; this.unsubscribe?.() }
  async shutdown(): Promise<void> {
    this.dispose()
    await Promise.all([...this.active.values()].map(async active => { await active.handle.stop('core_shutdown'); await active.done }))
  }
}
