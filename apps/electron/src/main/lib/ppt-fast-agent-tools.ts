import PptxGenJS from 'pptxgenjs'
import { existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

type ToolResult = { content: Array<{ type: 'text'; text: string }>; details?: unknown }

export interface FastPptSlide {
  title: string
  bullets?: string[]
  chart?: { labels: string[]; values: number[]; title?: string }
  notes?: string[]
}

export interface FastPptInput {
  title: string
  slides: FastPptSlide[]
  styleId?: 'academic-editorial' | 'profer-cloud-dancer'
  outputName?: string
}

export interface FastPptContext { agentCwd: string }

function response(payload: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], details: payload }
}

function safeOutputName(value: string | undefined, title: string): string {
  const raw = (value || title || 'presentation').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'presentation'
  return raw.toLowerCase().endsWith('.pptx') ? raw : `${raw}.pptx`
}

export async function generatePptxFast(ctx: FastPptContext, input: FastPptInput): Promise<{ outputPath: string; slideCount: number; styleId: string }> {
  if (!ctx.agentCwd.trim()) throw new Error('当前会话没有 Agent 工作目录')
  if (!input.title.trim()) throw new Error('title 必填')
  if (!Array.isArray(input.slides) || input.slides.length === 0 || input.slides.length > 30) throw new Error('slides 必须为 1–30 页')
  const outDir = resolve(ctx.agentCwd, '.context', 'ppt-output')
  mkdirSync(outDir, { recursive: true })
  const styleId = input.styleId ?? 'academic-editorial'
  const cloud = styleId === 'profer-cloud-dancer'
  const colors = cloud ? { bg: 'F0EFEC', ink: '312F2A', accent: '846557', muted: '746F67', card: 'F6F5F2' } : { bg: 'F7F5F0', ink: '17191C', accent: 'A20D18', muted: '5D6268', card: 'FFFFFF' }
  const pptx = new PptxGenJS()
  pptx.layout = 'LAYOUT_WIDE'
  pptx.author = 'Profer'
  pptx.company = 'Profer'
  pptx.title = input.title
  pptx.subject = input.title
  pptx.theme = { headFontFace: 'Aptos Display', bodyFontFace: 'Aptos' }

  for (const [index, spec] of input.slides.entries()) {
    if (!spec?.title?.trim()) throw new Error(`第 ${index + 1} 页 title 必填`)
    const slide = pptx.addSlide()
    slide.background = { color: colors.bg }
    const isCover = index === 0
    if (isCover) {
      slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 13.333, h: 7.5, fill: { color: colors.ink }, line: { color: colors.ink } })
      slide.addShape(pptx.ShapeType.arc, { x: 8.9, y: 0.4, w: 4.1, h: 4.1, rotate: 20, fill: { color: colors.accent, transparency: 15 }, line: { color: colors.accent, transparency: 100 } })
      slide.addText(spec.title, { x: 0.8, y: 2.05, w: 8.1, h: 1.5, fontFace: 'Aptos Display', fontSize: 35, bold: true, color: 'FFFFFF', margin: 0, breakLine: false, fit: 'shrink' })
      slide.addText((spec.bullets ?? []).join(' · ') || input.title, { x: 0.82, y: 3.85, w: 7.6, h: 0.55, fontSize: 16, color: 'E8E5DE', margin: 0, fit: 'shrink' })
    } else {
      slide.addText(spec.title, { x: 0.65, y: 0.48, w: 11.9, h: 0.55, fontFace: 'Aptos Display', fontSize: 25, bold: true, color: colors.ink, margin: 0, fit: 'shrink' })
      slide.addShape(pptx.ShapeType.line, { x: 0.65, y: 1.18, w: 12.0, h: 0, line: { color: colors.accent, width: 1.1 } })
      if (spec.chart && spec.chart.labels.length && spec.chart.labels.length === spec.chart.values.length) {
        slide.addChart(pptx.ChartType.bar, [{ name: spec.chart.title || spec.title, labels: spec.chart.labels, values: spec.chart.values }], { x: 0.75, y: 1.55, w: 7.65, h: 4.9, catAxisLabelFontFace: 'Aptos', catAxisLabelFontSize: 13, valAxisLabelFontSize: 11, showLegend: false, showTitle: false, chartColors: [colors.accent], showValue: true })
        slide.addShape(pptx.ShapeType.roundRect, { x: 8.85, y: 1.65, w: 3.65, h: 3.5, rectRadius: 0.08, fill: { color: colors.card }, line: { color: 'D7D1C8', width: 0.7 } })
        slide.addText((spec.bullets ?? []).join('\n'), { x: 9.15, y: 2.05, w: 3.05, h: 2.75, fontSize: 16, color: colors.ink, breakLine: true, margin: 0.05, fit: 'shrink', bullet: { indent: 14 } })
      } else {
        slide.addShape(pptx.ShapeType.roundRect, { x: 0.72, y: 1.55, w: 7.8, h: 4.95, rectRadius: 0.06, fill: { color: colors.card }, line: { color: 'DED9D0', width: 0.6 } })
        slide.addText((spec.bullets ?? []).join('\n') || '补充本页内容', { x: 1.1, y: 2.0, w: 6.95, h: 3.95, fontSize: 19, color: colors.ink, breakLine: true, margin: 0.02, fit: 'shrink', bullet: { indent: 18 } })
        slide.addShape(pptx.ShapeType.ellipse, { x: 9.45, y: 2.0, w: 2.25, h: 2.25, fill: { color: colors.accent, transparency: 12 }, line: { color: colors.accent, transparency: 100 } })
        slide.addText(String(index + 1).padStart(2, '0'), { x: 9.45, y: 2.62, w: 2.25, h: 0.6, fontSize: 28, bold: true, color: 'FFFFFF', align: 'center', margin: 0 })
      }
      slide.addText(`${index + 1} / ${input.slides.length}`, { x: 11.65, y: 6.95, w: 0.75, h: 0.18, fontSize: 9, color: colors.muted, align: 'right', margin: 0 })
    }
    slide.addNotes((spec.notes ?? [`本页：${spec.title}`]).join('\n'))
  }
  const outputPath = join(outDir, safeOutputName(input.outputName, input.title))
  await pptx.writeFile({ fileName: outputPath, compression: true })
  if (!existsSync(outputPath)) throw new Error(`PPTX 输出失败: ${outputPath}`)
  return { outputPath, slideCount: input.slides.length, styleId }
}

