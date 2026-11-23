import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface StoredCoreEndpoint {
  id: string
  label: string
  baseUrl: string
  encryptedToken: string
  /** 配对身份锚，不从地址更新或高级表单自动替换。 */
  identityPin?: string
  bindingId?: string
  /** 显式隧道线路不自动回退到局域网地址或发现结果。 */
  tunnel?: boolean
}

export interface StoredCoreTarget {
  expiresAt?: number
  id: string
  name: string
  coreId: string
  version?: string
  capabilities?: string[]
  platform?: string
  osId?: string
  selectedEndpointId: string
  endpoints: StoredCoreEndpoint[]
}

export interface CoreTargetStore {
  // 仅记录主动选择的启动偏好；不记录本次启动回退结果。
  preferredId: string
  targets: StoredCoreTarget[]
}

interface LegacyTarget extends Partial<StoredCoreTarget> {
  baseUrl?: string
  encryptedToken?: string
}

export function migrateCoreTargetStore(value: unknown): CoreTargetStore {
  if (!value || typeof value !== 'object') throw new Error('远程内核配置格式错误')
  const input = value as { preferredId?: string; currentId?: string; targets: LegacyTarget[] }
  if (!Array.isArray(input.targets)) throw new Error('远程内核配置缺少设备列表')
  let preferredId = input.preferredId ?? input.currentId ?? 'local'
  const byCore = new Map<string, StoredCoreTarget>()
  for (const item of input.targets) {
    if (!item || typeof item.id !== 'string' || typeof item.name !== 'string' || !item.id || item.id === 'local') {
      throw new Error('远程内核配置包含无效设备')
    }
    // 旧版 addCoreTarget 始终先验证 coreId；没有身份的记录不能当作已验证连接。
    if (typeof item.coreId !== 'string' || !item.coreId) throw new Error('已保存的远程内核缺少身份')
    const endpoints = item.endpoints ?? [{ id: item.id, label: '默认地址', baseUrl: item.baseUrl, encryptedToken: item.encryptedToken }]
    if (!Array.isArray(endpoints) || !endpoints.length || endpoints.some(endpoint => !endpoint || !endpoint.id || !endpoint.baseUrl || !endpoint.encryptedToken)) {
      throw new Error('远程内核配置包含无效地址')
    }
    if ((endpoints as StoredCoreEndpoint[]).some(endpoint => endpoint.identityPin !== undefined && !/^sha256\/[A-Za-z0-9+/]{43}=$/.test(endpoint.identityPin))) throw new Error('Core 配对身份指纹无效')
    const pins = new Set((endpoints as StoredCoreEndpoint[]).map(endpoint => endpoint.identityPin).filter(Boolean))
    if (pins.size > 1) throw new Error('同一 Core 包含不一致的配对身份')
    const selected = endpoints.find(endpoint => endpoint.id === (item.selectedEndpointId ?? item.id))
    if (!selected) throw new Error('远程内核配置缺少首选地址')
    const existing = byCore.get(item.coreId)
    if (existing) {
      const knownPin = existing.endpoints.find(endpoint => endpoint.identityPin)?.identityPin
      if (knownPin && pins.size && !pins.has(knownPin)) throw new Error('Core 配对身份与已有目标不一致')
      for (const endpoint of endpoints as StoredCoreEndpoint[]) {
        const prior = existing.endpoints.find(e => e.baseUrl === endpoint.baseUrl)
        if (!prior) existing.endpoints.push({ ...endpoint })
        if (preferredId === item.id && endpoint.id === selected.id) existing.selectedEndpointId = prior?.id ?? endpoint.id
      }
      if (preferredId === item.id) preferredId = existing.id
    } else {
      byCore.set(item.coreId, { id: item.id, name: item.name, coreId: item.coreId, platform: item.platform, osId: item.osId,
        expiresAt: item.expiresAt, version: item.version, capabilities: item.capabilities, selectedEndpointId: selected.id,
        endpoints: (endpoints as StoredCoreEndpoint[]).map(endpoint => ({ ...endpoint })) })
    }
  }
  const targets = [...byCore.values()]
  if (preferredId !== 'local' && !targets.some(item => item.id === preferredId)) throw new Error('远程内核配置缺少上次选择的内核')
  return { preferredId, targets }
}

export function readCoreTargetStore(path: string): CoreTargetStore {
  let raw: string
  try { raw = readFileSync(path, 'utf8') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { preferredId: 'local', targets: [] }
    throw error
  }
  return migrateCoreTargetStore(JSON.parse(raw))
}

export function writeCoreTargetStore(path: string, store: CoreTargetStore): void {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, JSON.stringify(store, null, 2), { mode: 0o600, flag: 'wx' })
    renameSync(temp, path)
  } finally { rmSync(temp, { force: true }) }
}
