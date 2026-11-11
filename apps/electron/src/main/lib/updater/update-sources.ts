import type { AppUpdater } from 'electron-updater'
import { isCommercialBuild } from '../build-target'

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

/** 发行版：决定用哪一组更新目录。 */
export type UpdateEdition = 'oss' | 'commercial'

/**
 * 开源版国内主源目录。
 *
 * 与商业版目录**物理隔离**：两个发行版的元数据文件同名（latest.yml /
 * latest-mac.yml），放进同一目录会互相覆盖，安装器也无法区分该给谁。
 */
export const OSS_UPDATE_FEED_URL = 'https://profer.cn/profer-updates/oss/'
export const OSS_FALLBACK_UPDATE_FEED_URL = 'https://updates.profer.cn/oss/'

/**
 * 商业版国内主源：沿用存量平铺目录。
 *
 * 已安装的商业版老用户读的就是这个地址，改路径等于让存量用户停止收到更新，
 * 所以商业版继承原路径，由新增的开源版去占新目录。
 *
 * 2026-10-08：香港机失联，`updates.profer.cn` 已不可达，主备顺序切回旧机。
 */
export const COMMERCIAL_UPDATE_FEED_URL = 'https://profer.cn/profer-updates/'
/** 商业版备用国内源：香港机专属域名（失联后降级为备用）。 */
export const COMMERCIAL_FALLBACK_UPDATE_FEED_URL = 'https://updates.profer.cn/'

/** @deprecated 旧名，等价于商业版目录。新代码请直接用带发行版语义的常量。 */
export const DOMESTIC_UPDATE_FEED_URL = COMMERCIAL_UPDATE_FEED_URL
/** @deprecated 旧名，等价于商业版备用目录。 */
export const DOMESTIC_FALLBACK_UPDATE_FEED_URL = COMMERCIAL_FALLBACK_UPDATE_FEED_URL
/**
 * 并行探活超时。黑洞型故障（丢包不回 RST）下，探活必须远早于真正的元数据请求放弃。
 *
 * 注意：元数据请求本身的截止时间**不在**这里，也不能写进 electron-updater 的
 * provider `timeout` 字段——6.8.9 的 ElectronHttpExecutor 不设请求超时，
 * provider 配置里的 `timeout` 不会被任何 provider 读取（已在 node_modules 核对）。
 * 真正的超时在 auto-updater.ts 的 UPDATE_CHECK_DEADLINE_MS / 总预算上执行。
 */
export const UPDATE_PROBE_TIMEOUT_MS = 4_000

const GITHUB_UPDATE_SOURCE: UpdateSource = {
  id: 'github',
  label: 'GitHub Releases',
  configuration: {
    provider: 'github',
    owner: 'Yuan-lai-ru-ci',
    repo: 'ProferAI',
    releaseType: 'release',
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
 *
 * 两个发行版走**不同目录**，并各自有独立的回退策略：
 * - 开源版：国内开源目录 → 备用开源目录 → GitHub Releases。
 * - 商业版：国内商业目录 → 备用商业目录，**不回退 GitHub**。
 *   公共 Release 上是开源产物，商业版装上去会变成没有账号与官方渠道的版本，
 *   这是跨版本降级，比“更新不了”严重得多。
 *
 * generic provider 会由 electron-updater 根据运行平台自动请求：
 * Windows 为 latest.yml，macOS 为 latest-mac.yml。因此两个平台共用同一个 HTTPS
 * 目录，发布时必须同时提供各自平台的元数据和安装包。
 *
 * 这里返回的只是「声明顺序」。实际尝试顺序由 `orderSourcesByReachability` 按并发探活
 * 结果重排——否则一个指向黑洞 IP 的源会让每次检查都先白等满一次元数据超时。
 */
export function getUpdateSources(
  overrideUrl = process.env.PROFER_UPDATE_FEED_URL,
  platform: NodeJS.Platform = process.platform,
  edition: UpdateEdition = isCommercialBuild() ? 'commercial' : 'oss',
): UpdateSource[] {
  const sources: UpdateSource[] = []
  const metadataFile = updateMetadataFileName(platform)
  const commercial = edition === 'commercial'
  const primaryUrl = commercial ? COMMERCIAL_UPDATE_FEED_URL : OSS_UPDATE_FEED_URL
  const fallbackUrl = commercial ? COMMERCIAL_FALLBACK_UPDATE_FEED_URL : OSS_FALLBACK_UPDATE_FEED_URL
  const normalizedDomesticUrl = normalizeFeedUrl(primaryUrl)
  const normalizedFallbackUrl = normalizeFeedUrl(fallbackUrl)

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

  // 标签对用户可见（更新失败时会拼进错误文案），保持中性描述；发行版差异只体现在 URL 上。
  sources.push(genericSource('domestic', '国内更新服务器', primaryUrl))
  sources.push(genericSource('domestic-fallback', '备用国内更新源', fallbackUrl))
  // 商业版到此为止：绝不能拿公共 Release 的开源产物覆盖商业安装。
  if (!commercial) sources.push(GITHUB_UPDATE_SOURCE)
  return sources
}
