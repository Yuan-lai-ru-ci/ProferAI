/**
 * FilePathChip — 文件路径可点击芯片
 *
 * 在 Agent 消息中检测到文件路径时，渲染为可点击的芯片。
 * 支持绝对路径和相对路径（相对于 basePath 解析）。
 * 点击后按用户偏好（标签页 / 侧边分屏）打开文件预览。
 */

import * as React from 'react'
import { useStore } from 'jotai'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { getFileBaseName, isAbsoluteFilePath as isAbsoluteFilePathCore, resolveRelativeToAbsolute } from '@/lib/file-utils'
import { useTabletMode } from './tablet-mode-context'
import { FileTypeIcon } from '@/components/file-browser/FileTypeIcon'
import { useOpenPreview } from '@/components/diff/preview-opener'
import { currentAgentSessionIdAtom } from '@/atoms/agent-atoms'
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from '@/components/ui/context-menu'

/** 文件存在性缓存（模块级共享，避免重复 IPC）。key = filePath + basePaths */
const fileExistsCache = new Map<string, boolean>()
/** 缓存最大条目数，防止长会话内存无限增长 */
const MAX_CACHE_SIZE = 500
function existsCacheKey(filePath: string, bases: string[]): string {
  return `${filePath}\0${bases.join('\0')}`
}
/** 写入缓存，超限时删除最旧条目 */
function cacheSet(key: string, value: boolean): void {
  if (fileExistsCache.size >= MAX_CACHE_SIZE) {
    const firstKey = fileExistsCache.keys().next().value
    if (firstKey !== undefined) fileExistsCache.delete(firstKey)
  }
  fileExistsCache.set(key, value)
}

/** 图片扩展名 */
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'])
/** 视频扩展名 */
const VIDEO_EXTS = new Set(['mp4', 'webm', 'mov'])
/**
 * 代码/结构化文本扩展名
 * 需与主进程 file-preview-service.ts 的 CODE_EXTENSIONS + MARKDOWN_EXTENSIONS 保持一致，
 * 否则消息中的相对路径无法被识别为可点击 chip。
 */
const CODE_EXTS = new Set([
  'md', 'markdown',
  'json', 'jsonc', 'json5',
  'xml', 'html', 'htm',
  'txt', 'log', 'csv',
  'yaml', 'yml', 'toml', 'ini', 'env', 'lock',
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
  'py', 'go', 'rs', 'java', 'kt', 'swift',
  'c', 'h', 'cpp', 'hpp', 'cs',
  'sh', 'bash', 'zsh', 'fish',
  'css', 'scss', 'less',
  'sql', 'rb', 'php',
  'diff', 'patch',
])
/** 文档扩展名 */
const DOC_EXTS = new Set(['pdf', 'docx'])

/** 所有可预览的扩展名集合（用于相对路径检测） */
const ALL_PREVIEWABLE_EXTS = new Set([...IMAGE_EXTS, ...VIDEO_EXTS, ...CODE_EXTS, ...DOC_EXTS])

/** 从文件名提取扩展名（小写，不含点） */
function getExtension(filename: string): string {
  const dot = filename.lastIndexOf('.')
  if (dot === -1) return ''
  return filename.slice(dot + 1).toLowerCase()
}

/**
 * 从路径中剥离末尾的行号/列号后缀（如 :42 或 :42:15）
 * Agent 模式下模型常输出 file_path:line_number 格式
 */
function stripLineCol(filePath: string): { path: string; suffix: string } {
  const m = filePath.match(/^(.+?)(:\d+(?::\d+)?)$/)
  if (m && !m[1]!.endsWith(':')) {
    return { path: m[1]!, suffix: m[2]! }
  }
  return { path: filePath, suffix: '' }
}

interface FilePathChipProps {
  /** 文件路径（绝对或相对，可能带行号后缀） */
  filePath: string
  /** 基础目录路径（向后兼容，单值） */
  basePath?: string
  /** 多个候选基础目录（如主 cwd + 附加目录），点击时由主进程依次解析 */
  basePaths?: string[]
  className?: string
}

