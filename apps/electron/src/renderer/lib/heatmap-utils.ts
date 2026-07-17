/**
 * 工作区热力图 — 类型与工具函数
 *
 * 复用 OpenCovibe 的百分位分级思路：
 * 取所有非零值的 P25 / P50 / P75 作为颜色阈值，而非固定值。
 * 这样颜色深度是相对自身历史的，不会出现"全绿"或"全白"。
 */

/** 按天聚合的编码活跃条目 */
export interface WorkspaceHeatmapEntry {
  /** ISO 日期，如 "2026-07-16" */
  date: string
  /** 当日消耗的 token 数（input + output） */
  tokens: number
}

/** 计算 [p25, p50, p75] 百分位阈值。只对非零值做分级，空则返回 [0,0,0] */
export function computePercentileThresholds(values: number[]): [number, number, number] {
  const nonZero = values.filter((v) => v > 0).sort((a, b) => a - b)
  if (nonZero.length === 0) return [0, 0, 0]
  const p = (pct: number): number => {
    const idx = Math.floor((pct / 100) * (nonZero.length - 1))
    return nonZero[idx] ?? 0
  }
  return [p(25), p(50), p(75)]
}

/** 根据百分位阈值将数值映射为 0-4 的颜色等级 */
export function valueToLevel(value: number, thresholds: [number, number, number]): 0 | 1 | 2 | 3 | 4 {
  if (value <= 0) return 0
  if (value <= thresholds[0]) return 1
  if (value <= thresholds[1]) return 2
  if (value <= thresholds[2]) return 3
  return 4
}

/**
 * 将后端返回的 WorkspaceHeatmapEntry[] 转成热力图渲染格式。
 * 每一天的 level 由当日 tokens 在所有非零值中的百分位决定。
 */
export function toCalendarData(entries: WorkspaceHeatmapEntry[]): Array<{ date: string; tokens: number; level: number }> {
  const thresholds = computePercentileThresholds(entries.map((e) => e.tokens))
  return entries.map((e) => ({
    date: e.date,
    tokens: e.tokens,
    level: valueToLevel(e.tokens, thresholds),
  }))
}
