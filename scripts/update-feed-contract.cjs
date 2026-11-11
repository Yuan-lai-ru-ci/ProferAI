/**
 * 更新源的分块差分契约。
 *
 * macOS（Squirrel zip）和 Windows（NSIS exe）都靠 electron-updater 的块级差分下载：
 * `Provider.getBlockMapFiles()` 会把「新版本文件名」里的版本号替换成「旧版本号」，
 * 再去更新源取 `${旧文件名}.blockmap`。所以差分能不能用，取决于**服务器上还留着
 * 用户当前安装版本的 blockmap**。
 *
 * 缺这个文件时客户端不会报错——`MacUpdater` / `NsisUpdater` 只会静默退化成全量下载
 * （macOS 256MB / Windows 224MB），用户感受到的就是「更新特别慢」。
 *
 * 2026-10-31 实测（nginx 访问日志，10-22 ~ 10-31）：
 * - 差分对「blockmap 还在的版本」是生效的：0.16.16 Windows 有 4 个客户端只下了 27~29MB，
 *   macOS 两个客户端下了 47/56MB；0.16.13 的 blockmap 被请求 12 次且全部 200。
 * - 真正的失败案例是**跨了多个版本**的用户：`Profer-Setup-0.15.83.exe.blockmap` 返回 404，
 *   该客户端只能全量下载 224MB。
 *
 * 结论：发布前要确认「上一版本」的 blockmap 仍在（阻断），并提示最近几个版本是否已被清理（告警），
 * 别让「静默退化成全量下载」只能靠用户体感发现。
 */

const UPDATE_METADATA_VERSION = /^version:\s*(\S+)\s*$/m
const UPDATE_METADATA_PATH = /^path:\s*(\S+)\s*$/m

/** 解析 `latest-mac.yml` / `latest.yml`：只取差分门禁需要的 version 与 path。 */
function parseUpdateMetadata(text) {
  const source = String(text ?? '')
  return {
    version: UPDATE_METADATA_VERSION.exec(source)?.[1] ?? null,
    fileName: UPDATE_METADATA_PATH.exec(source)?.[1] ?? null,
  }
}

/**
 * 计算「当前已安装版本」的 blockmap 地址。
 *
 * 服务端 metadata 的 `path` 就是用户当前会拿到（或已经拿到）的安装包名，
 * 差分请求的旧 blockmap 正是 `${该文件名}.blockmap`。
 */
function previousBlockmapUrl(feedUrl, fileName) {
  const base = String(feedUrl).endsWith('/') ? String(feedUrl) : `${feedUrl}/`
  return `${base}${fileName}.blockmap`
}

/**
 * 发布门禁：确认上一版本的 blockmap 仍在更新源上。
 *
 * @param {object} options
 * @param {string} options.feedUrl 更新源根地址（带尾斜杠）
 * @param {string} options.metadataText 上传前从更新源读到的 metadata 原文
 * @param {string} options.version 本次要发布的版本号
 * @param {(url: string) => number} options.fetchStatus 返回 HTTP 状态码（网络异常抛错）
 * @param {boolean} [options.allowMissing] 明确放弃差分时跳过门禁（会打印醒目警告）
 * @returns {{checked: boolean, ok: boolean, url?: string, reason?: string}}
 */
function assertPreviousBlockmapPublished({ feedUrl, metadataText, version, fetchStatus, allowMissing = false }) {
  const { version: servedVersion, fileName } = parseUpdateMetadata(metadataText)
  if (!servedVersion || !fileName) {
    return { checked: false, ok: false, reason: 'metadata-unparsed' }
  }
  // 更新源上已经是本次版本（重复发布/补传资产），没有「上一版本」需要校验。
  if (servedVersion === version) {
    return { checked: false, ok: false, reason: 'same-version' }
  }

  const url = previousBlockmapUrl(feedUrl, fileName)
  const status = fetchStatus(url)
  if (status === 200) {
    return { checked: true, ok: true, url }
  }
  if (allowMissing) {
    console.warn(
      `[差分门禁] 已按 PROFER_UPDATE_ALLOW_MISSING_PREVIOUS_BLOCKMAP 跳过：${url} 返回 ${status}。` +
      `所有 ${servedVersion} 用户下次更新都会退化成全量下载。`,
    )
    return { checked: true, ok: false, url, reason: `http-${status}` }
  }

  throw new Error(
    `更新源缺少上一版本的分块映射：${url}（HTTP ${status}）。\n` +
    `缺它不会报错，只会让所有 ${servedVersion} 用户下次更新静默退化成全量下载（220MB+）。\n` +
    `修复：把 ${fileName}.blockmap（约 270KB）补传到更新源目录，并确认服务器清理策略不再删除历史 blockmap。\n` +
    `如确认放弃差分，可设置 PROFER_UPDATE_ALLOW_MISSING_PREVIOUS_BLOCKMAP=1 跳过此门禁。`,
  )
}

