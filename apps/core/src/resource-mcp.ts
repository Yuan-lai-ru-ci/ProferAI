import { join } from 'node:path'
import type { McpConnectionSnapshot, McpServerEntry } from '@profer/shared'
import { assertSafeSkillSegment } from '@profer/agent-provider-pi/skills/skill-path-security'
import { mcpConfigFingerprint, probeMcpServer } from '@profer/agent-provider-pi/pi/mcp-probe'
import { restartMcpServer } from '@profer/agent-provider-pi/pi/mcp-tools'
import { atomicWriteJson } from '../../../packages/session-store/src/atomic-write'
import { assertResourcePath, coreWorkspaceDirectory, readResourceObject, resourceObject, resourceText } from './resource-paths'
import type { CoreResourceOperationContext } from './resource-paths'

export const CORE_MCP_OPERATION_ARITY: Record<string, [number, number]> = {
  probeMcpServer: [2, 3], restartMcpServer: [1, 2], listMcpConnectionSnapshots: [0, 0],
}

function serverName(value: unknown): string {
  const name = assertSafeSkillSegment(resourceText(value), 'MCP server name')
  if (name === 'planning' || name === 'goal') throw new Error('Core用户MCP不能覆盖内置控制服务器')
  return name
}
function probeEntry(value: unknown): McpServerEntry {
  const input = resourceObject(value)
  const type = input.type ?? (input.command ? 'stdio' : input.url ? 'http' : undefined)
  if (type !== 'stdio' && type !== 'http' && type !== 'sse') throw new Error('Core MCP transport不支持')
  const entry: McpServerEntry = { type, enabled: input.enabled !== false }
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new Error('Core MCP enabled无效')
  for (const key of ['command', 'url'] as const) if (input[key] !== undefined) entry[key] = resourceText(input[key], 8192)
  if (input.args !== undefined) {
    if (!Array.isArray(input.args) || input.args.length > 256) throw new Error('Core MCP args无效')
    entry.args = input.args.map(arg => resourceText(arg, 8192))
  }
  for (const field of ['env', 'headers'] as const) if (input[field] !== undefined) {
    const map = resourceObject(input[field])
    entry[field] = Object.fromEntries(Object.entries(map).map(([key, value]) => [resourceText(key, 8192), resourceText(value, 8192)]))
  }
  if (input.timeout !== undefined) {
    if (typeof input.timeout !== 'number' || !Number.isFinite(input.timeout) || input.timeout <= 0) throw new Error('Core MCP timeout无效')
    entry.timeout = input.timeout
  }
  if (input.externalStatePaths !== undefined) {
    if (!Array.isArray(input.externalStatePaths) || input.externalStatePaths.length > 256) throw new Error('Core MCP externalStatePaths无效')
    entry.externalStatePaths = input.externalStatePaths.map(path => resourceText(path, 8192))
  }
  if (input.isBuiltin !== undefined) {
    if (typeof input.isBuiltin !== 'boolean') throw new Error('Core MCP isBuiltin无效')
    entry.isBuiltin = input.isBuiltin
  }
  return entry
}
function manager(context: CoreResourceOperationContext) {
  if (!context.mcpManager) throw new Error('当前Core未装配MCP连接管理器；不会回退其他Core')
  return context.mcpManager
}
function workspaceScope(context: CoreResourceOperationContext, workspaceId: string): string {
  // 与 runtime 的 MCP bridge options 完全一致；不是 UI 的 slug。
  return `${context.config.configDir}:${workspaceId}`
}

/** 保存禁用/删除配置后调用；只释放当前 Core 当前工作区的常驻连接。 */
export async function reconcileCoreMcpConnections(context: CoreResourceOperationContext, workspaceId: string, activeNames: string[]): Promise<void> {
  if (context.mcpManager) await context.mcpManager.reconcile(activeNames, workspaceScope(context, workspaceId))
}

export async function executeCoreMcpOperation(context: CoreResourceOperationContext, operation: string, args: unknown[]): Promise<unknown> {
  if (operation === 'listMcpConnectionSnapshots') {
    const scopes = new Map(context.workspaces.list().map(workspace => [workspaceScope(context, workspace.id), workspace.slug]))
    return manager(context).snapshots().flatMap((snapshot): McpConnectionSnapshot[] => {
      const slug = snapshot.workspaceSlug ? scopes.get(snapshot.workspaceSlug) : undefined
      return slug ? [{ ...snapshot, workspaceSlug: slug }] : []
    })
  }
  const name = serverName(args[0])
  if (operation === 'restartMcpServer') {
    // ElectronAPI 允许省略工作区：只重启当前 Core manager，不触碰其他 Core。
    if (args[1] === undefined) return restartMcpServer(name, { manager: manager(context) })
    const { workspace } = coreWorkspaceDirectory(context, args[1])
    // 与桌面语义一致：关闭并提升代际，下一次工具发现时重新握手；不重启 Core。
    const result = await restartMcpServer(name, { manager: manager(context), workspaceSlug: workspaceScope(context, workspace.id) })
    return { ...result, message: result.message.replace(workspaceScope(context, workspace.id), workspace.slug) }
  }
  if (operation !== 'probeMcpServer') throw new Error(`Core MCP操作不支持：${operation}`)
  const entry = probeEntry(args[1])
  const location = args[2] === undefined ? undefined : coreWorkspaceDirectory(context, args[2])
  // 连接前检查落盘路径，拒绝将配置写入任何软链目标。
  if (location) {
    assertResourcePath(join(location.directory, 'mcp.json'))
    if (location.workspace.storageMode === 'project') assertResourcePath(join(location.directory, 'mcp.local.json'))
  }
  const probe = await probeMcpServer(name, entry)
  const { serverInfo: _serverInfo, ...outcome } = probe
  if (!location) return outcome
  const basePath = join(location.directory, 'mcp.json')
  const targetPath = location.workspace.storageMode === 'project' ? join(location.directory, 'mcp.local.json') : basePath
  try {
    const base = readResourceObject(basePath) ?? { servers: {} }
    const target = targetPath === basePath ? base : readResourceObject(targetPath) ?? { servers: {} }
    const baseServers = resourceObject(base.servers), targetServers = resourceObject(target.servers)
    // 未保存的草稿只返回探测结论，不创建幽灵配置或复制 base 凭据到 local。
    if (!Object.hasOwn(baseServers, name) && !Object.hasOwn(targetServers, name)) return outcome
    const existing = Object.hasOwn(targetServers, name) ? resourceObject(targetServers[name]) : {}
    await atomicWriteJson(targetPath, { ...target, servers: { ...targetServers, [name]: { ...existing,
      lastTestResult: { ...outcome, timestamp: Date.now(), fingerprint: mcpConfigFingerprint(entry) },
    } } })
  } catch {
    // 落盘失败不篡改探测结论；固定文案，绝不输出 transport/env/header 原文。
    console.warn('[Core MCP] 测试结果保存失败')
  }
  return outcome
}
