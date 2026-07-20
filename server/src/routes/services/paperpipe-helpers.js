const MAX_PAPER_ID_LENGTH = 160

/**
 * 生产环境不得在无内部密钥时把已认证用户请求代理给 Bridge。
 * 开发环境允许显式省略，降低本地 fake Bridge 联调门槛。
 */
export function getPaperpipeBridgeConfig(env = process.env) {
  const url = env.PAPERPIPE_BRIDGE_URL?.trim() || 'http://host.docker.internal:9876'
  const secret = env.PAPERPIPE_BRIDGE_SECRET?.trim()
  const isProduction = env.NODE_ENV === 'production'
  return {
    url,
    secret,
    ready: !isProduction || Boolean(secret),
  }
}

export function isSafePaperpipeId(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_PAPER_ID_LENGTH
    && !value.includes('..')
    && !/[\\/\u0000\r\n]/.test(value)
}

export function sanitizePaperFilename(value) {
  const name = typeof value === 'string' ? value.split(/[\\/]/).pop() : ''
  return (name || 'paper.pdf').replace(/[\u0000-\u001f\u007f"\\]/g, '_').slice(0, 180)
}

export function hasPdfMagicBytes(buffer) {
  return Buffer.isBuffer(buffer) && buffer.subarray(0, 5).toString('ascii') === '%PDF-'
}

export function extractRemotePaperId(data) {
  const candidate = data?.paper?.id ?? data?.paperId ?? data?.id
  return isSafePaperpipeId(candidate) ? candidate : undefined
}

export function normalizePaperpipeSearchInput(body) {
  const query = typeof body?.query === 'string' ? body.query.trim() : ''
  if (!query || query.length > 500) return { error: '搜索关键词不能为空或过长' }
  const { topK, mode } = body
  if (topK != null && (!Number.isInteger(topK) || topK < 1 || topK > 50)) return { error: '搜索数量必须在 1 到 50 之间' }
  if (mode != null && !['fts', 'semantic', 'hybrid'].includes(mode)) return { error: '搜索模式无效' }
  return { value: { query, ...(topK != null ? { topK } : {}), ...(mode != null ? { mode } : {}) } }
}
