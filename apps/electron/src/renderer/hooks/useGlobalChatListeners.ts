/**
 * useGlobalChatListeners — 全局 Chat IPC 监听器
 *
 * 在应用顶层挂载，永不销毁。将所有 Chat 流式事件
 * 写入对应 Jotai atoms，确保页面切换时不丢失事件。
 *
 * 参照 useGlobalAgentListeners 模式，使用 useStore() 直接操作 atoms。
 */

import { useEffect } from 'react'
import { useStore } from 'jotai'
import {
  streamingStatesAtom,
  chatStreamErrorsAtom,
  chatStreamErrorCodesAtom,
  conversationsAtom,
  chatMessageRefreshAtom,
  chatExternalUserMessagesAtom,
  CHAT_EXTERNAL_USER_MESSAGE_LIMIT,
  pendingAgentRecommendationAtom,
} from '@/atoms/chat-atoms'
import { tabsAtom, updateTabTitle } from '@/atoms/tab-atoms'
import { createSessionUpdateBatcher } from '@/lib/session-update-batcher'
import { sidebarViewModeAtom } from '@/atoms/sidebar-atoms'
import { refreshCreditsInto } from '@/domains/credits/credits-state'
import type { ConversationStreamState } from '@/atoms/chat-atoms'
import type {
  StreamChunkEvent,
  StreamReasoningEvent,
  StreamCompleteEvent,
  StreamErrorEvent,
  StreamToolActivityEvent,
  StreamUserEvent,
  GenerateTitleInput,
} from '@profer/shared'

/**
 * 待参与自动命名的对话（按 conversationId 跟踪本轮使用的渠道/模型）
 *
 * 每轮发送都登记一次；命中的资源消耗与定稿判定全在主进程（chat:auto-title），
 * 这里只负责把「本轮用的哪个模型」带过去。
 */
const pendingTitles = new Map<string, GenerateTitleInput>()

/**
 * 登记本轮发送的渠道/模型，供流结束后的自动命名窗口使用（由 ChatView.handleSend 调用）
 */
export function registerPendingTitle(
  conversationId: string,
  input: GenerateTitleInput,
): void {
  pendingTitles.set(conversationId, input)
}

