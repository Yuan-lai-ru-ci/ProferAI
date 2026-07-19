/**
 * ChatMessageItem - 单条消息渲染
 *
 * 使用 ai-elements 原语组合渲染消息。
 * 支持复制、删除、重新发送、原地编辑操作，并排模式。
 *
 * - assistant 消息：头像 + Reasoning 折叠 + Markdown 内容 + 操作按钮
 * - user 消息：右对齐气泡 + 可折叠长文本 + 操作按钮
 * - streaming 最后一条：呼吸脉冲指示器
 */

import * as React from 'react'
import { useAtomValue } from 'jotai'
import { AlertCircle, FileText, Library, Pencil, RotateCcw, Trash2 } from 'lucide-react'
import {
  Message,
  MessageHeader,
  MessageContent,
  MessageActions,
  MessageAction,
  MessageResponse,
  UserMessageContent,
  MessageStopped,
  StreamingIndicator,
  MessageAttachments,
} from '@/components/ai-elements/message'
import {
  Reasoning,
  ReasoningTrigger,
  ReasoningContent,
} from '@/components/ai-elements/reasoning'
import { CopyButton } from './CopyButton'
import { MigrateToAgentButton } from './MigrateToAgentButton'
import { DeleteMessageDialog } from './DeleteMessageDialog'
import { InlineEditForm } from './InlineEditForm'
import { UserAvatar } from './UserAvatar'
import { getModelLogo, resolveModelDisplayName, resolveModelProvider } from '@/lib/model-logo'
import { userProfileAtom } from '@/atoms/user-profile'
import { channelsAtom } from '@/atoms/chat-atoms'
import type { ChatMessage, KnowledgeReference } from '@profer/shared'
import type { InlineEditSubmitPayload } from './InlineEditForm'
import { ChatToolActivityIndicator } from './ChatToolActivityIndicator'
import { cn } from '@/lib/utils'
import { openKnowledgePreview } from '@/components/knowledge-base/KnowledgePreviewPanel'

// 重导出供外部使用
export type { InlineEditSubmitPayload } from './InlineEditForm'

function KnowledgeReferenceCards({ references }: { references: KnowledgeReference[] }): React.ReactElement {
  const [availableIds, setAvailableIds] = React.useState<Set<string> | null>(null)
  React.useEffect(() => {
    let active = true
    void window.electronAPI.knowledge.getLibrarySnapshot()
      .then((snapshot) => { if (active) setAvailableIds(new Set(snapshot.items.map((item) => item.id))) })
      .catch(() => { if (active) setAvailableIds(null) })
    return () => { active = false }
  }, [])
  return <div className="mb-3 rounded-lg border border-primary/20 bg-primary/[0.03] p-3"><div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-primary"><Library className="size-3.5"/>已导入 {references.length} 份资料</div><div className="space-y-1.5">{references.map((reference) => {
    const unavailable = availableIds !== null && !availableIds.has(reference.itemId)
    return <button key={reference.itemId} type="button" disabled={unavailable} onClick={() => openKnowledgePreview(reference)} className={cn('flex w-full items-center gap-2 rounded border border-border/60 bg-background/60 px-2 py-1.5 text-left text-xs hover:bg-accent disabled:cursor-not-allowed', unavailable && 'opacity-55')}><FileText className="size-3.5 text-muted-foreground"/><span className="min-w-0 flex-1 truncate">{reference.title}</span>{unavailable ? <span className="shrink-0 text-destructive">已删除，不可读取</span> : <span className="shrink-0 text-muted-foreground">{reference.kind} · {reference.origin === 'arxiv' ? '研究资料' : '本地资料'}</span>}</button>
  })}</div></div>
}

/**
 * 格式化消息时间（简略写法）
 * - 今年：02/12 14:30
 * - 跨年：2025/02/12 14:30
 */
