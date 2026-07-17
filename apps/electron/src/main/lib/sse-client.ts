/**
 * SSE 客户端 — 连接团队服务器 SSE 端点，接收实时事件推送
 *
 * 在主进程中运行，解析 SSE 帧后通过 webContents.send() 转发到渲染进程。
 * 支持断线重连（指数退避）和窗口聚焦感知的自动连接管理。
 */

import { fetch as undiciFetch } from 'undici'
import { BrowserWindow, app } from 'electron'
import { SSE_IPC_CHANNELS } from '@profer/shared'

// ===== 类型定义 =====

export interface SSEEvent {
  type: string
  data: unknown
  workspaceId: string
  timestamp: number
}

type EventCallback = (workspaceId: string, event: SSEEvent) => void

interface SSEMeta {
  baseUrl: string
  token: string
  abortController: AbortController
  reconnectTimer?: ReturnType<typeof setTimeout>
  retryCount: number
  retryDelay: number
  connected: boolean
}

// ===== SSE 客户端 =====

const DEFAULT_RETRY_DELAY = 1000
const MAX_RETRY_DELAY = 30000
const RETRY_BACKOFF = 2

class SSEClientManager {
  private connections = new Map<string, SSEMeta>()
  private listeners: EventCallback[] = []
  private focused = true
  private initialized = false

  /** 初始化：监听窗口聚焦事件 */
  init(): void {
    if (this.initialized) return
    this.initialized = true

    // 监听窗口可见性
    app.on('browser-window-blur', () => {
      this.focused = false
    })
    app.on('browser-window-focus', () => {
      this.focused = true
      // 重新聚焦时恢复所有连接
      for (const [workspaceId, meta] of this.connections) {
        if (!meta.connected) {
          this.connect(workspaceId, meta.baseUrl, meta.token).catch(() => {})
        }
      }
    })
  }

  /** 注册事件监听器 */
  onEvent(callback: EventCallback): void {
    this.listeners.push(callback)
  }

  /** 注销事件监听器 */
  removeListener(callback: EventCallback): void {
    this.listeners = this.listeners.filter((l) => l !== callback)
  }

  /** 连接到指定工作区的 SSE 端点 */
  async connect(workspaceId: string, baseUrl: string, token: string): Promise<void> {
    // 如果已有连接，先断开
    await this.disconnect(workspaceId)

    const meta: SSEMeta = {
      baseUrl,
      token,
      abortController: new AbortController(),
      retryCount: 0,
      retryDelay: DEFAULT_RETRY_DELAY,
      connected: false,
    }
    this.connections.set(workspaceId, meta)

    await this.doConnect(workspaceId, meta)
  }

  private async doConnect(workspaceId: string, meta: SSEMeta): Promise<void> {
    const url = `${meta.baseUrl}/v1/workspaces/${workspaceId}/events`

    try {
      const response = await (undiciFetch as unknown as typeof fetch)(url, {
        headers: {
          Authorization: `Bearer ${meta.token}`,
          Accept: 'text/event-stream',
        },
        signal: meta.abortController.signal,
      })

      if (!response.ok) {
        if (response.status === 401) {
          console.warn(`[SSE] 认证失败 (workspace=${workspaceId})，停止重连`)
          this.broadcastStatus(workspaceId, 'auth-error')
          return
        }
        throw new Error(`HTTP ${response.status}`)
      }

      if (!response.body) {
        throw new Error('无响应体')
      }

      meta.connected = true
      meta.retryCount = 0
      meta.retryDelay = DEFAULT_RETRY_DELAY
      this.broadcastStatus(workspaceId, 'connected')
      console.log(`[SSE] 已连接 workspace=${workspaceId}`)

      // 流式读取 SSE 帧
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })

