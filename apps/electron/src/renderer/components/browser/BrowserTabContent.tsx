/**
 * BrowserTabContent — 浏览器页 Tab 的内容宿主。
 *
 * 每个浏览器内部标签一个顶栏 Tab（`__browser__:sessionId:tabId`）：
 * - 本 Tab 对应页是主进程当前激活页时，渲染完整 BrowserPanel（含原生 WebContentsView）；
 * - 同会话多个页 Tab 并排（Tab 组合）时，主进程同一时刻只能渲染一个页面——
 *   非激活页显示轻量占位（URL + 「激活此页面」），点击即切换主进程激活页；
 * - Tab 卸载时 BrowserViewport 的 cleanup 让原生视图让位，主进程浏览器会话保留。
 */

import * as React from 'react'
import { useAtomValue } from 'jotai'
import { Globe2 } from 'lucide-react'
import { browserStateMapAtom } from '@/atoms/browser-atoms'
import { useCloseTab } from '@/hooks/useCloseTab'
import { Button } from '@/components/ui/button'
import { BrowserPanel } from './BrowserPanel'

interface BrowserTabContentProps {
  /** 顶栏 Tab id（__browser__:sessionId:tabId） */
  tabId: string
  sessionId: string
  /** 对应的浏览器内部标签 id */
  browserTabId: string
}

export function BrowserTabContent({ tabId, sessionId, browserTabId }: BrowserTabContentProps): React.ReactElement {
  const browserState = useAtomValue(browserStateMapAtom).get(sessionId) ?? null
  const { requestClose } = useCloseTab()

  const handleClose = React.useCallback(() => {
    requestClose(tabId)
  }, [requestClose, tabId])

  // 非激活页占位：主进程同一时刻只渲染一个原生页面（同会话两页并排时的受限场景）
  if (browserState && browserTabId && browserState.activeTabId !== browserTabId) {
    const page = browserState.tabs.find((tab) => tab.tabId === browserTabId)
    const activate = (): void => {
      const select = (window.electronAPI as Partial<typeof window.electronAPI>).selectAgentBrowserTab
      if (typeof select === 'function') {
        void select({ sessionId, tabId: browserTabId }).catch(() => undefined)
      }
    }
    return (
      <div className="flex h-full min-h-0 w-full flex-col items-center justify-center gap-2 overflow-hidden bg-content-area px-6 text-center">
        <Globe2 className="size-5 text-muted-foreground" aria-hidden="true" />
        <p className="truncate max-w-full text-sm text-foreground/80">{page?.title || '新建标签页'}</p>
        {page?.url && <p className="truncate max-w-full text-xs text-muted-foreground">{page.url}</p>}
        <p className="text-xs text-muted-foreground/70">同一浏览器的两个页面不能同时并排显示</p>
        <Button size="sm" variant="outline" className="mt-1 h-7 text-xs" onClick={activate}>激活此页面</Button>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-content-area">
      <BrowserPanel
        sessionId={sessionId}
        state={browserState}
        visible
        onClose={handleClose}
      />
    </div>
  )
}
