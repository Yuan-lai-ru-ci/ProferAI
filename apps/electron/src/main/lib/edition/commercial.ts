import type { EditionProviders } from '@profer/edition-contract'
// 深路径引用：该模块刻意不在 @profer/core 的 barrel 里，避免被开源构建顺带打包。
import { detectInsufficientCredits } from '@profer/core/providers/insufficient-credits'
import { registerAccountIpc } from '../account-ipc'
import {
  getAuthSessionGeneration,
  getAuthStatus,
  getCommercialMode,
  getMembershipTier,
  getRemoteRelayTicket,
  getTeamAuth,
  getTeamAuthWithRefresh,
  isSelfConfigAllowed,
  recoverCommercialProxyAuth,
  refreshAuthToken,
  scheduleAutoRefresh,
  tryRestoreSession,
} from '../auth-service'
import { shouldUseCommercialBearerAuth, shouldUseManagedCommercialRoute } from '../commercial-routing-policy'
import { RemoteRelayClient } from './commercial/remote-relay-client'
import { pruneManagedOnLogout, restoreForAccount, syncFromServer } from './commercial/channel-sync'
import { isOfficialManagedChannel } from '../official-channel'

/**
 * 商业版能力装配。
 *
 * 这个文件是 OSS 构建里唯一被别名排除的实现：只有 `build:main-commercial`
 * 会把 `@profer/edition-impl` 指到它，因此 `auth-service` / `account-ipc` /
 * `commercial-routing-policy` 只会进商业包。
 *
 * 行为与拆分前完全一致——这里只做转发，不改变任何判定逻辑。
 */
export const editionProviders: EditionProviders = {
  id: 'commercial',
  account: {
    getSession: async () => getTeamAuthWithRefresh(),
    recoverSession: async () => recoverCommercialProxyAuth(),
    getSessionSnapshot: () => getTeamAuth(),
    getSessionGeneration: () => getAuthSessionGeneration(),
    refreshSession: () => refreshAuthToken(),
    restoreSession: async () => {
      const restored = await tryRestoreSession()
      // 与拆分前 main/index.ts 的判定一致：恢复失败但本地仍有有效登录态时也要续期。
      return restored || getAuthStatus().isLoggedIn
    },
    scheduleAutoRefresh: () => scheduleAutoRefresh(),
    getMembership: () => ({
      commercialMode: getCommercialMode(),
      membershipTier: getMembershipTier(),
      canSelfConfig: isSelfConfigAllowed(),
    }),
  },
  credentials: {
    shouldUseManagedRoute: (channel, options) => shouldUseManagedCommercialRoute(channel, options),
    shouldUseBearerAuth: (channel) => shouldUseCommercialBearerAuth(channel),
    // 代管端点只定义在商业实现里，开源包因此不含 /v1/proxy/* 字面量。
    managedPath: (kind) => {
      switch (kind) {
        case 'messages': return '/v1/proxy/messages'
        case 'chat': return '/v1/proxy/chat'
        case 'images': return '/v1/proxy/images/generations'
        case 'imageEdits': return '/v1/proxy/images/edits'
        case 'root': return '/v1/proxy'
      }
    },
    managedImageOperationPath: (operation, idempotencyKey) =>
      `/v1/proxy/images/operations/by-idempotency/${encodeURIComponent(operation)}/${encodeURIComponent(idempotencyKey)}`,
  },
  channels: {
    isManagedChannel: (channel) => isOfficialManagedChannel(channel),
    // 商业版下发的渠道在这里永远可见。
    isChannelVisible: () => true,
    // 服务端渠道的同步/清理/恢复：实现放在 commercial/ 下，OSS 构建里不存在。
    syncFromServer: (store, serverBaseUrl, accessToken) => syncFromServer(store, serverBaseUrl, accessToken),
    pruneManagedOnLogout: (store) => pruneManagedOnLogout(store),
    restoreForAccount: (store, accountId) => restoreForAccount(store, accountId),
  },
  errors: {
    detectInsufficientCredits: (error, status) => detectInsufficientCredits(error, status),
  },
  remote: {
    getRelayTicket: (role, deviceSlotId) => getRemoteRelayTicket(role, deviceSlotId),
    // 传输层不直接依赖装配点：ticket 在这里注入，避免 commercial → client → edition 的循环。
    createRelayClient: (options) =>
      new RemoteRelayClient({
        ...options,
        getTicket: (role) => getRemoteRelayTicket(role),
      }),
  },
  registerIpc: () => registerAccountIpc(),
}
