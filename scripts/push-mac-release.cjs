#!/usr/bin/env node
/**
 * Profer macOS 发布（Apple Silicon + 国内更新源 + GitHub Release）。
 *
 * 必须在 macOS arm64 上运行。自动更新的硬门槛是“包可验证 + 顶层 designated
 * requirement 钉死为 identifier "com.profer.app"”（见
 * apps/electron/scripts/macos-signature.cjs），构建时由 afterSign 钩子保证，
 * 本脚本上传前再断言一次。
 *
 * 不要求 Developer ID / notarization：ad-hoc 签名即可满足 Squirrel.Mac；
 * spctl 评估对 ad-hoc 必然 rejected，也与自更新无关，因此不再作为门禁。
 * 一旦将来接入真实签名，同一个断言会自然地要求真实签名的产物，无需改这里。
 *
 * 用法：node scripts/push-mac-release.cjs <版本号>
 */
const { execSync } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { assertWindowsReleaseReady } = require('./release-asset-contract.cjs')
// 与构建时的 afterSign 钩子共用同一份签名契约，避免门禁与产物实现漂移。
const { assertMacSignatureContract } = require('../apps/electron/scripts/macos-signature.cjs')

const VERSION = process.argv[2]
if (!VERSION) throw new Error('用法：node scripts/push-mac-release.cjs <版本号>')
if (!/^\d+\.\d+\.\d+$/.test(VERSION)) throw new Error(`版本号格式非法：${VERSION}`)
if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  throw new Error(`macOS 发布必须在 darwin-arm64 上运行，当前为 ${process.platform}-${process.arch}`)
}

const ROOT = path.resolve(__dirname, '..')
const ELECTRON = path.join(ROOT, 'apps/electron')
const OUT = path.join(ELECTRON, 'out')
const TAG = `v${VERSION}`
const GH_REPO = 'Yuan-lai-ru-ci/ProferAI'
const HOST = process.env.PROFER_UPDATE_SSH_HOST || '45.114.127.232'
const USER = process.env.PROFER_UPDATE_SSH_USER || 'root'
const SSH_PORT = process.env.PROFER_UPDATE_SSH_PORT || '41235'
const UPDATE_FEED_URL = 'https://updates.profer.cn/'
const UPDATE_DIR = process.env.PROFER_MAC_UPDATE_DIR || '/var/www/updates.profer.cn'
// 发布目标：新机为主；旧机（profer.cn/profer-updates/ 供数）在退役前保持双写，PROFER_UPDATE_SKIP_LEGACY=1 可关闭。
const UPDATE_TARGETS = [
  { host: HOST, user: USER, port: SSH_PORT, dir: UPDATE_DIR },
]
if (!process.env.PROFER_UPDATE_SKIP_LEGACY) {
  UPDATE_TARGETS.push({
    host: process.env.PROFER_UPDATE_LEGACY_SSH_HOST || '47.109.108.57',
    user: process.env.PROFER_UPDATE_LEGACY_SSH_USER || 'ecs-user',
    port: process.env.PROFER_UPDATE_LEGACY_SSH_PORT || '22',
    dir: process.env.PROFER_UPDATE_LEGACY_DIR || '/usr/share/nginx/html/profer-updates',
  })
}
const MAC_UPDATE_METADATA = 'latest-mac.yml'

function run(command, cwd = ROOT) {
  return execSync(command, { cwd, encoding: 'utf8', stdio: 'inherit' }).trim()
}
function sha256(filePath) { return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex') }
function remote(command, target = UPDATE_TARGETS[0]) { run(`ssh -o StrictHostKeyChecking=yes -p ${target.port} ${target.user}@${target.host} ${JSON.stringify(command)}`) }
function upload(localPath, remotePath, target = UPDATE_TARGETS[0]) { run(`scp -o StrictHostKeyChecking=yes -P ${target.port} ${JSON.stringify(localPath)} ${target.user}@${target.host}:${JSON.stringify(remotePath)}`) }
function assertExists(filePath) { if (!fs.existsSync(filePath)) throw new Error(`缺少发布资产: ${filePath}`) }

function findMacAssets() {
  const metadata = path.join(OUT, MAC_UPDATE_METADATA)
  const zip = path.join(OUT, `Profer-${VERSION}-arm64-mac.zip`)
  const dmg = path.join(OUT, `Profer-${VERSION}-arm64.dmg`)
  // 增量下载依赖 ZIP 旁边的 .zip.blockmap；缺它会让每次更新都退化成全量下载。
  const blockmap = `${zip}.blockmap`
  for (const filePath of [metadata, zip, dmg, blockmap]) assertExists(filePath)
  return [metadata, zip, dmg, blockmap]
}

function findAppBundle() {
  const direct = path.join(OUT, 'Profer.app')
  const nested = fs.existsSync(OUT)
    ? fs.readdirSync(OUT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(OUT, entry.name, 'Profer.app'))
    : []
  return [direct, ...nested].find((candidate) => fs.existsSync(candidate)) ?? null
}

function assertSignedApp() {
  const appPath = findAppBundle()
  if (!appPath) throw new Error(`未找到 macOS 解包产物：${path.join(OUT, 'Profer.app')}`)
  const result = assertMacSignatureContract(appPath)
  console.log(`  签名契约通过：DR=${result.designatedRequirement}（嵌套 App ${result.nestedAppCount} 个）`)
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
  const [metadata, zip, dmg, blockmap] = findMacAssets()
  assertSignedApp()
  run('bun run verify:mac-package', ELECTRON)
  run('bun run verify:mac-signature', ELECTRON)
  run('node scripts/verify-macos-update-assets.cjs', ELECTRON)

  // 构建可能耗时较久；任何远程写入前再次确认 Windows Release 仍满足契约。
  assertWindowsReleaseReady(readReleaseAssets(), VERSION)
  console.log(`[1/2] 上传 macOS 更新资产到 ${UPDATE_FEED_URL}`)
  const uploadedNames = [metadata, zip, dmg, blockmap].map((filePath) => path.basename(filePath))
  for (const target of UPDATE_TARGETS) {
    const sudo = target.user === 'root' ? '' : 'sudo '
    for (const filePath of [metadata, zip, dmg, blockmap]) upload(filePath, `/tmp/${path.basename(filePath)}`, target)
    const copyCommands = uploadedNames.map((name) => `${sudo}cp /tmp/${name} ${target.dir}/`).join(' && ')
    remote(`${sudo}mkdir -p ${target.dir} && ${copyCommands} && ${sudo}chmod -R 755 ${target.dir}`, target)
    console.log(`  已上传到 ${target.user}@${target.host}:${target.dir}`)
  }

  console.log('[2/2] 上传 GitHub Release macOS 资产')
  ensureGitHubAssets([metadata, zip, dmg, blockmap])
  console.log(`=== macOS 发布完成 ${TAG} ===`)
})().catch((error) => {
  console.error(`macOS 发布失败：${error.message}`)
  process.exit(1)
})
