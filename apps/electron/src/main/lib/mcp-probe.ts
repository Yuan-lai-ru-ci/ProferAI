/**
 * MCP 服务器独立探测
 *
 * 设置页「测试连接」专用：每次探测都新建 transport + client，探测结束立即关闭，
 * 不与运行时长连接（pi-mcp-tools.ts 的连接缓存）共享任何状态，因此结果永远是新鲜的。
 *
 * 设计约束：
 * - 不复用全局连接、不读写 lastTestResult（避免「写入结果导致指纹变化」的自指循环）
 * - 任何路径都必须关闭 transport，不能泄漏 stdio 子进程
 * - 返回的 message 是固定中文短句，绝不拼接 header/env 原文，防止凭据进入 UI 与日志
 */

import { createHash } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { McpProbeFailureReason, McpServerEntry, McpToolSummary } from '@profer/shared'

/** 探测默认超时：设置页交互，超过 20s 视为不可用 */
const DEFAULT_PROBE_TIMEOUT_MS = 20_000
/** 工具分页保护上限，防止服务端返回重复 cursor 造成死循环 */
const MAX_TOOL_PAGES = 50

export interface McpProbeResult {
  success: boolean
  message: string
  reason?: McpProbeFailureReason
  tools?: McpToolSummary[]
  serverInfo?: { name?: string; version?: string }
}

export interface McpProbeOptions {
  timeoutMs?: number
}

/** 探测只需要 transport 的关闭能力 */
export interface McpProbeTransport {
  close(): Promise<void>
}

export interface McpProbeToolInfo {
  name: string
  annotations?: { readOnlyHint?: boolean }
}

export interface McpProbeListToolsResult {
  tools?: McpProbeToolInfo[]
  nextCursor?: string
}

/** 探测只需要 client 的连接、列工具、版本信息能力 */
export interface McpProbeClient {
  connect(transport: McpProbeTransport, options?: { signal?: AbortSignal; timeout?: number }): Promise<void>
  listTools(
    params?: { cursor?: string },
    options?: { signal?: AbortSignal; timeout?: number },
  ): Promise<McpProbeListToolsResult>
  getServerVersion?(): { name?: string; version?: string } | undefined
}

/** 测试注入点：默认实现是真实的 SDK Client/Transport */
export interface McpProbeDeps {
  createClient?: () => McpProbeClient
  createTransport?: (name: string, entry: McpServerEntry) => McpProbeTransport
}

/** 内部超时错误，用于让 classifyMcpProbeError 识别为 handshake-timeout */
class McpProbeTimeoutError extends Error {
  readonly code = 'ETIMEDOUT'

  constructor(label: string, timeoutMs: number) {
    super(`${label} 超时（${timeoutMs}ms）`)
    this.name = 'TimeoutError'
  }
}

/** 配置本身不合法，直接给出结论而不发起连接 */
class McpProbeConfigError extends Error {
  readonly reason: McpProbeFailureReason

  constructor(reason: McpProbeFailureReason, message: string) {
    super(message)
    this.name = 'McpProbeConfigError'
    this.reason = reason
  }
}

/**
 * 计算配置指纹：稳定序列化（键排序）后 sha256 前 16 位
 *
 * 必须排除 lastTestResult，否则「写入测试结果」会改变指纹，导致结果永远作废。
 */
export function mcpConfigFingerprint(entry: McpServerEntry): string {
  const { lastTestResult: _ignored, ...config } = entry
  return createHash('sha256').update(stableStringify(config)).digest('hex').slice(0, 16)
}

function stableStringify(value: unknown): string {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`).join(',')}}`
}

/**
 * 错误分类：把各种 SDK/系统错误归并成 UI 可区分的失败原因
 */
export function classifyMcpProbeError(error: unknown): McpProbeFailureReason {
  const { text, status } = collectErrorSignals(error)
  const haystack = text.toLowerCase()

  // 命令不存在：spawn ENOENT / command not found
  if (
    /enoent/.test(haystack)
    || /command not found/.test(haystack)
    || /no such file or directory/.test(haystack)
    || /not recognized as an internal or external command/.test(haystack)
  ) {
    return 'command-missing'
  }

  // 超时：AbortError、ETIMEDOUT、timeout 关键字
  if (/etimedout|aborterror|timeout|timed out|aborted/.test(haystack)) {
    return 'handshake-timeout'
  }

  // 鉴权失败
  if (status === 401 || /\b401\b|unauthorized|unauthenticated|invalid token|invalid_token|invalid api key/.test(haystack)) {
    return 'unauthorized'
  }

  // 权限不足
  if (status === 403 || /\b403\b|forbidden|insufficient scope|insufficient_scope|permission denied/.test(haystack)) {
    return 'forbidden'
  }

  // 协议/版本不匹配：initialize 失败、JSON-RPC 解析失败
  if (
    /protocol version|unsupported protocol|protocol mismatch|json-?rpc|parse error|invalid message|unexpected token/.test(haystack)
    || /initialize/.test(haystack)
  ) {
    return 'protocol-incompatible'
  }

  // 网络层
  if (
    /econnrefused|econnreset|enotfound|ehostunreach|econnaborted|epipe|getaddrinfo|fetch failed|socket hang up|network error/.test(haystack)
  ) {
    return 'network'
  }

  return 'unknown'
}

