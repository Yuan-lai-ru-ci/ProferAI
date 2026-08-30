import type { AppUpdater } from 'electron-updater'

type UpdateFeedConfiguration = Exclude<Parameters<AppUpdater['setFeedURL']>[0], string>

export interface UpdateSource {
  id: 'override' | 'domestic' | 'github'
  label: string
  configuration: UpdateFeedConfiguration
}

/** 国内更新源必须使用有证书的 HTTPS 域名，禁止裸 IP 和明文 HTTP。 */
export const DOMESTIC_UPDATE_FEED_URL = 'https://profer.cn/profer-updates/'
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
 */
export function getUpdateSources(overrideUrl = process.env.PROFER_UPDATE_FEED_URL): UpdateSource[] {
  const sources: UpdateSource[] = []
  const normalizedDomesticUrl = normalizeFeedUrl(DOMESTIC_UPDATE_FEED_URL)

  if (overrideUrl && !isSecureUpdateFeedUrl(overrideUrl)) {
    console.warn('[更新] 忽略不安全的 PROFER_UPDATE_FEED_URL，仅允许 HTTPS 域名')
  }

  if (isSecureUpdateFeedUrl(overrideUrl) && normalizeFeedUrl(overrideUrl) !== normalizedDomesticUrl) {
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
  sources.push(GITHUB_UPDATE_SOURCE)
  return sources
}
