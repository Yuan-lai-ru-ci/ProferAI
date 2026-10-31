const PROFER_REPO_URL = 'https://github.com/Yuan-lai-ru-ci/Profer'

/**
 * 渠道白名单兼容标识。
 *
 * Kimi Coding Plan / 智谱 Coding Plan / 小米 Token Plan 的服务端按 UA 产品名放行，
 * 白名单里登记的是旧产品名 `Proma`。这是**服务端契约**，不是产品名，只在
 * `requiresWhitelistUserAgent()` 命中的渠道上使用；其余请求一律发 `Profer/`。
 */
const WHITELIST_COMPAT_PRODUCT = 'Proma'

/** semver 格式校验（MAJOR.MINOR.PATCH 及预发布后缀） */
const SEMVER_RE = /^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$/

let _proferVersion = '0.0.0'

export function setProferVersion(version: string): void {
  if (!SEMVER_RE.test(version)) {
    console.warn(`[Profer] setProferVersion 收到非 semver 格式版本号: "${version}"，已忽略。使用当前版本 ${_proferVersion}`)
    return
  }
  _proferVersion = version
}

export function getProferVersion(): string {
  return _proferVersion
}

/** 默认 User-Agent：产品名一律 Profer。 */
export function getProferUserAgent(version?: string): string {
  const v = version ?? _proferVersion
  return `Profer/${v} (+${PROFER_REPO_URL})`
}

/**
 * 计划渠道白名单 User-Agent：产品名保持 `Proma`。
 *
 * ⚠️ 只给 `requiresWhitelistUserAgent()` 命中的渠道用。改成 `Profer` 会让这些
 * 渠道的 UA 白名单校验失败（Kimi Coding Plan 直接 403）。
 */
export function getWhitelistCompatUserAgent(version?: string): string {
  const v = version ?? _proferVersion
  return `${WHITELIST_COMPAT_PRODUCT}/${v} (+${PROFER_REPO_URL})`
}
