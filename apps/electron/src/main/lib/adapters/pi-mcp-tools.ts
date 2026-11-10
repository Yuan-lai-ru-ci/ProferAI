/**
 * Pi Runtime 用户 MCP 工具桥接层
 *
 * Claude runtime 继续使用 Claude Agent SDK 原生 mcpServers；Pi SDK 当前没有等价
 * mcpServers 参数，因此 Profer 在主进程连接用户配置的 MCP server，并把 MCP tools
 * 映射成 Pi customTools。
 *
 * 连接生命周期约定：
 * - 连接 key = `${workspaceSlug ?? '-'}::${serverName}::${configHash(config)}`，
 *   配置变化自然会生成新 key，但用户改的是 stdio server 自己的配置文件（例如 rcf 的
 *   TOML）时配置 hash 不变，必须靠 restartMcpServer 显式重建。
 * - 每次连接记录单调递增的 epoch；重启后代际递增，旧代际的探测结果与工具清单作废。
 * - dispose() 只用于 app quit；重启/断开/回收都不允许置位 disposed。
 */

import { isEffectiveAgentPresetMcpServerAllowed, isEffectiveAgentPresetToolDisabled, type EffectiveAgentPresetPolicy, type McpConnectionSnapshot, type McpServerRestartResult } from '@profer/shared'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { statSync } from 'node:fs'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import type { TextContent, ImageContent } from '@earendil-works/pi-ai'
import type { TSchema } from 'typebox'
import { Type } from 'typebox'

const DEFAULT_MCP_REQUEST_TIMEOUT_MS = 60_000
const DEFAULT_MCP_STARTUP_TIMEOUT_MS = 30_000
const MCP_CONNECTION_HEALTH_CHECK_INTERVAL_MS = 120_000
/** 健康检查 ping 的短超时（不应阻塞正常调用路径） */
const MCP_CONNECTION_HEALTH_PING_TIMEOUT_MS = 5_000
const MCP_MAX_RETRIES = 2
/** 空闲连接回收阈值：默认 10 分钟 */
const DEFAULT_MCP_CONNECTION_TTL_MS = 10 * 60_000
/** 回收器扫描间隔 */
const MCP_CONNECTION_REAPER_INTERVAL_MS = 60_000

interface PiMcpServerConfig {
  type?: unknown
  command?: unknown
  args?: unknown
  env?: unknown
  url?: unknown
  headers?: unknown
  startup_timeout_sec?: unknown
  timeout?: unknown
}

export type PiMcpServers = Record<string, Record<string, unknown>>

type McpToolInfo = Awaited<ReturnType<Client['listTools']>>['tools'][number]

type McpCallToolResult = Awaited<ReturnType<Client['callTool']>>

/** 桥接层可选上下文：连接归属工作区，以及需要观测的外部配置文件 */
export interface PiMcpBridgeOptions {
  workspaceSlug?: string
  /** serverName -> 该 server 在进程内缓存的外部配置文件绝对路径 */
  externalStatePaths?: Record<string, string[]>
}

