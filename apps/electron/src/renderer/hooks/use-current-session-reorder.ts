/**
 * 「当前会话」区拖拽重排的状态与事件处理
 *
 * 从 `CurrentSessionSection` 抽离：视图只负责渲染，协议、索引换算与状态都在这里。
 * 顺序写回 `tabsAtom`（顶部 Tab 栏共用同一事实源，`main.tsx` 的订阅会自动落盘）。
 */

import * as React from 'react'
import { useSetAtom } from 'jotai'
import { reorderTabs, tabsAtom } from '@/atoms/tab-atoms'
import {
  acceptCurrentSessionReorderDrag,
  clearCurrentSessionReorderDragState,
  getActiveCurrentSessionReorderTabId,
  isCurrentSessionReorderDrag,
  normalizeDropTarget,
  resolveReorderDropPosition,
  resolveReorderTargetIndex,
  setCurrentSessionReorderDragData,
  type ReorderDropTarget,
} from '@/lib/current-session-reorder'

/**
 * 鼠标停留多久才让位显示把手。快速扫过列表时每行都跳 20px 很吵，
 * 延迟一拍后只有真正停留的那一行会让位；进入重排态则立即全部显示，不受此延迟影响。
 */
export const REORDER_HOVER_DELAY_MS = 100

export interface CurrentSessionReorder {
  /** 正在被拖的 tabId；非 null 表示整个列表处于「重排态」 */
  draggingTabId: string | null
  isReordering: boolean
  /** 已停留超过延迟的行；与 isReordering 共同决定该行是否让位 */
  hoveredTabId: string | null
  /** 仅用于绘制插入指示线，不参与 drop 判定 */
  dropIndicator: ReorderDropTarget | null
  onHandleDragStart: (e: React.DragEvent, tabId: string) => void
  onHandleDragEnd: () => void
  /** 行级 hover 延迟：快速扫过不触发让位，离开立即收起 */
  onRowMouseEnter: (tabId: string) => void
  onRowMouseLeave: () => void
  /** 列表容器级：整个区域（含行间 gap、空白、滚动槽位）统一声明可放下 */
  onListDragEnter: (e: React.DragEvent) => void
  onListDragOver: (e: React.DragEvent) => void
  onListDrop: (e: React.DragEvent) => void
  onRowDragOver: (e: React.DragEvent, tabId: string, nextTabId: string | null) => void
  onRowDrop: (e: React.DragEvent, tabId: string, nextTabId: string | null) => void
}

