import React from 'react'
import { Loader2, X } from 'lucide-react'
import { markdownToSafeDisplayHtml } from '@/lib/markdown-rich-text'
import { usePreviewQuotedSelection } from '@/hooks/usePreviewQuotedSelection'
import type { KnowledgeItem, KnowledgeReference } from '@profer/shared'

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
 * Chat 资料预览共用正文；仅传入 agentSessionId 时才允许划词引用。
 * 不传该参数时不会成为新的对话入口。
 */
export function KnowledgePreviewContent({ reference, onClose, agentSessionId }: { reference: KnowledgeReference; onClose?: () => void; agentSessionId?: string }): React.ReactElement {
  const [state, setState] = React.useState<{ loading: boolean; meta: KnowledgeItem | null; text: string; error: string | null }>({ loading: true, meta: null, text: '', error: null })
  const contentRef = React.useRef<HTMLDivElement>(null)

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
    setState({ loading: true, meta: null, text: '', error: null })
    void (async () => {
      try {
        const local = await window.electronAPI.knowledge.getItem(reference.itemId)
        if (local) {
          if (active) setState({ loading: false, meta: local.meta, text: local.text, error: null })
          return
        }
        if (active) setState({ loading: false, meta: null, text: '', error: '资料已删除或正文暂不可读取。' })
      } catch (error) {
        if (active) setState({ loading: false, meta: null, text: '', error: error instanceof Error ? error.message : '加载资料失败。' })
      }
    })()
    return () => { active = false }
  }, [reference])

  const safeDisplayHtml = React.useMemo(() => markdownToSafeDisplayHtml(state.text), [state.text])
  return <div className="flex h-full min-h-0 flex-col">
    {state.meta ? <div className="shrink-0 border-b border-border/40 px-4 py-2.5 text-xs text-muted-foreground"><div className="flex items-center gap-x-3 gap-y-1"><div className="flex min-w-0 flex-1 flex-wrap gap-x-3 gap-y-1"><span>{kindLabel(reference.kind)}</span><span>{reference.origin === 'arxiv' ? '研究资料' : '本地资料'}</span><span>导入于 {formatDate(state.meta.importedAt)}</span></div>{onClose ? <button type="button" aria-label="关闭资料预览" onClick={onClose} className="inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"><X className="size-3.5"/></button> : null}</div></div> : null}
    <div ref={contentRef} className="min-h-0 flex-1 overflow-y-auto">
      {state.loading ? <div className="flex h-full items-center justify-center"><Loader2 className="size-5 animate-spin text-muted-foreground"/></div> : state.error ? <div className="p-5 text-sm text-muted-foreground">{state.error}</div> : <article className="prose prose-sm mx-auto max-w-none p-5 text-foreground/85 [&_pre]:overflow-x-auto [&_pre]:bg-accent/60" dangerouslySetInnerHTML={{ __html: safeDisplayHtml }}/>}
    </div>
  </div>
}
