#!/usr/bin/env node
/** 验证 Windows 解包产物含有并可运行锁定版本的 Bun。 */
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const crypto = require('node:crypto')

const appRoot = path.resolve(__dirname, '..')
const bunConfig = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8')).proma?.bun
const expectedVersion = bunConfig?.version
const expectedBinarySha256 = bunConfig?.binarySha256
if (!expectedVersion || !expectedBinarySha256) throw new Error('package.json 缺少 proma.bun.version / binarySha256')

const outputDir = process.env.PROFER_ELECTRON_OUTPUT_DIR
  ? path.resolve(appRoot, process.env.PROFER_ELECTRON_OUTPUT_DIR)
  : path.join(appRoot, 'out')
const bunPath = path.join(outputDir, 'win-unpacked', 'resources', 'vendor', 'bun', 'bun.exe')
if (!fs.existsSync(bunPath)) throw new Error(`安装包缺少 Bun runtime: ${bunPath}`)

let version
try {
  version = execFileSync(bunPath, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 }).trim()
} catch (error) {
  throw new Error(`安装包内 Bun 无法执行: ${bunPath}\n${error instanceof Error ? error.message : String(error)}`)
}
if (version !== expectedVersion) {
  throw new Error(`安装包内 Bun 版本不匹配: expected ${expectedVersion}, received ${version}`)
}
const actualBinarySha256 = crypto.createHash('sha256').update(fs.readFileSync(bunPath)).digest('hex')
if (actualBinarySha256.toLowerCase() !== expectedBinarySha256.toLowerCase()) {
  throw new Error(`安装包内 Bun SHA-256 不匹配: expected ${expectedBinarySha256}, received ${actualBinarySha256}`)
}
console.log(`[verify:packaged-bun] Bun ${version} OK: ${bunPath}`)