/** 文件路径芯片 — 可点击，触发文件预览 */
export function FilePathChip({ filePath, basePath, basePaths, className }: FilePathChipProps): React.ReactElement {
  const trimmedPath = filePath.trim()
  const { path: cleanPath, suffix: lineColSuffix } = stripLineCol(trimmedPath)
  // 平板远程模式：预览面板/文件管理器均依赖桌面能力（MainArea 渲染 / Electron IPC），
  // 点击与右键菜单入口应诚实隐藏，仅保留路径展示
  const tabletMode = useTabletMode()

  const filename = getFileBaseName(cleanPath)

  const isAbsolute = isAbsoluteFilePathCore(cleanPath)

  const chipRef = React.useRef<HTMLButtonElement>(null)
  const [fileStatus, setFileStatus] = React.useState<'idle' | 'resolved' | 'pending' | 'broken'>('idle')
  const store = useStore()
  const openPreview = useOpenPreview()

  // 候选基础目录列表：优先使用 basePaths；否则退化到 basePath 单值
  const candidateBases = React.useMemo<string[]>(() => {
    if (basePaths && basePaths.length > 0) return basePaths.filter(Boolean)
    if (basePath) return [basePath]
    return []
  }, [basePath, basePaths])

  // 用于 title 提示：绝对路径直接展示（含行号后缀）；相对路径优先匹配首段对应的 base 目录
  const displayPath = React.useMemo(() => {
    if (isAbsolute) return trimmedPath
    return resolveRelativeToAbsolute(cleanPath, candidateBases)
  }, [trimmedPath, cleanPath, isAbsolute, candidateBases])

  // 预览/复制用的完整路径：绝对路径剥离行号后缀后直接使用；相对路径基于候选 base 目录解析。
  // 修复：打开预览传原始相对路径时，预览顶部与复制只会得到文件名（Windows 反斜杠下 split('/') 失效）。
  const previewFilePath = React.useMemo(() => {
    if (isAbsolute) return cleanPath
    return resolveRelativeToAbsolute(cleanPath, candidateBases)
  }, [cleanPath, isAbsolute, candidateBases])

  // IntersectionObserver 懒检查文件是否存在
  React.useEffect(() => {
    const el = chipRef.current
    if (!el) return

    const key = existsCacheKey(cleanPath, candidateBases)
    if (fileExistsCache.has(key)) {
      setFileStatus(fileExistsCache.get(key) ? 'resolved' : 'broken')
      return
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting) return
        observer.disconnect()
        const sessionId = store.get(currentAgentSessionIdAtom)

        // 绝对路径：不传 options，允许访问任意位置（如 Desktop、Documents 等）
        // 相对路径：传 sessionId 和 candidateBasePaths，限制在授权目录内
        // 预检模式（preflight: true）：主进程只做快速查找、跳过全局递归搜索，避免批量预检阻塞主进程
        const accessOptions = isAbsolute
          ? { sessionId: sessionId ?? undefined, preflight: true }
          : { sessionId: sessionId ?? undefined, candidateBasePaths: candidateBases.length > 0 ? candidateBases : undefined, preflight: true }

        window.electronAPI.resolveFilePath(cleanPath, accessOptions)
          .then((resolved) => {
            if (resolved) {
              cacheSet(key, true)
              setFileStatus('resolved')
            } else {
              // 预检快速未命中：可能只是没触发全局搜索，不能误判为「不存在」，标记为「待查找」
              setFileStatus('pending')
            }
          })
          .catch(() => { /* IPC 失败不标记 */ })
      },
      { threshold: 0 },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [cleanPath, candidateBases, isAbsolute, store])

  const handleClick = React.useCallback(() => {
    const sessionId = store.get(currentAgentSessionIdAtom)
    if (sessionId) {
      // 用户主动点击：做一次完整解析（允许全局搜索，单次可接受），解析成功才打开预览
      window.electronAPI.resolveFilePath(previewFilePath, { sessionId })
        .then((resolved) => {
          if (resolved) {
            openPreview(sessionId, {
              filePath: previewFilePath,
              previewOnly: true,
              basePaths: candidateBases.length > 0 ? candidateBases : undefined,
            })
          } else {
            // 完整查找仍失败 → 才标记「不存在」（虚线样式）
            setFileStatus('broken')
            toast.error(`未找到文件：${filename}`)
          }
        })
        .catch(() => toast.error(`未找到文件：${filename}`))
    } else {
      // 无 session 时直接调用系统默认程序打开
      window.electronAPI.systemOpenFile(previewFilePath).catch(() => {})
    }
  }, [store, openPreview, previewFilePath, candidateBases, filename])

  const handleShowInFolder = React.useCallback(() => {
    const bases = candidateBases.length > 0 ? candidateBases : undefined
    window.electronAPI.showItemInFolder(cleanPath, bases)
      .then((opened) => { if (!opened) toast.error(`未找到文件：${filename}`) })
      .catch(() => toast.error(`未找到文件：${filename}`))
  }, [cleanPath, candidateBases, filename])

  // 平板模式：静态展示（不可点击、无右键菜单），保留文件名与文件类型图标
  if (tabletMode) {
    return (
      <span
        title={displayPath}
        className={cn(
          'inline-flex items-center gap-1 rounded px-1.5 py-[2px] text-[12px] font-medium leading-[1.6]',
          'align-baseline not-prose',
          fileStatus === 'broken'
            ? 'opacity-50 border border-dashed border-muted-foreground/30 text-muted-foreground'
            : fileStatus === 'pending'
              ? 'bg-muted/40 text-muted-foreground'
              : 'bg-primary/10 text-primary',
          className
        )}
      >
        <FileTypeIcon name={filename} isDirectory={false} size={14} />
        <span className="truncate max-w-[240px]">{filename}{lineColSuffix}</span>
      </span>
    )
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          ref={chipRef}
          type="button"
          onClick={handleClick}
          title={fileStatus === 'broken' ? `文件不存在: ${displayPath}` : fileStatus === 'pending' ? '待确认，点击查找' : displayPath}
          className={cn(
            'inline-flex items-center gap-1 rounded px-1.5 py-[2px] text-[12px] font-medium leading-[1.6]',
            'cursor-pointer transition-colors duration-150',
            'align-baseline not-prose',
            fileStatus === 'broken'
              ? 'opacity-50 border border-dashed border-muted-foreground/30 text-muted-foreground hover:opacity-70 hover:bg-muted/20'
              : fileStatus === 'pending'
                ? 'bg-muted/40 text-muted-foreground hover:bg-muted/60'
                : 'bg-primary/10 text-primary hover:bg-primary/20',
            className
          )}
        >
          <FileTypeIcon name={filename} isDirectory={false} size={14} />
          <span className="truncate max-w-[240px]">{filename}{lineColSuffix}</span>
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        <ContextMenuItem onClick={handleClick}>
          打开预览
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={handleShowInFolder}>
          在文件管理器中显示
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

/**
 * 检测文本是否为绝对文件路径
 *
 * 匹配规则：
 * - macOS/Linux: 以 / 开头，至少两级路径
 * - Windows: 以 C:\ 等盘符开头
 */
export function isAbsoluteFilePath(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length < 2) return false

  // 剥离末尾行号后缀再检测
  const { path: clean } = stripLineCol(trimmed)

  // 公共前缀判定（盘符 / UNC / 根斜杠）统一走 renderer/lib 唯一实现（R2 收敛）
  if (!isAbsoluteFilePathCore(clean)) return false

  // 保守校验（消息文本检测专用）：根斜杠路径需至少两级，
  // 且排除「尾部斜杠且无扩展名」的目录/正则模式（如 /regex/）
  if (clean.startsWith('/')) {
    if (!/^\/[^\n]+(?:\/[^\n]+)*$/.test(clean)) return false
    if (clean.endsWith('/') && !clean.includes('.')) return false
  }

  return true
}

/**
 * 检测文本是否为相对文件路径（需要 basePath 才有意义）
 *
 * 匹配规则：
 * - 含有可预览的文件扩展名
 * - 看起来像文件名或相对路径（不含空格、不含特殊字符）
 * - 排除常见的非路径 inline code（如命令、变量名等）
 */
export function isRelativeFilePath(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length < 3) return false

  // 剥离末尾行号后缀再检测
  const { path: clean } = stripLineCol(trimmed)

  // 提取扩展名
  const ext = getExtension(clean)
  if (!ext || !ALL_PREVIEWABLE_EXTS.has(ext)) return false

  // 必须看起来像文件路径：允许 字母数字（含中文等 Unicode 字母）、点、横线、下划线、斜杠
  // \w 只匹配 ASCII，需补 \p{L}（任意语言字母）+ \p{M}（组合标记）才不误排中文文件名
  // 排除含空格或特殊字符（含中文标点）的（太可能是其他内容）
  if (!/^[\w./@\p{L}\p{M}-]+$/u.test(clean)) return false

  // 排除以点开头的隐藏文件（如 .gitignore），但保留含子路径的目录相对路径（如 .context/file.md）
  if (clean.startsWith('.') && !clean.startsWith('./') && !clean.includes('/')) return false

  return true
}
