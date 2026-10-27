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
 * - 用户主目录缩写：`~/`（或 `~\`）开头；主进程 resolveTargetPath 会展开为真实 home。
 *   Agent 输出常用这种写法（如 create_skin 的 installedPath `~/.profer/skins/<id>`），
 *   不识别就会把可预览的链接降级成普通文本。
 *
 * 仅做前缀归类，适用于「已知文件路径字符串」的判定；若用于消息文本检测（可能含行号后缀、
 * 正则等非路径内容），由调用方在需要时叠加保守校验（见 file-path-chip 薄封装）。
 */
export function isAbsoluteFilePath(filePath: string): boolean {
  return filePath.startsWith('/')
    || filePath.startsWith('~/')
    || filePath.startsWith('~\\')
    || filePath.startsWith('\\\\')
    || /^[A-Za-z]:[\\/]/.test(filePath)
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

const SEPARATOR_PATTERN = /[\\/]+/

/** 路径中是否含 `.` / `..` 段；用于判断是否需要折叠（避免无谓改写分隔符风格）。 */
function hasDotSegments(filePath: string): boolean {
  return filePath.split(SEPARATOR_PATTERN).some((segment) => segment === '.' || segment === '..')
}

/**
 * 拆出路径根前缀（`~`、盘符、UNC、根斜杠），并给出重建时使用的分隔符。
 * 根前缀不需要折叠，也不允许被 `..` 弹出。
 */
function splitPathRoot(filePath: string): { root: string; rest: string; separator: '/' | '\\' } {
  if (filePath.startsWith('~/') || filePath.startsWith('~\\')) {
    return { root: '~', rest: filePath.slice(2), separator: '/' }
  }
  if (/^[A-Za-z]:[\\/]/.test(filePath)) {
    // 盘符后的第一个分隔符决定重建风格，保持用户/Agent 原本的写法。
    return { root: filePath.slice(0, 2), rest: filePath.slice(3), separator: filePath[2] === '/' ? '/' : '\\' }
  }
  if (filePath.startsWith('\\\\')) {
    const segments = filePath.slice(2).split(SEPARATOR_PATTERN).filter(Boolean)
    const share = segments.slice(0, 2)
    return {
      root: share.length === 2 ? `\\\\${share[0]}\\${share[1]}` : '\\\\',
      rest: segments.slice(2).join('/'),
      separator: '\\',
    }
  }
  if (filePath.startsWith('/') || filePath.startsWith('\\')) {
    return { root: '/', rest: filePath.slice(1), separator: '/' }
  }
  return { root: '', rest: filePath, separator: '/' }
}

function joinPathRoot(root: string, body: string, separator: '/' | '\\'): string {
  if (!root) return body
  if (root === '/') return body ? `/${body}` : '/'
  if (root === '~') return body ? `~/${body}` : '~'
  return body ? `${root}${separator}${body}` : root
}

/**
 * 折叠路径里的 `.` / `..` 段，返回可直接展示、复制、粘贴回终端的规范化路径。
 *
 * 只在路径确实含 `.`/`..` 段时重建，其余情况原样返回（保留调用方原有的分隔符混用写法）。
 * 相对路径开头无法回退的 `..` 会被保留（`../a/../../b` → `../../b`），
 * 绝对路径根之上的 `..` 直接丢弃（`/../a` → `/a`），`~` 缩写不被展开。
 */
export function normalizeFilePathSegments(filePath: string): string {
  if (!filePath || !hasDotSegments(filePath)) return filePath

  const { root, rest, separator } = splitPathRoot(filePath)
  const segments: string[] = []
  for (const segment of rest.split(SEPARATOR_PATTERN)) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (segments.length > 0 && segments[segments.length - 1] !== '..') {
        segments.pop()
      } else if (!root) {
        segments.push('..')
      }
      continue
    }
    segments.push(segment)
  }
  return joinPathRoot(root, segments.join(separator), separator)
}

/**
 * 相对路径基于候选 base 目录解析为绝对路径（全 renderer 层唯一实现，R4 统一收敛）。
 *
 * 与主进程 resolveTargetPath 的候选 base 语义一致：
 * 优先匹配「首段与 base 目录名相同」的候选（如 base `C:/ws/profer` + 相对路径 `profer/src/a.md`
 * → `C:/ws/profer/src/a.md`，避免多套一层目录），再退化到第一个候选；无候选或无法匹配时返回原路径
 * （保持相对，由主进程继续兜底解析）。
 *
 * 拼接结果会折叠 `.`/`..` 段：Agent 常写 `../兄弟文件.txt`（文件在会话工作目录的上一级），
 * 不折叠就会把 `C:\ws\<会话目录>/../兄弟文件.txt` 这种半截路径直接显示并复制给用户。
 */
export function resolveRelativeToAbsolute(cleanPath: string, candidateBases: string[]): string {
  if (candidateBases.length === 0) return cleanPath

  // 相对路径在消息中可能使用 Windows 反斜杠；统一为正斜杠后再按目录段匹配，
  // 使 src\\main.ts 与 src/main.ts 在预览解析时落到同一文件。
  const relativePath = cleanPath.replace(/\\/g, '/')
  const firstSegment = relativePath.split('/')[0]
  if (firstSegment) {
    for (const base of candidateBases) {
      const normalizedBase = base.replace(/[\\/]+$/, '')
      const baseName = getFileBaseName(normalizedBase)
      if (baseName === firstSegment) {
        const parentDir = getFileParentPath(normalizedBase)
        return normalizeFilePathSegments(parentDir ? `${parentDir}/${relativePath}` : relativePath)
      }
    }
  }
  const base = candidateBases[0]!.replace(/[\\/]+$/, '')
  return normalizeFilePathSegments(`${base}/${relativePath}`)
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

/** 判断附件数据是否异常缺失；0 字节文件本来就对应空字符串。 */
export function isMissingAttachmentData(size: number, data: string | undefined): boolean {
  return size > 0 && !data
}
