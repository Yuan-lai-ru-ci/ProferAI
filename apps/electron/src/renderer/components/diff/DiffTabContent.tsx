/**
 * DiffTabContent — 单文件 Diff 或纯文件预览内容
 *
 * previewOnly=true 时：代码高亮预览（Shiki）或 Markdown 渲染
 * previewOnly=false（默认）：显示 git diff（旧版本 vs 磁盘）
 */

import * as React from 'react'
import { Copy, Check } from 'lucide-react'
import { useAtom, useAtomValue } from 'jotai'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import DOMPurify from 'dompurify'
import { cn } from '@/lib/utils'
import { agentDiffViewModeAtom, agentDiffRefreshVersionAtom, currentAgentSessionIdAtom } from '@/atoms/agent-atoms'
import { resolvedThemeAtom } from '@/atoms/theme'
import { highlightCode } from '@proma/core'
import { DiffView } from './DiffView'

/** 扩展名 → Shiki 语言 ID */
const EXT_LANG: Record<string, string> = {
  '.md': 'markdown', '.markdown': 'markdown',
  '.json': 'json', '.jsonc': 'json', '.json5': 'json',
  '.xml': 'xml', '.html': 'html', '.htm': 'html', '.svg': 'xml',
  '.yaml': 'yaml', '.yml': 'yaml', '.toml': 'toml', '.ini': 'ini', '.env': 'bash',
  '.ts': 'typescript', '.tsx': 'tsx', '.js': 'javascript', '.jsx': 'jsx',
  '.mjs': 'javascript', '.cjs': 'javascript',
  '.py': 'python', '.go': 'go', '.rs': 'rust', '.java': 'java', '.kt': 'kotlin', '.swift': 'swift',
  '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.hpp': 'cpp', '.cs': 'csharp',
  '.sh': 'bash', '.bash': 'bash', '.zsh': 'bash', '.fish': 'fish',
  '.css': 'css', '.scss': 'scss', '.less': 'less',
  '.sql': 'sql', '.rb': 'ruby', '.php': 'php',
  '.diff': 'diff', '.patch': 'diff',
  '.txt': 'text', '.log': 'text', '.csv': 'text',
}

const MD_EXTS = new Set(['.md', '.markdown'])
const PDF_EXTS = new Set(['.pdf'])
const DOCX_EXTS = new Set(['.docx'])
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico'])

/** 将绝对路径转为 proma-file:// URL（保留开头的 /，只编码特殊字符） */
function toPromaFileUrl(absPath: string): string {
  const encoded = absPath.split('/').map(encodeURIComponent).join('/')
  return 'proma-file://' + encoded
}

/** 扩展名 → MIME type */
const EXT_MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp', '.ico': 'image/x-icon',
}

/**
 * 简易 LRU 缓存：保留最近访问的 N 个 entries。
 * key 设计：
 * - diff 模式：`diff:${filePath}@v${refreshVersion}`
 * - preview 模式：`preview:${filePath}`
 * refreshVersion 变化时（agent 写文件、git 突变、窗口聚焦）key 自然变化，
 * 老 entry 不会被命中，最终被 LRU 淘汰；无需主动失效。
 */
type CacheEntry = { oldContent: string; newContent: string }
const CACHE_MAX = 50
const contentCache = new Map<string, CacheEntry>()
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

interface DiffTabContentProps {
  filePath: string
  dirPath: string
  gitRoot?: string
  previewOnly?: boolean
  /** 候选基础目录（previewOnly 模式下用于路径解析） */
  basePaths?: string[]
}

