/**
 * 左侧栏「当前会话」区拖拽重排：拖放协议与索引换算
 *
 * 与 `session-reference-drag.ts`（拖会话到输入框当引用）是两种不同交互、各自一个 MIME，
 * 但共用同一套 HTML5 drag 机制：把手独立可拖，行体仍可拖作引用，两者互不干扰。
 *
 * dragover 阶段读不到 dataTransfer 的 payload（浏览器规范），所以和引用协议一样，
 * 用模块内存态记住正在拖的 tabId；drop 时再按真实 tabs 数组换算索引。
 */

export const CURRENT_SESSION_REORDER_MIME = 'application/x-profer-current-session-reorder'

export type ReorderDropPosition = 'before' | 'after'

let activeReorderTabId: string | null = null

export function setCurrentSessionReorderDragData(dataTransfer: DataTransfer, tabId: string): void {
  activeReorderTabId = tabId
  // 只写自定义 MIME，不写 text/plain：drop 目标是本区自己的行，用 types 判定即可；
  // 写 text/plain 会让用户误把把手拖进输入框时插入一串裸 tab id。
  dataTransfer.setData(CURRENT_SESSION_REORDER_MIME, tabId)
  dataTransfer.effectAllowed = 'move'
}

export function isCurrentSessionReorderDrag(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes(CURRENT_SESSION_REORDER_MIME)
}

/** 只依赖拖放事件的最小结构，便于纯函数测试，不绑定 React 事件类型 */
export interface ReorderDragEventLike {
  dataTransfer: DataTransfer
  preventDefault: () => void
}

/**
 * 声明「此处可放下」并统一光标。
 *
 * HTML5 规定：dragover / dragenter 必须 preventDefault，浏览器才把当前位置当作合法 drop 目标，
 * 否则显示禁止光标。容器与行都要调用它——指针经过行间 gap、滚动槽位或容器内空白时，
 * dragover 的 target 是列表容器而不是任何一行，只靠行级 preventDefault 会让光标频繁闪成禁止。
 */
export function acceptCurrentSessionReorderDrag(e: ReorderDragEventLike): boolean {
  if (!isCurrentSessionReorderDrag(e.dataTransfer)) return false
  e.preventDefault()
  e.dataTransfer.dropEffect = 'move'
  return true
}

/** dragover 无法读取 payload，只能结合可枚举的 MIME type 使用 dragstart 内存态。 */
export function getActiveCurrentSessionReorderTabId(dataTransfer: DataTransfer): string | null {
  return isCurrentSessionReorderDrag(dataTransfer) ? activeReorderTabId : null
}

export function clearCurrentSessionReorderDragState(): void {
  activeReorderTabId = null
}

/** 根据指针在目标行内的相对位置判定插入到前还是后 */
export function resolveReorderDropPosition(clientY: number, top: number, height: number): ReorderDropPosition {
  return height > 0 && (clientY - top) / height < 0.5 ? 'before' : 'after'
}

export interface ReorderDropTarget {
  tabId: string
  position: ReorderDropPosition
}

/**
 * 把「插到某行之后」规范化为「插到下一行之前」。
 *
 * 相邻两行交界处，「上一行的 after」和「下一行的 before」本是同一个插入点，
 * 但前者画在上一行底部、后者画在下一行顶部，隔着 2px 线高 + 1px gap 并不重合，
 * 鼠标轻微上下移动就会看到两根线来回跳。规范化后同一个插入点只有一根线、一个位置。
 * 最后一行没有下一行，保留 after，线画在它底部。
 */
export function normalizeDropTarget(
  tabId: string,
  position: ReorderDropPosition,
  nextTabId: string | null,
): ReorderDropTarget {
  return position === 'after' && nextTabId
    ? { tabId: nextTabId, position: 'before' }
    : { tabId, position }
}

/**
 * 把「把 dragged 放到 target 的前/后」换算成 `reorderTabs(tabs, fromIndex, insertIndex)` 的插入索引。
 *
 * 关键：**不能用侧栏里的行号**。`getOpenSessionEntries` 已过滤掉 Scratch Pad、preview、
 * browser 等工作 Tab，侧栏第 0 行在 `tabsAtom` 里可能是第 3 项；这里一律按 tab.id 查找真实索引。
 *
 * `reorderTabs` 的语义是先 splice(fromIndex, 1) 再 splice(insertIndex, 0, moved)，
 * 因此从前往后拖时目标索引要减 1 补偿被移走的那一项。
 */
export function resolveReorderTargetIndex(
  tabs: readonly { id: string }[],
  draggedTabId: string,
  targetTabId: string,
  position: ReorderDropPosition,
): number | null {
  if (draggedTabId === targetTabId) return null
  const fromIndex = tabs.findIndex((tab) => tab.id === draggedTabId)
  const toIndex = tabs.findIndex((tab) => tab.id === targetTabId)
  if (fromIndex < 0 || toIndex < 0) return null
  const adjustedToIndex = fromIndex < toIndex ? toIndex - 1 : toIndex
  return position === 'after' ? adjustedToIndex + 1 : adjustedToIndex
}
