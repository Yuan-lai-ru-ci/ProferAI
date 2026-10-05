import * as React from 'react'
import { init, buildChartOption, nativeChartHeight, chartThemeFromTokens, type ChartTheme } from '../../../shared/visualization-chart'
import type { VisualizationChartSpec, VisualizationViewState, VisualizationContent, VisualizationQuote } from '@profer/shared'
import { resolveVisualizationQuote } from '@/lib/visualization-bridge'
import { useVisualizationHostTheme } from '@/hooks/useVisualizationHostTheme'

export function NativeVisualizationChart({ spec, content, state, onState, onQuote, onHeight }: { spec: VisualizationChartSpec; content: VisualizationContent; state: VisualizationViewState; onState: (state: VisualizationViewState) => void; onQuote: (quote: VisualizationQuote) => void; onHeight: (height: number) => void }): React.ReactElement {
  const { title, summary } = content.record
  const rootRef = React.useRef<HTMLElement>(null)
  const callbacks = React.useRef({ state, onState, onQuote, content, onHeight })
  callbacks.current = { state, onState, onQuote, content, onHeight }
  const ref = React.useRef<HTMLDivElement>(null)
  const chartRef = React.useRef<ReturnType<typeof init> | null>(null)
  // 主题（含皮肤）由 useVisualizationHostTheme 统一搬运：换肤后 token 落地才发布，不再各自挂 Observer。
  const hostTheme = useVisualizationHostTheme()
  const [theme, setTheme] = React.useState<ChartTheme>(() => chartThemeFromTokens(hostTheme.tokens, hostTheme.fontFamily))
  React.useEffect(() => {
    setTheme(chartThemeFromTokens(hostTheme.tokens, hostTheme.fontFamily))
  }, [hostTheme])
  const height = nativeChartHeight(spec)
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
  const lastOptionRef = React.useRef('')
  React.useEffect(() => {
    // state/spec/theme 的**对象身份**会因父层无关重渲染而变（例如滚动更新候选集合）。
    // 用序列化结果做闸门：内容没变就不重建图表，否则 ECharts 会在每帧整块重绘（看着就是在抖）。
    const option = buildChartOption(spec, theme, state)
    const signature = JSON.stringify([option, theme.palette, theme.barRadius])
    if (signature === lastOptionRef.current) return
    lastOptionRef.current = signature
    chartRef.current?.setOption(option, { notMerge: true, silent: true })
  }, [spec, state, theme])
  React.useLayoutEffect(() => {
    const element = rootRef.current
    if (!element) return
    let lastHeight = 0
    let timer: ReturnType<typeof setTimeout> | null = null
    const publish = () => {
      const height = Math.ceil(element.getBoundingClientRect().height)
      // 高度未变化时跳过
      if (height === lastHeight) return
      // 大幅变化（>32px）立即上报，小幅变化防抖 150ms
      const delta = Math.abs(height - lastHeight)
      if (timer) clearTimeout(timer)
      if (lastHeight === 0 || delta >= 32) {
        lastHeight = height
        callbacks.current.onHeight(height)
      } else {
        timer = setTimeout(() => {
          lastHeight = height
          callbacks.current.onHeight(height)
          timer = null
        }, 150)
      }
    }
    const observer = new ResizeObserver(publish)
    observer.observe(element)
    publish()
    return () => {
      observer.disconnect()
      if (timer) clearTimeout(timer)
    }
  }, [])
  return <section ref={rootRef} data-native-visualization={spec.chartType} className="w-full min-w-0" aria-label={title}>
    <div className="mb-2"><h2 className="text-base font-medium">{title}</h2><p className="text-xs text-muted-foreground">{summary}</p></div>
    <div ref={ref} role="img" aria-label={`${title}：${summary}`} style={{ height }} className="w-full min-w-0" />
    <details className="mt-2 text-xs text-muted-foreground"><summary className="cursor-pointer">查看数据</summary><div className="mt-2 overflow-x-auto"><table className="w-full border-collapse"><thead><tr>{Object.keys(spec.data[0] ?? {}).map((key) => <th key={key} className="border-b border-border px-2 py-1 text-left font-medium">{key}</th>)}</tr></thead><tbody>{spec.data.slice(0, 200).map((row, index) => <tr key={index}>{Object.keys(spec.data[0] ?? {}).map((key) => <td key={key} className="border-b border-border/50 px-2 py-1">{key === Object.keys(spec.data[0] ?? {})[0] ? <button type="button" className="text-foreground hover:underline" onClick={() => { const quote = resolveVisualizationQuote(content, `row-${index}`); if (quote) onQuote(quote) }}>{String(row[key])}</button> : String(row[key])}</td>)}</tr>)}</tbody></table></div></details>
  </section>
}
