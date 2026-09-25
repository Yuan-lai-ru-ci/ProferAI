import * as React from 'react'
import type { ProferPluginViewInstance, ProferPluginViewLayout } from '@profer/plugin-api'

const RENDERER_INSTANCE_ID = globalThis.crypto?.randomUUID?.() ?? `plugin-renderer-${Date.now()}`
let nextRevision = 0
let nextSourceRevision = 0

const BLOCKING_OVERLAY_SELECTOR = [
  '[data-browser-blocking][data-state="open"]',
  '[data-radix-popper-content-wrapper] [data-state="open"]',
  '[data-sonner-toast][data-mounted="true"]',
  '[data-profer-intro-overlay]',
].join(', ')
function hasBlockingOverlay(): boolean {
  return document.querySelector(BLOCKING_OVERLAY_SELECTOR) !== null
}

export interface PluginViewportProps {
  pluginId: string
  pageId: string
  instance: ProferPluginViewInstance
  visible: boolean
}

/**
 * 插件页面的 DOM 几何宿主。
 * 真正页面由主进程 WebContentsView 绘制；这里仅提供安全的布局锚点，
 * 同时在对话框/下拉菜单等遮罩出现时及时隐藏原生 View，避免它拦截宿主交互。
 */
export function PluginViewport({ pluginId, pageId, instance, visible }: PluginViewportProps): React.ReactElement {
  const taskContext = instance.kind === 'tab' && instance.sessionId ? instance.sessionId : undefined
  const frameRef = React.useRef<HTMLDivElement>(null)

  React.useLayoutEffect(() => {
    const frame = frameRef.current
    const publishLayout = window.electronAPI.setPluginViewLayout
    if (!frame || typeof publishLayout !== 'function') return

    const sourceRevision = ++nextSourceRevision
    let raf = 0
    let previous: ProferPluginViewLayout | null = null
    const publish = (): void => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        const rect = frame.getBoundingClientRect()
        const style = getComputedStyle(frame)
        const radius = Number.parseFloat(style.borderTopLeftRadius)
        const next: ProferPluginViewLayout = {
          pluginId,
          pageId,
          instance,
          rendererInstanceId: RENDERER_INSTANCE_ID,
          layoutSourceRevision: sourceRevision,
          revision: ++nextRevision,
          visible: visible && !hasBlockingOverlay() && rect.width > 4 && rect.height > 4,
          bounds: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.max(0, Math.round(rect.width)),
            height: Math.max(0, Math.round(rect.height)),
          },
          borderRadius: Number.isFinite(radius) ? Math.round(radius) : 16,
        }
        if (previous
          && previous.visible === next.visible
          && previous.bounds.x === next.bounds.x
          && previous.bounds.y === next.bounds.y
          && previous.bounds.width === next.bounds.width
          && previous.bounds.height === next.bounds.height
          && previous.borderRadius === next.borderRadius) return
        previous = next
        void publishLayout(next).catch(() => undefined)
      })
    }

    const resizeObserver = new ResizeObserver(publish)
    resizeObserver.observe(frame)
    const onPluginsChanged = window.electronAPI.onPluginsChanged
    const unsubscribePluginsChanged = typeof onPluginsChanged === 'function'
      ? onPluginsChanged(() => { previous = null; publish() })
      : undefined
    const mutationObserver = new MutationObserver(publish)
    mutationObserver.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['class', 'data-state', 'data-mounted', 'data-visible', 'style'],
    })
    window.addEventListener('resize', publish)
    window.addEventListener('scroll', publish, true)
    publish()

    return () => {
      resizeObserver.disconnect()
      unsubscribePluginsChanged?.()
      mutationObserver.disconnect()
      window.removeEventListener('resize', publish)
      window.removeEventListener('scroll', publish, true)
      if (raf) cancelAnimationFrame(raf)
      // 首个布局帧尚未发送时，主进程还没有创建对应的 native View；
      // 不要在 cleanup 中反向创建一个永远不可见的孤儿 View。
      if (previous) {
        void publishLayout({
          pluginId,
          pageId,
          instance,
          rendererInstanceId: RENDERER_INSTANCE_ID,
          layoutSourceRevision: sourceRevision,
          revision: ++nextRevision,
          visible: false,
          bounds: { x: 0, y: 0, width: 0, height: 0 },
          borderRadius: 0,
        }).catch(() => undefined)
      }
    }
  }, [instance.kind, taskContext, pageId, pluginId, visible])


  return (
    <div
      ref={frameRef}
      data-plugin-native-host
      className="h-full min-h-0 w-full overflow-hidden rounded-2xl bg-surface-raised"
      aria-label="插件页面"
    />
  )
}
