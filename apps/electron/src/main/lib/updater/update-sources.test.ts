import { describe, expect, test } from 'bun:test'
import {
  COMMERCIAL_FALLBACK_UPDATE_FEED_URL,
  COMMERCIAL_UPDATE_FEED_URL,
  OSS_FALLBACK_UPDATE_FEED_URL,
  OSS_UPDATE_FEED_URL,
  getUpdateSources,
  isSecureUpdateFeedUrl,
  updateMetadataFileName,
} from './update-sources'

describe('更新源优先级', () => {
  test('开源版默认主源为开源目录，备用目录第二，最后回退到 GitHub', () => {
    expect(getUpdateSources(undefined).map((source) => source.id))
      .toEqual(['domestic', 'domestic-fallback', 'github'])
    expect(getUpdateSources(undefined)[0]?.configuration).toEqual({
      provider: 'generic',
      url: OSS_UPDATE_FEED_URL,
    })
    // 2026-10-08：香港机失联，备用域名不能再当主源
    expect(OSS_UPDATE_FEED_URL).toBe('https://profer.cn/profer-updates/oss/')
    expect(getUpdateSources(undefined)[1]?.configuration)
      .toMatchObject({ provider: 'generic', url: OSS_FALLBACK_UPDATE_FEED_URL })
  })

  test('商业版只走商业目录，绝不回退 GitHub', () => {
    // 公共 Release 上是开源产物：商业版装上去会丢掉账号与官方渠道，
    // 属于事实上的版本降级，比“更新不了”严重得多。
    expect(getUpdateSources(undefined, process.platform, 'commercial').map((source) => source.id))
      .toEqual(['domestic', 'domestic-fallback'])
    const [primary, fallback] = getUpdateSources(undefined, process.platform, 'commercial')
    expect(primary?.configuration).toMatchObject({ provider: 'generic', url: COMMERCIAL_UPDATE_FEED_URL })
    expect(fallback?.configuration).toMatchObject({ provider: 'generic', url: COMMERCIAL_FALLBACK_UPDATE_FEED_URL })
    // 商业版继承存量平铺目录，已安装用户不会因为改目录而收不到更新
    expect(COMMERCIAL_UPDATE_FEED_URL).toBe('https://profer.cn/profer-updates/')
  })

  test('两个发行版的更新目录必须不同', () => {
    expect(OSS_UPDATE_FEED_URL).not.toBe(COMMERCIAL_UPDATE_FEED_URL)
    expect(OSS_FALLBACK_UPDATE_FEED_URL).not.toBe(COMMERCIAL_FALLBACK_UPDATE_FEED_URL)
    // 元数据文件名两边同名，只能用目录隔离，所以开源目录必须是商业目录的子路径且带独立段
    expect(OSS_UPDATE_FEED_URL.startsWith(COMMERCIAL_UPDATE_FEED_URL)).toBe(true)
    expect(OSS_UPDATE_FEED_URL).toBe(`${COMMERCIAL_UPDATE_FEED_URL}oss/`)
  })

  test('环境变量源只作为额外优先源，仍保留对应发行版的国内与回退', () => {
    expect(getUpdateSources('https://updates.example.com/profer/').map((source) => source.id))
      .toEqual(['override', 'domestic', 'domestic-fallback', 'github'])
    expect(getUpdateSources('https://updates.example.com/profer/')[0]?.configuration)
      .toMatchObject({ provider: 'generic', url: 'https://updates.example.com/profer' })
    expect(getUpdateSources('https://updates.example.com/profer/', process.platform, 'commercial').map((source) => source.id))
      .toEqual(['override', 'domestic', 'domestic-fallback'])
  })

  test('拒绝明文 HTTP、裸 IP、凭据和无效 URL 覆盖', () => {
    for (const value of [
      'http://updates.example.com/profer/',
      'https://203.0.113.10/profer/',
      'https://[::1]/profer/',
      'https://user:pass@updates.example.com/profer/',
      'not-a-url',
    ]) {
      expect(isSecureUpdateFeedUrl(value)).toBe(false)
      expect(getUpdateSources(value).map((source) => source.id))
        .toEqual(['domestic', 'domestic-fallback', 'github'])
    }
    expect(isSecureUpdateFeedUrl(OSS_UPDATE_FEED_URL)).toBe(true)
    expect(isSecureUpdateFeedUrl(OSS_FALLBACK_UPDATE_FEED_URL)).toBe(true)
    expect(isSecureUpdateFeedUrl(COMMERCIAL_UPDATE_FEED_URL)).toBe(true)
    expect(isSecureUpdateFeedUrl(COMMERCIAL_FALLBACK_UPDATE_FEED_URL)).toBe(true)
    expect(isSecureUpdateFeedUrl('https://updates.example.com/profer?channel=stable')).toBe(true)
  })

  test('探活地址按平台指向 electron-updater 实际请求的元数据文件', () => {
    expect(updateMetadataFileName('darwin')).toBe('latest-mac.yml')
    expect(updateMetadataFileName('win32')).toBe('latest.yml')
    expect(updateMetadataFileName('linux')).toBe('latest-linux.yml')

    const win = getUpdateSources(undefined, 'win32')
    const mac = getUpdateSources(undefined, 'darwin')
    expect(win[0]?.probeUrl).toBe('https://profer.cn/profer-updates/oss/latest.yml')
    expect(win[1]?.probeUrl).toBe('https://updates.profer.cn/oss/latest.yml')
    expect(mac[0]?.probeUrl).toBe('https://profer.cn/profer-updates/oss/latest-mac.yml')
    // GitHub 源没有静态元数据地址，不参与探活
    expect(win[2]?.id).toBe('github')
    expect(win[2]?.probeUrl).toBeNull()

    // 商业版探活落在商业目录，与开源目录不重叠
    const commercialWin = getUpdateSources(undefined, 'win32', 'commercial')
    expect(commercialWin[0]?.probeUrl).toBe('https://profer.cn/profer-updates/latest.yml')
    expect(commercialWin[1]?.probeUrl).toBe('https://updates.profer.cn/latest.yml')
  })

  test('feed URL 必须保留尾斜杠：electron-updater 靠它拼接元数据地址', () => {
    const sources = getUpdateSources(undefined, 'win32')
    const domesticUrl = (sources[0]?.configuration as { url: string }).url
    const fallbackUrl = (sources[1]?.configuration as { url: string }).url

    expect(OSS_UPDATE_FEED_URL.endsWith('/')).toBe(true)
    expect(OSS_FALLBACK_UPDATE_FEED_URL.endsWith('/')).toBe(true)
    expect(COMMERCIAL_UPDATE_FEED_URL.endsWith('/')).toBe(true)
    expect(COMMERCIAL_FALLBACK_UPDATE_FEED_URL.endsWith('/')).toBe(true)
    // 不能把尾斜杠规范化掉：generic provider 用 new URL(文件名, feedUrl) 拼接，
    // 缺尾斜杠会把最后一段当成文件替换掉（…/profer-updates + latest.yml → …/latest.yml）。
    expect(domesticUrl).toBe(OSS_UPDATE_FEED_URL)
    expect(fallbackUrl).toBe(OSS_FALLBACK_UPDATE_FEED_URL)

    // 探活地址反倒要归一化，不能出现双斜杠
    expect(sources[0]?.probeUrl).toBe('https://profer.cn/profer-updates/oss/latest.yml')
    expect(sources[1]?.probeUrl).toBe('https://updates.profer.cn/oss/latest.yml')
    expect(sources.map((source) => source.probeUrl ?? '').join()).not.toContain('//latest')
  })
})
