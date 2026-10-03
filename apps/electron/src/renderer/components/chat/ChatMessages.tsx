/**
 * ChatMessages - 消息区域
 *
 * 使用 Conversation / ConversationContent / ConversationScrollButton 原语
 * 替代手动 scroll。支持上下文分隔线和并排模式切换。
 *
 * 功能：
 * - StickToBottom 自动滚动容器
 * - 遍历 messages → ChatMessageItem
 * - 消息间渲染 ContextDivider（根据 contextDividersAtom）
 * - streaming 时末尾显示临时 assistant 消息
 * - 并排模式切换到 ParallelChatMessages
 */

import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { Loader2 } from 'lucide-react'
import { WelcomeEmptyState } from '@/components/welcome/WelcomeEmptyState'
import { ChatMessageItem, formatMessageTime } from './ChatMessageItem'
import type { InlineEditSubmitPayload } from './ChatMessageItem'
import { ChatToolActivityIndicator } from './ChatToolActivityIndicator'
import { ParallelChatMessages } from './ParallelChatMessages'
import {
  Message,
  MessageHeader,
  MessageContent,
  MessageLoading,
  MessageResponse,
  StreamingIndicator,
} from '@/components/ai-elements/message'
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from '@/components/ai-elements/conversation'
import { ScrollMinimap } from '@/components/ai-elements/scroll-minimap'
import type { MinimapItem } from '@/components/ai-elements/scroll-minimap'
import { useConversationScroll } from '@/components/ai-elements/conversation-scroll'
import { ConversationFollowTrigger } from '@/components/ai-elements/conversation-follow-trigger'
import { useCompletionTransition } from '@/hooks/useCompletionTransition'
import { ContextDivider } from '@/components/ai-elements/context-divider'
import {
  Reasoning,
  ReasoningTrigger,
  ReasoningContent,
} from '@/components/ai-elements/reasoning'
import { ScrollPositionManager } from '@/hooks/useScrollPositionMemory'
import { useConversationParallelMode } from '@/hooks/useConversationSettings'
import { getModelLogo, resolveModelProvider } from '@/lib/model-logo'
import { parseQuotedSelectionRefs } from '@/lib/quoted-selection'
import { userProfileAtom } from '@/atoms/user-profile'
import { channelsAtom } from '@/atoms/chat-atoms'
import { tabMinimapCacheAtom } from '@/atoms/tab-atoms'
import type { ChatMessage, ChatToolActivity } from '@profer/shared'

// ===== 滚动到顶部加载更多 =====

interface ScrollTopLoaderProps {
  /** 是否还有更多历史消息 */
  hasMore: boolean
  /** 是否正在加载 */
  loading: boolean
  /** 加载更多回调 */
  onLoadMore: () => Promise<void>
}

/**
 * 滚动到顶部自动加载更多历史消息
 *
 * 挂在 Conversation（StickToBottom）内部，通过 context 获取滚动容器 ref，
 * 监听 scroll 事件，当滚动到顶部附近时触发加载。
 * 加载后恢复滚动位置，保证用户视角不变。
 */
function ScrollTopLoader({ hasMore, loading, onLoadMore }: ScrollTopLoaderProps): React.ReactElement | null {
  const { scrollRef, beginLayout, following } = useConversationScroll()
  const loadRef = React.useRef(onLoadMore)
  loadRef.current = onLoadMore

  React.useEffect(() => {
    const el = scrollRef.current
    if (!el || !hasMore || following) return
    let active = true
    let inFlight = false
    let armed = true
    let frame: number | undefined
    const handleScroll = (): void => {
      if (el.scrollTop >= 100) armed = true
      if (el.scrollTop >= 100 || !armed || inFlight) return
      armed = false
      inFlight = true
      const finishLayout = beginLayout()
      void loadRef.current()
        .then(() => {
          if (!active) return
          frame = requestAnimationFrame(() => {
            if (active) finishLayout()
          })
        })
        .catch(() => { armed = true })
        .finally(() => { inFlight = false })
    }
    el.addEventListener('scroll', handleScroll, { passive: true })
    return () => {
      active = false
      if (frame !== undefined) cancelAnimationFrame(frame)
      el.removeEventListener('scroll', handleScroll)
    }
  }, [scrollRef, hasMore, beginLayout, following])

  if (!hasMore || !loading) return null
  return (
    <div role="status" aria-label="正在加载历史消息" className="absolute inset-x-0 top-0 z-10 flex justify-center py-3 pointer-events-none">
      <Loader2 className="size-4 animate-spin text-muted-foreground" />
    </div>
  )
}

