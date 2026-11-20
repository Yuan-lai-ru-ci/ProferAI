#!/usr/bin/env node
/** 与 electron-builder 的 prerelease channel 命名保持一致，禁止误验旧 latest 元数据。 */
function releaseMetadataName(version, platform) {
  const match = /^\d+\.\d+\.\d+-([0-9A-Za-z-]+)(?:\.|\+|$)/.exec(version)
  const channel = match ? match[1] : 'latest'
  const suffix = platform === 'darwin' ? '-mac' : platform === 'linux' ? '-linux' : ''
  return `${channel}${suffix}.yml`
}
module.exports = { releaseMetadataName }
