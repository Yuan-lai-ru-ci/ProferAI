import { describe, expect, test } from 'bun:test'
import contract from './release-asset-contract.cjs'

const {
  assertReleasePublished,
  hasMacReleaseAssets,
  hasWindowsReleaseAssets,
  requiredMacReleaseAssetNames,
  requiredWindowsReleaseAssetNames,
} = contract

const VERSION = '0.15.68'
const WINDOWS_ASSETS = [
  'latest.yml',
  'Profer-Setup-0.15.68.exe',
  'Profer-Setup-0.15.68.exe.blockmap',
]
const MAC_ASSETS = [
  'latest-mac.yml',
  'Profer-0.15.68-arm64-mac.zip',
  'Profer-0.15.68-arm64-mac.zip.blockmap',
  'Profer-0.15.68-arm64.dmg',
]

function uploaded(names: string[]) {
  return names.map((name) => ({ name, size: 1, state: 'uploaded' }))
}

describe('发布资产契约', () => {
  test('两个平台的必需资产名固定', () => {
    expect(requiredWindowsReleaseAssetNames(VERSION)).toEqual(WINDOWS_ASSETS)
    expect(requiredMacReleaseAssetNames(VERSION)).toEqual(MAC_ASSETS)
  })

  test('完整上传的 Windows 资产才算就绪', () => {
    expect(hasWindowsReleaseAssets({ isDraft: false, assets: uploaded(WINDOWS_ASSETS) }, VERSION)).toBe(true)
    expect(hasWindowsReleaseAssets(null, VERSION)).toBe(false)
    expect(hasWindowsReleaseAssets({ isDraft: false, assets: [] }, VERSION)).toBe(false)

    for (const missingName of WINDOWS_ASSETS) {
      const assets = uploaded(WINDOWS_ASSETS.filter((name) => name !== missingName))
      expect(hasWindowsReleaseAssets({ isDraft: false, assets }, VERSION)).toBe(false)
    }
  })

  test('完整上传的 macOS 资产才算就绪', () => {
    expect(hasMacReleaseAssets({ isDraft: false, assets: uploaded(MAC_ASSETS) }, VERSION)).toBe(true)
    expect(hasMacReleaseAssets(null, VERSION)).toBe(false)

    for (const missingName of MAC_ASSETS) {
      const assets = uploaded(MAC_ASSETS.filter((name) => name !== missingName))
      expect(hasMacReleaseAssets({ isDraft: false, assets }, VERSION)).toBe(false)
    }
  })

  test('空文件或尚未完成上传的资产不算就绪', () => {
    const windows = uploaded(WINDOWS_ASSETS)
    expect(hasWindowsReleaseAssets({
      isDraft: false,
      assets: windows.map((asset) => asset.name === 'latest.yml' ? { ...asset, size: 0 } : asset),
    }, VERSION)).toBe(false)
    expect(hasWindowsReleaseAssets({
      isDraft: false,
      assets: windows.map((asset) => asset.name.endsWith('.exe') ? { ...asset, state: 'new' } : asset),
    }, VERSION)).toBe(false)

    const mac = uploaded(MAC_ASSETS)
    expect(hasMacReleaseAssets({
      isDraft: false,
      assets: mac.map((asset) => asset.name.endsWith('.dmg') ? { ...asset, size: 0 } : asset),
    }, VERSION)).toBe(false)
    expect(hasMacReleaseAssets({
      isDraft: false,
      assets: mac.map((asset) => asset.name.endsWith('.zip') ? { ...asset, state: 'new' } : asset),
    }, VERSION)).toBe(false)
  })

  test('发布终态要求 Release 存在且非草稿', () => {
    expect(() => assertReleasePublished(null, VERSION)).toThrow('未找到')
    expect(() => assertReleasePublished({ isDraft: true, assets: [] }, VERSION)).toThrow('仍是草稿')
    expect(() => assertReleasePublished({ assets: [] }, VERSION)).toThrow('仍是草稿')

    const release = { isDraft: false, assets: uploaded(MAC_ASSETS) }
    expect(assertReleasePublished(release, VERSION)).toEqual(release)
  })
})
