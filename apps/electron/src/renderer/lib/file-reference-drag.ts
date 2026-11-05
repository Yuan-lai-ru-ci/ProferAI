/**
 * 右侧文件面板（会话文件 / 工作区文件 / 变更列表）拖入输入框时使用的内部拖放协议。
 *
 * 与会话引用（session-reference-drag）保持同一套模式：
 * - 自定义 MIME 用于可靠识别来源，避免和外部文件拖放（dataTransfer.files）混淆；
 * - text/plain 仅作为拖到其它宿主时的路径兜底；
 * - 载荷统一用绝对路径，插入 @ 引用时再按会话根换算成相对路径。
 */

export const FILE_REFERENCE_DRAG_MIME = 'application/x-profer-file-reference'

/** 单次拖拽最多携带的条目数，防止误拖整个大目录时生成过长的载荷 */
const MAX_DRAG_ITEMS = 100

export interface FileReferenceDragItem {
  /** 绝对路径（来源面板统一给出完整路径） */
  path: string
  /** 展示名（文件名 / 目录名） */
  name: string
  isDirectory?: boolean
}

/** 拖拽开始时写入载荷；重复路径按首次出现去重。 */
export function setFileReferenceDragData(
  dataTransfer: DataTransfer,
  items: readonly FileReferenceDragItem[],
): void {
  const normalized = normalizeDragItems(items)
  if (normalized.length === 0) return

  dataTransfer.setData(FILE_REFERENCE_DRAG_MIME, JSON.stringify(normalized))
  dataTransfer.setData('text/plain', normalized.map((item) => item.path).join('\n'))
  dataTransfer.effectAllowed = 'copy'
}

export function isFileReferenceDrag(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes(FILE_REFERENCE_DRAG_MIME)
}

/** 读取拖拽载荷；非本协议或载荷损坏时返回 null，让调用方回退到文件拖放分支。 */
export function getFileReferenceDragData(
  dataTransfer: DataTransfer,
): FileReferenceDragItem[] | null {
  const raw = dataTransfer.getData(FILE_REFERENCE_DRAG_MIME)
  if (!raw) return null

  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return null
    const items = parsed.filter(isFileReferenceDragItem)
    return items.length > 0 ? normalizeDragItems(items) : null
  } catch {
    return null
  }
}

/**
 * 把绝对路径换算成插入 @ 引用用的路径。
 *
 * 与会话内 `@` 文件检索的语义保持一致：会话根（工作区）内的文件用相对路径，
 * 附加目录等根外路径保留绝对路径；分隔符统一成 `/`，避免 Windows 反斜杠
 * 在 mention 文本里被当成转义或断词。
 */
export function toFileReferenceMentionPath(
  absolutePath: string,
  workspacePath?: string | null,
): string {
  if (!workspacePath) return absolutePath

  const normalizedPath = absolutePath.replace(/\\/g, '/')
  const normalizedRoot = workspacePath.replace(/\\/g, '/').replace(/\/+$/, '')
  if (!normalizedRoot) return absolutePath
  if (normalizedPath.toLowerCase() === normalizedRoot.toLowerCase()) return absolutePath
  if (!normalizedPath.toLowerCase().startsWith(`${normalizedRoot.toLowerCase()}/`)) {
    return normalizedPath
  }
  return normalizedPath.slice(normalizedRoot.length + 1)
}

/** 把拖拽载荷转成输入框要插入的 @ 引用条目（相对路径 + 去重）。 */
export function toFileReferenceMentions(
  items: readonly FileReferenceDragItem[],
  workspacePath?: string | null,
): FileReferenceDragItem[] {
  return normalizeDragItems(items.map((item) => ({
    ...item,
    path: toFileReferenceMentionPath(item.path, workspacePath),
  })))
}

function normalizeDragItems(items: readonly FileReferenceDragItem[]): FileReferenceDragItem[] {
  const seen = new Set<string>()
  const result: FileReferenceDragItem[] = []
  for (const item of items) {
    const path = item.path?.trim()
    if (!path || seen.has(path)) continue
    seen.add(path)
    result.push({
      path,
      name: item.name?.trim() || path.split(/[\\/]/).pop() || path,
      ...(item.isDirectory ? { isDirectory: true } : {}),
    })
    if (result.length >= MAX_DRAG_ITEMS) break
  }
  return result
}

function isFileReferenceDragItem(item: unknown): item is FileReferenceDragItem {
  if (!item || typeof item !== 'object') return false
  const candidate = item as Partial<FileReferenceDragItem>
  return typeof candidate.path === 'string' && candidate.path.trim().length > 0
}
