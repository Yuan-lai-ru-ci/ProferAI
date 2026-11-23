export function isCoreConnectionTtl(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 60 && value <= 2592000
}

export interface CoreConnectionPin { algorithm: 'spki-sha256'; value: string }
export interface CoreConnectionInvitation {
  version: 1; coreId: string; name: string; endpoints: string[]; pin: CoreConnectionPin; invitationToken: string; expiresAt: number; bindingTtlSeconds?: number
}
export interface CoreConnectionBinding { id: string; clientName: string; createdAt: number; expiresAt?: number }
export interface CoreConnectionState {
  coreId: string; name: string; sharingEnabled: boolean; port: number; endpoints: string[]; pin: CoreConnectionPin; bindings: CoreConnectionBinding[]
}
export interface CorePairingResult { coreId: string; bindingId: string; credential: string; name: string; expiresAt?: number }
export function parseCoreConnectionInvitation(input: string, now = Date.now()): CoreConnectionInvitation {
  const value = JSON.parse(input) as CoreConnectionInvitation
  if (value.version !== 1 || typeof value.coreId !== 'string' || !value.coreId || typeof value.name !== 'string'
    || !Array.isArray(value.endpoints) || !value.endpoints.length || value.endpoints.length > 32
    || !value.endpoints.every(endpoint => { try { const u = new URL(endpoint); return u.protocol === 'https:' && !u.username && !u.password && u.pathname === '/' && !u.search && !u.hash } catch { return false } })
    || value.pin?.algorithm !== 'spki-sha256' || !/^sha256\/[A-Za-z0-9+/]{43}=$/.test(value.pin.value)
    || typeof value.invitationToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.invitationToken)
    || (value.bindingTtlSeconds !== undefined && !isCoreConnectionTtl(value.bindingTtlSeconds))
    || !Number.isFinite(value.expiresAt) || value.expiresAt <= now) throw new Error('Core 邀请无效或已过期')
  return value
}

/** UDP 发现仅提示地址；绝不能凭广告信任身份或发送授权。 */
export const CORE_DISCOVERY_PORT = 47789
export const CORE_DISCOVERY_GROUP = '239.255.77.89'
export interface CoreDiscoveryQuery { protocol: 'profer-core-discovery'; version: 1; kind: 'query' }
export interface CoreDiscoveryAdvertisement { protocol: 'profer-core-discovery'; version: 1; kind: 'advertisement'; coreId: string; endpoints: string[]; pin: CoreConnectionPin }
export function parseCoreDiscoveryAdvertisement(input: string): CoreDiscoveryAdvertisement | undefined {
  if (input.length > 8192) return
  try {
    const value = JSON.parse(input) as CoreDiscoveryAdvertisement
    if (value.protocol !== 'profer-core-discovery' || value.version !== 1 || value.kind !== 'advertisement' || typeof value.coreId !== 'string' || !value.coreId || value.coreId.length > 128
      || value.pin?.algorithm !== 'spki-sha256' || !/^sha256\/[A-Za-z0-9+/]{43}=$/.test(value.pin.value)
      || !Array.isArray(value.endpoints) || !value.endpoints.length || value.endpoints.length > 32
      || !value.endpoints.every(endpoint => { const url = new URL(endpoint); return url.protocol === 'https:' && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash })) return
    return value
  } catch { return }
}
