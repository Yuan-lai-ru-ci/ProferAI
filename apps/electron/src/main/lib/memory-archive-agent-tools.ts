/**
 * memory-archive Agent MCP 工具。
 *
 * 让 Agent 在会话中能直接全文搜索 `workspace-files/.context/memory-archive/` 主题记忆
 * （基于 FTS5 双语检索服务），解决"记忆写进去了但日后找不到"的核心痛点：
 * 过去 Agent 只能靠 MEMORY.md 索引 + 文件名定位正文，无法按正文内容检索。
 *
 * 只读工具：Agent 可通过它搜索/读取工作区已沉淀的记忆主题文件，不能写入（写入走
 * 统一知识维护规则 + 编辑工具，此处不做双向权限膨胀）。
 */

import type { MemoryArchiveSearchHit } from './memory-archive-search'
import { filterDisabledTools } from '@profer/shared'

type ToolResult = { content: Array<{ type: 'text'; text: string }> }
function result(payload: unknown): ToolResult { return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] } }

/**
 * 注册 memory-archive MCP 服务器。
 * @param sdk - Claude Agent SDK 命名空间
 * @param mcpServers - 待注册的 MCP 服务器表
 * @param ctx - memoryArchivePath（memory-archive 绝对路径）与 workspaceSlug
 * @param disabledTools - 预设禁用的单工具短名（见 shared AGENT_PRESET_GROUP_TOOL_NAMES）
 */
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

  // 每次检索是惰性刷新索引（按 mtime/size 签名增量），无需常驻后台。
  const search = (query: string, topK: number): MemoryArchiveSearchHit[] => searcher.search(query, topK)

  const tools = [
    sdk.tool(
      'search_memory',
      '全文搜索当前工作区已沉淀的长期记忆（memory-archive 主题文件，FTS5，中英文均支持）。当用户询问"之前研究/踩过坑/做过什么/有没有记录"等需要回看历史记忆时，先调用本工具按关键词检索，再引用命中片段中的结论回答。',
      { query: z.string().min(1).max(200).describe('检索关键词；可为中文短语、英文/代码词、路径片段'), topK: z.number().int().min(1).max(20).optional().describe('返回条数，默认 5') },
      async (args) => {
        const hits = search(args.query, args.topK ?? 5)
        console.log(`[记忆工具] Agent 检索 memory-archive: workspace=${ctx.workspaceSlug}, query="${args.query}", hits=${hits.length}`)
        return result({
          hits: hits.map((h) => ({
            file: h.relativePath,
            content: h.content,
            startIndex: h.startIndex,
            endIndex: h.endIndex,
            matched: h.matchedTokens,
          })),
          message: hits.length ? undefined : 'memory-archive 中没有匹配的长期记忆。若属新话题，可咨询用户是否需要沉淀。',
        })
      },
      { annotations: { readOnlyHint: true } },
    ),
  ]
  const server = sdk.createSdkMcpServer({
    name: 'memory-archive',
    version: '1.0.0',
    tools: filterDisabledTools(tools, disabledTools),
  })
  mcpServers['memory-archive'] = server
}
