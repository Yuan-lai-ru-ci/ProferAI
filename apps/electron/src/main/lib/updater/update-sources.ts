import type { AppUpdater } from 'electron-updater'

type UpdateFeedConfiguration = Exclude<Parameters<AppUpdater['setFeedURL']>[0], string>

export interface UpdateSource {
  id: 'override' | 'domestic' | 'github'
  label: string
  configuration: UpdateFeedConfiguration
}

export const DOMESTIC_UPDATE_FEED_URL = 'http://47.109.108.57/profer-updates/'
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
  return url.replace(/\/+$/, '')
}

/**
 * 客户端运行时更新源顺序。
 * 国内源是默认主源，GitHub 只在主源不可达或下载失败时作为备用。
 */
export function getUpdateSources(overrideUrl = process.env.PROFER_UPDATE_FEED_URL): UpdateSource[] {
  const sources: UpdateSource[] = []
  const normalizedDomesticUrl = normalizeFeedUrl(DOMESTIC_UPDATE_FEED_URL)

  if (overrideUrl && normalizeFeedUrl(overrideUrl) !== normalizedDomesticUrl) {
    sources.push({
      id: 'override',
      label: '环境变量更新源',
      configuration: {
        provider: 'generic',
        url: overrideUrl,
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
