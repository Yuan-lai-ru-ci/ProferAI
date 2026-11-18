import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { filterDisabledTools, isAgentPresetToolGroupDisabled } from '@profer/shared'
import type { PiAgentQueryOptions } from '@profer/agent-provider-pi/pi-agent-adapter'
import type { WebServiceConfig } from './web-service'
import { fetchWebPage, formatFetchResults, formatSearchResults, searchWeb, type WebSearchDepth } from './web-service'

export interface CoreWebToolFactory {
  defineTool(definition: {
    name: string
    label: string
    description: string
    promptSnippet: string
    parameters: unknown
    execute: (toolCallId: string, params: unknown, signal?: AbortSignal) => Promise<CoreWebToolResult>
  }): unknown
}

export interface CoreWebToolSchema {
  string(): unknown
  number(): unknown
  optional(value: unknown): unknown
  object(value: Record<string, unknown>): unknown
  array(value: unknown): unknown
  union(values: unknown[]): unknown
  literal(value: string): unknown
}

export interface CoreWebToolResult extends Record<string, unknown> {
  content: Array<{ type: 'text'; text: string }>
  details: unknown
  isError?: boolean
}

export interface CoreWebToolContext {
  disabledTools?: string[]
  disabledToolGroups?: string[]
  signal?: AbortSignal
  /** 宿主会话级权限与取消检查；名称为 Pi 短名或 Claude 的 mcp__web__ 名称。 */
  authorize(toolName: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<void>
}

type PiWebTool = NonNullable<PiAgentQueryOptions['customTools']>[number]
type PiWebSdk = { defineTool(definition: PiWebTool): PiWebTool }

function webToolsEnabled(config: WebServiceConfig, ctx: CoreWebToolContext): boolean {
  return config.enabled !== false && Boolean(config.apiKey?.trim())
    && !isAgentPresetToolGroupDisabled(ctx.disabledToolGroups, 'web')
}

function webToolAllowed(name: string, ctx: CoreWebToolContext): boolean {
  const aliases = [{ name }, { name: `mcp__web__${name}` }]
  return filterDisabledTools(aliases, ctx.disabledTools).length === aliases.length
}

/** 由 provider 的依赖解析 SDK/schema，避免 Core 另装一套 SDK 或 schema 版本。 */
export async function loadPiCoreWebTools(config: WebServiceConfig, ctx: CoreWebToolContext): Promise<PiWebTool[]> {
  if (!webToolsEnabled(config, ctx)) return []
  const requireProvider = createRequire(import.meta.resolve('@profer/agent-provider-pi'))
  const sdk = await import(pathToFileURL(requireProvider.resolve('@earendil-works/pi-coding-agent')).href) as PiWebSdk
  const { Type } = requireProvider('typebox') as { Type: {
    String(options?: { minLength: number }): PiWebTool['parameters']
    Number(): PiWebTool['parameters']
    Optional(value: unknown): PiWebTool['parameters']
    Object(value: Record<string, unknown>): PiWebTool['parameters']
    Array(value: unknown): PiWebTool['parameters']
    Union(values: unknown[]): PiWebTool['parameters']
    Literal(value: string): PiWebTool['parameters']
  } }
  const schema: CoreWebToolSchema = {
    string: () => Type.String({ minLength: 1 }), number: () => Type.Number(),
    optional: value => Type.Optional(value),
    object: value => Type.Object(value),
    array: value => Type.Array(value),
    union: values => Type.Union(values), literal: value => Type.Literal(value),
  }
  const definitions: PiWebTool[] = []
  buildCoreWebTools({ defineTool(definition) {
    if (!webToolAllowed(definition.name, ctx)) return undefined
    definitions.push(sdk.defineTool({ ...definition,
      parameters: definition.parameters as PiWebTool['parameters'],
      async execute(id, input, signal) {
        const activeSignal = signal && ctx.signal ? AbortSignal.any([signal, ctx.signal]) : signal ?? ctx.signal
        activeSignal?.throwIfAborted()
        await ctx.authorize(definition.name, input as Record<string, unknown>, activeSignal)
        activeSignal?.throwIfAborted()
        return definition.execute(id, input, activeSignal)
      },
    }))
  } }, schema, config)
  return definitions
}

/** Claude 使用同一业务定义生成 Zod raw shape，失败标记 isError，取消保持抛出。 */
export async function injectClaudeCoreWebTools(
  sdk: Pick<typeof import('@anthropic-ai/claude-agent-sdk'), 'tool' | 'createSdkMcpServer'>,
  mcpServers: Record<string, Record<string, unknown>>,
  config: WebServiceConfig,
  ctx: CoreWebToolContext,
): Promise<void> {
  if (!webToolsEnabled(config, ctx)) return
  const requireProvider = createRequire(import.meta.resolve('@profer/agent-provider-claude'))
  interface ZodValue { optional(): ZodValue }
  const { z } = requireProvider('zod') as { z: {
    string(): { min(value: number): ZodValue }
    number(): { finite(): ZodValue }
    array(value: unknown): ZodValue
    union(values: unknown[]): ZodValue
    literal(value: string): ZodValue
  } }
  type ZodType = ZodValue
  const schema: CoreWebToolSchema = {
    string: () => z.string().min(1), number: () => z.number().finite(),
    optional: value => (value as ZodType).optional(), object: value => value,
    array: value => z.array(value as ZodType),
    union: values => z.union(values as [ZodType, ZodType, ...ZodType[]]), literal: value => z.literal(value),
  }
  const tools: ReturnType<typeof sdk.tool>[] = []
  buildCoreWebTools({ defineTool(definition) {
    if (!webToolAllowed(definition.name, ctx)) return undefined
    tools.push(sdk.tool(definition.name, definition.description,
      definition.parameters as Parameters<typeof sdk.tool>[2], async (input, extra) => {
        const extraSignal = extra && typeof extra === 'object' && 'signal' in extra && extra.signal instanceof AbortSignal ? extra.signal : undefined
        const activeSignal = extraSignal && ctx.signal ? AbortSignal.any([extraSignal, ctx.signal]) : extraSignal ?? ctx.signal
        activeSignal?.throwIfAborted()
        try {
          await ctx.authorize(`mcp__web__${definition.name}`, input, activeSignal)
          activeSignal?.throwIfAborted()
          return await definition.execute('', input, activeSignal)
        } catch (error) {
          activeSignal?.throwIfAborted()
          return { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true }
        }
      }))
  } }, schema, config)
  if (tools.length) mcpServers.web = sdk.createSdkMcpServer({ name: 'web', version: '1.0.0', tools }) as unknown as Record<string, unknown>
}

function depth(value: unknown): WebSearchDepth | undefined {
  return value === 'basic' || value === 'advanced' ? value : undefined
}

function strings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const result = value.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean)
  return result.length ? result : undefined
}

