import { describe, expect, test } from 'bun:test'
import { DOMESTIC_UPDATE_FEED_URL, getUpdateSources, isSecureUpdateFeedUrl, UPDATE_REQUEST_TIMEOUT_MS } from './update-sources'

describe('更新源优先级', () => {
  test('默认先走国内服务器，再回退到 GitHub', () => {
    expect(getUpdateSources(undefined).map((source) => source.id)).toEqual(['domestic', 'github'])
    expect(getUpdateSources(undefined)[0]?.configuration).toEqual({
      provider: 'generic',
      url: DOMESTIC_UPDATE_FEED_URL,
      timeout: UPDATE_REQUEST_TIMEOUT_MS,
    })
  })

  test('环境变量源只作为额外优先源，仍保留国内与 GitHub 回退', () => {
    expect(getUpdateSources('https://updates.example.com/profer/').map((source) => source.id))
      .toEqual(['override', 'domestic', 'github'])
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
      expect(getUpdateSources(value).map((source) => source.id)).toEqual(['domestic', 'github'])
    }
    expect(isSecureUpdateFeedUrl(DOMESTIC_UPDATE_FEED_URL)).toBe(true)
    expect(isSecureUpdateFeedUrl('https://updates.example.com/profer?channel=stable')).toBe(true)
  })

  test('generic 更新源由 electron-updater 按平台请求 latest.yml 或 latest-mac.yml', () => {
    const source = getUpdateSources(undefined)[0]
    expect(source?.configuration).toMatchObject({ provider: 'generic', url: DOMESTIC_UPDATE_FEED_URL })
    // electron-updater 的平台文件名逻辑在其 Provider 内部：darwin 为 latest-mac.yml。
    expect(DOMESTIC_UPDATE_FEED_URL.endsWith('/')).toBe(true)
  })
})
