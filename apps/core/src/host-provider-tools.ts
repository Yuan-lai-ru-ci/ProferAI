import { extname } from 'node:path'
import { createRequire } from 'node:module'
import type { AnyZodRawShape } from '@anthropic-ai/claude-agent-sdk'
import { HOST_TOOL_NAMES, HOST_TOOL_DESCRIPTIONS, loadPiHostToolDefinitions, type HostToolName, type HostToolResult } from '@profer/agent-provider-pi/host-tools'
import type { RuntimeCanUseTool } from '@profer/agent-runtime'
import type { CoreHostTools, CoreHostToolContext } from './host-tools'

type ClaudeSdk = Pick<typeof import('@anthropic-ai/claude-agent-sdk'), 'tool' | 'createSdkMcpServer'>
export const CORE_HOST_MCP_SERVER_NAME = 'host'
export const CORE_HOST_CLAUDE_TOOL_NAMES = HOST_TOOL_NAMES.map(name => `mcp__${CORE_HOST_MCP_SERVER_NAME}__${name}`)
export interface CoreHostProviderContext extends CoreHostToolContext {
  disabledTools?: readonly string[]
}
export interface CoreClaudeHostProviderContext extends CoreHostProviderContext {
  /** 传入本次运行的 prepared.canUseTool，不能绕过 Core 统一权限。 */
  canUseTool: RuntimeCanUseTool
}

type ContentBlock = HostToolResult['content'][number]
function isContentBlock(value: unknown): value is ContentBlock {
  if (!value || typeof value !== 'object') return false
  if ('type' in value && value.type === 'text') return 'text' in value && typeof value.text === 'string'
  return 'type' in value && value.type === 'image' && 'data' in value && typeof value.data === 'string'
    && 'mimeType' in value && typeof value.mimeType === 'string'
}

/** 保留宿主返回的文字/图片块，避免把预览图片序列化进文本。 */
function result(value: unknown): HostToolResult {
  if (value && typeof value === 'object' && 'content' in value && Array.isArray(value.content) && value.content.every(isContentBlock)) {
    return { content: value.content, details: 'details' in value ? value.details : undefined,
      ...('isError' in value && value.isError === true ? { isError: true } : {}) }
  }
  return { content: [{ type: 'text', text: JSON.stringify(value) ?? 'null' }], details: value }
}

function disabled(context: CoreHostProviderContext, name: HostToolName): boolean {
  return context.disabledTools?.includes(name) === true || context.disabledTools?.includes(`mcp__${CORE_HOST_MCP_SERVER_NAME}__${name}`) === true
}

async function execute(tools: CoreHostTools, context: CoreHostProviderContext, name: HostToolName, input: Record<string, unknown>, signal?: AbortSignal): Promise<HostToolResult> {
  const operationSignal = signal ? AbortSignal.any([context.signal, signal]) : context.signal
  operationSignal.throwIfAborted()
  if (disabled(context, name)) throw new Error('当前预设已禁用此宿主工具')
  const operationContext: CoreHostToolContext = { connectionId: context.connectionId, sessionId: context.sessionId, runId: context.runId, signal: operationSignal }
  if (name === 'clipboard_write_text') {
    if (typeof input.text !== 'string') throw new Error('剪贴板文本无效')
    return result(await tools.clipboardWrite(operationContext, input.text))
  }
  if (typeof input.filePath !== 'string' || !input.filePath.length || input.filePath.length > 4096) throw new Error('预览文件路径无效')
  const pptx = extname(input.filePath).toLowerCase() === '.pptx'
  if (name !== 'inspect_preview' && !pptx) throw new Error('PPTX 正式预览工具仅支持 .pptx 文件；其他文件请使用 inspect_preview')
  if (name === 'inspect_preview' && pptx) throw new Error('PPTX 请先使用 open_file_preview，再使用 inspect_file_preview 检查正式预览')
  if (input.page !== undefined && (typeof input.page !== 'number' || !Number.isInteger(input.page) || input.page < 1)) throw new Error('预览页码无效')
  if (input.scope !== undefined && !['overview', 'page', 'all'].includes(String(input.scope))) throw new Error('预览范围无效')
  if (input.mode !== undefined && !['content', 'visual', 'both'].includes(String(input.mode))) throw new Error('预览模式无效')
  if (input.previousRevision !== undefined && (typeof input.previousRevision !== 'string' || !input.previousRevision.length || input.previousRevision.length > 200)) throw new Error('预览版本无效')
  // 只向既有宿主桥传内容；PPTX 仍使用正式 viewer。即使调用方传 false，也强制只读。
  const options = { readOnly: true, page: input.page as number | undefined,
    scope: input.scope as 'overview' | 'page' | 'all' | undefined,
    mode: input.mode as 'content' | 'visual' | 'both' | undefined,
    previousRevision: input.previousRevision as string | undefined }
  return result(await tools.preview(operationContext, { path: input.filePath, inspect: name !== 'open_file_preview', options }))
}

