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
 * 发布顺序不固定：macOS 可以先推送 tag、创建并发布 GitHub Release，Windows 之后
 * 再补自己的资产；反之亦然。先跑的一方负责创建 Release，后跑的一方只补资产。
 *
 * 用法：node scripts/push-mac-release.cjs <版本号>
 */
const { execSync } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const {
  assertReleasePublished,
  hasMacReleaseAssets,
  hasWindowsReleaseAssets,
} = require('./release-asset-contract.cjs')
// 与构建时的 afterSign 钩子共用同一份签名契约，避免门禁与产物实现漂移。
const { assertMacSignatureContract } = require('../apps/electron/scripts/macos-signature.cjs')
const { assertPreviousBlockmapPublished, findPurgedBlockmaps } = require('./update-feed-contract.cjs')

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
const UPDATE_FEED_URL = 'https://updates.profer.cn/'
const LEGACY_UPDATE_FEED_URL = 'https://profer.cn/profer-updates/'
const MAC_UPDATE_METADATA = 'latest-mac.yml'
const RELEASE_RETRY_DELAYS_MS = [0, 15_000, 45_000, 90_000]

/**
 * 生产主机、SSH 用户与端口一律由环境变量提供，仓库内不保存任何默认值：
 *   PROFER_UPDATE_SSH_HOST / _USER / _PORT / PROFER_MAC_UPDATE_DIR                 新机
 *   PROFER_UPDATE_LEGACY_SSH_HOST / _USER / _PORT / PROFER_UPDATE_LEGACY_DIR       旧机
 */
function requireEnv(name, hint) {
  const value = (process.env[name] || '').trim()
  if (!value) throw new Error(`缺少环境变量 ${name}：${hint}`)
  return value
}

function assertSafeTarget(target) {
  if (!/^[A-Za-z0-9.-]+$/.test(target.host)) throw new Error(`更新源主机非法: ${target.host}`)
  if (!/^[A-Za-z0-9._-]+$/.test(target.user)) throw new Error(`更新源用户非法: ${target.user}`)
  if (!/^\d{2,5}$/.test(String(target.port))) throw new Error(`更新源端口非法: ${target.port}`)
  if (!/^[A-Za-z0-9._/-]+$/.test(target.dir)) throw new Error(`更新源目录非法: ${target.dir}`)
  return target
}

let updateTargetsCache = null
function getUpdateTargets() {
  if (updateTargetsCache) return updateTargetsCache
  const targets = [assertSafeTarget({
    label: '新机',
    host: requireEnv('PROFER_UPDATE_SSH_HOST', '国内更新源主机'),
    user: requireEnv('PROFER_UPDATE_SSH_USER', '国内更新源 SSH 用户'),
    port: process.env.PROFER_UPDATE_SSH_PORT || '22',
    dir: process.env.PROFER_MAC_UPDATE_DIR || '/var/www/updates.profer.cn',
  })]
  if (process.env.PROFER_UPDATE_SKIP_LEGACY !== '1') {
    targets.push(assertSafeTarget({
      label: '旧机',
      host: requireEnv('PROFER_UPDATE_LEGACY_SSH_HOST', '旧更新源主机；已退役可设 PROFER_UPDATE_SKIP_LEGACY=1'),
      user: requireEnv('PROFER_UPDATE_LEGACY_SSH_USER', '旧更新源 SSH 用户'),
      port: process.env.PROFER_UPDATE_LEGACY_SSH_PORT || '22',
      dir: process.env.PROFER_UPDATE_LEGACY_DIR || '/usr/share/nginx/html/profer-updates',
    }))
  }
  updateTargetsCache = targets
  return targets
}

