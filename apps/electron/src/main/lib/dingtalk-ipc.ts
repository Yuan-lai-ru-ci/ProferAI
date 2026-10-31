import { ipcMain } from 'electron'
import { DINGTALK_IPC_CHANNELS, type DingTalkConfig, type DingTalkConfigInput, type DingTalkBridgeState, type DingTalkTestResult, type DingTalkBotConfigInput, type DingTalkChatBinding, type DingTalkUpdateBindingInput } from '@profer/shared'
import {
  getDingTalkConfig,
  saveDingTalkConfig,
  getDecryptedClientSecret,
  getDingTalkMultiBotConfig,
  saveDingTalkBotConfig,
  removeDingTalkBot,
  getDecryptedBotClientSecret,
} from './dingtalk-config'
import { dingtalkBridgeManager } from './dingtalk-bridge-manager'

export function registerDingTalkIpc(): void {
  ipcMain.handle(
    DINGTALK_IPC_CHANNELS.GET_CONFIG,
    async (): Promise<DingTalkConfig> => getDingTalkConfig(),
  )

  ipcMain.handle(
    DINGTALK_IPC_CHANNELS.GET_DECRYPTED_SECRET,
    async (): Promise<string> => getDecryptedClientSecret(),
  )

  ipcMain.handle(
    DINGTALK_IPC_CHANNELS.SAVE_CONFIG,
    async (_, input: DingTalkConfigInput): Promise<DingTalkConfig> => saveDingTalkConfig(input),
  )

  ipcMain.handle(
    DINGTALK_IPC_CHANNELS.TEST_CONNECTION,
    async (_, clientId: string, clientSecret: string): Promise<DingTalkTestResult> =>
      dingtalkBridgeManager.testConnection(clientId, clientSecret),
  )

  ipcMain.handle(
    DINGTALK_IPC_CHANNELS.START_BRIDGE,
    async (): Promise<void> => {
      await dingtalkBridgeManager.startAll()
    },
  )

  ipcMain.handle(
    DINGTALK_IPC_CHANNELS.STOP_BRIDGE,
    async (): Promise<void> => {
      dingtalkBridgeManager.stopAll()
    },
  )

  ipcMain.handle(
    DINGTALK_IPC_CHANNELS.GET_STATUS,
    async (): Promise<DingTalkBridgeState> => {
      const states = dingtalkBridgeManager.getStates()
      const first = Object.values(states.bots)[0]
      return first ?? { status: 'disconnected' }
    },
  )

  ipcMain.handle(
    DINGTALK_IPC_CHANNELS.GET_MULTI_CONFIG,
    async () => getDingTalkMultiBotConfig(),
  )

  ipcMain.handle(
    DINGTALK_IPC_CHANNELS.SAVE_BOT_CONFIG,
    async (_, input: DingTalkBotConfigInput) => {
      const saved = saveDingTalkBotConfig(input)
      if (saved.enabled && saved.clientId && saved.clientSecret) {
        dingtalkBridgeManager.restartBot(saved.id).catch((error) => {
          console.error(`[钉钉 IPC] Bot "${saved.name}" 重启失败:`, error)
        })
      } else {
        dingtalkBridgeManager.stopBot(saved.id)
      }
      return saved
    },
  )

  ipcMain.handle(
    DINGTALK_IPC_CHANNELS.REMOVE_BOT,
    async (_, botId: string) => {
      dingtalkBridgeManager.stopBot(botId)
      return removeDingTalkBot(botId)
    },
  )

  ipcMain.handle(
    DINGTALK_IPC_CHANNELS.GET_BOT_DECRYPTED_SECRET,
    async (_, botId: string) => getDecryptedBotClientSecret(botId),
  )

  ipcMain.handle(
    DINGTALK_IPC_CHANNELS.START_BOT,
    async (_, botId: string): Promise<void> => {
      await dingtalkBridgeManager.startBot(botId)
    },
  )

  ipcMain.handle(
    DINGTALK_IPC_CHANNELS.STOP_BOT,
    async (_, botId: string): Promise<void> => {
      dingtalkBridgeManager.stopBot(botId)
    },
  )

  ipcMain.handle(
    DINGTALK_IPC_CHANNELS.GET_MULTI_STATUS,
    async () => dingtalkBridgeManager.getStates(),
  )

  ipcMain.handle(
    DINGTALK_IPC_CHANNELS.LIST_BINDINGS,
    async (): Promise<DingTalkChatBinding[]> => dingtalkBridgeManager.listAllBindings(),
  )

  ipcMain.handle(
    DINGTALK_IPC_CHANNELS.UPDATE_BINDING,
    async (_, input: DingTalkUpdateBindingInput): Promise<DingTalkChatBinding | null> => {
      const existing = dingtalkBridgeManager
        .listAllBindings()
        .find((binding) => binding.chatId === input.chatId)
      const bridge = dingtalkBridgeManager.findBridgeByChatId(input.chatId)
      if (!existing || !bridge) return null

      const updated = bridge.updateBinding(input.chatId, {
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
      })
      return updated ? { ...updated, botId: existing.botId, botName: existing.botName } : null
    },
  )

  ipcMain.handle(
    DINGTALK_IPC_CHANNELS.REMOVE_BINDING,
    async (_, chatId: string): Promise<boolean> =>
      dingtalkBridgeManager.findBridgeByChatId(chatId)?.removeBinding(chatId) ?? false,
  )
}
