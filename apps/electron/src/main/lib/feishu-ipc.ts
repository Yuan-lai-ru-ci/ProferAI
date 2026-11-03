import { ipcMain } from 'electron'
import {
  FEISHU_IPC_CHANNELS,
  type FeishuBridgeState,
  type FeishuChatBinding,
  type FeishuConfig,
  type FeishuConfigInput,
  type FeishuPresenceReport,
  type FeishuRegisterAppQRCode,
  type FeishuRegisterAppResult,
  type FeishuRegisterAppStatus,
  type FeishuTestResult,
  type FeishuUpdateBindingInput,
} from '@profer/shared'
import {
  getDecryptedAppSecret,
  getDecryptedBotAppSecret,
  getFeishuConfig,
  getFeishuMultiBotConfig,
  removeFeishuBot,
  saveFeishuBotConfig,
  saveFeishuConfig,
} from './feishu-config'
import { feishuBridgeManager } from './feishu-bridge-manager'
import { presenceService } from './feishu-presence'

let activeRegisterAbort: AbortController | null = null

export function registerFeishuIpc(): void {
  ipcMain.handle(
    FEISHU_IPC_CHANNELS.GET_CONFIG,
    async (): Promise<FeishuConfig> => getFeishuConfig(),
  )

  ipcMain.handle(
    FEISHU_IPC_CHANNELS.GET_DECRYPTED_SECRET,
    async (): Promise<string> => getDecryptedAppSecret(),
  )

  ipcMain.handle(
    FEISHU_IPC_CHANNELS.SAVE_CONFIG,
    async (_, input: FeishuConfigInput): Promise<FeishuConfig> => {
      const config = saveFeishuConfig(input)
      const multi = getFeishuMultiBotConfig()
      const firstBot = multi.bots[0]
      if (firstBot) {
        if (input.enabled && input.appId && input.appSecret) {
          await feishuBridgeManager.restartBot(firstBot.id)
        } else if (!input.enabled) {
          feishuBridgeManager.stopBot(firstBot.id)
        }
      }
      return config
    },
  )

  ipcMain.handle(
    FEISHU_IPC_CHANNELS.START_BRIDGE,
    async (): Promise<void> => {
      await feishuBridgeManager.startAll()
    },
  )

  ipcMain.handle(
    FEISHU_IPC_CHANNELS.STOP_BRIDGE,
    async (): Promise<void> => {
      feishuBridgeManager.stopAll()
    },
  )

  ipcMain.handle(
    FEISHU_IPC_CHANNELS.GET_STATUS,
    async (): Promise<FeishuBridgeState> => {
      const states = feishuBridgeManager.getStates()
      const first = Object.values(states.bots)[0]
      return first ?? { status: 'disconnected', activeBindings: 0 }
    },
  )

  ipcMain.handle(
    FEISHU_IPC_CHANNELS.GET_MULTI_CONFIG,
    async () => getFeishuMultiBotConfig(),
  )

  ipcMain.handle(
    FEISHU_IPC_CHANNELS.SAVE_BOT_CONFIG,
    async (_, input: import('@profer/shared').FeishuBotConfigInput) => {
      const saved = saveFeishuBotConfig(input)
      if (saved.enabled && saved.appId && saved.appSecret) {
        feishuBridgeManager.restartBot(saved.id).catch((error) => {
          console.error(`[飞书 IPC] Bot "${saved.name}" 重启失败:`, error)
        })
      } else {
        feishuBridgeManager.stopBot(saved.id)
      }
      return saved
    },
  )

  ipcMain.handle(
    FEISHU_IPC_CHANNELS.REMOVE_BOT,
    async (_, botId: string) => {
      feishuBridgeManager.stopBot(botId)
      return removeFeishuBot(botId)
    },
  )

  ipcMain.handle(
    FEISHU_IPC_CHANNELS.GET_BOT_DECRYPTED_SECRET,
    async (_, botId: string) => getDecryptedBotAppSecret(botId),
  )

  ipcMain.handle(
    FEISHU_IPC_CHANNELS.START_BOT,
    async (_, botId: string): Promise<void> => {
      await feishuBridgeManager.startBot(botId)
    },
  )

  ipcMain.handle(
    FEISHU_IPC_CHANNELS.STOP_BOT,
    async (_, botId: string): Promise<void> => {
      feishuBridgeManager.stopBot(botId)
    },
  )

  ipcMain.handle(
    FEISHU_IPC_CHANNELS.GET_MULTI_STATUS,
    async () => feishuBridgeManager.getStates(),
  )

  ipcMain.handle(
    FEISHU_IPC_CHANNELS.TEST_CONNECTION,
    async (_, appId: string, appSecret: string): Promise<FeishuTestResult> =>
      feishuBridgeManager.testConnection(appId, appSecret),
  )

  ipcMain.handle(
    FEISHU_IPC_CHANNELS.LIST_BINDINGS,
    async (): Promise<FeishuChatBinding[]> => feishuBridgeManager.listAllBindings(),
  )

  ipcMain.handle(
    FEISHU_IPC_CHANNELS.UPDATE_BINDING,
    async (_, input: FeishuUpdateBindingInput): Promise<FeishuChatBinding | null> => {
      const bridge = feishuBridgeManager.findBridgeByChatId(input.chatId)
      return bridge?.updateBinding(input) ?? null
    },
  )

  ipcMain.handle(
    FEISHU_IPC_CHANNELS.REMOVE_BINDING,
    async (_, chatId: string): Promise<boolean> => {
      const bridge = feishuBridgeManager.findBridgeByChatId(chatId)
      return bridge?.removeBinding(chatId) ?? false
    },
  )

  ipcMain.handle(
    FEISHU_IPC_CHANNELS.REPORT_PRESENCE,
    async (_, report: FeishuPresenceReport): Promise<void> => {
      presenceService.updatePresence(report)
    },
  )

  ipcMain.handle(
    FEISHU_IPC_CHANNELS.REGISTER_APP_START,
    async (event): Promise<FeishuRegisterAppResult> => {
      if (activeRegisterAbort) activeRegisterAbort.abort()
      const abort = new AbortController()
      activeRegisterAbort = abort

      try {
        const lark = await import('@larksuiteoapi/node-sdk')
        const QRCode = (await import('qrcode')).default
        const result = await lark.registerApp({
          source: 'profer',
          signal: abort.signal,
          onQRCodeReady: async (info) => {
            if (event.sender.isDestroyed()) return
            try {
              const dataUrl = await QRCode.toDataURL(info.url, { width: 280, margin: 2, errorCorrectionLevel: 'M' })
              if (event.sender.isDestroyed()) return
              const payload: FeishuRegisterAppQRCode = { url: info.url, dataUrl, expireIn: info.expireIn }
              event.sender.send(FEISHU_IPC_CHANNELS.REGISTER_APP_QRCODE, payload)
            } catch (error) {
              console.error('[飞书扫码注册] QRCode 生成失败:', error)
              if (event.sender.isDestroyed()) return
              event.sender.send(FEISHU_IPC_CHANNELS.REGISTER_APP_QRCODE, {
                url: info.url,
                dataUrl: '',
                expireIn: info.expireIn,
              } satisfies FeishuRegisterAppQRCode)
            }
          },
          onStatusChange: (info) => {
            if (event.sender.isDestroyed()) return
            const payload: FeishuRegisterAppStatus = { status: info.status, interval: info.interval }
            event.sender.send(FEISHU_IPC_CHANNELS.REGISTER_APP_STATUS, payload)
          },
        })
        return {
          appId: result.client_id,
          appSecret: result.client_secret,
          tenantBrand: result.user_info?.tenant_brand,
          operatorOpenId: result.user_info?.open_id,
        }
      } finally {
        if (activeRegisterAbort === abort) activeRegisterAbort = null
      }
    },
  )

  ipcMain.handle(
    FEISHU_IPC_CHANNELS.REGISTER_APP_CANCEL,
    async (): Promise<void> => {
      activeRegisterAbort?.abort()
      activeRegisterAbort = null
    },
  )
}
