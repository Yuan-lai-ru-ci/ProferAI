import type { TeamMemoryDocument } from '@profer/shared'
import { filterDisabledTools } from '@profer/shared'
import { createTeamMemory, listTeamMemories, readTeamMemory, updateTeamMemory } from './team-memory-service'

type ToolResult = { content: Array<{ type: 'text'; text: string }> }
function result(payload: unknown): ToolResult { return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] } }
function requireTeamWorkspace(workspaceId?: string): string {
  if (!workspaceId) throw new Error('当前会话不属于团队工作区，无法访问团队共享记忆。')
  return workspaceId
}

/** 团队 Agent 只使用此受限集合：可按需读写，不能归档/恢复/强制覆盖团队共同知识。 */
export function teamMemoryOperations(workspaceId?: string) {
  const id = requireTeamWorkspace(workspaceId)
  return {
    async list() { const response = await listTeamMemories(id); return response.ok ? response.data ?? [] : { error: response.error } },
    async read(memoryId: string) { const response = await readTeamMemory(id, memoryId); return response.ok ? response.data : { error: response.error } },
    async search(query: string) {
      const response = await listTeamMemories(id)
      if (!response.ok) return { error: response.error }
      const needle = query.trim().toLowerCase()
      const matches = (response.data ?? []).filter((doc) => `${doc.path}\n${doc.title}`.toLowerCase().includes(needle))
      return { matches }
    },
    async create(input: { path: string; title: string; content: string; changeSummary?: string }) {
      const response = await createTeamMemory(id, input); return response.ok ? response.data : { error: response.error }
    },
    async update(memoryId: string, expectedVersion: number, input: { path?: string; title?: string; content?: string; changeSummary?: string }) {
      const response = await updateTeamMemory(id, memoryId, { expectedVersion, ...input })
      return response.ok ? response.data : response.conflict ? { error: response.error, conflict: response.conflict } : { error: response.error }
    },
  }
}

export async function injectTeamMemoryMcpServer(
  sdk: typeof import('@anthropic-ai/claude-agent-sdk'),
  mcpServers: Record<string, Record<string, unknown>>,
  ctx: { workspaceId?: string },
  disabledTools?: string[],
): Promise<void> {
  if (!ctx.workspaceId) return
  let z: typeof import('zod').z
  try { ({ z } = await import('zod')) } catch { z = require('zod').z }
  const ops = teamMemoryOperations(ctx.workspaceId)
  const tools = [
    sdk.tool('list_team_memories', '列出当前团队工作区的共享知识记忆。团队记忆是项目共识，不包含成员个人记忆。', {}, async () => result(await ops.list()), { annotations: { readOnlyHint: true } }),
    sdk.tool('read_team_memory', '读取一篇团队共享知识记忆。应先按需读取相关文档，再回答团队项目问题。', { memoryId: z.string() }, async ({ memoryId }) => result(await ops.read(memoryId)), { annotations: { readOnlyHint: true } }),
    sdk.tool('search_team_memories', '按标题和路径搜索当前团队的共享知识记忆。', { query: z.string().min(1).max(200) }, async ({ query }) => result(await ops.search(query)), { annotations: { readOnlyHint: true } }),
    sdk.tool('create_team_memory', '创建团队共享知识记忆。仅在用户明确确认要沉淀且内容为跨成员可复用项目事实时使用。', { path: z.string().min(1).max(300), title: z.string().min(1).max(160), content: z.string().max(1048576), changeSummary: z.string().max(500).optional() }, async (args) => result(await ops.create(args))),
    sdk.tool('update_team_memory', '更新团队共享知识记忆。更新前先读取，发生版本冲突时必须向用户说明，不能自动覆盖。', { memoryId: z.string(), expectedVersion: z.number().int().positive(), path: z.string().min(1).max(300).optional(), title: z.string().min(1).max(160).optional(), content: z.string().max(1048576).optional(), changeSummary: z.string().max(500).optional() }, async ({ memoryId, expectedVersion, ...input }) => result(await ops.update(memoryId, expectedVersion, input))),
  ]
  const server = sdk.createSdkMcpServer({ name: 'team-memory', version: '1.0.0', tools: filterDisabledTools(tools, disabledTools) })
  mcpServers['team-memory'] = server
}
