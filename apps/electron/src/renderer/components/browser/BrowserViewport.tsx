import * as React from 'react'
import type { BrowserViewLayout } from '@profer/shared'
import { resolveNativeBrowserVisible, sameBrowserViewportLayout } from './browser-viewport-layout'

// 每次 publish（包括卸载隐藏）分配全局单调 revision。旧 viewport 的 IPC 即使晚到，
// 主进程也不会覆盖当前标签的可见性或几何。
let nextBrowserLayoutRevision = 0

function nextLayoutRevision(): number {
  nextBrowserLayoutRevision += 1
  return nextBrowserLayoutRevision
}

/** WebContentsView 位于 renderer DOM 上方；原生 host 只覆盖网页区，遮挡它的 portal 仍需让原生 frame 暂时隐藏。 */
const APP_OVERLAY_LIFECYCLE_SELECTOR = [
  '[data-profer-intro-overlay]',
  '[data-browser-blocking]',
  '[data-sonner-toast]',
  '[data-radix-popper-content-wrapper]',
].join(', ')

function findBlockingOverlay(viewport: HTMLElement): boolean {
  if (document.querySelector('[data-profer-intro-overlay]')) return true
  const blocking = document.querySelector<HTMLElement>('[data-browser-blocking][data-state="open"]')
    ?? [...document.querySelectorAll<HTMLElement>('[data-browser-blocking]')].find((element) => !element.getAttribute('data-state'))
  if (blocking) return true

  const viewportRect = viewport.getBoundingClientRect()
  if (viewportRect.width <= 4 || viewportRect.height <= 4) return false
  const intersects = (rect: DOMRect): boolean => (
    rect.width > 0 && rect.height > 0
    && rect.right > viewportRect.left + 1 && rect.left < viewportRect.right - 1
    && rect.bottom > viewportRect.top + 1 && rect.top < viewportRect.bottom - 1
  )
  for (const toast of document.querySelectorAll<HTMLElement>('[data-sonner-toast][data-mounted="true"], [data-sonner-toast][data-visible="true"]')) {
    if (intersects(toast.getBoundingClientRect())) return true
  }
  for (const wrapper of document.querySelectorAll<HTMLElement>('[data-radix-popper-content-wrapper]')) {
    const content = wrapper.querySelector<HTMLElement>('[data-state="open"]')
    if (!content || content.getAttribute('role') === 'tooltip') continue
    if (intersects(content.getBoundingClientRect())) return true
  }
  return false
}

function mutationsAffectAppOverlay(mutations: MutationRecord[]): boolean {
  return mutations.some((mutation) => {
    if (mutation.type === 'attributes') {
      const target = mutation.target instanceof Element ? mutation.target : null
      return !!target?.closest(APP_OVERLAY_LIFECYCLE_SELECTOR)
    }
    const nodes = [...mutation.addedNodes, ...mutation.removedNodes]
    return nodes.some((node) => node instanceof Element
      && (node.matches(APP_OVERLAY_LIFECYCLE_SELECTOR) || !!node.querySelector(APP_OVERLAY_LIFECYCLE_SELECTOR)))
  })
}

function roundedRect(rect: DOMRect): BrowserViewLayout['viewportBounds'] {
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.max(0, Math.round(rect.width)),
    height: Math.max(0, Math.round(rect.height)),
  }
}

/** 原生 frame 必须与唯一的 DOM 卡片边界同半径，皮肤切换时不依赖硬编码默认值。 */
function readFrameRadius(frame: HTMLElement): number {
  const radius = Number.parseFloat(getComputedStyle(frame).borderTopLeftRadius)
  return Number.isFinite(radius) && radius >= 0 ? Math.round(radius) : 16
}

/**
 * Native browser frame 的唯一 renderer 入口。
 * 外层 card 是唯一几何来源，工具栏/标签条继续由 DOM 处于卡片顶部；
 * 原生 host 只占 card 内的 `pageBounds`，避免透明原生 View 在 macOS 上覆盖 DOM 交互区。
 */
