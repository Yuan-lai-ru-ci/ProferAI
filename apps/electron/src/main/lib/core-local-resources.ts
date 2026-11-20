import { watchFile, unwatchFile } from 'node:fs'
import { getChannelsPath } from './config-paths'
import { listChannels } from './channel-manager'
import { createElectronCredentialPort } from './agent-runtime-host'
import type { CoreClient, CoreChannel } from './core-client'

/** 桌面本地Core的内存资源装配。凭据只走鉴权loopback，不保存另一套配置。 */
export function maintainLocalCoreChannels(client: CoreClient): () => void {
  let stopped = false
  let tail: Promise<void> = Promise.resolve()
  const refresh = () => {
    if (stopped) return
    tail = tail.catch(() => {}).then(async () => {
      if (!stopped) await syncLocalCoreChannels(client)
    }).catch(error => console.error('[Core] 本地渠道快照刷新失败，目标Core不会使用其他渠道替代：', error instanceof Error ? error.message : '未知错误'))
  }
  const path = getChannelsPath()
  const onChange = () => refresh()
  watchFile(path, { persistent: false, interval: 2000 }, onChange)
  const unsubscribe = client.addSnapshotListener(() => refresh())
  return () => { stopped = true; unwatchFile(path, onChange); unsubscribe() }
}

export async function syncLocalCoreChannels(client: CoreClient): Promise<void> {
  const credentials = createElectronCredentialPort()
  const snapshot: Array<CoreChannel & { apiKey: string; codexOAuthCredentials?: unknown; xaiOAuthCredentials?: unknown }> = []
  let unavailable = 0
  for (const channel of listChannels()) {
    const runtime = channel.agentRuntimes?.[0] ?? 'pi'
    if (channel.enabled === false) continue
    let result: Awaited<ReturnType<typeof credentials.resolve>>
    try { result = await credentials.resolve({ sessionId: 'local-core-resources', runtime, channelId: channel.id }) }
    catch { unavailable++; continue }
    if (!result.ok) { unavailable++; continue }
    const value = result.credentials
    snapshot.push({ id: channel.id, name: channel.name, provider: value.provider, apiKey: value.apiKey,
      baseUrl: value.baseUrl, agentBaseUrl: channel.agentBaseUrl, models: channel.models, enabled: channel.enabled,
      agentRuntimes: channel.agentRuntimes, credentialMode: channel.credentialMode,
      codexOAuthCredentials: value.codexOAuthCredentials, xaiOAuthCredentials: value.xaiOAuthCredentials,
      apiProtocol: value.xaiApiProtocol })
  }
  await client.syncDesktopChannels(snapshot)
  if (unavailable) console.warn(`[Core] ${unavailable}个渠道凭据不可用，已从本地Core快照排除；不会沿用旧凭据或改用其他渠道`)
}
