/**
 * ParallelChatMessages - 并排消息展示
 *
 * 两列布局：用户消息 | 助手回复
 * - 按上下文分隔线分段
 * - 各列独立 StickToBottom 滚动
 * - ChatMessageItem 以 isParallelMode={true} 渲染
 *
 * 移植自 profer-frontend 的 parallel-chat-messages.tsx。
 */

import { Fragment, useMemo } from 'react'
import { useAtomValue } from 'jotai'
import { Loader2 } from 'lucide-react'
import { ChatMessageItem, formatMessageTime } from './ChatMessageItem'
import type { InlineEditSubmitPayload } from './ChatMessageItem'
import { ContextDivider } from '@/components/ai-elements/context-divider'
import {
  Message,
  MessageHeader,
  MessageContent,
  MessageLoading,
  MessageResponse,
  StreamingIndicator,
} from '@/components/ai-elements/message'
import {
  Reasoning,
  ReasoningTrigger,
  ReasoningContent,
} from '@/components/ai-elements/reasoning'
import { streamingModelAtom, channelsAtom } from '@/atoms/chat-atoms'
import { getModelLogo, resolveModelProvider } from '@/lib/model-logo'
import { Conversation, ConversationContent, ConversationScrollButton } from '@/components/ai-elements/conversation'
import { ConversationFollowTrigger, useConversationFollowIntentBaseline } from '@/components/ai-elements/conversation-follow-trigger'
import { ScrollPositionManager } from '@/hooks/useScrollPositionMemory'
import type { ChatMessage } from '@profer/shared'

/** 消息段落（按分隔线分割） */
interface MessageSegment {
  userMessages: ChatMessage[]
  assistantMessages: ChatMessage[]
  dividerMessageId?: string
}

interface ParallelChatMessagesProps {
  messages: ChatMessage[]
  messagesLoaded?: boolean
  /** 当前对话 ID（用于迁移到 Agent 模式） */
  conversationId?: string
  streaming: boolean
  streamingContent: string
  streamingReasoning: string
  /** 流式开始时间戳 */
  startedAt?: number
  contextDividers?: string[]
  onDeleteDivider?: (messageId: string) => void
  onDeleteMessage?: (messageId: string) => Promise<void>
  onResendMessage?: (message: ChatMessage) => Promise<void>
  onStartInlineEdit?: (message: ChatMessage) => void
  onSubmitInlineEdit?: (message: ChatMessage, payload: InlineEditSubmitPayload) => Promise<void>
  onCancelInlineEdit?: () => void
  inlineEditingMessageId?: string | null
  /** 是否正在加载更多历史消息 */
  loadingMore?: boolean
}

/** 空列占位 */
function EmptyColumn({ side }: { side: 'user' | 'assistant' }): React.ReactElement {
  return (
    <div className="flex h-full items-center justify-center p-4">
      <p className="text-sm text-muted-foreground">
        {side === 'user' ? '暂无用户消息' : '暂无助手回复'}
      </p>
    </div>
  )
}

/** 加载更多旋转器 */
function LoadMoreSpinner(): React.ReactElement {
  return (
    <div className="flex items-center justify-center py-3">
      <Loader2 className="size-4 animate-spin text-muted-foreground" />
    </div>
  )
}

/**
 * 将消息按 ContextDivider 分割成多个段落
 */
function segmentMessages(
  messages: ChatMessage[],
  contextDividers: string[]
): MessageSegment[] {
  const dividerSet = new Set(contextDividers)
  const segments: MessageSegment[] = []
  let currentUserMessages: ChatMessage[] = []
  let currentAssistantMessages: ChatMessage[] = []

  for (const message of messages) {
    if (message.role === 'user') {
      currentUserMessages.push(message)
    } else if (message.role === 'assistant') {
      currentAssistantMessages.push(message)
    }

    // 如果这条消息后面有分隔线，结束当前段落
    if (dividerSet.has(message.id)) {
      segments.push({
        userMessages: currentUserMessages,
        assistantMessages: currentAssistantMessages,
        dividerMessageId: message.id,
      })
      currentUserMessages = []
      currentAssistantMessages = []
    }
  }

  // 添加最后一个段落
  if (currentUserMessages.length > 0 || currentAssistantMessages.length > 0) {
    segments.push({
      userMessages: currentUserMessages,
      assistantMessages: currentAssistantMessages,
    })
  }

  return segments
}

/** 单列消息渲染 */
interface MessageColumnProps {
  messages: ChatMessage[]
  allMessages: ChatMessage[]
  /** 当前对话 ID（用于迁移到 Agent 模式） */
  conversationId?: string
  onDeleteMessage?: (messageId: string) => Promise<void>
  onResendMessage?: (message: ChatMessage) => Promise<void>
  onStartInlineEdit?: (message: ChatMessage) => void
  onSubmitInlineEdit?: (message: ChatMessage, payload: InlineEditSubmitPayload) => Promise<void>
  onCancelInlineEdit?: () => void
  inlineEditingMessageId?: string | null
  side: 'user' | 'assistant'
  segmentId?: string
  followActive?: boolean
  initialIntent: number
  messagesLoaded?: boolean
  /** streaming 相关 - 仅 assistant 列需要 */
  streaming?: boolean
  streamingContent?: string
  streamingReasoning?: string
  startedAt?: number
}

