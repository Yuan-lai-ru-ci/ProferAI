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
import { cn } from '@/lib/utils'
import { agentDiffViewModeAtom, agentDiffRefreshVersionAtom } from '@/atoms/agent-atoms'
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

function getExtension(filePath: string): string {
  const dot = filePath.lastIndexOf('.')
  return dot >= 0 ? filePath.slice(dot).toLowerCase() : ''
}

interface DiffTabContentProps {
  filePath: string
  dirPath: string
  sessionId?: string
  isUntracked?: boolean
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
  const [loading, setLoading] = React.useState(true)
  const [copied, setCopied] = React.useState(false)
  const refreshVersion = useAtomValue(agentDiffRefreshVersionAtom)
  const theme = useAtomValue(resolvedThemeAtom)

  const ext = getExtension(filePath)
  const isMarkdown = previewOnly && MD_EXTS.has(ext)
  const shikiTheme = theme === 'dark' ? 'one-dark-pro' : 'one-light'

  // 切换文件（filePath 或上下文变化）时：清空旧内容并显示 loading
  // refreshVersion 变化时：静默重新拉取并比较，内容相同不更新
  const isInitialLoadRef = React.useRef(true)
  const lastNewContentRef = React.useRef('')
  const lastOldContentRef = React.useRef('')

  React.useEffect(() => {
    let cancelled = false

    // 区分"切文件"（首次/上下文变） 与 "刷新"（仅 refreshVersion 变）
    // 切文件时清空 + loading；刷新时静默对比
    const isContextChange = isInitialLoadRef.current
    if (isContextChange) {
      setLoading(true)
      setOldContent('')
      setNewContent('')
      setHighlightedHtml('')
    }

    async function load() {
      try {
        let content = ''
        let oldContent = ''

        if (previewOnly) {
          // 纯预览模式不响应 refreshVersion，仅首次加载
          if (!isContextChange) return
          const result = await window.electronAPI.resolveAndReadFile(filePath, basePaths)
          if (cancelled) return
          content = result?.content ?? ''
        } else {
          const result = await window.electronAPI.getDiffContents({ dirPath, filePath, gitRoot })
          if (cancelled) return
          content = result?.newContent ?? ''
          oldContent = result?.oldContent ?? ''
        }

        // 内容未变（且不是上下文变化）则跳过 state 更新，避免 Shiki 重高亮抖动
        if (!isContextChange &&
            content === lastNewContentRef.current &&
            oldContent === lastOldContentRef.current) {
          return
        }

        lastNewContentRef.current = content
        lastOldContentRef.current = oldContent
        setOldContent(oldContent)
        setNewContent(content)

        if (previewOnly && !MD_EXTS.has(getExtension(filePath)) && content) {
          const lang = EXT_LANG[getExtension(filePath)] || 'text'
          try {
            const hl = await highlightCode({ code: content, language: lang, theme: shikiTheme })
            if (!cancelled) setHighlightedHtml(hl.html)
          } catch (err) {
            console.error('[DiffTabContent] Shiki highlight failed:', err)
          }
        }
      } catch {
        // 加载失败静默处理
      } finally {
        if (!cancelled && isContextChange) setLoading(false)
        isInitialLoadRef.current = false
      }
    }

    load()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath, dirPath, gitRoot, previewOnly, shikiTheme, basePaths])

  // refreshVersion 单独的 effect：只在 diff 模式下静默对比刷新
  React.useEffect(() => {
    if (previewOnly) return
    if (isInitialLoadRef.current) return // 首次加载已由上面 effect 处理

    let cancelled = false
    async function refresh() {
      try {
        const result = await window.electronAPI.getDiffContents({ dirPath, filePath, gitRoot })
        if (cancelled || !result) return
        const newC = result.newContent ?? ''
        const oldC = result.oldContent ?? ''
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

  // 切换 filePath 等上下文时，标记下次 effect 为初次加载
  React.useEffect(() => {
    isInitialLoadRef.current = true
  }, [filePath, dirPath, gitRoot, previewOnly])

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
          isMarkdown ? (
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
