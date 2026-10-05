import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { Download, RotateCcw } from 'lucide-react'
import type { VisualizationRecord, VisualizationContent, VisualizationViewState, VisualizationQuote } from '@profer/shared'
import { visualizationViewStatesAtom, visualizationHeightsAtom } from '@/atoms/visualization-atoms'
import { visualizationStateKey } from '@/lib/visualization-lifecycle'
import { quotedSelectionMapAtom } from '@/atoms/preview-atoms'
import { useOptionalConversationScroll } from '@/components/ai-elements/conversation-scroll'
import { VisualizationHost } from './VisualizationHost'

const NativeVisualizationChart = React.lazy(() => import('./NativeVisualizationChart').then((module) => ({ default: module.NativeVisualizationChart })))

export function VisualizationResultInline({ record, sessionId }: { record: VisualizationRecord; sessionId?: string | null }): React.ReactElement {
  const owner = sessionId ?? record.sessionId
  const key = visualizationStateKey(owner, record.id, record.revision)
  const ref = React.useRef<HTMLDivElement>(null)
  const scroll = useOptionalConversationScroll()
  const heights = useAtomValue(visualizationHeightsAtom)
  const setHeights = useSetAtom(visualizationHeightsAtom)
  const height = heights.get(key) ?? 240
  const states = useAtomValue(visualizationViewStatesAtom)
  const setStates = useSetAtom(visualizationViewStatesAtom)
  const setQuotes = useSetAtom(quotedSelectionMapAtom)
  const [content, setContent] = React.useState<VisualizationContent | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [reload, setReload] = React.useState(0)
  const [selectedQuote, setSelectedQuote] = React.useState<VisualizationQuote | null>(null)
  const [loadedStateKey, setLoadedStateKey] = React.useState<string | null>(null)
  const pendingStateRef = React.useRef<VisualizationViewState | null>(null)
  const saveTimerRef = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // 组件挂载后就激活，不再基于滚动位置动态管理
  const active = true

  const state = states.get(key) ?? {}

  // 加载视图状态
  React.useEffect(() => {
    let cancelled = false
    setLoadedStateKey(null)
    setError(null)
    setSelectedQuote(null)
    window.electronAPI.readVisualizationViewState({ sessionId: owner, id: record.id, revision: record.revision }).then((restored) => {
      if (cancelled) return
      setStates((previous) => {
        if (previous.has(key)) return previous
        const next = new Map(previous); next.set(key, restored)
        while (next.size > 64) next.delete(next.keys().next().value!)
        return next
      })
      setLoadedStateKey(key)
    }).catch((reason: unknown) => { if (!cancelled) setError(reason instanceof Error ? reason.message : '恢复可视化状态失败') })
    return () => { cancelled = true }
  }, [key, owner, record.id, record.revision, reload, setStates])

  // 加载可视化内容（组件挂载后立即加载，只加载一次）
  React.useEffect(() => {
    let cancelled = false
    setError(null)
    window.electronAPI.readVisualization({ sessionId: owner, id: record.id, revision: record.revision }).then((result) => {
      if (!cancelled) setContent(result)
    }).catch((reason: unknown) => { if (!cancelled) setError(reason instanceof Error ? reason.message : '加载可视化失败') })
    return () => { cancelled = true }
  }, [owner, record.id, record.revision, reload])

  const savePendingState = React.useCallback(() => {
    const pending = pendingStateRef.current
    if (!pending) return
    pendingStateRef.current = null
    void window.electronAPI.saveVisualizationViewState({ sessionId: owner, id: record.id, revision: record.revision, state: pending }).catch((reason: unknown) => console.error('[可视化] 保存视图状态失败:', reason))
  }, [owner, record.id, record.revision])

  React.useEffect(() => () => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    savePendingState()
  }, [savePendingState])

  const updateState = (nextState: VisualizationViewState) => {
    pendingStateRef.current = nextState
    setStates((previous) => { const next = new Map(previous); next.delete(key); next.set(key, nextState); while (next.size > 64) next.delete(next.keys().next().value!); return next })
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(savePendingState, 250)
  }
  const finishRef = React.useRef<(() => void) | null>(null)
  React.useLayoutEffect(() => { finishRef.current?.(); finishRef.current = null }, [height])
  React.useEffect(() => () => { finishRef.current?.() }, [])
  const updateHeight = (nextHeight: number) => {
    if (nextHeight === height) return
    finishRef.current?.()
    finishRef.current = scroll?.beginLayout(ref.current ?? undefined) ?? null
    setHeights((previous) => {
      const next = new Map(previous); next.delete(key); next.set(key, nextHeight)
      while (next.size > 64) next.delete(next.keys().next().value!)
      return next
    })
  }
  const quote = () => {
    if (!selectedQuote || owner !== record.sessionId) return
    setQuotes((previous) => {
      const next = new Map(previous)
      next.set(owner, { sourceType: 'visualization', filePath: '', sourceLabel: `${record.title} · ${selectedQuote.label}`, text: selectedQuote.text, visualization: selectedQuote, capturedAt: Date.now() })
      return next
    })
  }
  return <section ref={ref} data-visualization-id={record.id} aria-label={record.title} className="my-4 min-w-0">
    <div className="flex items-center justify-between gap-2 pb-2 text-xs text-muted-foreground/60">
      <span className="min-w-0 truncate">{record.format === 'chart' ? '图表' : record.title}</span>
      <button type="button" aria-label="导出 HTML" title="导出 HTML" onClick={() => {
        void (async () => {
          await window.electronAPI.saveVisualizationViewState({ sessionId: owner, id: record.id, revision: record.revision, state })
          await window.electronAPI.exportVisualization({ sessionId: owner, id: record.id, revision: record.revision })
        })().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : '导出失败'))
      }} className="rounded p-1 text-muted-foreground/60 hover:bg-muted hover:text-foreground"><Download className="size-3.5" /></button>
    </div>
    <div style={{ height }} className="relative">
      {content && !error ? content.record.chart ? <React.Suspense fallback={<p className="py-6 text-sm text-muted-foreground">正在加载图表…</p>}><NativeVisualizationChart key={key} spec={content.record.chart} content={content} state={state} onState={updateState} onQuote={setSelectedQuote} onHeight={updateHeight} /></React.Suspense> : <VisualizationHost content={content} state={state} onState={updateState} onQuote={setSelectedQuote} onInteraction={() => scroll?.pause()} onError={setError} onHeight={updateHeight} onWheel={(_, deltaY) => {
        const viewport = scroll?.scrollRef.current
        if (viewport) scroll?.navigate(viewport.scrollTop + deltaY, false)
      }} className="block h-full w-full border-0" /> : <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="max-w-lg text-sm text-muted-foreground">{record.summary}</p>
        {error ? <><p role="alert" className="text-xs text-destructive">{error}</p><button type="button" onClick={() => { setError(null); setReload((value) => value + 1) }} className="flex items-center gap-1 text-xs"><RotateCcw className="size-3" />重新加载</button></> : <p className="text-xs text-muted-foreground">正在加载交互视图…</p>}
      </div>}
    </div>
    {selectedQuote && <div className="flex items-center justify-between gap-2 pt-2 text-xs"><span className="truncate text-muted-foreground">已选中：{selectedQuote.label}</span><button type="button" onClick={quote} className="shrink-0 rounded bg-muted px-3 py-1">引用到会话</button></div>}
  </section>
}
