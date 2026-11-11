/**
 * 定时任务（Automation）管理器
 *
 * 负责定时任务的 CRUD 与运行历史持久化。
 * - 索引文件：~/.profer/automations.json
 *
 * 照搬 agent-session-manager.ts 的原子写模式（safe-file）。
 * 调度逻辑见 automation-scheduler.ts，本文件只管数据。
 */

import { randomUUID } from 'node:crypto'
import { writeJsonFileAtomic, readJsonFileSafe } from './safe-file'
import { getAutomationsPath } from './config-paths'
import { readProjectAutomations, writeProjectAutomations } from './project-automation-store'
import {
  AUTOMATION_MAX_HISTORY,
  AUTOMATION_DEFAULT_PERMISSION_MODE,
  normalizeTimeOfDay,
  normalizeDayOfWeek,
  normalizeDayOfMonth,
  DEFAULT_TIME_OF_DAY,
  DEFAULT_DAY_OF_WEEK,
  DEFAULT_DAY_OF_MONTH,
  type Automation,
  type AutomationRun,
  type CreateAutomationInput,
  type UpdateAutomationInput,
  type AutomationTriggerRecord,
  type AutomationPendingTrigger,
} from '@profer/shared'
import { presetReferenceForId, resolvePresetReference } from './agent-preset-manager'
import { enqueueAutomationTrigger as enqueueTrigger, normalizeAutomationTriggerRecords, transitionAutomationTrigger, validateBoundAutomationChannel, validateBoundAutomationSession } from './automation-dispatch'

/** 索引文件格式 */
interface AutomationsIndex {
  version: number
  automations: Automation[]
  triggers?: AutomationTriggerRecord[]
}

const INDEX_VERSION = 4

/**
 * 把自动任务的预设 ID 解析为引用，并拒绝停用或不存在的预设。
 * 创建与更新共用此入口：界面过滤不能替代主进程校验，绕过界面的调用也不能写入停用预设。
 */
function presetReferenceForAutomation(workspaceId: string | undefined, presetId: string) {
  const { getAgentWorkspace } = require('./agent-workspace-manager') as typeof import('./agent-workspace-manager')
  const workspaceSlug = workspaceId ? getAgentWorkspace(workspaceId)?.slug : undefined
  // 停用是按工作区判定的：没有工作区上下文时无法确认预设可用，草稿也不能携带未校验的预设引用
  if (!workspaceSlug) throw new Error('指定预设前需要先选择工作区')
  const reference = presetReferenceForId(workspaceSlug, presetId)
  resolvePresetReference(reference, workspaceSlug)
  return reference
}

function assertValidBoundAutomation(automation: Pick<Automation, 'boundSessionId' | 'workspaceId' | 'channelId' | 'modelId' | 'agentRuntime' | 'presetId'>): void {
  if (!automation.boundSessionId) return
  const { getAgentSessionMeta } = require('./agent-session-manager') as typeof import('./agent-session-manager')
  const { getAgentWorkspace } = require('./agent-workspace-manager') as typeof import('./agent-workspace-manager')
  const { resolvePresetId, getDefaultPresetId } = require('./agent-preset-manager') as typeof import('./agent-preset-manager')
  const { getVisibleChannelById } = require('./channel-manager') as typeof import('./channel-manager')
  const session = getAgentSessionMeta(automation.boundSessionId)
  const workspaceSlug = automation.workspaceId ? getAgentWorkspace(automation.workspaceId)?.slug : undefined
  const expectedPresetId = automation.presetId
    ? resolvePresetId(workspaceSlug, automation.presetId)
    : getDefaultPresetId(workspaceSlug)
  const result = validateBoundAutomationSession(automation, session, expectedPresetId)
  if (!result.valid) throw new Error(`目标会话绑定无效：${result.reason}`)
  const channel = getVisibleChannelById(automation.channelId)
  const availability = validateBoundAutomationChannel(automation, session!, channel)
  if (!availability.valid) throw new Error(`目标会话绑定无效：${availability.reason}`)
}

/**
 * 兼容历史字段：
 * - sessionMode：v1 用过的 'new' 值统一改为 'daily'。
 * - permissionMode：已移除的 'auto' 统一改为默认完全自动模式。
 * - timeOfDay/dayOfWeek/dayOfMonth：v1/v2 单值 → v3 多值数组（归一化）。
 * - 同时把 index.version bump 到当前值，避免下次启动反复迁移。
 * 返回是否发生改动，由调用方决定是否写回磁盘。
 */
