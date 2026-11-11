/**
 * Electron 提供给 Pi provider 的宿主事实：代管渠道判定 + xAI OAuth 凭据落盘。
 *
 * provider 包不导入 apps/electron；这些依赖通过 `PiProviderHostDependencies`
 * 在组合根注入，保持渠道账号策略仍由桌面宿主决定。
 */
import type { PiModelRegistryHost } from '@profer/agent-provider-pi/pi/model-registry'
import { editionProviders } from '../edition'
import { rememberXaiOAuthCredentials, refreshXaiOAuthCredentialsSerial } from '../xai-oauth-credentials'

export const electronPiModelRegistryHost: PiModelRegistryHost = {
  // 走发行版策略而不是直接引用官方渠道模块：开源版的模块图里不该出现这个概念。
  isOfficialManagedChannel: (channel) => editionProviders.channels.isManagedChannel(channel),
  rememberXaiOAuthCredentials,
  refreshXaiOAuthCredentialsSerial,
}
