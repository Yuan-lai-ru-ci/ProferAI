import type { Channel } from '@profer/shared'

interface TeamAuth {
  baseUrl: string
  token: string
}

export interface LocalFirstChannelListingDeps {
  listLocalChannels: () => Channel[]
  isCommercialMode: () => boolean
  getTeamAuthWithRefresh: () => Promise<TeamAuth | null>
  syncChannelsFromServer: (serverBaseUrl: string, accessToken: string) => Promise<void>
  onSyncFailure: (error: unknown) => void
}

/**
 * 立即返回本地渠道快照，并在商业模式下后台刷新服务端托管渠道。
 *
 * 本地 `channels.json` 是模型选择首屏的可靠缓存；远端刷新属于补充，
 * 绝不能让认证、代理或服务器网络状态阻塞对话输入。
 */
export function listChannelsWithBackgroundSync(deps: LocalFirstChannelListingDeps): Channel[] {
  const localChannels = deps.listLocalChannels()

  if (!deps.isCommercialMode()) return localChannels

  void deps.getTeamAuthWithRefresh()
    .then(async (auth) => {
      if (!auth) return
      await deps.syncChannelsFromServer(auth.baseUrl, auth.token)
    })
    .catch((error: unknown) => {
      deps.onSyncFailure(error)
    })

  return localChannels
}
