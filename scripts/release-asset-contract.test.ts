import { describe, expect, test } from 'bun:test'
import contract from './release-asset-contract.cjs'

const { assertWindowsReleaseReady, requiredWindowsReleaseAssetNames } = contract

describe('macOS 补充发布资产前置条件', () => {
  const expectedNames = [
    'latest.yml',
    'Profer-Setup-0.15.68.exe',
    'Profer-Setup-0.15.68.exe.blockmap',
  ]

  test('要求已发布版本包含完整 Windows 资产', () => {
    expect(requiredWindowsReleaseAssetNames('0.15.68')).toEqual(expectedNames)
    const assets = expectedNames.map((name) => ({ name, size: 1, state: 'uploaded' }))

    expect(assertWindowsReleaseReady({ isDraft: false, assets }, '0.15.68')).toEqual({
      isDraft: false,
      assets,
    })
  })

  test('拒绝在 Windows Release 不存在或仍为草稿时抢先发布', () => {
    expect(() => assertWindowsReleaseReady(null, '0.15.68')).toThrow('请先完成 Windows 发布')
    expect(() => assertWindowsReleaseReady({ isDraft: true, assets: [] }, '0.15.68')).toThrow('尚未确认已发布')
    expect(() => assertWindowsReleaseReady({ assets: [] }, '0.15.68')).toThrow('尚未确认已发布')
  })

  test('拒绝缺少任一 Windows 发布资产的版本', () => {
    for (const missingName of expectedNames) {
      const assets = expectedNames
        .filter((name) => name !== missingName)
        .map((name) => ({ name, size: 1, state: 'uploaded' }))
      expect(() => assertWindowsReleaseReady({ isDraft: false, assets }, '0.15.68'))
        .toThrow(missingName)
    }
  })

  test('拒绝空文件或尚未完成上传的 Windows 资产', () => {
    const assets = expectedNames.map((name) => ({ name, size: 1, state: 'uploaded' }))
    expect(() => assertWindowsReleaseReady({
      isDraft: false,
      assets: assets.map((asset) => asset.name === 'latest.yml' ? { ...asset, size: 0 } : asset),
    }, '0.15.68')).toThrow('latest.yml')
    expect(() => assertWindowsReleaseReady({
      isDraft: false,
      assets: assets.map((asset) => asset.name.endsWith('.exe') ? { ...asset, state: 'new' } : asset),
    }, '0.15.68')).toThrow('Profer-Setup-0.15.68.exe')
  })
})