export function DiffTabContent({ filePath, dirPath, gitRoot, previewOnly, basePaths }: DiffTabContentProps): React.ReactElement {
  const [viewMode, setViewMode] = useAtom(agentDiffViewModeAtom)
  const [oldContent, setOldContent] = React.useState('')
  const [newContent, setNewContent] = React.useState('')
  const [highlightedHtml, setHighlightedHtml] = React.useState('')
  const [docxHtml, setDocxHtml] = React.useState('')
  const [pdfHtml, setPdfHtml] = React.useState('')
  const [imagePath, setImagePath] = React.useState('')
  const [imageDataUrl, setImageDataUrl] = React.useState('')
  const [imageZoom, setImageZoom] = React.useState(1)
  const [loading, setLoading] = React.useState(true)
  const [copied, setCopied] = React.useState(false)
  const refreshVersionMap = useAtomValue(agentDiffRefreshVersionAtom)
  const currentSessionId = useAtomValue(currentAgentSessionIdAtom)
  const refreshVersion = refreshVersionMap.get(currentSessionId ?? '') ?? 0
  const theme = useAtomValue(resolvedThemeAtom)

  const ext = getExtension(filePath)
  const isMarkdown = previewOnly && MD_EXTS.has(ext)
  const isPdf = previewOnly && PDF_EXTS.has(ext)
  const isDocx = previewOnly && DOCX_EXTS.has(ext)
  const isImage = previewOnly && IMAGE_EXTS.has(ext)
  const shikiTheme = theme === 'dark' ? 'one-dark-pro' : 'one-light'

  // 上次加载的内容（refreshVersion 触发时用来对比是否变化）
  const lastNewContentRef = React.useRef('')
  const lastOldContentRef = React.useRef('')

  // 主加载 effect：上下文变化（filePath/dirPath/gitRoot/previewOnly）时触发
  // 命中缓存时跳过 loading 闪烁直接渲染；未命中走 IPC 拉取
  React.useEffect(() => {
    let cancelled = false

    // PDF / DOCX 不走文本缓存（HTML 体积大、解析过程也不轻）
    const cacheable = !isPdf && !isDocx && !isImage
    const cacheKey = cacheable
      ? (previewOnly ? `preview:${filePath}` : `diff:${filePath}@v${refreshVersion}`)
      : null
    const cached = cacheKey ? cacheGet(cacheKey) : undefined

    if (cached) {
      // 命中：直接同步渲染，不闪
      lastNewContentRef.current = cached.newContent
      lastOldContentRef.current = cached.oldContent
      setOldContent(cached.oldContent)
      setNewContent(cached.newContent)
      setHighlightedHtml('')
      setDocxHtml('')
      setPdfHtml('')
      setImagePath('')
      setImageDataUrl('')
      setImageZoom(1)
      setLoading(false)
    } else {
      setLoading(true)
      setOldContent('')
      setNewContent('')
      setHighlightedHtml('')
      setDocxHtml('')
      setPdfHtml('')
      setImagePath('')
      setImageDataUrl('')
      setImageZoom(1)
      lastNewContentRef.current = ''
      lastOldContentRef.current = ''
    }

    async function load() {
      try {
        let content = cached?.newContent ?? ''
        let old = cached?.oldContent ?? ''

        if (!cached) {
          if (previewOnly) {
            if (isPdf) {
              const result = await window.electronAPI.preparePdfPreview(filePath, basePaths)
              if (cancelled) return
              setPdfHtml(result?.html ?? '')
              return
            }
            if (isImage) {
              const resolved = await window.electronAPI.resolveFilePath(filePath, basePaths)
              if (cancelled || !resolved) { setImagePath(''); return }
              setImagePath(resolved)
              try {
                const b64 = await window.electronAPI.readAttachment(resolved)
                if (cancelled) return
                const mime = EXT_MIME[ext] || 'image/png'
                setImageDataUrl(`data:${mime};base64,${b64}`)
              } catch {
                setImageDataUrl('')
              }
              return
            }
            if (isDocx) {
              const result = await window.electronAPI.docxToHtml(filePath, basePaths)
              if (cancelled) return
              setDocxHtml(DOMPurify.sanitize(result?.html ?? ''))
              return
            }
            const result = await window.electronAPI.resolveAndReadFile(filePath, basePaths)
            if (cancelled) return
            content = result?.content ?? ''
          } else {
            const result = await window.electronAPI.getDiffContents({ dirPath, filePath, gitRoot })
            if (cancelled) return
            content = result?.newContent ?? ''
            old = result?.oldContent ?? ''
          }

          lastNewContentRef.current = content
          lastOldContentRef.current = old
          setOldContent(old)
          setNewContent(content)

          if (cacheKey) cacheSet(cacheKey, { oldContent: old, newContent: content })
        }

        if (previewOnly && !MD_EXTS.has(getExtension(filePath)) && content) {
          const lang = EXT_LANG[getExtension(filePath)] || 'text'
          try {
            const hl = await highlightCode({ code: content, language: lang, theme: shikiTheme })
            if (!cancelled) setHighlightedHtml(DOMPurify.sanitize(hl.html))
          } catch (err) {
            console.error('[DiffTabContent] Shiki highlight failed:', err)
          }
        }
      } catch {
        // 加载失败静默处理
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath, dirPath, gitRoot, previewOnly, shikiTheme, basePaths, isPdf, isDocx, isImage])

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
        const result = await window.electronAPI.getDiffContents({ dirPath, filePath, gitRoot })
        if (cancelled || !result) return
        const newC = result.newContent ?? ''
        const oldC = result.oldContent ?? ''
        // 用新 refreshVersion 写入缓存，让后续切走再切回来能命中
        cacheSet(`diff:${filePath}@v${refreshVersion}`, { oldContent: oldC, newContent: newC })
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
  }, [refreshVersion, previewOnly, filePath, dirPath, gitRoot])

  const handleCopy = React.useCallback(async () => {
    try {
      await navigator.clipboard.writeText(newContent)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // 复制失败
    }
  }, [newContent])

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-3 py-1.5 flex-shrink-0">
        <span className="text-[12px] text-foreground/60 truncate" title={filePath}>
          {filePath}
        </span>

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

        <button type="button" onClick={handleCopy}
          className={cn("p-1 rounded hover:bg-foreground/[0.06] text-foreground/40 hover:text-foreground/60 shrink-0", previewOnly && "ml-auto")}
          title="复制文件内容">
          {copied ? <Check className="size-3.5 text-green-500" /> : <Copy className="size-3.5" />}
        </button>
      </div>

      <div className="flex-1 overflow-auto scrollbar-thin relative">
        {loading ? (
          <div className="flex items-center justify-center h-full text-muted-foreground text-[12px]">加载中...</div>
        ) : previewOnly ? (
          isPdf ? (
            pdfHtml ? (
              <iframe
                srcDoc={pdfHtml}
                className="w-full h-full border-0"
                title={filePath.split('/').pop() || 'PDF'}
                sandbox="allow-scripts"
              />
            ) : (
              <div className="flex items-center justify-center h-full text-muted-foreground text-[12px]">无法加载 PDF</div>
            )
          ) : isImage ? (
            imageDataUrl ? (
              <div className="relative h-full">
                <div className="absolute top-2 left-1/2 -translate-x-1/2 z-10 flex items-center gap-2 px-2 py-1 rounded-lg bg-background/80 backdrop-blur-sm border border-border/30 shadow-sm">
                  <button
                    type="button"
                    className="w-6 h-6 rounded border border-border/30 flex items-center justify-center text-sm text-muted-foreground hover:bg-muted/50"
                    onClick={() => setImageZoom((z) => Math.max(0.25, z / 1.5))}
                  >−</button>
                  <span className="text-xs text-muted-foreground min-w-[40px] text-center font-mono">{Math.round(imageZoom * 100)}%</span>
                  <button
                    type="button"
                    className="w-6 h-6 rounded border border-border/30 flex items-center justify-center text-sm text-muted-foreground hover:bg-muted/50"
                    onClick={() => setImageZoom((z) => Math.min(5, z * 1.5))}
                  >+</button>
                </div>
                <div className="flex items-center justify-center h-full overflow-auto p-4 pt-12">
                  <img
                    src={imageDataUrl}
                    alt={filePath.split('/').pop() || 'Image'}
                    className="object-contain"
                    style={{ width: `${imageZoom * 100}%`, maxWidth: 'none' }}
                  />
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-center h-full text-muted-foreground text-[12px]">{imagePath ? '加载中...' : '无法加载图片'}</div>
            )
          ) : isDocx ? (
            docxHtml ? (
              <div
                className="prose prose-sm dark:prose-invert max-w-none px-4 py-3"
                dangerouslySetInnerHTML={{ __html: docxHtml }}
              />
            ) : (
              <div className="flex items-center justify-center h-full text-muted-foreground text-[12px]">无法加载 DOCX</div>
            )
          ) : isMarkdown ? (
            <div className="prose prose-sm dark:prose-invert max-w-none px-4 py-3">
              <Markdown remarkPlugins={[remarkGfm]}>{newContent}</Markdown>
            </div>
          ) : highlightedHtml ? (
            <div
              className="p-3 text-[13px] leading-relaxed [&_pre]:!bg-transparent [&_pre]:!m-0 [&_pre]:!p-0 [&_code]:!text-[13px]"
              dangerouslySetInnerHTML={{ __html: highlightedHtml }}
            />
          ) : (
            <pre className="p-3 text-[13px] leading-relaxed text-foreground/80 font-mono whitespace-pre-wrap break-words">
              {newContent || <span className="text-muted-foreground">（文件为空）</span>}
            </pre>
          )
        ) : (
          <DiffView oldContent={oldContent} newContent={newContent} filePath={filePath} viewMode={viewMode} />
        )}
      </div>
    </div>
  )
}
