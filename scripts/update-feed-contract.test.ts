import { describe, expect, test } from 'bun:test'
import contract from './update-feed-contract.cjs'

const { parseUpdateMetadata, previousBlockmapUrl, assertPreviousBlockmapPublished } = contract

const MAC_METADATA = `version: 0.16.15
files:
  - url: Profer-0.16.15-arm64-mac.zip
    sha512: abc
    size: 256297940
  - url: Profer-0.16.15-arm64.dmg
    sha512: def
    size: 264818283
path: Profer-0.16.15-arm64-mac.zip
sha512: abc
releaseDate: '2026-10-28T17:10:00.000Z'
`

const WINDOWS_METADATA = `version: 0.16.15
files:
  - url: Profer-Setup-0.16.15.exe
    sha512: abc
    size: 223900000
path: Profer-Setup-0.16.15.exe
sha512: abc
releaseDate: '2026-10-28T09:46:21.579Z'
`

describe('更新源 metadata 解析', () => {
  test('取出 macOS 与 Windows 的版本号与安装包文件名', () => {
    expect(parseUpdateMetadata(MAC_METADATA)).toEqual({
      version: '0.16.15',
      fileName: 'Profer-0.16.15-arm64-mac.zip',
    })
    expect(parseUpdateMetadata(WINDOWS_METADATA)).toEqual({
      version: '0.16.15',
      fileName: 'Profer-Setup-0.16.15.exe',
    })
  })

  test('解析不了时返回 null，交给调用方降级而不是瞎猜', () => {
    expect(parseUpdateMetadata('')).toEqual({ version: null, fileName: null })
    expect(parseUpdateMetadata('garbage')).toEqual({ version: null, fileName: null })
  })
})

describe('旧 blockmap 地址', () => {
  test('容忍 feedUrl 带或不带尾斜杠，不产生双斜杠', () => {
    expect(previousBlockmapUrl('https://profer.cn/profer-updates/', 'a.zip'))
      .toBe('https://profer.cn/profer-updates/a.zip.blockmap')
    expect(previousBlockmapUrl('https://profer.cn/profer-updates', 'a.zip'))
      .toBe('https://profer.cn/profer-updates/a.zip.blockmap')
  })
})

describe('发布期差分门禁', () => {
  const base = {
    feedUrl: 'https://profer.cn/profer-updates/',
    version: '0.16.16',
  }

  test('上一版本 blockmap 可访问时通过', () => {
    const result = assertPreviousBlockmapPublished({
      ...base,
      metadataText: MAC_METADATA,
      fetchStatus: () => 200,
    })
    expect(result.checked).toBe(true)
    expect(result.ok).toBe(true)
    expect(result.url).toBe('https://profer.cn/profer-updates/Profer-0.16.15-arm64-mac.zip.blockmap')
  })

  test('上一版本 blockmap 404 时发布直接失败，并说明会退化成全量下载', () => {
    expect(() => assertPreviousBlockmapPublished({
      ...base,
      metadataText: WINDOWS_METADATA,
      fetchStatus: () => 404,
    })).toThrow(/Profer-Setup-0\.16\.15\.exe\.blockmap/)
  })

  test('明确放弃差分时只警告不阻断发布', () => {
    const result = assertPreviousBlockmapPublished({
      ...base,
      metadataText: WINDOWS_METADATA,
      fetchStatus: () => 404,
      allowMissing: true,
    })
    expect(result.checked).toBe(true)
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('http-404')
  })

  test('更新源上已经是本次版本时跳过校验（重复发布/补传资产）', () => {
    const result = assertPreviousBlockmapPublished({
      ...base,
      version: '0.16.15',
      metadataText: MAC_METADATA,
      fetchStatus: () => {
        throw new Error('不应该发请求')
      },
    })
    expect(result.checked).toBe(false)
    expect(result.reason).toBe('same-version')
  })
})

describe('老版本 blockmap 清理告警', () => {
  const releasesJson = JSON.stringify([
    { tag_name: 'v0.16.16' },
    { tag_name: 'v0.16.13' },
    { tag_name: 'v0.16.12' },
    { tag_name: 'v0.16.11' },
    { tag_name: 'v0.16.10' },
    { tag_name: 'v0.15.83' },
    { tag_name: 'draft-without-version' },
  ])

  test('取最近版本时去掉当前版本、去掉 v 前缀、忽略非法 tag', () => {
    expect(contract.listRecentVersions(releasesJson, '0.16.16', 3)).toEqual(['0.16.13', '0.16.12', '0.16.11'])
  })

  test('releases.json 不可解析时返回空列表，不抛错', () => {
    expect(contract.listRecentVersions('not json', '0.16.16')).toEqual([])
  })

  test('安装包在但 blockmap 被清理时报告；安装包本身不存在的版本不误报', () => {
    const present = new Set([
      'Profer-Setup-0.16.13.exe',
      'Profer-Setup-0.16.13.exe.blockmap',
      'Profer-Setup-0.16.12.exe',
      // 0.16.12 的 blockmap 缺失 → 应报告
      // 0.16.11 只有 macOS 资产（模拟）→ 安装包不存在，跳过
    ])
    const result = contract.findPurgedBlockmaps({
      feedUrl: 'https://profer.cn/profer-updates/',
      releasesJsonText: releasesJson,
      currentVersion: '0.16.16',
      installerName: (version: string) => `Profer-Setup-${version}.exe`,
      limit: 3,
      fetchStatus: (url: string) => (present.has(url.split('/').pop() ?? '') ? 200 : 404),
    })
    expect(result.checked).toEqual(['0.16.13', '0.16.12'])
    expect(result.missing).toEqual([
      { version: '0.16.12', blockmap: 'Profer-Setup-0.16.12.exe.blockmap', status: 404 },
    ])
  })
})
