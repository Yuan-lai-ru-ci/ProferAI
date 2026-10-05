/**
 * 宿主主题 token 契约：名单、值白名单、图表主题推导与导出页的同步行为。
 *
 * 这些用例保护的是「颜色跟随主题/皮肤」这条链路的可搬运性——只要某个值在边界上被
 * 悄悄丢掉（例如长度值被当成非法颜色、皮肤换了系列色但图表仍用硬编码调色板），
 * 用户看到的就是「换肤后颜色不跟随」。
 */
import { describe, expect, test } from 'bun:test'
import {
  VISUALIZATION_CHART_TOKEN_NAMES,
  VISUALIZATION_FRAGMENT_TOKEN_NAMES,
  VISUALIZATION_THEME_TOKEN_NAMES,
  collectVisualizationThemeTokens,
  normalizeVisualizationTheme,
  serializeVisualizationThemeCss,
} from '../../shared/visualization-theme'
import { DEFAULT_CHART_PALETTE, chartThemeFromTokens } from '../../shared/visualization-chart'
import { buildVisualizationExport } from './visualization-export'
import type { VisualizationContent } from '@profer/shared'

describe('可视化主题 token 契约', () => {
  test('名单覆盖片段可见 token 与图表系列色，且没有重复项', () => {
    expect(VISUALIZATION_THEME_TOKEN_NAMES).toEqual([
      ...VISUALIZATION_FRAGMENT_TOKEN_NAMES,
      ...VISUALIZATION_CHART_TOKEN_NAMES,
    ])
    expect(new Set(VISUALIZATION_THEME_TOKEN_NAMES).size).toBe(VISUALIZATION_THEME_TOKEN_NAMES.length)
  })

  test('normalize 只留名单内的键，并挡住 CSS 语法与 URL', () => {
    expect(normalizeVisualizationTheme({
      '--background': '0 0% 100%',
      '--radius': '0.625rem',
      '--chart-1': 'hsl(200 66% 44%)',
      '--evil': 'url(https://evil.test/x.png)',
      '--foreground': 'red; background:url(http://evil)',
      '--muted': 'red} body{display:none',
      '--accent': 'x'.repeat(200),
      '--border': "red'",
    })).toEqual({
      '--background': '0 0% 100%',
      '--radius': '0.625rem',
      '--chart-1': 'hsl(200 66% 44%)',
    })
  })

  test('collect 只收有值的 token（未定义项留给片段自己的 var() fallback）', () => {
    const source = {
      getPropertyValue: (name: string) => ({ '--foreground': ' 0 0% 98% ', '--muted': '', '--chart-3': '158 45% 58%' })[name] ?? '',
    }
    expect(collectVisualizationThemeTokens(source)).toEqual({ '--foreground': '0 0% 98%', '--chart-3': '158 45% 58%' })
  })

  test('serializeVisualizationThemeCss 键序固定、可安全拼进导出页的 :root{}', () => {
    expect(serializeVisualizationThemeCss({ '--muted': '0 0% 20%', '--background': '0 0% 7%', '--evil': 'x' }))
      .toBe('--background:0 0% 7%;--muted:0 0% 20%')
    expect(serializeVisualizationThemeCss(null)).toBe('')
  })

  test('图表主题从 token 推导：三元组补 hsl()、完整颜色原样、系列色可被皮肤覆写', () => {
    const theme = chartThemeFromTokens({ '--foreground': '0 0% 98%', '--background': '#0b1020', '--chart-1': '150 40% 60%' })
    expect(theme.foreground).toBe('hsl(0 0% 98%)')
    expect(theme.background).toBe('#0b1020')
    expect(theme.palette?.[0]).toBe('hsl(150 40% 60%)')
    expect(theme.palette?.[1]).toBe(DEFAULT_CHART_PALETTE[1])
    expect(theme.palette).toHaveLength(DEFAULT_CHART_PALETTE.length)
  })

  test('没有宿主主题时图表回落默认调色板（程序化导出、旧调用方）', () => {
    const theme = chartThemeFromTokens({})
    expect([...(theme.palette ?? [])]).toEqual([...DEFAULT_CHART_PALETTE])
    expect(chartThemeFromTokens({}, 'Inter').fontFamily).toBe('Inter')
  })

  test('柱子圆角跟随主题圆角节奇（直角皮肤 → 0，不写死 2px）', () => {
    expect(chartThemeFromTokens({ '--radius': '10px' }).barRadius).toBe(2)
    expect(chartThemeFromTokens({ '--radius': '0.625rem' }).barRadius).toBe(2)
    expect(chartThemeFromTokens({ '--radius': '0px' }).barRadius).toBe(0)
    expect(chartThemeFromTokens({ '--radius': '2px' }).barRadius).toBe(0)
    expect(chartThemeFromTokens({}).barRadius).toBe(2)
    expect(chartThemeFromTokens({ '--radius': '0.625rem' }).barRadius).toBe(chartThemeFromTokens({}).barRadius!)
  })

  test('导出页把当前主题（含皮肤）烘进静态文件，缺省仍走浅色基线', () => {
    const content: VisualizationContent = {
      html: '<div id="widget"><p data-profer-caption>说明</p></div>',
      record: {
        schemaVersion: 1, id: 'viz-1', sessionId: 's1', toolCallId: 'call-1', title: '标题', kind: 'explanation',
        revision: 'r1', recordVersion: 1, summary: '摘要', objects: [], createdAt: 1, updatedAt: 1,
      },
    }
    const dark = buildVisualizationExport(content, {}, { '--background': '0 0% 7%', '--radius': '2px', '--evil': 'url(x)' })
    expect(dark).toContain('--background:0 0% 7%')
    expect(dark).toContain('--radius:2px')
    expect(dark).not.toContain('--evil')
    const fallback = buildVisualizationExport(content, {})
    expect(fallback).toContain('--background:0 0% 100%')
    expect(fallback).not.toContain('--background:0 0% 7%')
  })
})
