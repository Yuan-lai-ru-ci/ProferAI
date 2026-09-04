/**
 * Chat 流式事件总线 — 桌面 IPC 与平板远程通道的共用推送层
 *
 * 背景：桌面 Chat 流式事件原本只走 webContents.send()（发给主窗口渲染进程）。
 * 平板远程模式（remote-service）没有 webContents，需要一条独立的订阅通道。
 * 这里抽出轻量总线：pushChatStream 同时向桌面窗口（如有）和所有总线订阅者发送，
 * 桌面行为零变化，remote-service 只需订阅 chatEventBus 即可把 Chat 流式事件广播给平板。
 */

import type { WebContents } from 'electron'

type ChatBusListener = (conversationId: string, channel: string, payload: unknown) => void

const listeners = new Set<ChatBusListener>()

/** Chat 流式事件总线（remote-service 订阅后向 WS 客户端广播） */
export const chatEventBus = {
  on(listener: ChatBusListener): () => void {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  emit(conversationId: string, channel: string, payload: unknown): void {
    for (const listener of [...listeners]) {
      try {
        listener(conversationId, channel, payload)
      } catch (error) {
        console.error('[ChatBus] 事件监听器执行异常:', error)
      }
    }
  },
}

/**
 * 推送一条 Chat 流式事件：桌面窗口（webContents）与总线订阅者同时送达。
 * webContents 可为 null（平板远程调用时不指向任何窗口）。
 */
export function pushChatStream(
  webContents: WebContents | null,
  conversationId: string,
  channel: string,
  payload: unknown,
): void {
  if (webContents && !webContents.isDestroyed()) {
    try {
      webContents.send(channel, payload)
    } catch {
      /* 窗口已销毁等异常，忽略 */
    }
  }
  chatEventBus.emit(conversationId, channel, payload)
}
