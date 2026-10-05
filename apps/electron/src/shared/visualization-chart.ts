import { init, use, type EChartsCoreOption } from 'echarts/core'
import { BarChart, LineChart, PieChart, ScatterChart } from 'echarts/charts'
import { GridComponent, LegendComponent, TooltipComponent, AriaComponent } from 'echarts/components'
import { SVGRenderer } from 'echarts/renderers'
import type { VisualizationChartSpec, VisualizationViewState } from '@profer/shared'

use([BarChart, LineChart, PieChart, ScatterChart, GridComponent, LegendComponent, TooltipComponent, AriaComponent, SVGRenderer])
export { init }

export interface ChartTheme {
  foreground: string
  muted: string
  border: string
  background: string
  fontFamily?: string
  /** 系列色；缺省用 DEFAULT_CHART_PALETTE（宿主未提供 `--chart-N` 时的兼容路径） */
  palette?: readonly string[]
  /** 柱子圆角（px）；由 `--radius` 推导，直角皮肤的 0 会让图表也变直角 */
  barRadius?: number
}

/**
 * 系列色兜底值：只在宿主没有提供 `--chart-1..8` 时使用（导出静态页、旧调用方）。
 * 正常路径由 `chartThemeFromTokens` 从主题 token 里取——图表配色必须跟随主题与皮肤。
 */
export const DEFAULT_CHART_PALETTE = ['#2992c8', '#bf7396', '#45a582', '#ae8acd', '#d8a541', '#5b9b97', '#b5836e', '#8392c5'] as const

/**
 * 把宿主 token（HSL 三元组或完整颜色）转成图表主题。
 *
 * token 取值口径与 CSS 侧一致：`hsl(var(--x))` 里的三元组直接用，已经是完整颜色的原样使用。
 * 这样默认主题、内置皮肤、用户自定义皮肤都走同一条路径，图表不会停在硬编码调色板上。
 */
export function chartThemeFromTokens(tokens: Record<string, string | undefined> = {}, fontFamily?: string): ChartTheme {
  const color = (name: string, fallback: string) => themeColor(tokens[name], fallback)
  return {
    foreground: color('--foreground', '#171717'),
    muted: color('--muted-foreground', '#737373'),
    border: color('--border', '#e5e5e5'),
    background: color('--background', '#ffffff'),
    fontFamily,
    palette: DEFAULT_CHART_PALETTE.map((fallback, index) => themeColor(tokens[`--chart-${index + 1}`], fallback)),
    barRadius: barRadiusFromTokens(tokens['--radius']),
  }
}

/**
 * 柱子圆角跟随主题的圆角节奇，不写死：默认主题（`--radius: 10px`）得 2px（与旧观感一致），
 * 直角皮肤（terminal-dark 探针得到 `0px`）得 0。取不到长度值时保留 2px（旧行为）。
 */
function barRadiusFromTokens(radius: string | undefined): number {
  const px = lengthToPx(radius)
  if (px === null) return 2
  return Math.max(0, Math.min(4, Math.round(px / 5)))
}

/** `--radius` 可能是 px（宿主探针）也可能是 rem（导出路径的原始 token）；rem 按 16px 根字号换算 */
function lengthToPx(value: string | undefined): number | null {
  const trimmed = value?.trim()
  if (!trimmed) return null
  const match = /^(\d+(?:\.\d+)?)(px|rem|em)?$/.exec(trimmed)
  if (!match) return null
  const amount = Number.parseFloat(match[1]!)
  if (!Number.isFinite(amount)) return null
  return match[2] === 'rem' || match[2] === 'em' ? amount * 16 : amount
}

function themeColor(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim()
  if (!trimmed) return fallback
  // 完整颜色（#hex / hsl(...) / rgb(...) / 命名色）原样用；HSL 三元组补上 hsl() 包装。
  if (trimmed.startsWith('#') || trimmed.includes('(') || /^[a-z]+$/i.test(trimmed)) return trimmed
  return `hsl(${trimmed})`
}

