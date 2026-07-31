/**
 * 定时任务触发时间展开（日历视图展示用）
 *
 * 调度器（apps/electron/src/main/lib/automation-manager.ts）持久化 nextRunAt 锚点；
 * 日历月/周视图需要看到可见范围内的全部未来触发时间，这里按调度规则展开。
 *
 * 本实现适配 Profer 的多值调度（timeOfDay/dayOfWeek/dayOfMonth 为数组）：
 * - interval 从 nextRunAt 等距累加（锚点语义）
 * - daily：从 nextRunAt 天起逐天推进，匹配 timeOfDay[] 每个时刻
 * - weekly：按 dayOfWeek[] × timeOfDay[] 在每个 7 天窗口内展开（多星期分组）
 * - monthly：按 dayOfMonth[] × timeOfDay[] 在每月内展开（多日期）
 * - once：只在 scheduledAt 单点
 *
 * 展开规则与主进程 computeNextRunAtMulti 保持一致；monthly 短月钳制（min(dayOfMonth, 当月天数)）。
 */

import type { Automation } from '../types/automation'
import { normalizeTimeOfDay, normalizeDayOfWeek, normalizeDayOfMonth } from '../types/automation'

/** 展开所需的调度字段（Automation 子集，方便单测与复用） */
export type AutomationScheduleFields = Pick<Automation, 'scheduleType' | 'nextRunAt'> &
  Partial<
    Pick<Automation, 'intervalMinutes' | 'timeOfDay' | 'dayOfWeek' | 'dayOfMonth' | 'scheduledAt' | 'maxRuns' | 'runCount'>
  >

/** 一天内的触发分布 */
export interface AutomationOccurrenceDay {
  /** 当天 0 点（本地）时间戳 */
  day: number
  /** 当天触发时刻（升序）。密集任务只保留前 AUTOMATION_OCCURRENCE_SAMPLES_PER_DAY 个，完整次数看 count */
  times: number[]
  /** 当天实际触发总次数 */
  count: number
}

/** 每天最多保留的触发时刻样本数（UI 用于逐点展示或取首次时间；超过则以 count 聚合展示） */
export const AUTOMATION_OCCURRENCE_SAMPLES_PER_DAY = 4

/** 迭代兜底上限：interval=1min × 月视图 42 天 ≈ 6 万次，10 万足以覆盖正常场景且不会失控 */
const MAX_ITERATIONS = 100_000

/** 一天毫秒数 */
const DAY_MS = 86_400_000

function startOfDayTs(value: number): number {
  const date = new Date(value)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate()
}

/** 生成 timeOfDay[] 在指定本地日期上的时刻戳（升序） */
function timesOnDate(year: number, month: number, dateNum: number, timesOfDay: string[]): number[] {
  const out: number[] = []
  for (const tod of timesOfDay) {
    const parts = tod.split(':').map(Number)
    const hh = Number.isFinite(parts[0]) ? Math.max(0, Math.min(23, parts[0]!)) : 9
    const mm = Number.isFinite(parts[1]) ? Math.max(0, Math.min(59, parts[1]!)) : 0
    const d = new Date(year, month, dateNum)
    d.setHours(hh, mm, 0, 0)
    out.push(d.getTime())
  }
  return out.sort((a, b) => a - b)
}

/** 确保后续表达式为 boolean */
function clampDom(dom: number, lastDay: number): number {
  return Math.max(1, Math.min(dom, lastDay))
}

/**
 * 生成 [rangeStart, rangeEnd] 内的全部触发时刻（升序），以 nextRunAt 为锚点推进。
 * - 只展开 >= nextRunAt 的点（调度权威：nextRunAt 之前的周期不会发生）
 * - maxRuns 限制剩余可运行次数（maxRuns - runCount）；once 天然只有 1 个点
 * - interval 从 nextRunAt 等距累加，跨度大时先数学快进
 */
