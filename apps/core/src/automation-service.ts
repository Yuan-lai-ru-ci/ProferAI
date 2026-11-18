import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createAutomationManager, type AutomationManager } from '@profer/agent-runtime/automation-manager'
import { buildAutomationDispatchMetadata, createAutomationTriggerId, validateBoundAutomationSession } from '@profer/agent-runtime/automation-dispatch'
import { automationDayKey } from '@profer/agent-runtime/automation-schedule'
import { createAgentRunContext, type AgentRunLedger, type AgentRun, type AgentRuntimeRunHandle } from '@profer/agent-runtime'
import { calculateContextUsageRatio, resolveContextWindowFromModelUsage, inferContextWindow, AUTOMATION_MAX_CONSECUTIVE_FAILURES, type Automation, type AutomationTriggerRecord, type CreateAutomationInput, type UpdateAutomationInput, type AgentSessionMeta } from '@profer/shared'
import type { CoreConfig } from './config'
import type { CoreAgentRuntime } from './runtime'
import { resolveCorePreset } from './preset-resources'
import { CoreAutomationStore } from './automation-store'
import { importDesktopAutomations } from './desktop-automation-import'
import { markAutomationMirrors, readAutomationMirror, writeAutomationMirror, type CoreAutomationIndex, type CoreAutomationMirrorState, type CoreAutomationNotification } from './automation-project-mirror'

export interface CoreAutomationNotificationPort {
  deliver(notification: Readonly<CoreAutomationNotification>): Promise<void>
}

