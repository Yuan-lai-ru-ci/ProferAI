import { PROFER_PLUGIN_PERMISSION_LABELS as PLUGIN_PERMISSION_LABELS } from '@profer/plugin-api'
import { dialog } from 'electron'
import { join } from 'node:path'
import type { ProferPluginPermission } from '@profer/plugin-api'
import { getConfigDir } from '../config-paths'
import { getMainWindow } from '../main-window-state'
import { readJsonFileSafe, writeJsonFileAtomic } from '../safe-file'
import { getInstalledPlugin } from './plugin-manager'
import { PluginRpcError } from './plugin-rpc-errors'

interface Grant { permissions: ProferPluginPermission[]; origins: string[]; revoked?: boolean }

function path(): string { return join(getConfigDir(), 'plugin-permissions.json') }
function grants(): Record<string, Grant> { return readJsonFileSafe<Record<string, Grant>>(path()) ?? {} }
export function getGrantedPermissions(pluginId: string): ProferPluginPermission[] {
  const plugin = getInstalledPlugin(pluginId)
  if (!plugin) return []
  const grant = grants()[pluginId]
  return (plugin.manifest.permissions ?? []).filter((permission) => permission === 'pluginStorage'
    || (Array.isArray(grant?.permissions) && grant.permissions.includes(permission)))
}
function permissionAliases(permission: ProferPluginPermission): ProferPluginPermission[] {
  if (permission === 'secrets.readMetadata') return [permission, 'mcp.secrets.readMetadata']
  if (permission === 'secrets.configure') return [permission, 'mcp.secrets.write']
  return [permission]
}

export function assertPluginPermission(pluginId: string, permission: ProferPluginPermission): void {
  if (!getInstalledPlugin(pluginId)?.enabled) throw new PluginRpcError('PLUGIN_DISABLED', '插件已停用或卸载')
  if (grants()[pluginId]?.revoked) throw new PluginRpcError('PLUGIN_REVOKED', '插件授权已撤销')
  const granted = getGrantedPermissions(pluginId)
  if (!permissionAliases(permission).some((candidate) => granted.includes(candidate))) throw new PluginRpcError('PLUGIN_PERMISSION_DENIED', `请在插件设置中授权：${PLUGIN_PERMISSION_LABELS[permission]}`)
}
export function assertPluginOrigin(pluginId: string, origin: string): void {
  assertPluginPermission(pluginId, 'network.fetch')
  const plugin = getInstalledPlugin(pluginId)
  if (!plugin?.manifest.network?.origins.includes(origin) || !grants()[pluginId]?.origins?.includes(origin)) {
    throw new Error('网络地址未声明或尚未获准；请在插件设置中重新授权')
  }
}
export async function authorizePlugin(pluginId: string): Promise<boolean> {
  const plugin = getInstalledPlugin(pluginId)
  const owner = getMainWindow()
  if (!plugin || !owner) throw new Error('插件或主窗口不存在')
  const manifestIdentity = JSON.stringify(plugin.manifest)
  const permissions = plugin.manifest.permissions ?? []
  const origins = plugin.manifest.network?.origins ?? []
  const result = await dialog.showMessageBox(owner, {
    type: 'question', title: '插件能力授权', message: `允许「${plugin.manifest.name}」使用以下能力？`,
    detail: [...permissions.map((permission) => `• ${PLUGIN_PERMISSION_LABELS[permission]}`), ...origins.map((origin) => `• 网络：${origin}`)].join('\n') || '此插件没有申请宿主能力。',
    buttons: ['取消', '允许'], defaultId: 0, cancelId: 0, noLink: true,
  })
  if (result.response !== 1) return false
  if (JSON.stringify(getInstalledPlugin(pluginId)?.manifest) !== manifestIdentity) throw new Error('插件已更新，请重新确认权限')
  const all = grants()
  all[pluginId] = { permissions, origins, revoked: false }
  writeJsonFileAtomic(path(), all)
  return true
}
export function revokePluginPermissions(pluginId: string): void {
  const all = grants()
  const current = all[pluginId]
  all[pluginId] = { permissions: current?.permissions ?? [], origins: current?.origins ?? [], revoked: true }
  writeJsonFileAtomic(path(), all)
}
