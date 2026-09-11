/**
 * ChatView - 主聊天视图容器（参数化版本）
 *
 * 职责：
 * - 接受 conversationId prop，不依赖全局单例 atom
 * - 加载对话消息和上下文分隔线（本地 state）
 * - 处理消息发送、删除、编辑、重发
 * - 管理上下文清除/删除
 * - 监听 chatMessageRefreshAtom 版本号变化自动重载消息
 *
 * 注意：流式 IPC 事件监听已迁移到 useGlobalChatListeners（全局挂载）
 *
 * 布局：三段式 ChatHeader | ChatMessages | ChatInput
 */

import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { toast } from 'sonner'
import { AlertCircle, X, Wallet } from 'lucide-react'
import { ChatHeader } from './ChatHeader'
import { ChatMessages } from './ChatMessages'
import { ChatInput } from './ChatInput'
import { BranchTreeView } from './HistoryDrawer'
import { AgentRecommendBanner } from './AgentRecommendBanner'
import { PromptEditorSidebar } from './PromptEditorSidebar'
import { KNOWLEDGE_PREVIEW_EVENT, KnowledgePreviewContent } from '@/components/knowledge-base/KnowledgePreviewPanel'
import type { InlineEditSubmitPayload } from './ChatMessageItem'
import {
  conversationsAtom,
  streamingStatesAtom,
  chatStreamErrorsAtom,
  chatStreamErrorCodesAtom,
  chatMessageRefreshAtom,
  pendingAgentRecommendationAtom,
  conversationModelsAtom,
  chatPendingMessageAtom,
  chatPendingKnowledgeReferencesAtom,
  channelsAtom,
  INITIAL_MESSAGE_LIMIT,
} from '@/atoms/chat-atoms'
import type { PendingAttachment, ChatPendingMessage } from '@/atoms/chat-atoms'
import { promptConfigAtom, promptSidebarOpenAtom, conversationPromptIdAtom, resolveSystemMessage, selectedPromptIdAtom } from '@/atoms/system-prompt-atoms'
import { activeToolIdsAtom } from '@/atoms/chat-tool-atoms'
import { settingsOpenAtom, settingsTabAtom } from '@/atoms/settings-tab'
import { userProfileAtom } from '@/atoms/user-profile'
import { ConversationProvider } from '@/contexts/session-context'
import {
  useConversationModel,
  useConversationContextLength,
  useConversationThinkingEnabled,
  useConversationPromptId,
} from '@/hooks/useConversationSettings'
import { registerPendingTitle } from '@/hooks/useGlobalChatListeners'
import { draftSessionIdsAtom } from '@/atoms/draft-session-atoms'
import { cn } from '@/lib/utils'
import type {
  ChatMessage,
  ChatSendInput,
  FileAttachment,
  AttachmentSaveInput,
} from '@profer/shared'

interface ChatViewProps {
  conversationId: string
}

export function ChatView({ conversationId }: ChatViewProps): React.ReactElement {
  return (
    <ConversationProvider conversationId={conversationId}>
      <ChatViewInner conversationId={conversationId} />
    </ConversationProvider>
  )
}

