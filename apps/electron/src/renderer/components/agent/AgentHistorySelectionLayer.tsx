/**
 * AgentHistorySelectionLayer — Agent 历史选区引用入口
 *
 * 在 Agent 历史消息里划选文本后，提供轻量动作：
 * 添加到当前 Agent 输入框引用
 */

import * as React from 'react'
import { useSetAtom } from 'jotai'
import { toast } from 'sonner'
import { quotedSelectionMapAtom } from '@/atoms/preview-atoms'
import { SelectionActionPopover } from '@/components/selection/SelectionActionPopover'
import { SELECTION_ACTION_POPOVER_SELECTOR } from '@/lib/quoted-selection'

const MAX_AGENT_HISTORY_QUOTED_CHARS = 2000

interface AgentHistorySelection {
  text: string
  x: number
  y: number
  direction: 'up' | 'down'
  sourceLabel: string
  messageId?: string
  messageRole?: 'user' | 'assistant' | 'system'
}

interface AgentHistorySelectionLayerProps {
  sessionId: string
  rootRef: React.RefObject<HTMLDivElement>
}

function getElementFromNode(node: Node | null): Element | null {
  if (!node) return null
  return node instanceof Element ? node : node.parentElement
}

function normalizeSelectedText(text: string): string {
  return text.replace(/\s+\n/g, '\n').replace(/\n\s+/g, '\n').trim()
}

export interface SelectionRect {
  left: number
  top: number
  right: number
  bottom: number
  width: number
}

export interface SelectionAnchor {
  x: number
  y: number
  direction: 'up' | 'down'
}

/** 按钮与抬手点（或键盘选择时的选区底部兜底锚点）之间的间距，避免按钮紧贴抬手点。 */
const ANCHOR_GAP = 24

/** 锚点：水平居中于选区包围盒、垂直取鼠标抬手点（并留出间距），根据选择方向决定按钮展开方向——
 *  按钮始终落在抬手点的「选区外侧」，避免压住选中文字：
 *  - 抬手点在选区下半部（从上往下选）：按钮放抬手点下方（向下展开）
 *  - 抬手点在选区上半部（从下往上选）：按钮放抬手点上方（向上展开）
 *  键盘选择无抬手点（pointerY 为 null）时退回选区底部、向上展开兜底。 */
export function pickSelectionAnchor(anchorRect: SelectionRect, pointerY: number | null): SelectionAnchor {
  const x = anchorRect.left + anchorRect.width / 2
  if (pointerY == null) {
    return { x, y: anchorRect.bottom - ANCHOR_GAP, direction: 'up' }
  }
  const centerY = (anchorRect.top + anchorRect.bottom) / 2
  if (pointerY >= centerY) {
    return { x, y: pointerY + ANCHOR_GAP, direction: 'down' }
  }
  return { x, y: pointerY - ANCHOR_GAP, direction: 'up' }
}

function getRoleLabel(role?: string): string {
  if (role === 'user') return 'Agent 历史 · 用户消息'
  if (role === 'assistant') return 'Agent 历史 · Agent 回复'
  if (role === 'system') return 'Agent 历史 · 系统消息'
  return 'Agent 历史'
}

