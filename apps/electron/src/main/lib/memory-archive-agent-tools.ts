import type { MemoryArchiveSearchHit } from './memory-archive-search'
import { memoryFreshnessNote, memoryHitAgeDays } from './memory-archive-search'
import { filterDisabledTools } from '@profer/shared'

type ToolResult = { content: Array<{ type: 'text'; text: string }> }
function result(payload: unknown): ToolResult { return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] } }

export async function injectMemoryArchiveMcpServer(
  sdk: typeof import('@anthropic-ai/claude-agent-sdk'),
  mcpServers: Record<string, Record<string, unknown>>,
  ctx: { memoryArchivePath?: string; workspaceSlug?: string },
  disabledTools?: string[],
): Promise<void> {
  if (!ctx.memoryArchivePath) return
  const { createMemoryArchiveSearcher } = await import('./memory-archive-search')
  let z: typeof import('zod').z
  try { ({ z } = await import('zod')) } catch { z = require('zod').z }
  const searcher = createMemoryArchiveSearcher(ctx.memoryArchivePath)
  const search = (query: string, topK: number): MemoryArchiveSearchHit[] => searcher.search(query, topK)
  const tools = [
    sdk.tool(
      'search_memory',
      '全文搜索当前工作区已沉淀的长期记忆（memory-archive 主题文件，FTS5，中英文均支持）。当用户询问之前研究、踩坑、做过什么或有没有记录时调用。只读。',
      { query: z.string().min(1).max(200).describe('中文短语、英文/代码词、路径片段'), topK: z.number().int().min(1).max(20).optional() },
      async (args) => {
        const hits = search(args.query, args.topK ?? 5)
        console.log(`[记忆工具] Agent 检索 memory-archive: workspace=${ctx.workspaceSlug}, query="${args.query}", hits=${hits.length}`)
        return result({
          hits: hits.map((hit) => ({ file: hit.relativePath, content: hit.content, startIndex: hit.startIndex, endIndex: hit.endIndex, matched: hit.matchedTokens, ageDays: memoryHitAgeDays(hit) })),
          freshnessNote: memoryFreshnessNote(hits),
          message: hits.length ? undefined : '当前工作区 memory-archive 中没有匹配的记忆。',
        })
      },
      { annotations: { readOnlyHint: true } },
    ),
  ]
  const server = sdk.createSdkMcpServer({ name: 'memory-archive', version: '1.0.0', tools: filterDisabledTools(tools, disabledTools) })
  mcpServers['memory-archive'] = server
}
