import * as React from 'react'
import { useSetAtom } from 'jotai'

import { pendingQuoteInsertMapAtom, type QuotedSelection } from '@/atoms/preview-atoms'

/**
 * 浏览器列里的划词引用。
 *
 * 选区发生在**另一个 webContents**（受管浏览器视图里那个无 preload 的 viewer 页），
 * 本进程读不到它的 `getSelection()`；页面只能把文本经哨兵 URL 回投给主进程，
 * 主进程再转成 `BROWSER_LOCAL_FILE_SELECTION` 事件送到这里。
 *
 * 本 hook 只负责把事件转成一条引用并交给输入框插入（正文里的 `[n]` 胶囊）。
 * 与手动引用同构：落进正文后就是普通节点，用户删胶囊即删引用。
 *
 * 自动引用的取舍：浏览器划词是**被动**产生的，所以每条新划词替换上一条自动引用
 * （`origin: 'browser-selection'`），不会越攒越多——替换在编辑器侧完成。
 */

/** 把浏览器事件转成引用；空选区（用户点了别处）返回 null，不产生任何副作用。 */
export function buildBrowserSelectionQuote(event: {
  text: string
  filePath: string
  fileName: string
  capturedAt?: number
}): QuotedSelection | null {
  const text = event.text.trim()
  if (!text) return null
  return {
    text,
    filePath: event.filePath,
    sourceType: 'file',
    sourceLabel: event.fileName,
    capturedAt: event.capturedAt ?? Date.now(),
    origin: 'browser-selection',
  }
}

export function useBrowserLocalFileSelectionQuote(): void {
  const setPendingQuoteInsert = useSetAtom(pendingQuoteInsertMapAtom)

  React.useEffect(() => {
    const subscribe = (window.electronAPI as Partial<typeof window.electronAPI>)
      .onAgentBrowserLocalFileSelection
    if (!subscribe) return
    return subscribe((event) => {
      const quote = buildBrowserSelectionQuote(event)
      if (!quote) return
      setPendingQuoteInsert((previous) => {
        const next = new Map(previous)
        next.set(event.sessionId, [...(previous.get(event.sessionId) ?? []), quote])
        return next
      })
    })
  }, [setPendingQuoteInsert])
}