export function formatMessageTime(timestamp: number): string {
  const date = new Date(timestamp)
  const now = new Date()

  const hh = date.getHours().toString().padStart(2, '0')
  const mm = date.getMinutes().toString().padStart(2, '0')
  const month = (date.getMonth() + 1).toString().padStart(2, '0')
  const day = date.getDate().toString().padStart(2, '0')
  const time = `${hh}:${mm}`

  if (date.getFullYear() === now.getFullYear()) {
    return `${month}/${day} ${time}`
  }

  return `${date.getFullYear()}/${month}/${day} ${time}`
}

interface ChatMessageItemProps {
  /** 消息数据 */
  message: ChatMessage
  /** 当前对话 ID（用于迁移到 Agent 模式） */
  conversationId?: string
  /** 是否正在流式生成中 */
  isStreaming?: boolean
  /** 是否为最后一条 assistant 消息（用于显示 StreamingIndicator） */
  isLastAssistant?: boolean
  /** 所有消息列表 */
  allMessages?: ChatMessage[]
  /** 消息在列表中的索引 */
  messageIndex?: number
  /** 删除消息回调 */
  onDeleteMessage?: (messageId: string) => Promise<void>
  /** 重新发送用户消息 */
  onResendMessage?: (message: ChatMessage) => Promise<void>
  /** 开始原地编辑用户消息 */
  onStartInlineEdit?: (message: ChatMessage) => void
  /** 原地编辑发送 */
  onSubmitInlineEdit?: (message: ChatMessage, payload: InlineEditSubmitPayload) => Promise<void>
  /** 取消原地编辑 */
  onCancelInlineEdit?: () => void
  /** 是否处于原地编辑态 */
  isInlineEditing?: boolean
  /** 是否并排模式（用户消息不右对齐） */
  isParallelMode?: boolean
}