function* iterateOccurrences(
  automation: AutomationScheduleFields,
  rangeStart: number,
  rangeEnd: number,
): Generator<number> {
  const { nextRunAt } = automation
  if (!Number.isFinite(nextRunAt) || nextRunAt <= 0) return
  const remaining =
    automation.maxRuns !== undefined
      ? Math.max(0, automation.maxRuns - (automation.runCount ?? 0))
      : Number.POSITIVE_INFINITY
  if (remaining <= 0) return

  let produced = 0

  // once
  if (automation.scheduleType === 'once') {
    if (nextRunAt >= rangeStart && nextRunAt <= rangeEnd) yield nextRunAt
    return
  }

  // interval
  if (automation.scheduleType === 'interval') {
    const minutes = Number(automation.intervalMinutes)
    if (!Number.isFinite(minutes) || minutes < 1) return
    const step = minutes * 60_000
    let ts = nextRunAt
    if (ts < rangeStart) {
      const skip = Math.floor((rangeStart - ts) / step)
      ts += skip * step
    }
    let guard = 0
    while (ts <= rangeEnd && produced < remaining && guard < MAX_ITERATIONS) {
      guard++
      if (ts >= rangeStart) {
        produced++
        yield ts
      }
      ts += step
    }
    return
  }

  // daily / weekly / monthly：多值字段归一化
  const timesOfDay = normalizeTimeOfDay(automation.timeOfDay as string | string[] | undefined)
  if (timesOfDay.length === 0) return

  let guard = 0

  if (automation.scheduleType === 'daily') {
    let cursor = new Date(startOfDayTs(nextRunAt))
    while (cursor.getTime() <= rangeEnd && produced < remaining && guard < MAX_ITERATIONS) {
      guard++
      for (const ts of timesOnDate(cursor.getFullYear(), cursor.getMonth(), cursor.getDate(), timesOfDay)) {
        if (ts >= nextRunAt && ts >= rangeStart && ts <= rangeEnd) {
          produced++
          yield ts
        }
        if (produced >= remaining) return
      }
      cursor.setDate(cursor.getDate() + 1)
    }
    return
  }

  if (automation.scheduleType === 'weekly') {
    const dowSet = normalizeDayOfWeek(automation.dayOfWeek as number | number[] | undefined)
    const dowList = dowSet.length > 0 ? dowSet : [nextRunAt ? new Date(nextRunAt).getDay() : 1]
    // 从 nextRunAt 所在周的周一开始，逐周推进
    let weekStart = new Date(startOfDayTs(nextRunAt))
    weekStart.setDate(weekStart.getDate() - weekStart.getDay() + 1) // 本周一
    while (produced < remaining && guard < MAX_ITERATIONS) {
      guard++
      const weekEnd = weekStart.getTime() + 7 * DAY_MS
      for (let d = 0; d < 7; d++) {
        const dayCursor = new Date(weekStart.getTime() + d * DAY_MS)
        if (!dowList.includes(dayCursor.getDay())) continue
        for (const ts of timesOnDate(dayCursor.getFullYear(), dayCursor.getMonth(), dayCursor.getDate(), timesOfDay)) {
          if (ts >= nextRunAt && ts >= rangeStart && ts <= rangeEnd) {
            produced++
            yield ts
          }
          if (produced >= remaining) return
        }
      }
      if (weekStart.getTime() > rangeEnd) break
      weekStart = new Date(weekStart.getTime() + 7 * DAY_MS)
      if (weekEnd > rangeEnd + 7 * DAY_MS) break
    }
    return
  }

  // monthly
  const domSet = normalizeDayOfMonth(automation.dayOfMonth as number | number[] | undefined)
  const domList = domSet.length > 0 ? domSet : [1]
  // 从 nextRunAt 所在月份开始推进
  const anchor = new Date(nextRunAt)
  let monthCursor = new Date(anchor.getFullYear(), anchor.getMonth(), 1)
  while (produced < remaining && guard < MAX_ITERATIONS) {
    guard++
    const lastDay = daysInMonth(monthCursor.getFullYear(), monthCursor.getMonth())
    for (const dom of domList) {
      const dayCursor = new Date(monthCursor.getFullYear(), monthCursor.getMonth(), clampDom(dom, lastDay))
      for (const ts of timesOnDate(dayCursor.getFullYear(), dayCursor.getMonth(), dayCursor.getDate(), timesOfDay)) {
        if (ts >= nextRunAt && ts >= rangeStart && ts <= rangeEnd) {
          produced++
          yield ts
        }
        if (produced >= remaining) return
      }
    }
    const thisMonthEnd = new Date(monthCursor.getFullYear(), monthCursor.getMonth() + 1, 0).getTime()
    if (thisMonthEnd > rangeEnd) break
    monthCursor = new Date(monthCursor.getFullYear(), monthCursor.getMonth() + 1, 1)
  }
}

/**
 * 展开定时任务在 [rangeStart, rangeEnd] 范围内的触发时间，按天聚合（升序）。
 * 供日历月视图（每天一个标记 + ×N）与周视图（逐点展示或按天聚合）使用。
 */
export function getAutomationOccurrencesByDay(
  automation: AutomationScheduleFields,
  rangeStart: number,
  rangeEnd: number,
): AutomationOccurrenceDay[] {
  if (rangeEnd < rangeStart) return []
  const byDay = new Map<number, AutomationOccurrenceDay>()
  for (const ts of iterateOccurrences(automation, rangeStart, rangeEnd)) {
    const day = startOfDayTs(ts)
    let bucket = byDay.get(day)
    if (!bucket) {
      bucket = { day, times: [], count: 0 }
      byDay.set(day, bucket)
    }
    bucket.count++
    if (bucket.times.length < AUTOMATION_OCCURRENCE_SAMPLES_PER_DAY) bucket.times.push(ts)
  }
  return [...byDay.values()].sort((a, b) => a.day - b.day)
}
