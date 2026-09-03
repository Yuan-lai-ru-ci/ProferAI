#!/usr/bin/env node
/**
 * Profer macOS 发布（Apple Silicon + 国内更新源 + GitHub Release）。
 *
 * 必须在 macOS arm64 上运行。自动更新依赖有效的 Developer ID 签名和
 * notarization；脚本拒绝把无签名验收包上传到更新源。
 * 用法：node scripts/push-mac-release.cjs <版本号>
 */
const { execSync } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { assertWindowsReleaseReady } = require('./release-asset-contract.cjs')

const VERSION = process.argv[2]
if (!VERSION) throw new Error('用法：node scripts/push-mac-release.cjs <版本号>')
if (!/^\d+\.\d+\.\d+$/.test(VERSION)) throw new Error(`版本号格式非法：${VERSION}`)
if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  throw new Error(`macOS 发布必须在 darwin-arm64 上运行，当前为 ${process.platform}-${process.arch}`)
}
if (process.env.CSC_IDENTITY_AUTO_DISCOVERY === 'false') {
  throw new Error('检测到 CSC_IDENTITY_AUTO_DISCOVERY=false；无签名包禁止进入 macOS 更新源')
}

const ROOT = path.resolve(__dirname, '..')
const ELECTRON = path.join(ROOT, 'apps/electron')
const OUT = path.join(ELECTRON, 'out')
const TAG = `v${VERSION}`
const GH_REPO = 'Yuan-lai-ru-ci/ProferAI'
const HOST = process.env.PROFER_UPDATE_SSH_HOST || '47.109.108.57'
const USER = process.env.PROFER_UPDATE_SSH_USER || 'ecs-user'
const UPDATE_FEED_URL = 'https://profer.cn/profer-updates/'
const UPDATE_DIR = process.env.PROFER_MAC_UPDATE_DIR || '/usr/share/nginx/html/profer-updates'
const MAC_UPDATE_METADATA = 'latest-mac.yml'

function run(command, cwd = ROOT) {
  return execSync(command, { cwd, encoding: 'utf8', stdio: 'inherit' }).trim()
}
function sha256(filePath) { return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex') }
function remote(command) { run(`ssh -o StrictHostKeyChecking=yes ${USER}@${HOST} ${JSON.stringify(command)}`) }
function upload(localPath, remotePath) { run(`scp -o StrictHostKeyChecking=yes ${JSON.stringify(localPath)} ${USER}@${HOST}:${JSON.stringify(remotePath)}`) }
function assertExists(filePath) { if (!fs.existsSync(filePath)) throw new Error(`缺少发布资产: ${filePath}`) }

function findMacAssets() {
  const metadata = path.join(OUT, MAC_UPDATE_METADATA)
  const zip = path.join(OUT, `Profer-${VERSION}-arm64-mac.zip`)
  const dmg = path.join(OUT, `Profer-${VERSION}-arm64.dmg`)
  for (const filePath of [metadata, zip, dmg]) assertExists(filePath)
  return [metadata, zip, dmg]
}

function assertSignedApp() {
  const direct = path.join(OUT, 'Profer.app')
  const nested = fs.existsSync(OUT)
    ? fs.readdirSync(OUT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(OUT, entry.name, 'Profer.app'))
    : []
  const appPath = [direct, ...nested].find((candidate) => fs.existsSync(candidate))
  if (!appPath) throw new Error(`未找到 macOS 解包产物：${direct}`)
  run(`codesign --verify --deep --strict --verbose=2 ${JSON.stringify(appPath)}`)
  run(`spctl --assess --type execute --verbose=2 ${JSON.stringify(appPath)}`)
}

function readReleaseAssets() {
  try { return JSON.parse(execSync(`gh release view ${TAG} --repo ${GH_REPO} --json assets,isDraft,name`, { cwd: ROOT, encoding: 'utf8' })) } catch { return null }
}
function ensureGitHubAssets(assetPaths) {
  assertWindowsReleaseReady(readReleaseAssets(), VERSION)
  for (const filePath of assetPaths) {
    const name = path.basename(filePath)
    const current = readReleaseAssets()
    const asset = current?.assets?.find((item) => item.name === name)
    if (asset && asset.size === fs.statSync(filePath).size && asset.digest === `sha256:${sha256(filePath)}`) continue
    run(`gh release upload ${TAG} ${JSON.stringify(filePath)} --repo ${GH_REPO} --clobber`)
  }
  run(`gh release edit ${TAG} --repo ${GH_REPO} --latest --title ${JSON.stringify(`Profer ${TAG}`)}`)
}

(async () => {
  console.log(`=== Profer macOS 发布 ${TAG} ===`)
  // Mac 资产只能在 Windows Release 完成后由独立 Apple Silicon 主机补齐。
  run(`node scripts/verify-release-preflight.cjs ${VERSION} --allow-published-release`)
  assertWindowsReleaseReady(readReleaseAssets(), VERSION)
  run('bun run typecheck')
  run('bun test --isolate --timeout 30000')
  run('bun run dist:mac-release', ELECTRON)
  const [metadata, zip, dmg] = findMacAssets()
  assertSignedApp()
  run('bun run verify:mac-package', ELECTRON)
  run('node scripts/verify-macos-update-assets.cjs', ELECTRON)

  // 构建可能耗时较久；任何远程写入前再次确认 Windows Release 仍满足契约。
  assertWindowsReleaseReady(readReleaseAssets(), VERSION)
  console.log(`[1/2] 上传 macOS 更新资产到 ${UPDATE_FEED_URL}`)
  for (const filePath of [metadata, zip, dmg]) upload(filePath, `/tmp/${path.basename(filePath)}`)
  remote(`sudo mkdir -p ${UPDATE_DIR} && sudo cp /tmp/${path.basename(metadata)} ${UPDATE_DIR}/ && sudo cp /tmp/${path.basename(zip)} ${UPDATE_DIR}/ && sudo cp /tmp/${path.basename(dmg)} ${UPDATE_DIR}/ && sudo chmod -R 755 ${UPDATE_DIR}`)

  console.log('[2/2] 上传 GitHub Release macOS 资产')
  ensureGitHubAssets([metadata, zip, dmg])
  console.log(`=== macOS 发布完成 ${TAG} ===`)
})().catch((error) => {
  console.error(`macOS 发布失败：${error.message}`)
  process.exit(1)
})
