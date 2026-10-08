import type { Channel } from '@profer/shared'

interface TeamAuth {
  baseUrl: string
  teamAccountId?: string
  token: string
}

export interface LocalFirstChannelListingDeps {
  listLocalChannels: () => Channel[]
  isCommercialMode: () => boolean
  getSessionGeneration: () => number | null
  getTeamAuth: () => TeamAuth | null
  getTeamAuthWithRefresh: () => Promise<TeamAuth | null>
  syncChannelsFromServer: (serverBaseUrl: string, accessToken: string) => Promise<boolean | void>
  onSyncFailure: (error: unknown) => void
}

// 多窗口同时读取目录时，同一认证快照只启动一次同步；不缓存任何目录正文。
const pendingSyncs = new WeakMap<LocalFirstChannelListingDeps['listLocalChannels'], Set<string>>()

/**
 * 立即返回本地渠道快照，并在商业模式下后台刷新服务端托管渠道。
 *
 * 本地 `channels.json` 是模型选择首屏的可靠缓存；远端刷新属于补充，
 * 绝不能让认证、代理或服务器网络状态阻塞对话输入。
 */
export function listChannelsWithBackgroundSync(deps: LocalFirstChannelListingDeps, sync = true): Channel[] {
  const localChannels = deps.listLocalChannels()

  if (!sync || !deps.isCommercialMode()) return localChannels
  const initial = deps.getTeamAuth()
  const generation = deps.getSessionGeneration()
  if (generation === null) return localChannels
  const key = JSON.stringify([generation, initial?.baseUrl, initial?.teamAccountId])
  const pending = pendingSyncs.get(deps.listLocalChannels) ?? new Set<string>()
  pendingSyncs.set(deps.listLocalChannels, pending)
  if (pending.has(key)) return localChannels
  pending.add(key)
  const isInitialCurrent = (): boolean => {
    return deps.getSessionGeneration() === generation
  }

  void deps.getTeamAuthWithRefresh()
    .then(async (auth) => {
      if (!auth?.teamAccountId || !isInitialCurrent() || (initial && (auth.baseUrl !== initial.baseUrl
        || auth.teamAccountId !== initial.teamAccountId))) return
      await deps.syncChannelsFromServer(auth.baseUrl, auth.token)
    })
    .catch((error: unknown) => {
      deps.onSyncFailure(error)
    })
    .finally(() => { pending.delete(key) })

  return localChannels
}
