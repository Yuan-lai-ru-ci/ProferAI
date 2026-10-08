import type { AgentStreamEvent, Channel } from '@profer/shared'

interface AccountSnapshot { isLoggedIn: boolean; teamAccountId?: string; teamEmail?: string }
interface ChannelCatalogListenerDeps {
  subscribe: (callback: (event: AgentStreamEvent) => void) => () => void
  subscribeAccount: (callback: () => void) => () => void
  subscribeRefresh?: (callback: () => void) => () => void
  getAccount: () => AccountSnapshot
  listLocalChannels: () => Promise<Channel[]>
  listInitialChannels?: () => Promise<Channel[]>
  getCatalogSnapshot?: () => Channel[]
  onAccountChange?: () => void
  apply: (channels: Channel[]) => void
  onFailure: (error: unknown) => void
  initialRefresh?: boolean
}

/** 复用目录失效事件；仅拉本地快照，避免完成通知再次触发远端同步。 */
export function subscribeChannelCatalog(deps: ChannelCatalogListenerDeps): () => void {
  let active = true
  let generation = 0
  let revision = 0
  const accountKey = (): string => JSON.stringify(deps.getAccount())
  const refresh = (initial = false): void => {
    if (!active) return
    const request = ++generation
    const account = accountKey()
    const snapshot = deps.getCatalogSnapshot?.()
    const read = initial ? deps.listInitialChannels ?? deps.listLocalChannels : deps.listLocalChannels
    void read().then((channels) => {
      if (!active || request !== generation || account !== accountKey()) return
      const currentSnapshot = deps.getCatalogSnapshot?.()
      if (initial && snapshot !== currentSnapshot && currentSnapshot) {
        // 设置页已提交更新目录时，用它完成就绪标记，不让迟到 LIST 覆盖它。
        deps.apply(currentSnapshot)
        return
      }
      const visible = deps.getAccount().isLoggedIn ? channels : channels.filter((channel) => !channel.serverManaged && !channel.id.startsWith('newapi-'))
      deps.apply(visible)
    }).catch((error: unknown) => {
      if (active && request === generation && account === accountKey()) deps.onFailure(error)
    })
  }
  const unsubscribe = deps.subscribe(({ payload }) => {
    if (!active || payload.kind !== 'catalog_invalidation' || payload.catalog !== 'channels'
      || payload.workspaceSlug !== null || payload.revision <= revision) return
    revision = payload.revision
    refresh()
  })
  const unsubscribeAccount = deps.subscribeAccount(() => {
    if (!active) return
    deps.onAccountChange?.()
    refresh(true)
  })
  const unsubscribeRefresh = deps.subscribeRefresh?.(() => refresh())
  if (deps.initialRefresh) refresh(true)
  return () => {
    if (!active) return
    active = false
    generation += 1
    unsubscribe()
    unsubscribeAccount()
    unsubscribeRefresh?.()
  }
}
