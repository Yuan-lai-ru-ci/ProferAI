import * as React from 'react'
import { browserGuestSlotId } from './BrowserGuestHost'

/** 页面只登记 DOM slot，guest 本身常驻 AppShell，不随面板卸载。 */
export function BrowserViewport({ sessionId, tabId, visible, blocked = false }: { sessionId: string; tabId: string; visible: boolean; blocked?: boolean }): React.ReactElement {
  React.useLayoutEffect(() => {
    window.dispatchEvent(new Event('browser-guest-layout'))
    return () => { window.dispatchEvent(new Event('browser-guest-layout')) }
  }, [sessionId, tabId, visible, blocked])
  return <div
    id={browserGuestSlotId(sessionId, tabId)}
    data-browser-guest-slot
    data-browser-guest-visible={visible ? 'true' : 'false'}
    data-browser-guest-blocked={blocked ? 'true' : 'false'}
    className="flex-1 min-h-0 min-w-0 bg-browser-host"
    style={{ borderBottomLeftRadius: 'inherit', borderBottomRightRadius: 'inherit' }}
  />
}