// ===== 主组件 =====

interface ChatMessagesProps {
  /** 当前对话 ID */
  conversationId: string
  /** 消息列表 */
  messages: ChatMessage[]
  /** 消息是否已完成首次 IPC 加载 */
  messagesLoaded: boolean
  /** 是否正在流式生成 */
  streaming: boolean
  /** 流式累积内容 */
  streamingContent: string
  /** 流式推理内容 */
  streamingReasoning: string
  /** 流式消息绑定的模型 */
  streamingModel: string | null
  /** 流式开始时间戳 */
  startedAt?: number
  /** 工具活动列表 */
  toolActivities: ChatToolActivity[]
  /** 上下文分隔线 */
  contextDividers: string[]
  /** 是否还有更多历史消息 */
  hasMore: boolean
  /** 删除消息回调 */
  onDeleteMessage?: (messageId: string) => Promise<void>
  /** 重新发送消息回调 */
  onResendMessage?: (message: ChatMessage) => Promise<void>
  /** 开始原地编辑消息 */
  onStartInlineEdit?: (message: ChatMessage) => void
  /** 提交原地编辑 */
  onSubmitInlineEdit?: (message: ChatMessage, payload: InlineEditSubmitPayload) => Promise<void>
  /** 取消原地编辑 */
  onCancelInlineEdit?: () => void
  /** 当前正在编辑的消息 ID */
  inlineEditingMessageId?: string | null
  /** 删除分隔线回调 */
  onDeleteDivider?: (messageId: string) => void
  /** 加载更多历史消息回调 */
  onLoadMore?: () => Promise<void>
  /** 打开"历史版本抽屉"回调（用于从单条消息的"查看历史"按钮触发） */
  onOpenHistory?: (anchorMessageId?: string) => void
}

/** 空状态引导 — 使用 WelcomeEmptyState */
function EmptyState(): React.ReactElement {
  return <WelcomeEmptyState />
}

