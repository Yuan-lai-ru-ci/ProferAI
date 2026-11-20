import { join } from 'node:path'
import { z } from 'zod'
import { Type } from 'typebox'
import type { AnyZodRawShape } from '@anthropic-ai/claude-agent-sdk'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { RuntimeCanUseTool } from '@profer/agent-runtime'
import { filterDisabledTools } from '@profer/shared'
import { readGlobalMemoryFile, searchGlobalMemory } from '../../../packages/user-memory/src/index'
import { appendGlobalMemoryEntry, GLOBAL_MEMORY_APPEND_DESCRIPTION } from './memory-operations'
import { searchMemoryArchive, memoryFreshnessNote, memoryHitAgeDays } from './memory-archive-search'

export interface CoreMemoryToolContext {
  /** 当前 Core 的配置目录，禁止传桌面或其他 Core 的配置目录。 */
  configDir: string
  /** resolveCorePreset 返回的工作区配置目录（project 的 .profer / managed 根）。 */
  workspaceConfigDir?: string
  workspaceStorageMode?: 'project' | 'managed'
  disabledTools?: readonly string[]
  disabledToolGroups?: readonly string[]
  /** 动态读取以遵守运行中的计划模式切换。 */
  getPermissionMode: () => string
  signal: AbortSignal
}
export interface CoreClaudeMemoryToolContext extends CoreMemoryToolContext { canUseTool: RuntimeCanUseTool }

const schemas = {
  search_global_memory: z.object({ query: z.string().min(1).max(200), topK: z.number().int().min(1).max(20).optional() }),
  read_global_memory: z.object({ relativePath: z.string().min(1).max(500) }),
  append_global_memory: z.object({ category: z.enum(['profile', 'preferences', 'inference']), entry: z.string().min(3).max(2000), confidence: z.literal('high').optional(), evidence: z.array(z.object({ sessionId: z.string().min(1).max(200), date: z.string(), observation: z.string().min(1).max(300) })).min(2).max(5).optional() }),
  search_memory: z.object({ query: z.string().min(1).max(200), topK: z.number().int().min(1).max(20).optional() }),
}
const descriptions = {
  search_global_memory: '按需全文搜索当前 Core 跨工作区共享的用户级长期记忆。动态状态应与用户当轮信息核对。只读。',
  read_global_memory: '读取 MEMORY.md 索引或搜索命中的全局用户记忆 Markdown 主题文件。只读。',
  append_global_memory: GLOBAL_MEMORY_APPEND_DESCRIPTION,
  search_memory: '全文搜索当前工作区已沉淀的长期记忆（memory 主题文件，FTS5，中英文均支持）。询问之前研究、踩坑或记录时调用。只读。',
}
type Name = keyof typeof schemas
const names = Object.keys(schemas) as Name[]
const serverName = (name: Name) => name === 'search_memory' ? 'memory-archive' : 'global-memory'
const fullName = (name: Name) => `mcp__${serverName(name)}__${name}`
export const CORE_MEMORY_CLAUDE_TOOL_NAMES = names.map(fullName)

function enabled(ctx: CoreMemoryToolContext, name: Name): boolean {
  return !ctx.disabledToolGroups?.includes('memory')
    && (name !== 'search_memory' || Boolean(ctx.workspaceConfigDir))
    && (name !== 'append_global_memory' || ctx.getPermissionMode() !== 'plan')
    && filterDisabledTools([{ name: fullName(name) }], ctx.disabledTools).length > 0
    && !ctx.disabledTools?.includes(name)
}
function result(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }], details: payload }
}
function execute(ctx: CoreMemoryToolContext, name: Name, input: unknown, signal: AbortSignal) {
  signal.throwIfAborted()
  if (!enabled(ctx, name)) throw new Error('当前预设或计划模式禁止此记忆工具')
  if (name === 'search_global_memory') {
    const args = schemas[name].parse(input)
    return result({ hits: searchGlobalMemory(ctx.configDir, args.query, args.topK ?? 5), freshnessNote: '记忆可能过时；涉及动态状态时与用户当轮信息核对。' })
  }
  if (name === 'read_global_memory') return result(readGlobalMemoryFile(ctx.configDir, schemas[name].parse(input).relativePath))
  if (name === 'append_global_memory') return result({ ...appendGlobalMemoryEntry(ctx.configDir, schemas[name].parse(input)), message: '全局记忆写入已完成；请在回复中简要告知用户写入主题。' })
  const args = schemas[name].parse(input)
  // 与 Electron getWorkspaceMemoryArchivePath 的统一目录一致；不触发旧档案迁移。
  const memoryPath = ctx.workspaceStorageMode === 'project'
    ? join(ctx.workspaceConfigDir!, 'memory') : join(ctx.workspaceConfigDir!, '.profer', 'memory')
  const hits = searchMemoryArchive(memoryPath, args.query, args.topK ?? 5)
  return result({ hits: hits.map(hit => ({ file: hit.relativePath, content: hit.content, startIndex: hit.startIndex, endIndex: hit.endIndex, matched: hit.matchedTokens, ageDays: memoryHitAgeDays(hit) })), freshnessNote: memoryFreshnessNote(hits), message: hits.length ? undefined : '当前工作区 memory 中没有匹配的记忆。' })
}

/** Pi 适配器统一包装 prepared.canUseTool；本层再次校验禁用项与实时计划模式。 */
export async function loadCorePiMemoryTools(ctx: CoreMemoryToolContext): Promise<ToolDefinition[]> {
  const sdk = await import('@earendil-works/pi-coding-agent')
  return names.filter(name => enabled(ctx, name)).map(name => sdk.defineTool({
    name: fullName(name), label: name, description: descriptions[name],
    parameters: Type.Unsafe<Record<string, unknown>>(z.toJSONSchema(schemas[name])),
    async execute(_id, input, signal) { return execute(ctx, name, input, signal ? AbortSignal.any([ctx.signal, signal]) : ctx.signal) },
  }))
}

/** 分别返回 global-memory / memory-archive，保持原 MCP 名称供预设及工具库存复用。 */
export async function createCoreClaudeMemoryMcpServers(
  sdk: Pick<typeof import('@anthropic-ai/claude-agent-sdk'), 'tool' | 'createSdkMcpServer'>,
  ctx: CoreClaudeMemoryToolContext,
) {
  const servers: Record<string, ReturnType<typeof sdk.createSdkMcpServer>> = {}
  for (const server of ['global-memory', 'memory-archive']) {
    const tools = names.filter(name => serverName(name) === server && enabled(ctx, name)).map(name => sdk.tool(
      name, descriptions[name], schemas[name].shape as unknown as AnyZodRawShape,
      async (input, extra) => {
        const extraSignal = extra && typeof extra === 'object' && 'signal' in extra && extra.signal instanceof AbortSignal ? extra.signal : undefined
        const signal = extraSignal ? AbortSignal.any([ctx.signal, extraSignal]) : ctx.signal
        signal.throwIfAborted()
        if (!enabled(ctx, name)) throw new Error('当前预设或计划模式禁止此记忆工具')
        const decision = await ctx.canUseTool(fullName(name), input, { signal })
        if (decision.behavior !== 'allow') throw new Error(decision.message)
        return { content: execute(ctx, name, decision.updatedInput ?? input, signal).content }
      }, { annotations: { readOnlyHint: name !== 'append_global_memory', destructiveHint: false } },
    ))
    if (tools.length) servers[server] = sdk.createSdkMcpServer({ name: server, version: '1.0.0', tools })
  }
  return servers
}
