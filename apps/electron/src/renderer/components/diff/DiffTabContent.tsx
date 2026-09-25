/**
 * DiffTabContent — 单文件 Diff 或纯文件预览内容
 *
 * previewOnly=true 时：代码高亮预览（@pierre/diffs File）或 Markdown 渲染
 * previewOnly=false（默认）：显示 git diff（旧版本 vs 磁盘）
 */

import * as React from 'react'
import { ChevronRight, Code2, Copy, Check, Eye, List, Pencil, RefreshCw, Save, X, FileQuestion } from 'lucide-react'
import { useAtom, useAtomValue, useSetAtom, useStore } from 'jotai'
import DOMPurify from 'dompurify'
import { File as PierreFile } from '@pierre/diffs/react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { agentDiffViewModeAtom, agentDiffRefreshVersionAtom, agentSessionsAtom, agentSDKMessagesCacheAtom, liveMessagesMapAtom } from '@/atoms/agent-atoms'
import { openExplorationBranchTab } from '@/lib/exploration-tab'
import { resolvedThemeAtom } from '@/atoms/theme'
import { quotedSelectionMapAtom } from '@/atoms/preview-atoms'
import { markdownTocOpenAtom } from '@/atoms/markdown-toc'
import { useShortcut } from '@/hooks/useShortcut'
import { usePreviewQuotedSelection } from '@/hooks/usePreviewQuotedSelection'
import { initShortcutRegistry } from '@/lib/shortcut-registry'
import { getFileBaseName } from '@/lib/file-utils'
import { useSmoothZoom } from '@/hooks/useSmoothZoom'
import { DiffView } from './DiffView'
import { MarkdownRichEditor } from './MarkdownRichEditor'
import { getPreviewCandidateBasePaths, isAbsoluteFilePath } from './preview-open-path'
import { PreviewFindBar } from './PreviewFindBar'
import { PreviewDirectoryView } from './PreviewDirectoryView'
import { MarkdownToc } from './MarkdownToc'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { PIERRE_FILE_CSS } from '@/components/agent/tool-result-renderers/pierre-styles'
import { OfficePreview } from '@/components/file-browser/office-preview/OfficePreview'
import { OfvPreview } from '@/components/file-browser/ofv-preview/OfvPreview'
import { EDITABLE_TEXT_EXTS, IMAGE_PREVIEW_EXTS, UNSUPPORTED_EXTS } from '@/lib/preview-extension-sets'
import { isOfvBackedPath } from '@/lib/ofv-extensions'
import { SelectionActionPopover } from '@/components/selection/SelectionActionPopover'
import type { PreviewSelectionSnapshot } from '@/hooks/usePreviewQuotedSelection'
import { resolveLatestExplorationSourceMessageId } from '@/lib/exploration-session'

const MD_EXTS = new Set(['.md', '.markdown'])
const HTML_EXTS = new Set(['.html', '.htm'])
/** .docx 仍走 silurus WASM：原因见 OFFICE_PREVIEW_EXTS 上方的说明 */
const DOCX_EXTS = new Set(['.docx'])
const PDF_EXTS = new Set(['.pdf'])
/**
 * 仍走 silurus WASM 的 Office 格式：**DOCX 与 PPTX**（xlsx 已交给 Open File Viewer）。
 *
 * - **PPTX**：Agent 的「正式预览」回执挂在**可见的** silurus viewer 上 —— `official-preview-session.ts`
 *   需要 `slideCount` / `scrollToSlide` / 每页 canvas 抓图（`getRenderedPptxSlideCanvas`）+ 空白页检测；
 *   而 OFV 的公开 API 只有 `goToPage` / `command` / `preparePrint`，既没有页数也没有每页 canvas。
 *   换 PPTX 需先补等价的「页数 + 跳页 + 抓图」能力（或改走主进程 capturePage 截图）。
 * - **DOCX**：OFV 的 docx 主路径（docx-preview）**不过 DOMPurify**（其 issue #140，源码 `office.ts:641`），
 *   且它渲染进宿主同源 DOM；在渲染进程里跑就等于把一条注入面带回 app（preload/IPC 可达，需用户点击恶意链接触发）。
 *   等预览面搬到浏览器视图（sandbox + 无 preload）后这条风险归零，那时再换 docx。
 */
const OFFICE_PREVIEW_EXTS = new Set(['.pptx'])
const LEGACY_OFFICE_EXTS = new Set(['.doc', '.xls', '.ppt'])

const FILE_FIND_SHORTCUT_OPTIONS = { exclusive: true }

/**
 * 简易 LRU 缓存：保留最近访问的 N 个 entries。
 * key 设计：
 * - diff 模式：`${sessionId}:diff:${filePath}@v${refreshVersion}:${scope}`
 * - preview 模式：`${sessionId}:preview:${filePath}@v${refreshVersion}:${scope}`
 * refreshVersion 变化时（agent 写文件、git 突变）key 自然变化，
 * 老 entry 不会被命中，最终被 LRU 淘汰；无需主动失效。
 */
type CacheEntry = {
  oldContent: string
  newContent: string
  /** 非文本文件预览数据 */
  pdfSrc?: string
  imageDataUrl?: string
  imagePath?: string
  docxHtml?: string
  officeHtml?: string
  officeText?: string
  /** HTML 预览的目录级 token URL，允许加载同目录相对资源 */
  htmlPreviewUrl?: string
}
const CACHE_MAX = 50
const contentCache = new Map<string, CacheEntry>()

/** 超过此字符数的文本文件将跳过 PierreFile 高亮，直接以纯文本展示，避免大文件卡顿 */
const MAX_PREVIEW_CHARS = 500_000

/** 选中文本最大字符数（与 Bozeman DOM 模式一致） */
const MAX_QUOTED_CHARS = 2000

/** 滚动位置持久化：key = `${sessionId}:${filePath}` */
const scrollPositionCache = new Map<string, { top: number; left: number }>()

function scrollCacheKey(sessionId: string, filePath: string): string {
  return `${sessionId}:${filePath}`
}

/** 获取缓存的滚动位置 */
export function getPreviewScrollPosition(sessionId: string, filePath: string): { top: number; left: number } | undefined {
  return scrollPositionCache.get(scrollCacheKey(sessionId, filePath))
}

/**
 * 清除指定 session 的预览缓存，供 useCloseTab 调用。
 */
export function clearPreviewCacheForSession(sessionId: string): void {
  const prefix = `${sessionId}:`
  for (const key of scrollPositionCache.keys()) {
    if (key.startsWith(prefix)) scrollPositionCache.delete(key)
  }
  for (const key of contentCache.keys()) {
    if (key.startsWith(prefix)) contentCache.delete(key)
  }
}
function cacheGet(key: string): CacheEntry | undefined {
  const v = contentCache.get(key)
  if (!v) return undefined
  // 重新插入到末尾，更新 LRU 位置
  contentCache.delete(key)
  contentCache.set(key, v)
  return v
}
function cacheSet(key: string, value: CacheEntry): void {
  if (contentCache.has(key)) contentCache.delete(key)
  contentCache.set(key, value)
  if (contentCache.size > CACHE_MAX) {
    const oldestKey = contentCache.keys().next().value
    if (oldestKey !== undefined) contentCache.delete(oldestKey)
  }
}

function getExtension(filePath: string): string {
  const dot = filePath.lastIndexOf('.')
  return dot >= 0 ? filePath.slice(dot).toLowerCase() : ''
}

/** 判断选区是否在容器内（穿透 Shadow DOM 边界） */
function isSelectionInside(container: HTMLElement, selection: Selection): boolean {
  if (selection.rangeCount === 0) return false
  const range = selection.getRangeAt(0)
  let node: Node | null = range.commonAncestorContainer
  while (node) {
    if (node === container) return true
    const root = node.getRootNode()
    if (root instanceof ShadowRoot) {
      // Shadow DOM 边界：从 shadowRoot.host 继续向上
      node = root.host
    } else {
      // 普通 DOM：沿 parentNode 向上
      node = node.parentNode
    }
  }
  return false
}