export function BrowserViewport({
  sessionId,
  tabId,
  /** 面板的实际可见性；不能只依赖 width=0，因为收起动画期间 native View 仍会盖在 DOM 之上。 */
  visible: panelVisible,
}: {
  sessionId: string
  tabId: string
  visible: boolean
}): React.ReactElement {
  const pageRef = React.useRef<HTMLDivElement>(null)

  React.useLayoutEffect(() => {
    const page = pageRef.current
    const setLayout = (window.electronAPI as Partial<typeof window.electronAPI>).setAgentBrowserLayout
    if (!page || typeof setLayout !== 'function') return
    const frame = page.closest<HTMLElement>('[data-browser-native-host]')
    if (!frame) return

    let raf = 0
    let pendingVisible = true
    let previous: BrowserViewLayout | undefined
    const publish = (visible: boolean, force = false) => {
      pendingVisible = visible
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        const frameRect = frame.getBoundingClientRect()
        const pageRect = page.getBoundingClientRect()
        const viewportBounds = roundedRect(frameRect)
        const next: BrowserViewLayout = {
          sessionId,
          tabId,
          revision: nextLayoutRevision(),
          visible: pendingVisible && viewportBounds.width > 4 && viewportBounds.height > 4 && pageRect.width > 4 && pageRect.height > 4,
          viewportBounds,
          viewportRadius: readFrameRadius(frame),
          pageBounds: {
            x: Math.max(0, Math.round(pageRect.x - frameRect.x)),
            y: Math.max(0, Math.round(pageRect.y - frameRect.y)),
            width: Math.max(0, Math.round(pageRect.width)),
            height: Math.max(0, Math.round(pageRect.height)),
          },
        }
        if (!force && sameBrowserViewportLayout(previous, next)) return
        previous = next
        setLayout(next)
      })
    }
    // CSS 的 opacity / visibility 变化不会触发 ResizeObserver。把面板实际可见性
    // 纳入协议，收起或窄窗自动隐藏时立即撤走 native WebContentsView，不能让它
    // 继续停留在上一次的有效矩形上覆盖已不可见的 DOM 卡片。
    const publishCurrentVisibility = () => publish(resolveNativeBrowserVisible(panelVisible, findBlockingOverlay(frame)))
    const resizeObserver = new ResizeObserver(publishCurrentVisibility)
    resizeObserver.observe(frame)
    resizeObserver.observe(page)
    // ResizeObserver 不报告纯 x/y 平移；IntersectionObserver 会在卡片因侧栏、分栏或
    // 页面滚动改变视口矩形时回调，替代旧实现中持续运行的 rAF 几何轮询。
    const positionObserver = new IntersectionObserver(() => publishCurrentVisibility(), { threshold: [0, 1] })
    positionObserver.observe(frame)
    positionObserver.observe(page)
    const overlayObserver = new MutationObserver((mutations) => {
      if (mutationsAffectAppOverlay(mutations)) publishCurrentVisibility()
    })
    // 皮肤/主题可能改变 --radius；根节点变更后重新读取实际卡片半径。
    const themeObserver = new MutationObserver(publishCurrentVisibility)
    const publishOnScroll = () => publishCurrentVisibility()
    overlayObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'data-mounted', 'data-state', 'data-visible', 'style'],
    })
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] })
    window.addEventListener('resize', publishOnScroll)
    window.addEventListener('scroll', publishOnScroll, true)
    publishCurrentVisibility()

    return () => {
      resizeObserver.disconnect()
      positionObserver.disconnect()
      overlayObserver.disconnect()
      themeObserver.disconnect()
      window.removeEventListener('resize', publishOnScroll)
      window.removeEventListener('scroll', publishOnScroll, true)
      if (raf) cancelAnimationFrame(raf)
      setLayout({
        sessionId,
        tabId,
        revision: nextLayoutRevision(),
        visible: false,
        viewportBounds: { x: 0, y: 0, width: 0, height: 0 },
        viewportRadius: readFrameRadius(frame),
        pageBounds: { x: 0, y: 0, width: 0, height: 0 },
      })
    }
  }, [panelVisible, sessionId, tabId])

  return <div ref={pageRef} className="flex flex-1 min-h-0 bg-browser-host titlebar-no-drag" aria-label="受管浏览器页面" />
}
