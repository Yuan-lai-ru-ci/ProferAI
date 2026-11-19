#!/usr/bin/env node
/**
 * 跨主机校验 Windows 发布资产（不含 win-unpacked）。
 *
 * 场景：Windows 构建机上只负责出包，发布仍由持有版本库与 gh 凭据的机器执行。
 * 构建产物（latest.yml / *.exe / *.exe.blockmap / packaged-pi-probe.out.log）
 * 回传后在发布机上跑本脚本，校验用户实际下载的那几个文件的完整性：
 * 版本、大小、SHA-512、blockmap 存在性，以及构建机上 packaged Pi runtime
 * 闭包探针的结果。
 *
 * 明确不覆盖：win-unpacked 目录不随资产搬运，其内 CLI / 运行时闭包完整性
 * 由构建机的 verify:release-assets 负责，本脚本不重复声称已验证。
 *
 * 用法: node scripts/verify-windows-artifacts-portable.cjs --dir <目录> [--unsigned]
 */
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const args = process.argv.slice(2)
const dirIndex = args.indexOf('--dir')
const dir = dirIndex === -1 ? null : path.resolve(ROOT, args[dirIndex + 1] ?? '')
if (!dir) {
  console.error('用法: node scripts/verify-windows-artifacts-portable.cjs --dir <目录> [--unsigned]')
  process.exit(1)
}
if (!fs.existsSync(dir)) throw new Error(`资产目录不存在: ${dir}`)

const unsignedRelease = args.includes('--unsigned') || process.env.PROFER_UNSIGNED_RELEASE === '1'
const metadataPath = path.join(dir, 'latest.yml')
if (!fs.existsSync(metadataPath)) throw new Error(`缺少 latest.yml: ${metadataPath}`)

const pkgPath = path.join(ROOT, 'apps/electron/package.json')
const expectedVersion = fs.existsSync(pkgPath)
  ? JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version
  : undefined

function parseLatestYml(text) {
  const versionMatch = text.match(/^version:\s*([^\r\n]+)$/m)
  const urlMatch = text.match(/^\s+- url:\s*(\S+)$/m)
  const hashMatch = text.match(/^\s+sha512:\s*(\S+)$/m)
  const sizeMatch = text.match(/^\s+size:\s*(\d+)$/m)
  if (!versionMatch || !urlMatch || !hashMatch || !sizeMatch) {
    throw new Error('latest.yml 缺少可验证的 version/url/sha512/size 元数据')
  }
  return {
    version: versionMatch[1].trim().replace(/^['"]|['"]$/g, ''),
    url: urlMatch[1],
    sha512: hashMatch[1],
    size: Number(sizeMatch[1]),
  }
}

const metadata = parseLatestYml(fs.readFileSync(metadataPath, 'utf8'))
if (expectedVersion && metadata.version !== expectedVersion) {
  throw new Error(`latest.yml 版本 ${metadata.version} 与 package.json ${expectedVersion} 不一致`)
}
if (!/^[A-Za-z0-9+/]+={0,2}$/.test(metadata.sha512)) {
  throw new Error('latest.yml sha512 不是合法的 base64')
}
if (!/^Profer(-Commercial)?-Setup-\d+\.\d+\.\d+\.exe$/.test(metadata.url)) {
  throw new Error(`latest.yml 安装包名称不符合发布约定: ${metadata.url}`)
}
const installerPath = path.join(dir, metadata.url)
if (!fs.existsSync(installerPath)) throw new Error(`缺少安装包: ${installerPath}`)
const actualSize = fs.statSync(installerPath).size
if (metadata.size !== actualSize) {
  throw new Error(`latest.yml size 不匹配: metadata=${metadata.size}, actual=${actualSize}`)
}
const actualSha512 = crypto.createHash('sha512').update(fs.readFileSync(installerPath)).digest('base64')
if (metadata.sha512 !== actualSha512) {
  throw new Error('latest.yml sha512 与安装包内容不匹配')
}
console.log('[verify:windows-artifacts] latest.yml SHA-512 元数据与安装包一致')

const blockmapPath = `${installerPath}.blockmap`
if (!fs.existsSync(blockmapPath) || fs.statSync(blockmapPath).size <= 0) {
  throw new Error(`缺少差分 blockmap（下次更新会退化成全量下载）: ${blockmapPath}`)
}
console.log('[verify:windows-artifacts] blockmap 存在且非空')

if (!unsignedRelease) {
  const signaturePath = path.join(dir, 'latest.yml.sig')
  if (!fs.existsSync(signaturePath) || fs.statSync(signaturePath).size <= 0) {
    throw new Error(`签名发布缺少 latest.yml.sig: ${signaturePath}`)
  }
  console.log('[verify:windows-artifacts] latest.yml.sig 存在（签名有效性仍须构建机 verify:release-assets 证明）')
}

// 探针日志由构建机的 verify:packaged-pi-runtime 写出；跨主机发布时它是唯一证据。
const probePath = path.join(dir, 'packaged-pi-probe.out.log')
if (!fs.existsSync(probePath)) {
  throw new Error(`缺少 packaged-pi-probe.out.log：请先在 Windows 构建机跑 bun run verify:packaged-pi-runtime 并把日志一并回传`)
}
let probe
try {
  probe = JSON.parse(fs.readFileSync(probePath, 'utf8'))
} catch (error) {
  throw new Error(`packaged-pi-probe.out.log 不是合法 JSON: ${error.message}`)
}
if (probe.ok !== true) throw new Error('构建机 packaged Pi runtime 闭包探针未通过（ok !== true）')
console.log(`[verify:windows-artifacts] 构建机 Pi 闭包探针 ok（nativeFileCount=${probe.nativeFileCount ?? '?'}）`)

console.log('[verify:windows-artifacts] 跨主机 Windows 资产校验完成（win-unpacked 未搬运，未在此校验）')