/** 汇总错误对象里可用于分类的信号（message/code/status 及 cause 链） */
function collectErrorSignals(error: unknown): { text: string; status?: number } {
  const parts: string[] = []
  let status: number | undefined

  const visit = (value: unknown, depth: number): void => {
    if (depth > 4 || value === undefined || value === null) return
    if (typeof value === 'string') {
      parts.push(value)
      return
    }
    if (typeof value === 'number') {
      parts.push(String(value))
      return
    }
    if (typeof value !== 'object') return

    const record = value as Record<string, unknown>
    if (typeof record.message === 'string') parts.push(record.message)
    if (typeof record.name === 'string') parts.push(record.name)
    if (typeof record.code === 'string' || typeof record.code === 'number') parts.push(String(record.code))
    if (typeof record.status === 'number') status ??= record.status
    if (typeof record.statusCode === 'number') status ??= record.statusCode

    visit(record.cause, depth + 1)
    visit(record.error, depth + 1)
    visit(record.data, depth + 1)
  }

  visit(error, 0)
  return { text: parts.join(' | '), status }
}

/** 固定中文文案：只描述原因，不携带任何 header/env 原文 */
function failureMessage(reason: McpProbeFailureReason): string {
  switch (reason) {
    case 'command-missing':
      return '启动命令不存在或不可执行'
    case 'handshake-timeout':
      return '握手超时，服务器未在限定时间内完成初始化'
    case 'unauthorized':
      return '鉴权失败：凭据无效或缺失'
    case 'forbidden':
      return '鉴权通过但权限不足'
    case 'protocol-incompatible':
      return '协议不兼容：服务器未按 MCP 协议完成初始化'
    case 'network':
      return '网络连接失败：无法访问服务器地址'
    default:
      return '连接失败：未知错误'
  }
}

/**
 * 独立探测单个 MCP 服务器
 *
 * 每次调用都会新建连接并在结束时关闭，不复用任何缓存连接。
 */
export async function probeMcpServer(
  name: string,
  entry: McpServerEntry,
  options?: McpProbeOptions,
): Promise<McpProbeResult> {
  return probeMcpServerWithDeps(name, entry, options, {})
}

/**
 * 带依赖注入的探测实现（测试用；生产代码请用 probeMcpServer）
 */
export async function probeMcpServerWithDeps(
  name: string,
  entry: McpServerEntry,
  options: McpProbeOptions | undefined,
  deps: McpProbeDeps,
): Promise<McpProbeResult> {
  const timeoutMs = options?.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_PROBE_TIMEOUT_MS
  const deadline = Date.now() + timeoutMs
  const remaining = (label: string): number => {
    const left = deadline - Date.now()
    if (left <= 0) throw new McpProbeTimeoutError(label, timeoutMs)
    return left
  }

  let transport: McpProbeTransport | undefined
  try {
    transport = (deps.createTransport ?? createProbeTransport)(name, entry)
    const client = (deps.createClient ?? createProbeClient)()
    const controller = new AbortController()

    try {
      await runWithTimeout(
        client.connect(transport, { signal: controller.signal, timeout: remaining('连接') }),
        remaining('连接'),
        '连接',
      )

      const tools = await listAllTools(client, remaining)
      const serverInfo = readServerInfo(client)
      controller.abort()

      return {
        success: true,
        message: tools.length > 0 ? `连接成功，发现 ${tools.length} 个工具` : '连接成功，服务器未声明工具',
        tools,
        ...(serverInfo ? { serverInfo } : {}),
      }
    } catch (error) {
      controller.abort()
      const reason = error instanceof McpProbeConfigError
        ? error.reason
        : classifyMcpProbeError(error)
      const message = error instanceof McpProbeConfigError
        ? error.message
        : failureMessage(reason)
      return { success: false, message, reason }
    }
  } catch (error) {
    // createTransport / createClient 本身抛错（例如 URL 非法、命令缺失）
    if (error instanceof McpProbeConfigError) {
      return { success: false, message: error.message, reason: error.reason }
    }
    const reason = classifyMcpProbeError(error)
    return { success: false, message: failureMessage(reason), reason }
  } finally {
    // 唯一关闭点：无论成功、失败还是超时都必须关，避免 stdio 子进程泄漏
    if (transport) {
      try {
        await transport.close()
      } catch {
        // 关闭失败不影响探测结论
      }
    }
  }
}

