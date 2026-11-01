/**
 * navigation-turns — 把「逐条消息」的导航条目折叠成「一轮对话」。
 *
 * 导航索引是按消息给的（用户一条、助手一条、系统状态一条），但人找东西时想的是
 * 「我问了什么、它答了什么」，不是「第 17 条消息」。所以迷你地图与导航面板都以
 * **轮**为单位：一条用户消息开一轮，后面跟的助手回复与收尾状态都归这一轮。
 *
 * 纯函数、无 React/Jotai 依赖，便于单测锁住分组与锚点语义。
 */
import { navigationItemKey, type NavigationKeyedItem } from './navigation-item-key'

/** 参与分轮的最小条目结构（MinimapItem / NavigationItem 都满足）。 */
export interface NavigationTurnItem extends NavigationKeyedItem {
  role: 'user' | 'assistant' | 'status'
  preview: string
  /** true 时作为独立一轮的起点，避免有内容的状态卡被并入前一轮。 */
  startsTurn?: boolean
}

export interface NavigationTurn<T extends NavigationTurnItem = NavigationTurnItem> {
  /** 稳定键：取自本轮锚点，与导航索引的去重键同一套。 */
  key: string
  /** 跳转锚点：优先用户消息（「回到这一轮」就是回到自己问的那句）。 */
  anchor: T
  /** 本轮的用户消息；会话首条不是用户消息时缺省。 */
  user?: T
  /** 本轮的第一条助手回复；多段回复时其余只在 `items` 里（预览只取首条）。 */
  assistant?: T
  /** 本轮收尾的系统状态（中断记录等），最多保留一条。 */
  status?: T
  /** 本轮全部条目，用于「是否在视口内 / 是否已加载」判定。 */
  items: T[]
  /** 预览文本：用户提问优先，其次助手，最后状态。 */
  preview: string
}

/**
 * 逐条条目 → 一轮一条目。
 *
 * 分轮规则刻意简单：
 * - `user` 开新轮；
 * - `assistant` / `status` 并入当前轮（没有当前轮时自成一「无提问轮」，例如会话以助手开场）；
 * - 中断记录、压缩记录这类 `status` 天然属于上一轮的收尾，不单独占一轮。
 */
export function groupNavigationTurns<T extends NavigationTurnItem>(
  items: ReadonlyArray<T>,
): NavigationTurn<T>[] {
  const turns: NavigationTurn<T>[] = []

  for (const item of items) {
    if (item.role === 'user' || item.startsTurn || turns.length === 0) {
      turns.push({
        key: navigationItemKey(item),
        anchor: item,
        user: item.role === 'user' ? item : undefined,
        assistant: item.role === 'assistant' ? item : undefined,
        status: item.role === 'status' ? item : undefined,
        items: [item],
        preview: item.preview,
      })
      continue
    }

    const turn = turns[turns.length - 1]!
    turn.items.push(item)
    if (item.role === 'assistant') {
      if (!turn.assistant) turn.assistant = item
    } else if (!turn.status) {
      turn.status = item
    }
  }

  for (const turn of turns) {
    turn.preview = turn.user?.preview ?? turn.assistant?.preview ?? turn.status?.preview ?? ''
  }

  return turns
}
