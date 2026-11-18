import { randomUUID } from 'node:crypto'
import { AUTOMATION_MAX_HISTORY, AUTOMATION_DEFAULT_PERMISSION_MODE, normalizeTimeOfDay, normalizeDayOfWeek, normalizeDayOfMonth, type Automation, type AutomationRun, type CreateAutomationInput, type UpdateAutomationInput, type AutomationTriggerRecord, type AutomationPendingTrigger, type PresetReference } from '@profer/shared'
import { computeNextRunAt } from './automation-schedule'
import { enqueueAutomationTrigger as enqueueTrigger, transitionAutomationTrigger } from './automation-dispatch'

export interface AutomationsIndex { version: number; automations: Automation[]; triggers?: AutomationTriggerRecord[]; operations?: Array<{ id: string; fingerprint: string; result: unknown }> }
/** 桌面与Core共用历史字段转换；仅修改调用方提供的副本，不重算调度水位。 */
export function migrateLegacyAutomationFields(data: AutomationsIndex): boolean {
  let changed = false
  for (const a of data.automations) {
    if ((a.sessionMode as string | undefined) === 'new') {
      a.sessionMode = 'daily'
      changed = true
    }
    const permissionMode = a.permissionMode as string | undefined
    if (permissionMode && permissionMode !== AUTOMATION_DEFAULT_PERMISSION_MODE) {
      a.permissionMode = AUTOMATION_DEFAULT_PERMISSION_MODE
      changed = true
    }
    // v3 多值迁移：单值 → 数组
    const rawTimeOfDay = a.timeOfDay as unknown
    if (typeof rawTimeOfDay === 'string') {
      a.timeOfDay = normalizeTimeOfDay(rawTimeOfDay)
      changed = true
    } else if (!Array.isArray(a.timeOfDay)) {
      a.timeOfDay = []
      changed = true
    }
    const rawDayOfWeek = a.dayOfWeek as unknown
    if (typeof rawDayOfWeek === 'number') {
      a.dayOfWeek = normalizeDayOfWeek(rawDayOfWeek)
      changed = true
    } else if (!Array.isArray(a.dayOfWeek)) {
      a.dayOfWeek = []
      changed = true
    }
    const rawDayOfMonth = a.dayOfMonth as unknown
    if (typeof rawDayOfMonth === 'number') {
      a.dayOfMonth = normalizeDayOfMonth(rawDayOfMonth)
      changed = true
    } else if (!Array.isArray(a.dayOfMonth)) {
      a.dayOfMonth = []
      changed = true
    }
  }
  if (data.version < 4) {
    data.version = 4
    changed = true
  }
  return changed
}