function ChatViewInner({ conversationId }: ChatViewProps): React.ReactElement {
  // ===== 本地状态（每个实例独立） =====
  const [messages, setMessages] = React.useState<ChatMessage[]>([])
  const [contextDividers, setContextDividers] = React.useState<string[]>([])
  const [pendingAttachments, setPendingAttachments] = React.useState<PendingAttachment[]>([])
  const [pendingKnowledgeReferences, setPendingKnowledgeReferences] = React.useState<import('@profer/shared').KnowledgeReference[]>([])
  const [hasMoreMessages, setHasMoreMessages] = React.useState(false)
  const [messagesLoaded, setMessagesLoaded] = React.useState(false)
  const [inlineEditingMessageId, setInlineEditingMessageId] = React.useState<string | null>(null)
  const [previewReference, setPreviewReference] = React.useState<import('@profer/shared').KnowledgeReference | null>(null)
  const [historyDrawerOpen, setHistoryDrawerOpen] = React.useState(false)
  const [branchTree, setBranchTree] = React.useState<import('@profer/shared').BranchTreeSnapshot | null>(null)
  React.useEffect(() => {
    const handlePreview = (event: Event) => setPreviewReference((event as CustomEvent<import('@profer/shared').KnowledgeReference>).detail)
    const handleEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setPreviewReference(null) }
    window.addEventListener(KNOWLEDGE_PREVIEW_EVENT, handlePreview)
    window.addEventListener('keydown', handleEscape)
    return () => { window.removeEventListener(KNOWLEDGE_PREVIEW_EVENT, handlePreview); window.removeEventListener('keydown', handleEscape) }
  }, [])

  // ===== Per-conversation hooks（分屏独立） =====
  const [selectedModel, setSelectedModel] = useConversationModel()
  const [contextLength] = useConversationContextLength()
  const [thinkingEnabled] = useConversationThinkingEnabled()
  const [conversationPromptId] = useConversationPromptId()

  // ===== 全局 atoms（Map 结构，按 conversationId 读取） =====
  const conversations = useAtomValue(conversationsAtom)
  const setConversations = useSetAtom(conversationsAtom)
  const setDraftSessionIds = useSetAtom(draftSessionIdsAtom)
  const streamingStates = useAtomValue(streamingStatesAtom)
  const setStreamingStates = useSetAtom(streamingStatesAtom)
  const setConversationModels = useSetAtom(conversationModelsAtom)
  const setChatStreamErrors = useSetAtom(chatStreamErrorsAtom)
  const chatStreamErrors = useAtomValue(chatStreamErrorsAtom)
  const chatStreamErrorCodes = useAtomValue(chatStreamErrorCodesAtom)
  const setSettingsOpen = useSetAtom(settingsOpenAtom)
  const setSettingsTab = useSetAtom(settingsTabAtom)
  const refreshMap = useAtomValue(chatMessageRefreshAtom)
  const promptConfig = useAtomValue(promptConfigAtom)
  const userProfile = useAtomValue(userProfileAtom)
  const channels = useAtomValue(channelsAtom)
  const promptSidebarOpen = useAtomValue(promptSidebarOpenAtom)
  const activeToolIds = useAtomValue(activeToolIdsAtom)
  const setPendingRecommendation = useSetAtom(pendingAgentRecommendationAtom)
  const [chatPendingMessage, setChatPendingMessage] = React.useState<ChatPendingMessage | null>(null)

  // 从全局 atom 读取快速任务待发送消息
  const globalChatPending = useAtomValue(chatPendingMessageAtom)
  const setGlobalChatPending = useSetAtom(chatPendingMessageAtom)
  const globalPendingKnowledge = useAtomValue(chatPendingKnowledgeReferencesAtom)
  const setGlobalPendingKnowledge = useSetAtom(chatPendingKnowledgeReferencesAtom)

  // 检测到当前对话的待发送消息时，捕获到本地状态
  React.useEffect(() => {
    if (!globalChatPending) return
    if (globalChatPending.conversationId !== conversationId) return
    setChatPendingMessage(globalChatPending)
    setGlobalChatPending(null)
  }, [globalChatPending, conversationId, setGlobalChatPending])

  React.useEffect(() => {
    if (!globalPendingKnowledge || globalPendingKnowledge.conversationId !== conversationId) return
    setPendingKnowledgeReferences(globalPendingKnowledge.references)
    setGlobalPendingKnowledge(null)
  }, [conversationId, globalPendingKnowledge, setGlobalPendingKnowledge])

  // ===== 从 Map 派生当前对话状态 =====
  const conversation = conversations.find((c) => c.id === conversationId) ?? null
  const streamState = streamingStates.get(conversationId)
  const isStreaming = streamState?.streaming ?? false
  const streamingContent = streamState?.content ?? ''
  const streamingReasoning = streamState?.reasoning ?? ''
  const streamingModel = streamState?.model ?? null
  const toolActivities = streamState?.toolActivities ?? []
  const chatError = chatStreamErrors.get(conversationId) ?? null
  const chatErrorCode = chatStreamErrorCodes.get(conversationId) ?? null
  const isInsufficientCredits = chatErrorCode === 'insufficient_credits'
  const refreshVersion = refreshMap.get(conversationId) ?? 0

  // ===== 对话切换时重置状态 =====
  React.useEffect(() => {
    setInlineEditingMessageId(null)
    setPendingRecommendation(null)

    // 清空附件列表和缓存
    setPendingAttachments((prev) => {
      // 释放 blob URLs
      prev.forEach((att) => {
        if (att.previewUrl?.startsWith('blob:')) {
          URL.revokeObjectURL(att.previewUrl)
        }
      })
      return []
    })

    // 清空附件数据缓存（如果存在）
    if (window.__pendingAttachmentData) {
      window.__pendingAttachmentData.clear()
    }
  }, [conversationId, setPendingRecommendation])

  // ===== 加载消息 + 上下文分隔线 =====
  React.useEffect(() => {
    setMessagesLoaded(false)
    window.electronAPI
      .getBranch(conversationId)
      .then((msgs) => {
        setMessages(msgs)
        setHasMoreMessages(false)
        setMessagesLoaded(true)

        // 消息加载完成后，清除已完成的流式状态（streaming=false 的过渡气泡）
        // 在同一个微任务中执行，确保 React 在一次渲染中同时显示持久化消息并移除流式气泡
        setStreamingStates((prev) => {
          const state = prev.get(conversationId)
          if (!state || state.streaming) return prev  // 仍在流式中，不清除
          const map = new Map(prev)
          map.delete(conversationId)
          return map
        })
      })
      .catch(console.error)
  }, [conversationId, refreshVersion, setStreamingStates])

  // 从对话元数据加载分隔线
  React.useEffect(() => {
    if (conversation?.contextDividers) {
      setContextDividers(conversation.contextDividers)
    } else {
      setContextDividers([])
    }
  }, [conversation?.contextDividers])

  // 从对话元数据恢复模型/渠道选择（写入 per-conversation Map）
  const conversationChannelId = conversation?.channelId
  const conversationModelId = conversation?.modelId
  React.useEffect(() => {
    if (conversationChannelId && conversationModelId) {
      setConversationModels((prev) => {
        const map = new Map(prev)
        map.set(conversationId, {
          channelId: conversationChannelId,
          modelId: conversationModelId,
        })
        return map
      })
    }
  }, [conversationId, conversationChannelId, conversationModelId, setConversationModels])

  const syncContextDividers = React.useCallback(async (
    convId: string,
    msgs: { id: string }[],
    currentDividers: string[],
  ): Promise<string[]> => {
    const messageIdSet = new Set(msgs.map((msg) => msg.id))
    const newDividers = currentDividers.filter((id) => messageIdSet.has(id))
    if (newDividers.length !== currentDividers.length) {
      setContextDividers(newDividers)
      await window.electronAPI.updateContextDividers(convId, newDividers)
    }
    return newDividers
  }, [])

  /** 发送消息 */
  const handleSend = React.useCallback(async (
    content: string,
    options?: {
      attachments?: FileAttachment[]
      knowledgeReferences?: import('@profer/shared').KnowledgeReference[]
      consumePendingAttachments?: boolean
      messageCountBeforeSend?: number
      contextDividersOverride?: string[]
      /** 重发 / 编辑后重发：该 user 节点已由 forkBranchAt 创建，sendMessage 不再追加重复消息 */
      pendingUserMessageId?: string
    },
  ): Promise<void> => {
    if (!selectedModel) {
      toast.error('暂无可用模型，请先在设置中添加 AI 渠道')
      return
    }
    const channel = channels.find((c) => c.id === selectedModel.channelId)
    const model = channel?.models.find((m) => m.id === selectedModel.modelId)
    if (!channel?.enabled || !model?.enabled) {
      toast.error('当前模型配置已失效，请重新选择可用模型')
      setSelectedModel(null)
      setConversationModels((prev) => {
        if (!prev.has(conversationId)) return prev
        const map = new Map(prev)
        map.delete(conversationId)
        return map
      })
      window.electronAPI
        .updateConversationModel(conversationId, undefined, undefined)
        .then((updated) => {
          setConversations((prev) =>
            prev.map((c) => (c.id === updated.id ? updated : c))
          )
        })
        .catch(console.error)
      return
    }

    const consumePending = options?.consumePendingAttachments ?? true
    const knowledgeReferences = options?.knowledgeReferences ?? pendingKnowledgeReferences

    // 清除当前对话的错误消息
    setChatStreamErrors((prev) => {
      if (!prev.has(conversationId)) return prev
      const map = new Map(prev)
      map.delete(conversationId)
      return map
    })

    // 判断是否为第一条消息（发送前历史为空）
    const messageCountBeforeSend = options?.messageCountBeforeSend ?? messages.length
    const isFirstMessage = messageCountBeforeSend === 0
    console.log('[ChatView] 发送消息 - isFirstMessage:', isFirstMessage, 'messageCountBeforeSend:', messageCountBeforeSend, 'conversationId:', conversationId)
    if (isFirstMessage && content) {
      console.log('[ChatView] 设置待生成标题:', { conversationId, userMessage: content.slice(0, 50) })
      registerPendingTitle(conversationId, {
        userMessage: content,
        channelId: selectedModel.channelId,
        modelId: selectedModel.modelId,
      })
      // 取消 draft 标记，让会话出现在侧边栏
      setDraftSessionIds((prev: Set<string>) => {
        if (!prev.has(conversationId)) return prev
        const next = new Set(prev)
        next.delete(conversationId)
        return next
      })
    }

    let savedAttachments: FileAttachment[] = options?.attachments ?? []

    if (consumePending) {
      // 获取当前待发送附件的快照
      const currentAttachments = [...pendingAttachments]

      // 保存附件到磁盘（通过 IPC）
      savedAttachments = []
      for (const att of currentAttachments) {
        const base64Data = window.__pendingAttachmentData?.get(att.id)
        if (!base64Data) {
          const errorMessage = `附件「${att.filename}」数据已丢失，请重新添加后再发送`
          setChatStreamErrors((prev) => new Map(prev).set(conversationId, errorMessage))
          toast.error(errorMessage)
          return
        }

        try {
          const input: AttachmentSaveInput = {
            conversationId,
            filename: att.filename,
            mediaType: att.mediaType,
            data: base64Data,
          }
          const result = await window.electronAPI.saveAttachment(input)
          savedAttachments.push(result.attachment)
        } catch (error) {
          console.error('[ChatView] 保存附件失败:', error)
          const errorMessage = `附件「${att.filename}」保存失败，请重试`
          setChatStreamErrors((prev) => new Map(prev).set(conversationId, errorMessage))
          toast.error(errorMessage)
          return
        }
      }

      // 清理 pending 附件和临时缓存
      for (const att of currentAttachments) {
        if (att.previewUrl?.startsWith('blob:')) {
          URL.revokeObjectURL(att.previewUrl)
        }
        window.__pendingAttachmentData?.delete(att.id)
      }
      setPendingAttachments([])
    }

    // 初始化当前对话的流式状态
    setStreamingStates((prev) => {
      const map = new Map(prev)
      map.set(conversationId, {
        streaming: true,
        content: '',
        reasoning: '',
        model: selectedModel.modelId,
        toolActivities: [],
        startedAt: Date.now(),
      })
      return map
    })

    // 乐观更新：发送瞬间若会话已归档，立即取消归档，
    // 让侧边栏立即把它移到未归档列表，无需等待 STREAM_COMPLETE。
    // 后端 appendMessage 已会做同样的取消归档，STREAM_COMPLETE 时会再用 listConversations 对齐
    setConversations((prev) => {
      const idx = prev.findIndex((c) => c.id === conversationId)
      if (idx === -1) return prev
      const conv = prev[idx]!
      if (!conv.archived) return prev
      const next = [...prev]
      next[idx] = { ...conv, archived: false, updatedAt: Date.now() }
      return next
    })

    const input: ChatSendInput = {
      conversationId,
      userMessage: content,
      messageHistory: [], // 后端已改为从磁盘读取完整历史，无需前端传入
      channelId: selectedModel.channelId,
      modelId: selectedModel.modelId,
      contextLength,
      contextDividers: options?.contextDividersOverride ?? contextDividers,
      attachments: savedAttachments.length > 0 ? savedAttachments : undefined,
      knowledgeReferences: knowledgeReferences.length > 0 ? knowledgeReferences : undefined,
      thinkingEnabled: thinkingEnabled || undefined,
      systemMessage: resolveSystemMessage(conversationPromptId, promptConfig, userProfile.userName),
      enabledToolIds: activeToolIds.length > 0 ? activeToolIds : undefined,
      ...(options?.pendingUserMessageId ? { pendingUserMessageId: options.pendingUserMessageId } : {}),
    }

    // 优化更新：立即在 UI 中显示用户消息。
    // 重发场景下 forkBranchAt 已经把新 user 节点写入并 refresh 到本地，这里不能再乐观插入一条重复的 temp 消息。
    const optimisticMessageId = options?.pendingUserMessageId ? null : `temp-${Date.now()}`
    if (optimisticMessageId) {
      setMessages((prev) => [
        ...prev,
        {
          id: optimisticMessageId,
          parentId: prev.length > 0 ? prev[prev.length - 1]!.id : null,
          role: 'user',
          content,
          createdAt: Date.now(),
          attachments: savedAttachments.length > 0 ? savedAttachments : undefined,
          knowledgeReferences: knowledgeReferences.length > 0 ? knowledgeReferences : undefined,
        },
      ])
    }

    setPendingKnowledgeReferences([])
    window.electronAPI.sendMessage(input).catch((error) => {
      console.error('[ChatView] 发送消息失败:', error)
      setStreamingStates((prev) => {
        if (!prev.has(conversationId)) return prev
        const map = new Map(prev)
        map.delete(conversationId)
        return map
      })
      if (optimisticMessageId) {
        setMessages((prev) => prev.filter((message) => message.id !== optimisticMessageId))
      }
      const errorMessage = error instanceof Error ? error.message : '消息发送失败，请重试'
      setChatStreamErrors((prev) => new Map(prev).set(conversationId, errorMessage))
      toast.error(errorMessage)
    })
  }, [
    conversationId,
    selectedModel,
    messages.length,
    pendingAttachments,
    pendingKnowledgeReferences,
    contextLength,
    contextDividers,
    thinkingEnabled,
    conversationPromptId,
    promptConfig,
    userProfile.userName,
    activeToolIds,
    channels,
    setSelectedModel,
    setConversationModels,
    setChatStreamErrors,
    setStreamingStates,
    setConversations,
  ])

  // ===== 自动发送快速任务消息 =====
  // 使用 queueMicrotask 延迟发送：microtask 在当前任务结束后、React 下一次渲染前执行，
  // 避免 setState → 重渲染 → cleanup 取消 timer 的竞态。
  React.useEffect(() => {
    if (!chatPendingMessage) return
    if (chatPendingMessage.conversationId !== conversationId) return
    if (!selectedModel || isStreaming) return

    const pending = chatPendingMessage
    setChatPendingMessage(null)

    queueMicrotask(() => {
      handleSend(pending.message, {
        consumePendingAttachments: false,
        messageCountBeforeSend: 0,
        attachments: pending.attachments,
      })
    })
  }, [chatPendingMessage, conversationId, selectedModel, isStreaming, handleSend])

  /** 在某条 user message 的兄弟位置 fork 一条新 user message（不删除任何旧节点） */
  const forkFromMessage = React.useCallback(async (
    messageId: string,
    payload: { role: 'user'; content: string; attachments?: FileAttachment[]; knowledgeReferences?: ChatMessage['knowledgeReferences'] },
  ): Promise<{
    targetAttachments: FileAttachment[]
    messageCountBeforeSend: number
    contextDividersAfterTruncate: string[]
    newUserMessage: ChatMessage
  }> => {
    const target = messages.find((msg) => msg.id === messageId)
    const targetIndex = messages.findIndex((msg) => msg.id === messageId)
    const targetAttachments = target?.attachments ?? []

    const newUserMessage = await window.electronAPI.forkBranchAt(
      conversationId,
      messageId,
      {
        role: payload.role,
        content: payload.content,
        attachments: payload.attachments,
        knowledgeReferences: payload.knowledgeReferences,
      },
    )

    // 重新拉取激活分支（forkBranchAt 已更新 activePath 并把新节点追加到末尾）
    const refreshed = await window.electronAPI.getBranch(conversationId)
    setMessages(refreshed)
    setHasMoreMessages(false)

    if (inlineEditingMessageId && inlineEditingMessageId !== messageId && !refreshed.some((m) => m.id === inlineEditingMessageId)) {
      setInlineEditingMessageId(null)
    }

    const contextDividersAfterTruncate = await syncContextDividers(conversationId, refreshed, contextDividers)
    return {
      targetAttachments,
      messageCountBeforeSend: targetIndex >= 0 ? targetIndex : refreshed.length,
      contextDividersAfterTruncate,
      newUserMessage,
    }
  }, [
    conversationId,
    messages,
    contextDividers,
    inlineEditingMessageId,
    syncContextDividers,
  ])

  /** 停止生成 */
  const handleStop = React.useCallback((): void => {
    // 标记 streaming=false（按钮即时变化），不清空内容
    // 内容保留在 UI 直到 onStreamComplete 原子性替换为磁盘消息，避免闪烁
    setStreamingStates((prev) => {
      const current = prev.get(conversationId)
      if (!current) return prev
      const map = new Map(prev)
      map.set(conversationId, { ...current, streaming: false })
      return map
    })
    window.electronAPI.stopGeneration(conversationId).catch(console.error)
  }, [conversationId, setStreamingStates])

  // 监听快捷键系统分发的 stop-generation 事件
  React.useEffect(() => {
    const handler = (): void => {
      if (isStreaming) handleStop()
    }
    window.addEventListener('profer:stop-generation', handler)
    return () => window.removeEventListener('profer:stop-generation', handler)
  }, [isStreaming, handleStop])

  /** 重新拉取分支树（给 BranchTreeView 用） */
  const reloadBranchTree = React.useCallback(async (): Promise<void> => {
    const tree = await window.electronAPI.getBranchTree(conversationId)
    setBranchTree(tree)
  }, [conversationId])

  /** 删除消息 */
  const handleDeleteMessage = React.useCallback(async (messageId: string): Promise<void> => {
    try {
      const updatedMessages = await window.electronAPI.deleteMessage(
        conversationId,
        messageId
      )
      setMessages(updatedMessages)
      if (inlineEditingMessageId === messageId) {
        setInlineEditingMessageId(null)
      }
      // 删除可能改 activePath（截断/回退），刷新树状图让被删节点从树上消失
      await reloadBranchTree()
      await syncContextDividers(conversationId, updatedMessages, contextDividers)
    } catch (error) {
      console.error('[ChatView] 删除消息失败:', error)
    }
  }, [conversationId, contextDividers, inlineEditingMessageId, reloadBranchTree, syncContextDividers])

  /** 重新发送：在该 user message 的兄弟位置 fork 一条新 user message 并触发重发 */
  const handleResendMessage = React.useCallback(async (message: { id: string; content: string }): Promise<void> => {
    if (isStreaming) return

    try {
      const target = messages.find((m) => m.id === message.id)
      const targetAttachments = target?.attachments ?? []
      const forked = await forkFromMessage(message.id, {
        role: 'user',
        content: message.content,
        attachments: targetAttachments,
      })
      await handleSend(message.content, {
        attachments: forked.targetAttachments,
        consumePendingAttachments: false,
        messageCountBeforeSend: forked.messageCountBeforeSend,
        contextDividersOverride: forked.contextDividersAfterTruncate,
        pendingUserMessageId: forked.newUserMessage.id,
      })
    } catch (error) {
      console.error('[ChatView] 重新发送失败:', error)
    }
  }, [isStreaming, forkFromMessage, handleSend, messages])

  /** 开始原地编辑 */
  const handleStartInlineEdit = React.useCallback((message: { id: string }): void => {
    if (isStreaming) return
    setInlineEditingMessageId(message.id)
  }, [isStreaming])

  /** 取消原地编辑 */
  const handleCancelInlineEdit = React.useCallback((): void => {
    setInlineEditingMessageId(null)
  }, [])

  /** 提交原地编辑：在该消息的兄弟位置 fork 一条新内容并触发重发 */
  const inlineEditSubmitRef = React.useRef(false)

  const handleSubmitInlineEdit = React.useCallback(async (
    message: { id: string; content: string },
    payload: InlineEditSubmitPayload,
  ): Promise<void> => {
    if (isStreaming || inlineEditSubmitRef.current) return
    inlineEditSubmitRef.current = true
    const trimmed = payload.content.trim()
    if (!trimmed && payload.keepExistingAttachments.length === 0 && payload.newAttachments.length === 0) {
      inlineEditSubmitRef.current = false
      return
    }

    try {
      const forked = await forkFromMessage(message.id, {
        role: 'user',
        content: trimmed,
      })
      const keepLocalPathSet = new Set(payload.keepExistingAttachments.map((att) => att.localPath))
      const removedOldAttachments = forked.targetAttachments.filter(
        (att) => !keepLocalPathSet.has(att.localPath),
      )
      for (const removed of removedOldAttachments) {
        try {
          await window.electronAPI.deleteAttachment(removed.localPath)
        } catch (error) {
          // 删除旧附件失败不应阻断新分支发送；保留文件比丢失编辑更安全。
          console.warn('[ChatView] 删除旧附件失败，保留文件:', removed.localPath, error)
        }
      }

      const newSavedAttachments: FileAttachment[] = []
      for (const newAttachment of payload.newAttachments) {
        const input: AttachmentSaveInput = {
          conversationId,
          filename: newAttachment.filename,
          mediaType: newAttachment.mediaType,
          data: newAttachment.data,
        }
        const result = await window.electronAPI.saveAttachment(input)
        newSavedAttachments.push(result.attachment)
      }

      await handleSend(trimmed, {
        attachments: [...payload.keepExistingAttachments, ...newSavedAttachments],
        consumePendingAttachments: false,
        messageCountBeforeSend: forked.messageCountBeforeSend,
        contextDividersOverride: forked.contextDividersAfterTruncate,
        pendingUserMessageId: forked.newUserMessage.id,
      })
      setInlineEditingMessageId(null)
    } catch (error) {
      console.error('[ChatView] 原地编辑重发失败:', error)
    } finally {
      inlineEditSubmitRef.current = false
    }
  }, [conversationId, isStreaming, forkFromMessage, handleSend])

  /** 清除上下文（toggle 最后消息的分隔线） */
  const handleClearContext = React.useCallback((): void => {
    if (messages.length === 0) return

    const lastMessage = messages[messages.length - 1]!
    const lastMessageId = lastMessage.id

    let newDividers: string[]
    if (contextDividers.includes(lastMessageId)) {
      // 已有分隔线 → 删除
      newDividers = contextDividers.filter((id) => id !== lastMessageId)
    } else {
      // 无分隔线 → 添加
      newDividers = [...contextDividers, lastMessageId]
    }

    setContextDividers(newDividers)
    window.electronAPI
      .updateContextDividers(conversationId, newDividers)
      .catch(console.error)
  }, [conversationId, messages, contextDividers])

  /** 删除分隔线 */
  const handleDeleteDivider = React.useCallback((messageId: string): void => {
    const newDividers = contextDividers.filter((id) => id !== messageId)
    setContextDividers(newDividers)
    window.electronAPI
      .updateContextDividers(conversationId, newDividers)
      .catch(console.error)
  }, [conversationId, contextDividers])

  /** 切换激活路径：把路径写到 main，重渲染 */
  const handleSetActivePath = React.useCallback(async (path: string[]) => {
    const updated = await window.electronAPI.setActivePath(conversationId, path)
    setMessages(updated)
    setHasMoreMessages(false)
    return updated
  }, [conversationId])

  /** 切换激活分支（被 BranchTreeView 调用） */
  const handleSetActivePathViaTree = React.useCallback(
    async (path: string[]): Promise<void> => {
      await handleSetActivePath(path)
      await reloadBranchTree()
    },
    [handleSetActivePath, reloadBranchTree],
  )

  /** 加载整个分支树快照（用于树视图） */
  const loadBranchTree = React.useCallback(async () => {
    return window.electronAPI.getBranchTree(conversationId)
  }, [conversationId])

  /** 加载全部历史消息（向上滚动时触发） */
  const handleLoadMore = React.useCallback(async (): Promise<void> => {
    const branch = await window.electronAPI.getBranch(conversationId)
    setMessages(branch)
    setHasMoreMessages(false)
  }, [conversationId])

  return (
    <div className="flex h-full overflow-hidden">
      {/* 主内容区域 */}
      <div data-profer-navigation-region="conversation" tabIndex={-1} className="flex flex-col h-full flex-1 min-w-0">
        {/* Header 在 max-w 外，按钮可到达最右侧 */}
        <ChatHeader conversation={conversation} onOpenHistory={() => setHistoryDrawerOpen(true)} />
        <div className="flex flex-col flex-1 w-full max-w-[min(72rem,100%)] mx-auto overflow-hidden min-h-0">
          {/* 中间：消息区域 */}
          <ChatMessages
            conversationId={conversationId}
            messages={messages}
            messagesLoaded={messagesLoaded}
            streaming={isStreaming}
            streamingContent={streamingContent}
            streamingReasoning={streamingReasoning}
            streamingModel={streamingModel}
            startedAt={streamState?.startedAt}
            toolActivities={toolActivities}
            contextDividers={contextDividers}
            hasMore={hasMoreMessages}
            onDeleteMessage={handleDeleteMessage}
            onResendMessage={handleResendMessage}
            onStartInlineEdit={handleStartInlineEdit}
            onSubmitInlineEdit={handleSubmitInlineEdit}
            onCancelInlineEdit={handleCancelInlineEdit}
            inlineEditingMessageId={inlineEditingMessageId}
            onDeleteDivider={handleDeleteDivider}
            onLoadMore={handleLoadMore}
            onOpenHistory={() => setHistoryDrawerOpen(true)}
          />

          {/* 错误提示 */}
          {chatError && (
            <div className={`mx-4 mb-2 px-4 py-2.5 rounded-lg text-sm flex items-center gap-2 ${isInsufficientCredits ? 'bg-yellow-500/10 text-yellow-700 dark:text-yellow-400' : 'bg-destructive/10 text-destructive'}`}>
              {isInsufficientCredits ? <Wallet className="size-4 shrink-0" /> : <AlertCircle className="size-4 shrink-0" />}
              <span className="flex-1 break-all">{chatError}</span>
              {isInsufficientCredits && (
                <button
                  type="button"
                  className="shrink-0 px-2.5 py-1 rounded-md bg-yellow-500/15 hover:bg-yellow-500/25 text-yellow-700 dark:text-yellow-400 font-medium transition-colors"
                  onClick={() => {
                    setSettingsTab('credits')
                    setSettingsOpen(true)
                  }}
                >
                  查看额度
                </button>
              )}
              <button
                type="button"
                className="shrink-0 p-0.5 rounded hover:bg-foreground/10 transition-colors"
                onClick={() => {
                  setChatStreamErrors((prev) => {
                    const map = new Map(prev)
                    map.delete(conversationId)
                    return map
                  })
                }}
              >
                <X className="size-3.5" />
              </button>
            </div>
          )}

          {/* Agent 模式推荐横幅 */}
          <AgentRecommendBanner />

          {/* 底部：输入框 */}
          <ChatInput
            conversationId={conversationId}
            streaming={isStreaming}
            pendingAttachments={pendingAttachments}
            onSetPendingAttachments={setPendingAttachments}
            pendingKnowledgeReferences={pendingKnowledgeReferences}
            onSetPendingKnowledgeReferences={setPendingKnowledgeReferences}
            onSend={handleSend}
            onStop={handleStop}
            onClearContext={handleClearContext}
          />
        </div>
      </div>

      {previewReference ? <aside className="flex h-full min-w-[320px] max-w-[55%] flex-[0_1_42%] flex-col border-l border-surface-border bg-surface-raised"><header className="flex h-11 shrink-0 items-center border-b border-surface-border px-3"><span className="min-w-0 flex-1 truncate text-sm font-medium">{previewReference.title}</span><button type="button" aria-label="关闭资料预览" onClick={() => setPreviewReference(null)} className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"><X className="size-4"/></button></header><KnowledgePreviewContent reference={previewReference}/></aside> : null}

      {/* 分支树视图 */}
      <BranchTreeView
        open={historyDrawerOpen}
        onOpenChange={setHistoryDrawerOpen}
        conversationId={conversationId}
        tree={branchTree}
        onSwitchToPath={handleSetActivePathViaTree}
        onReloadTree={reloadBranchTree}
        onDeleteMessage={handleDeleteMessage}
      />

      {/* 提示词编辑侧栏 */}
      <div className={cn(
        'chat-prompt-sidebar relative flex-shrink-0 transition-[width] duration-300 ease-in-out overflow-hidden titlebar-drag-region',
        promptSidebarOpen ? 'w-[300px] border-l' : 'w-10'
      )}>
        <div className={cn(
          'w-[300px] h-full transition-opacity duration-200 titlebar-no-drag',
          promptSidebarOpen ? 'opacity-100' : 'opacity-0 pointer-events-none'
        )}>
          <PromptEditorSidebar />
        </div>
      </div>
    </div>
  )
}
