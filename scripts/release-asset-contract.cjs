const WINDOWS_RELEASE_ASSET_NAMES = Object.freeze([
  'latest.yml',
])

function requiredWindowsReleaseAssetNames(version) {
  return [
    ...WINDOWS_RELEASE_ASSET_NAMES,
    `Profer-Setup-${version}.exe`,
    `Profer-Setup-${version}.exe.blockmap`,
  ]
}

/**
 * macOS 只负责给已经完成的 Windows Release 补充资产，不能抢先创建或发布版本。
 */
function assertWindowsReleaseReady(release, version) {
  const tag = `v${version}`
  if (!release) {
    throw new Error(`未找到 ${tag}；请先完成 Windows 发布，再补充 macOS 资产。`)
  }
  if (release.isDraft !== false) {
    throw new Error(`${tag} 尚未确认已发布；请先完成 Windows 发布，再补充 macOS 资产。`)
  }

  const assetsByName = new Map(Array.isArray(release.assets)
    ? release.assets.filter((asset) => asset?.name).map((asset) => [asset.name, asset])
    : [])
  const missing = requiredWindowsReleaseAssetNames(version).filter((name) => {
    const asset = assetsByName.get(name)
    return !asset || asset.state !== 'uploaded' || !Number.isFinite(asset.size) || asset.size <= 0
  })
  if (missing.length > 0) {
    throw new Error(`${tag} 缺少完整的 Windows 发布资产：${missing.join('、')}`)
  }
  return release
}

module.exports = {
  assertWindowsReleaseReady,
  requiredWindowsReleaseAssetNames,
}
