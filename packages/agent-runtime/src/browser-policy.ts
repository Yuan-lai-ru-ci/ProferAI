/** 受管浏览器的纯 URL 边界；保持无 Electron 依赖，便于在普通 Bun 测试中验证。 */
import { lookup } from 'node:dns/promises'

const BROWSER_DNS_LOOKUP_TIMEOUT_MS = 3_000

function isPrivateAddress(hostname: string): boolean {
  const host = hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true
  const ipv6 = host.replace(/^\[/, '').replace(/\]$/, '')
  // IPv6 loopback/unspecified、IPv4-mapped、ULA、link-local 与 multicast 都不能作为
  // 受管浏览器的网络目的地。对 IPv4-mapped 地址一律拒绝，避免映射后绕过 IPv4 私网段判断。
  if (ipv6 === '::' || ipv6 === '::1' || ipv6.startsWith('::ffff:') || ipv6.startsWith('fc') || ipv6.startsWith('fd') || ipv6.startsWith('fe8') || ipv6.startsWith('fe9') || ipv6.startsWith('fea') || ipv6.startsWith('feb') || ipv6.startsWith('ff')) return true
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!match) return false
  const a = Number(match[1] ?? 0)
  const b = Number(match[2] ?? 0)
  return a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a === 0 || a >= 224
}

/** 从 URL 中安全取出 hostname；空值或非法 URL 返回 null（调用方据此走「顶层未知」分支）。 */
function parseUrlHostname(input: string | null | undefined): string | null {
  if (!input) return null
  try {
    return new URL(input).hostname
  } catch {
    return null
  }
}

/**
 * 地址栏可直接输入域名或路径（例如 `example.com/docs`）；公网缺省按 HTTPS 打开，
 * 明确的本机/局域网开发地址缺省按 HTTP 打开。
 * 显式协议仍按原安全策略校验，绝不把 `javascript:` 等输入误当作域名。
 */
export function normalizeBrowserUrl(input: string): string {
  const value = input.trim()
  if (!value) throw new Error('浏览器地址不能为空。')
  // 协议相对地址没有当前页面协议可继承；本地回环地址按开发服务器常用的 HTTP 处理，
  // 公网地址则按 HTTPS 处理。
  if (value.startsWith('//')) {
    try {
      const protocol = isPrivateAddress(new URL(`http:${value}`).hostname) ? 'http:' : 'https:'
      return `${protocol}${value}`
    } catch {
      return `https:${value}`
    }
  }
  // 本地开发服务器常见的是 `localhost:3000` / `127.0.0.1:5173` / `192.168.x.x:8080`，
  // 明确输入的局域网开发地址缺省协议也必须是 HTTP。
  try {
    if (isPrivateAddress(new URL(`http://${value}`).hostname)) return `http://${value}`
  } catch { /* 继续按公网地址栏输入处理 */ }
  // `example.com:8080` 是没有协议的常见地址栏输入，不能被误判为 scheme。
  if (/^[^/?#:\s]+:\d+(?:[/?#]|$)/.test(value)) return `https://${value}`
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(value)) return value
  return `https://${value}`
}

export function assertSafeBrowserUrl(input: string): string {
  const normalized = normalizeBrowserUrl(input)
  let parsed: URL
  try { parsed = new URL(normalized) } catch { throw new Error('浏览器地址无效。请输入公共域名或完整的 HTTP/HTTPS URL。') }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('受管浏览器不允许此 URL 协议。')
  if (parsed.username || parsed.password) throw new Error('受管浏览器不允许访问带认证信息的 URL。')
  return parsed.toString()
}

/**
 * 子资源不重复执行异步 DNS 查询（逐资源查 DNS 会拖垮正常页面），只做同步的
 * 协议与认证信息检查。本机/局域网地址在这里一律放行：本地开发页面必须能加载
 * 自己同源的脚本、样式和 XHR；公网域名到私网 IP 的解析仍由主框架的
 * assertSafeBrowserDestination 拦截。
 */
export function isSafeBrowserSubresourceUrl(input: string): boolean {
  try {
    const parsed = new URL(input)
    return ['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol)
      && !parsed.username
      && !parsed.password
  } catch {
    return false
  }
}

/**
 * 按顶层页面信任上下文校验子资源：本地开发页允许加载本地依赖；公网页面拒绝明显的私网目标。
 * 非私网公网资源不重复做 DNS 查询，完整的 DNS rebinding 防护仍应由受控 egress 层承担。
 */
export async function assertSafeBrowserSubresourceDestination(input: string, topLevelUrl: string | null | undefined): Promise<string> {
  if (!isSafeBrowserSubresourceUrl(input)) throw new Error('受管浏览器不允许此子资源协议或认证信息。')
  const resource = new URL(input)
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(resource.protocol)) throw new Error('受管浏览器不允许此子资源协议。')
  const topLevelHostname = parseUrlHostname(topLevelUrl)
  // 顶层页面未知（标签定位失败、地址尚未落定等）时，绝不能把整页子资源一律拒绝：
  // 那会让页面只剩裸 HTML（CSS/图片/脚本全部加载失败，主文档却正常）。
  // 这里退化为「只拦本机/私网子资源」，公网子资源照常放行。
  if (!topLevelHostname) {
    if (isPrivateAddress(resource.hostname)) throw new Error('无法确认顶层页面时，不允许加载本机或私网子资源。')
    return resource.toString()
  }
  if (!isPrivateAddress(topLevelHostname) && isPrivateAddress(resource.hostname)) {
    throw new Error('公网页面不得访问本机或私网子资源。')
  }
  return resource.toString()
}

/**
 * 导航/请求开始前再次解析域名并拒绝落到非公网地址的结果。
 * 用户直接输入的本机/局域网地址（localhost、127.x、10.x、192.168.x、.local 等）
 * 视为有意指定的开发目标，不做 DNS 校验。
 * Chromium 仍是最终网络栈；完整 DNS-rebinding 防护需要后续接入受控 egress proxy，
 * 但这个 guard 可以阻断“公网域名解析到私网”的常见攻击路径。
 */
async function lookupBrowserAddresses(hostname: string): Promise<Array<{ address: string }>> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      lookup(hostname, { all: true, verbatim: true }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('DNS 查询超时。')), BROWSER_DNS_LOOKUP_TIMEOUT_MS)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function assertSafeBrowserDestination(input: string): Promise<string> {
  const safeUrl = assertSafeBrowserUrl(input)
  const hostname = new URL(safeUrl).hostname
  // 明确的本机/局域网开发地址不需要 DNS 查询；localhost 在不同系统上可能解析到 IPv4/IPv6，
  // 用户直接输入私网 IP 或 .local 主机名时，也应作为本地页面正常预览。
  if (isPrivateAddress(hostname)) return safeUrl
  let addresses: Array<{ address: string }>
  try {
    addresses = await lookupBrowserAddresses(hostname)
  } catch {
    throw new Error('受管浏览器无法确认目标网站的公网地址，请稍后重试。')
  }
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error('受管浏览器拒绝访问解析到本机或私网的地址。')
  }
  return safeUrl
}
