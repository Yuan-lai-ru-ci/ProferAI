import type { BrowserGuestRequest } from '@profer/shared'
export type BrowserGuestHostRequest = BrowserGuestRequest

export function browserGuestHostKey(request: Pick<BrowserGuestRequest, 'sessionId' | 'tabId'>): string {
  return JSON.stringify([request.sessionId, request.tabId])
}

/** 完整快照只包含主进程仍授权的实例；新票据代表显式重建，而非可见性变化。 */
export function normalizeBrowserGuestRequests(previous: readonly BrowserGuestRequest[], incoming: readonly BrowserGuestRequest[]): BrowserGuestRequest[] {
  const old = new Map(previous.map(item => [browserGuestHostKey(item), item]))
  const seen = new Set<string>()
  return incoming.filter(item => {
    const key = browserGuestHostKey(item)
    if (!item.sessionId || !item.tabId || !item.ticket || !item.partition || !item.src || seen.has(key)) return false
    seen.add(key)
    return true
  }).map(item => {
    const existing = old.get(browserGuestHostKey(item))
    return existing && existing.ticket === item.ticket && existing.partition === item.partition && existing.src === item.src ? existing : item
  })
}
