import { ipcMain } from 'electron'
import { CHANNEL_IPC_CHANNELS } from '@profer/shared'
import type { Channel, ChannelCreateInput, ChannelTestResult, ChannelUpdateInput, FetchModelsInput, FetchModelsResult } from '@profer/shared'
import { listChannels, createChannel, updateChannel, deleteChannel, decryptApiKey, testChannel, testChannelDirect, fetchModels, getChannelPlanQuota, syncChannelsFromServer, isCommercialMode, loginXaiChannel, loginCodexChannel } from './channel-manager'
import { listChannelsWithBackgroundSync } from './local-first-channel-listing'
import { cancelXaiOAuthLogin } from './xai-oauth-service'
import { cancelCodexOAuthLogin } from './codex-oauth-service'
import { listCodexModels, listXaiModels } from './adapters/pi-model-registry'
import { editionProviders } from './edition'
import type { ChannelNetworkRequests } from './channel-network-requests'

export interface ChannelIpcContext {
  channelNetworkRequests: ChannelNetworkRequests
  invalidateCatalog: (catalog: 'channels') => void
}

export function registerChannelIpc(context: ChannelIpcContext): void {
  ipcMain.handle(CHANNEL_IPC_CHANNELS.LIST, (_, options?: { localOnly?: boolean }): Channel[] => listChannelsWithBackgroundSync({
    listLocalChannels: listChannels,
    isCommercialMode,
    // 账号能力一律经发行版契约，开源版在这里拿到 null / null / false。
    getTeamAuth: () => editionProviders.account.getSessionSnapshot(),
    getSessionGeneration: () => editionProviders.account.getSessionGeneration(),
    getTeamAuthWithRefresh: () => editionProviders.account.getSession(),
    syncChannelsFromServer,
    onSyncFailure: (error) => console.warn('[渠道管理] 后台同步渠道失败，继续使用本地缓存:', error),
  }, options?.localOnly !== true))

  ipcMain.handle(CHANNEL_IPC_CHANNELS.GET_OFFICIAL_HEALTH, async (): Promise<import('@profer/shared').OfficialChannelHealth[]> => {
    const auth = await editionProviders.account.getSession()
    if (!auth) return []
    const response = await fetch(`${auth.baseUrl}/v1/account/channels/health`, {
      headers: { Authorization: `Bearer ${auth.token}` },
      signal: AbortSignal.timeout(10000),
    })
    if (!response.ok) return []
    const data = await response.json() as { channels?: import('@profer/shared').OfficialChannelHealth[] }
    return data.channels || []
  })

  ipcMain.handle(CHANNEL_IPC_CHANNELS.CREATE, async (_, input: ChannelCreateInput): Promise<Channel> => {
    const channel = createChannel(input)
    context.invalidateCatalog('channels')
    return channel
  })
  ipcMain.handle(CHANNEL_IPC_CHANNELS.UPDATE, async (_, id: string, input: ChannelUpdateInput): Promise<Channel> => {
    const channel = updateChannel(id, input)
    context.invalidateCatalog('channels')
    return channel
  })
  ipcMain.handle(CHANNEL_IPC_CHANNELS.DELETE, async (_, id: string): Promise<void> => {
    const result = deleteChannel(id)
    context.invalidateCatalog('channels')
    return result
  })
  ipcMain.handle(CHANNEL_IPC_CHANNELS.DECRYPT_KEY, async (_, channelId: string): Promise<string> => {
    return decryptApiKey(channelId)
  })
  ipcMain.handle(CHANNEL_IPC_CHANNELS.TEST, async (_, channelId: string): Promise<ChannelTestResult> => testChannel(channelId))
  ipcMain.handle(CHANNEL_IPC_CHANNELS.TEST_DIRECT, async (event, input: FetchModelsInput): Promise<ChannelTestResult> =>
    context.channelNetworkRequests.run(event.sender, input.requestId, (signal) => testChannelDirect(input, signal)))
  ipcMain.handle(CHANNEL_IPC_CHANNELS.FETCH_MODELS, async (event, input: FetchModelsInput): Promise<FetchModelsResult> =>
    context.channelNetworkRequests.run(event.sender, input.requestId, (signal) => fetchModels(input, signal)))
  ipcMain.handle(CHANNEL_IPC_CHANNELS.CANCEL_REQUEST, (event, requestId: string): void => {
    context.channelNetworkRequests.cancel(event.sender.id, requestId)
  })
  ipcMain.handle(CHANNEL_IPC_CHANNELS.GET_PLAN_QUOTA, async (_, channelId: string): Promise<import('@profer/shared').ChannelPlanQuotaResult> => getChannelPlanQuota(channelId))
  ipcMain.handle(CHANNEL_IPC_CHANNELS.SYNC_FROM_SERVER, async (_, serverBaseUrl: string, accessToken: string): Promise<void> => {
    await syncChannelsFromServer(serverBaseUrl, accessToken)
  })
  ipcMain.handle(CHANNEL_IPC_CHANNELS.GET_COMMERCIAL_MODE, async (): Promise<boolean> => isCommercialMode())
  ipcMain.handle(CHANNEL_IPC_CHANNELS.GET_ACCOUNT_CAPABILITIES, async (_, force?: boolean): Promise<{ commercialMode: boolean; canSelfConfig: boolean; membershipTier: string }> => {
    if (force) await editionProviders.account.refreshSession().catch(() => {})
    const membership = editionProviders.account.getMembership()
    return { commercialMode: membership.commercialMode, canSelfConfig: membership.canSelfConfig, membershipTier: membership.membershipTier }
  })
  ipcMain.handle(CHANNEL_IPC_CHANNELS.GET_BUILD_TARGET, async (): Promise<'oss' | 'commercial'> => {
    const { getBuildTarget } = await import('./build-target')
    return getBuildTarget()
  })
  ipcMain.handle(CHANNEL_IPC_CHANNELS.XAI_LOGIN, async (_, input: import('@profer/shared').XaiOAuthLoginInput): Promise<Channel> => {
    const channel = await loginXaiChannel(input)
    context.invalidateCatalog('channels')
    return channel
  })
  ipcMain.handle(CHANNEL_IPC_CHANNELS.XAI_LOGIN_CANCEL, async (): Promise<void> => cancelXaiOAuthLogin())
  ipcMain.handle(CHANNEL_IPC_CHANNELS.XAI_MODELS, async (): Promise<import('@profer/shared').ChannelModel[]> =>
    (await listXaiModels()).map((model) => ({ ...model, enabled: true, source: 'builtin-catalog' as const })))
  ipcMain.handle(CHANNEL_IPC_CHANNELS.CODEX_LOGIN, async (_, input: import('@profer/shared').CodexOAuthLoginInput): Promise<Channel> => {
    const channel = await loginCodexChannel(input)
    context.invalidateCatalog('channels')
    return channel
  })
  ipcMain.handle(CHANNEL_IPC_CHANNELS.CODEX_LOGIN_CANCEL, async (): Promise<void> => cancelCodexOAuthLogin())
  ipcMain.handle(CHANNEL_IPC_CHANNELS.CODEX_MODELS, async (): Promise<import('@profer/shared').ChannelModel[]> =>
    (await listCodexModels()).map((model) => ({ ...model, enabled: true, source: 'builtin-catalog' as const })))
}
