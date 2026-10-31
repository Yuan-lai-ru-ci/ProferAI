/**
 * 钉钉 Bridge 管理器（多 Bot 版本）
 *
 * 管理多个 DingTalkBridge 实例的生命周期、状态汇总和聚合查询。
 * 替代原来的单例 `dingtalkBridge`。
 */

import type {
  DingTalkBridgeState,
  DingTalkChatBinding,
  DingTalkMultiBridgeState,
  DingTalkBotBridgeState,
  DingTalkTestResult,
  DingTalkBotConfig,
} from '@profer/shared'
import { DingTalkBridge } from './dingtalk-bridge'
import { getDingTalkMultiBotConfig, getDingTalkBotById } from './dingtalk-config'
import { getDingTalkBotBindingsPath } from './config-paths'
import { existsSync, readFileSync } from 'node:fs'

class DingTalkBridgeManager {
  /** botId → Bridge 实例 */
  private bridges = new Map<string, DingTalkBridge>()

  // ===== 生命周期 =====

  /** 启动所有已启用的 Bot */
  async startAll(): Promise<void> {
    const config = getDingTalkMultiBotConfig()
    const enabledBots = config.bots.filter((b) => b.enabled && b.clientId && b.clientSecret)

    for (const bot of enabledBots) {
      try {
        await this.startBot(bot.id)
      } catch (error) {
        console.error(`[钉钉 BridgeManager] Bot "${bot.name}" 启动失败:`, error)
      }
    }

    if (enabledBots.length > 0) {
      console.log(`[钉钉 BridgeManager] 已启动 ${this.bridges.size}/${enabledBots.length} 个 Bot`)
    }
  }

  /** 停止所有 Bot */
  stopAll(): void {
    for (const [botId, bridge] of this.bridges) {
      try {
        bridge.stop()
      } catch (error) {
        console.error(`[钉钉 BridgeManager] Bot ${botId} 停止失败:`, error)
      }
    }
    this.bridges.clear()
    console.log('[钉钉 BridgeManager] 所有 Bot 已停止')
  }

  /** 启动单个 Bot */
  async startBot(botId: string): Promise<void> {
    const botConfig = getDingTalkBotById(botId)
    if (!botConfig) {
      throw new Error(`Bot ${botId} 不存在`)
    }
    if (!botConfig.enabled) {
      throw new Error(`Bot "${botConfig.name}" 未启用`)
    }

    // 复用已有实例（保留 commandHandler 中的 chatBindings），仅重建连接
    const existing = this.bridges.get(botId)
    if (existing) {
      existing.stop()
      existing.updateConfig(botConfig)
      await existing.start()
      return
    }

    const bridge = new DingTalkBridge(botConfig)
    this.bridges.set(botId, bridge)
    await bridge.start()
  }

  /** 停止单个 Bot */
  stopBot(botId: string): void {
    const bridge = this.bridges.get(botId)
    if (bridge) {
      bridge.stop()
      this.bridges.delete(botId)
    }
  }

  /** 重启单个 Bot（配置变更后调用，复用实例保留绑定） */
  async restartBot(botId: string): Promise<void> {
    await this.startBot(botId)
  }

  // ===== 状态查询 =====

  /** 获取所有 Bot 的 Bridge 状态 */
  getStates(): DingTalkMultiBridgeState {
    const bots: Record<string, DingTalkBotBridgeState> = {}
    const config = getDingTalkMultiBotConfig()

    for (const bot of config.bots) {
      const bridge = this.bridges.get(bot.id)
      const status: DingTalkBridgeState = bridge
        ? bridge.getStatus()
        : { status: 'disconnected' }

      bots[bot.id] = {
        ...status,
        botId: bot.id,
        botName: bot.name,
      }
    }

    return { bots }
  }

  /** 获取单个 Bot 的 Bridge 实例 */
  getBridge(botId: string): DingTalkBridge | undefined {
    return this.bridges.get(botId)
  }

  /** 获取所有活跃 Bridge 实例 */
  getAllBridges(): Map<string, DingTalkBridge> {
    return this.bridges
  }

  // ===== 连接测试（静态，不影响运行中的 Bridge） =====

  async testConnection(clientId: string, clientSecret: string): Promise<DingTalkTestResult> {
    const tempConfig: DingTalkBotConfig = {
      id: 'test',
      name: 'test',
      enabled: true,
      clientId,
      clientSecret: '',
    }
    const tempBridge = new DingTalkBridge(tempConfig)
    return tempBridge.testConnection(clientId, clientSecret)
  }

  // ===== 聊天绑定（设置页）=====

  /**
   * 汇总所有 Bot 的聊天绑定。
   *
   * 运行中的 Bot 从内存读；未启动/已停用的 Bot 直接从落盘文件读，
   * 避免“停用后绑定列表凭空消失”。
   */
  listAllBindings(): DingTalkChatBinding[] {
    const result: DingTalkChatBinding[] = []
    const config = getDingTalkMultiBotConfig()

    for (const bot of config.bots) {
      const bridge = this.bridges.get(bot.id)
      if (bridge) {
        for (const binding of bridge.listBindings()) {
          result.push({ ...binding, botId: bot.id, botName: bot.name })
        }
        continue
      }

      const path = getDingTalkBotBindingsPath(bot.id)
      if (!existsSync(path)) continue
      try {
        const bindings = JSON.parse(readFileSync(path, 'utf-8')) as DingTalkChatBinding[]
        for (const binding of bindings) {
          result.push({ ...binding, botId: bot.id, botName: bot.name })
        }
      } catch (error) {
        console.error(`[钉钉 BridgeManager] 读取 Bot ${bot.id} 绑定失败:`, error)
      }
    }

    return result
  }

  /** 按 chatId 找到所属 Bot 的 Bridge */
  findBridgeByChatId(chatId: string): DingTalkBridge | undefined {
    for (const bridge of this.bridges.values()) {
      if (bridge.listBindings().some((binding) => binding.chatId === chatId)) return bridge
    }
    return undefined
  }

}

export const dingtalkBridgeManager = new DingTalkBridgeManager()
