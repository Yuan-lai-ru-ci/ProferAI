import { normalizeTimeOfDay, normalizeDayOfWeek, normalizeDayOfMonth, DEFAULT_TIME_OF_DAY, DEFAULT_DAY_OF_WEEK, DEFAULT_DAY_OF_MONTH, type Automation } from '@profer/shared'

export function computeNextRunAt(
  a: { scheduleType: Automation['scheduleType'] } & Partial<
    Pick<Automation, 'intervalMinutes' | 'timeOfDay' | 'dayOfWeek' | 'dayOfMonth' | 'scheduledAt' | 'timeZone'>
  >,
  from: number = Date.now(),
): number {
  const FALLBACK_INTERVAL_MS = 10 * 60_000
  if (a.timeZone && !['interval', 'once'].includes(a.scheduleType)) return computeZonedNextRunAt(a, from)

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


/** 用任务时区解释墙上时间，不改变进程TZ。DST缺失时刻跳过，重复时刻选下一个未来实例。 */
function computeZonedNextRunAt(a: Parameters<typeof computeNextRunAt>[0], from: number): number {
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: a.timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
  const parts = (at: number) => {
    const values = Object.fromEntries(formatter.formatToParts(at).map(part => [part.type, part.value]))
    return { y: Number(values.year), m: Number(values.month), d: Number(values.day), h: Number(values.hour), min: Number(values.minute), sec: Number(values.second) }
  }
  const start = parts(from)
  const times = normalizeTimeOfDay(a.timeOfDay); if (!times.length) times.push(...DEFAULT_TIME_OF_DAY)
  const weekdays = normalizeDayOfWeek(a.dayOfWeek); if (!weekdays.length) weekdays.push(...DEFAULT_DAY_OF_WEEK)
  const monthdays = normalizeDayOfMonth(a.dayOfMonth); if (!monthdays.length) monthdays.push(...DEFAULT_DAY_OF_MONTH)
  for (let day = 0; day < 370; day++) {
    const date = new Date(Date.UTC(start.y, start.m - 1, start.d + day))
    const y = date.getUTCFullYear(), m = date.getUTCMonth() + 1, d = date.getUTCDate()
    if (a.scheduleType === 'weekly' && !weekdays.includes(date.getUTCDay())) continue
    if (a.scheduleType === 'monthly' && !monthdays.some(value => Math.min(value, new Date(Date.UTC(y, m, 0)).getUTCDate()) === d)) continue
    let best = Infinity
    for (const time of times) {
      const [h, min] = time.split(':').map(Number) as [number, number]
      const wall = Date.UTC(y, m - 1, d, h, min)
      const offsets = new Set<number>()
      for (let delta = -48; delta <= 48; delta += 6) {
        const sample = wall + delta * 3600000, p = parts(sample)
        offsets.add(Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.sec) - sample)
      }
      for (const offset of offsets) {
        const at = wall - offset, p = parts(at)
        if (at > from && p.y === y && p.m === m && p.d === d && p.h === h && p.min === min) best = Math.min(best, at)
      }
    }
    if (Number.isFinite(best)) return best
  }
  throw new Error('任务时区内一年内没有有效调度时刻')
}

export function automationDayKey(at: number, timeZone?: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at)
}