/** 只由宿主构造图表 option；模型不能传入 formatter、代码或任意库选项。 */
export function buildChartOption(spec: VisualizationChartSpec, theme: ChartTheme, state: VisualizationViewState = {}): EChartsCoreOption {
  const horizontal = spec.chartType === 'bar' && spec.layout === 'vertical'
  const categories = spec.data.map((row) => String(row[spec.xKey ?? spec.nameKey ?? ''] ?? ''))
  const axis = { axisLine: { lineStyle: { color: theme.border } }, axisTick: { show: false }, axisLabel: { color: theme.muted, fontSize: 12, hideOverlap: true }, nameTextStyle: { color: theme.muted }, splitLine: { lineStyle: { color: theme.border } } }
  const hidden = Array.isArray(state.hiddenSeries) ? state.hiddenSeries.filter((value): value is string => typeof value === 'string') : []
  const names = spec.chartType === 'pie' ? spec.data.map((row) => String(row[spec.nameKey!])) : spec.series.map((item) => item.label ?? item.dataKey)
  const values = spec.data.flatMap((row) => spec.series.map((item) => Number(row[item.dataKey])))
  const hasNegative = values.some((value) => value < 0)
  const zeroBaseline = spec.chartType === 'bar' && !hasNegative ? { min: 0 } : {}
  const series = spec.chartType === 'pie' ? [{
    type: 'pie', radius: ['0%', '62%'], center: ['50%', '45%'], avoidLabelOverlap: true,
    label: { show: false }, emphasis: { label: { show: true, color: theme.foreground } },
    tooltip: { valueFormatter: (value: unknown) => `${spec.series[0]?.valuePrefix ?? ''}${String(value)}${spec.series[0]?.valueSuffix ?? ''}` },
    data: spec.data.map((row) => ({ name: String(row[spec.nameKey!]), value: row[spec.valueKey!] })),
  }] : spec.series.map((item) => ({
    type: spec.chartType, name: item.label ?? item.dataKey,
    data: spec.data.map((row) => spec.chartType === 'scatter' ? [row[spec.xKey!], row[item.dataKey]] : row[item.dataKey]),
    symbolSize: 9, showSymbol: spec.data.length <= 40, connectNulls: false,
    barMaxWidth: 40,
    tooltip: { valueFormatter: (value: unknown) => `${item.valuePrefix ?? ''}${String(value)}${item.valueSuffix ?? ''}` },
    itemStyle: { borderRadius: spec.chartType === 'bar' ? (theme.barRadius ?? 2) : undefined },
  }))
  return {
    animation: false, color: [...(theme.palette ?? DEFAULT_CHART_PALETTE)], backgroundColor: 'transparent',
    textStyle: { color: theme.foreground, fontFamily: theme.fontFamily, fontSize: 12 },
    aria: { enabled: true, decal: { show: true } },
    tooltip: { trigger: spec.chartType === 'line' ? 'axis' : 'item', renderMode: 'richText', confine: true, backgroundColor: theme.background, borderColor: theme.border, textStyle: { color: theme.foreground } },
    legend: { bottom: 0, type: 'scroll', textStyle: { color: theme.muted }, selected: Object.fromEntries(names.map((name) => [name, !hidden.includes(name)])) },
    ...(spec.chartType === 'pie' ? {} : {
      grid: { left: 12, right: 16, top: 12, bottom: 52, outerBoundsMode: 'same', outerBoundsContain: 'all' },
      xAxis: { ...axis, type: horizontal || spec.chartType === 'scatter' ? 'value' : 'category', ...(horizontal || spec.chartType === 'scatter' ? {} : { data: categories }), ...(spec.chartType === 'scatter' ? { name: spec.xAxisLabel, nameLocation: 'middle', nameGap: 26 } : {}), ...(spec.chartType === 'bar' && horizontal ? zeroBaseline : {}) },
      yAxis: { ...axis, type: horizontal ? 'category' : 'value', ...(horizontal ? { data: categories, inverse: true } : {}), ...(spec.chartType === 'bar' && !horizontal ? zeroBaseline : {}) },
    }),
    series,
  }
}

export function nativeChartHeight(spec: VisualizationChartSpec): number {
  return spec.chartType === 'bar' && spec.layout === 'vertical' ? Math.min(800, Math.max(280, spec.data.length * 34 + 70)) : 340
}
