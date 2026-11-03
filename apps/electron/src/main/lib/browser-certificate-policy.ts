/**
 * 受管浏览器的证书信任边界。
 *
 * 背景：Chrome 通过 Component Updater 下发 CRLSet，能在数小时内拉黑私钥泄露的
 * 中间 CA（2026-10-17 eMudhra 事件：18:05 UTC 收到报告，19:45 UTC 已推送封锁）。
 * Electron 不运行 Chrome 的组件更新通道，内置浏览器的 CRLSet 停留在构建时，
 * 因此「Chrome 已拉黑」的证书在受管浏览器里仍会被信任。
 *
 * 这里用 SPKI SHA-256 黑名单补上这条路径：
 *   - 基线：与 Go 1.27.3 crypto/x509 的 distrustedSPKIHashes（CVE-2026-111943）一致；
 *   - 远程：Profer Server /v1/public/security/distrusted-spki，启动时拉取并缓存，
 *     之后每 6 小时刷新；拉取失败时继续用基线与上次缓存。
 */
import { createHash, X509Certificate } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Certificate, Session } from 'electron'

/**
 * eMudhra 八张中间 CA（私钥已泄露，可用于伪造任意站点证书）。
 * 六张 TLS 证书会被 Chromium 的 TLS 验证路径使用；两张代码签名证书一并列入，
 * 成本为零，且避免未来验证路径变化时漏掉。
 * 来源：Go 1.27.3 crypto/x509/verify.go distrustedSPKIHashes。
 */
export const DISTRUSTED_SPKI_SHA256: ReadonlySet<string> = new Set([
  'ebed6475c2c2d80fcb199f3fe8dd6e6b3ce60b77eb15d4e42c3dec0c6f5b5105',
  '49dd353dc2b919a3770645117d0e60c16115e7d1bc259eefe734b00ea434fe5f',
  'e0254c7fcdc265e2f0f8a428dabb75ab4ae039b4872d62f5ee57f0877d5a8a41',
  '5c0660a2b164910d8ff589c18e14552e9e0ec237dcefe2cb736d41a4811f81a0',
  '43bffa19d6ef651451f6841e019931e96f6f2eaeff28ab4b6f1ce4576de2717b',
  '63ecefee431d49523bc1136c4e72d0206a477086caf606cd5cf025686c109cf8',
  'ec4ffa1ad0ac88081314b7aaffef6a91f97cd57291bb5ba686c5415f5eb4f6b6',
  '92c063d67e8f14db71d288e11266ffdaf69cbf115f7bab14f3bc2f68d25e0e30',
])

export const DEFAULT_SECURITY_FEED_URL = process.env.PROFER_SECURITY_FEED_URL
  || 'https://profer.cn/profer/v1/public/security/distrusted-spki'

const CACHE_FILE_NAME = 'browser-distrusted-spki.json'
const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000
const MAX_REMOTE_HASHES = 512
const SHA256_HEX = /^[0-9a-f]{64}$/

let activeDistrustedSpki: ReadonlySet<string> = DISTRUSTED_SPKI_SHA256
let policyInitialized = false
let feedFailureReported = false

export function getDistrustedSpkiHashes(): ReadonlySet<string> {
  return activeDistrustedSpki
}

/** 解析远程/缓存载荷；只接受 64 位 hex，去重并限长。 */
export function parseDistrustedSpkiFeed(payload: unknown): string[] {
  const list = Array.isArray(payload)
    ? payload
    : (payload as { spkiSha256?: unknown } | null | undefined)?.spkiSha256
  if (!Array.isArray(list)) throw new Error('证书黑名单格式无效。')
  const hashes: string[] = []
  const seen = new Set<string>()
  for (const value of list) {
    if (typeof value !== 'string') continue
    const hash = value.trim().toLowerCase()
    if (!SHA256_HEX.test(hash) || seen.has(hash)) continue
    seen.add(hash)
    hashes.push(hash)
    if (hashes.length >= MAX_REMOTE_HASHES) break
  }
  if (hashes.length === 0) throw new Error('证书黑名单为空。')
  return hashes
}

/** 基线永远保留；远程项只能追加，不能因为服务端返回空/被篡改而放宽信任。 */
export function mergeDistrustedSpkiHashes(hashes: Iterable<string>): void {
  const merged = new Set(DISTRUSTED_SPKI_SHA256)
  for (const value of hashes) {
    const hash = value.trim().toLowerCase()
    if (SHA256_HEX.test(hash)) merged.add(hash)
  }
  activeDistrustedSpki = merged
}

/** 仅供测试：恢复为基线集合。 */
export function resetDistrustedSpkiHashesForTest(): void {
  activeDistrustedSpki = DISTRUSTED_SPKI_SHA256
  policyInitialized = false
  feedFailureReported = false
}

/**
 * 远程黑名单是增强项，基线已经覆盖已知泄露 CA：
 * 失败只在首次提示一次，避免端点未部署或网络故障时每 6 小时刷日志。
 */
