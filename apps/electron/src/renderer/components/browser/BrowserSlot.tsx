import * as React from 'react'

// 每次 publish（包括卸载隐藏）分配全局单调 revision。旧 slot 的 IPC 即使晚到，
// 主进程也不会覆盖随后已挂载 tab 的可见性和边界。
let nextBrowserLayoutRevision = 0

function nextLayoutRevision(): number {
  nextBrowserLayoutRevision += 1
  return nextBrowserLayoutRevision
}

/**
 * WebContentsView 是原生子视图，天然盖在 renderer DOM 之上；CSS z-index 无法反转。
 * 应用级 Dialog / Select / Popover / Dropdown 与 Sonner 通知出现时，临时隐藏原生视图，
 * 让 portal 内容获得正确的层级；浮层关闭后立即恢复浏览器。
 */
const APP_OVERLAY_LIFECYCLE_SELECTOR = [
  '[data-profer-intro-overlay]',
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[data-sonner-toast]',
  '[data-radix-popper-content-wrapper]',
].join(', ')

function hasBlockingAppOverlay(): boolean {
  if (document.querySelector('[data-profer-intro-overlay], [role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]')) return true
  if (document.querySelector('[data-sonner-toast][data-mounted="true"], [data-sonner-toast][data-visible="true"]')) return true

  return Array.from(document.querySelectorAll<HTMLElement>('[data-radix-popper-content-wrapper]'))
    .some((wrapper) => {
      const openContent = wrapper.querySelector<HTMLElement>('[data-state="open"]')
      // 浏览器自身的 Tooltip 不需要遮住网页；菜单、选择器与 Popover 则必须优先显示。
      return !!openContent && openContent.getAttribute('role') !== 'tooltip'
    })
}

/** 只跟踪 portal/toast 生命周期，避免 Agent 流式渲染触发无意义的 layout IPC。 */
function mutationsAffectAppOverlay(mutations: MutationRecord[]): boolean {
  return mutations.some((mutation) => {
    if (mutation.type === 'attributes') {
      const target = mutation.target instanceof Element ? mutation.target : null
      return !!target?.closest(APP_OVERLAY_LIFECYCLE_SELECTOR)
    }

    const nodes = [...mutation.addedNodes, ...mutation.removedNodes]
    if (nodes.some((node) => (
      node instanceof Element
      && (node.matches(APP_OVERLAY_LIFECYCLE_SELECTOR) || !!node.querySelector(APP_OVERLAY_LIFECYCLE_SELECTOR))
    ))) return true

    const parent = mutation.target instanceof Element ? mutation.target : null
    return !!parent?.closest(APP_OVERLAY_LIFECYCLE_SELECTOR)
  })
}

export function BrowserSlot({ sessionId, tabId }: { sessionId: string; tabId: string }): React.ReactElement {
  const ref = React.useRef<HTMLDivElement>(null)

  React.useLayoutEffect(() => {
    const element = ref.current
    const setLayout = (window.electronAPI as Partial<typeof window.electronAPI>).setAgentBrowserLayout
    if (!element || typeof setLayout !== 'function') return
    let frame = 0
    let pendingVisible = true
    const publish = (visible: boolean) => {
      pendingVisible = visible
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        const rect = element.getBoundingClientRect()
        setLayout({
          sessionId,
          tabId,
          revision: nextLayoutRevision(),
          visible: pendingVisible && rect.width > 4 && rect.height > 4,
          bounds: {
            x: Math.round(rect.x), y: Math.round(rect.y),
            width: Math.round(rect.width), height: Math.round(rect.height),
          },
        })
      })
    }
    const publishCurrentVisibility = () => publish(!hasBlockingAppOverlay())
    const observer = new ResizeObserver(publishCurrentVisibility)
    const overlayObserver = new MutationObserver((mutations) => {
      if (mutationsAffectAppOverlay(mutations)) publishCurrentVisibility()
    })
    // 主题/皮肤在 <html> 切换 dark、theme-*、skin-* class，并可能触发容器重排；
    // body 的浮层观察无法看到此 mutation，必须立即重新测量原生宿主 bounds。
    const themeObserver = new MutationObserver(() => publishCurrentVisibility())
    const publishBounded = () => publishCurrentVisibility()
    observer.observe(element)
    overlayObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'data-mounted', 'data-state', 'data-visible', 'style'],
    })
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] })
    window.addEventListener('resize', publishBounded)
    publishCurrentVisibility()

    // ResizeObserver 只在尺寸变化时触发；当右侧边栏/分屏等布局重排使 BrowserSlot 仅发生位置平移
    // （x/y 移动而宽高不变）时，它不会被触发，导致原生 WebContentsView 停留在旧坐标、与 DOM 框脱节。
    // 在浏览器可见期间用 rAF 轮询比对几何，发生位移/尺寸变化就重新同步布局。
    let layoutFrame = 0
    let prevRect: DOMRect | null = null
    const layoutLoop = (): void => {
      layoutFrame = 0
      if (hasBlockingAppOverlay()) { prevRect = null; scheduleLayoutLoop(); return }
      const rect = element.getBoundingClientRect()
      if (rect.width <= 4 || rect.height <= 4) { prevRect = null; scheduleLayoutLoop(); return }
      const changed = !prevRect
        || Math.abs(rect.x - prevRect.x) > 0.5
        || Math.abs(rect.y - prevRect.y) > 0.5
        || Math.abs(rect.width - prevRect.width) > 0.5
        || Math.abs(rect.height - prevRect.height) > 0.5
      if (changed) { prevRect = rect; publishCurrentVisibility() }
      scheduleLayoutLoop()
    }
    const scheduleLayoutLoop = (): void => {
      if (layoutFrame) return
      layoutFrame = requestAnimationFrame(layoutLoop)
    }
    scheduleLayoutLoop()

    return () => {
      observer.disconnect()
      overlayObserver.disconnect()
      themeObserver.disconnect()
      window.removeEventListener('resize', publishBounded)
      if (frame) cancelAnimationFrame(frame)
      if (layoutFrame) cancelAnimationFrame(layoutFrame)
      setLayout({ sessionId, tabId, revision: nextLayoutRevision(), visible: false, bounds: { x: 0, y: 0, width: 0, height: 0 } })
    }
  }, [sessionId, tabId])

  return <div ref={ref} className="flex-1 min-h-0 bg-muted/15 titlebar-no-drag" aria-label="受管浏览器页面" />
}