export function useCurrentSessionReorder(): CurrentSessionReorder {
  const setTabs = useSetAtom(tabsAtom)
  const [draggingTabId, setDraggingTabId] = React.useState<string | null>(null)
  const [hoveredTabId, setHoveredTabId] = React.useState<string | null>(null)
  const [dropIndicator, setDropIndicator] = React.useState<ReorderDropTarget | null>(null)
  const hoverTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearHoverTimer = React.useCallback((): void => {
    if (hoverTimerRef.current !== null) {
      clearTimeout(hoverTimerRef.current)
      hoverTimerRef.current = null
    }
  }, [])

  // 组件卸载（切换模式 / 关闭当前会话区）时别留下一个会 setState 的定时器
  React.useEffect(() => () => clearHoverTimer(), [clearHoverTimer])

  const onRowMouseEnter = React.useCallback((tabId: string): void => {
    clearHoverTimer()
    hoverTimerRef.current = setTimeout(() => {
      hoverTimerRef.current = null
      setHoveredTabId(tabId)
    }, REORDER_HOVER_DELAY_MS)
  }, [clearHoverTimer])

  const onRowMouseLeave = React.useCallback((): void => {
    clearHoverTimer()
    setHoveredTabId(null)
  }, [clearHoverTimer])

  const clearDragState = React.useCallback((): void => {
    setDraggingTabId(null)
    setDropIndicator(null)
    clearCurrentSessionReorderDragState()
  }, [])

  const onHandleDragStart = React.useCallback((e: React.DragEvent, tabId: string): void => {
    // drag 期间 mouseenter/mouseleave 被浏览器抑制，挂起的 timer 不该在拖拽中途触发
    clearHoverTimer()
    setCurrentSessionReorderDragData(e.dataTransfer, tabId)
    setDraggingTabId(tabId)
  }, [clearHoverTimer])

  /**
   * 容器级 dragenter / dragover 必须 preventDefault，浏览器才认为整个区域可放下。
   * 只绑在行上会导致指针经过行间 1px gap、padding 或滚动槽位时，事件落在容器上无人接管，
   * 光标在「可放下 / 禁止」之间频繁闪烁。
   */
  const onListDragEnter = React.useCallback((e: React.DragEvent): void => {
    acceptCurrentSessionReorderDrag(e)
  }, [])

  const onListDragOver = React.useCallback((e: React.DragEvent): void => {
    if (!acceptCurrentSessionReorderDrag(e)) return
    // 指针落在行间或空白（target 就是容器本身）时收起指示线，避免停在最后一次 hover 的行上
    if (e.target === e.currentTarget) setDropIndicator(null)
  }, [])

  /** 落在空白处：不重排，但要收起重排态，避免拖拽结束后整列还保持让位 */
  const onListDrop = React.useCallback((e: React.DragEvent): void => {
    if (!isCurrentSessionReorderDrag(e.dataTransfer)) return
    e.preventDefault()
    clearDragState()
  }, [clearDragState])

  const onRowDragOver = React.useCallback((e: React.DragEvent, tabId: string, nextTabId: string | null): void => {
    if (!acceptCurrentSessionReorderDrag(e)) return
    const dragged = getActiveCurrentSessionReorderTabId(e.dataTransfer)
    if (!dragged || dragged === tabId) { setDropIndicator(null); return }
    const rect = e.currentTarget.getBoundingClientRect()
    const position = resolveReorderDropPosition(e.clientY, rect.top, rect.height)
    // 「本行之后」与「下一行之前」是同一个插入点，规范化后只画一根线
    const target = normalizeDropTarget(tabId, position, nextTabId)
    setDropIndicator((prev) => (
      prev?.tabId === target.tabId && prev.position === target.position ? prev : target
    ))
  }, [])

  /**
   * drop 时直接用事件的 clientY 重算插入位置，不读 `dropIndicator` state：
   * 快速拖放时 React 批处理可能让 state 还没跟上，依赖它会静默丢掉这次重排。
   * stopPropagation 避免冒泡到容器的 onListDrop 再清一次状态。
   */
  const onRowDrop = React.useCallback((e: React.DragEvent, targetTabId: string, nextTabId: string | null): void => {
    e.preventDefault()
    e.stopPropagation()
    const dragged = getActiveCurrentSessionReorderTabId(e.dataTransfer)
    const rect = e.currentTarget.getBoundingClientRect()
    const position = resolveReorderDropPosition(e.clientY, rect.top, rect.height)
    // 与指示线用同一套规范化：线画在哪里，放下就插到哪里
    const target = normalizeDropTarget(targetTabId, position, nextTabId)
    clearDragState()
    if (!dragged) return
    setTabs((previous) => {
      const insertIndex = resolveReorderTargetIndex(previous, dragged, target.tabId, target.position)
      if (insertIndex === null) return previous
      const fromIndex = previous.findIndex((tab) => tab.id === dragged)
      return reorderTabs(previous, fromIndex, insertIndex)
    })
  }, [clearDragState, setTabs])

  return {
    draggingTabId,
    isReordering: draggingTabId !== null,
    hoveredTabId,
    dropIndicator,
    onHandleDragStart,
    onHandleDragEnd: clearDragState,
    onRowMouseEnter,
    onRowMouseLeave,
    onListDragEnter,
    onListDragOver,
    onListDrop,
    onRowDragOver,
    onRowDrop,
  }
}
