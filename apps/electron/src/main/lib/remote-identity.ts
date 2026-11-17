import { safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { hostname, networkInterfaces } from 'node:os'
import { randomUUID } from 'node:crypto'
import { isPrivateHost, validateEndpoint, type RemoteEndpoint, type RemoteProfile, type PairingQr } from '@profer/shared'
import { getConfigDir } from './config-paths'
import { migrateRemoteToken } from './remote-token-migration'
import { PairingManager, createBinding, equalSecret, secretHash, type RemoteBinding } from './remote-pairing'

interface Identity { deviceId: string; deviceName: string; bindings: RemoteBinding[] }
let identity: Identity | null = null
let profileCache: RemoteProfile | null = null
export const pairingManager = new PairingManager()
function atomicJson(name: string, value: unknown): void {
  const dir = getConfigDir()
  mkdirSync(dir, { recursive: true })
  const file = join(dir, name)
  writeFileSync(`${file}.tmp`, JSON.stringify(value), { mode: 0o600 })
  renameSync(`${file}.tmp`, file)
}
function loadIdentity(): Identity {
  if (identity) return identity
  const path = join(getConfigDir(), 'remote-identity.json')
  if (existsSync(path)) {
    const saved = JSON.parse(readFileSync(path, 'utf8')) as Identity
    if (!saved.deviceId || !Array.isArray(saved.bindings)) throw new Error('设备身份文件无效')
    identity = saved
  } else {
    identity = { deviceId: randomUUID(), deviceName: hostname(), bindings: [] }
    atomicJson('remote-identity.json', identity)
  }
  return identity
}
function persistIdentity(next: Identity): void { atomicJson('remote-identity.json', next); identity = next }
export function protectSecret(secret: string): string {
  if (!safeStorage.isEncryptionAvailable() || (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')) throw new Error('系统安全存储不可用，未保存凭据')
  return safeStorage.encryptString(secret).toString('base64')
}
export function revealSecret(ciphertext: string): string {
  if (!safeStorage.isEncryptionAvailable() || (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')) throw new Error('系统安全存储不可用')
  return safeStorage.decryptString(Buffer.from(ciphertext, 'base64'))
}
export function loadRemoteToken(): string {
  const file = join(getConfigDir(), 'remote-token.json')
  if (process.env.PROFER_REMOTE_TOKEN) return process.env.PROFER_REMOTE_TOKEN
  const legacyFile = join(process.env.PROFER_CONFIG_DIR?.trim() || '.profer-dev', 'remote-token.json')
  return migrateRemoteToken(file, legacyFile, protectSecret, revealSecret)
}

/**
 * WebUI 的独立访问凭据。
 *
 * 与 Pocket 的 token **必须是两个值**：网页链接是要发给别人/放进书签的，
 * 而 Pocket 的凭据等同于「这台机器的远控权」。共用一个 token 时，任何拿到
 * 分享链接的人都能拿着它去连 Pocket 的端口（同一局域网内直接可达）。
 */
export function loadWebuiToken(): string {
  const file = join(getConfigDir(), 'webui-token.json')
  if (process.env.PROFER_WEBUI_TOKEN) return process.env.PROFER_WEBUI_TOKEN
  return migrateRemoteToken(file, file, protectSecret, revealSecret)
}
export function lanEndpoints(interfaces: ReturnType<typeof networkInterfaces>, port: number) {
  const addresses = new Set<string>()
  for (const nets of Object.values(interfaces)) for (const net of nets ?? []) {
    if (!net.internal && isPrivateHost(net.address)) addresses.add(net.address)
  }
  return [...addresses].sort().slice(0, 15).map((ip) => validateEndpoint({ url: `ws://${ip.includes(':') ? `[${ip}]` : ip}:${port}/ws`, scope: 'lan' }))
}
export function getConnectionProfile(port: number, publicEndpoint?: string | RemoteEndpoint): RemoteProfile {
  const id = loadIdentity()
  // 当前阶段收缩二维码体积：只带一个局域网地址。多网卡/多端点回退等公网方案恢复时再加。
  const endpoints = lanEndpoints(networkInterfaces(), port).slice(0, 1)
  if (publicEndpoint) endpoints.push(validateEndpoint(typeof publicEndpoint === 'string' ? { url: publicEndpoint, scope: 'public' } : publicEndpoint))
  if (!endpoints.length) endpoints.push(validateEndpoint({ url: `ws://127.0.0.1:${port}/ws`, scope: 'lan' }))
  const candidate: RemoteProfile = { schemaVersion: endpoints.some((e) => e.trustMode) ? 2 : 1, deviceId: id.deviceId, deviceName: id.deviceName, endpoints, updatedAt: profileCache?.updatedAt ?? Date.now() }
  if (!profileCache || JSON.stringify(candidate) !== JSON.stringify(profileCache)) candidate.updatedAt = Math.max(Date.now(), (profileCache?.updatedAt ?? 0) + 1)
  profileCache = candidate
  return candidate
}
export function refreshPairing(profile: RemoteProfile): PairingQr { return pairingManager.refresh(profile) }
export function pairDevice(code: string, peer: string, name: string): { credential: string; bindingId: string } {
  const current = loadIdentity()
  if (current.bindings.length >= 64) throw new Error('已配对设备数量达到上限')
  pairingManager.consume(code, peer)
  const result = createBinding(name)
  persistIdentity({ ...current, bindings: [...current.bindings, result.binding] })
  return { credential: result.credential, bindingId: result.binding.id }
}
export function authenticateRemote(token: string, legacy: string | null): string | null {
  const id = loadIdentity()
  const binding = id.bindings.find((b) => equalSecret(b.tokenHash, secretHash(token)))
  if (binding) return binding.id
  return legacy && equalSecret(token, legacy) ? 'legacy' : null
}
export function listBindings(): Array<Omit<RemoteBinding, 'tokenHash'>> { return loadIdentity().bindings.map(({ tokenHash: _, ...b }) => b) }
export function revokeBinding(id: string): void { const current = loadIdentity(); persistIdentity({ ...current, bindings: current.bindings.filter((b) => b.id !== id) }) }
