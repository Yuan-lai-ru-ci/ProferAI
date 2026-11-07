import { filterDisabledTools } from '@profer/shared'
import { searchGlobalMemory, readGlobalMemoryFile } from './global-memory-service'

type ToolResult = { content: Array<{ type: 'text'; text: string }> }
function result(payload: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] }
}

export async function buildGlobalMemoryTools(sdk: typeof import('@anthropic-ai/claude-agent-sdk')): Promise<any[]> {
  let z: typeof import('zod').z
  try { ({ z } = await import('zod')) } catch { z = require('zod').z }
  return [
    sdk.tool(
      'search_global_memory',
      '按需全文搜索跨工作区共享的用户级长期记忆（用户背景、稳定偏好、设备、服务器）。相关时调用；搜索结果可能过时，动态状态应与用户当轮信息核对。只读。',
      { query: z.string().min(1).max(200), topK: z.number().int().min(1).max(20).optional() },
      async (args) => result({ hits: searchGlobalMemory(args.query, args.topK ?? 5), freshnessNote: '记忆可能过时；涉及动态状态时与用户当轮信息核对。' }),
      { annotations: { readOnlyHint: true } },
    ),
    sdk.tool(
      'read_global_memory',
      '读取 MEMORY.md 索引或搜索命中的全局用户记忆 Markdown 主题文件。只读。',
      { relativePath: z.string().min(1).max(500) },
      async (args) => {
        try { return result(readGlobalMemoryFile(args.relativePath)) }
        catch (error) { return result({ error: error instanceof Error ? error.message : String(error) }) }
      },
      { annotations: { readOnlyHint: true } },
    ),
  ]
}

export async function injectGlobalMemoryTools(
  sdk: typeof import('@anthropic-ai/claude-agent-sdk'),
  mcpServers: Record<string, Record<string, unknown>>,
  disabledTools?: string[],
): Promise<void> {
  const tools = await buildGlobalMemoryTools(sdk)
  mcpServers['global-memory'] = sdk.createSdkMcpServer({
    name: 'global-memory',
    version: '1.0.0',
    tools: filterDisabledTools(tools, disabledTools),
  })
}
