import { setPluginCredential, removePluginCredentials } from './plugin-credentials'
import { authorizePlugin, getGrantedPermissions, revokePluginPermissions } from './plugin-permissions'
import { getTaskRouting, setTaskRouting } from './plugin-routing'
import { pluginRequests } from './plugin-requests'
import { taskReferenceSchema } from './plugin-capabilities'
import { BrowserWindow, ipcMain } from 'electron'
import {
  PROFER_PLUGIN_IPC_CHANNELS,
  type ProferPluginOperationResult,
  type ProferPluginViewLayout,
} from '@profer/plugin-api'
import { assertMainWindowSender } from '../ipc-sender-guard'
import { getMainWindow } from '../main-window-state'
import {
  cleanupStalePluginTempDirs,
  installPluginPackage,
  listInstalledPlugins,
  openPluginsFolder,
  removePlugin,
  selectPluginPackage,
  setPluginEnabled,
  setPluginMutationListener,
  setPluginsChangedListener,
} from './plugin-manager'
import { pluginViewManager, registerPluginHostIpc } from './plugin-view-manager'
import { configureWorkspaceProvider } from './workspace-provider'
import { configurePluginCapabilityProviders } from './provider-registry'
import type { PluginCapabilityProviders } from './ports/capabilities'
import type { WorkspaceProvider } from './ports/workspace'

let registered = false

/** 由宿主启动 wiring 注入 workspace provider；未注入时 workspace RPC 保持稳定 not-supported。 */
export function setPluginWorkspaceProvider(provider: WorkspaceProvider | undefined): void {
  configureWorkspaceProvider(provider)
}

/** 由宿主显式注入 provider-neutral 实现；未注入的能力保持 not-supported。 */
export function setPluginCapabilityProviders(provider: PluginCapabilityProviders): void {
  configurePluginCapabilityProviders(provider)
}

function assertPluginManagerSender(event: {
  sender: { isDestroyed(): boolean; mainFrame: unknown }
  senderFrame: unknown
}): void {
  if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) {
    throw new Error('仅允许主窗口主页面调用插件管理 IPC')
  }
  assertMainWindowSender(event, getMainWindow)
}

function broadcastChanged(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(PROFER_PLUGIN_IPC_CHANNELS.CHANGED)
  }
}

