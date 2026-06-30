/** 团队文件路由的纯工具函数 */

export function normalizeFilePath(input) {
  if (typeof input !== 'string') return null
  const normalized = input.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  if (!normalized || normalized.includes('\0')) return null
  const parts = normalized.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..')) return null
  return normalized
}

/** decodeURIComponent 安全包装，防止无效编码导致崩溃 */
export function safeDecodeURI(input) {
  try {
    return decodeURIComponent(input)
  } catch {
    return null
  }
}

export function canModifyRows(rows, userId) {
  let hasModifiableRow = false
  for (const row of rows) {
    if (!row.uploaded_by) {
      if (!row.is_directory) return false
      hasModifiableRow = true
      continue
    }
    if (row.uploaded_by !== userId) return false
    hasModifiableRow = true
  }
  return hasModifiableRow
}
