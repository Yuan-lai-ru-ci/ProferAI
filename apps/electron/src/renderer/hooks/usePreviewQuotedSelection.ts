import * as React from 'react'
import { useSetAtom } from 'jotai'
import { toast } from 'sonner'
import { quotedSelectionMapAtom, type QuotedSelectionSourceType } from '@/atoms/preview-atoms'

const MAX_QUOTED_CHARS = 2000

function isSelectionInside(container: HTMLElement, selection: Selection): boolean {
  if (selection.rangeCount === 0) return false
  let node: Node | null = selection.getRangeAt(0).commonAncestorContainer
  while (node) {
    if (node === container) return true
    const root = node.getRootNode()
    node = root instanceof ShadowRoot ? root.host : node.parentNode
  }
  return false
}

function getDeepSelection(container: HTMLElement, shadowRoots: Set<ShadowRoot>): { text: string } | null {
  const documentSelection = document.getSelection()
  if (documentSelection && !documentSelection.isCollapsed && documentSelection.rangeCount > 0 && isSelectionInside(container, documentSelection)) {
    const text = documentSelection.toString().trim()
    if (text) return { text }
  }
  for (const shadowRoot of shadowRoots) {
    if (!container.contains(shadowRoot.host)) continue
    const selection = (shadowRoot as ShadowRoot & { getSelection?: () => Selection | null }).getSelection?.()
    if (selection && !selection.isCollapsed && selection.rangeCount > 0) {
      const text = selection.toString().trim()
      if (text) return { text }
    }
  }
  // 与原生文件预览的兜底一致：缓存尚未建立时递归寻找开放 Shadow DOM。
  const walk = (node: Node): { text: string } | null => {
    if (node instanceof HTMLElement && node.shadowRoot) {
      const selection = (node.shadowRoot as ShadowRoot & { getSelection?: () => Selection | null }).getSelection?.()
      if (selection && !selection.isCollapsed && selection.rangeCount > 0) {
        const text = selection.toString().trim()
        if (text) return { text }
      }
      const nested = walk(node.shadowRoot)
      if (nested) return nested
    }
    for (const child of node.childNodes) {
      const nested = walk(child)
      if (nested) return nested
    }
    return null
  }
  return walk(container)
}

function discoverShadowRoots(root: Node, target: Set<ShadowRoot>): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT)
  while (walker.nextNode()) {
    const element = walker.currentNode as HTMLElement
    if (element.shadowRoot) target.add(element.shadowRoot)
  }
}

/** 与 DiffTabContent 同款的预览划词引用：选区变化即更新当前 Agent 的引用附件。 */
export function usePreviewQuotedSelection({
  containerRef,
  sessionId,
  filePath,
  sourceType = 'file',
  sourceLabel,
  enabled = true,
}: {
  containerRef: React.RefObject<HTMLElement>
  sessionId?: string
  filePath: string
  sourceType?: QuotedSelectionSourceType
  sourceLabel?: string
  enabled?: boolean
}): void {
  const setQuotedSelectionMap = useSetAtom(quotedSelectionMapAtom)
  const shadowRootsRef = React.useRef<Set<ShadowRoot>>(new Set())
  const toastIdRef = React.useRef<string | null>(null)

  const dismissToast = React.useCallback(() => {
    if (toastIdRef.current) toast.dismiss(toastIdRef.current)
    toastIdRef.current = null
  }, [])

  const capture = React.useCallback(() => {
    if (!enabled || !sessionId || !containerRef.current) return
    const container = containerRef.current
    const deepSelection = getDeepSelection(container, shadowRootsRef.current)
    const clear = () => setQuotedSelectionMap((previous) => {
      if (!previous.has(sessionId)) return previous
      const next = new Map(previous)
      next.delete(sessionId)
      return next
    })
    if (!deepSelection) {
      dismissToast()
      const activeElement = document.activeElement
      if (!activeElement?.closest?.('.ProseMirror, [data-input-mode]')) clear()
      return
    }
    const truncated = deepSelection.text.length > MAX_QUOTED_CHARS
    const text = truncated ? deepSelection.text.slice(0, MAX_QUOTED_CHARS) : deepSelection.text
    setQuotedSelectionMap((previous) => {
      const existing = previous.get(sessionId)
      if (existing?.text === text && existing.filePath === filePath) return previous
      const next = new Map(previous)
      next.set(sessionId, { text, filePath, sourceType, sourceLabel, capturedAt: Date.now() })
      return next
    })
    if (truncated) {
      const id = `quoted-chars-cap:${sessionId}:${Math.floor(deepSelection.text.length / 1000) * 1000}`
      if (toastIdRef.current && toastIdRef.current !== id) toast.dismiss(toastIdRef.current)
      toast.warning(`已选中超过 ${MAX_QUOTED_CHARS} 字符，仅引用前 ${MAX_QUOTED_CHARS} 字符`, { id, duration: 3000 })
      toastIdRef.current = id
    } else dismissToast()
  }, [containerRef, dismissToast, enabled, filePath, sessionId, setQuotedSelectionMap, sourceLabel, sourceType])

  React.useEffect(() => {
    if (!enabled || !sessionId || !containerRef.current) return
    const container = containerRef.current
    const roots = shadowRootsRef.current
    roots.clear()
    discoverShadowRoots(container, roots)
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) for (const node of mutation.addedNodes) discoverShadowRoots(node, roots)
    })
    observer.observe(container, { childList: true, subtree: true })
    let tracking = false
    let frame = 0
    const schedule = () => {
      // 与 DiffTabContent 一致：非拖拽且 document 选区折叠时，不做昂贵的 Shadow DOM 遍历。
      if (!tracking) {
        const selection = document.getSelection()
        if (!selection || selection.isCollapsed || !isSelectionInside(container, selection)) return
      }
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; capture() })
    }
    const onMouseDown = (event: MouseEvent) => { if (event.button === 0 && container.contains(event.target as Node)) tracking = true }
    const onMouseMove = () => { if (tracking) schedule() }
    const onMouseUp = () => { if (tracking) { tracking = false; schedule() } }
    const onSelectionChange = () => schedule()
    container.addEventListener('mousedown', onMouseDown)
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
    document.addEventListener('selectionchange', onSelectionChange)
    return () => {
      if (frame) cancelAnimationFrame(frame)
      observer.disconnect(); roots.clear(); dismissToast()
      container.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      document.removeEventListener('selectionchange', onSelectionChange)
    }
  }, [capture, containerRef, dismissToast, enabled, sessionId])
}
