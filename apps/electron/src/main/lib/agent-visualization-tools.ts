import type { PresentVisualizationInput, VisualizationContext, VisualizationRecord } from '@profer/shared'
import { filterDisabledTools } from '@profer/shared'
import { randomUUID } from 'node:crypto'
import { presentVisualization, readVisualization } from './visualization-records'

/**
 * 常驻注入的工具描述只保留「参数与硬性校验」契约。
 *
 * 形式选择、片段编写规范、宿主 token/语义类、自检清单都在 `present-visualization` Skill 正文里，
 * 只在触发时随 skill_routing 注入——否则这段描述每轮请求都要占用上下文。
 */
export const PRESENT_VISUALIZATION_DESCRIPTION = `Present a chart or interactive explanation. Chart: pass chart, not filePath; reviewed finite data only, no fabricated values/ECharts options/JS/styling. bar/line/pie/scatter, max 200 rows/8 series; pie needs nameKey/valueKey and matching series dataKey, scatter numeric xKey; vertical layout = horizontal bars. Fragment: filePath + format:'fragment', #widget root; non-ASCII requires full HTML with UTF-8 meta; ASCII may be bare. Inline CSS/JS, data: images, natural-height flow only; no event-handler attributes, external resources/CDN/links/forms/network. Formulas: \\(...\\) inline, \\[...\\] display; $...$ is not rendered. State: window.proferVisualization.setState(plain JSON <=16 KiB), restore on stateUpdated; selectObject(id) and data-profer-object-id must use declared objects. Updates require BOTH visualizationId/baseRevision; failure preserves old version. No publishing in plan mode. Read present-visualization Skill before authoring; no markdown tables/mermaid/ASCII substitutes.`

export interface VisualizationToolContext extends VisualizationContext {
  onUpdate?: (record: VisualizationRecord) => void
  assertCanPresent?: () => void
}

export async function executePresentVisualization(input: PresentVisualizationInput, context: VisualizationToolContext, toolCallId: string = randomUUID(), signal?: AbortSignal) {
  const assertCanCommit = () => {
    signal?.throwIfAborted()
    context.assertCanPresent?.()
  }
  const normalized = input.chart === undefined && input.format === undefined ? { ...input, format: 'fragment' as const } : input
  const record = await presentVisualization(normalized, context, toolCallId, assertCanCommit)
  context.onUpdate?.(record)
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ visualization: record, message: '可视化已保存，会直接显示在当前会话。不要输出内部协议标记。' }) }],
    details: { visualization: record },
  }
}

export async function executeInspectVisualization(input: { visualizationId: string; revision?: string }, context: VisualizationContext) {
  const content = await readVisualization(context, input.visualizationId, input.revision)
  return { content: [{ type: 'text' as const, text: JSON.stringify(content) }], details: { visualization: content.record } }
}

export async function injectVisualizationMcpServer(
  sdk: typeof import('@anthropic-ai/claude-agent-sdk'),
  servers: Record<string, Record<string, unknown>>,
  context: VisualizationToolContext,
  disabledTools?: string[],
): Promise<void> {
  const { z } = await import('zod')
  const server = sdk.createSdkMcpServer({
    name: 'visualization', version: '1.0.0',
    tools: filterDisabledTools([
      sdk.tool('present_visualization', PRESENT_VISUALIZATION_DESCRIPTION, {
        filePath: z.string().min(1).max(4096).optional(),
        format: z.enum(['html', 'fragment']).optional(),
        chart: z.object({
          chartType: z.enum(['bar', 'line', 'pie', 'scatter']),
          xKey: z.string().optional(), xAxisLabel: z.string().optional(), nameKey: z.string().optional(), valueKey: z.string().optional(),
          layout: z.enum(['horizontal', 'vertical']).optional(),
          series: z.array(z.object({ dataKey: z.string(), label: z.string().optional(), valuePrefix: z.string().optional(), valueSuffix: z.string().optional() })).min(1).max(8),
          data: z.array(z.record(z.string(), z.union([z.string(), z.number()]))).min(1).max(200),
        }).optional(),
        title: z.string().min(1).max(120),
        summary: z.string().min(1).max(2000), kind: z.enum(['structure', 'comparison', 'data', 'explanation']).optional(),
        objects: z.array(z.object({ id: z.string().min(1).max(120), label: z.string().min(1).max(200), text: z.string().max(2000).optional() })).max(200).optional(),
        visualizationId: z.string().optional(), baseRevision: z.string().optional(),
        sourceMessageId: z.string().max(200).optional(), sourceText: z.string().max(10000).optional(),
      }, async (args) => executePresentVisualization(args, context)),
      sdk.tool('inspect_visualization', 'Read a saved visualization revision, source HTML and object list in the current session. This checks content; it does not claim visual or interaction verification.', {
        visualizationId: z.string().min(1).max(200), revision: z.string().max(200).optional(),
      }, async (args) => executeInspectVisualization(args, context)),
    ], disabledTools),
  })
  servers.visualization = server as unknown as Record<string, unknown>
}