function migrateLegacyFields(data: AutomationsIndex): boolean {
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
  if (data.version < INDEX_VERSION) {
    data.version = INDEX_VERSION
    changed = true
  }
  return changed
}

/**
 * 内存缓存：避免每次操作都从磁盘读取完整索引。
 * 所有写入操作同时更新缓存和磁盘（write-through），保证一致性。
 * 由于 readFileSync/writeFileSync 是同步的，Node 事件循环不会在 read-modify-write 中间让出，
 * 因此不存在并发竞态。缓存的作用是减少冗余磁盘 I/O。
 */
let cachedIndex: AutomationsIndex | null = null

interface ProjectAutomationMirror {
  id: string
  rootPath: string
}

function listProjectAutomationMirrors(): ProjectAutomationMirror[] {
  // 延迟 require：工作区管理器与定时任务管理器共享索引文件，避免顶层循环依赖。
  const { listAgentWorkspaces } = require('./agent-workspace-manager') as typeof import('./agent-workspace-manager')
  return listAgentWorkspaces()
    .filter((workspace) => workspace.storageMode === 'project' && typeof workspace.rootPath === 'string' && workspace.rootPath.length > 0)
    .map((workspace) => ({ id: workspace.id, rootPath: workspace.rootPath! }))
}

const mirroredAutomationSignatures = new Map<string, string>()
const reconciledAutomationRoots = new Set<string>()

function automationMirrorSignature(
  automations: readonly Automation[],
  triggers: readonly AutomationTriggerRecord[],
): string {
  const automationPart = automations
    .map((automation) => `${automation.id}:${automation.updatedAt ?? 0}:${automation.active ? 1 : 0}:${automation.name}`)
    .join('|')
  const triggerPart = triggers
    .map((trigger) => `${trigger.triggerId}:${trigger.updatedAt ?? 0}:${trigger.status}`)
    .join('|')
  return `${automationPart}##${triggerPart}`
}

/** 把全局索引里属于各 project 的任务镜像到 `<root>/.profer/automations.json`。 */
function mirrorProjectAutomations(index: AutomationsIndex): void {
  const mirrors = listProjectAutomationMirrors()
  if (mirrors.length === 0) return

  for (const mirror of mirrors) {
    const automations = index.automations.filter((automation) => automation.workspaceId === mirror.id)
    const automationIds = new Set(automations.map((automation) => automation.id))
    const triggers = (index.triggers ?? []).filter((trigger) => automationIds.has(trigger.automationId))
    const signature = automationMirrorSignature(automations, triggers)
    const cacheKey = `${mirror.id}|${mirror.rootPath}`
    if (mirroredAutomationSignatures.get(cacheKey) === signature) continue
    try {
      writeProjectAutomations(mirror.rootPath, automations, triggers)
      mirroredAutomationSignatures.set(cacheKey, signature)
    } catch (error) {
      console.warn(`[定时任务] 写入项目任务镜像失败 (${mirror.rootPath}):`, error)
    }
  }
}

/** 启动/打开项目时把项目镜像里更新的任务合并回全局。 */
function reconcileProjectAutomations(index: AutomationsIndex): boolean {
  let changed = false
  index.triggers = index.triggers ?? []

  for (const mirror of listProjectAutomationMirrors()) {
    if (reconciledAutomationRoots.has(mirror.rootPath)) continue
    reconciledAutomationRoots.add(mirror.rootPath)
    const file = readProjectAutomations(mirror.rootPath)
    if (!file) continue

    const workspaceSlug = (() => {
      const { getAgentWorkspace } = require('./agent-workspace-manager') as typeof import('./agent-workspace-manager')
      return getAgentWorkspace(mirror.id)?.slug
    })()
    for (const automation of file.automations) {
      const normalized: Automation = { ...automation, workspaceId: mirror.id }
      // 项目拷到新机器后 slug 可能变化：工作区级预设引用改指当前项目。
      if (workspaceSlug && normalized.presetReference?.presetScope === 'workspace') {
        normalized.presetReference = { ...normalized.presetReference, workspaceSlug }
      }
      const existing = index.automations.find((item) => item.id === normalized.id)
      if (!existing) {
        index.automations.push(normalized)
        changed = true
        continue
      }
      if ((normalized.updatedAt ?? 0) > (existing.updatedAt ?? 0)) {
        Object.assign(existing, normalized)
        changed = true
      }
    }

    for (const trigger of file.triggers) {
      const existing = index.triggers.find((item) => item.triggerId === trigger.triggerId)
      if (!existing) {
        index.triggers.push(trigger)
        changed = true
        continue
      }
      if ((trigger.updatedAt ?? 0) > (existing.updatedAt ?? 0)) {
        Object.assign(existing, trigger)
        changed = true
      }
    }
  }

  return changed
}