/** 插件管理 IPC 只允许主 renderer 调用；插件页面使用完全分离的 Plugin Host IPC。 */
export function registerPluginIpcHandlers(): void {
  if (registered) return
  registered = true
  setPluginsChangedListener(broadcastChanged)
  setPluginMutationListener((pluginId) => {
    pluginRequests.cancelPlugin(pluginId)
    pluginViewManager.closePlugin(pluginId)
  })
  registerPluginHostIpc()

  // 启动即回收上次安装/更新/卸载留下的残留临时目录；清理失败不影响启动。
  void cleanupStalePluginTempDirs().catch((error) => console.warn('[插件] 残留临时目录清理异常:', error))

  ipcMain.handle(PROFER_PLUGIN_IPC_CHANNELS.LIST, (event) => {
    assertPluginManagerSender(event)
    return listInstalledPlugins().map((plugin) => ({ ...plugin, grantedPermissions: getGrantedPermissions(plugin.manifest.id) }))
  })
  ipcMain.handle(PROFER_PLUGIN_IPC_CHANNELS.SET_CREDENTIAL, (event, pluginId: unknown, id: unknown, secret: unknown) => {
    assertPluginManagerSender(event)
    if (typeof pluginId !== 'string' || typeof id !== 'string' || (secret !== null && typeof secret !== 'string')) throw new Error('凭据参数非法')
    setPluginCredential(pluginId, id, secret)
  })
  ipcMain.handle(PROFER_PLUGIN_IPC_CHANNELS.AUTHORIZE, async (event, pluginId: unknown) => {
    assertPluginManagerSender(event)
    if (typeof pluginId !== 'string') throw new Error('插件 ID 非法')
    const authorized = await authorizePlugin(pluginId)
    if (authorized) { pluginViewManager.closePlugin(pluginId); broadcastChanged() }
    return authorized
  })
  ipcMain.handle(PROFER_PLUGIN_IPC_CHANNELS.REVOKE, (event, pluginId: unknown) => {
    assertPluginManagerSender(event)
    if (typeof pluginId !== 'string') throw new Error('插件 ID 非法')
    revokePluginPermissions(pluginId); pluginRequests.cancelPlugin(pluginId); pluginViewManager.closePlugin(pluginId); broadcastChanged()
  })
  ipcMain.handle(PROFER_PLUGIN_IPC_CHANNELS.ACTIVATE, (event, pluginId: unknown, pageId: unknown, reference: unknown) => {
    assertPluginManagerSender(event)
    if (typeof pluginId !== 'string' || typeof pageId !== 'string') throw new Error('插件页面标识非法')
    pluginViewManager.activate(pluginId, pageId, reference ? taskReferenceSchema.parse(reference) : null)
  })
  ipcMain.handle(PROFER_PLUGIN_IPC_CHANNELS.ROUTING_GET, (event, key: unknown) => {
    assertPluginManagerSender(event)
    if (typeof key !== 'string' || !/^(chat|agent):.{1,200}$/.test(key)) throw new Error('任务标识非法')
    return getTaskRouting(key)
  })
  ipcMain.handle(PROFER_PLUGIN_IPC_CHANNELS.ROUTING_SET, (event, key: unknown, pluginId: unknown) => {
    assertPluginManagerSender(event)
    if (typeof key !== 'string' || (pluginId !== null && typeof pluginId !== 'string')) throw new Error('路由参数非法')
    setTaskRouting(key, pluginId)
  })
  ipcMain.handle(PROFER_PLUGIN_IPC_CHANNELS.SELECT_PACKAGE, (event, kind: unknown) => {
    assertPluginManagerSender(event)
    if (kind !== 'zip' && kind !== 'folder') throw new Error('插件包选择类型非法')
    return selectPluginPackage(kind)
  })
  ipcMain.handle(PROFER_PLUGIN_IPC_CHANNELS.INSTALL, (event, sourcePath: unknown, replace: unknown): ProferPluginOperationResult => {
    assertPluginManagerSender(event)
    if (typeof sourcePath !== 'string' || (replace !== undefined && typeof replace !== 'boolean')) {
      return { ok: false, status: 'error', message: '插件安装参数非法' }
    }
    return installPluginPackage(sourcePath, replace === true)
  })
  ipcMain.handle(PROFER_PLUGIN_IPC_CHANNELS.SET_ENABLED, (event, pluginId: unknown, enabled: unknown): ProferPluginOperationResult => {
    assertPluginManagerSender(event)
    if (typeof pluginId !== 'string' || typeof enabled !== 'boolean') return { ok: false, status: 'error', message: '插件状态参数非法' }
    if (!enabled) pluginViewManager.closePlugin(pluginId)
    return setPluginEnabled(pluginId, enabled)
  })
  ipcMain.handle(PROFER_PLUGIN_IPC_CHANNELS.REMOVE, (event, pluginId: unknown): ProferPluginOperationResult => {
    assertPluginManagerSender(event)
    if (typeof pluginId !== 'string') return { ok: false, status: 'error', message: '插件 ID 非法' }
    pluginViewManager.closePlugin(pluginId)
    const result = removePlugin(pluginId)
    if (result.ok) { revokePluginPermissions(pluginId); removePluginCredentials(pluginId) }
    return result
  })
  ipcMain.handle(PROFER_PLUGIN_IPC_CHANNELS.OPEN_FOLDER, (event) => {
    assertPluginManagerSender(event)
    return openPluginsFolder()
  })
  ipcMain.handle(PROFER_PLUGIN_IPC_CHANNELS.SET_VIEW_LAYOUT, (event, layout: ProferPluginViewLayout) => {
    assertPluginManagerSender(event)
    pluginViewManager.setLayout(layout)
  })
  ipcMain.handle(PROFER_PLUGIN_IPC_CHANNELS.HIDE_VIEW, (event, pluginId: unknown, pageId: unknown) => {
    assertPluginManagerSender(event)
    if (typeof pluginId === 'string' && typeof pageId === 'string') pluginViewManager.hide(pluginId, pageId)
  })
  ipcMain.handle(PROFER_PLUGIN_IPC_CHANNELS.CLOSE_VIEW, (event, pluginId: unknown, pageId: unknown) => {
    assertPluginManagerSender(event)
    if (typeof pluginId === 'string' && typeof pageId === 'string') pluginViewManager.close(pluginId, pageId)
  })
}
