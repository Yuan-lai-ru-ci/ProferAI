import type { FileAccessOptions } from '@profer/shared'
import type { PreviewFile } from '@/atoms/preview-atoms'
import { isAbsoluteFilePath } from '@/lib/file-utils'

// 绝对路径判定统一走 renderer/lib 公共实现（R2），此处仅转发以保持既有导入路径兼容
export { isAbsoluteFilePath }

function normalizeWindowsDrivePath(filePath: string): string {
  // 默认应用 IPC 必须用可 realpath 的单一 Windows 路径格式；
  // 对话链接和历史状态可能混用 C:/Users\\name\\...，统一为 C:/Users/name/...。
  if (!/^[A-Za-z]:[\\/]/.test(filePath)) return filePath
  const normalized = filePath
    .replace(/\\/g, '/')
    .replace(/^([A-Za-z]:)\/+/, '$1/')
  // Markdown/file URL 在某些路径中会吞掉 `\\.`，把 `yuan.profer-dev`
  // 还原为用户目录下的隐藏配置目录 `yuan/.profer-dev`。
  return normalized.replace(
    /^([A-Za-z]:\/Users\/[^/]+)\.(profer(?:-dev)?|proma(?:-dev)?)(?=\/|$)/i,
    '$1/.$2',
  )
}

function joinFilePath(basePath: string, filePath: string): string {
  const base = basePath.replace(/[\\/]+$/, '')
  const child = filePath.replace(/^[\\/]+/, '')
  return normalizeWindowsDrivePath(`${base}/${child}`)
}

function uniqueTruthyPaths(paths: Array<string | null | undefined>): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const path of paths) {
    if (!path || seen.has(path)) continue
    seen.add(path)
    result.push(path)
  }
  return result
}

/**
 * 相对路径预览必须携带会话工作目录；历史工具调用通常只持久化了 filePath。
 * 合并调用方已有候选目录和上下文目录，使 .context/plan/*.md 等路径能稳定解析。
 */
export function getPreviewCandidateBasePaths(
  basePaths: readonly string[] | undefined,
  ...contextPaths: Array<string | null | undefined>
): string[] {
  return uniqueTruthyPaths([...(basePaths ?? []), ...contextPaths].map((path) => path ? normalizeWindowsDrivePath(path) : path))
}

/**
 * Diff 服务需要相对 git 路径；系统默认 App 打开文件则必须使用实际文件路径。
 */
export function getDefaultAppTargetPath(file: PreviewFile, sessionPath: string): string {
  if (isAbsoluteFilePath(file.filePath)) return normalizeWindowsDrivePath(file.filePath)

  const basePath = file.previewOnly
    ? (file.basePaths?.[0] ?? file.dirPath ?? sessionPath)
    : (file.gitRoot ?? file.dirPath ?? sessionPath)

  return basePath ? joinFilePath(basePath, file.filePath) : file.filePath
}

export function getPreviewFileAccess(
  sessionId: string,
  file: PreviewFile,
  sessionPath: string,
): FileAccessOptions {
  return {
    sessionId,
    candidateBasePaths: getPreviewCandidateBasePaths(
      file.basePaths,
      file.gitRoot,
      file.dirPath,
      sessionPath,
    ),
  }
}