function readGlobalIndex(): AutomationsIndex {
  if (cachedIndex) return cachedIndex

  const data = readJsonFileSafe<AutomationsIndex>(getAutomationsPath())
  if (!data) {
    cachedIndex = { version: INDEX_VERSION, automations: [], triggers: [] }
    return cachedIndex
  }
  if (typeof data.version !== 'number') {
    console.warn(`[定时任务] 索引文件缺少有效 version 字段，将忽略其内容`)
    cachedIndex = { version: INDEX_VERSION, automations: [], triggers: [] }
    return cachedIndex
  }
  if (data.version > INDEX_VERSION) {
    // 数据由更高版本的 Profer 写入（用户回滚到旧版的场景）。保留原始 automations 数组只读返回，
    // 避免下次 writeIndex 用空数据覆盖磁盘导致永久丢失任务配置和运行历史。
    console.warn(
      `[定时任务] 索引文件版本 ${data.version} 高于当前构建（${INDEX_VERSION}），将以原数据加载，` +
        `可能存在不识别的字段；请尽量升级到最新版本。`,
    )
    if (!Array.isArray(data.automations)) {
      cachedIndex = { version: INDEX_VERSION, automations: [] }
      return cachedIndex
    }
    cachedIndex = data
    return cachedIndex
  }
  if (!Array.isArray(data.automations)) {
    cachedIndex = { version: INDEX_VERSION, automations: [], triggers: [] }
    return cachedIndex
  }
  const needsTriggerMigration = !Array.isArray(data.triggers)
    || data.triggers.some((trigger) => trigger.status === 'running')
  data.triggers = normalizeAutomationTriggerRecords(Array.isArray(data.triggers) ? data.triggers : [], Date.now())
  const migrated = migrateLegacyFields(data) || needsTriggerMigration
  cachedIndex = data
  if (migrated) {
    writeIndex(data)
    console.log('[定时任务] 索引已迁移至最新版本（sessionMode: new → daily，permissionMode: auto → bypassPermissions）')
  }
  return cachedIndex
}

function readIndex(): AutomationsIndex {
  const index = readGlobalIndex()
  if (reconcileProjectAutomations(index)) {
    try {
      writeJsonFileAtomic(getAutomationsPath(), index)
    } catch (error) {
      console.warn('[定时任务] 项目任务对账后写回全局索引失败:', error)
    }
  }
  return index
}

function writeIndex(index: AutomationsIndex): void {
  try {
    cachedIndex = index
    writeJsonFileAtomic(getAutomationsPath(), index)
    mirrorProjectAutomations(index)
  } catch (error) {
    cachedIndex = null // 写入失败时丢弃缓存，下次重新从磁盘读取
    console.error('[定时任务] 写入索引文件失败:', error)
    throw new Error('写入定时任务索引失败')
  }
}

/**
 * 计算下次触发时间戳（从基准时刻 from 起算）
 * - interval：from + 间隔分钟
 * - daily：从 timeOfDay[] 中找今天/明天最近的时间点
 * - weekly：dayOfWeek[] × timeOfDay[] 求最近未来组合
 * - monthly：dayOfMonth[] × timeOfDay[] 求最近未来组合
 * - once：直接返回固定的 scheduledAt（不做任何前进推算），跑完后由 appendRun 自动停用
 *
 * 返回值保证为有限正整数。输入非法时回退到 from + 10min 并打印警告。
 */
