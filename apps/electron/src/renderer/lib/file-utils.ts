/**
 * 文件处理工具函数
 */

import { MAX_ATTACHMENT_SIZE } from '@profer/shared'

export function formatFileNames(names: string[], max = 3): string {
  if (names.length <= max) return names.join('、')
  return `${names.slice(0, max).join('、')} 等 ${names.length} 个文件`
}

/**
 * 从路径提取文件名（全 renderer 层唯一实现，R1 统一收敛）
 * 兼容 Windows 反斜杠与 Unix 正斜杠；无分隔符时返回原串。
 */
export function getFileBaseName(filePath: string): string {
  return filePath.split(/[\\/]/).filter(Boolean).pop() || filePath
}

/**
 * 判断路径是否为绝对路径（全 renderer 层唯一实现，R2 统一收敛）
 *
 * 匹配规则：
 * - Windows 盘符：C:\ 或 C:/
 * - Windows UNC 网络路径：\\server\share
 * - macOS/Linux：以 / 开头
 *
 * 仅做前缀归类，适用于「已知文件路径字符串」的判定；若用于消息文本检测（可能含行号后缀、
 * 正则等非路径内容），由调用方在需要时叠加保守校验（见 file-path-chip 薄封装）。
 */
export function isAbsoluteFilePath(filePath: string): boolean {
  return filePath.startsWith('/') || filePath.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(filePath)
}

/**
 * 面包屑显示：取路径末尾 n 段（默认 2 段）。
 * 段数不足 n 时按原样返回；空串返回空串。分隔符处理与既有实现保持一致（按正斜杠切分）。
 */
export function getLastPathSegments(path: string | null | undefined, n = 2): string {
  if (!path) return ''
  const parts = path.split('/').filter(Boolean)
  return parts.length > n ? `.../${parts.slice(-n).join('/')}` : path
}

/**
 * 相对路径基于候选 base 目录解析为绝对路径（全 renderer 层唯一实现，R4 统一收敛）。
 *
 * 与主进程 resolveTargetPath 的候选 base 语义一致：
 * 优先匹配「首段与 base 目录名相同」的候选（如 base `C:/ws/profer` + 相对路径 `profer/src/a.md`
 * → `C:/ws/profer/src/a.md`，避免多套一层目录），再退化到第一个候选；无候选或无法匹配时返回原路径
 * （保持相对，由主进程继续兜底解析）。
 */
export function resolveRelativeToAbsolute(cleanPath: string, candidateBases: string[]): string {
  if (candidateBases.length === 0) return cleanPath
  const firstSegment = cleanPath.split('/')[0]
  if (firstSegment) {
    for (const base of candidateBases) {
      const baseName = getFileBaseName(base)
      if (baseName === firstSegment) {
        const parentDir = base.endsWith('/')
          ? base.slice(0, base.slice(0, -1).lastIndexOf('/'))
          : base.slice(0, base.lastIndexOf('/'))
        return parentDir.endsWith('/') ? `${parentDir}${cleanPath}` : `${parentDir}/${cleanPath}`
      }
    }
  }
  const base = candidateBases[0]!
  return base.endsWith('/') ? `${base}${cleanPath}` : `${base}/${cleanPath}`
}

export function getFileParentPath(filePath: string): string | null {
  const slashIndex = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  if (slashIndex < 0) return null
  if (slashIndex === 0) return filePath.slice(0, 1)
  if (/^[A-Za-z]:[\\/]/.test(filePath) && slashIndex === 2) {
    return filePath.slice(0, 3)
  }
  return filePath.slice(0, slashIndex)
}

/** 将 File 对象转为 base64 字符串 */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    if (file.size > MAX_ATTACHMENT_SIZE) {
      reject(new Error(`文件 ${file.name} 超过 100MB 大小限制`))
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result as string
      const base64 = result.split(',')[1]!
      resolve(base64)
    }
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}
