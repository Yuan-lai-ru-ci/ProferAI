import type { AgentSessionMeta, KnowledgeReference } from '@profer/shared'

interface KbAgentToolContext { sessionId: string; workspaceId?: string }
interface KbToolResult extends Record<string, unknown> { content: Array<{ type: 'text'; text: string }> }
type ZodModule = typeof import('zod')

function jsonResult(payload: unknown): KbToolResult { return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] } }

function schemas(z: ZodModule['z']) {
  return {
    read: {
      itemIds: z.array(z.string()).min(1).max(10).optional().describe('要读取的已导入资料 ID；省略时仅列出资料元数据'),
      query: z.string().max(500).optional().describe('可选：在已导入资料内搜索相关片段'),
      topK: z.number().int().min(1).max(10).optional(),
    },
  }
}

/** Agent 工具严格以 session metadata 的资料引用作为 allowlist；不注册旧全库读取/任意路径导入工具。 */
export async function injectKbMcpServer(
  sdk: typeof import('@anthropic-ai/claude-agent-sdk'),
  mcpServers: Record<string, Record<string, unknown>>,
  ctx: KbAgentToolContext,
): Promise<void> {
  const { getAgentSessionMeta } = await import('./agent-session-manager')
  const { getKnowledgeItem, searchKnowledgeItemsForChat } = await import('./knowledge-item-service')
  const { getPaper } = await import('./kb-paperpipe')
  let z: ZodModule['z']
  try { ({ z } = await import('zod') as ZodModule) } catch { z = (require('zod') as ZodModule).z }
  const toolSchemas = schemas(z)

  const currentReferences = (): KnowledgeReference[] => getAgentSessionMeta(ctx.sessionId)?.knowledgeReferences || []
  const list = (): KbToolResult => {
    const references = currentReferences()
    return jsonResult({
      // remote Paperpipe 正文按需读取，不能因本地缓存缺失被误报为不可读。
      items: references.map((reference) => ({ ...reference, readable: true })),
      message: references.length ? undefined : '当前 Agent 会话未导入任何资料。请让用户通过资料库按钮显式导入。',
    })
  }

  const server = sdk.createSdkMcpServer({
    name: 'knowledge-base', version: '2.0.0', tools: [
      sdk.tool('list_imported_knowledge', '列出当前 Agent 会话显式导入的资料。只能访问此列表中的资料。', {}, async () => {
        console.log(`[资料工具] Agent 列出已授权资料: session=${ctx.sessionId}, count=${currentReferences().length}`)
        return list()
      }, { annotations: { readOnlyHint: true } }),
      sdk.tool('read_imported_knowledge', '读取或搜索当前 Agent 会话显式导入的资料。绝不读取其他会话或全库资料。', toolSchemas.read, async (args) => {
        const references = currentReferences()
        console.log(`[资料工具] Agent 读取已授权资料: session=${ctx.sessionId}, referenceCount=${references.length}, requestedCount=${args.itemIds?.length ?? 0}, hasQuery=${Boolean(args.query)}`)
        const allowed = new Set(references.map((reference) => reference.itemId))
        const requested = args.itemIds ? [...new Set(args.itemIds)] : []
        const denied = requested.filter((id) => !allowed.has(id))
        const permitted = requested.filter((id) => allowed.has(id))
        if (denied.length) return jsonResult({ error: 'KNOWLEDGE_ITEM_NOT_IMPORTED', deniedItemIds: denied, message: '请求的资料未导入当前 Agent 会话，已拒绝读取。' })
        if (!references.length) return list()
        if (!args.query && !permitted.length) return list()
        if (args.query) {
          const results = await searchKnowledgeItemsForChat(args.query, permitted.length ? permitted : [...allowed], args.topK ?? 5)
          return jsonResult({ results: results.map((result) => ({ itemId: result.item.id, title: result.item.title, kind: result.item.kind, origin: result.item.origin, content: result.content, startIndex: result.startIndex, endIndex: result.endIndex })), message: results.length ? undefined : '已导入资料中没有可读取的匹配片段。' })
        }
        const items = permitted.map(async (id) => {
          const reference = references.find((candidate) => candidate.itemId === id)!
          const loaded = getKnowledgeItem(id)
          if (loaded) return { itemId: id, title: reference.title, kind: reference.kind, origin: reference.origin, content: loaded.text.slice(0, 6_000), truncated: loaded.text.length > 6_000 }
          const remote = await getPaper(id).catch(() => null)
          return remote ? { itemId: id, title: reference.title, kind: reference.kind, origin: reference.origin, content: remote.markdown.slice(0, 6_000), truncated: remote.markdown.length > 6_000 } : { itemId: id, title: reference.title, unavailable: true }
        })
        return jsonResult({ items: await Promise.all(items) })
      }, { annotations: { readOnlyHint: true } }),
    ],
  })
  mcpServers['knowledge-base'] = server
}
