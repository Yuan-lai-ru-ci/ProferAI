import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateChart, validateFragment } from './visualization-validation'
import { presentVisualization, readVisualization, listVisualizations } from './visualization-records'
import { buildVisualizationExport } from './visualization-export'
import { buildChartOption, chartThemeFromTokens, DEFAULT_CHART_PALETTE, init } from '../../shared/visualization-chart'
import type { VisualizationChartSpec } from '@profer/shared'

const bar: VisualizationChartSpec = { chartType: 'bar', xKey: 'name', series: [{ dataKey: 'value', label: '金额' }], data: [{ name: 'A', value: 20 }, { name: 'B', value: -10 }] }
describe('宿主图表双路径', () => {
  test('标准规格拒绝代码/任意选项/非有限数值/原型与映射错误', () => {
    expect(validateChart(bar)).toEqual(bar)
    for (const invalid of [{ ...bar, option: {} }, { ...bar, data: [{ name: 'A', value: NaN }] }, { ...bar, data: [{ name: 'A', value: 1e100 }] }, { ...bar, xKey: 'missing' }, { ...bar, series: [{ dataKey: 'value' }, { dataKey: 'value' }] }, { ...bar, chartType: 'scatter' }, { ...bar, data: [JSON.parse('{"name":"A","value":1,"__proto__":1}')] }]) expect(() => validateChart(invalid)).toThrow()
    expect(() => validateChart({ ...bar, series: [{ dataKey: 'value', label: '重复' }, { dataKey: 'other', label: '重复' }] })).toThrow('图例')
    expect(() => validateChart({ ...bar, chartType: 'pie', nameKey: 'name', valueKey: 'value', data: [{ name: 'A', value: 1 }, { name: 'A', value: 2 }] })).toThrow('分类')
    expect(() => validateChart({ ...bar, chartType: 'pie', nameKey: 'name', valueKey: 'value' })).toThrow()
  })
  test('严格片段接受局部JS，拒绝不完整HTML和内联事件，但允许带charset的完整HTML', () => {
    // 接受纯片段
    validateFragment('<div id="widget"><button class="btn">切换</button></div><script>document.querySelector("button").addEventListener("click",()=>{});</script>')
    // 接受带 charset 的完整 HTML
    validateFragment('<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body><div id="widget">内容</div></body></html>')
    validateFragment('<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>标题</title></head><body><div id="widget">中文内容</div></body></html>')
    // 拒绝不完整的 HTML 结构（只有部分标签）
    expect(() => validateFragment('<html><body>page</body></html>')).toThrow('完整文档')
    expect(() => validateFragment('<head><meta charset="UTF-8"></head><div id="widget">内容</div>')).toThrow('完整文档')
    expect(() => validateFragment('<!DOCTYPE html><html><body><div id="widget">缺少head和charset</div></body></html>')).toThrow('charset')
    // 拒绝内联事件
    expect(() => validateFragment('<button onclick="alert(1)">Click</button>')).toThrow('内联事件')
    // 拒绝 <main> 标签
    expect(() => validateFragment('<main id="widget">内容</main>')).toThrow('main')
  })
  test('无源文件发布图表，CAS更新可读旧版本，导出包含SVG且转义数据', async () => {
    const base = await mkdtemp(join(tmpdir(), 'profer-native-chart-'))
    const root = join(base, 'session-workspace')
    const store = join(base, 'agent-visualizations', 's1')
    await mkdir(root, { recursive: true })
    try {
      const context = { sessionId: 's1', agentCwd: root, storageDir: store, allowedRoots: [] }
      const first = await presentVisualization({ chart: bar, title: '对比', summary: '数据' }, context, 'call1')
      expect(first.format).toBe('chart')
      expect(first.objects[0]?.id).toBe('row-0')
      expect((await listVisualizations(context))).toHaveLength(1)
      const content = await readVisualization(context, first.id)
      expect(content.html).toBe('')
      expect(content.record.chart).toEqual(bar)
      const second = await presentVisualization({ chart: { ...bar, chartType: 'line' }, title: '更新', summary: '数据', visualizationId: first.id, baseRevision: first.revision }, context, 'call2')
      expect(second.recordVersion).toBe(2)
      expect((await readVisualization(context, first.id, first.revision)).record.chart?.chartType).toBe('bar')
      const exported = buildVisualizationExport({ ...content, record: { ...content.record, title: '<script>alert(1)</script>' } }, {})
      expect(exported).toContain('<svg')
      expect(exported).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
      const filePath = join(root, 'view.html'); await writeFile(filePath, '<div id="widget">Fragment</div>')
      expect((await presentVisualization({ filePath, format: 'fragment', title: '片段', summary: '说明' }, context, 'call3')).format).toBe('fragment')
      await expect(presentVisualization({ chart: bar, filePath, title: '重复', summary: '错误' }, context, 'call4')).rejects.toThrow('只能')
      const revisionFile = join(context.storageDir, second.id, 'revisions', `${second.revision}.json`)
      const json = JSON.parse(await Bun.file(revisionFile).text()); json.chart.data[0].value = 99; await writeFile(revisionFile, JSON.stringify(json))
      await expect(readVisualization(context, first.id, second.revision)).rejects.toThrow('损坏')
    } finally { await rm(base, { recursive: true }) }
  })
  test('四种图表使用成熟引擎生成非空SVG，bar负值不会截断', () => {
    const option = buildChartOption(bar, { foreground: '#111', muted: '#777', border: '#ddd', background: '#fff' })
    expect((option.yAxis as { min?: number }).min).toBeUndefined()
    const theme = { foreground: '#111', muted: '#777', border: '#ddd', background: '#fff' }
    const positive = { ...bar, data: [{ name: 'A', value: 20 }] }
    expect((buildChartOption(positive, theme).yAxis as { min?: number }).min).toBe(0)
    expect((buildChartOption({ ...positive, layout: 'vertical' }, theme).xAxis as { min?: number }).min).toBe(0)
    for (const spec of [bar, { ...bar, chartType: 'line' as const }, { ...bar, chartType: 'pie' as const, nameKey: 'name', valueKey: 'value', data: [{ name: 'A', value: 20 }, { name: 'B', value: 10 }] }, { ...bar, chartType: 'scatter' as const, data: [{ name: 1, value: 20 }, { name: 2, value: 10 }] }]) {
      const chart = init(null, undefined, { renderer: 'svg', ssr: true, width: 600, height: 340 })
      try { chart.setOption(buildChartOption(spec, { foreground: '#111', muted: '#777', border: '#ddd', background: '#fff' })); expect(chart.renderToSVGString()).toContain('<path') } finally { chart.dispose() }
    }
  })

  test('图表系列色跟随主题 token：皮肤覆写 --chart-* 时不再回落默认调色板', () => {
    const ocean = chartThemeFromTokens({ '--chart-1': '205 58% 42%', '--chart-2': '188 55% 38%' })
    const terminal = chartThemeFromTokens({ '--chart-1': '100 40% 52%', '--chart-2': '70 35% 58%' })
    expect(ocean.palette?.[0]).toBe('hsl(205 58% 42%)')
    expect(ocean.palette?.[1]).toBe('hsl(188 55% 38%)')
    expect(terminal.palette?.[0]).toBe('hsl(100 40% 52%)')
    // 皮肤未覆写的槽位仍保留默认兜底值，且两套皮肤确实不同
    expect(ocean.palette?.[7]).toBe(DEFAULT_CHART_PALETTE[7])
    expect(ocean.palette?.[0]).not.toBe(terminal.palette?.[0])
  })

  test('完全无 token 时回落到默认调色板（导出静态页/旧调用方路径）', () => {
    expect(chartThemeFromTokens({}).palette).toEqual([...DEFAULT_CHART_PALETTE])
  })
})