function run(command, cwd = ROOT) {
  execSync(command, { cwd, stdio: 'inherit' })
}
function capture(command, cwd = ROOT) {
  return execSync(command, { cwd, encoding: 'utf8' }).trim()
}
function tryCapture(command, cwd = ROOT) {
  try {
    return { ok: true, out: capture(command, cwd) }
  } catch (error) {
    return { ok: false, out: ((error.stdout || '') + (error.stderr || '') || error.message || '').trim() }
  }
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
function quote(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`
}
function sha256(filePath) { return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex') }
function remote(command, target = getUpdateTargets()[0]) { run(`ssh -o StrictHostKeyChecking=yes -p ${target.port} ${target.user}@${target.host} ${JSON.stringify(command)}`) }
function upload(localPath, remotePath, target = getUpdateTargets()[0]) { run(`scp -o StrictHostKeyChecking=yes -P ${target.port} ${JSON.stringify(localPath)} ${target.user}@${target.host}:${JSON.stringify(remotePath)}`) }
function assertExists(filePath) { if (!fs.existsSync(filePath)) throw new Error(`缺少发布资产: ${filePath}`) }

/**
 * 读取更新源当前的 metadata；源不可达或目录为空时返回 null（首次发布到该源）。
 */
function readServedMetadata(feedUrl, metadataName) {
  try {
    return capture(`curl -fsSL --max-time 20 ${JSON.stringify(`${feedUrl}${metadataName}`)}`)
  } catch {
    return null
  }
}

/** 取公网 URL 的 HTTP 状态码；拿不到状态码直接抛错，不能把「连不上」当成「存在」。 */
function fetchPublicStatus(url) {
  const output = capture(`curl -sS -I -o /dev/null --max-time 20 -w '%{http_code}' ${JSON.stringify(url)}`)
  const status = Number(output.trim())
  if (!Number.isFinite(status) || status === 0) throw new Error(`无法访问 ${url}（curl 不可用或网络不通）`)
  return status
}

/**
 * 差分门禁：确认上一版本的 blockmap 仍在更新源上。
 *
 * 缺它不会让更新失败，只会让客户端静默退化成 256MB 全量下载——这正是「更新很慢」的根因。
 */
function assertDifferentialPrerequisite(feedUrl, metadataName, { warnOnly = false } = {}) {
  const metadataText = readServedMetadata(feedUrl, metadataName)
  if (metadataText === null) {
    console.warn(`[差分门禁] ${feedUrl}${metadataName} 不可读，跳过校验（首次发布到该源？）`)
    return
  }
  const result = assertPreviousBlockmapPublished({
    feedUrl,
    metadataText,
    version: VERSION,
    fetchStatus: fetchPublicStatus,
    allowMissing: warnOnly || process.env.PROFER_UPDATE_ALLOW_MISSING_PREVIOUS_BLOCKMAP === '1',
  })
  if (result.checked && result.ok) console.log(`  上一版本 blockmap 可用：${result.url}`)
}

/**
 * 告警：最近几个版本的 blockmap 是否已被清理。
 *
 * 跨了多个版本的用户如果发现自己的 blockmap 404，只能全量下载 256MB。这里不阻断发布，
 * 只把「谁被清理了」摆到发布日志里——0.15.83 就是这么静默失效的。
 */
function warnPurgedBlockmaps(feedUrl) {
  const releasesJson = readServedMetadata(feedUrl, 'releases.json')
  if (releasesJson === null) return
  const { checked, missing } = findPurgedBlockmaps({
    feedUrl,
    releasesJsonText: releasesJson,
    currentVersion: VERSION,
    installerName: (version) => `Profer-${version}-arm64-mac.zip`,
    fetchStatus: fetchPublicStatus,
  })
  if (missing.length === 0) {
    if (checked.length > 0) console.log(`  最近 ${checked.length} 个版本的 blockmap 都在`)
    return
  }
  console.warn(`[差分告警] 最近 ${checked.length} 个版本里有 ${missing.length} 个 blockmap 已被清理（这些版本的用户只能全量下载）：`)
  for (const item of missing) console.warn(`  - ${item.version}: ${item.blockmap} → HTTP ${item.status}`)
}

function verifyPublicFeed(feedUrl, assetPaths) {
  const metadataPath = assetPaths.find((filePath) => path.basename(filePath) === MAC_UPDATE_METADATA)
  if (!metadataPath) throw new Error(`发布资产缺少 ${MAC_UPDATE_METADATA}`)
  const remoteMetadata = capture(`curl -fsSL ${JSON.stringify(`${feedUrl}${MAC_UPDATE_METADATA}`)}`)
  const localMetadata = fs.readFileSync(metadataPath, 'utf8').trim()
  if (remoteMetadata !== localMetadata) {
    throw new Error(`公开更新源元数据不一致: ${feedUrl}${MAC_UPDATE_METADATA}`)
  }

  for (const filePath of assetPaths) {
    const name = path.basename(filePath)
    if (name === MAC_UPDATE_METADATA) continue
    if (name.endsWith('.blockmap')) {
      // blockmap 是下次发版差分的前提，必须确认真的可访问（以前只跳过不检查）。
      const status = fetchPublicStatus(`${feedUrl}${name}`)
      if (status !== 200) throw new Error(`公开更新源缺少 blockmap: ${feedUrl}${name} (HTTP ${status})`)
      continue
    }
    const headers = capture(`curl -fsSLI ${JSON.stringify(`${feedUrl}${name}`)}`)
    const lengths = [...headers.matchAll(/(?:^|\n)content-length:\s*(\d+)/ig)].map((match) => Number(match[1]))
    const remoteSize = lengths.at(-1)
    const localSize = fs.statSync(filePath).size
    if (remoteSize !== localSize) {
      throw new Error(`公开更新源文件大小不一致: ${feedUrl}${name} (${remoteSize ?? '缺失'} != ${localSize})`)
    }
  }
  console.log(`  公开更新源校验通过：${feedUrl}`)
}

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
  const result = tryCapture(`gh release view ${TAG} --repo ${GH_REPO} --json assets,isDraft,name`)
  if (!result.ok) return null
  try {
    return JSON.parse(result.out)
  } catch {
    return null
  }
}

function remoteTagTarget() {
  const output = capture(`git ls-remote --tags origin refs/tags/${TAG} refs/tags/${TAG}^{}`)
  if (!output) return null
  const lines = output.split(/\r?\n/).map((line) => line.split(/\s+/))
  const peeled = lines.find(([, ref]) => ref.endsWith('^{}'))
  return (peeled || lines[0])[0]
}

function localTagTarget() {
  const result = tryCapture(`git rev-list -n 1 refs/tags/${TAG}`)
  return result.ok ? result.out : null
}

/**
 * 推送源码与 tag。macOS 现在可以先发布，因此这里与 Windows 脚本使用同一套
 * 防覆盖约束：已存在的本地/远端 tag 必须指向 HEAD，否则拒绝发布。
 */
function pushSourceAndTag() {
  const head = capture('git rev-parse HEAD')
  const localTag = localTagTarget()
  const remoteTag = remoteTagTarget()
  if (localTag && localTag !== head) throw new Error(`本地 ${TAG} 不指向 HEAD，拒绝覆盖已有 tag。`)
  if (remoteTag && remoteTag !== head) throw new Error(`远端 ${TAG} 不指向 HEAD，拒绝覆盖已有 tag。`)

  const mainIsAncestor = tryCapture('git merge-base --is-ancestor origin/main HEAD').ok
  if (mainIsAncestor) {
    run('git push origin HEAD:main')
  } else if (!localTag) {
    throw new Error('创建新 tag 前 HEAD 必须包含最新 origin/main；请先同步 main。')
  } else {
    console.log('  HEAD 不是 origin/main 的最新提交，跳过源码推送（按补充已发布版本资产处理）。')
  }
  if (!localTag) run(`git tag ${TAG}`)
  if (!remoteTag) run(`git push origin ${TAG}`)
}

function transientGitHubError(output) {
  return /\b(?:429|500|502|503|504)\b|no server is currently available|timeout|temporar(?:y|ily)|econnreset|eof/i.test(output)
}

async function retryGitHub(label, action, isRecovered = () => false) {
  let lastError = ''
  for (let attempt = 0; attempt < RELEASE_RETRY_DELAYS_MS.length; attempt += 1) {
    if (attempt > 0) {
      const delay = RELEASE_RETRY_DELAYS_MS[attempt]
      console.log(`  ${label}: 等待 ${Math.round(delay / 1000)}s 后重试 (${attempt + 1}/${RELEASE_RETRY_DELAYS_MS.length})`)
      await sleep(delay)
      if (await isRecovered()) return
    }

    const result = action()
    if (result.ok) return
    lastError = result.out
    if (await isRecovered()) return
    if (!transientGitHubError(result.out) || attempt === RELEASE_RETRY_DELAYS_MS.length - 1) break
    console.warn(`  ${label}: GitHub 暂时不可用，准备重试。`)
  }
  throw new Error(`${label} 失败: ${lastError.slice(-500)}`)
}

function assetMatches(release, filePath) {
  const name = path.basename(filePath)
  const asset = release?.assets?.find((item) => item.name === name)
  return Boolean(asset) &&
    asset.size === fs.statSync(filePath).size &&
    asset.digest === `sha256:${sha256(filePath)}`
}

async function waitForAssets(assetPaths) {
  for (let attempt = 0; attempt < RELEASE_RETRY_DELAYS_MS.length; attempt += 1) {
    if (attempt > 0) await sleep(RELEASE_RETRY_DELAYS_MS[attempt])
    const release = readReleaseAssets()
    if (assetPaths.every((filePath) => assetMatches(release, filePath))) return release
    console.warn(`  GitHub Release 资产尚未可见，继续等待 (${attempt + 1}/${RELEASE_RETRY_DELAYS_MS.length})`)
  }
  throw new Error('GitHub Release 资产未在重试窗口内全部进入 uploaded 状态。')
}

/**
 * 确保 GitHub Release 存在。不存在时先建草稿；已存在（草稿或已发布）则直接复用。
 * 先建草稿、等国内更新源也上传成功后再正式发布，避免发布出半套资产。
 */
async function ensureGitHubReleaseDraft() {
  if (readReleaseAssets()) return
  const notesFile = path.join(ROOT, 'release-notes', `${TAG}.md`)
  const notesArg = fs.existsSync(notesFile) ? `--notes-file ${quote(notesFile)}` : '--generate-notes'
  await retryGitHub('创建 GitHub Release', () => {
    const result = tryCapture(
      `gh release create ${TAG} --repo ${GH_REPO} --title ${quote(`Profer ${TAG}`)} --draft ${notesArg}`,
    )
    return !result.ok && /already exists|already_exists|HTTP 422/i.test(result.out)
      ? { ok: true, out: result.out }
      : result
  }, () => Boolean(readReleaseAssets()))
}

async function uploadGitHubAssets(assetPaths) {
  for (const filePath of assetPaths) {
    const name = path.basename(filePath)
    if (assetMatches(readReleaseAssets(), filePath)) {
      console.log(`  ${name}: 已存在且 SHA-256 匹配`)
      continue
    }
    await retryGitHub(`上传 ${name}`, () => tryCapture(
      `gh release upload ${TAG} ${quote(filePath)} --repo ${GH_REPO} --clobber`,
    ), () => assetMatches(readReleaseAssets(), filePath))
  }
  await waitForAssets(assetPaths)
}

async function publishGitHubRelease() {
  const releaseName = `Profer ${TAG}`
  const release = readReleaseAssets()
  if (release?.isDraft) {
    await retryGitHub('发布 GitHub Release', () => tryCapture(
      `gh release edit ${TAG} --repo ${GH_REPO} --draft=false --latest --title ${quote(releaseName)}`,
    ), () => {
      const current = readReleaseAssets()
      return current?.isDraft === false && current.name === releaseName
    })
  } else {
    await retryGitHub('校正 GitHub Release 元数据', () => tryCapture(
      `gh release edit ${TAG} --repo ${GH_REPO} --latest --title ${quote(releaseName)}`,
    ), () => readReleaseAssets()?.name === releaseName)
  }
}

(async () => {
  console.log(`=== Profer macOS 发布 ${TAG} ===`)
  // macOS 可以先创建 tag/Release，也可以在 Windows 发布后补充资产；
  // 但已发布且 macOS 资产完整的版本禁止重复覆盖。
  const existingRelease = readReleaseAssets()
  if (existingRelease && existingRelease.isDraft === false && hasMacReleaseAssets(existingRelease, VERSION)) {
    throw new Error(`${TAG} 已发布且包含完整 macOS 资产；拒绝覆盖已发布版本。如仅需刷新版本历史，请手动运行 node scripts/build-releases-json.cjs --upload。`)
  }
  // 先校验差分前提再花十几分钟构建：上一版本 blockmap 缺失会让所有存量用户
  // 下次更新静默退化成 256MB 全量下载，这属于发布前置条件，不是发布后检查。
  console.log('[0/5] 校验分块差分前提（上一版本 blockmap）...')
  assertDifferentialPrerequisite(UPDATE_FEED_URL, MAC_UPDATE_METADATA)
  if (!process.env.PROFER_UPDATE_SKIP_LEGACY) {
    // 旧机只是备用源：差分失效不影响兜底可用性，不拿它阻断正式发布。
    assertDifferentialPrerequisite(LEGACY_UPDATE_FEED_URL, MAC_UPDATE_METADATA, { warnOnly: true })
  }
  warnPurgedBlockmaps(UPDATE_FEED_URL)

  run(`node scripts/verify-release-preflight.cjs ${VERSION} --allow-published-release`)
  run('bun run typecheck')
  run('bun test --isolate --timeout 30000')
  run('bun run dist:mac-release', ELECTRON)
  const [metadata, zip, dmg, blockmap] = findMacAssets()
  assertSignedApp()
  run('bun run verify:mac-package', ELECTRON)
  run('bun run verify:mac-signature', ELECTRON)
  run('node scripts/verify-macos-update-assets.cjs', ELECTRON)

  console.log('[1/5] 推送源码与版本 tag...')
  pushSourceAndTag()

  console.log('[2/5] 创建/复用 GitHub Release...')
  await ensureGitHubReleaseDraft()

  console.log(`[3/5] 上传 macOS 更新资产到 ${UPDATE_FEED_URL}`)
  const uploadedNames = [metadata, zip, dmg, blockmap].map((filePath) => path.basename(filePath))
  for (const target of getUpdateTargets()) {
    const sudo = target.user === 'root' ? '' : 'sudo '
    for (const filePath of [metadata, zip, dmg, blockmap]) upload(filePath, `/tmp/${path.basename(filePath)}`, target)
    const copyCommands = uploadedNames.map((name) => `${sudo}cp /tmp/${name} ${target.dir}/`).join(' && ')
    remote(`${sudo}mkdir -p ${target.dir} && ${copyCommands} && ${sudo}chmod -R 755 ${target.dir}`, target)
    console.log(`  已上传到 ${target.user}@${target.host}:${target.dir}`)
  }
  verifyPublicFeed(UPDATE_FEED_URL, [metadata, zip, dmg, blockmap])
  if (!process.env.PROFER_UPDATE_SKIP_LEGACY) {
    verifyPublicFeed(LEGACY_UPDATE_FEED_URL, [metadata, zip, dmg, blockmap])
  }

  console.log('[4/5] 上传 GitHub Release macOS 资产...')
  await uploadGitHubAssets([metadata, zip, dmg, blockmap])

  console.log('[5/5] 正式发布 GitHub Release 并刷新版本历史...')
  await publishGitHubRelease()
  const release = assertReleasePublished(readReleaseAssets(), VERSION)
  if (!hasMacReleaseAssets(release, VERSION)) {
    throw new Error(`${TAG} 发布后缺少完整的 macOS 资产。`)
  }
  run('node scripts/build-releases-json.cjs --upload')

  if (!hasWindowsReleaseAssets(release, VERSION)) {
    console.log(
      `[提示] Windows 资产尚未发布：请在 Windows 机器上运行 ` +
      `node scripts/push-release.cjs ${VERSION} 补齐 Windows 安装包与 latest.yml。`,
    )
  }
  console.log(`=== macOS 发布完成 ${TAG} ===`)
})().catch((error) => {
  console.error(`macOS 发布失败：${error.message}`)
  process.exit(1)
})