interface ClaudeSdkLike { tool: (...args: any[]) => any; createSdkMcpServer: (...args: any[]) => any }
export async function injectFastPptMcpServer(sdk: ClaudeSdkLike, servers: Record<string, Record<string, unknown>>, ctx: FastPptContext): Promise<void> {
  const { z } = await import('zod')
  const tool = sdk.tool('generate_pptx_fast', 'Generate an editable PPTX immediately. Call this directly for a PPT request; do not create plans, JS scripts, or ask for confirmation first.', {
    title: z.string().min(1).max(200),
    slides: z.array(z.object({ title: z.string().min(1).max(200), bullets: z.array(z.string().min(1).max(500)).max(8).optional(), chart: z.object({ labels: z.array(z.string().min(1)).min(1).max(12), values: z.array(z.number()).min(1).max(12), title: z.string().max(100).optional() }).optional(), notes: z.array(z.string().min(1)).max(8).optional() })).min(1).max(30),
    styleId: z.enum(['academic-editorial', 'profer-cloud-dancer']).optional(), outputName: z.string().min(1).max(100).optional(),
  }, async (input: FastPptInput) => response(await generatePptxFast(ctx, input)))
  servers['ppt-fast'] = sdk.createSdkMcpServer({ name: 'ppt-fast', version: '1.0.0', tools: [tool] }) as Record<string, unknown>
}

export function buildPiFastPptTools(sdk: { defineTool: (input: any) => any }, ctx: FastPptContext): Array<Record<string, unknown>> {
  const { Type } = require('typebox') as typeof import('typebox')
  return [sdk.defineTool({ name: 'generate_pptx_fast', label: '快速生成 PPTX', description: '立即生成可编辑 PPTX。不要先创建项目计划、JS 脚本或等待确认。', promptSnippet: 'For a PPT request, call generate_pptx_fast immediately.', parameters: Type.Object({ title: Type.String({ minLength: 1, maxLength: 200 }), slides: Type.Array(Type.Object({ title: Type.String({ minLength: 1, maxLength: 200 }), bullets: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 8 })), chart: Type.Optional(Type.Object({ labels: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 12 }), values: Type.Array(Type.Number(), { minItems: 1, maxItems: 12 }), title: Type.Optional(Type.String({ maxLength: 100 })) })), notes: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 8 })) }), { minItems: 1, maxItems: 30 }), styleId: Type.Optional(Type.Union([Type.Literal('academic-editorial'), Type.Literal('profer-cloud-dancer')])), outputName: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })) }), execute: async (_id: string, input: FastPptInput) => response(await generatePptxFast(ctx, input)) }) as Record<string, unknown>]
}
