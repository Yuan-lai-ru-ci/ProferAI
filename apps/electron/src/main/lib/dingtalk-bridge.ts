/**
 * 钉钉 Bridge 服务
 *
 * 核心职责：
 * - 通过 WebSocket 长连接（Stream 模式）接收钉钉消息
 * - 管理连接生命周期（启动/停止/重启/状态推送）
 *
 * 当前为第一阶段：仅实现 Stream 连接建立，
 * 消息处理、聊天绑定等功能后续迭代。
 */

import { BrowserWindow } from 'electron'
import type {
  DingTalkBridgeState,
  DingTalkTestResult,
} from '@proma/shared'
import { DINGTALK_IPC_CHANNELS } from '@proma/shared'
import { getDingTalkConfig, getDecryptedClientSecret } from './dingtalk-config'

// ===== 类型声明 =====

interface DWClientModule {
  DWClient: new (opts: {
    clientId: string
    clientSecret: string
    ua?: string
    keepAlive?: boolean
  }) => DWClientInstance
  TOPIC_ROBOT: string
  EventAck: { SUCCESS: string; LATER: string }
}

interface DWClientInstance {
  connected: boolean
  registerCallbackListener(topic: string, callback: (msg: DWClientDownStream) => void): DWClientInstance
  registerAllEventListener(callback: (msg: DWClientDownStream) => { status: string; message?: string }): DWClientInstance
  connect(): Promise<void>
  disconnect(): void
}

interface DWClientDownStream {
  specVersion: string
  type: string
  headers: {
    appId: string
    connectionId: string
    contentType: string
    messageId: string
    time: string
    topic: string
    eventType?: string
  }
  data: string
}

// ===== 单例 Bridge =====

class DingTalkBridge {
  private client: DWClientInstance | null = null
  private state: DingTalkBridgeState = { status: 'disconnected' }

  /** 获取当前状态 */
  getStatus(): DingTalkBridgeState {
    return { ...this.state }
  }

  /** 启动 Stream 连接 */
  async start(): Promise<void> {
    const config = getDingTalkConfig()
    if (!config.enabled || !config.clientId || !config.clientSecret) {
      throw new Error('请先配置 Client ID 和 Client Secret')
    }

    // 如果已连接，先停止
    if (this.client) {
      this.stop()
    }

    this.updateStatus({ status: 'connecting' })

    try {
      const clientSecret = getDecryptedClientSecret()
      const sdk = await import('dingtalk-stream-sdk-nodejs') as DWClientModule

      // 创建客户端
      this.client = new sdk.DWClient({
        clientId: config.clientId,
        clientSecret,
        keepAlive: true,
      })

      // 注册机器人消息回调（即使暂不处理，也需要注册以通过钉钉验证）
      this.client.registerCallbackListener(sdk.TOPIC_ROBOT, (msg: DWClientDownStream) => {
        this.handleRobotMessage(msg)
      })

      // 注册通用事件监听（处理事件订阅验证）
      this.client.registerAllEventListener((msg: DWClientDownStream) => {
        console.log('[钉钉 Bridge] 收到事件:', msg.headers.topic, msg.headers.eventType ?? '')
        return { status: sdk.EventAck.SUCCESS }
      })

      // 建立 WebSocket 连接
      await this.client.connect()

      this.updateStatus({ status: 'connected', connectedAt: Date.now() })
      console.log('[钉钉 Bridge] Stream 连接已建立')
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      this.updateStatus({ status: 'error', errorMessage })
      console.error('[钉钉 Bridge] 连接失败:', errorMessage)
      this.client = null
      throw error
    }
  }

  /** 停止连接 */
  stop(): void {
    if (this.client) {
      try {
        this.client.disconnect()
      } catch {
        // 忽略断开连接时的错误
      }
      this.client = null
    }
    this.updateStatus({ status: 'disconnected' })
    console.log('[钉钉 Bridge] 已停止')
  }

  /** 重启连接 */
  async restart(): Promise<void> {
    this.stop()
    await this.start()
  }

  /** 测试连接（使用提供的凭证，不影响当前连接） */
  async testConnection(clientId: string, clientSecret: string): Promise<DingTalkTestResult> {
    let testClient: DWClientInstance | null = null
    try {
      const sdk = await import('dingtalk-stream-sdk-nodejs') as DWClientModule

      testClient = new sdk.DWClient({
        clientId,
        clientSecret,
      })

      // 注册一个空回调以满足 SDK 要求
      testClient.registerCallbackListener(sdk.TOPIC_ROBOT, () => {})
      testClient.registerAllEventListener(() => ({ status: sdk.EventAck.SUCCESS }))

      await testClient.connect()

      // 连接成功，立即断开
      testClient.disconnect()
      testClient = null

      return {
        success: true,
        message: '连接成功！Stream 通道已验证。',
      }
    } catch (error) {
      if (testClient) {
        try { testClient.disconnect() } catch {}
      }
      const errorMessage = error instanceof Error ? error.message : String(error)
      return {
        success: false,
        message: `连接失败: ${errorMessage}`,
      }
    }
  }

  /** 处理机器人消息（第一阶段仅打印日志） */
  private handleRobotMessage(msg: DWClientDownStream): void {
    try {
      const data = JSON.parse(msg.data)
      console.log('[钉钉 Bridge] 收到机器人消息:', {
        msgId: msg.headers.messageId,
        senderNick: data.senderNick,
        text: data.text?.content,
        conversationType: data.conversationType,
      })
    } catch (error) {
      console.error('[钉钉 Bridge] 解析消息失败:', error, msg.data)
    }
  }

  /** 更新状态并推送到渲染进程 */
  private updateStatus(partial: Partial<DingTalkBridgeState>): void {
    this.state = { ...this.state, ...partial }
    // 推送到所有渲染进程窗口
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(DINGTALK_IPC_CHANNELS.STATUS_CHANGED, this.state)
      }
    }
  }
}

export const dingtalkBridge = new DingTalkBridge()
