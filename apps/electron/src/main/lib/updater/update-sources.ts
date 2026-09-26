import type { AppUpdater } from 'electron-updater'

type UpdateFeedConfiguration = Exclude<Parameters<AppUpdater['setFeedURL']>[0], string>

export interface UpdateSource {
  id: 'override' | 'domestic' | 'domestic-legacy' | 'github'
  label: string
  configuration: UpdateFeedConfiguration
}

/** 国内主更新源：新机专属 HTTPS 域名（45.114.127.232 / updates.profer.cn）。 */
export const DOMESTIC_UPDATE_FEED_URL = 'https://updates.profer.cn/'
/** 旧域名更新源：profer.cn/profer-updates/，供数端正从旧机迁往新机；过渡期作为第二源，旧机退役后移除。 */
export const LEGACY_DOMESTIC_UPDATE_FEED_URL = 'https://profer.cn/profer-updates/'
export const UPDATE_REQUEST_TIMEOUT_MS = 30_000

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
}

function normalizeFeedUrl(url: string): string {
  return url.trim().replace(/\/+$/, '')
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
 */
export function getUpdateSources(overrideUrl = process.env.PROFER_UPDATE_FEED_URL): UpdateSource[] {
  const sources: UpdateSource[] = []
  const normalizedDomesticUrl = normalizeFeedUrl(DOMESTIC_UPDATE_FEED_URL)
  const normalizedLegacyUrl = normalizeFeedUrl(LEGACY_DOMESTIC_UPDATE_FEED_URL)

  if (overrideUrl && !isSecureUpdateFeedUrl(overrideUrl)) {
    console.warn('[更新] 忽略不安全的 PROFER_UPDATE_FEED_URL，仅允许 HTTPS 域名')
  }

  const normalizedOverride = overrideUrl ? normalizeFeedUrl(overrideUrl) : ''
  if (isSecureUpdateFeedUrl(overrideUrl) && normalizedOverride !== normalizedDomesticUrl && normalizedOverride !== normalizedLegacyUrl) {
    sources.push({
      id: 'override',
      label: '环境变量更新源',
      configuration: {
        provider: 'generic',
        url: normalizeFeedUrl(overrideUrl),
        timeout: UPDATE_REQUEST_TIMEOUT_MS,
      },
    })
  }

  sources.push({
    id: 'domestic',
    label: '国内更新服务器',
    configuration: {
      provider: 'generic',
      url: DOMESTIC_UPDATE_FEED_URL,
      timeout: UPDATE_REQUEST_TIMEOUT_MS,
    },
  })
  sources.push({
    id: 'domestic-legacy',
    label: '旧域名更新源',
    configuration: {
      provider: 'generic',
      url: LEGACY_DOMESTIC_UPDATE_FEED_URL,
      timeout: UPDATE_REQUEST_TIMEOUT_MS,
    },
  })
  sources.push(GITHUB_UPDATE_SOURCE)
  return sources
}
