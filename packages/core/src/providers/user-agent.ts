const PROMA_REPO_URL = 'https://github.com/Yuan-lai-ru-ci/Profer'

/** semver 格式校验（MAJOR.MINOR.PATCH 及预发布后缀） */
const SEMVER_RE = /^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$/

let _promaVersion = '0.0.0'

export function setPromaVersion(version: string): void {
  if (!SEMVER_RE.test(version)) {
    console.warn(`[Proma] setPromaVersion 收到非 semver 格式版本号: "${version}"，已忽略。使用当前版本 ${_promaVersion}`)
    return
  }
  _promaVersion = version
}

export function getPromaVersion(): string {
  return _promaVersion
}

export function getPromaUserAgent(version?: string): string {
  const v = version ?? _promaVersion
  // 产品名保持 Proma 兼容渠道服务端白名单（kimi-coding/zhipu-coding/xiaomi-token-plan）
  return `Proma/${v} (+${PROMA_REPO_URL})`
}
