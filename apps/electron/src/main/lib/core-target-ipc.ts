import { isIndependentLocalCore } from './core-local-mode'
import { getLocalCoreClient } from './core-local-bridge'
import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { addCoreTarget, getActiveCoreClient, getCurrentCoreTargetId, listCoreTargets, removeCoreEndpoint, removeCoreTarget, saveCoreEndpoint, selectCoreEndpoint, selectCoreTarget, testCoreTarget, updateCoreTarget } from './core-target-service'
import { CORE_TARGET_IPC_CHANNELS, CORE_CONNECTION_IPC_CHANNELS } from '../../types'
import { getCoreConnectionState, retryLocalCoreConnection, setCoreSharing, createCoreInvitation, pairCoreInvitation, pairAndSelectCoreInvitation, revokeCoreBinding } from './core-connection-service'

export function registerCoreTargetIpc(authorize: (event: IpcMainInvokeEvent) => void): void {
  ipcMain.handle(CORE_CONNECTION_IPC_CHANNELS.STATE, event => { authorize(event); return getCoreConnectionState() })
  ipcMain.handle(CORE_CONNECTION_IPC_CHANNELS.RETRY_LOCAL, event => { authorize(event); return retryLocalCoreConnection() })
  ipcMain.handle(CORE_CONNECTION_IPC_CHANNELS.SET_SHARING, (event, enabled) => { authorize(event); return setCoreSharing(enabled) })
  ipcMain.handle(CORE_CONNECTION_IPC_CHANNELS.INVITE, (event, ttlSeconds, bindingTtlSeconds) => { authorize(event); return createCoreInvitation(ttlSeconds, bindingTtlSeconds) })
  ipcMain.handle(CORE_CONNECTION_IPC_CHANNELS.PAIR, (event, invitation, tunnelUrl) => { authorize(event); return pairCoreInvitation(invitation, tunnelUrl) })
  ipcMain.handle(CORE_CONNECTION_IPC_CHANNELS.PAIR_AND_SELECT, (event, invitation, tunnelUrl) => { authorize(event); return pairAndSelectCoreInvitation(invitation, tunnelUrl) })
  ipcMain.handle(CORE_CONNECTION_IPC_CHANNELS.REVOKE, (event, id) => { authorize(event); return revokeCoreBinding(id) })
  ipcMain.handle(CORE_TARGET_IPC_CHANNELS.LIST, () => listCoreTargets())
  ipcMain.handle(CORE_TARGET_IPC_CHANNELS.CHANNELS, async () => {
    const state = listCoreTargets()
    const selected = state.targets.find(target => target.id === state.currentId)
    if (state.currentId === 'local' && !isIndependentLocalCore() && !selected?.capabilities?.includes('chat')) return []
    const client = state.currentId === 'local' ? getLocalCoreClient() : getActiveCoreClient()
    if (!client) throw new Error('当前内核未连接，不能读取模型目录')
    const channels = await client.listChannels()
    const latest = listCoreTargets()
    if (latest.currentId !== state.currentId || latest.generation !== state.generation
      || (state.currentId === 'local' && isIndependentLocalCore() && getLocalCoreClient() !== client)) throw new Error('Core已切换，忽略旧模型目录')
    return channels
  })
  ipcMain.handle(CORE_TARGET_IPC_CHANNELS.CREATE_CHANNEL, async (_event, input) => {
    const client = getActiveCoreClient()
    if (!client || getCurrentCoreTargetId() === 'local') throw new Error('当前远程内核未连接')
    return client.createChannel(input)
  })
  ipcMain.handle(CORE_TARGET_IPC_CHANNELS.UPDATE_CHANNEL, async (_event, id: string, input) => {
    const client = getActiveCoreClient()
    if (!client || getCurrentCoreTargetId() === 'local') throw new Error('当前远程内核未连接')
    return client.updateChannel(id, input)
  })
  ipcMain.handle(CORE_TARGET_IPC_CHANNELS.DELETE_CHANNEL, async (_event, id: string) => {
    const client = getActiveCoreClient()
    if (!client || getCurrentCoreTargetId() === 'local') throw new Error('当前远程内核未连接')
    return client.deleteChannel(id)
  })
  ipcMain.handle(CORE_TARGET_IPC_CHANNELS.FETCH_MODELS, async (_event, input) => {
    const client = getActiveCoreClient()
    if (!client || getCurrentCoreTargetId() === 'local') throw new Error('当前远程内核未连接')
    return client.fetchChannelModels(input)
  })
  ipcMain.handle(CORE_TARGET_IPC_CHANNELS.TEST_CHANNEL, async (_event, input) => {
    const client = getActiveCoreClient()
    if (!client || getCurrentCoreTargetId() === 'local') throw new Error('当前远程内核未连接')
    return client.testChannel(input)
  })
  ipcMain.handle(CORE_TARGET_IPC_CHANNELS.TEST, (event, input) => { authorize(event); return testCoreTarget(input) })
  ipcMain.handle(CORE_TARGET_IPC_CHANNELS.ADD, (event, input) => { authorize(event); return addCoreTarget(input) })
  ipcMain.handle(CORE_TARGET_IPC_CHANNELS.UPDATE, (event, id, input) => { authorize(event); return updateCoreTarget(id, input) })
  ipcMain.handle(CORE_TARGET_IPC_CHANNELS.SAVE_ENDPOINT, (event, id, input) => { authorize(event); return saveCoreEndpoint(id, input) })
  ipcMain.handle(CORE_TARGET_IPC_CHANNELS.SELECT_ENDPOINT, (event, id, endpointId) => { authorize(event); return selectCoreEndpoint(id, endpointId) })
  ipcMain.handle(CORE_TARGET_IPC_CHANNELS.REMOVE_ENDPOINT, (event, id, endpointId) => { authorize(event); return removeCoreEndpoint(id, endpointId) })
  ipcMain.handle(CORE_TARGET_IPC_CHANNELS.SELECT, (event, id: string) => { authorize(event); return selectCoreTarget(id) })
  ipcMain.handle(CORE_TARGET_IPC_CHANNELS.REMOVE, (event, id: string) => { authorize(event); return removeCoreTarget(id) })
}