function stableStringify(value: unknown): string {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const obj = value as Record<string, unknown>
  return `{${Object.keys(obj).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`).join(',')}}`
}

function configHash(config: unknown): string {
  return createHash('sha256').update(stableStringify(config)).digest('hex').slice(0, 16)
}

export function normalizeMcpToolNameSegment(segment: string): string {
  const normalized = segment.replace(/[^A-Za-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '')
  if (!normalized) return 'unnamed'
  return /^[A-Za-z_]/.test(normalized) ? normalized : `_${normalized}`
}

export function mcpToolName(serverName: string, toolName: string): string {
  return `mcp__${normalizeMcpToolNameSegment(serverName)}__${normalizeMcpToolNameSegment(toolName)}`
}

function getHeaders(config: PiMcpServerConfig): Record<string, string> | undefined {
  if (!config.headers || typeof config.headers !== 'object') return undefined
  const headers: Record<string, string> = {}
  for (const [key, value] of Object.entries(config.headers as Record<string, unknown>)) {
    if (typeof value === 'string') headers[key] = value
  }
  return Object.keys(headers).length > 0 ? headers : undefined
}

function getTimeoutMs(config: PiMcpServerConfig): number {
  const timeoutSec = typeof config.startup_timeout_sec === 'number'
    ? config.startup_timeout_sec
    : typeof config.timeout === 'number'
      ? config.timeout
      : undefined
  if (!timeoutSec || !Number.isFinite(timeoutSec) || timeoutSec <= 0) return DEFAULT_MCP_STARTUP_TIMEOUT_MS
  return timeoutSec * 1000
}

function createTransport(name: string, config: PiMcpServerConfig): Transport | undefined {
  const type = config.type
  if (type === 'stdio') {
    if (typeof config.command !== 'string' || !config.command.trim()) {
      console.warn(`[Pi MCP] MCP 服务器 ${name} 缺少 command，已跳过`)
      return undefined
    }
    const env = typeof config.env === 'object' && config.env
      ? Object.fromEntries(Object.entries(config.env as Record<string, unknown>).filter(([, value]) => typeof value === 'string')) as Record<string, string>
      : undefined
    return new StdioClientTransport({
      command: config.command,
      args: Array.isArray(config.args) ? config.args.filter((arg): arg is string => typeof arg === 'string') : undefined,
      env,
      stderr: 'inherit',
    })
  }

  if (type === 'http') {
    if (typeof config.url !== 'string' || !config.url.trim()) {
      console.warn(`[Pi MCP] MCP 服务器 ${name} 缺少 url，已跳过`)
      return undefined
    }
    const headers = getHeaders(config)
    return new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: headers ? { headers } : undefined,
    })
  }

  if (type === 'sse') {
    if (typeof config.url !== 'string' || !config.url.trim()) {
      console.warn(`[Pi MCP] MCP 服务器 ${name} 缺少 url，已跳过`)
      return undefined
    }
    const headers = getHeaders(config)
    return new SSEClientTransport(new URL(config.url), {
      requestInit: headers ? { headers } : undefined,
      eventSourceInit: headers
        ? ({
          fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, {
            ...init,
            headers: {
              ...(init?.headers as Record<string, string> | undefined),
              ...headers,
            },
          }),
        } as any)
        : undefined,
    })
  }

  console.warn(`[Pi MCP] MCP 服务器 ${name} 使用暂不支持的类型 ${String(type)}，已跳过`)
  return undefined
}

function isObjectSchema(schema: unknown): schema is Record<string, unknown> {
  return !!schema && typeof schema === 'object' && !Array.isArray(schema)
}

function toTypeBoxSchema(schema: unknown): TSchema {
  if (!isObjectSchema(schema)) return Type.Object({})
  if (schema.type !== 'object') return Type.Object({})
  return Type.Unsafe(schema)
}

function stringifyForTool(content: unknown): string {
  if (typeof content === 'string') return content
  try {
    return JSON.stringify(content, null, 2)
  } catch {
    return String(content)
  }
}

function convertMcpResult(result: McpCallToolResult): AgentToolResult<unknown> {
  const content: Array<TextContent | ImageContent> = []

  if ('content' in result && Array.isArray(result.content)) {
    for (const block of result.content) {
      if (block.type === 'text') {
        content.push({ type: 'text', text: block.text })
      } else if (block.type === 'image') {
        content.push({ type: 'image', data: block.data, mimeType: block.mimeType })
      } else {
        content.push({ type: 'text', text: stringifyForTool(block) })
      }
    }
  } else if ('toolResult' in result) {
    content.push({ type: 'text', text: stringifyForTool(result.toolResult) })
  }

  if ('structuredContent' in result && result.structuredContent !== undefined) {
    content.push({ type: 'text', text: `structuredContent:\n${stringifyForTool(result.structuredContent)}` })
  }

  if (content.length === 0) {
    content.push({ type: 'text', text: stringifyForTool(result) })
  }

  if ('isError' in result && result.isError) {
    content.unshift({ type: 'text', text: 'MCP tool returned isError=true.' })
  }

  return {
    content,
    details: result,
  } as AgentToolResult<unknown>
}

// ---------------------------------------------------------------------------
// 连接依赖工厂（可注入，供测试替换真实子进程）
// ---------------------------------------------------------------------------

interface McpConnectionDeps {
  client: Client
  transport: Transport
}

type McpConnectionFactory = (serverName: string, config: PiMcpServerConfig) => Promise<McpConnectionDeps>

async function defaultConnectionFactory(serverName: string, config: PiMcpServerConfig): Promise<McpConnectionDeps> {
  const transport = createTransport(serverName, config)
  if (!transport) throw new Error(`无法创建 MCP transport: ${serverName}`)

  const client = new Client({ name: 'profer-pi-agent-mcp-bridge', version: '0.1.0' }, { capabilities: {} })
  await client.connect(transport, { timeout: getTimeoutMs(config) })
  return { client, transport }
}

let connectionFactory: McpConnectionFactory = defaultConnectionFactory

/** 仅测试使用：替换 transport/client 创建；传 undefined 恢复默认实现。 */
export function __setMcpConnectionFactoryForTest(factory?: McpConnectionFactory): void {
  connectionFactory = factory ?? defaultConnectionFactory
}

/** 模块级单调代际计数器：新连接的 epoch 一定大于旧连接 */
let connectionEpochCounter = 0

function nextEpoch(): number {
  connectionEpochCounter += 1
  return connectionEpochCounter
}

function connectionKey(serverName: string, config: PiMcpServerConfig, workspaceSlug?: string): string {
  return `${workspaceSlug ?? '-'}::${serverName}::${configHash(config)}`
}

function transportPid(transport: Transport): number | null {
  const pid = (transport as { pid?: number | null }).pid
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? pid : null
}

/**
 * 清理 stdio 子进程树。
 * SDK 的 transport.close() 只结束直接子进程，npx/uvx 拉起的孙进程会残留。
 * win32 用 taskkill /T /F，POSIX 对残留 pid 直接 SIGKILL；全部 best-effort。
 */
function terminateProcessTree(pid: number | null, serverName: string): void {
  if (!pid) return

  if (process.platform === 'win32') {
    try {
      const killer = spawn('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true })
      killer.on('error', () => {
        // 进程已退出或 taskkill 不可用，忽略
      })
      killer.unref()
      console.warn(`[Pi MCP] 已请求结束 MCP 子进程树: ${serverName} pid=${pid}`)
    } catch {
      // 忽略
    }
    return
  }

  try {
    process.kill(pid, 0)
  } catch {
    return // 进程已退出，无需清理
  }

  try {
    process.kill(pid, 'SIGKILL')
    console.warn(`[Pi MCP] 已强制结束残留 MCP 子进程: ${serverName} pid=${pid}`)
  } catch (error) {
    console.warn(`[Pi MCP] 结束残留 MCP 子进程失败（忽略）: ${serverName} pid=${pid}`, error)
  }
}

// ---------------------------------------------------------------------------
// 连接记录
// ---------------------------------------------------------------------------

interface McpConnection {
  key: string
  serverName: string
  workspaceSlug?: string
  epoch: number
  client: Client
  transport: Transport
  /** listTools 结果缓存；连接关闭时丢弃 */
  tools?: McpToolInfo[]
  connectedAt: number
  lastUsedAt: number
  /** 该 server 关联的外部配置文件，用于判断连接是否已过期 */
  externalStatePaths?: string[]
  healthTimer?: ReturnType<typeof setInterval>
}

interface McpConnectionSlot {
  key: string
  serverName: string
  workspaceSlug?: string
  promise: Promise<McpConnection>
  /** 连接建立完成后才有值；pending / rejected 的 slot 没有 */
  connection?: McpConnection
  failed?: boolean
}

/** 关闭单个连接：先清缓存与定时器，再关 transport，最后兜底清理孙进程。 */
async function closeMcpConnection(conn: McpConnection, reason: string): Promise<void> {
  if (conn.healthTimer) {
    clearInterval(conn.healthTimer)
    conn.healthTimer = undefined
  }
  conn.tools = undefined

  const pid = transportPid(conn.transport)
  try {
    await conn.transport.close()
  } catch (error) {
    console.warn(`[Pi MCP] 关闭 MCP 连接出错（忽略）: ${conn.serverName} pid=${pid ?? '-'} (${reason})`, error)
  }

  // 只对真实 stdio transport 做进程树清理；测试替身不会触发 kill
  if (conn.transport instanceof StdioClientTransport) {
    terminateProcessTree(pid, conn.serverName)
  }
}

/** externalStatePaths 中任一文件 mtime 晚于连接建立时间即视为过期（读失败忽略）。 */
function isExternalStateStale(paths: string[] | undefined, connectedAt: number): boolean {
  if (!paths || paths.length === 0) return false
  for (const filePath of paths) {
    try {
      if (statSync(filePath).mtimeMs > connectedAt) return true
    } catch {
      // 文件不存在或不可读：忽略，不当作过期
    }
  }
  return false
}

// ---------------------------------------------------------------------------
// 连接管理器
// ---------------------------------------------------------------------------

class PiMcpClientManager {
  private readonly connections = new Map<string, McpConnectionSlot>()
  /** 只在 app quit 时置位；重启/断开/回收都不允许污染它 */
  private disposed = false

  /**
   * 关闭所有活跃的 MCP 连接，释放 stdio 子进程和网络资源。
   * 只应在 app quit 时调用；之后不再接受新连接。
   */
  async dispose(): Promise<void> {
    this.disposed = true
    stopMcpConnectionReaper()
    const keys = [...this.connections.keys()]
    await Promise.allSettled(keys.map((key) => this.closeSlot(key, 'app quit')))
  }

  /** 关闭指定 serverName 下的所有 key（跨 workspace 与不同配置 hash）。 */
  async closeServer(serverName: string, reason: string): Promise<number> {
    const keys = [...this.connections.entries()]
      .filter(([, slot]) => slot.serverName === serverName)
      .map(([key]) => key)
    await Promise.all(keys.map((key) => this.closeSlot(key, reason)))
    return keys.length
  }

  /** 关闭 serverName 不在 activeServerNames 里的连接（禁用/删除即断开）。 */
  async reconcile(activeServerNames: readonly string[]): Promise<void> {
    const active = new Set(activeServerNames)
    const stale = [...this.connections.entries()]
      .filter(([, slot]) => !active.has(slot.serverName))
      .map(([key]) => key)
    await Promise.all(stale.map((key) => this.closeSlot(key, 'server 已禁用或删除')))
  }

  /** 关闭 lastUsedAt 超过 ttl 的空闲连接。 */
  async reapIdle(ttlMs: number): Promise<void> {
    const deadline = Date.now() - ttlMs
    const idle = [...this.connections.entries()]
      .filter(([, slot]) => !!slot.connection && slot.connection.lastUsedAt < deadline)
      .map(([key]) => key)
    if (idle.length === 0) return
    console.log(`[Pi MCP] 回收 ${idle.length} 个空闲超过 ${Math.round(ttlMs / 1000)}s 的 MCP 连接`)
    await Promise.all(idle.map((key) => this.closeSlot(key, '空闲回收')))
  }

  /** 只输出已建立完成的连接；pending 与 rejected 一律跳过。 */
  snapshots(): McpConnectionSnapshot[] {
    const snapshots: McpConnectionSnapshot[] = []
    for (const slot of this.connections.values()) {
      const conn = slot.connection
      if (!conn) continue
      snapshots.push({
        serverName: conn.serverName,
        ...(conn.workspaceSlug ? { workspaceSlug: conn.workspaceSlug } : {}),
        connectedAt: conn.connectedAt,
        lastUsedAt: conn.lastUsedAt,
        epoch: conn.epoch,
        toolCount: conn.tools?.length ?? 0,
        pid: transportPid(conn.transport),
        externalStateStale: isExternalStateStale(conn.externalStatePaths, conn.connectedAt),
      })
    }
    return snapshots
  }

  async listTools(serverName: string, config: PiMcpServerConfig, options?: PiMcpBridgeOptions): Promise<McpToolInfo[]> {
    if (this.disposed) throw new Error('PiMcpClientManager 已关闭')
    const connection = await this.getConnection(serverName, config, options)
    connection.lastUsedAt = Date.now()
    if (connection.tools) return connection.tools
    const result = await connection.client.listTools(undefined, { timeout: DEFAULT_MCP_REQUEST_TIMEOUT_MS })
    connection.tools = result.tools
    return result.tools
  }

  async callTool(
    serverName: string,
    config: PiMcpServerConfig,
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    options?: PiMcpBridgeOptions,
  ): Promise<McpCallToolResult> {
    if (this.disposed) throw new Error('PiMcpClientManager 已关闭')
    let lastError: unknown
    for (let attempt = 0; attempt <= MCP_MAX_RETRIES; attempt++) {
      try {
        const connection = await this.getConnection(serverName, config, options)
        connection.lastUsedAt = Date.now()
        const result = await connection.client.callTool(
          { name: toolName, arguments: args },
          undefined,
          { signal, timeout: DEFAULT_MCP_REQUEST_TIMEOUT_MS, resetTimeoutOnProgress: true },
        )
        return result
      } catch (error) {
        lastError = error
        // 连接断开类错误：清除缓存、下次自动重连
        if (isMcpConnectionError(error) && attempt < MCP_MAX_RETRIES) {
          console.warn(`[Pi MCP] MCP 调用失败，尝试重连 (${attempt + 1}/${MCP_MAX_RETRIES}): ${serverName}/${toolName}`)
          await this.closeSlot(connectionKey(serverName, config, options?.workspaceSlug), '调用失败重连')
        } else {
          break
        }
      }
    }
    throw lastError
  }

  private async getConnection(serverName: string, config: PiMcpServerConfig, options?: PiMcpBridgeOptions): Promise<McpConnection> {
    if (this.disposed) throw new Error('PiMcpClientManager 已关闭')
    const key = connectionKey(serverName, config, options?.workspaceSlug)
    const existing = this.connections.get(key)
    if (existing && !existing.failed) {
      try {
        return await existing.promise
      } catch (error) {
        if (this.connections.get(key) === existing) this.connections.delete(key)
        throw error
      }
    }

    // promise 在下面赋值，slot 需要先能被子回调引用
    const slot = { key, serverName, workspaceSlug: options?.workspaceSlug } as McpConnectionSlot
    slot.promise = this.createConnection(serverName, config, key, options)
      .then((conn) => {
        slot.connection = conn
        return conn
      })
      .catch((error) => {
        slot.failed = true
        if (this.connections.get(key) === slot) this.connections.delete(key)
        throw error
      })
    this.connections.set(key, slot)
    return slot.promise
  }

  private async createConnection(serverName: string, config: PiMcpServerConfig, key: string, options?: PiMcpBridgeOptions): Promise<McpConnection> {
    const { client, transport } = await connectionFactory(serverName, config)
    const now = Date.now()
    const conn: McpConnection = {
      key,
      serverName,
      workspaceSlug: options?.workspaceSlug,
      epoch: nextEpoch(),
      client,
      transport,
      connectedAt: now,
      lastUsedAt: now,
      externalStatePaths: options?.externalStatePaths?.[serverName],
    }

    const previousOnError = transport.onerror
    transport.onerror = (error) => {
      previousOnError?.(error)
      console.warn(`[Pi MCP] MCP 服务器 ${serverName} transport error:`, error)
    }
    const previousOnClose = transport.onclose
    transport.onclose = () => {
      previousOnClose?.()
      if (conn.healthTimer) clearInterval(conn.healthTimer)
      const slot = this.connections.get(key)
      // 只有当前连接仍是 map 里那条时才移除，避免误删重建后的新连接
      if (slot?.connection === conn) this.connections.delete(key)
    }

    // 健康检查：定期 ping，失败即移除连接
    conn.healthTimer = setInterval(() => {
      void this.healthCheck(conn)
    }, MCP_CONNECTION_HEALTH_CHECK_INTERVAL_MS)
    conn.healthTimer.unref?.()

    return conn
  }

  /**
   * 只触发一次带短超时的异步 ping，失败就把连接从 Map 移除并关闭。
   * 它不判断存活，也不判断配置新鲜度——配置变化必须由 restart/reconcile 显式驱动。
   */
  private async healthCheck(conn: McpConnection): Promise<void> {
    try {
      await conn.client.ping({ timeout: MCP_CONNECTION_HEALTH_PING_TIMEOUT_MS })
    } catch (error) {
      console.warn(`[Pi MCP] 健康检查 ping 失败，移除连接: ${conn.serverName} pid=${transportPid(conn.transport) ?? '-'}`, error)
      await this.closeSlot(conn.key, 'ping 失败')
    }
  }

  /** 关闭并移除单个 key；pending 连接会等它建立后再关，避免子进程泄漏。 */
  private async closeSlot(key: string, reason: string): Promise<void> {
    const slot = this.connections.get(key)
    if (!slot) return
    this.connections.delete(key)

    let conn = slot.connection
    if (!conn) {
      try {
        conn = await slot.promise
      } catch {
        return // 连接本身失败，没有资源需要关闭
      }
    }
    await closeMcpConnection(conn, reason)
  }

  /** 仅测试使用：恢复 disposed 标志，让同一进程内可继续建连。 */
  resetDisposedForTest(): void {
    this.disposed = false
  }
}

/** 判断错误是否为 MCP 连接级错误（需重连），而非业务错误 */
function isMcpConnectionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const message = error.message.toLowerCase()
  return /connection|disconnect|transport|econnrefused|econnreset|epipe|not connected|closed/.test(message)
}

const manager = new PiMcpClientManager()
const mcpPolicyIdentities = new WeakMap<ToolDefinition, string>()

export function getMcpPolicyToolName(tool: ToolDefinition): string {
  return mcpPolicyIdentities.get(tool) ?? tool.name
}

interface McpToolBinding {
  serverName: string
  originalToolName: string
  tool: McpToolInfo
  manager: PiMcpClientManager
  managerConfig: PiMcpServerConfig
  managerOptions?: PiMcpBridgeOptions
}

function createPiMcpToolDefinition(binding: McpToolBinding): ToolDefinition {
  const toolName = mcpToolName(binding.serverName, binding.originalToolName)
  const description = binding.tool.description || `Call MCP tool ${binding.originalToolName} from server ${binding.serverName}`

  return {
    name: toolName,
    label: toolName,
    description,
    promptSnippet: `${toolName}: ${description}`,
    parameters: toTypeBoxSchema(binding.tool.inputSchema),
    async execute(_toolCallId, params, signal) {
      const args = isObjectSchema(params) ? params as Record<string, unknown> : {}
      const result = await binding.manager.callTool(
        binding.serverName,
        binding.managerConfig,
        binding.originalToolName,
        args,
        signal,
        binding.managerOptions,
      )
      return convertMcpResult(result)
    },
  } as ToolDefinition
}

/**
 * 将 Profer 已构建的 MCP server 配置转换为 Pi customTools。
 *
 * 注意：本函数仅供 Pi runtime 使用；Claude runtime 仍直接把 mcpServers 交给
 * Claude Agent SDK，不经过这里。
 */
export interface DiscoveredMcpTool {
  serverName: string
  config: PiMcpServerConfig
  tool: McpToolInfo
}

/** 保留原始服务器/工具身份，策略判断不能使用 Pi 转换后的调用别名。 */
export async function discoverExternalMcpTools(mcpServers: PiMcpServers, options?: PiMcpBridgeOptions): Promise<DiscoveredMcpTool[]> {
  const discovered: DiscoveredMcpTool[] = []

  // 并行连接所有 MCP 服务器，避免串行等待导致启动慢
  const entries = Object.entries(mcpServers).filter(([, rawConfig]) => {
    const type = (rawConfig as PiMcpServerConfig).type
    return type === 'stdio' || type === 'http' || type === 'sse'
  })

  const results = await Promise.allSettled(
    entries.map(async ([serverName, rawConfig]) => {
      const config = rawConfig as PiMcpServerConfig
      const mcpTools = await manager.listTools(serverName, config, options)
      return { serverName, config, mcpTools }
    }),
  )

  for (const result of results) {
    if (result.status === 'rejected') {
      console.warn('[Pi MCP] 连接或列出 MCP 服务器工具失败，已跳过:', result.reason)
      continue
    }
    const { serverName, config, mcpTools } = result.value
    for (const tool of mcpTools) discovered.push({ serverName, config, tool })
  }
  return discovered
}

export async function buildPiMcpTools(mcpServers: PiMcpServers, policy?: EffectiveAgentPresetPolicy, options?: PiMcpBridgeOptions): Promise<ToolDefinition[]> {
  const tools: ToolDefinition[] = []
  const seenToolNames = new Set<string>()
  for (const { serverName, config, tool } of await discoverExternalMcpTools(Object.fromEntries(Object.entries(mcpServers).filter(([name]) => !policy || isEffectiveAgentPresetMcpServerAllowed(policy, name))), options)) {
    const originalName = `mcp__${serverName}__${tool.name}`
    const piToolName = mcpToolName(serverName, tool.name)
    if (policy && (isEffectiveAgentPresetToolDisabled(policy, originalName) || policy.disabledTools?.includes(originalName) || policy.disabledTools?.includes(piToolName))) continue
    if (seenToolNames.has(piToolName)) {
      console.warn(`[Pi MCP] 工具名冲突 ${piToolName}，已跳过 ${serverName}/${tool.name}`)
      continue
    }
    seenToolNames.add(piToolName)
    const definition = createPiMcpToolDefinition({
      serverName,
      originalToolName: tool.name,
      tool,
      manager,
      managerConfig: config,
      managerOptions: options,
    })
    mcpPolicyIdentities.set(definition, originalName)
    tools.push(definition)
  }

  if (tools.length > 0) {
    console.log(`[Pi MCP] 已桥接 ${tools.length} 个用户 MCP 工具到 Pi customTools`)
  }

  return tools
}

/**
 * 重启单个 MCP server：关闭它名下所有连接（跨 workspace 与配置 hash），
 * 丢弃 tools 缓存并递增代际。下次 listTools 会重建连接与子进程。
 * 不会置位 disposed，因此重启后桥接仍可正常使用。
 */
export async function restartMcpServer(serverName: string): Promise<McpServerRestartResult> {
  // 代际递增：即使没有旧连接，新连接的 epoch 也必须大于重启前的任何探测结果
  nextEpoch()
  const closed = await manager.closeServer(serverName, '手动重启')
  console.log(`[Pi MCP] 重启 MCP server ${serverName}：已关闭 ${closed} 个连接`)
  return { ok: true, message: `已重启 ${closed} 个连接` }
}

/** 断开单个 MCP server 的所有连接；不清 disposed，下次调用会自动重连。 */
export async function disconnectMcpServer(serverName: string): Promise<void> {
  const closed = await manager.closeServer(serverName, '手动断开')
  console.log(`[Pi MCP] 断开 MCP server ${serverName}：已关闭 ${closed} 个连接`)
}

/** 关闭 serverName 不在 activeServerNames 里的连接，用于禁用/删除 server 即断开。 */
export async function reconcileMcpServers(activeServerNames: readonly string[]): Promise<void> {
  await manager.reconcile(activeServerNames)
}

/** 当前运行时连接快照（不含凭据）；只包含已建立完成的连接。 */
export function listMcpConnectionSnapshots(): McpConnectionSnapshot[] {
  return manager.snapshots()
}

let reaperTimer: ReturnType<typeof setInterval> | undefined
let reaperTtlMs = DEFAULT_MCP_CONNECTION_TTL_MS

function stopMcpConnectionReaper(): void {
  if (!reaperTimer) return
  clearInterval(reaperTimer)
  reaperTimer = undefined
}

/**
 * 启动空闲连接回收器：每 60s 扫一次，关闭 lastUsedAt 超过 ttl 的连接。
 * 重复调用幂等（只更新 TTL，不叠加定时器）。
 */
export function startMcpConnectionReaper(ttlMs: number = DEFAULT_MCP_CONNECTION_TTL_MS): void {
  reaperTtlMs = ttlMs > 0 ? ttlMs : DEFAULT_MCP_CONNECTION_TTL_MS
  if (reaperTimer) return
  reaperTimer = setInterval(() => {
    void manager.reapIdle(reaperTtlMs)
  }, MCP_CONNECTION_REAPER_INTERVAL_MS)
  reaperTimer.unref?.()
}

/** 关闭所有 MCP 连接。应在 app quit 时调用以清理 stdio 子进程。 */
export async function disposePiMcpConnections(): Promise<void> {
  await manager.dispose()
}

// ---------------------------------------------------------------------------
// 测试辅助（生产代码不应调用）
// ---------------------------------------------------------------------------

/** 仅测试使用：立刻执行一次空闲回收，避免等待 60s 定时器。 */
export async function __reapIdleConnectionsForTest(ttlMs: number = reaperTtlMs): Promise<void> {
  await manager.reapIdle(ttlMs)
}

/** 仅测试使用：清空模块单例状态（连接、代际、回收器、工厂）。 */
export async function __resetMcpBridgeForTest(): Promise<void> {
  await manager.dispose()
  manager.resetDisposedForTest()
  connectionEpochCounter = 0
  reaperTtlMs = DEFAULT_MCP_CONNECTION_TTL_MS
  connectionFactory = defaultConnectionFactory
}
