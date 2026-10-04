import * as React from 'react'
import { init, buildChartOption, nativeChartHeight, type ChartTheme } from '../../../shared/visualization-chart'
import type { VisualizationChartSpec, VisualizationViewState, VisualizationContent, VisualizationQuote } from '@profer/shared'
import { resolveVisualizationQuote } from '@/lib/visualization-bridge'

export function NativeVisualizationChart({ spec, content, state, onState, onQuote, onHeight }: { spec: VisualizationChartSpec; content: VisualizationContent; state: VisualizationViewState; onState: (state: VisualizationViewState) => void; onQuote: (quote: VisualizationQuote) => void; onHeight: (height: number) => void }): React.ReactElement {
  const { title, summary } = content.record
  const rootRef = React.useRef<HTMLElement>(null)
  const callbacks = React.useRef({ state, onState, onQuote, content, onHeight })
  callbacks.current = { state, onState, onQuote, content, onHeight }
  const ref = React.useRef<HTMLDivElement>(null)
  const chartRef = React.useRef<ReturnType<typeof init> | null>(null)
  const [theme, setTheme] = React.useState<ChartTheme>(() => readChartTheme())
  const height = nativeChartHeight(spec)
  React.useEffect(() => {
    const publish = () => setTheme(readChartTheme())
    const observer = new MutationObserver(publish)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] })
    return () => observer.disconnect()
  }, [])
  React.useEffect(() => {
    if (!ref.current) return
    const chart = init(ref.current, undefined, { renderer: 'svg' })
    chartRef.current = chart
    const onLegend = (event: unknown) => {
      if (!event || typeof event !== 'object' || !('selected' in event) || !event.selected || typeof event.selected !== 'object') return
      const selected = event.selected as Record<string, boolean>
      callbacks.current.onState({ ...callbacks.current.state, hiddenSeries: Object.entries(selected).filter(([, visible]) => !visible).map(([name]) => name) })
    }
    chart.on('legendselectchanged', onLegend)
    chart.on('click', (event: { dataIndex?: number }) => {
      if (typeof event.dataIndex !== 'number') return
      const quote = resolveVisualizationQuote(callbacks.current.content, `row-${event.dataIndex}`)
      if (quote) callbacks.current.onQuote(quote)
    })
    const resize = new ResizeObserver(() => chart.resize())
    resize.observe(ref.current)
    return () => { chartRef.current = null; chart.off('legendselectchanged', onLegend); resize.disconnect(); chart.dispose() }
  }, [])
  React.useEffect(() => {
    chartRef.current?.setOption(buildChartOption(spec, theme, state), { notMerge: true, silent: true })
  }, [spec, state, theme])
  React.useLayoutEffect(() => {
    const element = rootRef.current
    if (!element) return
    const publish = () => callbacks.current.onHeight(Math.ceil(element.getBoundingClientRect().height))
    const observer = new ResizeObserver(publish)
    observer.observe(element)
    publish()
    return () => observer.disconnect()
  }, [])
  return <section ref={rootRef} data-native-visualization={spec.chartType} className="w-full min-w-0" aria-label={title}>
    <div className="mb-2"><h2 className="text-base font-medium">{title}</h2><p className="text-xs text-muted-foreground">{summary}</p></div>
    <div ref={ref} role="img" aria-label={`${title}：${summary}`} style={{ height }} className="w-full min-w-0" />
    <details className="mt-2 text-xs text-muted-foreground"><summary className="cursor-pointer">查看数据</summary><div className="mt-2 overflow-x-auto"><table className="w-full border-collapse"><thead><tr>{Object.keys(spec.data[0] ?? {}).map((key) => <th key={key} className="border-b border-border px-2 py-1 text-left font-medium">{key}</th>)}</tr></thead><tbody>{spec.data.slice(0, 200).map((row, index) => <tr key={index}>{Object.keys(spec.data[0] ?? {}).map((key) => <td key={key} className="border-b border-border/50 px-2 py-1">{key === Object.keys(spec.data[0] ?? {})[0] ? <button type="button" className="text-foreground hover:underline" onClick={() => { const quote = resolveVisualizationQuote(content, `row-${index}`); if (quote) onQuote(quote) }}>{String(row[key])}</button> : String(row[key])}</td>)}</tr>)}</tbody></table></div></details>
  </section>
}

function readChartTheme(): ChartTheme {
  const style = getComputedStyle(document.documentElement)
  const value = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback
  return { foreground: `hsl(${value('--foreground', '0 0% 10%')})`, muted: `hsl(${value('--muted-foreground', '0 0% 45%')})`, border: `hsl(${value('--border', '0 0% 85%')})`, background: `hsl(${value('--background', '0 0% 100%')})`, fontFamily: style.fontFamily }
}
