import * as React from 'react'
import type { BrowserGuestClaim, BrowserGuestRequest, BrowserGuestVisibility } from '@profer/shared'
import type { WebviewTag } from 'electron'
import { browserGuestHostKey, normalizeBrowserGuestRequests } from './BrowserGuestHost.state'

export interface BrowserGuestHostBridge {
  connectBrowserGuestHost(): Promise<BrowserGuestRequest[]>
  bindBrowserGuest(claim: BrowserGuestClaim): Promise<void>
  onBrowserGuestsChanged(callback: (requests: BrowserGuestRequest[]) => void): () => void
  setBrowserGuestVisibility(pages: BrowserGuestVisibility[]): void
}

export function browserGuestSlotId(sessionId: string, tabId: string): string {
  return `browser-slot-${Array.from(JSON.stringify([sessionId, tabId]), char => char.codePointAt(0)!.toString(16)).join('-')}`
}

/** guest 不搬入/搬出面板；通过同一 renderer 中的 DOM 锚点定位，隐藏时仍有可截图的尺寸。 */
function Guest({ request, bridge }: { request: BrowserGuestRequest; bridge: BrowserGuestHostBridge }): React.ReactElement {
  const ref = React.useRef<WebviewTag | null>(null)
  const [phase, setPhase] = React.useState('loading')
  React.useLayoutEffect(() => {
    const guest = ref.current
    if (!guest) return
    let frame = 0
    let syncUntil = 0
    let observedSlot: HTMLElement | null = null
    let visible: boolean | undefined
    let claimed = false
    let active = true
    const ready = (): void => {
      if (claimed) { setPhase('ready'); return }
      claimed = true
      void bridge.bindBrowserGuest({ sessionId: request.sessionId, tabId: request.tabId, ticket: request.ticket, guestId: guest.getWebContentsId() })
        .then(() => { if (active) setPhase('ready') })
        .catch(() => { if (active) setPhase('error') })
    }
    const failed = (): void => setPhase('error')
    const destroyed = (): void => setPhase('destroyed')
    guest.addEventListener('dom-ready', ready)
    guest.addEventListener('did-fail-load', failed)
    guest.addEventListener('render-process-gone', failed)
    guest.addEventListener('destroyed', destroyed)
    const layout = (): void => {
      frame = 0
      const slot = document.getElementById(browserGuestSlotId(request.sessionId, request.tabId))
      if (slot !== observedSlot) {
        if (observedSlot) resize.unobserve(observedSlot)
        observedSlot = slot
        if (slot) resize.observe(slot)
      }
      const host = guest.parentElement
      const rect = slot?.getBoundingClientRect()
      const hostRect = host?.getBoundingClientRect()
      const scaleX = host && hostRect && host.offsetWidth ? hostRect.width / host.offsetWidth : 1
      const scaleY = host && hostRect && host.offsetHeight ? hostRect.height / host.offsetHeight : 1
      let shown = !!slot && !!host && slot.dataset.browserGuestVisible === 'true' && !!rect && !!hostRect && rect.width > 4 && rect.height > 4
      if (slot && rect && shown) {
        let left = Math.max(0, rect.left)
        let top = Math.max(0, rect.top)
        let right = Math.min(innerWidth, rect.right)
        let bottom = Math.min(innerHeight, rect.bottom)
        // DOM 合成层也尊重祖先的隐藏/裁切，不能沿用面板上次可见时的范围。
        for (let parent: HTMLElement | null = slot; parent; parent = parent.parentElement) {
          const style = getComputedStyle(parent)
          if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0 || parent.hidden) { shown = false; break }
          if (parent !== slot && /hidden|clip|scroll|auto/.test(`${style.overflowX} ${style.overflowY}`)) {
            const clip = parent.getBoundingClientRect()
            left = Math.max(left, clip.left); right = Math.min(right, clip.right)
            top = Math.max(top, clip.top); bottom = Math.min(bottom, clip.bottom)
          }
        }
        shown = shown && right - left > 4 && bottom - top > 4
        Object.assign(guest.style, {
          left: `${(rect.left - hostRect!.left) / scaleX}px`, top: `${(rect.top - hostRect!.top) / scaleY}px`,
          width: `${rect.width / scaleX}px`, height: `${rect.height / scaleY}px`,
          clipPath: `inset(${Math.max(0, top - rect.top) / scaleY}px ${Math.max(0, rect.right - right) / scaleX}px ${Math.max(0, rect.bottom - bottom) / scaleY}px ${Math.max(0, left - rect.left) / scaleX}px round ${getComputedStyle(slot).borderRadius})`,
        })
      }
      const guestShown = shown && slot?.dataset.browserGuestBlocked !== 'true'
      const interactive = guestShown && document.body.dataset.browserGuestDrag !== 'true'
      guest.style.opacity = guestShown ? '1' : '0'
      guest.style.pointerEvents = interactive ? 'auto' : 'none'
      guest.toggleAttribute('inert', !interactive)
      guest.setAttribute('aria-hidden', String(!guestShown))
      if (visible !== shown) {
        visible = shown
        bridge.setBrowserGuestVisibility([{ sessionId: request.sessionId, tabId: request.tabId, ticket: request.ticket, visible: shown }])
      }
      // 只在影响此视口的过渡期间连续同步，最长 1 秒；空闲时没有常驻帧循环。
      if (performance.now() < syncUntil) frame = requestAnimationFrame(layout)
    }
    const schedule = (): void => { if (!frame) frame = requestAnimationFrame(layout) }
    const transition = (event: Event): void => {
      const target = event.target
      const slot = document.getElementById(browserGuestSlotId(request.sessionId, request.tabId))
      if (!(target instanceof Element) || !slot || !target.contains(slot)) return
      syncUntil = performance.now() + 1000
      schedule()
    }
    const resize = new ResizeObserver(schedule)
    resize.observe(document.documentElement)
    const mutations = new MutationObserver((records) => {
      // 忽略自身 opacity/phase 更新，避免 MutationObserver → layout 的常驻自激循环。
      if (records.some(record => !(record.target instanceof Element) || !record.target.closest('[data-browser-guest-host]'))) schedule()
    })
    mutations.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'data-browser-guest-visible', 'data-browser-guest-blocked', 'data-browser-guest-drag'] })
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, true)
    window.addEventListener('browser-guest-layout', schedule)
    document.addEventListener('transitionrun', transition, true)
    document.addEventListener('transitionend', schedule, true)
    schedule()
    return () => {
      active = false
      cancelAnimationFrame(frame)
      resize.disconnect(); mutations.disconnect()
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule, true)
      window.removeEventListener('browser-guest-layout', schedule)
      document.removeEventListener('transitionrun', transition, true)
      document.removeEventListener('transitionend', schedule, true)
      guest.removeEventListener('dom-ready', ready)
      guest.removeEventListener('did-fail-load', failed)
      guest.removeEventListener('render-process-gone', failed)
      guest.removeEventListener('destroyed', destroyed)
      if (visible) bridge.setBrowserGuestVisibility([{ sessionId: request.sessionId, tabId: request.tabId, ticket: request.ticket, visible: false }])
    }
  }, [request.sessionId, request.tabId, bridge])
  return React.createElement('webview', {
    ref, src: request.src, partition: request.partition,
    'aria-label': '受管浏览器网页', 'data-browser-guest-key': browserGuestHostKey(request), 'data-browser-guest-phase': phase,
    style: { position: 'absolute', left: 0, top: 0, width: 1024, height: 768, opacity: 0, pointerEvents: 'none' },
  })
}

