/**
 * 会话悬浮预览的判定规则（纯函数，便于单测）
 *
 * 侧栏会话行被指针扫过就弹预览是「不小心弹出来」的主因，这里把两条规则抽成可测函数：
 * - 悬停意图：指针在行内持续位移视为「路过」，重新计时；小抖动不打断计时（否则手抖永远弹不出来）。
 * - 设置归一：只有显式 `false` 才关闭预览，缺省或读失败保持开启，不改变既有行为。
 */

export interface HoverPoint {
  x: number
  y: number
}

/** 指针在行内位移超过该值（px）就视为仍在移动，重新计时 */
export const HOVER_INTENT_MOVE_TOLERANCE = 12

/** 指针相对上次采样点移动是否已超过容差（超过 = 只是路过，需要重新计时） */
export function isHoverIntentMove(
  origin: HoverPoint | null,
  next: HoverPoint,
  tolerance: number = HOVER_INTENT_MOVE_TOLERANCE,
): boolean {
  if (!origin) return false
  return Math.hypot(next.x - origin.x, next.y - origin.y) > tolerance
}

/** 归一「会话悬浮预览」开关：缺省 / 读取失败一律按开启处理 */
export function resolveSessionHoverPreviewEnabled(
  settings: { sessionHoverPreviewEnabled?: boolean } | null | undefined,
): boolean {
  return settings?.sessionHoverPreviewEnabled !== false
}
