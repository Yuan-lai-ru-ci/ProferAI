import * as React from 'react'
import { useStore } from 'jotai'
import { toast } from 'sonner'
import { ChevronRight, Copy, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { getFileBaseName, isAbsoluteFilePath as isAbsoluteFilePathCore, resolveRelativeToAbsolute } from '@/lib/file-utils'
import { useTabletMode } from './tablet-mode-context'
import { FileTypeIcon } from '@/components/file-browser/FileTypeIcon'
import { useOpenPreview } from '@/components/diff/preview-opener'
import { currentAgentSessionIdAtom } from '@/atoms/agent-atoms'
import { LONG_PRESS_DURATION } from '@/components/agent/ContextUsageBadge'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
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
  const [showRawPath, setShowRawPath] = React.useState(false)
  const [candidates, setCandidates] = React.useState<string[]>([])
  const [selectedPath, setSelectedPath] = React.useState<string>()
  const [searching, setSearching] = React.useState(false)
  const [deepCandidateMenuOpen, setDeepCandidateMenuOpen] = React.useState(false)
  const [deepMenuAnchor, setDeepMenuAnchor] = React.useState<{ x: number; y: number }>()
  const [longPressProgress, setLongPressProgress] = React.useState(0)
  const [longPressDirection, setLongPressDirection] = React.useState<'left' | 'right'>('left')
  const requestIdRef = React.useRef<string>()
  const cancelledRequestsRef = React.useRef(new Set<string>())
  const longPressTimerRef = React.useRef<ReturnType<typeof setTimeout>>()
  const longPressFrameRef = React.useRef<number>()
  const longPressStartedAtRef = React.useRef<number>()
  const longPressButtonRef = React.useRef<0 | 2>()
  const longPressTriggeredRef = React.useRef(false)

  const candidateBases = React.useMemo(() => {
    if (basePaths && basePaths.length > 0) return basePaths.filter(Boolean)
    return basePath ? [basePath] : []
  }, [basePath, basePaths])
  const cacheKey = React.useMemo(
    () => searchCacheKey(store.get(currentAgentSessionIdAtom) ?? undefined, cleanPath, candidateBases),
    [candidateBases, cleanPath, store],
  )
  const displayPath = selectedPath ?? (isAbsolute ? cleanPath : resolveRelativeToAbsolute(cleanPath, candidateBases))

  React.useEffect(() => {
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
    if (candidates.length === 0) return
    fileSearchCache.set(cacheKey, {
      candidates,
      selectedPath,
      expiresAt: Date.now() + FILE_SEARCH_CACHE_TTL_MS,
    })
  }, [cacheKey, candidates, selectedPath])

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
        if (mode === 'deep') setDeepCandidateMenuOpen(true)
        if (!openOnFound) toast.info('没有更多同名文件')
        return
      }
      setCandidates((current) => [...current, ...newPaths])
      const previewPath = selectedPath ?? newPaths[0]!
      if (!selectedPath) setSelectedPath(previewPath)
      setFileStatus('resolved')
      if (mode === 'deep') setDeepCandidateMenuOpen(true)
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
  }, [candidates, filename, openPreviewPath, searching, store])

  const cancelSearch = React.useCallback(() => {
    const requestId = requestIdRef.current
    if (!requestId) return
    cancelledRequestsRef.current.add(requestId)
    requestIdRef.current = undefined
    setSearching(false)
    void window.electronAPI.cancelFileSearch(requestId)
  }, [])

  React.useEffect(() => () => {
    if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current)
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

  const clearLongPress = React.useCallback(() => {
    if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current)
    longPressTimerRef.current = undefined
    if (longPressFrameRef.current !== undefined) cancelAnimationFrame(longPressFrameRef.current)
    longPressFrameRef.current = undefined
    longPressStartedAtRef.current = undefined
    longPressButtonRef.current = undefined
    setLongPressProgress(0)
  }, [])

  const handleChipPointerDown = React.useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    if ((event.button !== 0 && event.button !== 2) || searching) return
    longPressTriggeredRef.current = false
    longPressButtonRef.current = event.button
    setLongPressDirection(event.button === 0 ? 'left' : 'right')
    const duration = Math.round(LONG_PRESS_DURATION * 0.65)
    if (event.button === 0) setDeepMenuAnchor({ x: event.clientX + 10, y: event.clientY + 10 })
    const startedAt = performance.now()
    longPressStartedAtRef.current = startedAt
    const updateProgress = (now: number): void => {
      if (longPressStartedAtRef.current !== startedAt || longPressTriggeredRef.current) return
      const progress = Math.min(1, (now - startedAt) / duration)
      setLongPressProgress(progress)
      if (progress < 1) longPressFrameRef.current = requestAnimationFrame(updateProgress)
    }
    longPressFrameRef.current = requestAnimationFrame(updateProgress)
    longPressTimerRef.current = setTimeout(() => {
      const button = longPressButtonRef.current
      longPressTriggeredRef.current = true
      clearLongPress()
      longPressTriggeredRef.current = true
      if (button === 0) void startSearch('deep', false)
      if (button === 2) setShowRawPath((current) => !current)
    }, duration)
  }, [clearLongPress, copyDisplayPath, searching, startSearch])

  const handleChipClick = React.useCallback(() => {
    if (longPressTriggeredRef.current) {
      longPressTriggeredRef.current = false
      return
    }

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
    const previewPath = selectedPath ?? cachedPath
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
    if (longPressTriggeredRef.current) {
      longPressTriggeredRef.current = false
      return
    }
    // 右键短按复制完整路径；右键长按才切换显示模式。
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
    showRawPath ? 'border-border/70 bg-muted/30 text-foreground/80' : fileStatus === 'broken' ? 'border-dashed border-muted-foreground/30 text-muted-foreground' : fileStatus === 'pending' ? 'border-border/50 bg-muted/40 text-muted-foreground' : 'border-primary/20 bg-primary/10 text-primary',
    className,
  )
  const chipProgressStyle = longPressProgress > 0 ? {
    backgroundImage: `linear-gradient(${longPressDirection === 'left' ? 90 : 270}deg, hsl(var(--primary) / 0.24) ${longPressProgress * 100}%, transparent ${longPressProgress * 100}%)`,
  } : undefined

  return (
    <span className={chipClassName} style={chipProgressStyle}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={handleChipClick}
            onContextMenu={handleChipContextMenu}
            onPointerDown={handleChipPointerDown}
            onPointerUp={clearLongPress}
            onPointerCancel={clearLongPress}
            onPointerLeave={clearLongPress}
            className="relative z-[1] inline-flex min-w-0 max-w-full items-center gap-1 bg-transparent p-0 text-inherit outline-none"
          >
            {showRawPath ? <span className="whitespace-normal break-all">{displayPath}{lineColSuffix}</span> : <><FileTypeIcon name={filename} isDirectory={false} size={14} /><span className="truncate">{filename}{lineColSuffix}</span></>}
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
          <p className="mt-1 text-tooltip-muted">左键搜索并预览 左键长按深度搜索 右键复制路径 右键长按切换显示</p>
        </TooltipContent>
      </Tooltip>
      {searching && <Loader2 className="relative z-[1] size-3.5 shrink-0 animate-spin text-muted-foreground" />}
      <Popover open={deepCandidateMenuOpen} onOpenChange={setDeepCandidateMenuOpen}>
        <PopoverAnchor asChild>
          <span
            aria-hidden="true"
            className="pointer-events-none fixed size-px"
            style={{ left: deepMenuAnchor?.x ?? 0, top: deepMenuAnchor?.y ?? 0 }}
          />
        </PopoverAnchor>
        <PopoverContent side="bottom" align="start" sideOffset={8} className="w-auto max-w-[min(520px,calc(100vw-32px))] p-1">
          {candidates.length === 0 ? <p className="px-2 py-1.5 text-xs text-muted-foreground">暂无已找到的候选</p> : candidates.map((path) => (
            <button
              key={normalizeCandidatePath(path)}
              type="button"
              onClick={() => { setSelectedPath(path); setFileStatus('resolved'); setDeepCandidateMenuOpen(false) }}
              className="flex w-full items-start gap-1 rounded px-2 py-1.5 text-left text-xs hover:bg-accent"
            >
              <ChevronRight className="mt-0.5 size-3 shrink-0" />
              <span className="whitespace-normal break-all">{path}</span>
            </button>
          ))}
        </PopoverContent>
      </Popover>
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
