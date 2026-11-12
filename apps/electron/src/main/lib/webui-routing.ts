/**
 * Profer WebUI 路由与配置的纯判定层。
 *
 * 本文件刻意保持零副作用：不 import Electron、不读设置、不碰文件系统，
 * 便于用 bun:test 直接检验「哪些 URL 该放行」这一安全边界。
 */
import { networkInterfaces } from 'node:os'

const SESSION_PREFIX = '/s/'
const ASSET_PREFIX = '/webui/'

/** 最多同时发布的会话数：避免设置项被误写成超大数组拖慢每次请求 */
export const WEBUI_MAX_PUBLISHED = 32

/**
 * 网卡类型。存在的意义是「别让用户在面板里选中一张手机永远到不了的网卡」：
 * 隧道/VPN 网卡（Tailscale、Clash TUN、et_6_jkb2 这类）同样是合法 IPv4，
 * 却只对隧道内的设备可达，选中后表现为「同一个 Wi-Fi 也连不上」。
 */
export type WebuiInterfaceKind = 'loopback' | 'lan' | 'tunnel' | 'virtual' | 'link-local'

export interface WebuiNetworkInterface {
  name: string
  address: string
  internal: boolean
  kind: WebuiInterfaceKind
}

/** 别名里出现这些词基本可判定是隧道/VPN，而不是物理局域网网卡。 */
const TUNNEL_HINTS = [
  'tunnel', 'tailscale', 'zerotier', 'wireguard', 'wintun', 'vpn',
  'openvpn', 'ppp', 'utun', 'tap-', 'tun', 'clash', 'singbox', 'sing-box',
]

/** 虚拟网卡：能通但通常不是「手机所在的物理局域网」。 */
const VIRTUAL_HINTS = [
  'vmware', 'hyper-v', 'vethernet', 'virtualbox', 'docker', 'bluetooth',
  '本地连接*', 'local area connection*', 'loopback', 'npcap', 'virtual',
]

/** 网卡排序权重：局域网优先，回环最后（因为「全部网卡」已覆盖本机访问）。 */
const KIND_ORDER: Record<WebuiInterfaceKind, number> = {
  lan: 0,
  virtual: 1,
  tunnel: 2,
  'link-local': 3,
  loopback: 4,
}

/**
 * 网段优先级：家用/办公 Wi-Fi 绝大多数是 192.168.x.x，其次是 172.16-31.x.x，再是 10.x.x.x。
 *
 * 必要性：有些隧道网卡的别名（例如 `et_6_jkb2`）不含任何可识别关键词，靠名字分不出来；
 * 此时靠网段优先级兜底，至少不会把它排到家用 Wi-Fi 前面，让面板首选项和展示地址都错。
 */
function addressTier(address: string): number {
  if (address.startsWith('192.168.')) return 0
  if (address.startsWith('172.')) {
    const second = Number(address.split('.')[1] ?? Number.NaN)
    if (second >= 16 && second <= 31) return 1
  }
  if (address.startsWith('10.')) return 2
  return 3
}

export function classifyInterfaceKind(name: string, address: string, internal: boolean): WebuiInterfaceKind {
  if (internal) return 'loopback'
  // 169.254/16 是 DHCP 失败时的链路本地地址，手机按这个地址一定连不上。
  if (address.startsWith('169.254.')) return 'link-local'
  const lower = name.toLowerCase()
  if (TUNNEL_HINTS.some((hint) => lower.includes(hint))) return 'tunnel'
  if (VIRTUAL_HINTS.some((hint) => lower.includes(hint))) return 'virtual'
  return 'lan'
}

export type WebuiRoute =
  | { kind: 'foreign' }
  | { kind: 'root' }
  | { kind: 'session'; sessionId: string }
  | { kind: 'asset'; relativePath: string }
  | { kind: 'invalid' }

/** 归一化设置项里的会话白名单：丢弃脏值、去重、限长。 */
export function normalizePublishedIds(input: unknown): string[] {
  if (!Array.isArray(input)) return []
  const seen = new Set<string>()
  const result: string[] = []
  for (const item of input) {
    if (typeof item !== 'string') continue
    const id = item.trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    result.push(id)
    if (result.length >= WEBUI_MAX_PUBLISHED) break
  }
  return result
}

/**
 * 只放行 IPv4 字面量，避免把任意字符串交给 server.listen。
 * 0.0.0.0 是合法输入：监听全部网卡，是「不知道手机走哪张网卡」时最省心的选择。
 */
