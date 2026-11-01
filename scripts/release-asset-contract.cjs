const WINDOWS_RELEASE_ASSET_NAMES = Object.freeze([
  'latest.yml',
])

const MAC_RELEASE_ASSET_NAMES = Object.freeze([
  'latest-mac.yml',
])

function requiredWindowsReleaseAssetNames(version) {
  return [
    ...WINDOWS_RELEASE_ASSET_NAMES,
    `Profer-Setup-${version}.exe`,
    `Profer-Setup-${version}.exe.blockmap`,
  ]
}

function requiredMacReleaseAssetNames(version) {
  return [
    ...MAC_RELEASE_ASSET_NAMES,
    `Profer-${version}-arm64-mac.zip`,
    `Profer-${version}-arm64-mac.zip.blockmap`,
    `Profer-${version}-arm64.dmg`,
  ]
}

function uploadedAssets(release) {
  return new Map(Array.isArray(release?.assets)
    ? release.assets.filter((asset) => asset?.name).map((asset) => [asset.name, asset])
    : [])
}

function hasUploadedAssets(release, names) {
  const assetsByName = uploadedAssets(release)
  return names.every((name) => {
    const asset = assetsByName.get(name)
    return Boolean(asset) && asset.state === 'uploaded' && Number.isFinite(asset.size) && asset.size > 0
  })
}

/**
 * GitHub Release 是否已包含完整的 Windows 资产。
 * Windows 发布脚本据此判断当前是「首次发布」还是「给 macOS 先创建的 Release 补资产」。
 */
function hasWindowsReleaseAssets(release, version) {
  return hasUploadedAssets(release, requiredWindowsReleaseAssetNames(version))
}

/** GitHub Release 是否已包含完整的 macOS 资产（用于发布后的漏发提示与校验）。 */
function hasMacReleaseAssets(release, version) {
  return hasUploadedAssets(release, requiredMacReleaseAssetNames(version))
}

/**
 * 发布完成后两个平台共用的终态断言：Release 必须存在且已正式发布。
 * 发布顺序不再固定，先跑的平台负责创建并发布，后跑的平台只补充自己的资产。
 */
function assertReleasePublished(release, version) {
  const tag = `v${version}`
  if (!release) {
    throw new Error(`未找到 ${tag} 的 GitHub Release。`)
  }
  if (release.isDraft !== false) {
    throw new Error(`${tag} 仍是草稿，尚未正式发布。`)
  }
  return release
}

module.exports = {
  assertReleasePublished,
  hasMacReleaseAssets,
  hasWindowsReleaseAssets,
  requiredMacReleaseAssetNames,
  requiredWindowsReleaseAssetNames,
}
