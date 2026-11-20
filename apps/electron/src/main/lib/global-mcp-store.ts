import { randomUUID } from 'node:crypto'
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import type { GlobalMcpDefinition, WorkspaceGlobalMcpSummary, WorkspaceMcpConfig } from '@profer/shared'
import { BUILTIN_MCP_INJECTION_ORDER } from './agent-runtime-mcp-injection'
import { PRODUCT_MCP_INJECTION_ORDER } from './agent-runtime-product-mcp-injection'
import { getConfigDir } from './config-root'

const defaultPath = () => join(getConfigDir(), 'global-mcp.json')
const reserved = new Set<string>([
  ...BUILTIN_MCP_INJECTION_ORDER, ...PRODUCT_MCP_INJECTION_ORDER,
  'global-memory', 'lark-mcp', 'memos-cloud',
])
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && [null, Object.prototype].includes(Object.getPrototypeOf(v))
const keysOnly = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).every(k => keys.includes(k))
const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0
const strings = (v: unknown): v is string[] => Array.isArray(v) && Array.from(v).every(x => typeof x === 'string')
const safeKey = (k: string) => !(k in Object.prototype) && k !== 'prototype'
const stringMap = (v: unknown) => record(v) && Object.entries(v).every(([k, val]) => text(k) && safeKey(k) && typeof val === 'string')
const validName = (v: unknown): v is string => text(v) && /^[a-zA-Z0-9_-]+$/.test(v) && !v.includes('__') && !/^plugin_[0-9a-f]{16}$/i.test(v) && safeKey(v) && !reserved.has(v.toLowerCase())

function assertDefinition(v: unknown): asserts v is GlobalMcpDefinition {
  if (!record(v) || !keysOnly(v, ['name', 'entry', 'workspaceIds'])) throw new Error('全局 MCP 定义字段无效')
  if (!validName(v.name)) throw new Error('全局 MCP 名称无效或已由系统保留')
  if (!strings(v.workspaceIds) || !v.workspaceIds.every(text) || new Set(v.workspaceIds).size !== v.workspaceIds.length) {
    throw new Error('工作区 ID 必须是无重复的非空字符串列表')
  }
  const e = v.entry
  if (!record(e) || typeof e.enabled !== 'boolean') throw new Error('MCP 配置必须包含布尔启用状态')
  const common = ['type', 'enabled', 'externalStatePaths']
  if (Object.hasOwn(e, 'externalStatePaths') && (!strings(e.externalStatePaths)
    || !e.externalStatePaths.every(p => isAbsolute(p) && !p.includes('\0')))) {
    throw new Error('外部状态路径必须是绝对路径字符串列表')
  }
  if (e.type === 'stdio') {
    if (!keysOnly(e, [...common, 'command', 'args', 'env', 'timeout'])) throw new Error('stdio 配置包含不支持的字段')
    if (!text(e.command)) throw new Error('stdio 启动命令不能为空')
    if (e.args !== undefined && !strings(e.args)) throw new Error('命令参数必须是字符串列表')
    if (e.env !== undefined && !stringMap(e.env)) throw new Error('环境变量必须是有效的字符串键值对')
    if (e.timeout !== undefined && !(typeof e.timeout === 'number' && Number.isFinite(e.timeout) && e.timeout > 0)) {
      throw new Error('启动超时必须是大于零的有限数值')
    }
    return
  }
  if (e.type !== 'http' && e.type !== 'sse') throw new Error('仅支持 stdio、HTTP 和 SSE 传输')
  if (!keysOnly(e, [...common, 'url', 'headers'])) throw new Error('远程 MCP 配置包含不支持的字段')
  if (!text(e.url) || !URL.canParse(e.url) || !['https:', 'http:'].includes(new URL(e.url).protocol)) {
    throw new Error('服务地址必须是有效的 HTTP 或 HTTPS URL')
  }
  if (e.headers !== undefined && !stringMap(e.headers)) throw new Error('请求头必须是有效的字符串键值对')
}

export function listGlobalMcpServers(path = defaultPath()): GlobalMcpDefinition[] {
  const stat = lstatSync(path, { throwIfNoEntry: false })
  if (!stat) return []
  if (!stat.isFile()) throw new Error('全局 MCP 配置必须是普通文件')
  const raw = readFileSync(path, 'utf8')
  let rows: unknown
  try { rows = JSON.parse(raw) } catch { throw new Error('全局 MCP 配置不是有效 JSON') }
  if (!Array.isArray(rows)) throw new Error('全局 MCP 配置必须是定义列表')
  const definitions = rows.map((row: unknown) => {
    assertDefinition(row)
    return row
  })
  if (new Set(definitions.map(row => row.name)).size !== definitions.length) throw new Error('全局 MCP 名称重复')
  return definitions
}

function persist(path: string, rows: GlobalMcpDefinition[]): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  // 不复用 safe-file 的默认权限或备份策略，避免留下可被其他用户读取的凭据副本。
  const tmp = `${path}.${randomUUID()}.tmp`
  const fd = openSync(tmp, 'wx', 0o600)
  try {
    try { writeFileSync(fd, JSON.stringify(rows, null, 2) + '\n') } finally { closeSync(fd) }
    renameSync(tmp, path)
  } finally { rmSync(tmp, { force: true }) }
}

export function saveGlobalMcpServer(definition: GlobalMcpDefinition, mode: 'create' | 'update', path = defaultPath()): void {
  assertDefinition(definition)
  if (!['create', 'update'].includes(mode)) throw new Error('全局 MCP 保存模式无效')
  const rows = listGlobalMcpServers(path)
  const i = rows.findIndex(row => row.name === definition.name)
  if (mode === 'create') {
    if (i >= 0) throw new Error('全局 MCP 名称已存在')
    rows.push(definition)
  } else {
    if (i < 0) throw new Error('全局 MCP 不存在')
    rows[i] = definition
  }
  persist(path, rows)
}

export function deleteGlobalMcpServer(name: string, path = defaultPath()): void {
  if (!validName(name)) throw new Error('全局 MCP 名称无效')
  const rows = listGlobalMcpServers(path)
  const remaining = rows.filter(row => row.name !== name)
  if (remaining.length === rows.length) throw new Error('全局 MCP 不存在')
  persist(path, remaining)
}

function assigned(workspaceId: string, path: string) {
  return listGlobalMcpServers(path).filter(row => row.workspaceIds.includes(workspaceId))
}

export function resolveGlobalMcpForWorkspace(workspaceId: string, local: WorkspaceMcpConfig, path = defaultPath()): WorkspaceMcpConfig {
  try {
    const shared = Object.fromEntries(assigned(workspaceId, path).map(row => [row.name, row.entry]))
    return { servers: { ...shared, ...local.servers } }
  } catch { return local }
}

export function summarizeGlobalMcpForWorkspace(workspaceId: string, local: WorkspaceMcpConfig, path = defaultPath()): WorkspaceGlobalMcpSummary[] {
  return assigned(workspaceId, path).map(({ name, entry }) => ({ name, enabled: entry.enabled, shadowed: Object.hasOwn(local.servers, name) }))
}
