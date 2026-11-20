import { ipcMain } from 'electron'
import { isDeepStrictEqual } from 'node:util'
import { AGENT_IPC_CHANNELS, type GlobalMcpDefinition } from '@profer/shared'
import { listGlobalMcpServers, saveGlobalMcpServer, deleteGlobalMcpServer } from './global-mcp-store'
import { getWorkspaceMcpConfig, listAgentWorkspaces, listWorkspaceGlobalMcpServers } from './agent-workspace-manager'
import { assertSafeSkillSegment } from './skill-path-security'
import { localCoreOwnsBusinessData } from './core-business-ownership'
import { listCoreTargets } from './core-target-service'

function assertDesktopGlobalMcpAvailable(): void {
  if (listCoreTargets().currentId !== 'local' || localCoreOwnsBusinessData()) {
    throw new Error('当前 Core 尚未实现全局 MCP 管理；不会读取或写入桌面本机配置')
  }
}

/** 只有之前实际使用全局定义、且配置已变化/撤销的工作区需要释放旧连接。 */
async function retireChangedConnections(previous: GlobalMcpDefinition | undefined, next?: GlobalMcpDefinition): Promise<void> {
  if (!previous?.entry.enabled) return
  const unchanged = next && isDeepStrictEqual(previous.entry, next.entry)
  const staleIds = new Set(previous.workspaceIds.filter(id => !unchanged || !next.workspaceIds.includes(id)))
  if (!staleIds.size) return
  const { disconnectMcpServer } = await import('./adapters/pi-mcp-tools')
  await Promise.all(listAgentWorkspaces().filter(ws => staleIds.has(ws.id)).map(async ws => {
    try {
      // 同名本地定义（包括禁用项）不受共享配置变更影响。
      if (Object.hasOwn(getWorkspaceMcpConfig(ws.slug).servers, previous.name)) return
    } catch {
      // 项目不再可读，仍应释放曾授权的旧连接。
    }
    await disconnectMcpServer(previous.name, ws.slug)
  }))
}

function retireAfterSave(previous: GlobalMcpDefinition | undefined, next?: GlobalMcpDefinition): Promise<void> {
  return retireChangedConnections(previous, next).catch(() => {
    // 配置已原子提交，回收失败不应使界面误报保存失败。下轮按有效配置重新装配。
    console.warn('[全局 MCP] 未能释放旧的工作区连接')
  })
}

export function registerGlobalMcpIpc(): void {
  ipcMain.handle(AGENT_IPC_CHANNELS.LIST_GLOBAL_MCP, () => {
    assertDesktopGlobalMcpAvailable()
    const known = new Set(listAgentWorkspaces().filter(ws => !ws.isDeleted).map(ws => ws.id))
    return listGlobalMcpServers().map(row => ({ ...row, workspaceIds: row.workspaceIds.filter(id => known.has(id)) }))
  })
  ipcMain.handle(AGENT_IPC_CHANNELS.LIST_WORKSPACE_GLOBAL_MCP, (_, workspaceSlug: string) => {
    assertDesktopGlobalMcpAvailable()
    assertSafeSkillSegment(workspaceSlug, 'workspaceSlug')
    return listWorkspaceGlobalMcpServers(workspaceSlug)
  })
  ipcMain.handle(AGENT_IPC_CHANNELS.SAVE_GLOBAL_MCP, async (_, definition: GlobalMcpDefinition, mode: 'create' | 'update') => {
    assertDesktopGlobalMcpAvailable()
    const known = new Set(listAgentWorkspaces().filter(ws => !ws.isDeleted).map(ws => ws.id))
    if (!Array.isArray(definition?.workspaceIds) || !definition.workspaceIds.every(id => known.has(id))) throw new Error('请选择仍然存在的工作区')
    const previous = mode === 'update' ? listGlobalMcpServers().find(row => row.name === definition.name) : undefined
    saveGlobalMcpServer(definition, mode)
    await retireAfterSave(previous, definition)
  })
  ipcMain.handle(AGENT_IPC_CHANNELS.DELETE_GLOBAL_MCP, async (_, name: string) => {
    assertDesktopGlobalMcpAvailable()
    const previous = listGlobalMcpServers().find(row => row.name === name)
    deleteGlobalMcpServer(name)
    await retireAfterSave(previous)
  })
}