export function useGlobalChatListeners(): void {
  const store = useStore()

  useEffect(() => {
    /** 辅助函数：更新 Map 中某个对话的流式状态 */
    const updateState = (
      convId: string,
      runId: string,
      updater: (prev: ConversationStreamState) => ConversationStreamState,
    ): void => {
      store.set(streamingStatesAtom, (prev) => {
        const current = prev.get(convId)
        if (current?.runId && current.runId !== runId) return prev
        const base = current ?? {
          runId,
          streaming: false,
          content: '',
          reasoning: '',
          model: undefined,
          toolActivities: [],
          startedAt: Date.now(),
        }
        const next = updater(base)
        const map = new Map(prev)
        map.set(convId, next)
        return map
      })
    }

    /** 辅助函数：从 Map 中移除某个对话的流式状态 */
    const removeState = (convId: string): void => {
      store.set(streamingStatesAtom, (prev) => {
        if (!prev.has(convId)) return prev
        const map = new Map(prev)
        map.delete(convId)
        return map
      })
    }

    // ===== 1. 流式内容块 =====
    //
    // 模型每秒会吐几十到上百个 delta；每个 delta 直接写 atom 会让 ChatView 按 token
    // 重渲染（markdown 解析 + 整列表 diff）。这里按对话合并到一帧提交，与 Agent 侧的
    // streamStateBatcher 同一套机制。终态（complete / error）先 flush，尾帧不会丢。
    const deltaBatcher = createSessionUpdateBatcher<{
      runId: string
      content?: string
      reasoning?: string
    }>((conversationId, updates) => {
      store.set(streamingStatesAtom, (prev) => {
        const current = prev.get(conversationId)
        let next = current
        for (const update of updates) {
          // 旧 run 的迟到增量不能污染新一轮内容。
          if (next?.runId && next.runId !== update.runId) continue
          const base: ConversationStreamState = next ?? {
            runId: update.runId,
            streaming: false,
            content: '',
            reasoning: '',
            toolActivities: [],
            startedAt: Date.now(),
          }
          next = {
            ...base,
            content: update.content ? base.content + update.content : base.content,
            reasoning: update.reasoning ? base.reasoning + update.reasoning : base.reasoning,
          }
        }
        if (!next || next === current) return prev
        const map = new Map(prev)
        map.set(conversationId, next)
        return map
      })
    })

    const cleanupChunk = window.electronAPI.onStreamChunk(
      (event: StreamChunkEvent) => {
        deltaBatcher.enqueue(event.conversationId, { runId: event.runId, content: event.delta })
      },
    )

    // ===== 2. 流式推理内容 =====
    const cleanupReasoning = window.electronAPI.onStreamReasoning(
      (event: StreamReasoningEvent) => {
        deltaBatcher.enqueue(event.conversationId, { runId: event.runId, reasoning: event.delta })
      },
    )

    // ===== 3. 流式完成 =====
    const cleanupComplete = window.electronAPI.onStreamComplete(
      (event: StreamCompleteEvent) => {
        // 先把挂起的增量落盘，否则尾帧会晚于 streaming=false 到达，续写已结束的态。
        deltaBatcher.flush(event.conversationId)
        // 旧 run 的完成事件不能关闭当前新 run。
        if (store.get(streamingStatesAtom).get(event.conversationId)?.runId !== event.runId) return
        // 标记 streaming=false，但保留 content/reasoning 作为过渡气泡
        // 流式状态的完全清除由 ChatView 在消息加载完成后执行（见 chatMessageRefreshAtom 的 useEffect），
        // 确保不会出现「气泡消失 → 持久化消息尚未加载」的空档闪烁
        updateState(event.conversationId, event.runId, (s) => ({ ...s, streaming: false }))

        // 递增消息刷新版本号，通知 ChatView 重新加载消息
        store.set(chatMessageRefreshAtom, (prev) => {
          const map = new Map(prev)
          map.set(
            event.conversationId,
            (prev.get(event.conversationId) ?? 0) + 1,
          )
          return map
        })

        // 刷新对话列表（updatedAt 已更新；按当前视图拉取，避免归档视图被活跃列表覆盖）
        window.electronAPI
          .listConversations(store.get(sidebarViewModeAtom) === 'archived')
          .then((convs) => store.set(conversationsAtom, convs))
          .catch(console.error)

        // 自动命名窗口：本轮回复完成后，由主进程按前几轮有效用户消息生成/精修标题。
        // 命不命名、用几条消息、是否已定稿全部由主进程判定；这里只负责把本轮
        // 的渠道/模型带过去，并在真的改名后同步会话列表与标签页标题。
        const titleInput = pendingTitles.get(event.conversationId)
        if (titleInput) {
          pendingTitles.delete(event.conversationId)
          window.electronAPI
            .autoTitleConversation({
              conversationId: event.conversationId,
              channelId: titleInput.channelId,
              modelId: titleInput.modelId,
            })
            .then((updated) => {
              if (!updated) return
              console.log('[GlobalChatListeners] 自动命名窗口更新标题:', updated.title)
              store.set(conversationsAtom, (prev) =>
                prev.map((c) => (c.id === updated.id ? updated : c)),
              )
              // 同步更新标签页标题
              store.set(tabsAtom, (prev) =>
                updateTabTitle(prev, event.conversationId, updated.title),
              )
            })
            .catch((error) => {
              console.error('[GlobalChatListeners] 自动命名失败:', error)
            })
        }
      },
    )

    // ===== 4. 流式错误 =====
    const cleanupError = window.electronAPI.onStreamError(
      (event: StreamErrorEvent) => {
        deltaBatcher.flush(event.conversationId)
        if (store.get(streamingStatesAtom).get(event.conversationId)?.runId !== event.runId) return
        console.error('[GlobalChatListeners] 流式错误:', event.error)

        // 标记 streaming=false，保留内容作为过渡（与完成逻辑一致）
        updateState(event.conversationId, event.runId, (s) => ({ ...s, streaming: false }))

        // 存储错误消息，供 UI 显示
        store.set(chatStreamErrorsAtom, (prev) => {
          const map = new Map(prev)
          map.set(event.conversationId, event.error)
          return map
        })

        // 存储结构化错误代码（如 insufficient_credits），供 UI 渲染充值引导
        store.set(chatStreamErrorCodesAtom, (prev) => {
          const map = new Map(prev)
          if (event.code) {
            map.set(event.conversationId, event.code)
          } else {
            map.delete(event.conversationId)
          }
          return map
        })

        // 额度不足：立即刷新余额，让侧栏余额条与设置页反映最新（多为 0）状态
        if (event.code === 'insufficient_credits') {
          void refreshCreditsInto(store)
        }

        // 递增消息刷新版本号，通知 ChatView 重新加载消息
        // 流式状态的完全清除由 ChatView 在消息加载完成后执行
        store.set(chatMessageRefreshAtom, (prev) => {
          const map = new Map(prev)
          map.set(
            event.conversationId,
            (prev.get(event.conversationId) ?? 0) + 1,
          )
          return map
        })
      },
    )

    // ===== 5. 工具活动 =====
    const cleanupToolActivity = window.electronAPI.onStreamToolActivity(
      (event: StreamToolActivityEvent) => {
        updateState(event.conversationId, event.runId, (s) => ({
          ...s,
          toolActivities: [...s.toolActivities, event.activity],
        }))

        // 官方生图成功后刷新余额，避免侧栏/额度页延迟显示本次固定 5 积分扣费。
        if (
          event.activity.type === 'result' &&
          event.activity.toolName === 'generate_image' &&
          !event.activity.isError
        ) {
          void refreshCreditsInto(store)
        }

        // 检测 Agent 推荐工具结果，写入推荐 atom
        if (
          event.activity.type === 'result' &&
          event.activity.toolName === 'suggest_agent_mode' &&
          event.activity.result &&
          !event.activity.isError
        ) {
          try {
            const parsed = JSON.parse(event.activity.result) as {
              type?: string
              reason?: string
              suggestedPrompt?: string
            }
            if (
              parsed.type === 'agent_recommendation' &&
              parsed.reason &&
              parsed.suggestedPrompt
            ) {
              store.set(pendingAgentRecommendationAtom, {
                reason: parsed.reason,
                suggestedPrompt: parsed.suggestedPrompt,
                conversationId: event.conversationId,
              })
            }
          } catch {
            // JSON 解析失败，忽略
          }
        }
      },
    )

    // ===== 6. 用户消息公告（桌面/移动端任一端发送） =====
    // 不依赖重新打开会话：按 id 合并，本地乐观消息原位换成真实消息。
    const cleanupUser = window.electronAPI.onStreamUser(
      (event: StreamUserEvent) => {
        store.set(chatExternalUserMessagesAtom, (prev) => {
          const current = prev.get(event.conversationId) ?? []
          if (current.some((message) => message.id === event.message.id)) return prev
          const next = [...current, event.message].slice(-CHAT_EXTERNAL_USER_MESSAGE_LIMIT)
          const map = new Map(prev)
          map.set(event.conversationId, next)
          return map
        })
      },
    )

    return () => {
      deltaBatcher.flushAll()
      cleanupChunk()
      cleanupReasoning()
      cleanupComplete()
      cleanupError()
      cleanupToolActivity()
      cleanupUser()
    }
  }, [store]) // store 引用稳定，effect 只执行一次
}
