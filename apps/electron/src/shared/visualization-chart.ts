import { init, use, type EChartsCoreOption } from 'echarts/core'
import { BarChart, LineChart, PieChart, ScatterChart } from 'echarts/charts'
import { GridComponent, LegendComponent, TooltipComponent, AriaComponent } from 'echarts/components'
import { SVGRenderer } from 'echarts/renderers'
import type { VisualizationChartSpec, VisualizationViewState } from '@profer/shared'

use([BarChart, LineChart, PieChart, ScatterChart, GridComponent, LegendComponent, TooltipComponent, AriaComponent, SVGRenderer])
export { init }

export interface ChartTheme { foreground: string; muted: string; border: string; background: string; fontFamily?: string }
const palette = ['#2992c8', '#bf7396', '#45a582', '#ae8acd', '#d8a541', '#5b9b97', '#b5836e', '#8392c5']

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
    itemStyle: { borderRadius: spec.chartType === 'bar' ? 2 : undefined },
  }))
  return {
    animation: false, color: palette, backgroundColor: 'transparent',
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