export const ChatMessageItem = React.memo(function ChatMessageItem({
  message,
  conversationId,
  isStreaming = false,
  isLastAssistant = false,
  onDeleteMessage,
  onResendMessage,
  onStartInlineEdit,
  onSubmitInlineEdit,
  onCancelInlineEdit,
  isInlineEditing = false,
  isParallelMode = false,
}: ChatMessageItemProps): React.ReactElement {
  const [deleteDialogOpen, setDeleteDialogOpen] = React.useState(false)
  const [isDeleting, setIsDeleting] = React.useState(false)
  const userProfile = useAtomValue(userProfileAtom)
  const channels = useAtomValue(channelsAtom)

  /** 确认删除消息 */
  const handleDeleteConfirm = async (): Promise<void> => {
    if (!onDeleteMessage) return
    setIsDeleting(true)
    try {
      await onDeleteMessage(message.id)
    } finally {
      setIsDeleting(false)
      setDeleteDialogOpen(false)
    }
  }

  /** 原地编辑提交 */
  const handleInlineEditSubmit = React.useCallback((payload: InlineEditSubmitPayload): void => {
    if (!onSubmitInlineEdit) return
    void onSubmitInlineEdit(message, payload)
  }, [message, onSubmitInlineEdit])

  // 并排模式下，user 消息不使用 from="user" 以避免右对齐
  const messageFrom = isParallelMode ? 'assistant' : message.role

  return (
    <>
      <Message from={messageFrom}>
        {/* assistant 头像 + 模型名 + 时间 */}
        {message.role === 'assistant' && (
          <MessageHeader
            model={message.model ? resolveModelDisplayName(message.model, channels) : undefined}
            time={formatMessageTime(message.createdAt)}
            logo={
              <img
                src={getModelLogo(message.model ?? '', resolveModelProvider(message.model ?? '', channels))}
                alt={message.model ?? 'AI'}
                className="size-[35px] rounded-[25%] object-cover"
              />
            }
          />
        )}

        {/* user 头像 + 用户名 + 时间 */}
        {message.role === 'user' && (
          <div className="flex items-start gap-2.5 mb-2.5">
            <UserAvatar avatar={userProfile.avatar} size={35} />
            <div className="flex flex-col justify-between h-[35px]">
              <span className="text-sm font-semibold text-foreground/60 leading-none">{userProfile.userName}</span>
              <span className="message-time text-[10px] text-foreground/[0.38] leading-none">{formatMessageTime(message.createdAt)}</span>
            </div>
          </div>
        )}

        <MessageContent className={isInlineEditing ? 'w-full' : undefined}>
          {message.knowledgeReferences?.length ? <KnowledgeReferenceCards references={message.knowledgeReferences} /> : null}
          {message.role === 'assistant' ? (
            <>
              {/* 工具活动记录（历史消息） */}
              {message.toolActivities && message.toolActivities.length > 0 && (
                <ChatToolActivityIndicator activities={message.toolActivities} />
              )}

              {/* 推理折叠区域 */}
              {message.reasoning && (
                <Reasoning
                  isStreaming={isStreaming && !message.content}
                  defaultOpen={isStreaming && !message.content}
                >
                  <ReasoningTrigger />
                  <ReasoningContent>{message.reasoning}</ReasoningContent>
                </Reasoning>
              )}

              {/* 内容区域 */}
              {message.content ? (
                <>
                  <MessageResponse>{message.content}</MessageResponse>
                  {/* 流式传输中的呼吸指示器 */}
                  {isStreaming && isLastAssistant && !message.stopped && (
                    <StreamingIndicator />
                  )}
                </>
              ) : message.error ? (
                null
              ) : message.stopped ? (
                <MessageStopped />
              ) : null}

              {/* 错误提示 */}
              {message.error && (
                <div className="mt-1 px-3 py-2 rounded-md bg-destructive/10 text-destructive text-sm flex items-center gap-2">
                  <AlertCircle className="size-4 shrink-0" />
                  <span className="break-all">{message.error}</span>
                </div>
              )}

              {/* 生成的图片附件（如 GPT Image 生图结果） */}
              {message.attachments && message.attachments.length > 0 && (
                <MessageAttachments attachments={message.attachments} />
              )}
            </>
          ) : (
            /* 用户消息 - 附件 + 可折叠文本 / 原地编辑 */
            <>
              {!isInlineEditing && message.attachments && message.attachments.length > 0 && (
                <MessageAttachments attachments={message.attachments} />
              )}
              {isInlineEditing ? (
                <InlineEditForm
                  message={message}
                  onSubmit={handleInlineEditSubmit}
                  onCancel={() => onCancelInlineEdit?.()}
                />
              ) : message.content && (
                <UserMessageContent>{message.content}</UserMessageContent>
              )}
            </>
          )}
        </MessageContent>

        {/* 操作按钮（非 streaming 时显示，hover 时可见） */}
        {(message.content || message.error || (message.attachments && message.attachments.length > 0)) && !isStreaming && !isInlineEditing && (
          <MessageActions className="pl-[46px] mt-0.5 min-h-[28px]">
            <CopyButton content={message.content} />
            {message.role === 'assistant' && conversationId && (
              <MigrateToAgentButton conversationId={conversationId} />
            )}
            {message.role === 'user' && onResendMessage && (
              <MessageAction
                tooltip="重新发送"
                onClick={() => { void onResendMessage(message) }}
              >
                <RotateCcw className="size-3.5" />
              </MessageAction>
            )}
            {message.role === 'user' && onStartInlineEdit && (
              <MessageAction
                tooltip="编辑后重发"
                onClick={() => onStartInlineEdit(message)}
              >
                <Pencil className="size-3.5" />
              </MessageAction>
            )}
            {onDeleteMessage && (
              <MessageAction
                tooltip="删除"
                onClick={() => setDeleteDialogOpen(true)}
              >
                <Trash2 className="size-3.5" />
              </MessageAction>
            )}
            {message.role === 'assistant' && message.error && (
              <span className="text-[11px] text-destructive ml-1 flex items-center gap-0.5">
                <AlertCircle className="size-3" />
                生成失败
              </span>
            )}
            {message.role === 'assistant' && message.stopped && !message.error && (
              <span className="text-[11px] text-foreground/40 ml-1">（已中止）</span>
            )}
          </MessageActions>
        )}
      </Message>

      {/* 删除确认对话框 */}
      <DeleteMessageDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        onConfirm={handleDeleteConfirm}
        isDeleting={isDeleting}
      />
    </>
  )
})