export function ChatMessages({
  conversationId,
  messages,
  messagesLoaded,
  streaming,
  streamingContent,
  streamingReasoning,
  streamingModel,
  startedAt,
  toolActivities,
  contextDividers,
  hasMore,
  onDeleteMessage,
  onResendMessage,
  onStartInlineEdit,
  onSubmitInlineEdit,
  onCancelInlineEdit,
  inlineEditingMessageId,
  onDeleteDivider,
  onLoadMore,
  onOpenHistory,
}: ChatMessagesProps): React.ReactElement {
  const userProfile = useAtomValue(userProfileAtom)
  const channels = useAtomValue(channelsAtom)
  const setMinimapCache = useSetAtom(tabMinimapCacheAtom)

  // 原始累积内容就是可见正文，不再运行第二套逐字更新时钟。
  const visibleContent = streamingContent
  const visibleReasoning = streamingReasoning
  const [parallelMode] = useConversationParallelMode()
  const [loadingMore, setLoadingMore] = React.useState(false)
  const [loadError, setLoadError] = React.useState<string | null>(null)
  const loadingRef = React.useRef(false)
  const loadGeneration = React.useRef(0)
  React.useEffect(() => {
    loadingRef.current = false
    setLoadingMore(false)
    setLoadError(null)
    return () => { loadGeneration.current++ }
  }, [conversationId])
  const transitioning = useCompletionTransition(streaming, !!(visibleContent || visibleReasoning))

  // 缓存 streaming MessageHeader 的 props，避免每帧 re-render 导致闪烁
  const streamingTime = React.useMemo(
    () => formatMessageTime(startedAt ?? Date.now()),
    [startedAt]
  )
  const streamingLogo = React.useMemo(
    () => (
      <img
        src={getModelLogo(streamingModel ?? '', resolveModelProvider(streamingModel ?? '', channels))}
        alt="AI"
        className="size-[35px] rounded-[25%] object-cover"
      />
    ),
    [streamingModel, channels]
  )

  /**
   * 淡入控制：切换对话时先隐藏，等 StickToBottom 定位完成后再显示。
   * 避免 "先看到顶部消息再跳到底部" 的闪烁。
   */
  const [ready, setReady] = React.useState(false)
  // 空对话无需淡入过渡（无消息则无滚动位置问题）
  const [skipFadeIn, setSkipFadeIn] = React.useState(false)
  const prevConversationIdRef = React.useRef<string | null>(null)

  // 对话切换时立即隐藏
  React.useEffect(() => {
    if (conversationId !== prevConversationIdRef.current) {
      prevConversationIdRef.current = conversationId
      setReady(false)
      setSkipFadeIn(false)
    }
  }, [conversationId])

  // 消息渲染 + StickToBottom 定位完成后淡入
  React.useEffect(() => {
    if (ready) return

    // 必须等消息 IPC 加载完成，否则 messages=[] 会被误判为空对话
    if (!messagesLoaded) return

    // 加载完后确实是空对话：直接显示（无需过渡动画）
    if (messages.length === 0 && !streaming) {
      setSkipFadeIn(true)
      setReady(true)
      return
    }

    // 双 rAF：确保 DOM 渲染和 StickToBottom 滚动都完成
    let cancelled = false
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!cancelled) setReady(true)
      })
    })
    return () => { cancelled = true }
  }, [messages, streaming, ready, messagesLoaded])

  /** 加载更多历史消息 */
  const handleLoadMore = React.useCallback(async () => {
    if (!onLoadMore || loadingRef.current || !hasMore) return
    const generation = loadGeneration.current
    loadingRef.current = true
    setLoadingMore(true)
    setLoadError(null)
    try {
      await onLoadMore()
    } catch (error) {
      if (generation === loadGeneration.current) {
        setLoadError(error instanceof Error ? error.message : '历史消息加载失败')
      }
      throw error
    } finally {
      if (generation === loadGeneration.current) {
        loadingRef.current = false
        setLoadingMore(false)
      }
    }
  }, [onLoadMore, hasMore])

  // 并排模式：自动加载全部历史消息（并排视图需要完整上下文）
  React.useEffect(() => {
    if (parallelMode && hasMore) {
      void handleLoadMore().catch(() => {})
    }
  }, [parallelMode, hasMore, handleLoadMore])

  // 迷你地图数据（必须在所有条件分支之前调用，遵守 hooks 规则）
  const minimapItems: MinimapItem[] = React.useMemo(
    () => messages.map((m) => ({
      id: m.id,
      role: m.role as MinimapItem['role'],
      preview: (m.role === 'user' ? parseQuotedSelectionRefs(m.content).text : m.content).slice(0, 200),
      avatar: m.role === 'user' ? userProfile.avatar : undefined,
      model: m.model,
    })),
    [messages, userProfile.avatar]
  )

  // 同步 minimap 缓存到 Tab 级别（供 Tab hover 预览使用）
  React.useEffect(() => {
    if (minimapItems.length > 0) {
      setMinimapCache((prev) => {
        const next = new Map(prev)
        next.set(conversationId, minimapItems)
        return next
      })
    }
  }, [conversationId, minimapItems, setMinimapCache])

  // 并排模式
  if (parallelMode) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {loadError && (
          <div role="alert" className="flex items-center justify-center gap-2 py-2 text-xs text-destructive">
            <span>{loadError}</span>
            <button type="button" disabled={loadingMore} onClick={() => { void handleLoadMore().catch(() => {}) }} className="underline disabled:opacity-50">重试</button>
          </div>
        )}
      <ParallelChatMessages
        messages={messages}
        messagesLoaded={messagesLoaded}
        conversationId={conversationId}
        streaming={streaming}
        streamingContent={visibleContent}
        streamingReasoning={visibleReasoning}
        startedAt={startedAt}
        contextDividers={contextDividers}
        onDeleteDivider={onDeleteDivider}
        onDeleteMessage={onDeleteMessage}
        onResendMessage={onResendMessage}
        onStartInlineEdit={onStartInlineEdit}
        onSubmitInlineEdit={onSubmitInlineEdit}
        onCancelInlineEdit={onCancelInlineEdit}
        inlineEditingMessageId={inlineEditingMessageId}
        loadingMore={loadingMore}
      />
      </div>
    )
  }

  // 标准消息列表模式
  const dividerSet = new Set(contextDividers)

  return (
    <Conversation key={conversationId} resize={ready && !transitioning ? 'smooth' : 'instant'} className={ready ? (skipFadeIn ? 'opacity-100' : 'opacity-100 transition-opacity duration-200') : 'opacity-0'}>
      <ScrollPositionManager id={conversationId} ready={ready} />
      {/* 滚动到顶部时自动加载更多历史 */}
      <ScrollTopLoader
        hasMore={hasMore}
        loading={loadingMore}
        onLoadMore={handleLoadMore}
      />
      <ConversationFollowTrigger sessionId={conversationId} loaded={messagesLoaded && ready} />
      <ConversationContent>
        {loadError && (
          <div role="alert" className="flex items-center justify-center gap-2 py-2 text-xs text-destructive">
            <span>{loadError}</span>
            <button type="button" disabled={loadingMore} onClick={() => { void handleLoadMore().catch(() => {}) }} className="underline disabled:opacity-50">重试</button>
          </div>
        )}
        {messages.length === 0 && !streaming ? (
          <EmptyState />
        ) : (
          <>
            {/* 已有消息 + 分隔线 */}
            {messages.map((msg: ChatMessage) => (
              <React.Fragment key={msg.id}>
                <div data-message-id={msg.id}>
                  <ChatMessageItem
                    message={msg}
                    conversationId={conversationId}
                    isStreaming={false}
                    isLastAssistant={false}
                    allMessages={messages}
                    onDeleteMessage={onDeleteMessage}
                    onResendMessage={onResendMessage}
                    onStartInlineEdit={onStartInlineEdit}
                    onSubmitInlineEdit={onSubmitInlineEdit}
                    onCancelInlineEdit={onCancelInlineEdit}
                    isInlineEditing={msg.id === inlineEditingMessageId}
                    onOpenHistory={onOpenHistory ? () => onOpenHistory(msg.id) : undefined}
                  />
                </div>
                {/* 分隔线 */}
                {dividerSet.has(msg.id) && (
                  <ContextDivider
                    messageId={msg.id}
                    onDelete={onDeleteDivider}
                  />
                )}
              </React.Fragment>
            ))}

            {/* 正在生成 / 停止后等待磁盘消息加载的临时 assistant 消息 */}
            {(streaming || visibleContent || visibleReasoning) && (
              <Message from="assistant">
                <MessageHeader
                  model={streamingModel ?? undefined}
                  time={streamingTime}
                  logo={streamingLogo}
                />
                <MessageContent>
                  {/* 工具活动指示器 */}
                  <ChatToolActivityIndicator activities={toolActivities} isStreaming={streaming} />

                  {/* 推理内容（如果有） */}
                  {visibleReasoning && (
                    <Reasoning
                      isStreaming={streaming && !visibleContent}
                      defaultOpen={true}
                    >
                      <ReasoningTrigger />
                      <ReasoningContent>{visibleReasoning}</ReasoningContent>
                    </Reasoning>
                  )}

                  {/* 最新流式 Markdown 正文 */}
                  {visibleContent ? (
                    <>
                      <MessageResponse>{visibleContent}</MessageResponse>
                      {streaming && <StreamingIndicator />}
                    </>
                  ) : (
                    /* 等待首个 chunk 时的加载动画（仅流式中且无推理时显示） */
                    streaming && !visibleReasoning && <MessageLoading startedAt={startedAt} />
                  )}
                </MessageContent>
                {/* 操作栏占位：预留与 MessageActions 相同高度，防止流式结束时布局跳动 */}
                <div className="pl-[46px] mt-0.5 min-h-[28px]" />
              </Message>
            )}
          </>
        )}
      </ConversationContent>
      <ScrollMinimap items={minimapItems} />
      <ConversationScrollButton />
    </Conversation>
  )
}