function reportFeedFailure(error: unknown): void {
  if (feedFailureReported) return
  feedFailureReported = true
  console.warn(
    '[受管浏览器] 证书黑名单刷新失败，继续使用本地基线与缓存:',
    error instanceof Error ? error.message : error,
  )
}

/** 解析 PEM 并计算 SPKI 的 SHA-256（小写 hex）；非法证书返回 null。 */
export function spkiSha256FromPem(pem: string): string | null {
  try {
    const certificate = new X509Certificate(pem)
    const der = certificate.publicKey.export({ type: 'spki', format: 'der' })
    return createHash('sha256').update(der).digest('hex')
  } catch {
    return null
  }
}

/** 纯判定，便于在无 Electron 环境测试。 */
export function isDistrustedSpkiHash(
  hash: string | null,
  distrusted: ReadonlySet<string> = activeDistrustedSpki,
): boolean {
  return hash !== null && distrusted.has(hash.toLowerCase())
}

function certificateIsDistrusted(certificate: Certificate, distrusted: ReadonlySet<string>): boolean {
  return isDistrustedSpkiHash(spkiSha256FromPem(certificate.data), distrusted)
}

/**
 * 沿 issuerCert 链检查。Electron 的 Certificate 链在多数平台可达根证书；
 * 中途断开时只检查已拿到的部分，不会因为拿不到根而放行已知的泄露中间 CA。
 */
export function chainContainsDistrustedCertificate(
  certificate: Certificate | undefined | null,
  distrusted: ReadonlySet<string> = activeDistrustedSpki,
): boolean {
  const seen = new Set<Certificate>()
  let current = certificate
  while (current && !seen.has(current)) {
    seen.add(current)
    if (certificateIsDistrusted(current, distrusted)) return true
    current = current.issuerCert
  }
  return false
}

export function readDistrustedSpkiCache(cacheFile: string): string[] | null {
  try {
    return parseDistrustedSpkiFeed(JSON.parse(readFileSync(cacheFile, 'utf-8')))
  } catch {
    return null
  }
}

function writeDistrustedSpkiCache(cacheFile: string, hashes: string[]): void {
  try {
    mkdirSync(dirname(cacheFile), { recursive: true })
    const temporary = `${cacheFile}.tmp`
    writeFileSync(temporary, JSON.stringify({
      version: 1,
      updatedAt: new Date().toISOString(),
      spkiSha256: hashes,
    }), 'utf-8')
    renameSync(temporary, cacheFile)
  } catch (error) {
    console.warn('[受管浏览器] 写入证书黑名单缓存失败:', error instanceof Error ? error.message : error)
  }
}

/** 拉取远程黑名单并合并；失败由调用方决定是否降级。 */
export async function refreshDistrustedSpkiHashes(options: {
  feedUrl?: string
  cacheFile?: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
} = {}): Promise<{ count: number }> {
  const fetchImpl = options.fetchImpl ?? fetch
  const response = await fetchImpl(options.feedUrl ?? DEFAULT_SECURITY_FEED_URL, {
    signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    headers: { accept: 'application/json' },
  })
  if (!response.ok) throw new Error(`证书黑名单请求失败：HTTP ${response.status}`)
  const hashes = parseDistrustedSpkiFeed(await response.json())
  mergeDistrustedSpkiHashes(hashes)
  if (options.cacheFile) writeDistrustedSpkiCache(options.cacheFile, hashes)
  return { count: hashes.length }
}

/**
 * 只装在受管浏览器的 session 上，不影响主窗口与其它 partition。
 * 回调 -2 = 拒绝连接；-3 = 使用 Chromium 默认验证结果。
 * 首次调用会读取本地缓存并触发远程刷新，后续调用只装 verifyProc。
 */
export function installDistrustedCertificateGuard(
  browserSession: Session,
  options: { cacheDir?: string } = {},
): void {
  browserSession.setCertificateVerifyProc((request, callback) => {
    try {
      if (chainContainsDistrustedCertificate(request.certificate)) {
        callback(-2)
        return
      }
      callback(-3)
    } catch {
      // 校验过程本身异常时交回 Chromium 默认逻辑，避免把正常站点误伤成不可访问。
      callback(-3)
    }
  })

  if (policyInitialized) return
  policyInitialized = true

  const cacheFile = options.cacheDir ? join(options.cacheDir, CACHE_FILE_NAME) : undefined
  if (cacheFile) {
    const cached = readDistrustedSpkiCache(cacheFile)
    if (cached) mergeDistrustedSpkiHashes(cached)
  }

  void refreshDistrustedSpkiHashes({ cacheFile }).catch(reportFeedFailure)

  const timer = setInterval(() => {
    void refreshDistrustedSpkiHashes({ cacheFile }).catch(reportFeedFailure)
  }, REFRESH_INTERVAL_MS)
  timer.unref?.()
}