/** 获取容器内的选区：先查光 DOM，再遍历缓存的 ShadowRoot 集合 */
function getDeepSelection(container: HTMLElement, shadowRoots?: Set<ShadowRoot> | null): { text: string } | null {
  const docSel = document.getSelection()
  if (docSel && !docSel.isCollapsed && docSel.rangeCount > 0) {
    if (isSelectionInside(container, docSel)) {
      const text = docSel.toString().trim()
      if (text) return { text }
    }
  }

  if (shadowRoots) {
    // 直接遍历缓存的 ShadowRoot（O(n) 其中 n = ShadowRoot 数量，通常 2-3 个）
    for (const sr of shadowRoots) {
      // 检查 host 是否仍在 DOM 中（可能已被移除）
      if (!container.contains(sr.host)) continue
      const shadowSel = (sr as { getSelection?: () => Selection | null }).getSelection?.()
      if (shadowSel && !shadowSel.isCollapsed && shadowSel.rangeCount > 0) {
        const text = shadowSel.toString().trim()
        if (text) return { text }
      }
    }
    return null
  }

  // 兜底：无缓存时递归遍历（组件初始化瞬间可能命中一次）
  function walk(node: Node): { text: string } | null {
    if (node instanceof HTMLElement && node.shadowRoot) {
      const shadowSel = (node.shadowRoot as { getSelection?: () => Selection | null }).getSelection?.()
      if (shadowSel && !shadowSel.isCollapsed && shadowSel.rangeCount > 0) {
        const text = shadowSel.toString().trim()
        if (text) return { text }
      }
      const result = walk(node.shadowRoot)
      if (result) return result
    }
    for (const child of node.childNodes) {
      const result = walk(child)
      if (result) return result
    }
    return null
  }
  return walk(container)
}

/** 用 TreeWalker 发现容器内所有现有 ShadowRoot（仅初始化时调用一次） */
function discoverShadowRoots(root: Node, target: Set<ShadowRoot>): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT)
  while (walker.nextNode()) {
    const el = walker.currentNode as HTMLElement
    if (el.shadowRoot) target.add(el.shadowRoot)
  }
}

interface DiffTabContentProps {
  filePath: string
  dirPath: string
  sessionId: string
  gitRoot?: string
  previewOnly?: boolean
  /** 禁用预览内编辑，适用于 clipboard 等临时快照 */
  readOnly?: boolean
  /** 候选基础目录（previewOnly 模式下用于路径解析） */
  basePaths?: string[]
  /** diff 模式下检测到内容为空（无差异）时回调，用于自动关闭预览面板 */
  onEmptyDiff?: () => void
  /** 由外层场景注入的额外工具按钮，例如默认应用打开、返回会话 */
  toolbarActions?: React.ReactNode
  /** 上层已提供文件名和操作栏时，隐藏本组件的路径/操作重复栏。 */
  hideToolbar?: boolean
  /** 基准 ref（如 "origin/main"），用于 worktree vs main 模式 */
  baseRef?: string
  /** Agent 正式预览请求上下文；只透传给当前用户可见的 PPTX OfficePreview。 */
  agentPreviewSession?: { requestId: string; revision: string }
}

