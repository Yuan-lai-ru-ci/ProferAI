import { ipcMain } from 'electron'
import {
  WECHAT_IPC_CHANNELS,
  type WeChatBridgeState,
  type WeChatChatBinding,
  type WeChatConfig,
  type WeChatUpdateBindingInput,
} from '@profer/shared'
import { getWeChatConfig } from './wechat-config'
import { wechatBridge } from './wechat-bridge'

export function registerWeChatIpc(): void {
  ipcMain.handle(
    WECHAT_IPC_CHANNELS.GET_CONFIG,
    async (): Promise<WeChatConfig> => getWeChatConfig(),
  )

  ipcMain.handle(
    WECHAT_IPC_CHANNELS.START_LOGIN,
    async (): Promise<void> => {
      await wechatBridge.startLogin()
    },
  )

  ipcMain.handle(
    WECHAT_IPC_CHANNELS.LOGOUT,
    async (): Promise<void> => {
      wechatBridge.logout()
    },
  )

  ipcMain.handle(
    WECHAT_IPC_CHANNELS.START_BRIDGE,
    async (): Promise<void> => {
      await wechatBridge.start()
    },
  )

  ipcMain.handle(
    WECHAT_IPC_CHANNELS.STOP_BRIDGE,
    async (): Promise<void> => {
      wechatBridge.stop()
    },
  )

  ipcMain.handle(
    WECHAT_IPC_CHANNELS.GET_STATUS,
    async (): Promise<WeChatBridgeState> => wechatBridge.getStatus(),
  )

  ipcMain.handle(
    WECHAT_IPC_CHANNELS.LIST_BINDINGS,
    async (): Promise<WeChatChatBinding[]> => wechatBridge.listBindings() as WeChatChatBinding[],
  )

  ipcMain.handle(
    WECHAT_IPC_CHANNELS.UPDATE_BINDING,
    async (_, input: WeChatUpdateBindingInput): Promise<WeChatChatBinding | null> =>
      wechatBridge.updateBinding(input.chatId, {
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
      }) as WeChatChatBinding | null,
  )

  ipcMain.handle(
    WECHAT_IPC_CHANNELS.REMOVE_BINDING,
    async (_, chatId: string): Promise<boolean> => wechatBridge.removeBinding(chatId),
  )
}
