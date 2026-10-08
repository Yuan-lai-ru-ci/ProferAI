import { describe, expect, test } from 'bun:test'
import {
  DOMESTIC_FALLBACK_UPDATE_FEED_URL,
  DOMESTIC_UPDATE_FEED_URL,
  getUpdateSources,
  isSecureUpdateFeedUrl,
  UPDATE_REQUEST_TIMEOUT_MS,
  updateMetadataFileName,
} from './update-sources'

describe('更新源优先级', () => {
  test('默认主源为旧机静态目录，备用国内源第二，最后回退到 GitHub', () => {
    expect(getUpdateSources(undefined).map((source) => source.id))
      .toEqual(['domestic', 'domestic-fallback', 'github'])
    expect(getUpdateSources(undefined)[0]?.configuration).toEqual({
      provider: 'generic',
      url: DOMESTIC_UPDATE_FEED_URL,
      timeout: UPDATE_REQUEST_TIMEOUT_MS,
    })
    // 2026-10-08：香港机 45.114.127.232 失联，主源不能再是 updates.profer.cn
    expect(DOMESTIC_UPDATE_FEED_URL).toBe('https://profer.cn/profer-updates/')
    expect(getUpdateSources(undefined)[1]?.configuration)
      .toMatchObject({ provider: 'generic', url: DOMESTIC_FALLBACK_UPDATE_FEED_URL })
  })

  test('环境变量源只作为额外优先源，仍保留国内与 GitHub 回退', () => {
    expect(getUpdateSources('https://updates.example.com/profer/').map((source) => source.id))
      .toEqual(['override', 'domestic', 'domestic-fallback', 'github'])
    expect(getUpdateSources('https://updates.example.com/profer/')[0]?.configuration)
      .toMatchObject({ provider: 'generic', url: 'https://updates.example.com/profer' })
  })

  test('拒绝明文 HTTP、裸 IP、凭据和无效 URL 覆盖', () => {
    for (const value of [
      'http://updates.example.com/profer/',
      'https://47.109.108.57/profer/',
      'https://[::1]/profer/',
      'https://user:pass@updates.example.com/profer/',
      'not-a-url',
    ]) {
      expect(isSecureUpdateFeedUrl(value)).toBe(false)
      expect(getUpdateSources(value).map((source) => source.id))
        .toEqual(['domestic', 'domestic-fallback', 'github'])
    }
    expect(isSecureUpdateFeedUrl(DOMESTIC_UPDATE_FEED_URL)).toBe(true)
    expect(isSecureUpdateFeedUrl(DOMESTIC_FALLBACK_UPDATE_FEED_URL)).toBe(true)
    expect(isSecureUpdateFeedUrl('https://updates.example.com/profer?channel=stable')).toBe(true)
  })

  test('探活地址按平台指向 electron-updater 实际请求的元数据文件', () => {
    expect(updateMetadataFileName('darwin')).toBe('latest-mac.yml')
    expect(updateMetadataFileName('win32')).toBe('latest.yml')
    expect(updateMetadataFileName('linux')).toBe('latest-linux.yml')

    const win = getUpdateSources(undefined, 'win32')
    const mac = getUpdateSources(undefined, 'darwin')
    expect(win[0]?.probeUrl).toBe('https://profer.cn/profer-updates/latest.yml')
    expect(win[1]?.probeUrl).toBe('https://updates.profer.cn/latest.yml')
    expect(mac[0]?.probeUrl).toBe('https://profer.cn/profer-updates/latest-mac.yml')
    // GitHub 源没有静态元数据地址，不参与探活
    expect(win[2]?.id).toBe('github')
    expect(win[2]?.probeUrl).toBeNull()
  })

  test('feed URL 必须保留尾斜杠：electron-updater 靠它拼接元数据地址', () => {
    const sources = getUpdateSources(undefined, 'win32')
    const domesticUrl = (sources[0]?.configuration as { url: string }).url
    const fallbackUrl = (sources[1]?.configuration as { url: string }).url

    expect(DOMESTIC_UPDATE_FEED_URL.endsWith('/')).toBe(true)
    expect(DOMESTIC_FALLBACK_UPDATE_FEED_URL.endsWith('/')).toBe(true)
    // 不能把尾斜杠规范化掉：generic provider 用 new URL(文件名, feedUrl) 拼接，
    // 缺尾斜杠会把最后一段当成文件替换掉（…/profer-updates + latest.yml → …/latest.yml）。
    expect(domesticUrl).toBe(DOMESTIC_UPDATE_FEED_URL)
    expect(fallbackUrl).toBe(DOMESTIC_FALLBACK_UPDATE_FEED_URL)

    // 探活地址反倒要归一化，不能出现双斜杠
    expect(sources[0]?.probeUrl).toBe('https://profer.cn/profer-updates/latest.yml')
    expect(sources[1]?.probeUrl).toBe('https://updates.profer.cn/latest.yml')
    expect(sources.map((source) => source.probeUrl ?? '').join()).not.toContain('//latest')
  })
})