function MessageColumn({
  messages,
  allMessages,
  conversationId,
  onDeleteMessage,
  onResendMessage,
  onStartInlineEdit,
  onSubmitInlineEdit,
  onCancelInlineEdit,
  inlineEditingMessageId,
  side,
  segmentId = 'tail',
  followActive = true,
  initialIntent,
  messagesLoaded = true,
  streaming = false,
  streamingContent = '',
  streamingReasoning = '',
  startedAt,
}: MessageColumnProps): React.ReactElement {
  const streamingModel = useAtomValue(streamingModelAtom)
  const channels = useAtomValue(channelsAtom)

  return (
    <Conversation key={`${conversationId}:${segmentId}:${side}`} className="min-h-0 overscroll-contain">
      {conversationId && <ConversationFollowTrigger sessionId={conversationId} loaded={messagesLoaded} active={followActive} initialIntent={initialIntent} />}
      {conversationId && <ScrollPositionManager id={`${conversationId}:parallel:${segmentId}:${side}`} ready={messagesLoaded} />}
      <ConversationContent className="gap-6 p-4">
        {messages.length === 0 && !(side === 'assistant' && streaming) && <EmptyColumn side={side} />}
        {messages.map((message) => (
          <div key={message.id} data-message-id={message.id}>
            <ChatMessageItem
              message={message}
              conversationId={conversationId}
              allMessages={allMessages}
              onDeleteMessage={onDeleteMessage}
              onResendMessage={onResendMessage}
              onStartInlineEdit={onStartInlineEdit}
              onSubmitInlineEdit={onSubmitInlineEdit}
              onCancelInlineEdit={onCancelInlineEdit}
              isInlineEditing={message.id === inlineEditingMessageId}
              isParallelMode
            />
          </div>
        ))}
        {/* assistant 列：流式生成 / 停止后等待磁盘消息的临时消息 */}
        {side === 'assistant' && (streaming || streamingContent || streamingReasoning) && (
          <Message from="assistant">
            <MessageHeader
              model={streamingModel ?? undefined}
              time={formatMessageTime(Date.now())}
              logo={
                <img
                  src={getModelLogo(streamingModel ?? '', resolveModelProvider(streamingModel ?? '', channels))}
                  alt="AI"
                  className="size-[35px] rounded-[25%] object-cover"
                />
              }
            />
            <MessageContent>
              {streamingReasoning && (
                <Reasoning isStreaming={streaming && !streamingContent} defaultOpen={true}>
                  <ReasoningTrigger />
                  <ReasoningContent>{streamingReasoning}</ReasoningContent>
                </Reasoning>
              )}
              {streamingContent ? (
                <>
                  <MessageResponse>{streamingContent}</MessageResponse>
                  {streaming && <StreamingIndicator />}
                </>
              ) : (
                streaming && !streamingReasoning && <MessageLoading startedAt={startedAt} />
              )}
            </MessageContent>
          </Message>
        )}
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>
  )
}

