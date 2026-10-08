import type { AppUpdater } from 'electron-updater'

type UpdateFeedConfiguration = Exclude<Parameters<AppUpdater['setFeedURL']>[0], string>

export interface UpdateSource {
  id: 'override' | 'domestic' | 'domestic-fallback' | 'github'
  label: string
  configuration: UpdateFeedConfiguration
  /**
   * 该源的元数据地址，供「并行探活」决定实际尝试顺序使用。
   * GitHub 源由 provider 内部解析 Release，没有静态元数据地址，固定为 null（不参与探测）。
   */
  probeUrl: string | null
}

/**
 * 国内主更新源：旧机静态目录 `profer.cn/profer-updates/`（阿里云，国内直连）。
 *
 * 2026-10-08：香港机 `45.114.127.232` 失联，`updates.profer.cn` 已不可达，主备顺序切回旧机。
 */
export const DOMESTIC_UPDATE_FEED_URL = 'https://profer.cn/profer-updates/'
/**
 * 备用国内源：香港机专属域名。
 *
 * 香港机 2026-10-08 失联后由主源降级为备用；若确认该域名不再使用，可直接从
 * `getUpdateSources` 中移除（客户端在它之后仍有 GitHub 兜底）。
 */
export const DOMESTIC_FALLBACK_UPDATE_FEED_URL = 'https://updates.profer.cn/'
/** 单个更新源的请求超时。注意：这是「请求级」超时，串行回退时每个死源都会各吃满一次。 */
export const UPDATE_REQUEST_TIMEOUT_MS = 30_000
/** 并行探活超时。黑洞型故障（丢包不回 RST）下，探活必须远早于 30s 的请求超时放弃。 */
export const UPDATE_PROBE_TIMEOUT_MS = 4_000

const GITHUB_UPDATE_SOURCE: UpdateSource = {
  id: 'github',
  label: 'GitHub Releases',
  configuration: {
    provider: 'github',
    owner: 'Yuan-lai-ru-ci',
    repo: 'ProferAI',
    releaseType: 'release',
    timeout: UPDATE_REQUEST_TIMEOUT_MS,
  },
  probeUrl: null,
}

function normalizeFeedUrl(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

/** 拼接探活地址：容忍 feedUrl 带或不带尾斜杠，不会产生双斜杠。 */
function joinMetadataUrl(feedUrl: string, fileName: string): string {
  return `${normalizeFeedUrl(feedUrl)}/${fileName}`
}

/**
 * electron-updater 的 generic provider 按平台请求不同的元数据文件名。
 * 探活必须用同一个文件名，否则会把「文件不存在」误判成「源不可达」。
 */
export function updateMetadataFileName(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'darwin') return 'latest-mac.yml'
  if (platform === 'linux') return 'latest-linux.yml'
  return 'latest.yml'
}

/** 只接受 HTTPS 域名更新源；URL 中不得携带凭据或使用 IP 地址。 */
export function isSecureUpdateFeedUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim()) return false
  try {
    const url = new URL(value.trim())
    return url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      url.hostname.includes('.') &&
      !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(url.hostname) &&
      !/^\[[0-9a-f:]+\]$/i.test(url.hostname)
  } catch {
    return false
  }
}

/**
 * 客户端运行时更新源顺序。
 * 国内源是默认主源，GitHub 只在主源不可达或下载失败时作为备用。
 *
 * generic provider 会由 electron-updater 根据运行平台自动请求：
 * Windows 为 latest.yml，macOS 为 latest-mac.yml。因此两个平台共用同一个 HTTPS
 * 目录，发布时必须同时提供各自平台的元数据和安装包。
 *
 * 这里返回的只是「声明顺序」。实际尝试顺序由 `orderSourcesByReachability` 按并发探活
 * 结果重排——否则一个指向黑洞 IP 的源会让每次检查都先白等满 30s 超时。
 */
export function getUpdateSources(
  overrideUrl = process.env.PROFER_UPDATE_FEED_URL,
  platform: NodeJS.Platform = process.platform,
): UpdateSource[] {
  const sources: UpdateSource[] = []
  const metadataFile = updateMetadataFileName(platform)
  const normalizedDomesticUrl = normalizeFeedUrl(DOMESTIC_UPDATE_FEED_URL)
  const normalizedFallbackUrl = normalizeFeedUrl(DOMESTIC_FALLBACK_UPDATE_FEED_URL)

  const genericSource = (
    id: 'override' | 'domestic' | 'domestic-fallback',
    label: string,
    feedUrl: string,
  ): UpdateSource => ({
    id,
    label,
    // 注意：feedUrl 必须原样传给 electron-updater，**不能**剥掉尾斜杠。
    // generic provider 用 `new URL(文件名, feedUrl)` 拼接元数据地址，缺尾斜杠会把最后一段
    // 当成文件而替换掉（`…/profer-updates` + `latest.yml` → `…/latest.yml`），更新直接失效。
    configuration: {
      provider: 'generic',
      url: feedUrl,
      timeout: UPDATE_REQUEST_TIMEOUT_MS,
    },
    probeUrl: joinMetadataUrl(feedUrl, metadataFile),
  })

  if (overrideUrl && !isSecureUpdateFeedUrl(overrideUrl)) {
    console.warn('[更新] 忽略不安全的 PROFER_UPDATE_FEED_URL，仅允许 HTTPS 域名')
  }

  const normalizedOverride = overrideUrl ? normalizeFeedUrl(overrideUrl) : ''
  if (isSecureUpdateFeedUrl(overrideUrl) && normalizedOverride !== normalizedDomesticUrl && normalizedOverride !== normalizedFallbackUrl) {
    sources.push(genericSource('override', '环境变量更新源', normalizedOverride))
  }

  sources.push(genericSource('domestic', '国内更新服务器', DOMESTIC_UPDATE_FEED_URL))
  sources.push(genericSource('domestic-fallback', '备用国内更新源', DOMESTIC_FALLBACK_UPDATE_FEED_URL))
  sources.push(GITHUB_UPDATE_SOURCE)
  return sources
}
