const PROMA_REPO_URL = 'https://github.com/Yuan-lai-ru-ci/Profer'

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

export function getProferUserAgent(version?: string): string {
  const v = version ?? _proferVersion
  // 产品名保持 Proma 兼容渠道服务端白名单（kimi-coding/zhipu-coding/xiaomi-token-plan）
  // ⚠️ 不可改为 Profer，否则这些渠道会因 UA 白名单校验失败而不可用
  return `Proma/${v} (+${PROMA_REPO_URL})`
}
