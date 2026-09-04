import type { BrowserViewLayout } from '@profer/shared'

/**
 * 原生 WebContentsView 覆盖 renderer DOM，必须显式服从面板的最终可见性。
 * CSS 的 opacity / visibility 不改变盒模型，不能寄希望于 ResizeObserver 把它隐藏。
 */
export function resolveNativeBrowserVisible(panelVisible: boolean, hasBlockingOverlay: boolean): boolean {
  return panelVisible && !hasBlockingOverlay
}

/** 防止 ResizeObserver、主题变更与浮层观察重复发送等价 IPC。 */
export function sameBrowserViewportLayout(
  previous: BrowserViewLayout | undefined,
  next: BrowserViewLayout,
): boolean {
  if (!previous) return false
  return previous.sessionId === next.sessionId
    && previous.tabId === next.tabId
    && previous.visible === next.visible
    && previous.viewportRadius === next.viewportRadius
    && sameBounds(previous.viewportBounds, next.viewportBounds)
    && sameBounds(previous.pageBounds, next.pageBounds)
}

function sameBounds(
  left: BrowserViewLayout['viewportBounds'],
  right: BrowserViewLayout['viewportBounds'],
): boolean {
  return left.x === right.x
    && left.y === right.y
    && left.width === right.width
    && left.height === right.height
}