export interface BrowserGuestHostProps { bridge?: BrowserGuestHostBridge }

export function BrowserGuestHost({ bridge: suppliedBridge }: BrowserGuestHostProps): React.ReactElement {
  const bridge = React.useMemo(() => suppliedBridge ?? window.electronAPI, [suppliedBridge])
  const [requests, setRequests] = React.useState<BrowserGuestRequest[]>([])
  const [status, setStatus] = React.useState('connecting')
  React.useEffect(() => {
    if (!bridge.connectBrowserGuestHost || !bridge.onBrowserGuestsChanged) { setStatus('unavailable'); return }
    let active = true
    let revision = 0
    const unsubscribe = bridge.onBrowserGuestsChanged(next => {
      revision += 1
      if (active) setRequests(previous => normalizeBrowserGuestRequests(previous, next))
    })
    const initialRevision = revision
    void bridge.connectBrowserGuestHost().then(next => {
      if (!active) return
      if (revision === initialRevision) setRequests(previous => normalizeBrowserGuestRequests(previous, next))
      setStatus('ready')
    }).catch(() => { if (active) setStatus('error') })
    return () => { active = false; unsubscribe() }
  }, [bridge])
  return <div data-browser-guest-host={status} style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 1 }}>
    {requests.map(request => <Guest key={`${browserGuestHostKey(request)}:${request.ticket}`} request={request} bridge={bridge} />)}
  </div>
}