export function AgentHistorySelectionLayer({
  sessionId,
  rootRef,
}: AgentHistorySelectionLayerProps): React.ReactElement {
  const setQuotedSelectionMap = useSetAtom(quotedSelectionMapAtom)
  const [selection, setSelection] = React.useState<AgentHistorySelection | null>(null)
  const pointerSelectingRef = React.useRef(false)
  const pointerUpYRef = React.useRef<number | null>(null)
  const captureTimerRef = React.useRef<number | null>(null)

  const clearSelection = React.useCallback((): void => {
    setSelection(null)
  }, [])

  const captureSelection = React.useCallback((): void => {
    const root = rootRef.current
    if (!root) return
    const activeEl = document.activeElement
    if (activeEl?.closest?.(`.ProseMirror, [data-input-mode], ${SELECTION_ACTION_POPOVER_SELECTOR}`)) return

    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
      clearSelection()
      return
    }

    const range = sel.getRangeAt(0)
    const startEl = getElementFromNode(range.startContainer)
    const endEl = getElementFromNode(range.endContainer)
    if (!startEl || !endEl || !root.contains(startEl) || !root.contains(endEl)) {
      clearSelection()
      return
    }

    const startMessageEl = startEl.closest('[data-message-id]')
    const endMessageEl = endEl.closest('[data-message-id]')
    if (!startMessageEl || !endMessageEl) {
      clearSelection()
      return
    }

    const rawText = normalizeSelectedText(sel.toString())
    if (!rawText) {
      clearSelection()
      return
    }

    const truncated = rawText.length > MAX_AGENT_HISTORY_QUOTED_CHARS
    const text = truncated ? rawText.slice(0, MAX_AGENT_HISTORY_QUOTED_CHARS) : rawText
    // 锚点取选区包围盒：水平居中于选区、垂直取鼠标抬手点（松手必在视口内）。
    // 跨屏选区时包围盒 top/bottom 总有一端会滚出视口，固定取哪一端都会在某个选择方向下越界，故垂直跟随抬手点。
    const rect = range.getBoundingClientRect()
    const firstRect = range.getClientRects()[0]
    const anchorRect = rect.width > 0 || rect.height > 0 ? rect : firstRect
    if (!anchorRect) return
    const { x, y, direction } = pickSelectionAnchor(anchorRect, pointerUpYRef.current)

    const sameMessage = startMessageEl === endMessageEl
    const role = sameMessage
      ? (startMessageEl.getAttribute('data-message-role') as AgentHistorySelection['messageRole'] | null)
      : null
    const messageId = sameMessage ? startMessageEl.getAttribute('data-message-id') ?? undefined : undefined

    setSelection({
      text,
      x,
      y,
      direction,
      sourceLabel: sameMessage ? getRoleLabel(role ?? undefined) : 'Agent 历史 · 多条消息',
      messageId,
      messageRole: role ?? undefined,
    })

    if (truncated) {
      toast.warning(`已选中超过 ${MAX_AGENT_HISTORY_QUOTED_CHARS} 字符，仅引用前 ${MAX_AGENT_HISTORY_QUOTED_CHARS} 字符`, {
        id: `agent-history-selection-cap:${sessionId}`,
        duration: 3000,
      })
    }
  }, [clearSelection, rootRef, sessionId])

  const scheduleCaptureSelection = React.useCallback((): void => {
    if (captureTimerRef.current != null) {
      window.clearTimeout(captureTimerRef.current)
    }
    captureTimerRef.current = window.setTimeout(() => {
      captureTimerRef.current = null
      captureSelection()
    }, 80)
  }, [captureSelection])

  React.useEffect(() => {
    const onSelectionChange = (): void => {
      if (pointerSelectingRef.current) return
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed) clearSelection()
    }
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target
      if (target instanceof Element && target.closest(SELECTION_ACTION_POPOVER_SELECTOR)) return
      if (target instanceof Element && rootRef.current?.contains(target)) {
        pointerSelectingRef.current = true
        pointerUpYRef.current = null
        clearSelection()
        return
      }
      clearSelection()
    }
    const onPointerUp = (event: PointerEvent): void => {
      if (!pointerSelectingRef.current) return
      pointerSelectingRef.current = false
      pointerUpYRef.current = event.clientY
      scheduleCaptureSelection()
    }
    const onPointerCancel = (): void => {
      pointerSelectingRef.current = false
      pointerUpYRef.current = null
    }
    const onKeyUp = (event: KeyboardEvent): void => {
      if (!event.shiftKey && !['Shift', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) return
      // 键盘选择没有抬手点，清空后用选区底部兜底定位。
      pointerUpYRef.current = null
      scheduleCaptureSelection()
    }

    document.addEventListener('selectionchange', onSelectionChange)
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('pointerup', onPointerUp, true)
    document.addEventListener('pointercancel', onPointerCancel, true)
    document.addEventListener('keyup', onKeyUp, true)
    return () => {
      if (captureTimerRef.current != null) {
        window.clearTimeout(captureTimerRef.current)
        captureTimerRef.current = null
      }
      document.removeEventListener('selectionchange', onSelectionChange)
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('pointerup', onPointerUp, true)
      document.removeEventListener('pointercancel', onPointerCancel, true)
      document.removeEventListener('keyup', onKeyUp, true)
    }
  }, [clearSelection, rootRef, scheduleCaptureSelection])

  const handleAddToAgent = React.useCallback((): void => {
    if (!selection) return
    setQuotedSelectionMap((prev) => {
      const next = new Map(prev)
      next.set(sessionId, {
        text: selection.text,
        filePath: selection.sourceLabel,
        sourceType: 'agent-history',
        sourceLabel: selection.sourceLabel,
        messageId: selection.messageId,
        messageRole: selection.messageRole,
        capturedAt: Date.now(),
      })
      return next
    })
    window.getSelection()?.removeAllRanges()
    clearSelection()
    toast.success('已添加到 Agent 引用')
  }, [clearSelection, selection, sessionId, setQuotedSelectionMap])

  return (
    <>
      {selection && (
        <SelectionActionPopover
          x={selection.x}
          y={selection.y}
          direction={selection.direction}
          onAddToAgent={handleAddToAgent}
        />
      )}
    </>
  )
}
