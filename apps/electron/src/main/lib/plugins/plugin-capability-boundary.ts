import { PluginRpcError } from './plugin-rpc-errors'
import { PROFER_PLUGIN_ID_PATTERN, type ProferPluginPermission, type ProferPluginWorkspaceScope } from '@profer/plugin-api'
import { assertPluginPermission } from './plugin-permissions'
import { getInstalledPlugin } from './plugin-manager'

/** 将插件声明的相对前缀规范化为 POSIX 形式，并 fail closed。 */
export function canonicalizePluginScopePrefix(value: unknown): string {
  if (typeof value !== 'string' || value.includes('\0') || value.includes('\\') || value.startsWith('/')) {
    throw new PluginRpcError('PLUGIN_INVALID_ARGUMENT', '资源 scope 前缀非法')
  }
  const input = value.trim().replace(/^\.\//, '')
  if (!input || input.split('/').some((part) => part === '..' || part === '.')) {
    throw new PluginRpcError('PLUGIN_INVALID_ARGUMENT', '资源 scope 前缀必须是相对路径')
  }
  const normalized = input.replace(/^\.\//, '').replace(/\/+/g, '/').replace(/\/+$/, '')
  if (!normalized || normalized.startsWith('../') || normalized.includes(':')) {
    throw new PluginRpcError('PLUGIN_INVALID_ARGUMENT', '资源 scope 前缀非法')
  }
  return normalized
}

export function canonicalizePluginWorkspaceScopes(scopes: unknown): ProferPluginWorkspaceScope[] {
  if (scopes === undefined) return []
  if (!Array.isArray(scopes) || scopes.length > 50) throw new PluginRpcError('PLUGIN_INVALID_ARGUMENT', 'workspaceScopes 必须是有限数组')
  const result: ProferPluginWorkspaceScope[] = []
  const seen = new Set<string>()
  for (const value of scopes) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PluginRpcError('PLUGIN_INVALID_ARGUMENT', 'workspace scope 必须是对象')
    const raw = value as { workspaceId?: unknown; prefixes?: unknown }
    if (typeof raw.workspaceId !== 'string' || !raw.workspaceId.trim() || raw.workspaceId.length > 200) {
      throw new PluginRpcError('PLUGIN_INVALID_ARGUMENT', 'workspaceId 非法')
    }
    const prefixes = raw.prefixes === undefined ? undefined : (() => {
      if (!Array.isArray(raw.prefixes) || raw.prefixes.length > 100) throw new PluginRpcError('PLUGIN_INVALID_ARGUMENT', 'scope 前缀数量非法')
      return [...new Set(raw.prefixes.map(canonicalizePluginScopePrefix))]
    })()
    const key = `${raw.workspaceId.trim()}\0${prefixes?.join('\0') ?? ''}`
    if (seen.has(key)) throw new PluginRpcError('PLUGIN_INVALID_ARGUMENT', 'workspace scope 不能重复')
    seen.add(key)
    result.push({ workspaceId: raw.workspaceId.trim(), ...(prefixes && { prefixes }) })
  }
  return result
}

export function isPluginWorkspaceAllowed(pluginId: string, workspaceId: string): boolean {
  const plugin = getInstalledPlugin(pluginId)
  return Boolean(plugin?.manifest.workspaceScopes?.some((scope) => scope.workspaceId === workspaceId))
}

export function assertPluginWorkspaceScope(pluginId: string, permission: ProferPluginPermission, workspaceId: string): void {
  if (!PROFER_PLUGIN_ID_PATTERN.test(pluginId)) throw new PluginRpcError('PLUGIN_INVALID_ARGUMENT', '插件 ID 非法')
  assertPluginPermission(pluginId, permission)
  const plugin = getInstalledPlugin(pluginId)
  if (!plugin) throw new PluginRpcError('PLUGIN_DISABLED', '插件不存在或已停用')
  if (!plugin.manifest.workspaceScopes?.some((scope) => scope.workspaceId === workspaceId)) {
    throw new PluginRpcError('PLUGIN_PERMISSION_DENIED', '插件未获准访问该工作区')
  }
}

export function isPluginProviderAllowed(pluginId: string, providerId: string, field?: string): boolean {
  const plugin = getInstalledPlugin(pluginId)
  const scope = plugin?.manifest.providerScopes?.find((candidate) => candidate.providerId === providerId)
  if (!scope) return false
  return field === undefined ? true : scope.fields?.includes(field) === true
}

export function assertPluginProviderScope(pluginId: string, permission: ProferPluginPermission, providerId: string, field?: string): void {
  if (!PROFER_PLUGIN_ID_PATTERN.test(pluginId)) throw new PluginRpcError('PLUGIN_INVALID_ARGUMENT', '插件 ID 非法')
  assertPluginPermission(pluginId, permission)
  const plugin = getInstalledPlugin(pluginId)
  if (!plugin) throw new PluginRpcError('PLUGIN_DISABLED', '插件不存在或已停用')
  const scope = plugin.manifest.providerScopes?.find((candidate) => candidate.providerId === providerId)
  if (!scope) throw new PluginRpcError('PLUGIN_PERMISSION_DENIED', '插件未获准访问该 provider')
  if (field !== undefined && !isPluginProviderAllowed(pluginId, providerId, field)) throw new PluginRpcError('PLUGIN_PERMISSION_DENIED', '插件未获准访问该 provider 字段')
}

export function assertPluginResourceScope(pluginId: string, permission: ProferPluginPermission, workspaceId: string, path?: string): void {
  if (!PROFER_PLUGIN_ID_PATTERN.test(pluginId)) throw new PluginRpcError('PLUGIN_INVALID_ARGUMENT', '插件 ID 非法')
  assertPluginPermission(pluginId, permission)
  const plugin = getInstalledPlugin(pluginId)
  if (!plugin) throw new PluginRpcError('PLUGIN_DISABLED', '插件不存在或已停用')
  const scopes = plugin.manifest.workspaceScopes ?? []
  const scope = scopes.find((candidate) => candidate.workspaceId === workspaceId)
  if (!scope) throw new PluginRpcError('PLUGIN_PERMISSION_DENIED', '插件未获准访问该工作区')
  const prefixes = scope.prefixes ?? []
  if (path === undefined) {
    if (prefixes.length > 0) throw new PluginRpcError('PLUGIN_PERMISSION_DENIED', '插件必须指定已授权的资源前缀')
    return
  }
  const canonical = canonicalizePluginScopePrefix(path)
  if (prefixes.length === 0 || !prefixes.some((prefix) => canonical === prefix || canonical.startsWith(`${prefix}/`))) {
    throw new PluginRpcError('PLUGIN_PERMISSION_DENIED', '插件未获准访问该资源路径')
  }
}