export function DiffTabContent({ filePath, dirPath, sessionId, gitRoot, previewOnly, readOnly, basePaths, onEmptyDiff, toolbarActions, hideToolbar = false, baseRef, agentPreviewSession }: DiffTabContentProps): React.ReactElement {
  const [viewMode, setViewMode] = useAtom(agentDiffViewModeAtom)
  const [oldContent, setOldContent] = React.useState('')
  const [newContent, setNewContent] = React.useState('')
  const [markdownEditing, setMarkdownEditing] = React.useState(false)
  const [markdownSourceMode, setMarkdownSourceMode] = React.useState(false)
  const [markdownDraft, setMarkdownDraft] = React.useState('')
  const [markdownSaving, setMarkdownSaving] = React.useState(false)
  const [autosaveStatus, setAutosaveStatus] = React.useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const lastSavedDraftRef = React.useRef('')
  const filePathRef = React.useRef(filePath)
  filePathRef.current = filePath
  const autosaveTimerRef = React.useRef<number | null>(null)
  const [docxHtml, setDocxHtml] = React.useState('')
  const [officeHtml, setOfficeHtml] = React.useState('')
  const [officeText, setOfficeText] = React.useState('')
  const [officeFallbackHtml, setOfficeFallbackHtml] = React.useState('')
  // HTML 默认展示运行后的页面；用户可随时切换回源码高亮预览。
  const [htmlPreviewUrl, setHtmlPreviewUrl] = React.useState('')
  const [htmlSourceMode, setHtmlSourceMode] = React.useState(false)
  const [pdfSrc, setPdfSrc] = React.useState('')
  const [pdfError, setPdfError] = React.useState('')
  const [pdfZoom, setPdfZoom] = React.useState(100)
  const pdfIframeRef = React.useRef<HTMLIFrameElement>(null)
  const [imagePath, setImagePath] = React.useState('')
  const [imageDataUrl, setImageDataUrl] = React.useState('')
  // 图片缩放：useSmoothZoom 统一三处图片预览（普通滚轮直接缩放 + rAF 平滑 + 指针锚定 + 拖拽平移）
  const {
    zoom: imageZoom,
    pan: imagePan,
    bindRef: bindImageEl,
    reset: resetImageZoom,
    zoomBy: imageZoomBy,
    onPanMouseDown: onImagePanMouseDown,
  } = useSmoothZoom({ minZoom: 0.5, maxZoom: 5 })
  const scrollContainerRef = React.useRef<HTMLDivElement>(null)
  const [findOpen, setFindOpen] = React.useState(false)
  const [loading, setLoading] = React.useState(true)
  const [copied, setCopied] = React.useState(false)
  // 文件解析失败（主进程 resolveAndReadFile 返回 null）：区别于「文件存在但内容为空」
  const [notFound, setNotFound] = React.useState(false)
  // 预览目标类型：目录链接展示目录清单；denied 区分「越权被拒」与「真的不存在」
  const [pathKind, setPathKind] = React.useState<'file' | 'directory' | 'denied'>('file')
  const refreshVersionMap = useAtomValue(agentDiffRefreshVersionAtom)
  const setRefreshVersionMap = useSetAtom(agentDiffRefreshVersionAtom)
  const refreshVersion = refreshVersionMap.get(sessionId) ?? 0
  const previewContentVersion = previewOnly ? refreshVersion : 0
  const theme = useAtomValue(resolvedThemeAtom)
  // md 文档预览代码块背景统一为深色 --code-bg（与聊天消息代码块一致），
  // 因此 Shiki 恒用深色主题，避免浅色主题下代码块文字变黑。
  const MD_SHIKI_THEME = 'github-dark' as const
  const [tocOpen, setTocOpen] = useAtom(markdownTocOpenAtom)
  const sessions = useAtomValue(agentSessionsAtom)
  const store = useStore()
  const setAgentSessions = useSetAtom(agentSessionsAtom)
  const setQuotedSelectionMap = useSetAtom(quotedSelectionMapAtom)
  const [previewSelection, setPreviewSelection] = React.useState<PreviewSelectionSnapshot | null>(null)

  const ext = getExtension(filePath)
  const isMarkdown = previewOnly && MD_EXTS.has(ext)
  const isHtml = previewOnly && HTML_EXTS.has(ext)
  const isPlainTextEditable = previewOnly && EDITABLE_TEXT_EXTS.has(ext)
  const isEditableText = isMarkdown || isPlainTextEditable
  const isPdf = previewOnly && PDF_EXTS.has(ext)
  const isDocx = previewOnly && DOCX_EXTS.has(ext)
  const isOfficePreview = previewOnly && OFFICE_PREVIEW_EXTS.has(ext)
  const isLegacyOffice = previewOnly && LEGACY_OFFICE_EXTS.has(ext)
  // 普通图片（Chromium <img> 能解的位图）不走 OFV：OFV 的 imagePlugin 要按住 Ctrl/Cmd
  // 滚轮才缩放、且是档位式 zoom-in/out 命令，体验不如自渲染的 useSmoothZoom（普通滚轮
  // 直接缩放 + rAF 平滑 + 指针锚定）。故把普通图片从 OFV 承担范围里排除，交回 isImage 分支。
  // OFV 只接管 Chromium 画不了的图片格式（.tif/.heic/.jxl…，在 OFV_EXTRA_EXTS 里）。
  const isImageExt = IMAGE_PREVIEW_EXTS.has(ext)
  const isOfvBacked = previewOnly && isOfvBackedPath(filePath) && !isImageExt
  const isImage = previewOnly && isImageExt
  const isUnsupported = previewOnly && UNSUPPORTED_EXTS.has(ext)

  React.useEffect(() => {
    initShortcutRegistry()
  }, [])

  useShortcut(
    'file-find',
    React.useCallback(() => setFindOpen(true), []),
    true,
    FILE_FIND_SHORTCUT_OPTIONS,
  )

  const findContentKey = React.useMemo(() => JSON.stringify({
    filePath,
    previewOnly: Boolean(previewOnly),
    viewMode,
    loading,
    newLength: newContent.length,
    oldLength: oldContent.length,
    officeLength: officeHtml.length,
    markdownEditing,
    markdownSourceMode,
    docxLength: docxHtml.length,
  }), [docxHtml.length, filePath, loading, markdownEditing, markdownSourceMode, newContent.length, officeHtml.length, oldContent.length, previewOnly, viewMode])

  // 目录提取只需在「文件本身或其内容」变化时重建，避免 loading/编辑态切换造成的抖动
  const tocContentKey = React.useMemo(
    () => JSON.stringify({ filePath, previewContentVersion, newLength: newContent.length }),
    [filePath, previewContentVersion, newContent.length],
  )

  // ===== 选中文本引用（Quoted Selection）=====

  usePreviewQuotedSelection({
    containerRef: scrollContainerRef,
    sessionId,
    filePath,
    onSelectionChange: setPreviewSelection,
    enabled: Boolean(previewOnly),
  })

  const handleOpenExplorationFromPreview = React.useCallback(async (): Promise<void> => {
    if (!previewSelection) return
    const sourceSession = sessions.find((item) => item.id === sessionId)
    if (!sourceSession || sourceSession.agentRuntime !== 'pi') {
      toast.info('文件探索目前仅支持 Pi Agent 会话')
      return
    }

    const cachedMessages = store.get(agentSDKMessagesCacheAtom).get(sessionId) ?? []
    const liveMessages = store.get(liveMessagesMapAtom).get(sessionId) ?? []
    const resolvedSourceMessageId = resolveLatestExplorationSourceMessageId(
      [...cachedMessages, ...liveMessages],
      sourceSession.piEntryBindings,
    )
    if (!resolvedSourceMessageId) {
      toast.info('当前文件预览没有可用的 Pi 探索节点，请先完成一轮 Agent 对话')
      return
    }

    try {
      const branch = await window.electronAPI.forkAgentSession({
        sessionId,
        upToMessageUuid: resolvedSourceMessageId,
        explorationSourceLabel: `文件 · ${getFileBaseName(filePath)}`,
      })
      const quotedSelection = {
        text: previewSelection.text,
        filePath,
        sourceType: 'file' as const,
        sourceLabel: getFileBaseName(filePath),
        capturedAt: Date.now(),
      }
      setAgentSessions((previous) => previous.some((item) => item.id === branch.id) ? previous : [branch, ...previous])
      // 预览 hook 已把选区写入父会话；创建探索后将它迁移到分支，避免主线残留重复引用。
      setQuotedSelectionMap((previous) => {
        const next = new Map(previous)
        next.delete(sessionId)
        next.set(branch.id, quotedSelection)
        return next
      })
      // 分支成为父会话上下文内的顶栏 Tab：激活分支，并自动与父会话并排（焦点在分支）。
      openExplorationBranchTab(store, sessionId, { sessionId: branch.id, title: branch.title || '探索分支' }, { autoGroup: true })
      setPreviewSelection(null)
      window.getSelection()?.removeAllRanges()
      toast.success('已从文件预览创建探索分支', { description: '当前选区已带入分支。' })
    } catch (error) {
      console.error('[DiffTabContent] 从文件预览创建探索分支失败:', error)
      toast.error('创建探索分支失败', { description: error instanceof Error ? error.message : undefined })
    }
  }, [filePath, previewSelection, sessionId, sessions, setAgentSessions, setQuotedSelectionMap, store])

  const fileAccess = React.useMemo(() => ({
    sessionId,
    // 历史工具调用常只保存相对 filePath；补入会话 CWD 才能在重开后解析真实文件。
    // 绝对路径不追加该回退，避免失效绝对路径误命中会话目录中的同名文件。
    candidateBasePaths: getPreviewCandidateBasePaths(
      basePaths,
      isAbsoluteFilePath(filePath) ? undefined : dirPath,
    ),
  }), [sessionId, basePaths, dirPath, filePath])

  const contentCacheScope = React.useMemo(() => JSON.stringify({
    dirPath,
    gitRoot: gitRoot ?? '',
    basePaths: basePaths ?? [],
  }), [basePaths, dirPath, gitRoot])

  const getContentCacheKey = React.useCallback((mode: 'preview' | 'diff', version: number) => (
    `${sessionId}:${mode}:${filePath}@v${version}:${contentCacheScope}`
  ), [contentCacheScope, filePath, sessionId])

  // PierreFile props 缓存，避免每次渲染创建新对象导致内部重新高亮
  const pierreFile = React.useMemo(() => ({
    name: getFileBaseName(filePath),
    contents: newContent,
    cacheKey: `${filePath}:${newContent.length}:${previewContentVersion}`,
  }), [filePath, newContent, previewContentVersion])

  const pierreOptions = React.useMemo(() => ({
    theme: { dark: 'one-dark-pro' as const, light: 'one-light' as const },
    disableFileHeader: true,
    overflow: 'scroll' as const,
    themeType: theme as 'light' | 'dark' | 'system',
    unsafeCSS: PIERRE_FILE_CSS,
  }), [theme])
  const markdownFileAccess = React.useMemo(() => {
    const candidateBasePaths: string[] = []
    const slash = filePath.lastIndexOf('/')
    if (slash > 0) candidateBasePaths.push(filePath.slice(0, slash))
    if (dirPath) candidateBasePaths.push(dirPath)
    for (const basePath of basePaths ?? []) {
      if (basePath && !candidateBasePaths.includes(basePath)) candidateBasePaths.push(basePath)
    }
    return { sessionId, candidateBasePaths }
  }, [basePaths, dirPath, filePath, sessionId])

  // props 变化时立即清空内容状态，避免在 useEffect 执行前渲染旧数据
  React.useEffect(() => {
    setOldContent('')
    setNewContent('')
    setNotFound(false)
    setDocxHtml('')
    setOfficeHtml('')
    setOfficeText('')
    setHtmlPreviewUrl('')
    setHtmlSourceMode(false)
    setPdfSrc('')
    setPdfError('')
    setPdfZoom(100)
    setImagePath('')
    setImageDataUrl('')
    resetImageZoom(1)
    setLoading(!isLegacyOffice)
    setMarkdownEditing(false)
    setMarkdownSourceMode(false)
    setMarkdownDraft('')
    setMarkdownSaving(false)
  }, [filePath, sessionId, previewOnly, isLegacyOffice, resetImageZoom])

  // 监听 PDF iframe 发回的缩放百分比
  React.useEffect(() => {
    if (!isPdf) return
    const handler = (e: MessageEvent) => {
      if (e.data?.type === 'pdf-zoom-changed') setPdfZoom(e.data.zoom)
    }
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [isPdf])

  // 上次加载的内容（refreshVersion 触发时用来对比是否变化）
  const lastNewContentRef = React.useRef('')
  const lastOldContentRef = React.useRef('')

  // 滚动位置持久化 key（sessionId:filePath）。主加载 effect 在缓存未命中时
  // 也会读它判断是否需要恢复滚动，故声明须早于该 effect。
  const scrollKey = scrollCacheKey(sessionId, filePath)

  // 主加载 effect：上下文变化（filePath/dirPath/gitRoot/previewOnly）时触发；
  // 纯预览模式也跟随 refreshVersion 失效，保证同一文件二次写入后重新读盘。
  // 命中缓存时跳过 loading 闪烁直接渲染；未命中走 IPC 拉取
  React.useEffect(() => {
    let cancelled = false

    // 所有文件类型均可缓存（含 PDF/DOCX/Office/Image）
    const cacheKey = previewOnly
      ? getContentCacheKey('preview', previewContentVersion)
      : getContentCacheKey('diff', refreshVersion)
    const cached = cacheGet(cacheKey)

    if (cached) {
      // 命中：直接同步渲染，不闪
      restoreScrollRef.current = true
      lastNewContentRef.current = cached.newContent
      lastOldContentRef.current = cached.oldContent
      setOldContent(cached.oldContent)
      setNewContent(cached.newContent)
      setDocxHtml(cached.docxHtml ?? '')
      setOfficeHtml(cached.officeHtml ?? '')
      setOfficeText(cached.officeText ?? '')
      setOfficeFallbackHtml(cached.officeHtml ?? '')
      setHtmlPreviewUrl(cached.htmlPreviewUrl ?? '')
      setPdfSrc(cached.pdfSrc ?? '')
      setPdfError('')
      setPdfZoom(100)
      setImagePath(cached.imagePath ?? '')
      setImageDataUrl(cached.imageDataUrl ?? '')
      resetImageZoom(1)
      setLoading(false)
      return // 缓存命中，直接返回，不执行 load()
    } else {
      if (!isLegacyOffice && !isUnsupported) setLoading(true)
      setOldContent('')
      setNewContent('')
      setNotFound(false)
      setPathKind('file')
      setDocxHtml('')
      setOfficeHtml('')
      setOfficeText('')
      setOfficeFallbackHtml('')
      setHtmlPreviewUrl('')
      setPdfSrc('')
      setPdfError('')
      setPdfZoom(100)
      setImagePath('')
      setImageDataUrl('')
      resetImageZoom(1)
      lastNewContentRef.current = ''
      lastOldContentRef.current = ''
      // 内容缓存被 LRU 淘汰但滚动位置仍在时（如切走会话后预览 Tab 重建），
      // 也标记需要恢复，待 load() 重新拉取渲染后回到上次滚动位置。
      if (scrollPositionCache.has(scrollKey)) {
        restoreScrollRef.current = true
      }
    }

    async function load() {
      try {
        let content = cached?.newContent ?? ''
        let old = cached?.oldContent ?? ''
        let htmlUrl = cached?.htmlPreviewUrl ?? ''

        if (!cached) {
          if (previewOnly) {
            // 先分清「文件 / 目录 / 不可预览」：目录链接（如 `~/.profer-dev/skins/<id>`）交给目录视图，
            // denied 路径拿到准确提示；否则后面各类型分支只会各自报“加载失败/不存在”。
            const described = await window.electronAPI.describePath(filePath, fileAccess)
            if (cancelled) return
            if (described.kind === 'directory') {
              setPathKind('directory')
              setLoading(false)
              return
            }
            if (described.kind === 'denied') {
              setPathKind('denied')
              setLoading(false)
              return
            }
            if (isUnsupported) {
              if (!cancelled) setLoading(false)
              return
            }
            if (isPdf) {
              const result = await window.electronAPI.preparePdfPreview(filePath, fileAccess)
              if (cancelled) return
              const src = result?.tmpHtmlUrl ?? ''
              if (!src) {
                setPdfSrc('')
                setPdfError('PDF 预览加载失败，请重试')
                // 失败结果不能写入成功缓存，否则重试/重新打开会永久命中空 src。
                contentCache.delete(cacheKey)
              } else {
                setPdfSrc(src)
                setPdfError('')
                cacheSet(cacheKey, { oldContent: '', newContent: '', pdfSrc: src })
              }
              setLoading(false)
              return
            }
            if (isImage) {
              const resolved = await window.electronAPI.resolveFilePath(filePath, fileAccess)
              if (cancelled) return
              if (resolved) {
                setImagePath(filePath)
                setImageDataUrl(resolved.url)
                cacheSet(cacheKey, { oldContent: '', newContent: '', imagePath: filePath, imageDataUrl: resolved.url })
              } else {
                setImagePath('')
                setImageDataUrl('')
                cacheSet(cacheKey, { oldContent: '', newContent: '', imagePath: '', imageDataUrl: '' })
              }
              return
            }
            if (isDocx) {
              const result = await window.electronAPI.docxToHtml(filePath, fileAccess)
              if (cancelled) return
              const html = DOMPurify.sanitize(result?.html ?? '')
              setDocxHtml(html)
              cacheSet(cacheKey, { oldContent: '', newContent: '', docxHtml: html })
              return
            }
            if (isOfficePreview) {
              const result = await window.electronAPI.officeToHtml(filePath, fileAccess)
              if (cancelled) return
              const html = DOMPurify.sanitize(result?.html ?? '')
              const text = result?.text ?? ''
              setOfficeHtml(html)
              setOfficeText(text)
              setOfficeFallbackHtml(html)
              cacheSet(cacheKey, { oldContent: '', newContent: '', officeHtml: html, officeText: text })
              return
            }
            if (isLegacyOffice) {
              return
            }
            if (isOfvBacked) {
              return
            }
            const result = await window.electronAPI.resolveAndReadFile(filePath, fileAccess)
            if (cancelled) return
            // result === null ⇒ 主进程在所有授权/全局目录都没找到该文件（非空文件，而是不存在）
            if (result === null) setNotFound(true)
            content = result?.content ?? ''
            if (isHtml) {
              const preview = await window.electronAPI.resolveHtmlPreviewPath(filePath, fileAccess)
              if (cancelled) return
              htmlUrl = preview?.url ?? ''
              setHtmlPreviewUrl(htmlUrl)
            }
          } else {
            const result = await window.electronAPI.getDiffContents({ dirPath, filePath, gitRoot, sessionId, baseRef })
            if (cancelled) return
            content = result?.newContent ?? ''
            old = result?.oldContent ?? ''
          }

          lastNewContentRef.current = content
          lastOldContentRef.current = old
          setOldContent(old)
          setNewContent(content)

          if (cacheKey) cacheSet(cacheKey, { oldContent: old, newContent: content, htmlPreviewUrl: htmlUrl || undefined })
        }

        if (previewOnly && !MD_EXTS.has(ext) && content) {
          if (!cancelled) setLoading(false)
        }
      } catch (error) {
        if (!cancelled && isPdf) {
          setPdfSrc('')
          setPdfError(error instanceof Error && error.message ? error.message : 'PDF 预览加载失败，请重试')
          // 不缓存失败结果；下一次重试必须重新请求主进程。
          contentCache.delete(cacheKey)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath, dirPath, gitRoot, previewOnly, previewContentVersion, fileAccess, isPdf, isDocx, isOfficePreview, isLegacyOffice, isImage, isOfvBacked, sessionId, ext, getContentCacheKey])

  // refreshVersion 触发的静默刷新：仅 diff 模式、内容有变化时才更新 state
  const prevRefreshRef = React.useRef(-1)
  React.useEffect(() => {
    if (previewOnly) return
    // 首次跳过（避免首屏加载时和主 effect 重复拉取）
    if (prevRefreshRef.current === -1) {
      prevRefreshRef.current = refreshVersion
      return
    }
    if (prevRefreshRef.current === refreshVersion) return
    prevRefreshRef.current = refreshVersion

    let cancelled = false
    async function refresh() {
      try {
        const result = await window.electronAPI.getDiffContents({ dirPath, filePath, gitRoot, sessionId })
        if (cancelled || !result) return
        const newC = result.newContent ?? ''
        const oldC = result.oldContent ?? ''
        // 用新 refreshVersion 写入缓存，让后续切走再切回来能命中
        cacheSet(getContentCacheKey('diff', refreshVersion), { oldContent: oldC, newContent: newC })
        if (newC === lastNewContentRef.current && oldC === lastOldContentRef.current) return
        lastNewContentRef.current = newC
        lastOldContentRef.current = oldC
        setNewContent(newC)
        setOldContent(oldC)
      } catch {
        // ignore
      }
    }
    refresh()
    return () => { cancelled = true }
  }, [refreshVersion, previewOnly, filePath, dirPath, gitRoot, sessionId, getContentCacheKey])

  // diff 模式：内容加载完成后若新旧一致（无差异），通知父组件关闭预览面板
  const emptyDiffFiredRef = React.useRef(false)
  React.useEffect(() => {
    emptyDiffFiredRef.current = false
  }, [filePath, sessionId])
  React.useEffect(() => {
    if (previewOnly || loading || emptyDiffFiredRef.current) return
    if (oldContent === newContent) {
      emptyDiffFiredRef.current = true
      onEmptyDiff?.()
    }
  }, [previewOnly, loading, oldContent, newContent, onEmptyDiff])

  // previewOnly 模式：加载完成后若内容无法预览，弹 Toast 通知用户
  const toastedPreviewFailRef = React.useRef('')
  React.useEffect(() => {
    if (!previewOnly || loading) return
    const key = `${filePath}:${ext}`
    if (toastedPreviewFailRef.current === key) return
    let message: string | null = null
    if (isLegacyOffice) {
      message = `暂不支持 ${ext.toUpperCase().slice(1)} 格式内联预览`
    } else if (isPdf && pdfError) {
      message = pdfError
    } else if (isDocx && !docxHtml) {
      message = '无法加载 DOCX 预览'
    } else if (isOfficePreview && !officeHtml) {
      message = '无法加载 PPTX 预览'
    } else if (isImage && !imageDataUrl) {
      message = '图片文件过大，无法在此预览'
    }
    if (message) {
      toastedPreviewFailRef.current = key
      toast.warning(message)
    }
  }, [previewOnly, loading, filePath, ext, isLegacyOffice, isPdf, pdfSrc, pdfError, isDocx, docxHtml, isOfficePreview, officeHtml, isImage, imageDataUrl])

  // scrollPosition persistent: module-level Map keyed by sessionId:filePath
  // content changes (refreshVersion bump) → delete stored position;
  // cached mount → restore; scroll → save.
  const prevRefreshVersionRef = React.useRef(refreshVersion)
  const restoreScrollRef = React.useRef(false)
  const restoreRafRef = React.useRef(0)

  // WHEN content version changes (refreshVersion bump): delete stored scroll position
  // 只在内容变化时清除，切换文件时保留位置以支持返回导航
  React.useEffect(() => {
    if (loading) return // still loading, don't clear yet
    if (prevRefreshVersionRef.current !== refreshVersion) {
      scrollPositionCache.delete(scrollKey)
      restoreScrollRef.current = false
      prevRefreshVersionRef.current = refreshVersion
    }
  }, [scrollKey, refreshVersion, loading])

  // RESTORE scroll position after cached content renders.
  // 等待滚动容器内容高度连续 3 帧稳定后再恢复，避免异步渲染
  // （Shiki tokenize、ProseMirror mount）导致高度变化引起滚动偏移。
  React.useEffect(() => {
    if (loading || !restoreScrollRef.current) return

    const pos = scrollPositionCache.get(scrollKey)
    if (!pos || !scrollContainerRef.current) {
      restoreScrollRef.current = false
      return
    }

    const el = scrollContainerRef.current
    let prevHeight = el.scrollHeight
    let stableFrames = 0

    const check = () => {
      const curHeight = el.scrollHeight
      if (curHeight === prevHeight) {
        stableFrames++
      } else {
        stableFrames = 0
        prevHeight = curHeight
      }
      if (stableFrames >= 3) {
        restoreScrollRef.current = false
        el.scrollTop = pos.top
        el.scrollLeft = pos.left
        restoreRafRef.current = 0
        return
      }
      restoreRafRef.current = requestAnimationFrame(check)
    }

    restoreRafRef.current = requestAnimationFrame(check)

    return () => {
      if (restoreRafRef.current) {
        cancelAnimationFrame(restoreRafRef.current)
        restoreRafRef.current = 0
      }
    }
  }, [loading, scrollKey])

  // SAVE scroll position on scroll (throttled via rAF)
  const scrollRafRef = React.useRef(0)
  const handleScroll = React.useCallback(() => {
    if (scrollRafRef.current) return
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = 0
      const el = scrollContainerRef.current
      if (el) {
        scrollPositionCache.set(scrollKey, { top: el.scrollTop, left: el.scrollLeft })
      }
    })
  }, [scrollKey])

  // Cleanup rAF on unmount to prevent stale writes
  React.useEffect(() => {
    return () => {
      if (scrollRafRef.current) cancelAnimationFrame(scrollRafRef.current)
      if (restoreRafRef.current) cancelAnimationFrame(restoreRafRef.current)
    }
  }, [])

  const handleCopy = React.useCallback(async () => {
    try {
      const copyText = markdownEditing ? markdownDraft : (isOfficePreview ? officeText : newContent)
      await navigator.clipboard.writeText(copyText)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // 复制失败
    }
  }, [isOfficePreview, markdownDraft, markdownEditing, newContent, officeText])

  const handleCopyPath = React.useCallback(async () => {
    try {
      await navigator.clipboard.writeText(filePath)
      toast.success('路径复制成功')
    } catch {
      toast.error('复制路径失败')
    }
  }, [filePath])

  const startMarkdownEdit = React.useCallback(() => {
    if (!isEditableText) return
    setMarkdownDraft(newContent)
    lastSavedDraftRef.current = newContent
    setAutosaveStatus('idle')
    setMarkdownSourceMode(false)
    setMarkdownEditing(true)
  }, [isEditableText, newContent])

  // ref 形式的 persist：避免 callback / effect 因 refreshVersion 频繁变化而重建
  const persistRef = React.useRef<(draft: string, fp: string, fa: typeof fileAccess) => Promise<boolean>>(async () => false)

  const exitMarkdownEdit = React.useCallback(() => {
    // 退出前 flush 待保存的草稿，避免用户在 debounce 窗口内退出时丢失输入。
    // 不再用 `draft !== ''` 过滤：清空整个文件也是合法编辑，依靠
    // `draft !== lastSavedDraftRef.current` 已能避免初次进入时无意义写盘
    // （startMarkdownEdit 时 lastSavedDraftRef = newContent）。
    if (autosaveTimerRef.current !== null) {
      window.clearTimeout(autosaveTimerRef.current)
      autosaveTimerRef.current = null
    }
    if (markdownDraft !== lastSavedDraftRef.current) {
      void persistRef.current(markdownDraft, filePath, fileAccess)
    }
    setMarkdownSourceMode(false)
    setMarkdownEditing(false)
    setAutosaveStatus('idle')
  }, [markdownDraft, filePath, fileAccess])

  // 写盘核心：不退出编辑模式，被 autosave、saveMarkdownEdit、flush 共用。
  // 接收显式参数（不依赖闭包），保证切换文件后 flush 用旧文件路径。
  // 同一份 draft 重复触发会被 `draft === lastSavedDraftRef.current` 短路，
  // 因此 autosave timer 与 unmount cleanup 偶发的双重 fire 不会真的写两次。
  const persistMarkdownDraft = React.useCallback(async (
    draft: string,
    fp: string,
    fa: typeof fileAccess,
  ): Promise<boolean> => {
    if (draft === lastSavedDraftRef.current) return true
    setAutosaveStatus('saving')
    try {
      const ok = await window.electronAPI.writeTextFile(fp, draft, fa)
      if (!ok) {
        setAutosaveStatus('error')
        return false
      }
      lastSavedDraftRef.current = draft
      // 仅当当前展示的仍是这个文件时，才同步 UI state，避免覆盖刚切到的新文件
      if (fp === filePathRef.current) {
        lastNewContentRef.current = draft
        lastOldContentRef.current = ''
        setOldContent('')
        setNewContent(draft)
        cacheSet(getContentCacheKey('preview', refreshVersion + 1), { oldContent: '', newContent: draft })
        setRefreshVersionMap((prev) => {
          const m = new Map(prev)
          m.set(sessionId, (prev.get(sessionId) ?? 0) + 1)
          return m
        })
        setAutosaveStatus('saved')
      }
      return true
    } catch (err) {
      console.error('[DiffTabContent] Markdown save failed:', err)
      setAutosaveStatus('error')
      return false
    }
  }, [getContentCacheKey, refreshVersion, sessionId, setRefreshVersionMap])

  const saveMarkdownEdit = React.useCallback(async () => {
    if (!isEditableText || markdownSaving) return
    // autosaveTimerRef 由 autosave effect 创建；这里手动清是为了避免
    // "立即保存"返回后 effect cleanup 再次清掉一个已经 null 的句柄（无害但冗余），
    // 同时也确保不会在 await 期间触发延迟回调
    if (autosaveTimerRef.current !== null) {
      window.clearTimeout(autosaveTimerRef.current)
      autosaveTimerRef.current = null
    }
    setMarkdownSaving(true)
    const ok = await persistMarkdownDraft(markdownDraft, filePath, fileAccess)
    setMarkdownSaving(false)
    if (!ok) {
      window.alert('保存失败：没有写入权限或文件不存在')
      return
    }
    setMarkdownSourceMode(false)
    setMarkdownEditing(false)
  }, [fileAccess, filePath, isEditableText, markdownDraft, markdownSaving, persistMarkdownDraft])

  const handleManualRefresh = React.useCallback(() => {
    setRefreshVersionMap((prev) => {
      const m = new Map(prev)
      m.set(sessionId, (prev.get(sessionId) ?? 0) + 1)
      return m
    })
  }, [sessionId, setRefreshVersionMap])

  const handlePdfRetry = React.useCallback(() => {
    contentCache.delete(getContentCacheKey('preview', previewContentVersion))
    setPdfError('')
    setPdfSrc('')
    handleManualRefresh()
  }, [getContentCacheKey, handleManualRefresh, previewContentVersion])

  // persistRef 始终持有最新 persistMarkdownDraft，供 setTimeout / unmount cleanup 调用。
  // 用 effect 而非渲染期赋值，避免 React 19 严格模式下并发渲染中途读到中间态。
  React.useEffect(() => {
    persistRef.current = persistMarkdownDraft
  }, [persistMarkdownDraft])

  // 自动保存：编辑模式下停止输入 1.5s 后写盘。
  // timer 所有权：autosave effect 创建并在 cleanup 中清；saveMarkdownEdit / exitMarkdownEdit
  // 也会主动清以抢占 debounce。多处清理都是幂等的（设 null 后再清是 no-op）。
  React.useEffect(() => {
    if (!markdownEditing || !isEditableText) return
    if (markdownDraft === lastSavedDraftRef.current) return
    if (autosaveTimerRef.current !== null) {
      window.clearTimeout(autosaveTimerRef.current)
    }
    const draftSnapshot = markdownDraft
    const fpSnapshot = filePath
    const faSnapshot = fileAccess
    autosaveTimerRef.current = window.setTimeout(() => {
      autosaveTimerRef.current = null
      void persistRef.current(draftSnapshot, fpSnapshot, faSnapshot)
    }, 1500)
    return () => {
      if (autosaveTimerRef.current !== null) {
        window.clearTimeout(autosaveTimerRef.current)
        autosaveTimerRef.current = null
      }
    }
  }, [markdownDraft, markdownEditing, isEditableText, filePath, fileAccess])

  // saved → 1.5s 后回到 idle，避免指示器一直停在"已保存"
  React.useEffect(() => {
    if (autosaveStatus !== 'saved') return
    const id = window.setTimeout(() => setAutosaveStatus('idle'), 1500)
    return () => window.clearTimeout(id)
  }, [autosaveStatus])

  // 切换文件 / 卸载：若有未保存的 draft，fire-and-forget flush 到旧文件。
  // persistMarkdownDraft 内的 short-circuit 保证即便 autosave timer 刚 fire 过、
  // 这里又 flush 一次，也不会真的写两次盘。
  const flushStateRef = React.useRef({ draft: '', editing: false, filePath, fileAccess })
  flushStateRef.current = { draft: markdownDraft, editing: markdownEditing, filePath, fileAccess }
  React.useEffect(() => {
    return () => {
      if (autosaveTimerRef.current !== null) {
        window.clearTimeout(autosaveTimerRef.current)
        autosaveTimerRef.current = null
      }
      const { draft, editing, filePath: fp, fileAccess: fa } = flushStateRef.current
      // 不过滤空 draft：startMarkdownEdit 已把 lastSavedDraftRef 设为 newContent，
      // 因此"原本就空、未编辑"的情况会被 dirty 比较自动跳过；而"非空清空"是合法操作必须落盘。
      if (editing && isEditableText && draft !== lastSavedDraftRef.current) {
        void persistRef.current(draft, fp, fa)
      }
    }
    // 仅依赖 filePath/sessionId：切文件时执行 cleanup 触发 flush；
    // draft/editing/fileAccess 通过 ref 读取最新值
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath, sessionId])

  return (
    <div className="flex flex-col h-full">
      {!hideToolbar && <div className="flex h-8 items-center gap-1.5 border-b border-surface-border/60 px-3 flex-shrink-0">
        <button
          type="button"
          onClick={handleCopyPath}
          className="min-w-0 flex-1 truncate text-left text-[12px] text-foreground/60 hover:text-foreground hover:underline underline-offset-2"
          title={`${filePath}（点击复制完整路径）`}
        >
          {getFileBaseName(filePath) || filePath}
        </button>

        {!previewOnly && (
          <div
            className="relative flex rounded-lg bg-muted p-0.5 shrink-0 ml-auto cursor-pointer select-none"
            onClick={() => setViewMode((v) => v === 'split' ? 'unified' : 'split')}
          >
            <div
              className={cn(
                'absolute top-0.5 bottom-0.5 w-[calc(50%-2px)] rounded-md bg-background shadow-sm transition-transform duration-200 ease-in-out',
                viewMode === 'unified' ? 'translate-x-full' : 'translate-x-0',
              )}
            />
            <span className={cn('relative z-[1] rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors',
              viewMode === 'split' ? 'text-foreground' : 'text-muted-foreground')}>分栏</span>
            <span className={cn('relative z-[1] rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors',
              viewMode === 'unified' ? 'text-foreground' : 'text-muted-foreground')}>统一</span>
          </div>
        )}

        {previewOnly && isHtml && (
          <button
            type="button"
            onClick={() => setHtmlSourceMode((sourceMode) => !sourceMode)}
            className="ml-auto p-1 rounded hover:bg-foreground/[0.06] text-foreground/40 hover:text-foreground/60 shrink-0"
            title={htmlSourceMode ? '切换到渲染预览' : '切换到源码预览'}
            aria-label={htmlSourceMode ? '切换到渲染预览' : '切换到源码预览'}
          >
            {htmlSourceMode ? <Eye className="size-3.5" /> : <Code2 className="size-3.5" />}
          </button>
        )}

        {previewOnly && isEditableText && !readOnly && (
          markdownEditing ? (
            <div className="ml-auto flex items-center gap-1">
              {isMarkdown && (
                <button
                  type="button"
                  onClick={() => setMarkdownSourceMode((v) => !v)}
                  disabled={markdownSaving}
                  className="p-1 rounded hover:bg-foreground/[0.06] text-foreground/40 hover:text-foreground/60 disabled:opacity-50 shrink-0"
                  title={markdownSourceMode ? '切换到富文本编辑' : '切换到源码编辑'}
                >
                  {markdownSourceMode ? <Eye className="size-3.5" /> : <Code2 className="size-3.5" />}
                </button>
              )}
              <button
                type="button"
                onClick={exitMarkdownEdit}
                disabled={markdownSaving}
                className="p-1 rounded hover:bg-foreground/[0.06] text-foreground/40 hover:text-foreground/60 disabled:opacity-50 shrink-0"
                title="退出编辑"
              >
                <X className="size-3.5" />
              </button>
              <button
                type="button"
                onClick={() => void saveMarkdownEdit()}
                disabled={markdownSaving}
                className={cn(
                  'p-1 rounded hover:bg-foreground/[0.06] disabled:opacity-50 shrink-0 transition-colors duration-300',
                  autosaveStatus === 'saved' && 'text-green-500 hover:text-green-500',
                  autosaveStatus === 'error' && 'text-red-500 hover:text-red-500',
                  autosaveStatus !== 'saved' && autosaveStatus !== 'error' && 'text-foreground/40 hover:text-foreground/60',
                )}
                title={
                  autosaveStatus === 'error'
                    ? '自动保存失败，点击重试'
                    : autosaveStatus === 'saved'
                      ? '已保存'
                      : '立即保存并退出'
                }
              >
                <Save className="size-3.5" />
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={startMarkdownEdit}
              className="ml-auto p-1 rounded hover:bg-foreground/[0.06] text-foreground/40 hover:text-foreground/60 shrink-0"
              title={isMarkdown ? '编辑 Markdown' : '编辑文本'}
            >
              <Pencil className="size-3.5" />
            </button>
          )
        )}

        {!(previewOnly && (isDocx || isOfficePreview || isOfvBacked)) && (
          <button type="button" onClick={handleCopy}
            className={cn("p-1 rounded hover:bg-foreground/[0.06] text-foreground/40 hover:text-foreground/60 shrink-0", previewOnly && !isEditableText && "ml-auto")}
            title="复制文件内容">
            {copied ? <Check className="size-3.5 text-green-500" /> : <Copy className="size-3.5" />}
          </button>
        )}

        <button
          type="button"
          onClick={handleManualRefresh}
          className="p-1 rounded hover:bg-foreground/[0.06] text-foreground/40 hover:text-foreground/60 shrink-0"
          title="刷新文件内容（检测外部编辑器的修改）"
        >
          <RefreshCw className="size-3.5" />
        </button>

        {isMarkdown && !markdownEditing && (
          <button
            type="button"
            onClick={() => setTocOpen((v) => !v)}
            className={cn(
              'p-1 rounded hover:bg-foreground/[0.06] shrink-0',
              tocOpen ? 'text-foreground/70' : 'text-foreground/40 hover:text-foreground/60',
            )}
            title={tocOpen ? '隐藏目录' : '显示目录'}
          >
            <List className="size-3.5" />
          </button>
        )}

        {toolbarActions}
      </div>}

      <div className="relative flex-1 min-h-0 flex">
        <PreviewFindBar
          open={findOpen}
          rootRef={scrollContainerRef}
          contentKey={findContentKey}
          unsupportedReason={isPdf ? '暂不支持 PDF 搜索' : undefined}
          onOpenChange={setFindOpen}
        />
        <MarkdownToc
          containerRef={scrollContainerRef}
          contentKey={tocContentKey}
          enabled={Boolean(isMarkdown && !markdownEditing && tocOpen)}
          onOpenChange={setTocOpen}
        />
        {isMarkdown && !markdownEditing && !tocOpen && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => setTocOpen(true)}
                className="mx-2 mb-2 mt-4 flex size-7 shrink-0 items-center justify-center self-start rounded-md bg-muted/40 text-foreground/45 hover:bg-foreground/[0.06] hover:text-foreground/70"
                aria-label="展开目录"
              >
                <ChevronRight className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">展开目录</TooltipContent>
          </Tooltip>
        )}
        <div ref={scrollContainerRef} onScroll={handleScroll} className="h-full flex-1 min-w-0 overflow-auto scrollbar-thin relative">
          {loading ? (
            <div className="flex items-center justify-center h-full text-muted-foreground text-[12px]">加载中...</div>
          ) : previewOnly ? (
            pathKind === 'directory' ? (
              <PreviewDirectoryView
                filePath={filePath}
                sessionId={sessionId}
                basePaths={fileAccess?.candidateBasePaths}
              />
            ) : pathKind === 'denied' ? (
              <div className="flex flex-col items-center justify-center h-full gap-1.5 px-4 text-center">
                <FileQuestion className="size-6 text-muted-foreground/60" />
                <span className="text-[13px] text-muted-foreground">该路径不在允许预览的范围内</span>
                <span className="text-[12px] text-muted-foreground/70">系统目录与凭据目录（~/.ssh、钥匙串等）不参与预览</span>
                <span className="text-[12px] text-muted-foreground/70 font-mono break-all">{filePath}</span>
              </div>
            ) : isUnsupported ? (
              <div className="flex flex-col items-center justify-center h-full gap-1.5 px-4 text-center">
                <FileQuestion className="size-6 text-muted-foreground/60" />
                <span className="text-[13px] text-muted-foreground">不支持预览此文件类型</span>
                <span className="text-[12px] text-muted-foreground/70">{ext.toUpperCase().slice(1)} 为二进制或不可预览格式</span>
              </div>
            ) : isPdf ? (
              pdfSrc ? (
                <div className="relative h-full">
                <div className="absolute top-2 left-1/2 -translate-x-1/2 z-10 flex items-center gap-2 px-2 py-1 rounded-lg bg-background/80 backdrop-filter backdrop-blur-sm border border-border/30 shadow-sm">
                  <button
                    type="button"
                    className="w-6 h-6 rounded border border-border/30 flex items-center justify-center text-sm text-muted-foreground hover:bg-muted/50"
                    onClick={() => pdfIframeRef.current?.contentWindow?.postMessage({ type: 'pdf-zoom', direction: 'out' }, '*')}
                  >−</button>
                  <span className="text-xs text-muted-foreground min-w-[40px] text-center font-mono">{pdfZoom}%</span>
                  <button
                    type="button"
                    className="w-6 h-6 rounded border border-border/30 flex items-center justify-center text-sm text-muted-foreground hover:bg-muted/50"
                    onClick={() => pdfIframeRef.current?.contentWindow?.postMessage({ type: 'pdf-zoom', direction: 'in' }, '*')}
                  >+</button>
                </div>
                <iframe
                  ref={pdfIframeRef}
                  src={pdfSrc}
                  className="w-full h-full border-0"
                  title={getFileBaseName(filePath) || 'PDF'}
                  onError={() => {
                    setPdfSrc('')
                    setPdfError('PDF 页面渲染失败，请重试')
                    contentCache.delete(getContentCacheKey('preview', previewContentVersion))
                  }}
                />
              </div>
              ) : (
                <div className="flex flex-col items-center justify-center h-full gap-3 px-4 text-center">
                  <FileQuestion className="size-6 text-destructive/70" />
                  <span className="text-[13px] text-muted-foreground">{pdfError || 'PDF 预览加载失败'}</span>
                  <button type="button" onClick={handlePdfRetry} className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs hover:bg-muted/50">
                    <RefreshCw className="size-3.5" /> 重试
                  </button>
                </div>
              )
            ) : isImage ? (
              imageDataUrl ? (
                <div className="relative h-full overflow-hidden">
                <div className="absolute top-2 left-1/2 -translate-x-1/2 z-10 flex items-center gap-2 px-2 py-1 rounded-lg bg-background/80 backdrop-blur-sm border border-border/30 shadow-sm">
                  <button
                    type="button"
                    className="w-6 h-6 rounded border border-border/30 flex items-center justify-center text-sm text-muted-foreground hover:bg-muted/50"
                    onClick={() => imageZoomBy(1 / 1.2)}
                  >−</button>
                  <span className="text-xs text-muted-foreground min-w-[40px] text-center font-mono">{Math.round(imageZoom * 100)}%</span>
                  <button
                    type="button"
                    className="w-6 h-6 rounded border border-border/30 flex items-center justify-center text-sm text-muted-foreground hover:bg-muted/50"
                    onClick={() => imageZoomBy(1.2)}
                  >+</button>
                </div>
                <div className="h-full overflow-hidden p-4 pt-12 flex items-center justify-center">
                  <img
                    ref={bindImageEl}
                    src={imageDataUrl}
                    alt={getFileBaseName(filePath) || 'Image'}
                    draggable={false}
                    onMouseDown={onImagePanMouseDown}
                    className="max-w-full max-h-full object-contain select-none"
                    style={{
                      transform: `translate(${imagePan.x}px, ${imagePan.y}px) scale(${imageZoom})`,
                      transformOrigin: '0 0',
                      cursor: 'grab',
                    }}
                    title="滚动滚轮缩放，拖拽平移"
                  />
                </div>
              </div>
              ) : null
            ) : isDocx ? (
              <OfficePreview
                filePath={filePath}
                fileName={filePath}
                access={fileAccess}
                className="h-full"
                fallback={docxHtml ? (
                  <div className="prose prose-sm dark:prose-invert max-w-none px-4 py-3" dangerouslySetInnerHTML={{ __html: docxHtml }} />
                ) : undefined}
              />
            ) : isOfficePreview ? (
              <OfficePreview
                filePath={filePath}
                fileName={filePath}
                access={fileAccess}
                className="h-full"
                agentPreviewSession={ext === '.pptx' && agentPreviewSession ? { sessionId, ...agentPreviewSession } : undefined}
                fallback={officeFallbackHtml ? (
                  <div className="office-preview-host" dangerouslySetInnerHTML={{ __html: officeFallbackHtml }} />
                ) : undefined}
              />
            ) : isOfvBacked ? (
              <OfvPreview filePath={filePath} access={fileAccess} className="h-full" />
            ) : isLegacyOffice ? null : isHtml && !htmlSourceMode ? (
              htmlPreviewUrl ? (
                <iframe
                  src={htmlPreviewUrl}
                  className="h-full w-full border-0 bg-white"
                  title={`${getFileBaseName(filePath) || 'HTML'} 渲染预览`}
                  sandbox="allow-scripts allow-forms"
                  referrerPolicy="no-referrer"
                />
              ) : (
                <div className="flex h-full items-center justify-center px-6 text-center text-[13px] text-muted-foreground">
                  无法加载 HTML 预览资源，请切换到源码预览或刷新后重试。
                </div>
              )
            ) : isMarkdown ? (
              markdownEditing && markdownSourceMode ? (
                <textarea
                  value={markdownDraft}
                  onChange={(e) => setMarkdownDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      e.preventDefault()
                      exitMarkdownEdit()
                    }
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault()
                      void saveMarkdownEdit()
                    }
                  }}
                  autoFocus
                  spellCheck={false}
                  className="w-full min-h-full resize-none border-0 bg-transparent px-4 py-3 font-mono text-[13px] leading-relaxed text-foreground outline-none focus:outline-none"
                />
              ) : (
                <MarkdownRichEditor
                  value={markdownEditing ? markdownDraft : newContent}
                  editing={markdownEditing}
                  onChange={setMarkdownDraft}
                  onSave={() => void saveMarkdownEdit()}
                  onCancel={exitMarkdownEdit}
                  onRequestEdit={startMarkdownEdit}
                  disabled={markdownSaving}
                  fileAccess={markdownFileAccess}
                  shikiTheme={MD_SHIKI_THEME}
                />
              )
            ) : isPlainTextEditable && markdownEditing ? (
              <textarea
                value={markdownDraft}
                onChange={(e) => setMarkdownDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.preventDefault()
                    exitMarkdownEdit()
                  }
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault()
                    void saveMarkdownEdit()
                  }
                }}
                autoFocus
                spellCheck={false}
                className="w-full min-h-full resize-none border-0 bg-transparent px-4 py-3 font-mono text-[13px] leading-relaxed text-foreground outline-none focus:outline-none"
              />
            ) : newContent ? (
              newContent.length > MAX_PREVIEW_CHARS ? (
                <pre className="p-3 text-[13px] leading-relaxed text-foreground/80 font-mono whitespace-pre-wrap [overflow-wrap:anywhere]">
                  {newContent.slice(0, MAX_PREVIEW_CHARS)}
                  <span className="text-muted-foreground block mt-2">
                    （文件过大，仅显示前 {MAX_PREVIEW_CHARS.toLocaleString()} 字符）
                  </span>
                </pre>
              ) : (
                <div className="h-full">
                  <PierreFile file={pierreFile} options={pierreOptions} />
                </div>
              )
            ) : notFound ? (
              <div className="flex flex-col items-center justify-center h-full gap-1.5 px-4 text-center">
                <FileQuestion className="size-6 text-muted-foreground/60" />
                <span className="text-[13px] text-muted-foreground">文件不存在或无法读取</span>
                <span className="text-[12px] text-muted-foreground/70 font-mono break-all">{filePath}</span>
              </div>
            ) : (
              <pre className="p-3 text-[13px] leading-relaxed text-foreground/80 font-mono whitespace-pre-wrap [overflow-wrap:anywhere]">
                <span className="text-muted-foreground">（文件为空）</span>
              </pre>
            )
          ) : (
            <DiffView oldContent={oldContent} newContent={newContent} filePath={filePath} viewMode={viewMode} />
          )}
        </div>
        {previewSelection && (
          <SelectionActionPopover
            x={previewSelection.rect ? previewSelection.rect.left + previewSelection.rect.width / 2 : 160}
            y={previewSelection.rect?.bottom ?? 80}
            direction="down"
            onAddToAgent={() => {
              setPreviewSelection(null)
              window.getSelection()?.removeAllRanges()
              toast.success('已添加到 Agent 引用')
            }}
            {...(sessions.find((item) => item.id === sessionId)?.agentRuntime === 'pi'
              ? { onOpenExplorationBranch: handleOpenExplorationFromPreview }
              : {})}
          />
        )}
      </div>
    </div>
  )
}