export function normalizeBindHost(input: unknown): string {
  if (typeof input !== 'string') return '127.0.0.1'
  const host = input.trim()
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(host) ? host : '127.0.0.1'
}

/** 静态资源相对路径白名单：禁止绝对路径、盘符、反斜杠与任何形式的目录穿越。 */
export function isSafeAssetPath(relative: string): boolean {
  if (!relative || relative.includes('\0') || relative.includes('\\')) return false
  if (relative.startsWith('/') || /^[A-Za-z]:/.test(relative)) return false
  return relative.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
}

/**
 * 解析 WebUI 请求路径。
 * - foreign：不属于 WebUI，交回 remote-service 原有的 404 逻辑
 * - invalid：属于 WebUI 但不应放行（未发布会话 / 非法资源路径）
 * - session：仅当 sessionId 在已发布白名单内才放行，这就是「默认 0 个网页」的落点
 */
export function resolveWebuiRoute(pathname: string, publishedIds: readonly string[]): WebuiRoute {
  if (!pathname.startsWith('/')) return { kind: 'foreign' }
  if (pathname === '/') return { kind: 'root' }
  if (pathname.startsWith(SESSION_PREFIX)) {
    const raw = pathname.slice(SESSION_PREFIX.length).replace(/\/+$/, '')
    let sessionId: string
    try {
      sessionId = decodeURIComponent(raw)
    } catch {
      return { kind: 'invalid' }
    }
    if (!sessionId || sessionId.includes('/') || sessionId.includes('\\')) return { kind: 'invalid' }
    if (!publishedIds.includes(sessionId)) return { kind: 'invalid' }
    return { kind: 'session', sessionId }
  }
  if (pathname.startsWith(ASSET_PREFIX)) {
    const relativePath = pathname.slice(ASSET_PREFIX.length)
    if (!isSafeAssetPath(relativePath)) return { kind: 'invalid' }
    return { kind: 'asset', relativePath }
  }
  return { kind: 'foreign' }
}

/** 枚举 IPv4 网卡供设置页下拉；回环地址也保留，便于「仅本机可访问」。 */
export function listWebuiInterfaces(): WebuiNetworkInterface[] {
  const result: WebuiNetworkInterface[] = []
  try {
    for (const [name, nets] of Object.entries(networkInterfaces())) {
      for (const net of nets ?? []) {
        if (net.family !== 'IPv4') continue
        result.push({ name, address: net.address, internal: net.internal, kind: classifyInterfaceKind(name, net.address, net.internal) })
      }
    }
  } catch {
    // 无可用网卡时不阻断设置页
  }
  return result.sort((a, b) =>
    KIND_ORDER[a.kind] - KIND_ORDER[b.kind]
    || addressTier(a.address) - addressTier(b.address)
    || a.address.localeCompare(b.address),
  )
}

/** 可能被手机访问到的地址（局域网类），按「最可能」排序；面板用来列出候选。 */
export function listAccessibleHosts(interfaces: readonly WebuiNetworkInterface[]): string[] {
  return interfaces
    .filter((item) => item.kind === 'lan')
    .sort((a, b) => addressTier(a.address) - addressTier(b.address) || a.address.localeCompare(b.address))
    .map((item) => item.address)
}

/**
 * 面板展示用的可达地址：监听 0.0.0.0 时不能把 127.0.0.1 复制给用户，
 * 那是「只有这台机器打得开」的地址，手机上必然是拒绝连接。
 */
export function pickAccessibleHost(interfaces: readonly WebuiNetworkInterface[]): string | null {
  return listAccessibleHosts(interfaces)[0] ?? null
}

/** 面板里展示/复制的会话 URL；0.0.0.0 只用于监听，展示时换成一张局域网网卡的地址。 */
export function buildPublishedUrls(
  publishedIds: readonly string[],
  port: number,
  host: string,
  token: string | null,
  accessibleHost?: string | null,
): Array<{ sessionId: string; url: string }> {
  const displayHost = host === '0.0.0.0' ? (accessibleHost ?? '127.0.0.1') : host
  const query = token ? `?token=${encodeURIComponent(token)}` : ''
  return publishedIds.map((sessionId) => ({
    sessionId,
    url: `http://${displayHost}:${port}/s/${encodeURIComponent(sessionId)}${query}`,
  }))
}