export function computeNextRunAt(
  a: { scheduleType: Automation['scheduleType'] } & Partial<
    Pick<Automation, 'intervalMinutes' | 'timeOfDay' | 'dayOfWeek' | 'dayOfMonth' | 'scheduledAt'>
  >,
  from: number = Date.now(),
): number {
  const FALLBACK_INTERVAL_MS = 10 * 60_000

  let result: number

  if (a.scheduleType === 'once') {
    // 一次性任务：永远返回固定的绝对时间戳，不随 from 前进。
    // 即使该时刻已过去（如应用重启后恢复），也保持过去值——让调度器在下个 tick 补跑一次，
    // 这正是「该跑没跑就补上」的期望行为；跑完后 appendRun 会把任务自动停用，不会重复触发。
    result = Number.isFinite(a.scheduledAt) && a.scheduledAt! > 0
      ? a.scheduledAt!
      : from + FALLBACK_INTERVAL_MS
    if (!Number.isFinite(a.scheduledAt) || a.scheduledAt! <= 0) {
      console.warn(`[定时任务] computeNextRunAt: once 缺少有效 scheduledAt (${a.scheduledAt})，回退到 10 分钟后`)
    }
  } else if (a.scheduleType === 'interval') {
    const minutes = Number(a.intervalMinutes)
    if (!Number.isFinite(minutes) || minutes < 1) {
      console.warn(`[定时任务] computeNextRunAt: intervalMinutes 非法 (${a.intervalMinutes})，回退到 10 分钟`)
      result = from + FALLBACK_INTERVAL_MS
    } else {
      result = from + Math.max(1, minutes) * 60_000
    }
  } else {
    // 归一化：处理旧数据单值兼容 + 默认值填充
    const timesOfDay = (normalizeTimeOfDay(a.timeOfDay as string | string[] | undefined)).length > 0
      ? normalizeTimeOfDay(a.timeOfDay as string | string[] | undefined)
      : DEFAULT_TIME_OF_DAY

    const daysOfWeek = a.scheduleType === 'weekly'
      ? ((normalizeDayOfWeek(a.dayOfWeek as number | number[] | undefined)).length > 0
        ? normalizeDayOfWeek(a.dayOfWeek as number | number[] | undefined)
        : DEFAULT_DAY_OF_WEEK)
      : undefined

    const daysOfMonth = a.scheduleType === 'monthly'
      ? ((normalizeDayOfMonth(a.dayOfMonth as number | number[] | undefined)).length > 0
        ? normalizeDayOfMonth(a.dayOfMonth as number | number[] | undefined)
        : DEFAULT_DAY_OF_MONTH)
      : undefined

    result = computeNextRunAtMulti(
      a.scheduleType as 'daily' | 'weekly' | 'monthly',
      timesOfDay,
      from,
      daysOfWeek,
      daysOfMonth,
    )
  }

  if (!Number.isFinite(result) || result <= 0) {
    console.warn(`[定时任务] computeNextRunAt: 计算结果非法 (${result})，回退到 10 分钟后`)
    return from + FALLBACK_INTERVAL_MS
  }

  return result
}

/**
 * 多值调度核心：遍历 time × day 组合，找 > from 的最小时间戳
 */
function computeNextRunAtMulti(
  scheduleType: 'daily' | 'weekly' | 'monthly',
  timesOfDay: string[],
  from: number,
  daysOfWeek?: number[],
  daysOfMonth?: number[],
): number {
  const FALLBACK_INTERVAL_MS = 10 * 60_000
  const daysInMonth = (y: number, m: number) => new Date(y, m + 1, 0).getDate()
  let best: number = Infinity

  for (const tod of timesOfDay) {
    const parts = tod.split(':').map(Number)
    const hh = Number.isFinite(parts[0]) ? parts[0]! : 9
    const mm = Number.isFinite(parts[1]) ? parts[1]! : 0

    if (scheduleType === 'daily') {
      // 每天：每个时间点试今天，已过则推到明天
      const next = new Date(from)
      next.setSeconds(0, 0)
      next.setHours(hh, mm, 0, 0)
      if (next.getTime() <= from) next.setDate(next.getDate() + 1)
      if (next.getTime() < best) best = next.getTime()
    } else if (scheduleType === 'weekly') {
      // 每周：dayOfWeek[] × timeOfDay[] 求最近未来组合
      const ds = daysOfWeek ?? DEFAULT_DAY_OF_WEEK
      for (const dow of ds) {
        const next = new Date(from)
        next.setSeconds(0, 0)
        next.setHours(hh, mm, 0, 0)
        let dayDiff = (dow - next.getDay() + 7) % 7
        // 同一天但时间已过 → 推到下周
        if (dayDiff === 0 && next.getTime() <= from) dayDiff = 7
        next.setDate(next.getDate() + dayDiff)
        if (next.getTime() < best) best = next.getTime()
      }
    } else {
      // 每月：dayOfMonth[] × timeOfDay[] 求最近未来组合
      const ds = daysOfMonth ?? DEFAULT_DAY_OF_MONTH
      for (const dom of ds) {
        const next = new Date(from)
        next.setSeconds(0, 0)
        next.setHours(hh, mm, 0, 0)
        // 先重置到当月 1 号再设日，避免当前日期为 31 时溢出
        next.setDate(1)
        const maxDay = daysInMonth(next.getFullYear(), next.getMonth())
        next.setDate(Math.min(dom, maxDay))
        if (next.getTime() <= from) {
          // 推到下个月
          next.setDate(1)
          next.setMonth(next.getMonth() + 1)
          next.setDate(Math.min(dom, daysInMonth(next.getFullYear(), next.getMonth())))
        }
        if (next.getTime() < best) best = next.getTime()
      }
    }
  }

  return Number.isFinite(best) ? best : from + FALLBACK_INTERVAL_MS
}