export function buildCoreWebTools(factory: CoreWebToolFactory, schema: CoreWebToolSchema, config: WebServiceConfig): unknown[] {
  if (!config.apiKey?.trim() || config.enabled === false) return []
  return [
    factory.defineTool({
      name: 'WebSearch', label: '搜索网页', description: 'Search the web for current information through Profer Core Tavily integration.',
      promptSnippet: 'WebSearch: search current public information and cite source URLs.',
      parameters: schema.object({ query: schema.string(), maxResults: schema.optional(schema.number()), searchDepth: schema.optional(schema.union([schema.literal('basic'), schema.literal('advanced')])), includeDomains: schema.optional(schema.array(schema.string())), excludeDomains: schema.optional(schema.array(schema.string())) }),
      async execute(_id, params, signal) {
        const args = params as Record<string, unknown>
        const result = await searchWeb(config, { query: typeof args.query === 'string' ? args.query : '', maxResults: typeof args.maxResults === 'number' ? args.maxResults : undefined, searchDepth: depth(args.searchDepth), includeDomains: strings(args.includeDomains), excludeDomains: strings(args.excludeDomains), signal })
        return { content: [{ type: 'text', text: formatSearchResults(result) }], details: result }
      },
    }),
    factory.defineTool({
      name: 'WebFetch', label: '抓取网页', description: 'Fetch readable Markdown content from a public HTTP/HTTPS URL through Profer Core Tavily integration.',
      promptSnippet: 'WebFetch: fetch readable webpage content from a URL and cite it.',
      parameters: schema.object({ url: schema.string(), prompt: schema.optional(schema.string()), extractDepth: schema.optional(schema.union([schema.literal('basic'), schema.literal('advanced')])), maxChars: schema.optional(schema.number()) }),
      async execute(_id, params, signal) {
        const args = params as Record<string, unknown>
        const result = await fetchWebPage(config, { url: typeof args.url === 'string' ? args.url : '', prompt: typeof args.prompt === 'string' ? args.prompt : undefined, extractDepth: depth(args.extractDepth), maxChars: typeof args.maxChars === 'number' ? args.maxChars : undefined, signal })
        return { content: [{ type: 'text', text: formatFetchResults(result) }], details: result }
      },
    }),
  ]
}
