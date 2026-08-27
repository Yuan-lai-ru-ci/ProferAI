#!/usr/bin/env node
/** 验证解包产物含有并可运行锁定版本的当前平台 Bun。 */
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const crypto = require('node:crypto')
const { getPlatformTarget } = require('./prepare-bundled-bun.cjs')

const appRoot = path.resolve(__dirname, '..')
const bunConfig = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8')).proma?.bun
const expectedVersion = bunConfig?.version
if (!expectedVersion) throw new Error('package.json 缺少 proma.bun.version')
const target = getPlatformTarget()

const outputDir = process.env.PROFER_ELECTRON_OUTPUT_DIR
  ? path.resolve(appRoot, process.env.PROFER_ELECTRON_OUTPUT_DIR)
  : path.join(appRoot, 'out')
function findMacResourcesRoot() {
  const direct = path.join(outputDir, 'Profer.app', 'Contents', 'Resources')
  if (fs.existsSync(direct)) return direct
  if (!fs.existsSync(outputDir)) return null
  const candidates = fs.readdirSync(outputDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(outputDir, entry.name, 'Profer.app', 'Contents', 'Resources'))
    .filter((candidate) => fs.existsSync(candidate))
  return candidates[0] ?? null
}

const resourcesRoot = process.platform === 'darwin'
  ? findMacResourcesRoot()
  : fs.existsSync(path.join(outputDir, 'win-unpacked', 'resources'))
    ? path.join(outputDir, 'win-unpacked', 'resources')
    : null
const bunPath = resourcesRoot ? path.join(resourcesRoot, 'vendor', 'bun', target.binary) : path.join(outputDir, target.binary)
if (!resourcesRoot || !fs.existsSync(bunPath)) throw new Error(`安装包缺少 ${target.platformArch} Bun runtime: ${bunPath}`)

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
if (actualBinarySha256.toLowerCase() !== target.binarySha256) {
  throw new Error(`安装包内 Bun SHA-256 不匹配: expected ${target.binarySha256}, received ${actualBinarySha256}`)
}
console.log(`[verify:packaged-bun] ${target.platformArch} Bun ${version} OK: ${bunPath}`)