/** 获取全部定时任务（按 createdAt 升序，保持列表稳定） */
export function listAutomations(): Automation[] {
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
      dispatchBlockReason: pendingTriggers.find((trigger) => trigger.status === 'blocked')?.error,
    }
  }).sort((a, b) => a.createdAt - b.createdAt)
}

/** 按 ID 获取单个定时任务 */
export function getAutomation(id: string): Automation | undefined {
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
export function applyMaxRunsUpdate(
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
export function createAutomation(input: CreateAutomationInput): Automation {
  const index = readIndex()
  const now = Date.now()
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
    dayOfWeek,
    dayOfMonth,
    scheduledAt: input.scheduledAt,
    maxRuns: normalizeMaxRuns(input.maxRuns),
    agentRuntime: input.agentRuntime,
    channelId: input.channelId,
    modelId: input.modelId,
    workspaceId: input.workspaceId,
    permissionMode: input.permissionMode ?? AUTOMATION_DEFAULT_PERMISSION_MODE,
    presetId: input.presetId?.trim() || undefined,
    ...(input.presetId?.trim() ? { presetReference: presetReferenceForAutomation(input.workspaceId, input.presetId) } : {}),
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
export function updateAutomation(input: UpdateAutomationInput): Automation | undefined {
  const index = readIndex()
  const target = index.automations.find((a) => a.id === input.id)
  if (!target) return undefined

  const now = Date.now()
  const nextRoute = {
    workspaceId: input.workspaceId !== undefined ? (input.workspaceId || undefined) : target.workspaceId,
    channelId: input.channelId ?? target.channelId,
    modelId: input.modelId ?? target.modelId,
    agentRuntime: input.agentRuntime ?? target.agentRuntime,
    presetId: input.presetId !== undefined ? (input.presetId.trim() || undefined) : target.presetId,
    boundSessionId: input.boundSessionId !== undefined ? (input.boundSessionId.trim() || undefined) : target.boundSessionId,
  }
  const routeChanged = nextRoute.workspaceId !== target.workspaceId
    || nextRoute.channelId !== target.channelId
    || nextRoute.modelId !== target.modelId
    || nextRoute.agentRuntime !== target.agentRuntime
    || nextRoute.presetId !== target.presetId
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
export function deleteAutomation(id: string): boolean {
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
export function pauseAutomationsForWorkspace(workspaceId: string): string[] {
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

export function getAutomationTrigger(triggerId: string): AutomationTriggerRecord | undefined {
  return readIndex().triggers?.find((trigger) => trigger.triggerId === triggerId)
}

export function listAutomationTriggers(status?: AutomationTriggerRecord['status']): AutomationTriggerRecord[] {
  const records = readIndex().triggers ?? []
  return records.filter((record) => status === undefined || record.status === status)
}

/** 持久化触发去重与首次 occurrence；重复投递返回原记录，不改状态或时间。 */
export function enqueueAutomationTrigger(record: AutomationTriggerRecord): AutomationTriggerRecord {
  const index = readIndex()
  const before = index.triggers ?? []
  const existing = before.find((trigger) => trigger.triggerId === record.triggerId)
  if (existing && !(existing.status === 'cancelled' && record.status === 'queued')) return existing
  const base = existing ? before.filter((trigger) => trigger.triggerId !== record.triggerId) : before
  index.triggers = enqueueTrigger(base, record, Date.now())
  writeIndex(index)
  return index.triggers[index.triggers.length - 1]!
}

export function transitionAutomationTriggerRecord(
  triggerId: string,
  status: AutomationTriggerRecord['status'],
  patch: Partial<Pick<AutomationTriggerRecord, 'boundSessionId' | 'targetSessionId' | 'runId' | 'error'>> = {},
): AutomationTriggerRecord | undefined {
  const index = readIndex()
  const position = (index.triggers ?? []).findIndex((trigger) => trigger.triggerId === triggerId)
  if (position < 0) return undefined
  const next = transitionAutomationTrigger(index.triggers![position]!, status, Date.now(), patch)
  index.triggers![position] = next
  writeIndex(index)
  return next
}

export function linkAutomationTriggerRun(
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
  trigger.updatedAt = Date.now()
  writeIndex(index)
  return trigger
}

/** trigger 与运行历史在同一次原子写入中结算；重复终态不重复计数。 */
export function settleAutomationTrigger(triggerId: string, run: AutomationRun): Automation | undefined {
  const index = readIndex()
  const trigger = index.triggers?.find((record) => record.triggerId === triggerId)
  const target = trigger ? index.automations.find((automation) => automation.id === trigger.automationId) : undefined
  if (!trigger || !target || !['queued', 'blocked', 'running'].includes(trigger.status)) return undefined
  if (run.status === 'skipped') throw new Error('自动化 trigger 终态不能使用 skipped')
  if (trigger.runId && run.runId && trigger.runId !== run.runId) throw new Error('自动化终态 Run 与 trigger 已关联的 Run 不一致')
  const now = Date.now()
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
export function getPendingAutomationTrigger(automationId: string): AutomationTriggerRecord | undefined {
  return (readIndex().triggers ?? []).find((trigger) =>
    trigger.automationId === automationId && (trigger.status === 'queued' || trigger.status === 'blocked' || trigger.status === 'running'),
  )
}

/** 清除已暂停/删除前仍 queued 的触发；running 保留以便结算。 */
export function cancelQueuedAutomationTriggers(automationId: string, reason = '定时任务已暂停'): void {
  const index = readIndex()
  let changed = false
  index.triggers = (index.triggers ?? []).map((trigger) => {
    if (trigger.automationId !== automationId || trigger.status !== 'queued') return trigger
    changed = true
    return transitionAutomationTrigger(trigger, 'failed', Date.now(), { error: reason })
  })
  if (changed) writeIndex(index)
}

export function unblockAutomationTriggers(automationId: string): void {
  const index = readIndex()
  let changed = false
  index.triggers = (index.triggers ?? []).map((trigger) => {
    if (trigger.automationId !== automationId || trigger.status !== 'blocked') return trigger
    changed = true
    return transitionAutomationTrigger(trigger, 'queued', Date.now(), { error: undefined })
  })
  if (changed) writeIndex(index)
}

/** 最近 trigger ledger 为独立运行事实，不写入 AutomationRun history。 */
export function removeAutomationTriggers(automationId: string): void {
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
export function appendRun(id: string, run: AutomationRun): Automation | undefined {
  const index = readIndex()
  const target = index.automations.find((a) => a.id === id)
  if (!target) return undefined

  applyAutomationRun(target, run, Date.now())
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
export function setNextRunAt(id: string, nextRunAt: number): void {
  const index = readIndex()
  const target = index.automations.find((a) => a.id === id)
  if (!target) return
  target.nextRunAt = nextRunAt
  writeIndex(index)
}

/** 记录本任务最近一次运行创建的会话 ID */
export function setLastSessionId(id: string, sessionId: string): void {
  const index = readIndex()
  const target = index.automations.find((a) => a.id === id)
  if (!target) return
  target.lastSessionId = sessionId
  writeIndex(index)
}

/** 仅测试：清空进程内缓存与镜像签名，回到首次启动状态。 */
export function __resetAutomationManagerForTests(): void {
  cachedIndex = null
  reconciledAutomationRoots.clear()
  mirroredAutomationSignatures.clear()
}

/** 启动时补齐项目任务镜像（不等待下一次写盘）。 */
export function ensureProjectAutomationMirrors(): void {
  const index = readIndex()
  mirrorProjectAutomations(index)
}
