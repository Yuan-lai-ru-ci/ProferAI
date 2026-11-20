import { getLocalCoreClient } from './core-local-bridge'
import { ipcMain } from 'electron'
import { addCoreTarget, getActiveCoreClient, getCurrentCoreTargetId, listCoreTargets, removeCoreTarget, selectCoreTarget, testCoreTarget } from './core-target-service'
import { CORE_TARGET_IPC_CHANNELS } from '../../types'

export function registerCoreTargetIpc(): void {
  ipcMain.handle(CORE_TARGET_IPC_CHANNELS.LIST, () => listCoreTargets())
  ipcMain.handle(CORE_TARGET_IPC_CHANNELS.CHANNELS, async () => {
    const state = listCoreTargets()
    const selected = state.targets.find(target => target.id === state.currentId)
    if (state.currentId === 'local' && !selected?.capabilities?.includes('chat')) return []
    const client = state.currentId === 'local' ? getLocalCoreClient() : getActiveCoreClient()
    if (!client) throw new Error('当前内核未连接，不能读取模型目录')
    const channels = await client.listChannels()
    const latest = listCoreTargets()
    if (latest.currentId !== state.currentId || latest.generation !== state.generation) throw new Error('Core已切换，忽略旧模型目录')
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
  ipcMain.handle(CORE_TARGET_IPC_CHANNELS.TEST, (_event, input) => testCoreTarget(input))
  ipcMain.handle(CORE_TARGET_IPC_CHANNELS.ADD, (_event, input) => addCoreTarget(input))
  ipcMain.handle(CORE_TARGET_IPC_CHANNELS.SELECT, (_event, id: string) => selectCoreTarget(id))
  ipcMain.handle(CORE_TARGET_IPC_CHANNELS.REMOVE, (_event, id: string) => removeCoreTarget(id))
}