/** Pi 的 prepared.canUseTool 已由 adapter 包装执行，这里不重复审批。 */
export async function loadCorePiHostTools(tools: CoreHostTools, context: CoreHostProviderContext) {
  return loadPiHostToolDefinitions({
    disabledTools: HOST_TOOL_NAMES.filter(name => disabled(context, name)),
    execute: (name, input, signal) => execute(tools, context, name, input, signal),
  })
}

/** 传 inventorySdk 即可让现有 skills inventory 收集实际注册名。 */
export async function createCoreClaudeHostMcpServer(sdk: ClaudeSdk, tools: CoreHostTools, context: CoreClaudeHostProviderContext) {
  // Zod 随 Claude SDK 安装，按 SDK 所在位置解析，不依赖 Core 的扁平 node_modules。
  interface SchemaBuilder {
    min(value: number): SchemaBuilder
    max(value: number): SchemaBuilder
    int(): SchemaBuilder
    positive(): SchemaBuilder
    optional(): SchemaBuilder
    describe(value: string): SchemaBuilder
  }
  const { z } = createRequire(import.meta.resolve('@anthropic-ai/claude-agent-sdk'))('zod') as {
    z: { string(): SchemaBuilder; number(): SchemaBuilder; boolean(): SchemaBuilder; enum(values: string[]): SchemaBuilder }
  }
  const filePath = z.string().min(1).max(4096)
  const scope = z.enum(['overview', 'page', 'all']).optional()
  const page = z.number().int().positive().optional()
  const schemas = {
    open_file_preview: { filePath, readOnly: z.boolean().optional() },
    inspect_file_preview: { filePath, scope, page },
    inspect_preview: { filePath, mode: z.enum(['content', 'visual', 'both']).optional(), scope, page, previousRevision: z.string().min(1).max(200).optional() },
    clipboard_write_text: { text: z.string().min(1).describe('要写入系统剪贴板的完整文本。') },
  }
  const entries = HOST_TOOL_NAMES.filter(name => !disabled(context, name)).map(name => sdk.tool(name, HOST_TOOL_DESCRIPTIONS[name], schemas[name] as unknown as AnyZodRawShape, async (args, extra) => {
    const extraSignal = extra && typeof extra === 'object' && 'signal' in extra && extra.signal instanceof AbortSignal ? extra.signal : undefined
    const signal = extraSignal ? AbortSignal.any([context.signal, extraSignal]) : context.signal
    signal.throwIfAborted()
    const input = name === 'open_file_preview' ? { ...args, readOnly: true } : args
    const decision = await context.canUseTool(`mcp__${CORE_HOST_MCP_SERVER_NAME}__${name}`, input, { signal })
    if (decision.behavior !== 'allow') throw new Error(decision.message)
    const response = await execute(tools, context, name, decision.updatedInput ?? input, signal)
    return { content: response.content, ...(response.isError ? { isError: true } : {}) }
  }))
  return sdk.createSdkMcpServer({ name: CORE_HOST_MCP_SERVER_NAME, version: '1.0.0', tools: entries })
}