/**
 * 从 `releases.json`（GitHub Release 镜像，服务器上就有）取出最近几个版本。
 *
 * 只用来做「老版本的 blockmap 是不是被清理了」的告警：跨了多个版本的用户
 * 一旦发现自己的 blockmap 404，就只能全量下载 224MB。
 */
function listRecentVersions(releasesJsonText, currentVersion, limit = 5) {
  let releases
  try {
    releases = JSON.parse(String(releasesJsonText ?? ''))
  } catch {
    return []
  }
  if (!Array.isArray(releases)) return []
  const versions = releases
    .map((release) => String(release?.tag_name ?? '').replace(/^v/, ''))
    .filter((version) => /^\d+\.\d+\.\d+/.test(version) && version !== currentVersion)
  // releases.json 按发布时间倒序，去重后取前 limit 个。
  return [...new Set(versions)].slice(0, limit)
}

/**
 * 检查最近几个版本的「安装包存在但 blockmap 缺失」情况（告警，不阻断）。
 *
 * 先探安装包再探 blockmap：某些版本只在单一平台发布（例如 0.16.15 只有 macOS），
 * 只看 blockmap 会把它误报成「被清理」。
 */
function findPurgedBlockmaps({ feedUrl, releasesJsonText, currentVersion, installerName, limit = 5, fetchStatus }) {
  const base = String(feedUrl).endsWith('/') ? String(feedUrl) : `${feedUrl}/`
  const missing = []
  const checked = []
  for (const version of listRecentVersions(releasesJsonText, currentVersion, limit)) {
    const installer = installerName(version)
    if (fetchStatus(`${base}${installer}`) !== 200) continue
    const blockmap = `${installer}.blockmap`
    const status = fetchStatus(`${base}${blockmap}`)
    checked.push(version)
    if (status !== 200) missing.push({ version, blockmap, status })
  }
  return { checked, missing }
}

/**
 * 发行版与更新源目录的对应关系。
 *
 * 两个发行版的元数据文件同名（latest.yml / latest-mac.yml），只能靠**目录**隔离。
 * 一旦开源版资产写进商业目录，商业版用户会被告知升级到一个没有账号能力的版本——
 * 这不是普通的事故，而是把付费用户静默降级，所以发布前必须机械校验。
 */
const EDITION_ARTIFACT_PREFIX = {
  oss: 'Profer-',
  commercial: 'Profer-Commercial-',
}

/**
 * 从发布资产文件名推断发行版。
 * 注意顺序：商业包同样以 `Profer-` 开头，必须先认 `Profer-Commercial-`。
 *
 * @param {string[]} fileNames
 * @returns {'oss' | 'commercial' | 'mixed' | 'unknown'}
 */
function classifyArtifactEdition(fileNames) {
  const names = (fileNames ?? []).map((name) => String(name))
  const isCommercial = (name) => name.startsWith(EDITION_ARTIFACT_PREFIX.commercial)
  const isOss = (name) => name.startsWith(EDITION_ARTIFACT_PREFIX.oss) && !isCommercial(name)
  const hasCommercial = names.some(isCommercial)
  const hasOss = names.some(isOss)
  if (hasCommercial && hasOss) return 'mixed'
  if (hasCommercial) return 'commercial'
  if (hasOss) return 'oss'
  return 'unknown'
}

/**
 * 发布门禁：资产发行版必须与目标更新目录匹配。
 *
 * @param {object} options
 * @param {string} options.edition classifyArtifactEdition 的结果
 * @param {string} options.dir 目标更新目录
 * @param {string} [options.label] 目标标签，用于报错定位
 */
function assertFeedDirectoryMatchesEdition({ edition, dir, label = '' }) {
  const target = String(dir ?? '').replace(/\/+$/, '')
  const where = label ? `（${label}）` : ''
  if (edition === 'mixed') {
    throw new Error(`发布资产同时包含开源版与商业版安装包，拒绝上传${where}。请分开发布。`)
  }
  if (edition === 'unknown') return
  if (edition === 'oss' && !target.endsWith('/oss')) {
    throw new Error(
      `开源版资产正在写入商业版更新目录${where}: ${target}\n` +
      '两个发行版的 latest.yml 同名，会直接覆盖商业版元数据，把商业用户升级到没有账号能力的版本。\n' +
      '修复：把 PROFER_UPDATE_DIR / PROFER_MAC_UPDATE_DIR 指向 <商业目录>/oss。',
    )
  }
  if (edition === 'commercial' && target.endsWith('/oss')) {
    throw new Error(
      `商业版资产正在写入开源版更新目录${where}: ${target}\n` +
      '修复：商业版应上传到平铺的商业目录（不带 /oss 后缀）。',
    )
  }
}

module.exports = {
  parseUpdateMetadata,
  previousBlockmapUrl,
  assertPreviousBlockmapPublished,
  listRecentVersions,
  findPurgedBlockmaps,
  classifyArtifactEdition,
  assertFeedDirectoryMatchesEdition,
}
