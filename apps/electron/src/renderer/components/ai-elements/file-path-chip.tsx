import * as React from 'react'
import { useStore } from 'jotai'
import { toast } from 'sonner'
import { Copy, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { getFileBaseName, isAbsoluteFilePath as isAbsoluteFilePathCore, resolveRelativeToAbsolute } from '@/lib/file-utils'
import { useTabletMode } from './tablet-mode-context'
import { FileTypeIcon } from '@/components/file-browser/FileTypeIcon'
import { useOpenPreview } from '@/components/diff/preview-opener'
import { currentAgentSessionIdAtom } from '@/atoms/agent-atoms'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { FileSearchCandidateResult } from '@profer/shared'

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'])
const VIDEO_EXTS = new Set(['mp4', 'webm', 'mov'])
const CODE_EXTS = new Set([
  'md', 'markdown', 'json', 'jsonc', 'json5', 'xml', 'html', 'htm', 'txt', 'log', 'csv',
  'yaml', 'yml', 'toml', 'ini', 'env', 'lock', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
  'py', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cpp', 'hpp', 'cs', 'sh', 'bash',
  'zsh', 'fish', 'css', 'scss', 'less', 'sql', 'rb', 'php', 'diff', 'patch',
])
const DOC_EXTS = new Set(['pdf', 'docx'])
const ALL_PREVIEWABLE_EXTS = new Set([...IMAGE_EXTS, ...VIDEO_EXTS, ...CODE_EXTS, ...DOC_EXTS])

function getExtension(filename: string): string {
  const dot = filename.lastIndexOf('.')
  return dot === -1 ? '' : filename.slice(dot + 1).toLowerCase()
}

function stripLineCol(filePath: string): { path: string; suffix: string } {
  const match = filePath.match(/^(.+?)(:\d+(?::\d+)?)$/)
  if (match && !match[1]!.endsWith(':')) return { path: match[1]!, suffix: match[2]! }
  return { path: filePath, suffix: '' }
}

interface FilePathChipProps {
  filePath: string
  basePath?: string
  basePaths?: string[]
  className?: string
}

function normalizeCandidatePath(filePath: string): string {
  const normalized = filePath.replace(/[\\/]+/g, '\\').replace(/\\+$/, '')
  return /^[A-Za-z]:/.test(normalized) ? normalized.toLowerCase() : normalized
}

interface FileSearchCacheEntry {
  candidates: string[]
  expiresAt: number
  selectedPath?: string
}

const FILE_SEARCH_CACHE_TTL_MS = 5 * 60 * 1000
const fileSearchCache = new Map<string, FileSearchCacheEntry>()

function searchCacheKey(sessionId: string | undefined, filePath: string, bases: string[]): string {
  return `${sessionId ?? ''}\0${filePath}\0${bases.join('\0')}`
}

/** 只有无法由真实工具路径确定位置的相对引用，才需要按文件名搜索候选。 */
export function shouldSearchFileCandidate(isAbsolute: boolean): boolean {
  return !isAbsolute
}

export function FilePathChip({ filePath, basePath, basePaths, className }: FilePathChipProps): React.ReactElement {
  const trimmedPath = filePath.trim()
  const { path: cleanPath, suffix: lineColSuffix } = stripLineCol(trimmedPath)
  const tabletMode = useTabletMode()
  const filename = getFileBaseName(cleanPath)
  const isAbsolute = isAbsoluteFilePathCore(cleanPath)
  const store = useStore()
  const openPreview = useOpenPreview()
  const [fileStatus, setFileStatus] = React.useState<'idle' | 'resolved' | 'pending' | 'broken'>('idle')
  const [candidates, setCandidates] = React.useState<string[]>([])
  const [selectedPath, setSelectedPath] = React.useState<string>()
  /** candidates / selectedPath 当前归属的缓存键，防止组件复用时旧路径状态污染新路径。 */
  const [stateCacheKey, setStateCacheKey] = React.useState<string>()
  const [searching, setSearching] = React.useState(false)
  const requestIdRef = React.useRef<string>()
  const cancelledRequestsRef = React.useRef(new Set<string>())

  const candidateBases = React.useMemo(() => {
    if (basePaths && basePaths.length > 0) return basePaths.filter(Boolean)
    return basePath ? [basePath] : []
  }, [basePath, basePaths])
  const cacheKey = React.useMemo(
    () => searchCacheKey(store.get(currentAgentSessionIdAtom) ?? undefined, cleanPath, candidateBases),
    [candidateBases, cleanPath, store],
  )
  const fallbackDisplayPath = isAbsolute ? cleanPath : resolveRelativeToAbsolute(cleanPath, candidateBases)
  const displayPath = stateCacheKey === cacheKey ? (selectedPath ?? fallbackDisplayPath) : fallbackDisplayPath

  React.useEffect(() => {
    const activeRequestId = requestIdRef.current
    if (activeRequestId) {
      cancelledRequestsRef.current.add(activeRequestId)
      requestIdRef.current = undefined
      void window.electronAPI.cancelFileSearch(activeRequestId)
    }
    setSearching(false)
    setCandidates([])
    setSelectedPath(undefined)
    setStateCacheKey(cacheKey)
    setFileStatus('idle')

    const cached = fileSearchCache.get(cacheKey)
    if (!cached) return
    if (cached.expiresAt <= Date.now()) {
      fileSearchCache.delete(cacheKey)
      return
    }
    setCandidates(cached.candidates)
    setSelectedPath(cached.selectedPath ?? cached.candidates[0])
    setFileStatus(cached.candidates.length > 0 ? 'resolved' : 'idle')
  }, [cacheKey])

  React.useEffect(() => {
    if (stateCacheKey !== cacheKey || candidates.length === 0) return
    fileSearchCache.set(cacheKey, {
      candidates,
      selectedPath,
      expiresAt: Date.now() + FILE_SEARCH_CACHE_TTL_MS,
    })
  }, [cacheKey, candidates, selectedPath, stateCacheKey])

  const openPreviewPath = React.useCallback((path: string) => {
    const sessionId = store.get(currentAgentSessionIdAtom)
    if (!sessionId) {
      void window.electronAPI.systemOpenFile(path)
      return
    }
    openPreview(sessionId, {
      filePath: path,
      previewOnly: true,
      basePaths: candidateBases.length > 0 ? candidateBases : undefined,
    })
  }, [candidateBases, openPreview, store])

  const startSearch = React.useCallback(async (mode: 'simple' | 'deep', openOnFound: boolean): Promise<void> => {
    if (searching) return
    const sessionId = store.get(currentAgentSessionIdAtom)
    if (!sessionId) {
      toast.error('当前没有可用的 Agent 会话')
      return
    }
    const requestId = crypto.randomUUID()
    requestIdRef.current = requestId
    cancelledRequestsRef.current.delete(requestId)
    setSearching(true)
    setFileStatus('pending')
    try {
      const result: FileSearchCandidateResult = await window.electronAPI.searchFileCandidate({
        requestId,
        sessionId,
        targetName: filename,
        ...(isAbsolute ? { targetPath: cleanPath } : {}),
        mode,
        alreadyFound: candidates,
      })
      if (requestIdRef.current !== requestId || cancelledRequestsRef.current.has(requestId)) return
      const foundPaths = (mode === 'deep'
        ? (result.candidates ?? []).map((candidate) => candidate.path)
        : result.candidate ? [result.candidate.path] : [])
      const existingKeys = new Set(candidates.map(normalizeCandidatePath))
      const newPaths = foundPaths.filter((path) => {
        const key = normalizeCandidatePath(path)
        if (existingKeys.has(key)) return false
        existingKeys.add(key)
        return true
      })
      if (newPaths.length === 0) {
        // 已有候选时只是“没有更多同名文件”，不能把当前仍可预览的 chip 标成不存在。
        if (candidates.length === 0) {
          setFileStatus('broken')
          if (openOnFound) toast.error(`未找到文件：${filename}`)
        } else {
          setFileStatus('resolved')
        }
        if (!openOnFound) toast.info('没有更多同名文件')
        return
      }
      setCandidates((current) => [...current, ...newPaths])
      const previewPath = selectedPath ?? newPaths[0]!
      if (!selectedPath) setSelectedPath(previewPath)
      setFileStatus('resolved')
      if (openOnFound) openPreviewPath(previewPath)
    } catch (error) {
      if (requestIdRef.current !== requestId || cancelledRequestsRef.current.has(requestId)) return
      setFileStatus('broken')
      toast.error(error instanceof Error ? error.message : `搜索文件失败：${filename}`)
    } finally {
      if (requestIdRef.current === requestId) {
        requestIdRef.current = undefined
        setSearching(false)
      }
    }
  }, [candidates, cleanPath, filename, isAbsolute, openPreviewPath, searching, store])

  const cancelSearch = React.useCallback(() => {
    const requestId = requestIdRef.current
    if (!requestId) return
    cancelledRequestsRef.current.add(requestId)
    requestIdRef.current = undefined
    setSearching(false)
    void window.electronAPI.cancelFileSearch(requestId)
  }, [])

  React.useEffect(() => () => {
    const requestId = requestIdRef.current
    if (requestId) {
      cancelledRequestsRef.current.add(requestId)
      void window.electronAPI.cancelFileSearch(requestId)
    }
  }, [])

  const copyDisplayPath = React.useCallback(() => {
    void navigator.clipboard.writeText(displayPath)
      .then(() => toast.success('完整路径已复制'))
      .catch(() => toast.error('复制路径失败'))
  }, [displayPath])

  const handleChipClick = React.useCallback(() => {
    // 工具调用和本轮文件名映射已提供绝对路径时，它就是唯一可靠的预览目标。
    // 不能先按文件名做浅层候选搜索：深层源码常超出浅搜深度，且同名文件会被错误选中。
    // 相对路径仍沿用候选搜索，保留“Agent 只提到裸文件名”时的按需定位能力。
    if (!shouldSearchFileCandidate(isAbsolute)) {
      openPreviewPath(cleanPath)
      return
    }

    // 优先同步读取缓存，避免从预览返回后的水合间隙误触发一次搜索。
    const cached = fileSearchCache.get(cacheKey)
    const cachedPath = cached && cached.expiresAt > Date.now()
      ? (cached.selectedPath ?? cached.candidates[0])
      : undefined
    const previewPath = stateCacheKey === cacheKey ? (selectedPath ?? cachedPath) : cachedPath
    if (previewPath) {
      if (!selectedPath) setSelectedPath(previewPath)
      openPreviewPath(previewPath)
      return
    }
    // 每次短按都搜索一个尚未发现的候选，并在命中后直接预览。
    void startSearch('simple', true)
  }, [cacheKey, cleanPath, isAbsolute, openPreviewPath, selectedPath, startSearch])

  const handleChipContextMenu = React.useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    // 右键复制完整路径。
    copyDisplayPath()
  }, [copyDisplayPath])

  if (tabletMode) {
    return (
      <span title={displayPath} className={cn('inline-flex items-center gap-1 rounded px-1.5 py-[2px] text-[12px] font-medium leading-[1.6] align-baseline not-prose', fileStatus === 'broken' ? 'opacity-50 border border-dashed border-muted-foreground/30 text-muted-foreground' : 'bg-primary/10 text-primary', className)}>
        <FileTypeIcon name={filename} isDirectory={false} size={14} />
        <span className="truncate max-w-[240px]">{filename}{lineColSuffix}</span>
      </span>
    )
  }

  const chipClassName = cn(
    'relative inline-flex max-w-full items-center gap-1 overflow-hidden rounded border px-1.5 py-[2px] text-[12px] font-medium leading-[1.6] align-baseline not-prose',
    fileStatus === 'broken' ? 'border-dashed border-muted-foreground/30 text-muted-foreground' : fileStatus === 'pending' ? 'border-border/50 bg-muted/40 text-muted-foreground' : 'border-primary/20 bg-primary/10 text-primary',
    className,
  )
  return (
    <span className={chipClassName}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={handleChipClick}
            onContextMenu={handleChipContextMenu}
            className="relative z-[1] inline-flex min-w-0 max-w-full items-center gap-1 bg-transparent p-0 text-inherit outline-none"
          >
            <FileTypeIcon name={filename} isDirectory={false} size={14} />
            <span className="truncate">{filename}{lineColSuffix}</span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" align="center" sideOffset={10} className="max-w-[min(520px,calc(100vw-32px))] p-2">
          <div className="flex items-start gap-2">
            <span className="whitespace-normal break-all leading-relaxed">{displayPath}</span>
            <button
              type="button"
              aria-label="复制完整路径"
              onClick={copyDisplayPath}
              className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded hover:bg-white/15"
            >
              <Copy className="size-3.5" />
            </button>
          </div>
          <p className="mt-1 text-tooltip-muted">左键搜索并预览 右键复制路径</p>
        </TooltipContent>
      </Tooltip>
      {searching && <Loader2 className="relative z-[1] size-3.5 shrink-0 animate-spin text-muted-foreground" />}
    </span>
  )
}

export function isAbsoluteFilePath(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length < 2) return false
  const { path: clean } = stripLineCol(trimmed)
  if (!isAbsoluteFilePathCore(clean)) return false
  if (clean.startsWith('/')) {
    if (!/^\/[^\n]+(?:\/[^\n]+)*$/.test(clean)) return false
    if (clean.endsWith('/') && !clean.includes('.')) return false
  }
  return true
}

export function isRelativeFilePath(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length < 3) return false
  const { path: clean } = stripLineCol(trimmed)
  const ext = getExtension(clean)
  if (!ext || !ALL_PREVIEWABLE_EXTS.has(ext)) return false
  const hasPathSeparator = /[\\/]/.test(clean)
  const pathPattern = hasPathSeparator ? /^[\w./@\\\p{L}\p{M} -]+$/u : /^[\w./@\\\p{L}\p{M}-]+$/u
  if (!pathPattern.test(clean) || clean.startsWith(' ') || clean.endsWith(' ')) return false
  if (clean.startsWith('.') && !clean.startsWith('./') && !clean.includes('/') && !clean.includes('\\')) return false
  return true
}
