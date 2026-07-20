import React from 'react'
import { Loader2, X } from 'lucide-react'
import { markdownToSafeDisplayHtml } from '@/lib/markdown-rich-text'
import { usePreviewQuotedSelection } from '@/hooks/usePreviewQuotedSelection'
import type { KnowledgeItem, KnowledgeReference, PaperWorkbenchRecord } from '@profer/shared'

export const KNOWLEDGE_PREVIEW_EVENT = 'profer:knowledge-preview'

export function openKnowledgePreview(reference: KnowledgeReference): void {
  window.dispatchEvent(new CustomEvent<KnowledgeReference>(KNOWLEDGE_PREVIEW_EVENT, { detail: reference }))
}

function kindLabel(kind: KnowledgeReference['kind']): string {
  return ({ pdf: 'PDF', word: 'Word', wps: 'WPS', presentation: '演示文稿', spreadsheet: '表格', markdown: 'Markdown', text: '文本' } as Record<string, string>)[kind] ?? '资料'
}

function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'short', day: 'numeric' }).format(timestamp)
}

/**
 * Agent 右侧资料预览共用正文；仅传入 agentSessionId 时才允许划词引用。
 * 知识库首页和 Chat 预览不传该参数，因此不会成为新的对话入口。
 */
export function KnowledgePreviewContent({ reference, onClose, agentSessionId }: { reference: KnowledgeReference; onClose?: () => void; agentSessionId?: string }): React.ReactElement {
  const [state, setState] = React.useState<{ loading: boolean; meta: KnowledgeItem | null; text: string; record: PaperWorkbenchRecord | null; error: string | null }>({ loading: true, meta: null, text: '', record: null, error: null })
  const contentRef = React.useRef<HTMLDivElement>(null)
  const scrollTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  usePreviewQuotedSelection({
    containerRef: contentRef,
    sessionId: agentSessionId,
    filePath: `知识库 · ${reference.title}`,
    sourceType: 'knowledge-preview',
    sourceLabel: `知识库 · ${reference.title}`,
    enabled: Boolean(agentSessionId),
  })

  React.useEffect(() => {
    let active = true
    setState({ loading: true, meta: null, text: '', record: null, error: null })
    void (async () => {
      try {
        const [local, workbench] = await Promise.all([
          window.electronAPI.knowledge.getItem(reference.itemId),
          window.electronAPI.kb.getWorkbenchState(),
        ])
        if (local) {
          if (active) setState({ loading: false, meta: local.meta, text: local.text, record: workbench.records[reference.itemId] ?? null, error: null })
          return
        }
        if (reference.origin === 'arxiv') {
          const legacy = await window.electronAPI.kb.getPaper(reference.itemId)
          if (legacy && active) {
            setState({ loading: false, meta: null, text: legacy.markdown, record: workbench.records[reference.itemId] ?? null, error: null })
            return
          }
        }
        if (active) setState({ loading: false, meta: null, text: '', record: null, error: '资料已删除或正文暂不可读取。' })
      } catch (error) {
        if (active) setState({ loading: false, meta: null, text: '', record: null, error: error instanceof Error ? error.message : '加载资料失败。' })
      }
    })()
    return () => { active = false; if (scrollTimer.current) clearTimeout(scrollTimer.current) }
  }, [reference])

  const onScroll = (event: React.UIEvent<HTMLDivElement>) => {
    if (scrollTimer.current) clearTimeout(scrollTimer.current)
    const element = event.currentTarget
    const progress = Math.max(0, Math.min(1, element.scrollTop / Math.max(1, element.scrollHeight - element.clientHeight)))
    scrollTimer.current = setTimeout(() => {
      void window.electronAPI.kb.updateWorkbenchRecord(reference.itemId, { readingProgress: progress })
        .then((record) => setState((current) => ({ ...current, record })))
        .catch(() => {})
    }, 600)
  }

  const progress = Math.round((state.record?.readingProgress ?? 0) * 100)
  const safeDisplayHtml = React.useMemo(() => markdownToSafeDisplayHtml(state.text), [state.text])
  return <div className="flex h-full min-h-0 flex-col">
    {state.meta ? <div className="shrink-0 border-b border-border/40 px-4 py-2.5 text-xs text-muted-foreground"><div className="flex items-center gap-x-3 gap-y-1"><div className="flex min-w-0 flex-1 flex-wrap gap-x-3 gap-y-1"><span>{kindLabel(reference.kind)}</span><span>{reference.origin === 'arxiv' ? '研究资料' : '本地资料'}</span><span>导入于 {formatDate(state.meta.importedAt)}</span><span>已阅读 {progress}%</span></div>{onClose ? <button type="button" aria-label="关闭资料预览" onClick={onClose} className="inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"><X className="size-3.5"/></button> : null}</div><div className="mt-2 h-1 overflow-hidden rounded bg-accent"><div className="h-full bg-primary transition-[width]" style={{ width: `${progress}%` }}/></div></div> : null}
    <div ref={contentRef} className="min-h-0 flex-1 overflow-y-auto" onScroll={onScroll}>
      {state.loading ? <div className="flex h-full items-center justify-center"><Loader2 className="size-5 animate-spin text-muted-foreground"/></div> : state.error ? <div className="p-5 text-sm text-muted-foreground">{state.error}</div> : <article className="prose prose-sm mx-auto max-w-none p-5 text-foreground/85 [&_pre]:overflow-x-auto [&_pre]:bg-accent/60" dangerouslySetInnerHTML={{ __html: safeDisplayHtml }}/>}
    </div>
  </div>
}
