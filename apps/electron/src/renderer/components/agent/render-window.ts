/**
 * 渲染窗口 —— 把一轮回复拆成「过程」与「回复」两类段，各自独立套一个尾部窗口。
 *
 * 目的：过程（思考 + 工具调用）可能累积几百段，而用户真正要读的是回复正文。
 * 如果两类共用一个窗口，过程会把回复挤出可视范围；分开计数后，过程再长也不影响回复。
 *
 * 本模块只做「渲染裁剪」，不改动底层数据，也不影响任何派生计算（任务映射、迷你地图等）。
 * 展开/收起属于渲染层职责，这里只负责把被折叠的段原样交出去。
 */
import type { AssistantTurnRenderItem, IndexedContentBlock } from './render-block-derivation'

/** 段窗口配置；过程与回复分别计数 */
export interface RenderWindowLimits {
  /** 回复区保留的最近段数 */
  replySegments: number
  /** 过程区保留的最近段数 */
  processSegments: number
}

/** 初始粗值：回复按「2~3 屏」估，过程按「用户极少回看」估；后续按实测调整 */
export const DEFAULT_RENDER_WINDOW: RenderWindowLimits = {
  replySegments: 30,
  processSegments: 20,
}

export interface WindowedTurnItems<T extends IndexedContentBlock = IndexedContentBlock> {
  /** 窗口内的渲染项（保持原顺序） */
  items: AssistantTurnRenderItem<T>[]
  /** 过程区被折叠的段（最早的若干段，按原顺序） */
  foldedProcessItems: T[]
  /** 回复区被折叠的段（按原顺序） */
  foldedReplyItems: T[]
}

/**
 * 按过程/回复两个窗口裁剪一轮的渲染项。
 *
 * - 窗口锚定末尾：保留最近 N 段，更早的进 folded*Items
 * - 过程与回复独立计数，互不挤占
 * - 不修改入参，返回新数组
 */
export function applyRenderWindow<T extends IndexedContentBlock>(
  items: AssistantTurnRenderItem<T>[],
  limits: RenderWindowLimits = DEFAULT_RENDER_WINDOW,
): WindowedTurnItems<T> {
  const processLimit = Math.max(0, limits.processSegments)
  const replyLimit = Math.max(0, limits.replySegments)

  // 回复项（type === 'block'）在整轮里是连续的一段；先定位再统一取尾部窗口。
  const replyIndexes: number[] = []
  for (let index = 0; index < items.length; index++) {
    if (items[index]!.type === 'block') replyIndexes.push(index)
  }
  const replyKeepFrom = Math.max(0, replyIndexes.length - replyLimit)
  const visibleReplyIndexes = new Set(replyIndexes.slice(replyKeepFrom))
  const foldedReplyItems: T[] = replyIndexes
    .slice(0, replyKeepFrom)
    .map((index) => (items[index] as { type: 'block'; item: T }).item)

  const windowed: AssistantTurnRenderItem<T>[] = []
  let foldedProcessItems: T[] = []

  for (let index = 0; index < items.length; index++) {
    const item = items[index]!
    if (item.type === 'block') {
      if (visibleReplyIndexes.has(index)) windowed.push(item)
      continue
    }
    // 过程组：取尾部窗口（一轮里至多一个过程组）
    const keepFrom = Math.max(0, item.items.length - processLimit)
    foldedProcessItems = item.items.slice(0, keepFrom)
    windowed.push(keepFrom === 0 ? item : { type: 'process-group', items: item.items.slice(keepFrom) })
  }

  return { items: windowed, foldedProcessItems, foldedReplyItems }
}