/** 分页取完全部工具，只保留 name 与 readOnly */
async function listAllTools(
  client: McpProbeClient,
  remaining: (label: string) => number,
): Promise<McpToolSummary[]> {
  const collected = new Map<string, McpToolSummary>()
  let cursor: string | undefined
  let page = 0

  do {
    page += 1
    const result = await runWithTimeout(
      client.listTools(cursor ? { cursor } : undefined, { timeout: remaining('获取工具列表') }),
      remaining('获取工具列表'),
      '获取工具列表',
    )
    for (const tool of result.tools ?? []) {
      if (!tool || typeof tool.name !== 'string' || !tool.name) continue
      if (collected.has(tool.name)) continue
      const summary: McpToolSummary = { name: tool.name }
      if (tool.annotations?.readOnlyHint === true) summary.readOnly = true
      collected.set(tool.name, summary)
    }
    cursor = typeof result.nextCursor === 'string' && result.nextCursor ? result.nextCursor : undefined
  } while (cursor && page < MAX_TOOL_PAGES)

  return [...collected.values()]
}

function readServerInfo(client: McpProbeClient): { name?: string; version?: string } | undefined {
  try {
    const info = client.getServerVersion?.()
    if (!info) return undefined
    const result: { name?: string; version?: string } = {}
    if (typeof info.name === 'string') result.name = info.name
    if (typeof info.version === 'string') result.version = info.version
    return Object.keys(result).length > 0 ? result : undefined
  } catch {
    return undefined
  }
}

/** 超时包装：内部自行吞掉后续 rejection，避免 unhandled rejection */
function runWithTimeout<T>(task: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new McpProbeTimeoutError(label, timeoutMs))
    }, Math.max(1, timeoutMs))
    ;(timer as { unref?: () => void }).unref?.()

    task.then(
      (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

function createProbeClient(): McpProbeClient {
  // 探测客户端不需要任何 capabilities 与缓存，每次都是全新实例
  return new Client(
    { name: 'profer-mcp-probe', version: '1.0.0' },
    { capabilities: {} },
  ) as unknown as McpProbeClient
}

/**
 * 构造 transport，与 adapters/pi-mcp-tools.ts 的 createTransport 对齐：
 * - stdio：合并 process.env.PATH 与 entry.env，保证命令可解析
 * - http/sse：透传 headers
 */
function createProbeTransport(name: string, entry: McpServerEntry): McpProbeTransport {
  const type = entry.type

  if (type === 'stdio') {
    const command = typeof entry.command === 'string' ? entry.command.trim() : ''
    if (!command) {
      throw new McpProbeConfigError('command-missing', '未配置启动命令')
    }
    return new StdioClientTransport({
      command,
      args: Array.isArray(entry.args) ? entry.args.filter((arg): arg is string => typeof arg === 'string') : undefined,
      env: buildStdioEnv(entry.env),
      // 探测不继承 stderr：服务端日志可能含凭据，不能进入主进程日志
      stderr: 'ignore',
    })
  }

  if (type === 'http' || type === 'sse') {
    const url = typeof entry.url === 'string' ? entry.url.trim() : ''
    if (!url) {
      throw new McpProbeConfigError('unknown', '未配置服务地址')
    }
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new McpProbeConfigError('unknown', '服务地址格式不合法')
    }

    const headers = getHeaders(entry)
    if (type === 'http') {
      return new StreamableHTTPClientTransport(parsed, {
        requestInit: headers ? { headers } : undefined,
      })
    }
    return new SSEClientTransport(parsed, {
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
        } as never)
        : undefined,
    })
  }

  throw new McpProbeConfigError('unknown', `不支持的传输类型：${String(type)}`)
}

function buildStdioEnv(entryEnv: Record<string, string> | undefined): Record<string, string> {
  const env: Record<string, string> = {}
  // SDK 在显式传入 env 时不会自动继承 PATH，这里补上，否则 npx/uvx 之类找不到
  const pathValue = process.env.PATH ?? process.env.Path
  if (pathValue) env.PATH = pathValue
  if (process.platform === 'win32' && process.env.PATHEXT) env.PATHEXT = process.env.PATHEXT

  for (const [key, value] of Object.entries(entryEnv ?? {})) {
    if (typeof value === 'string') env[key] = value
  }
  return env
}

function getHeaders(entry: McpServerEntry): Record<string, string> | undefined {
  if (!entry.headers || typeof entry.headers !== 'object') return undefined
  const headers: Record<string, string> = {}
  for (const [key, value] of Object.entries(entry.headers)) {
    if (typeof value === 'string') headers[key] = value
  }
  return Object.keys(headers).length > 0 ? headers : undefined
}
