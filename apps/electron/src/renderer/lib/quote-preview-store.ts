import * as React from 'react'

/**
 * 引用预览的「当前活跃者」单例。
 *
 * 为什么需要：每个胶囊都是独立的 TipTap nodeView，各自持有本地开关；节点在
 * 重排编号/重渲染时会被销毁重建，`mouseleave` 不一定会派发，于是旧预览可能
 * 残留在 body 上，和新预览同时出现。这里用模块级单例做仲裁：**同一时刻只允许
 * 一个预览存在**，后开的直接顶掉前一个。
 */

/** 首次悬停的展开延迟（ms） */
export const QUOTE_PREVIEW_OPEN_DELAY = 750
/** 刚收起后再次悬停的延迟（ms）：几乎立即 */
export const QUOTE_PREVIEW_REOPEN_DELAY = 120

type Listener = () => void

let activeId: string | null = null
/** 当前活跃预览的「被顶掉时怎么收」回调：由打开它的胶囊注册 */
let activeClose: (() => void) | null = null
const listeners = new Set<Listener>()

/** 上次**开始**收起预览的时间：短时间内再次悬停几乎立即展开 */
let lastClosedAt = 0

/**
 * 收起**开始**时调用（不是动画结束时）。
 *
 * 若等 140ms 退场播完再记录，用户在退场期间移到下一条胶囊会拿不到冷却标记，
 * 又要重新等 750ms——这正是「挪到另一个不立刻触发」的原因。
 */
export function markQuotePreviewClosing(): void {
  lastClosedAt = Date.now()
}

/**
 * 展开延迟：
 * - 已有别的预览开着 → 0ms（直接接手，交叉淡出）
 * - 刚收起过（2 秒内）→ 120ms
 * - 其余 → 750ms
 */
export function resolveQuotePreviewDelay(): number {
  if (activeId !== null) return 0
  return Date.now() - lastClosedAt < 2000 ? QUOTE_PREVIEW_REOPEN_DELAY : QUOTE_PREVIEW_OPEN_DELAY
}

function emit(): void {
  for (const listener of listeners) listener()
}

/**
 * 占位/释放预览。
 *
 * @param onSuperseded 被别的胶囊顶掉时如何收起自己（通常是 `beginClose`）。
 *   这样「关闭上一个」由打开者直接调用，不需要所有胶囊订阅全局状态——
 *   少一次全量重渲染，也就少一次编辑器失焦的机会。
 */
export function setActiveQuotePreview(id: string | null, onSuperseded?: () => void): void {
  if (activeId === id) {
    if (onSuperseded) activeClose = onSuperseded
    return
  }
  const previousClose = activeClose
  activeId = id
  activeClose = id ? (onSuperseded ?? null) : null
  if (id !== null && previousClose) previousClose()
  emit()
}

export function getActiveQuotePreview(): string | null {
  return activeId
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 订阅当前活跃预览 id（React 18 useSyncExternalStore，避免 tearing）。 */
export function useActiveQuotePreviewId(): string | null {
  return React.useSyncExternalStore(subscribe, getActiveQuotePreview, getActiveQuotePreview)
}
