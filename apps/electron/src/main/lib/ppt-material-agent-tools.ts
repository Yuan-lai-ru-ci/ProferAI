import type { PptMaterialItem } from '@profer/shared'
import { downloadPptMaterialToWorkspace, searchPptMaterials } from './ppt-material-service'
import { auditPptDelivery, planPptVisuals } from './ppt-delivery-audit-service'

type ToolResult = { content: Array<{ type: 'text'; text: string }> }
function result(payload: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] }
}

/** Claude runtime 的开放许可 PPT 素材 MCP 工具。 */
export async function injectPptMaterialMcpServer(
  sdk: typeof import('@anthropic-ai/claude-agent-sdk'),
  mcpServers: Record<string, Record<string, unknown>>,
  ctx: { agentCwd: string },
): Promise<void> {
  let z: typeof import('zod').z
  try { ({ z } = await import('zod')) } catch { z = require('zod').z }

  const server = sdk.createSdkMcpServer({
    name: 'ppt-materials', version: '1.0.0', tools: [
      sdk.tool(
        'search_open_materials',
        '搜索可用于 PPT 的开放许可真实图片。默认仅返回 Public Domain/CC0；includeAttribution=true 时可加入 CC BY。免费不等于已清权，使用时仍须注意商标、肖像和隐私权，并保留返回的来源与许可信息。',
        { query: z.string().min(1).max(200), includeAttribution: z.boolean().optional() },
        async ({ query, includeAttribution }) => result(await searchPptMaterials({ query, includeAttribution })),
        { annotations: { readOnlyHint: true } },
      ),
      sdk.tool(
        'download_open_material',
        '将 search_open_materials 返回的一项开放许可素材下载到当前 Agent 工作区 .context/ppt-materials/，供 PPT 生成代码使用。返回本地路径、来源页和许可；生成 PPT 时保留这些归属信息。',
        { material: z.object({ id: z.string(), source: z.literal('wikimedia'), title: z.string(), thumbnailUrl: z.string().url(), originalUrl: z.string().url(), landingPageUrl: z.string().url(), licenseCode: z.string(), licenseUrl: z.string().url().optional(), creator: z.string().optional(), attribution: z.string().optional(), width: z.number().optional(), height: z.number().optional(), mediaType: z.string().optional() }) },
        async ({ material }) => result(await downloadPptMaterialToWorkspace({ material: material as PptMaterialItem }, ctx.agentCwd)),
      ),
      sdk.tool(
        'plan_ppt_visuals',
        '在生成多页 PPT 前创建逐页视觉计划。每页必须指定真实图片、图表、图解或数据大字之一；真实图片页会返回可检索的素材关键词。',
        { deckIntent: z.string().min(1).max(300), slides: z.array(z.object({ slideNumber: z.number().int().positive().optional(), title: z.string().min(1).max(200), purpose: z.string().max(300).optional() })).min(1) },
        async ({ deckIntent, slides }) => result(planPptVisuals(deckIntent, slides)),
        { annotations: { readOnlyHint: true } },
      ),
      sdk.tool(
        'audit_ppt_delivery',
        'PPT 生成后必须调用。审计 PPTX 中逐页图片、图表、形状与文本；若视觉计划要求的主视觉未落地或整套无图片无图表，将返回 needsRevision=true，必须修订后再交付。',
        { filePath: z.string().min(1), visualPlan: z.object({ deckIntent: z.string(), slides: z.array(z.object({ slideNumber: z.number().int().positive(), slidePurpose: z.string(), heroVisual: z.enum(['real_image', 'chart', 'diagram', 'data_typography']), materialQuery: z.string().optional(), fallbackReason: z.string().optional() })) }).optional() },
        async ({ filePath, visualPlan }) => result(auditPptDelivery(filePath, visualPlan)),
        { annotations: { readOnlyHint: true } },
      ),
    ],
  })
  mcpServers['ppt-materials'] = server as unknown as Record<string, unknown>
}
