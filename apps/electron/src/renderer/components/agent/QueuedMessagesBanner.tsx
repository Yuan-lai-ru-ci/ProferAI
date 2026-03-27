/**
 * QueuedMessagesBanner — 队列消息浮动卡片
 *
 * 在输入框外上方展示排队中的消息。
 * 每条消息可「立即发送」或「撤回」。
 * 当 streaming 结束时自动清除（队列消息已被 SDK 消费）。
 */

import React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { Zap, X, Clock } from 'lucide-react'
import {
  currentQueuedMessagesAtom,
  agentStreamingStatesAtom,
  agentQueuedMessagesMapAtom,
} from '@/atoms/agent-atoms'
import type { QueuedMessage } from '@/atoms/agent-atoms'

interface QueuedMessagesBannerProps {
  sessionId: string
}

export const QueuedMessagesBanner: React.FC<QueuedMessagesBannerProps> = ({ sessionId }) => {
  const queuedMessages = useAtomValue(currentQueuedMessagesAtom)
  const streamingStates = useAtomValue(agentStreamingStatesAtom)
  const setQueuedMessagesMap = useSetAtom(agentQueuedMessagesMapAtom)
  const streaming = streamingStates.get(sessionId)?.running ?? false

  // 当 streaming 结束且队列中仍有消息时，自动清除（已被 SDK 消费）
  React.useEffect(() => {
    if (!streaming && queuedMessages.length > 0) {
      // 延迟清除，给 SDK 流式事件时间到达
      const timer = setTimeout(() => {
        setQueuedMessagesMap((prev) => {
          if (!prev.has(sessionId)) return prev
          const map = new Map(prev)
          map.delete(sessionId)
          return map
        })
      }, 500)
      return () => clearTimeout(timer)
    }
  }, [streaming, queuedMessages.length, sessionId, setQueuedMessagesMap])

  if (queuedMessages.length === 0) return null

  const handlePromote = async (msg: QueuedMessage) => {
    try {
      await window.electronAPI.promoteQueuedAgentMessage({
        sessionId,
        messageUuid: msg.uuid,
      })
    } catch (error) {
      console.error('[QueuedMessagesBanner] 提升队列消息失败:', error)
    }
  }

  const handleCancel = async (msg: QueuedMessage) => {
    try {
      await window.electronAPI.cancelQueuedAgentMessage({
        sessionId,
        messageUuid: msg.uuid,
      })
    } catch (error) {
      console.error('[QueuedMessagesBanner] 取消队列消息失败:', error)
    }
  }

  return (
    <div className="px-2.5 md:px-[18px] space-y-1.5">
      {queuedMessages.map((msg) => (
        <div
          key={msg.uuid}
          className="group flex items-start gap-2.5 rounded-xl border border-dashed border-primary/20 bg-primary/[0.03] backdrop-blur-sm px-3.5 py-2.5 text-sm animate-in slide-in-from-bottom-2 duration-200"
        >
          {/* 状态图标 */}
          <Clock className="size-3.5 shrink-0 mt-1 text-primary/40 animate-pulse" />

          {/* 消息内容预览 */}
          <div className="flex-1 min-w-0">
            <p className="text-foreground/80 line-clamp-2 break-all">{msg.text}</p>
            <p className="text-xs text-muted-foreground/50 mt-0.5">
              等待当前任务完成后发送
            </p>
          </div>

          {/* 操作按钮 */}
          <div className="flex items-center gap-1 shrink-0">
            {/* 立即发送 */}
            <button
              type="button"
              className="flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-primary hover:bg-primary/10 transition-colors"
              onClick={() => handlePromote(msg)}
              title="立即发送"
            >
              <Zap className="size-3" />
              <span>立即发送</span>
            </button>

            {/* 撤回 */}
            <button
              type="button"
              className="flex items-center justify-center size-6 rounded-md text-muted-foreground/40 hover:text-destructive hover:bg-destructive/10 transition-colors"
              onClick={() => handleCancel(msg)}
              title="撤回消息"
            >
              <X className="size-3.5" />
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}