export interface AutomationManagerPorts {
  readIndex(): AutomationsIndex
  writeIndex(index: AutomationsIndex): void
  now?(): number
  presetReferenceForAutomation(workspaceId: string | undefined, presetId: string): PresetReference
  validatePresetReference?(workspaceId: string | undefined, reference: PresetReference): void
  assertValidBoundAutomation(automation: Pick<Automation, 'boundSessionId' | 'workspaceId' | 'channelId' | 'modelId' | 'agentRuntime' | 'presetId'>): void
}
/** 桌面与Core共用定义、排队和原子结算规则；路径、校验、事务由所属宿主注入。 */
export function createAutomationManager(ports: AutomationManagerPorts) {
  const { readIndex, writeIndex, presetReferenceForAutomation, assertValidBoundAutomation } = ports
  const clock = ports.now ?? Date.now
  /** 获取全部定时任务（按 createdAt 升序，保持列表稳定） */
  function listAutomations(): Automation[] {
    const index = readIndex()
    return index.automations.map((automation) => {
      const pendingTriggers = Object.freeze((index.triggers ?? [])
        .filter((trigger) => trigger.automationId === automation.id)
        .flatMap((trigger): AutomationPendingTrigger[] => {
          const { status } = trigger
          if (status !== 'queued' && status !== 'blocked' && status !== 'running' && status !== 'interrupted') return []
          return [Object.freeze({
            triggerId: trigger.triggerId,
            scheduledAt: trigger.scheduledAt,
            status,
            boundSessionId: trigger.boundSessionId,
            targetSessionId: trigger.targetSessionId,
            runId: trigger.runId,
            error: trigger.error,
            updatedAt: trigger.updatedAt,
          })]
        })
        .sort((a, b) => a.scheduledAt - b.scheduledAt || a.triggerId.localeCompare(b.triggerId)))
      return {
        ...automation,
        pendingTriggers,
        dispatchBlockReason: pendingTriggers.find((trigger) => trigger.status === 'blocked')?.error ?? automation.dispatchBlockReason,
      }
    }).sort((a, b) => a.createdAt - b.createdAt)
  }

  /** 按 ID 获取单个定时任务 */
  function getAutomation(id: string): Automation | undefined {
    return listAutomations().find((a) => a.id === id)
  }

  /** 任务是否具备运行所需的最小完整度（channelId + workspaceId） */
  function isAutomationRunnable(a: Pick<Automation, 'channelId' | 'workspaceId'>): boolean {
    return !!a.channelId && !!a.workspaceId
  }

  /**
   * 规范化 maxRuns：只接受 ≥1 的有限整数，其余（0、负数、非法值、undefined）一律按「不限次」处理返回 undefined。
   * 让 0/负数等价于"取消上限"，避免出现"上限为 0 永远跑不了"的死配置。
   */
  function normalizeMaxRuns(v: number | undefined): number | undefined {
    if (v === undefined) return undefined
    if (!Number.isFinite(v) || !Number.isInteger(v) || v < 1) return undefined
    return v
  }

  /**
   * 应用 maxRuns 变更。只要运行配额发生变化，就把已执行计数/完成标记重置到新配额的起点。
   */
  function applyMaxRunsUpdate(
    target: Pick<Automation, 'maxRuns' | 'runCount' | 'completedAt'>,
    nextMaxRuns: number | undefined,
  ): void {
    const normalizedMaxRuns = normalizeMaxRuns(nextMaxRuns)
    if (normalizedMaxRuns !== target.maxRuns) {
      target.runCount = 0
      target.completedAt = undefined
    }
    target.maxRuns = normalizedMaxRuns
  }

  /**
   * 判断任务是否已达成「自动完成」条件（跑完后应停用，区别于手动暂停 / 失败暂停）：
   * - once：只要实际执行过一次（runCount ≥ 1）即完成
   * - 任意模式叠加 maxRuns：实际执行次数达到上限即完成
   * 仅依据 runCount（成功 + 失败，不含 skipped），调用方需保证传入的是已自增后的最新值。
   */
  function shouldAutoComplete(a: Pick<Automation, 'scheduleType' | 'maxRuns' | 'runCount'>): boolean {
    const count = a.runCount ?? 0
    if (a.scheduleType === 'once') return count >= 1
    const max = normalizeMaxRuns(a.maxRuns)
    return max !== undefined && count >= max
  }

  /** 创建定时任务 */
  function createAutomation(input: CreateAutomationInput): Automation {
    if (input.presetReference) ports.validatePresetReference?.(input.workspaceId, input.presetReference)
    if (input.timeZone) new Intl.DateTimeFormat('en', { timeZone: input.timeZone }).format()
    const index = readIndex()
    const now = clock()
    // 草稿态（缺 channelId / workspaceId）强制不启用，避免空配置任务进入调度
    const requestedActive = input.active ?? true
    const active = requestedActive && isAutomationRunnable(input)

    // 归一化多值字段（兼容旧调用传入单值）
    const timeOfDay = normalizeTimeOfDay(input.timeOfDay)
    const dayOfWeek = normalizeDayOfWeek(input.dayOfWeek as number | number[] | undefined)
    const dayOfMonth = normalizeDayOfMonth(input.dayOfMonth as number | number[] | undefined)

    const automation: Automation = {
      id: randomUUID(),
      name: input.name,
      prompt: input.prompt,
      active,
      scheduleType: input.scheduleType,
      intervalMinutes: input.intervalMinutes,
      timeOfDay,
      timeZone: input.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      dayOfWeek,
      dayOfMonth,
      scheduledAt: input.scheduledAt,
      maxRuns: normalizeMaxRuns(input.maxRuns),
      agentRuntime: input.agentRuntime,
      channelId: input.channelId,
      modelId: input.modelId,
      workspaceId: input.workspaceId,
      permissionMode: input.permissionMode ?? AUTOMATION_DEFAULT_PERMISSION_MODE,
      presetId: input.presetReference?.presetId ?? (input.presetId?.trim() || undefined),
      ...(input.presetReference ? { presetReference: input.presetReference } : input.presetId?.trim() ? { presetReference: presetReferenceForAutomation(input.workspaceId, input.presetId) } : {}),
      sessionMode: input.sessionMode,
      notificationTargets: input.notificationTargets,
      sourceSessionId: input.sourceSessionId,
      boundSessionId: input.boundSessionId?.trim() || undefined,
      promptAuthor: input.promptAuthor,
      createdAt: now,
      updatedAt: now,
      nextRunAt: computeNextRunAt({
        ...input,
        timeOfDay,
        timeZone: input.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
        dayOfWeek,
        dayOfMonth,
      }, now),
      runCount: 0,
      runHistory: [],
    }
    assertValidBoundAutomation(automation)

    index.automations.push(automation)
    writeIndex(index)
    console.log(`[定时任务] 已创建: ${automation.name} (${automation.id}), 模式 ${automation.scheduleType}`)
    return automation
  }

  /** 更新定时任务（部分字段） */
  function updateAutomation(input: UpdateAutomationInput): Automation | undefined {
    if (input.presetReference) ports.validatePresetReference?.(input.workspaceId ?? getAutomation(input.id)?.workspaceId, input.presetReference)
    if (input.timeZone !== undefined) { if (!input.timeZone.trim()) throw new Error('任务时区不能为空'); new Intl.DateTimeFormat('en', { timeZone: input.timeZone }).format() }
    const index = readIndex()
    const target = index.automations.find((a) => a.id === input.id)
    if (!target) return undefined

    const now = clock()
    const nextRoute = {
      workspaceId: input.workspaceId !== undefined ? (input.workspaceId || undefined) : target.workspaceId,
      channelId: input.channelId ?? target.channelId,
      modelId: input.modelId ?? target.modelId,
      agentRuntime: input.agentRuntime ?? target.agentRuntime,
      presetId: input.presetReference?.presetId ?? (input.presetId !== undefined ? (input.presetId.trim() || undefined) : target.presetId),
      presetReference: input.presetReference ?? (input.presetId !== undefined ? undefined : target.presetReference),
      boundSessionId: input.boundSessionId !== undefined ? (input.boundSessionId.trim() || undefined) : target.boundSessionId,
    }
    const routeChanged = nextRoute.workspaceId !== target.workspaceId
      || nextRoute.channelId !== target.channelId
      || nextRoute.modelId !== target.modelId
      || nextRoute.agentRuntime !== target.agentRuntime
      || nextRoute.presetId !== target.presetId
      || JSON.stringify(nextRoute.presetReference) !== JSON.stringify(target.presetReference)
      || nextRoute.boundSessionId !== target.boundSessionId
    if (routeChanged) assertValidBoundAutomation({ ...target, ...nextRoute })
    if (routeChanged) {
      index.triggers = (index.triggers ?? []).map((trigger) => {
        if (trigger.automationId !== target.id || (trigger.status !== 'queued' && trigger.status !== 'blocked')) return trigger
        const routePatch = { boundSessionId: nextRoute.boundSessionId, error: undefined }
        return trigger.status === 'blocked'
          ? transitionAutomationTrigger(trigger, 'queued', now, routePatch)
          : { ...trigger, ...routePatch, updatedAt: now }
      })
    }
    if (input.name !== undefined) target.name = input.name
    if (input.prompt !== undefined) target.prompt = input.prompt
    if (input.agentRuntime !== undefined) target.agentRuntime = input.agentRuntime
    if (input.channelId !== undefined) target.channelId = input.channelId
    if (input.modelId !== undefined) target.modelId = input.modelId
    // workspaceId 允许设为空字符串表示「无工作区」；用 undefined 区分「不修改」
    if (input.workspaceId !== undefined) {
      target.workspaceId = input.workspaceId || undefined
    }
    if (input.permissionMode !== undefined) target.permissionMode = input.permissionMode
    // presetId 允许设为空字符串表示「跟随工作区默认」；用 undefined 区分「不修改」
    if (input.presetReference !== undefined) {
      target.presetReference = input.presetReference
      target.presetId = input.presetReference?.presetId
    } else if (input.presetId !== undefined) {
      target.presetId = input.presetId.trim() || undefined
      target.presetReference = target.presetId
        ? presetReferenceForAutomation(target.workspaceId, target.presetId)
        : undefined
    }
    if (input.sessionMode !== undefined) target.sessionMode = input.sessionMode
    if (input.notificationTargets !== undefined) target.notificationTargets = input.notificationTargets
    if (input.boundSessionId !== undefined) {
      target.boundSessionId = input.boundSessionId.trim() || undefined
    }
    if (input.promptAuthor !== undefined) target.promptAuthor = input.promptAuthor
    if (input.maxRuns !== undefined) applyMaxRunsUpdate(target, input.maxRuns)

    // 调度参数变化：重算下次运行时间（从现在起算，避免旧时间戳立即触发）
    // 数组比较：归一化后比内容
    const nextTimeOfDay = input.timeOfDay !== undefined ? normalizeTimeOfDay(input.timeOfDay) : undefined
    const nextDayOfWeek = input.dayOfWeek !== undefined ? normalizeDayOfWeek(input.dayOfWeek as number | number[] | undefined) : undefined
    const nextDayOfMonth = input.dayOfMonth !== undefined ? normalizeDayOfMonth(input.dayOfMonth as number | number[] | undefined) : undefined

    const arraysEqual = (a: unknown[], b: unknown[]): boolean =>
      a.length === b.length && a.every((v, i) => v === b[i])

    const scheduleChanged =
      (input.timeZone !== undefined && input.timeZone !== target.timeZone) ||
      (input.scheduleType !== undefined && input.scheduleType !== target.scheduleType) ||
      (input.intervalMinutes !== undefined && input.intervalMinutes !== target.intervalMinutes) ||
      (nextTimeOfDay !== undefined && !arraysEqual(nextTimeOfDay, target.timeOfDay ?? [])) ||
      (nextDayOfWeek !== undefined && !arraysEqual(nextDayOfWeek, target.dayOfWeek ?? [])) ||
      (nextDayOfMonth !== undefined && !arraysEqual(nextDayOfMonth, target.dayOfMonth ?? [])) ||
      (input.scheduledAt !== undefined && input.scheduledAt !== target.scheduledAt)
    if (scheduleChanged) {
      index.triggers = (index.triggers ?? []).map((trigger) =>
        trigger.automationId === target.id && (trigger.status === 'queued' || trigger.status === 'blocked')
          ? transitionAutomationTrigger(trigger, 'cancelled', now, { error: '调度配置已变更' })
          : trigger,
      )
    }
    if (input.timeZone !== undefined) target.timeZone = input.timeZone
    if (input.scheduleType !== undefined) target.scheduleType = input.scheduleType
    if (input.intervalMinutes !== undefined) target.intervalMinutes = input.intervalMinutes
    if (nextTimeOfDay !== undefined) target.timeOfDay = nextTimeOfDay
    if (nextDayOfWeek !== undefined) target.dayOfWeek = nextDayOfWeek
    if (nextDayOfMonth !== undefined) target.dayOfMonth = nextDayOfMonth
    if (input.scheduledAt !== undefined) target.scheduledAt = input.scheduledAt
    if (scheduleChanged) {
      target.nextRunAt = computeNextRunAt(target, now)
    }

    // 启用状态变化
    if (input.active !== undefined && input.active !== target.active) {
      if (!input.active) {
        index.triggers = (index.triggers ?? []).map((trigger) =>
          trigger.automationId === target.id && (trigger.status === 'queued' || trigger.status === 'blocked')
            ? transitionAutomationTrigger(trigger, 'failed', now, { error: '定时任务已暂停' })
            : trigger,
        )
      }
      // 启用要求 channelId + workspaceId 齐全，否则拒绝（兜底前端校验，避免空配置任务进入调度）
      if (input.active && !isAutomationRunnable(target)) {
        throw new Error('启用定时任务前必须配置模型与工作区')
      }
      target.active = input.active
      if (input.active) {
        target.dispatchBlockReason = undefined
        // 重新启用：从现在起算下一次触发，清空连续失败计数，并重置运行配额
        //（runCount 清零 + 清空 completedAt），语义是「重新跑一轮配额」。
        // 这样跑满 maxRuns / once 完成后被自动停用的任务，用户手动启用即可再跑一轮。
        target.nextRunAt = computeNextRunAt(target, now)
        target.consecutiveFailures = 0
        target.runCount = 0
        target.completedAt = undefined
      }
    }

    // 调度配置被改成不完整时自动暂停：防止用户清空工作区 / 渠道后任务仍处于 active 进入 tick
    if (target.active && !isAutomationRunnable(target)) {
      target.active = false
    }
    target.updatedAt = now
    writeIndex(index)
    return getAutomation(target.id) ?? target
  }

  /** 删除定时任务 */
  function deleteAutomation(id: string): boolean {
    const index = readIndex()
    const before = index.automations.length
    index.automations = index.automations.filter((a) => a.id !== id)
    if (index.automations.length === before) return false
    index.triggers = (index.triggers ?? []).filter((trigger) => trigger.automationId !== id)
    writeIndex(index)
    console.log(`[定时任务] 已删除: ${id}`)
    return true
  }

  /**
   * 停用绑定到指定工作区的全部定时任务。
   *
   * 工作区被移除后 `getAgentWorkspace(workspaceId)` 再也解析不到，调度侧会以用户主目录
   * 作 cwd 执行无人值守任务（P1-3）。所以移除时必须先把任务停掉：
   * `updateAutomation({ active: false })` 同时会把该任务的 queued / blocked trigger 标记为失败，
   * 不会在下次 tick 被重拉起来。
   *
   * @returns 被本函数停用的任务 id（调用方负责广播 CHANGED）
   */
  function pauseAutomationsForWorkspace(workspaceId: string): string[] {
    const paused: string[] = []
    for (const automation of readIndex().automations) {
      if (automation.workspaceId !== workspaceId || !automation.active) continue
      if (updateAutomation({ id: automation.id, active: false })) paused.push(automation.id)
    }
    if (paused.length > 0) {
      console.log(`[定时任务] 工作区 ${workspaceId} 已移除，停用 ${paused.length} 个绑定任务`)
    }
    return paused
  }

  function getAutomationTrigger(triggerId: string): AutomationTriggerRecord | undefined {
    return readIndex().triggers?.find((trigger) => trigger.triggerId === triggerId)
  }

  function listAutomationTriggers(status?: AutomationTriggerRecord['status']): AutomationTriggerRecord[] {
    const records = readIndex().triggers ?? []
    return records.filter((record) => status === undefined || record.status === status)
  }

  /** 持久化触发去重与首次 occurrence；重复投递返回原记录，不改状态或时间。 */
  function enqueueAutomationTrigger(record: AutomationTriggerRecord): AutomationTriggerRecord {
    const index = readIndex()
    const before = index.triggers ?? []
    const existing = before.find((trigger) => trigger.triggerId === record.triggerId)
    if (existing && !(existing.status === 'cancelled' && record.status === 'queued')) return existing
    const base = existing ? before.filter((trigger) => trigger.triggerId !== record.triggerId) : before
    index.triggers = enqueueTrigger(base, record, clock())
    writeIndex(index)
    return index.triggers[index.triggers.length - 1]!
  }

  function transitionAutomationTriggerRecord(
    triggerId: string,
    status: AutomationTriggerRecord['status'],
    patch: Partial<Pick<AutomationTriggerRecord, 'boundSessionId' | 'targetSessionId' | 'runId' | 'error'>> = {},
  ): AutomationTriggerRecord | undefined {
    const index = readIndex()
    const position = (index.triggers ?? []).findIndex((trigger) => trigger.triggerId === triggerId)
    if (position < 0) return undefined
    const next = transitionAutomationTrigger(index.triggers![position]!, status, clock(), patch)
    index.triggers![position] = next
    writeIndex(index)
    return next
  }

  function linkAutomationTriggerRun(
    triggerId: string,
    runId: string,
    targetSessionId?: string,
  ): AutomationTriggerRecord | undefined {
    const index = readIndex()
    const trigger = index.triggers?.find((record) => record.triggerId === triggerId)
    if (!trigger) return undefined
    if (trigger.runId && trigger.runId !== runId) throw new Error('同一自动化 trigger 不能关联另一个 Run')
    if (trigger.runId === runId && (!targetSessionId || trigger.targetSessionId === targetSessionId)) return trigger
    trigger.runId = runId
    if (targetSessionId) trigger.targetSessionId = targetSessionId
    trigger.updatedAt = clock()
    writeIndex(index)
    return trigger
  }

  /** trigger 与运行历史在同一次原子写入中结算；重复终态不重复计数。 */
  function settleAutomationTrigger(triggerId: string, run: AutomationRun): Automation | undefined {
    const index = readIndex()
    const trigger = index.triggers?.find((record) => record.triggerId === triggerId)
    const target = trigger ? index.automations.find((automation) => automation.id === trigger.automationId) : undefined
    if (!trigger || !target || !['queued', 'blocked', 'running'].includes(trigger.status)) return undefined
    if (run.status === 'skipped') throw new Error('自动化 trigger 终态不能使用 skipped')
    if (trigger.runId && run.runId && trigger.runId !== run.runId) throw new Error('自动化终态 Run 与 trigger 已关联的 Run 不一致')
    const now = clock()
    const next = transitionAutomationTrigger(trigger, run.status === 'success' ? 'completed' : 'failed', now, {
      runId: run.runId ?? trigger.runId,
      targetSessionId: run.sessionId || trigger.targetSessionId,
      error: run.error,
    })
    Object.assign(trigger, next)
    applyAutomationRun(target, { ...run, triggerId, runId: next.runId }, now)
    writeIndex(index)
    return target
  }

  /** 当前 automation 的唯一未完成触发；同一 occurrence 重放不会创建第二条。 */
  function getPendingAutomationTrigger(automationId: string): AutomationTriggerRecord | undefined {
    return (readIndex().triggers ?? []).find((trigger) =>
      trigger.automationId === automationId && (trigger.status === 'queued' || trigger.status === 'blocked' || trigger.status === 'running'),
    )
  }

  /** 清除已暂停/删除前仍 queued 的触发；running 保留以便结算。 */
  function cancelQueuedAutomationTriggers(automationId: string, reason = '定时任务已暂停'): void {
    const index = readIndex()
    let changed = false
    index.triggers = (index.triggers ?? []).map((trigger) => {
      if (trigger.automationId !== automationId || trigger.status !== 'queued') return trigger
      changed = true
      return transitionAutomationTrigger(trigger, 'failed', clock(), { error: reason })
    })
    if (changed) writeIndex(index)
  }

  function unblockAutomationTriggers(automationId: string): void {
    const index = readIndex()
    let changed = false
    index.triggers = (index.triggers ?? []).map((trigger) => {
      if (trigger.automationId !== automationId || trigger.status !== 'blocked') return trigger
      changed = true
      return transitionAutomationTrigger(trigger, 'queued', clock(), { error: undefined })
    })
    if (changed) writeIndex(index)
  }

  /** 最近 trigger ledger 为独立运行事实，不写入 AutomationRun history。 */
  function removeAutomationTriggers(automationId: string): void {
    const index = readIndex()
    const before = index.triggers ?? []
    index.triggers = before.filter((trigger) => trigger.automationId !== automationId)
    if (index.triggers.length !== before.length) writeIndex(index)
  }

  /** 记录一次运行结果并推进下次触发时间
   *
   * 由调度器在运行完成/失败/跳过后调用。
   * - 成功/失败：从「现在」起算下次触发时间，并累加 runCount
   * - 跳过：不动 nextRunAt、不计入 runCount——否则任务因重入持续跳过时，每次跳过都会把下次触发再推一个完整间隔，
   *   实际周期会被拉成 N×interval。保留原 nextRunAt 让下一个 tick 立刻有机会再次尝试。
   * - 成功/跳过：清零连续失败计数；失败：累加（调度器据此判断是否自动暂停）
   * - once 跑完一次 / 达到 maxRuns 上限：自动停用并标记 completedAt，区别于手动暂停
   */
  function appendRun(id: string, run: AutomationRun): Automation | undefined {
    const index = readIndex()
    const target = index.automations.find((a) => a.id === id)
    if (!target) return undefined

    applyAutomationRun(target, run, clock())
    writeIndex(index)
    return target
  }

  function applyAutomationRun(target: Automation, run: AutomationRun, now: number): void {
    target.runHistory.unshift(run)
    if (target.runHistory.length > AUTOMATION_MAX_HISTORY) {
      target.runHistory = target.runHistory.slice(0, AUTOMATION_MAX_HISTORY)
    }

    if (run.status !== 'skipped') {
      target.lastRunAt = run.runAt
      target.runCount = (target.runCount ?? 0) + 1
      target.nextRunAt = computeNextRunAt(target, now)
    }

    if (run.status === 'error') {
      target.consecutiveFailures = (target.consecutiveFailures ?? 0) + 1
    } else {
      target.consecutiveFailures = 0
    }

    // 自动完成：once 跑完一次，或循环任务达到 maxRuns 上限 → 停用并标记完成时间。
    // 只在非 skipped（runCount 已自增）时判断，避免重入跳过被误判为完成。
    if (run.status !== 'skipped' && shouldAutoComplete(target)) {
      target.active = false
      target.completedAt = now
      console.log(`[定时任务] ${target.name} 已达成运行上限（${target.runCount} 次），自动完成停用`)
    }

    target.updatedAt = now
  }

  /** 设置 nextRunAt（调度器恢复过期任务时用，避免重启雪崩触发） */
  function setNextRunAt(id: string, nextRunAt: number): void {
    const index = readIndex()
    const target = index.automations.find((a) => a.id === id)
    if (!target) return
    target.nextRunAt = nextRunAt
    writeIndex(index)
  }

  /** 记录本任务最近一次运行创建的会话 ID */
  function setLastSessionId(id: string, sessionId: string): void {
    const index = readIndex()
    const target = index.automations.find((a) => a.id === id)
    if (!target) return
    target.lastSessionId = sessionId
    writeIndex(index)
  }


  return { listAutomations, getAutomation, applyMaxRunsUpdate, createAutomation, updateAutomation, deleteAutomation, pauseAutomationsForWorkspace, getAutomationTrigger, listAutomationTriggers, enqueueAutomationTrigger, transitionAutomationTriggerRecord, linkAutomationTriggerRun, settleAutomationTrigger, getPendingAutomationTrigger, cancelQueuedAutomationTriggers, unblockAutomationTriggers, removeAutomationTriggers, appendRun, setNextRunAt, setLastSessionId }
}
export type AutomationManager = ReturnType<typeof createAutomationManager>