          // 按 \n\n 分割 SSE 帧
          while (buffer.includes('\n\n')) {
            const idx = buffer.indexOf('\n\n')
            const frame = buffer.slice(0, idx)
            buffer = buffer.slice(idx + 2)
            this.parseFrame(workspaceId, frame)
          }
        }
      } catch (err) {
        if ((err as Error)?.name === 'AbortError') return
        throw err
      }
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return

      meta.connected = false
      console.warn(`[SSE] 连接断开 (workspace=${workspaceId}):`, (err as Error).message)

      // 指数退避重连
      if (!meta.abortController.signal.aborted) {
        meta.retryCount++
        meta.retryDelay = Math.min(
          DEFAULT_RETRY_DELAY * Math.pow(RETRY_BACKOFF, meta.retryCount - 1),
          MAX_RETRY_DELAY,
        )
        // 加少量随机抖动
        const jitter = Math.floor(Math.random() * 1000)
        const delay = meta.retryDelay + jitter

        this.broadcastStatus(workspaceId, 'reconnecting')
        console.log(`[SSE] ${delay}ms 后重连 (attempt #${meta.retryCount})`)

        meta.reconnectTimer = setTimeout(() => {
          if (!meta.abortController.signal.aborted) {
            this.doConnect(workspaceId, meta).catch(() => {})
          }
        }, delay)
      }
    }
  }

  /** 解析单个 SSE 帧 */
  private parseFrame(workspaceId: string, frame: string): void {
    const lines = frame.split('\n')
    let eventType = ''
    let eventData = ''

    for (const line of lines) {
      if (line.startsWith('event: ')) {
        eventType = line.slice(7).trim()
      } else if (line.startsWith('data: ')) {
        eventData = line.slice(6)
      } else if (line.startsWith(':')) {
        // heartbeat 注释，忽略
      }
    }

    if (!eventType || !eventData) return

    // 跳过 heartbeat 和 connected 事件 => 不转发到前端
    if (eventType === 'connected') return

    try {
      const data = JSON.parse(eventData)
      const event: SSEEvent = {
        type: eventType,
        data,
        workspaceId,
        timestamp: Date.now(),
      }

      for (const listener of this.listeners) {
        try {
          listener(workspaceId, event)
        } catch { /* 单个监听器崩溃不影响其他 */ }
      }

      // 转发到所有渲染进程窗口
      BrowserWindow.getAllWindows().forEach((win) => {
        if (!win.isDestroyed()) {
          win.webContents.send(SSE_IPC_CHANNELS.EVENT, event)
        }
      })
    } catch {
      // 非 JSON 数据，跳过
    }
  }

  /** 广播连接状态到渲染进程 */
  private broadcastStatus(workspaceId: string, status: string): void {
    BrowserWindow.getAllWindows().forEach((win) => {
      if (!win.isDestroyed()) {
        win.webContents.send(SSE_IPC_CHANNELS.CONNECTION_CHANGED, { workspaceId, status })
      }
    })
  }

  /** 断开指定工作区的 SSE 连接 */
  async disconnect(workspaceId: string): Promise<void> {
    const meta = this.connections.get(workspaceId)
    if (!meta) return

    if (meta.reconnectTimer) {
      clearTimeout(meta.reconnectTimer)
      meta.reconnectTimer = undefined
    }

    meta.abortController.abort()
    meta.connected = false
    this.connections.delete(workspaceId)
    console.log(`[SSE] 已断开 workspace=${workspaceId}`)
  }

  /** 断开所有连接 */
  disconnectAll(): void {
    for (const workspaceId of this.connections.keys()) {
      this.disconnect(workspaceId).catch(() => {})
    }
  }

  /** 获取活跃连接数 */
  getConnectionCount(): number {
    let count = 0
    for (const meta of this.connections.values()) {
      if (meta.connected) count++
    }
    return count
  }

  /** 是否已连接 */
  isConnected(workspaceId: string): boolean {
    return this.connections.get(workspaceId)?.connected ?? false
  }
}

/** 全局单例 */
export const sseClient = new SSEClientManager()
