#!/usr/bin/env node
/**
 * 验证 macOS electron-updater 发布资产。
 *
 * macOS 更新使用 latest-mac.yml + ZIP；DMG 仅用于首次安装，不参与
 * Squirrel.Mac 的后台更新。此脚本只读检查 out/，不访问网络、不写入文件。
 */
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const appRoot = path.resolve(__dirname, '..')
const out = path.join(appRoot, 'out')
const version = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8')).version
const metadataPath = path.join(out, 'latest-mac.yml')

function assertFile(filePath, description) {
  if (!fs.existsSync(filePath)) throw new Error(`缺少 macOS 更新资产: ${description} (${filePath})`)
  if (fs.statSync(filePath).size <= 0) throw new Error(`macOS 更新资产为空: ${filePath}`)
}

assertFile(metadataPath, 'latest-mac.yml')

const metadata = fs.readFileSync(metadataPath, 'utf8')
if (!/^path:\s*\S+\.zip\s*$/m.test(metadata)) {
  throw new Error('latest-mac.yml 缺少 ZIP path 元数据')
}
const versionMatch = metadata.match(/^version:\s*([^\r\n]+)$/m)
if (!versionMatch || versionMatch[1].trim().replace(/^['"]|['"]$/g, '') !== version) {
  throw new Error(`latest-mac.yml 版本与 package.json 不一致: ${versionMatch?.[1] ?? '缺失'} != ${version}`)
}

const fileMatches = [...metadata.matchAll(/^\s+- url:\s*(\S+)\s*$\n\s+sha512:\s*(\S+)\s*$\n\s+size:\s*(\d+)\s*$/gm)]
const zipEntry = fileMatches.find((match) => {
  try {
    return path.basename(new URL(match[1], 'https://updates.invalid/').pathname).toLowerCase().endsWith('.zip')
  } catch {
    return false
  }
})
if (!zipEntry) throw new Error('latest-mac.yml 缺少可验证的 ZIP url/sha512/size 元数据')

const zipName = path.basename(new URL(zipEntry[1], 'https://updates.invalid/').pathname)
const zipPath = path.join(out, zipName)
assertFile(zipPath, zipName)

const expectedSize = Number(zipEntry[3])
const actualSize = fs.statSync(zipPath).size
if (expectedSize !== actualSize) {
  throw new Error(`latest-mac.yml size 与 ZIP 不一致: metadata=${expectedSize}, actual=${actualSize}`)
}

const expectedSha512 = zipEntry[2]
if (!/^[A-Za-z0-9+/]+={0,2}$/.test(expectedSha512)) {
  throw new Error('latest-mac.yml sha512 不是合法的 base64')
}
const actualSha512 = crypto.createHash('sha512').update(fs.readFileSync(zipPath)).digest('base64')
if (expectedSha512 !== actualSha512) throw new Error('latest-mac.yml sha512 与 ZIP 内容不一致')

console.log(JSON.stringify({
  ok: true,
  version,
  metadata: path.basename(metadataPath),
  zip: zipName,
  size: actualSize,
}, null, 2))