export function ParallelChatMessages({
  messages,
  messagesLoaded = true,
  conversationId,
  streaming,
  streamingContent,
  streamingReasoning,
  startedAt,
  contextDividers = [],
  onDeleteDivider,
  onDeleteMessage,
  onResendMessage,
  onStartInlineEdit,
  onSubmitInlineEdit,
  onCancelInlineEdit,
  inlineEditingMessageId,
  loadingMore = false,
}: ParallelChatMessagesProps): React.ReactElement {
  const initialIntent = useConversationFollowIntentBaseline(conversationId ?? '', messagesLoaded)
  // 分段消息
  const segments = useMemo(
    () => segmentMessages(messages, contextDividers),
    [messages, contextDividers]
  )

  // 过滤出所有用户消息和助手消息
  const userMessages = useMemo(
    () => messages.filter((m) => m.role === 'user'),
    [messages]
  )
  const assistantMessages = useMemo(
    () => messages.filter((m) => m.role === 'assistant'),
    [messages]
  )
  // 如果没有分隔线，使用简单的两列布局
  if (segments.length <= 1) {
    return (
      <div className="relative flex-1 min-h-0">
        {/* 加载更多历史消息的旋转器 */}
        {loadingMore && (
          <div className="absolute top-0 left-0 right-0 z-10">
            <LoadMoreSpinner />
          </div>
        )}

        {/* 绝对定位内层，获得确定高度，解决嵌套 flex 滚动问题 */}
        <div className="absolute inset-0 flex">
          {/* 左侧用户消息 */}
          <div className="w-1/2 flex flex-col overflow-hidden border-r border-border">
            <div className="px-4 py-2 border-b border-border bg-muted/30">
              <span className="text-sm font-medium text-muted-foreground">
                用户消息
              </span>
            </div>
            <MessageColumn
              messages={userMessages}
              initialIntent={initialIntent}
              allMessages={messages}
              messagesLoaded={messagesLoaded}
              conversationId={conversationId}
              onDeleteMessage={onDeleteMessage}
              onResendMessage={onResendMessage}
              onStartInlineEdit={onStartInlineEdit}
              onSubmitInlineEdit={onSubmitInlineEdit}
              onCancelInlineEdit={onCancelInlineEdit}
              inlineEditingMessageId={inlineEditingMessageId}
              side="user"
            />
          </div>

          {/* 右侧助手消息 */}
          <div className="w-1/2 flex flex-col overflow-hidden">
            <div className="px-4 py-2 border-b border-border bg-muted/30">
              <span className="text-sm font-medium text-muted-foreground">
                助手回复
              </span>
            </div>
            <MessageColumn
              messages={assistantMessages}
              initialIntent={initialIntent}
              allMessages={messages}
              messagesLoaded={messagesLoaded}
              conversationId={conversationId}
              onDeleteMessage={onDeleteMessage}
              onResendMessage={onResendMessage}
              onStartInlineEdit={onStartInlineEdit}
              onSubmitInlineEdit={onSubmitInlineEdit}
              onCancelInlineEdit={onCancelInlineEdit}
              inlineEditingMessageId={inlineEditingMessageId}
              side="assistant"
              streaming={streaming}
              streamingContent={streamingContent}
              streamingReasoning={streamingReasoning}
              startedAt={startedAt}
            />
          </div>
        </div>
      </div>
    )
  }

  // 有分隔线的情况：分段渲染
  return (
    <div className="relative flex-1 min-h-0">
      <div className="absolute inset-0 flex flex-col overflow-hidden">
        {/* 加载更多历史消息的旋转器 */}
        {loadingMore && <LoadMoreSpinner />}

        {segments.map((segment, index) => (
          <Fragment key={segment.dividerMessageId ? `divider:${segment.dividerMessageId}` : 'tail'}>
            {/* 该段的左右并排消息 */}
            <div
              className={
                index === segments.length - 1
                  ? 'flex flex-1 min-h-0 overflow-hidden'
                  : 'flex flex-shrink-0 overflow-hidden'
              }
            >
              {/* 左侧用户消息 */}
              <div className="w-1/2 flex flex-col overflow-hidden border-r border-border">
                {index === 0 && (
                  <div className="px-4 py-2 border-b border-border bg-muted/30">
                    <span className="text-sm font-medium text-muted-foreground">
                      用户消息
                    </span>
                  </div>
                )}
                <MessageColumn
                  messages={segment.userMessages}
                  initialIntent={initialIntent}
                  allMessages={messages}
                  messagesLoaded={messagesLoaded}
                  followActive={index === segments.length - 1}
                  conversationId={conversationId}
                  onDeleteMessage={onDeleteMessage}
                  onResendMessage={onResendMessage}
                  onStartInlineEdit={onStartInlineEdit}
                  onSubmitInlineEdit={onSubmitInlineEdit}
                  onCancelInlineEdit={onCancelInlineEdit}
                  inlineEditingMessageId={inlineEditingMessageId}
                  side="user"
                  segmentId={segment.dividerMessageId ?? 'tail'}
                />
              </div>

              {/* 右侧助手消息 */}
              <div className="w-1/2 flex flex-col overflow-hidden">
                {index === 0 && (
                  <div className="px-4 py-2 border-b border-border bg-muted/30">
                    <span className="text-sm font-medium text-muted-foreground">
                      助手回复
                    </span>
                  </div>
                )}
                <MessageColumn
                  messages={segment.assistantMessages}
                  initialIntent={initialIntent}
                  allMessages={messages}
                  messagesLoaded={messagesLoaded}
                  followActive={index === segments.length - 1}
                  conversationId={conversationId}
                  onDeleteMessage={onDeleteMessage}
                  onResendMessage={onResendMessage}
                  onStartInlineEdit={onStartInlineEdit}
                  onSubmitInlineEdit={onSubmitInlineEdit}
                  onCancelInlineEdit={onCancelInlineEdit}
                  inlineEditingMessageId={inlineEditingMessageId}
                  side="assistant"
                  segmentId={segment.dividerMessageId ?? 'tail'}
                  streaming={index === segments.length - 1 ? streaming : false}
                  streamingContent={index === segments.length - 1 ? streamingContent : ''}
                  streamingReasoning={index === segments.length - 1 ? streamingReasoning : ''}
                  startedAt={index === segments.length - 1 ? startedAt : undefined}
                />
              </div>
            </div>

            {/* 当前段落后的分隔线 */}
            {segment.dividerMessageId && (
              <ContextDivider
                messageId={segment.dividerMessageId}
                onDelete={onDeleteDivider}
                className="flex-shrink-0"
              />
            )}
          </Fragment>
        ))}
      </div>
    </div>
  )
}
