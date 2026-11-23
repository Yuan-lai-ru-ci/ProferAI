import { isCoreConnectionTtl } from '@profer/shared'
import { safeStorage } from 'electron'
import type { CoreConnectionState, LocalCoreState } from '../../types/core-connection'
import { getLocalCoreState, retryLocalCore } from './core-local-service'
import { clearLocalCoreTargetClient, getManagedLocalCoreClient, listCoreTargets, savePairedCoreTarget, selectCoreTarget } from './core-target-service'
import { consumeCoreInvitation, decodeCoreInvitation, encodeCoreInvitation, withCoreInvitationTunnel } from './core-invitation'

const localState = getLocalCoreState
function localClient() {
  const client = getManagedLocalCoreClient()
  if (!client) throw new Error('本机 Core 尚未就绪')
  return client
}
export async function retryLocalCoreConnection(): Promise<LocalCoreState> {
  if (getLocalCoreState().status !== 'running') clearLocalCoreTargetClient()
  await retryLocalCore()
  return localState()
}

export async function getCoreConnectionState(): Promise<CoreConnectionState> {
  const local = localState()
  const client = getManagedLocalCoreClient()
  if (!client || local.status !== 'running') return { local, sharing: false, endpoints: [], bindings: [] }
  const state = await client.connectionState()
  return {
    local, sharing: state.sharingEnabled, coreId: state.coreId, name: state.name,
    endpoints: state.sharingEnabled ? state.endpoints : [],
    bindings: state.bindings.map(binding => ({ id: binding.id, name: binding.clientName, createdAt: binding.createdAt, expiresAt: binding.expiresAt })),
  }
}
export async function setCoreSharing(enabled: boolean): Promise<CoreConnectionState> {
  if (typeof enabled !== 'boolean') throw new Error('共享开关无效')
  await localClient().setSharing(enabled)
  return getCoreConnectionState()
}
export async function createCoreInvitation(ttlSeconds?: number, bindingTtlSeconds?: number): Promise<import('../../types').CoreInvitationResult> {
  if (ttlSeconds !== undefined && !isCoreConnectionTtl(ttlSeconds)) throw new Error('邀请时长无效')
  if (bindingTtlSeconds !== undefined && !isCoreConnectionTtl(bindingTtlSeconds)) throw new Error('连接期限无效')
  const invitation = await localClient().createInvitation({ ttlSeconds, bindingTtlSeconds })
  if (!invitation.endpoints.length) throw new Error('未发现局域网地址，请连接网络后重试')
  return { url: encodeCoreInvitation(invitation), expiresAt: invitation.expiresAt }
}
async function pairAndSaveCoreInvitation(input: string, tunnelUrl?: string) {
  // 消费一次性邀请之前，先确认客户端能够保存独立授权。
  if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用，无法保存 Core 授权')
  if (tunnelUrl !== undefined && typeof tunnelUrl !== 'string') throw new Error('隧道地址无效')
  const invitation = withCoreInvitationTunnel(decodeCoreInvitation(input), tunnelUrl)
  const result = await consumeCoreInvitation(invitation)
  return savePairedCoreTarget({
    name: invitation.name, coreId: invitation.coreId, endpoints: invitation.endpoints,
    identityPin: invitation.pin.value, bindingId: result.bindingId, credential: result.credential, expiresAt: result.expiresAt,
    ...(tunnelUrl?.trim() ? { tunnel: true } : {}),
  })
}

export async function pairCoreInvitation(input: string, tunnelUrl?: string) {
  await pairAndSaveCoreInvitation(input, tunnelUrl)
  return listCoreTargets()
}

export async function pairAndSelectCoreInvitation(input: string, tunnelUrl?: string): Promise<import('../../types').CoreTargetsSnapshot> {
  const target = await pairAndSaveCoreInvitation(input, tunnelUrl)
  try { return await selectCoreTarget(target.id, { reconnect: true }) }
  catch { throw new Error('已配对，但连接失败，可在设备列表重试连接') }
}
export async function revokeCoreBinding(id: string): Promise<CoreConnectionState> {
  if (!id || typeof id !== 'string') throw new Error('设备授权 ID 无效')
  await localClient().revokeBinding(id)
  return getCoreConnectionState()
}
