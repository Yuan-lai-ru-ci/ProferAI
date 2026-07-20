/** 团队文件路由的纯工具函数 */

const RESERVED_PATH_PREFIXES = ['__trash__', '.trash']

/** 服务端私有命名空间永远不能由团队文件 API 读写。 */
export function isReservedFilePath(path) {
  return RESERVED_PATH_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))
}

export function normalizeFilePath(input) {
  if (typeof input !== 'string') return null
  const normalized = input.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  if (!normalized || normalized.includes('\0')) return null
  const parts = normalized.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..')) return null
  if (isReservedFilePath(normalized)) return null
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
      // 无上传者记录（旧数据/自动创建的父目录）：允许任何成员管理，避免文件永久不可操作
      hasModifiableRow = true
      continue
    }
    if (row.uploaded_by !== userId) return false
    hasModifiableRow = true
  }
  return hasModifiableRow
}