/** Core单写者调度适配：共享manager管理事实，Coordinator独占执行；不委托桌面调度。 */
export class CoreAutomationService {
  readonly manager: AutomationManager
  private runtime?: CoreAgentRuntime
  private timer?: ReturnType<typeof setInterval>
  private stopped = false
  private failure?: unknown
  private readonly active = new Map<string, AgentRuntimeRunHandle>()
  private transaction?: CoreAutomationIndex
  private projecting = false
  private readonly deletingWorkspaces = new Set<string>()
  private notificationPort?: CoreAutomationNotificationPort
  private deliveringNotifications = false
  constructor(private readonly config: CoreConfig, private readonly ledger: AgentRunLedger, private readonly store = new CoreAutomationStore(join(config.configDir, 'core-automations.json')), private readonly now = Date.now) {
    importDesktopAutomations(config, store, now())
    this.manager = createAutomationManager({
      now, readIndex: () => this.transaction ?? store.read(), writeIndex: index => { if (this.transaction) { this.transaction = index; return }; this.commit(index) },
      validatePresetReference: (workspaceId, presetReference) => { this.resolvePreset({ workspaceId, presetId: presetReference.presetId, presetReference }) },
      presetReferenceForAutomation: (workspaceId, presetId) => this.resolvePreset({ workspaceId, presetId }).reference,
      assertValidBoundAutomation: automation => { this.validateRoute(automation); if (automation.boundSessionId) this.validateSession(automation, this.runtime?.sessions.getMeta(automation.boundSessionId)) },
    })
  }
  bindRuntime(runtime: CoreAgentRuntime): void {
    this.runtime = runtime
    // 重启后无法判断宿主是否已经发送，不能自动重试。
    const outboxIndex = this.store.read()
    let recoveredNotification = false
    for (const entry of outboxIndex.notificationOutbox ?? []) if (entry.status === 'sending') { entry.status = 'uncertain'; entry.error = 'Core重启，通知投递结果无法确认'; recoveredNotification = true }
    if (recoveredNotification) this.store.write(outboxIndex)
    // 启动先对账，再启动时钟；running绝不直接变回queued。
    for (const trigger of this.manager.listAutomationTriggers()) {
      if (!['queued', 'blocked', 'running'].includes(trigger.status)) continue
      const run = this.ledger.findByTrigger(trigger.triggerId)
      if (run && this.settle(trigger, run)) continue
      if (run || trigger.status === 'running' || trigger.runId) this.manager.transitionAutomationTriggerRecord(trigger.triggerId, 'interrupted', { error: 'Core重启时执行结果无法确认；不自动重放副作用' })
    }
    if (this.runtime.workspaces.list().some(workspace => workspace.storageMode === 'project') || this.store.read().projectMirrors?.length) this.commit(this.store.read())
    this.retryProjectMirrors()
    this.timer = setInterval(() => { try { this.tick() } catch (error) { this.failure ??= error; console.error('[Core Automation] 调度失败，已封锁后续派发：', error) } }, 1000)
    this.timer.unref?.()
  }
  /** 同一command与业务修改同盘提交；响应丢失后的重试不能再创建或手动派发。 */
  command(operationId: string, operation: string, input: Record<string, unknown>): unknown {
    this.assertAvailable()
    if (!operationId || operationId.length > 200) throw new Error('Automation命令必须有稳定operationId')
    const index = this.store.read(), fingerprint = JSON.stringify({ operation, input })
    const previous = index.operations?.find(item => item.id === operationId)
    if (previous) { if (previous.fingerprint !== fingerprint) throw new Error('Automation operationId不可复用于不同操作'); return structuredClone(previous.result) }
    this.transaction = index
    let result: unknown
    try {
      if (operation === 'create') result = this.create(input as unknown as CreateAutomationInput)
      else if (operation === 'update') result = this.update(input as unknown as UpdateAutomationInput)
      else if (operation === 'delete') result = this.delete(String(input.id ?? ''))
      else if (operation === 'run_now') {
        const task = this.manager.getAutomation(String(input.id ?? '')); if (!task) throw new Error('Automation不存在')
        result = this.enqueue(task, this.now(), `manual:${task.id}:${operationId}`, 'manual')
      } else throw new Error('不支持此Automation命令')
      this.transaction!.operations ??= []
      this.transaction!.operations.push({ id: operationId, fingerprint, result: structuredClone(result) })
      this.commit(this.transaction!)
    } finally { this.transaction = undefined }
    this.changed()
    if (operation === 'run_now') this.tick()
    return result
  }
  list(): Automation[] { return this.manager.listAutomations() }
  listTriggers(): AutomationTriggerRecord[] { return this.manager.listAutomationTriggers() }
  blockWorkspace(workspaceId: string): void { this.deletingWorkspaces.add(workspaceId) }
  removeWorkspaceSnapshot(workspaceId: string, automationIds: string[]): void {
    this.assertAvailable()
    this.deletingWorkspaces.add(workspaceId)
    const all = this.manager.listAutomations()
    if (all.some(item => automationIds.includes(item.id) && item.workspaceId !== workspaceId)) throw new Error('Automation已迁出原工作区，拒绝按旧快照删除')
    const current = all.filter(item => item.workspaceId === workspaceId).map(item => item.id).sort()
    if (current.some(id => !automationIds.includes(id))) throw new Error('Automation集合新增了事务范围外条目')
    const triggers = this.manager.listAutomationTriggers().filter(item => automationIds.includes(item.automationId))
    if (triggers.some(item => item.status === 'running' || item.status === 'interrupted' && item.runId)) throw new Error('Automation存在运行中或结果未确认的trigger')
    for (const id of automationIds) {
      const automation = this.manager.getAutomation(id)
      if (automation?.active) this.manager.updateAutomation({ id, active: false })
    }
    for (const id of automationIds) if (this.manager.getAutomation(id) && !this.manager.deleteAutomation(id)) throw new Error(`Automation删除失败: ${id}`)
    this.changed()
  }
  create(input: CreateAutomationInput): Automation {
    this.assertAvailable(); this.validateInput(input)
    if (input.workspaceId && this.deletingWorkspaces.has(input.workspaceId)) throw new Error('工作区正在删除，不能创建Automation')
    const result = this.manager.createAutomation(input); this.changed(); return result
  }
  update(input: UpdateAutomationInput): Automation {
    this.assertAvailable()
    const current = this.manager.getAutomation(input.id); if (!current) throw new Error('Automation不存在')
    if (current.workspaceId && this.deletingWorkspaces.has(current.workspaceId)) throw new Error('工作区正在删除，不能修改Automation')
    const defined = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as UpdateAutomationInput
    input = defined
    const next = { ...current, ...input }
    if (next.workspaceId && this.deletingWorkspaces.has(next.workspaceId)) throw new Error('目标工作区正在删除，不能迁入Automation')
    if (input.presetId !== undefined && input.presetReference === undefined) next.presetReference = undefined
    // 失效路径或渠道不能妨碍用户暂停；配置修复/启用仍须完整校验。
    const pauseOnly = input.active === false && Object.keys(input).every(key => key === 'id' || key === 'active')
    if (!pauseOnly) this.validateInput(next)
    const result = this.manager.updateAutomation(input)!; this.changed(); return result
  }
  delete(id: string): boolean {
    this.assertAvailable()
    if (this.manager.listAutomationTriggers('running').some(trigger => trigger.automationId === id)) throw new Error('Automation正在执行，请先暂停并等待结束再删除')
    const result = this.manager.deleteAutomation(id); this.changed(); return result
  }
  runNow(id: string): AutomationTriggerRecord {
    this.assertAvailable()
    const automation = this.manager.getAutomation(id); if (!automation) throw new Error('Automation不存在')
    const trigger = this.enqueue(automation, this.now(), `manual:${id}:${randomUUID()}`, 'manual')
    this.tick(); return this.manager.getAutomationTrigger(trigger.triggerId)!
  }
  tick(): void {
    this.assertAvailable()
    this.retryProjectMirrors()
    const now = this.now()
    for (const automation of this.manager.listAutomations()) {
      if (automation.workspaceId && this.deletingWorkspaces.has(automation.workspaceId)) continue
      const pending = this.manager.listAutomationTriggers().some(trigger => trigger.automationId === automation.id && ['queued', 'blocked', 'running', 'interrupted'].includes(trigger.status))
      if (automation.active && automation.nextRunAt <= now && !pending) this.enqueue(automation, automation.nextRunAt, createAutomationTriggerId(automation.id, automation.nextRunAt), 'scheduled')
    }
    for (const trigger of this.manager.listAutomationTriggers('queued')) {
      if (this.active.has(trigger.triggerId)) continue
      const automation = this.manager.getAutomation(trigger.automationId)
      if (!automation || (automation.workspaceId && this.deletingWorkspaces.has(automation.workspaceId)) || (!automation.active && trigger.kind !== 'manual')) continue
      if (this.manager.listAutomationTriggers('running').some(item => item.automationId === automation.id)) continue
      this.dispatch(automation, trigger)
    }
  }
  private enqueue(automation: Automation, at: number, id: string, kind: 'manual' | 'scheduled'): AutomationTriggerRecord {
    if (automation.workspaceId && this.deletingWorkspaces.has(automation.workspaceId)) throw new Error('工作区正在删除，不能派发Automation')
    const result = this.manager.enqueueAutomationTrigger({ triggerId: id, occurrenceId: id, automationId: automation.id, kind, scheduledAt: at, boundSessionId: automation.boundSessionId, status: 'queued', createdAt: this.now(), updatedAt: this.now() })
    this.changed(); return result
  }
  private dispatch(automation: Automation, trigger: AutomationTriggerRecord): void {
    const runtime = this.runtime!
    try {
      const previous = this.ledger.findByTrigger(trigger.triggerId)
      if (previous) {
        if (!this.settle(trigger, previous)) this.manager.transitionAutomationTriggerRecord(trigger.triggerId, 'interrupted', { runId: previous.id, error: '已存在未确认终态的共享Run，不重放' })
        this.changed(); return
      }
      this.validateRoute(automation)
      let session = this.selectSession(automation, trigger)
      if (session && (runtime.coordinator.isRunning(session.id) || runtime.coordinator.ownership.getOwner(session.id))) return
      if (!session) {
        const preset = this.resolvePreset(automation)
        session = runtime.sessions.create({ title: automation.name, workspaceId: automation.workspaceId, channelId: automation.channelId, modelId: automation.modelId, runtime: automation.agentRuntime ?? 'claude', presetId: preset.preset.id, presetReference: preset.reference, permissionMode: 'bypassPermissions' })
        runtime.sessions.updateMeta(session.id, { sourceAutomationId: automation.id })
      }
      this.validateSession(automation, session)
      // 已绑定的plan/auto会话不能为无人值守任务被静默提权。
      if (runtime.permissions.getMode(session.id) !== 'bypassPermissions') throw new Error('Automation执行会话未授权无人值守模式')
      const metadata = buildAutomationDispatchMetadata({ automation, triggerId: trigger.triggerId })
      const context = createAgentRunContext({ ...metadata, sessionId: session.id, initiator: 'automation' }, randomUUID, this.now)
      const base = runtime.createQuery(session, automation.prompt, { context })
      const runId = randomUUID()
      // 先持久化即将派发事实。崩溃窗口会成为interrupted而不是重复执行。
      this.manager.setLastSessionId(automation.id, session.id)
      this.manager.transitionAutomationTriggerRecord(trigger.triggerId, 'running', { targetSessionId: session.id, runId })
      this.changed()
      const handle = runtime.coordinator.run({ ...base, runId, initiator: 'automation', taskId: metadata.taskId, context })
      this.active.set(trigger.triggerId, handle)
      const timeout = setTimeout(() => { void handle.stop('automation_timeout').catch(error => console.error('[Core Automation] 超时停止失败：', error)) }, 2 * 60 * 60_000)
      timeout.unref?.()
      void handle.promise.then(() => {
        const run = this.ledger.findByTrigger(trigger.triggerId)
        if (!run || !this.settle(trigger, run)) this.manager.transitionAutomationTriggerRecord(trigger.triggerId, 'interrupted', { error: '执行结束但共享Run终态无法确认，不自动重放' })
        this.changed()
      }, error => {
        const run = this.ledger.findByTrigger(trigger.triggerId)
        if (!run || !this.settle(trigger, run)) this.manager.transitionAutomationTriggerRecord(trigger.triggerId, 'interrupted', { error: `执行未确认：${String(error)}` })
        this.changed()
      }).catch(error => { this.failure ??= error; console.error('[Core Automation] 结算失败，已封锁调度：', error) }).finally(() => { clearTimeout(timeout); this.active.delete(trigger.triggerId) })
    } catch (error) {
      if (this.failure) throw error
      const current = this.manager.getAutomationTrigger(trigger.triggerId)
      if (current && ['queued', 'running'].includes(current.status)) this.manager.transitionAutomationTriggerRecord(trigger.triggerId, current.status === 'running' ? 'interrupted' : 'blocked', { error: error instanceof Error ? error.message : String(error) })
      this.changed()
    }
  }
  private settle(trigger: AutomationTriggerRecord, run: AgentRun): boolean {
    if (!['completed', 'failed', 'stopped'].includes(run.status) || run.finishedAt === undefined) return false
    if (run.taskId !== `automation:${trigger.automationId}` || (trigger.runId && trigger.runId !== run.id)
      || (trigger.targetSessionId && trigger.targetSessionId !== run.sessionRef)) throw new Error('Automation Run归属不匹配')
    const current = this.manager.getAutomationTrigger(trigger.triggerId)
    if (!current || !['queued', 'blocked', 'running'].includes(current.status)) return true
    const runResult = { runAt: run.startedAt ?? run.createdAt, sessionId: run.sessionRef ?? '', status: run.status === 'completed' ? 'success' as const : 'error' as const, error: run.failureReason, runId: run.id, durationMs: run.finishedAt - (run.startedAt ?? run.createdAt), triggerId: trigger.triggerId }
    const index = this.store.read()
    this.transaction = index
    try {
      this.manager.settleAutomationTrigger(trigger.triggerId, runResult)
      const automation = this.manager.getAutomation(trigger.automationId)
      if (automation?.active && (automation.consecutiveFailures ?? 0) >= AUTOMATION_MAX_CONSECUTIVE_FAILURES) this.manager.updateAutomation({ id: automation.id, active: false })
      if (automation) for (const [position, target] of (automation.notificationTargets ?? []).entries()) {
        if (!target.enabled || (target.trigger !== 'always' && target.trigger !== runResult.status)) continue
        const id = `${trigger.triggerId}:${position}`
        this.transaction!.notificationOutbox ??= []
        if (!this.transaction!.notificationOutbox.some(item => item.id === id)) this.transaction!.notificationOutbox.push({ id, automation: structuredClone(automation), run: runResult, target: structuredClone(target), status: 'pending' })
      }
      this.commit(this.transaction!)
    } finally { this.transaction = undefined }
    this.startNotificationDelivery()
    return true
  }
  private selectSession(automation: Automation, trigger: AutomationTriggerRecord): AgentSessionMeta | undefined {
    const runtime = this.runtime!
    if (automation.boundSessionId) {
      const session = runtime.sessions.getMeta(automation.boundSessionId); this.validateSession(automation, session); return session
    }
    const id = trigger.targetSessionId ?? automation.lastSessionId
    const session = id ? runtime.sessions.getMeta(id) : undefined
    if (!session || session.automationGraduated) return undefined
    if (session.workspaceId !== automation.workspaceId || (session.agentRuntime ?? 'claude') !== (automation.agentRuntime ?? 'claude') || session.channelId !== automation.channelId || (automation.modelId && session.modelId !== automation.modelId)) return undefined
    if ((automation.sessionMode ?? 'daily') === 'daily') {
      if (!automation.lastRunAt || automationDayKey(automation.lastRunAt, automation.timeZone) !== automationDayKey(this.now(), automation.timeZone)) return undefined
      const ratio = this.contextRatio(session.id)
      if (typeof ratio === 'number' && ratio >= 0.7) return undefined
    }
    return session
  }
  private contextRatio(sessionId: string): number | undefined {
    const messages = this.runtime!.sessions.readMessages(sessionId)
    for (const message of [...messages].reverse()) {
      if (message.type === 'result') {
        const result = message as import('@profer/shared').SDKResultMessage
        if (result.usage) return calculateContextUsageRatio(result.usage.input_tokens + (result.usage.cache_read_input_tokens ?? 0) + (result.usage.cache_creation_input_tokens ?? 0), resolveContextWindowFromModelUsage(result.modelUsage, result._channelModelId))
      }
      if (message.type === 'assistant') {
        const assistant = message as import('@profer/shared').SDKAssistantMessage
        const usage = assistant.message?.usage
        if (usage) return calculateContextUsageRatio(usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0), inferContextWindow(assistant.message.model))
      }
    }
    return undefined
  }
  private resolvePreset(automation: Pick<Automation, 'workspaceId' | 'presetId'> & Partial<Pick<Automation, 'presetReference'>>) {
    const workspace = this.runtime?.workspaces.list().find(item => item.id === automation.workspaceId)
    return resolveCorePreset(this.config, { workspaceId: automation.workspaceId, presetId: automation.presetId, presetReference: automation.presetReference, permissionMode: 'bypassPermissions' } as AgentSessionMeta, workspace)
  }
  private validateRoute(automation: Pick<Automation, 'workspaceId' | 'channelId' | 'agentRuntime' | 'modelId' | 'presetId'>): void {
    const runtime = this.runtime
    if (!runtime) throw new Error('Core Automation尚未装配')
    const workspace = runtime.workspaces.list().find(item => item.id === automation.workspaceId)
    if (!workspace || (workspace.storageMode === 'project' && (!workspace.rootPath || !existsSync(workspace.rootPath)))) throw new Error('Automation所属工作区不存在或路径不可用')
    const channel = runtime.listChannelConfigs().find(item => item.id === automation.channelId)
    if (!channel || channel.enabled === false || (channel.agentRuntimes && !channel.agentRuntimes.includes(automation.agentRuntime ?? 'claude'))) throw new Error('Automation渠道不可用或runtime被禁用')
    if (channel.models && automation.modelId && !channel.models.some(model => model.id === automation.modelId && model.enabled)) throw new Error('Automation模型不可用')
    this.resolvePreset(automation)
  }
  private validateSession(automation: Pick<Automation, 'workspaceId' | 'channelId' | 'agentRuntime' | 'modelId' | 'presetId'>, session?: AgentSessionMeta): void {
    const preset = this.resolvePreset(automation)
    const result = validateBoundAutomationSession(automation, session, preset.preset.id)
    if (!result.valid) throw new Error(result.reason)
    if (automation.modelId && session?.modelId !== automation.modelId) throw new Error('Automation模型与会话不匹配')
  }
  private validateInput(input: CreateAutomationInput): void {
    if (typeof input.name !== 'string' || !input.name.trim() || typeof input.prompt !== 'string' || !input.prompt.trim()) throw new Error('Automation名称和任务内容不能为空')
    if (input.active !== undefined && typeof input.active !== 'boolean') throw new Error('Automation active必须是boolean')
    if (input.agentRuntime !== undefined && !['pi', 'claude'].includes(input.agentRuntime)) throw new Error('Automation runtime无效')
    if (input.permissionMode !== undefined && input.permissionMode !== 'bypassPermissions') throw new Error('Automation权限模式无效')
    if (input.sessionMode !== undefined && !['daily', 'reuse'].includes(input.sessionMode)) throw new Error('Automation会话模式无效')
    // 通知宿主未装配时保留目标，投递状态由outbox如实记录。
    if (input.maxRuns !== undefined && (!Number.isInteger(input.maxRuns) || input.maxRuns < 0)) throw new Error('Automation运行上限无效')
    for (const field of ['channelId', 'workspaceId', 'modelId', 'presetId', 'boundSessionId', 'sourceSessionId', 'timeZone'] as const) if (input[field] !== undefined && typeof input[field] !== 'string') throw new Error(`Automation ${field}必须是字符串`)
    if (input.timeZone !== undefined && !input.timeZone.trim()) throw new Error('Automation时区不能为空')
    if (input.timeOfDay !== undefined) {
      const times = Array.isArray(input.timeOfDay) ? input.timeOfDay : [input.timeOfDay]
      if ((['daily', 'weekly', 'monthly'].includes(input.scheduleType) && !times.length) || times.length > 10 || times.some(time => typeof time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time))) throw new Error('Automation时间必须是HH:MM')
    }
    for (const [value, max, min] of [[input.dayOfWeek, 6, 0], [input.dayOfMonth, 31, 1]] as const) {
      if (value === undefined) continue
      const days = Array.isArray(value) ? value : [value]
      if (days.length > 31 || days.some(day => !Number.isInteger(day) || day < min || day > max)) throw new Error('Automation调度日期无效')
    }
    if (!['interval', 'daily', 'weekly', 'monthly', 'once'].includes(input.scheduleType)) throw new Error('Automation调度类型无效')
    if (input.scheduleType === 'interval' && (!Number.isFinite(input.intervalMinutes) || input.intervalMinutes < 1)) throw new Error('Automation间隔无效')
    if (input.scheduleType === 'once' && (!input.scheduledAt || !Number.isFinite(input.scheduledAt) || input.scheduledAt < 1)) throw new Error('Automation一次性触发时间无效')
    if (input.timeZone) new Intl.DateTimeFormat('en', { timeZone: input.timeZone }).format()
    this.validateRoute(input)
    if (input.boundSessionId) this.validateSession(input, this.runtime?.sessions.getMeta(input.boundSessionId))
  }
  private commit(index: CoreAutomationIndex): void {
    const next = this.runtime ? markAutomationMirrors(index, this.runtime.workspaces.list()) : index
    try { this.store.write(next) } catch (error) { this.failure = error; throw error }
  }
  projectMirrorStatuses(): CoreAutomationMirrorState[] { return structuredClone(this.store.read().projectMirrors ?? []) }
  /** 工作区绑定或重定位后由宿主调用。 */
  workspaceBindingsChanged(): void { this.assertAvailable(); this.commit(this.store.read()); this.changed() }
  /** 只合并较新副本；同时间不同内容和跨工作区ID冲突必须由调用方处理。 */
  restoreProjectMirror(workspaceId: string, expectedHash: string): void {
    this.assertAvailable()
    const workspace = this.runtime?.workspaces.list().find(item => item.id === workspaceId)
    if (!workspace) throw new Error('工作区不存在')
    const mirror = readAutomationMirror(workspace)
    if (mirror.hash !== expectedHash) throw new Error('项目Automation镜像已变化，请重新检查')
    const index = this.store.read()
    for (const task of mirror.automations) {
      const normalized = { ...task, workspaceId, active: false, dispatchBlockReason: '项目副本已恢复，请核对后显式启用' }
      if (workspace.slug && normalized.presetReference?.presetScope === 'workspace') normalized.presetReference = { ...normalized.presetReference, workspaceSlug: workspace.slug }
      const current = index.automations.find(item => item.id === task.id)
      if (current && current.workspaceId !== workspaceId) throw new Error('项目Automation ID属于其他工作区')
      if (current && task.updatedAt === current.updatedAt && JSON.stringify(task) !== JSON.stringify(current)) throw new Error('项目Automation同版本冲突')
      if (!current) index.automations.push(normalized)
      else if (task.updatedAt > current.updatedAt) Object.assign(current, normalized)
    }
    for (const record of mirror.triggers) {
      const current = index.triggers!.find(item => item.triggerId === record.triggerId)
      if (current && current.automationId !== record.automationId) throw new Error('项目Automation触发ID冲突')
      if (current && record.updatedAt === current.updatedAt && JSON.stringify(record) !== JSON.stringify(current)) throw new Error('项目Automation触发记录同版本冲突')
      const safe = ['queued', 'blocked', 'running'].includes(record.status) ? { ...record, status: 'interrupted' as const, error: '从项目副本恢复，旧执行结果未确认' } : record
      if (!current) index.triggers!.push(safe)
      else if (record.updatedAt > current.updatedAt) Object.assign(current, safe)
    }
    const state = (index.projectMirrors ??= []).find(item => item.workspaceId === workspaceId)
    if (state) Object.assign(state, { rootPath: workspace.rootPath, lastHash: mirror.hash, pending: true, error: undefined })
    else index.projectMirrors.push({ workspaceId, rootPath: workspace.rootPath!, lastHash: mirror.hash, pending: true, knownAutomationIds: [] })
    this.commit(index); this.changed()
  }
  /** 用户明确选择中央账本覆盖时，必须提供当前项目副本哈希。 */
  resolveProjectMirrorWithCore(workspaceId: string, expectedHash: string): void {
    this.assertAvailable()
    const workspace = this.runtime?.workspaces.list().find(item => item.id === workspaceId)
    if (!workspace) throw new Error('工作区不存在')
    const mirror = readAutomationMirror(workspace)
    if (mirror.hash !== expectedHash) throw new Error('项目Automation镜像已变化，请重新检查')
    const index = this.store.read()
    const state = (index.projectMirrors ??= []).find(item => item.workspaceId === workspaceId)
    if (state) Object.assign(state, { rootPath: workspace.rootPath, lastHash: mirror.hash, pending: true, error: undefined })
    else index.projectMirrors.push({ workspaceId, rootPath: workspace.rootPath!, lastHash: mirror.hash, pending: true, knownAutomationIds: [] })
    this.store.write(index); this.changed()
  }
  inspectProjectMirror(workspaceId: string) {
    const workspace = this.runtime?.workspaces.list().find(item => item.id === workspaceId)
    if (!workspace) throw new Error('工作区不存在')
    return readAutomationMirror(workspace)
  }
  private startNotificationDelivery(): void { void this.deliverNotifications().catch(error => console.error('[Core Automation] 通知队列投递失败：', error)) }
  setNotificationPort(port?: CoreAutomationNotificationPort): void { this.notificationPort = port; if (port) this.startNotificationDelivery() }
  notificationOutbox(): CoreAutomationNotification[] { return structuredClone(this.store.read().notificationOutbox ?? []) }
  retryUncertainNotification(id: string): void {
    this.assertAvailable()
    const index = this.store.read(), item = index.notificationOutbox?.find(entry => entry.id === id)
    if (!item || item.status !== 'uncertain') throw new Error('通知不存在或状态不是待确认')
    item.status = 'pending'; item.error = undefined
    this.store.write(index)
    this.startNotificationDelivery()
  }
  async deliverNotifications(): Promise<void> {
    if (!this.notificationPort || this.deliveringNotifications || this.stopped) return
    this.deliveringNotifications = true
    try {
      for (const item of this.notificationOutbox().filter(entry => entry.status === 'pending')) {
        const index = this.store.read(), current = index.notificationOutbox?.find(entry => entry.id === item.id)
        if (!current || current.status !== 'pending' || !this.notificationPort) continue
        current.status = 'sending'; this.store.write(index)
        let error: unknown
        try { await this.notificationPort.deliver(structuredClone(current)) } catch (cause) { error = cause }
        const latest = this.store.read(), saved = latest.notificationOutbox?.find(entry => entry.id === item.id)
        if (!saved || saved.status !== 'sending') continue
        saved.status = error ? 'uncertain' : 'delivered'
        saved.error = error ? String(error) : undefined
        this.store.write(latest)
      }
    } finally { this.deliveringNotifications = false }
  }
  retryProjectMirrors(): void {
    if (!this.runtime || this.transaction || this.projecting || this.stopped) return
    this.projecting = true
    try {
      const index = this.store.read()
      const workspaces = this.runtime.workspaces.list()
      let changed = false
      for (const state of index.projectMirrors ?? []) {
        if (!state.pending) continue
        const workspace = workspaces.find(item => item.id === state.workspaceId && item.storageMode === 'project' && item.rootPath === state.rootPath)
        if (!workspace) continue // 已解绑或重新定位，原路径不再写入。
        try { Object.assign(state, writeAutomationMirror(index, state, workspace), { error: undefined }); changed = true }
        catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          if (state.error !== message) { state.error = message; changed = true }
        }
      }
      if (changed) this.store.write(index)
    } catch (error) { console.error('[Core Automation] 镜像状态未能保存，权威账本保留待重试：', error) }
    finally { this.projecting = false }
  }
  private changed(): void {
    if (this.transaction) return
    this.retryProjectMirrors()
    this.runtime?.publish({ type: 'automation', sessionId: '', payload: { automations: this.list(), projectMirrors: this.projectMirrorStatuses() } })
  }
  private assertAvailable(): void { if (this.stopped || this.failure) throw new Error(`Core Automation不可调度：${this.stopped ? '服务已关闭' : String(this.failure)}`) }
  dispose(): void { this.stopped = true; if (this.timer) clearInterval(this.timer) }
  async shutdown(): Promise<void> { this.dispose(); await Promise.all([...this.active.values()].map(async handle => { await handle.stop('core_shutdown'); await handle.promise })) }
}
