/**
 * ChatMessageItem - 单条消息渲染
 *
 * 使用 ai-elements 原语组合渲染消息。
 * 支持复制、删除操作，并排模式。
 *
 * - assistant 消息：头像 + Reasoning 折叠 + Markdown 内容 + 操作按钮
 * - user 消息：右对齐气泡 + 可折叠长文本 + 操作按钮
 * - streaming 最后一条：呼吸脉冲指示器
 */

import * as React from 'react'
import { useAtomValue } from 'jotai'
import { Paperclip, PencilLine, RotateCcw, SendHorizontal, Trash2, X } from 'lucide-react'
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
import { DeleteMessageDialog } from './DeleteMessageDialog'
import { AttachmentPreviewItem } from './AttachmentPreviewItem'
import { UserAvatar } from './UserAvatar'
import { getModelLogo } from '@/lib/model-logo'
import { userProfileAtom } from '@/atoms/user-profile'
import { cn } from '@/lib/utils'
import type { ChatMessage, FileAttachment } from '@proma/shared'

interface NewInlineAttachment {
  filename: string
  mediaType: string
  size: number
  data: string
}

export interface InlineEditSubmitPayload {
  content: string
  keepExistingAttachments: FileAttachment[]
  newAttachments: NewInlineAttachment[]
}

type EditableAttachment =
  | {
    kind: 'existing'
    id: string
    attachment: FileAttachment
    previewUrl?: string
  }
  | {
    kind: 'new'
    id: string
    attachment: FileAttachment
    base64: string
    previewUrl?: string
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

export function ChatMessageItem({
  message,
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
  const [editingContent, setEditingContent] = React.useState(message.content ?? '')
  const [editableAttachments, setEditableAttachments] = React.useState<EditableAttachment[]>([])
  const [isDragOver, setIsDragOver] = React.useState(false)
  const userProfile = useAtomValue(userProfileAtom)

  React.useEffect(() => {
    if (isInlineEditing) {
      setEditingContent(message.content ?? '')
    }
  }, [isInlineEditing, message.content])

  React.useEffect(() => {
    if (!isInlineEditing) {
      setEditableAttachments([])
      return
    }

    const existing: EditableAttachment[] = (message.attachments ?? []).map((att) => ({
      kind: 'existing',
      id: `existing-${att.id}`,
      attachment: att,
    }))
    setEditableAttachments(existing)

    const imageAttachments = (message.attachments ?? []).filter((att) => att.mediaType.startsWith('image/'))
    if (imageAttachments.length === 0) return

    let canceled = false
    Promise.all(
      imageAttachments.map(async (att) => {
        try {
          const base64 = await window.electronAPI.readAttachment(att.localPath)
          return { id: `existing-${att.id}`, previewUrl: `data:${att.mediaType};base64,${base64}` }
        } catch {
          return { id: `existing-${att.id}`, previewUrl: undefined }
        }
      }),
    ).then((results) => {
      if (canceled) return
      setEditableAttachments((prev) =>
        prev.map((item) => {
          const found = results.find((result) => result.id === item.id)
          if (!found || !found.previewUrl) return item
          return { ...item, previewUrl: found.previewUrl }
        }),
      )
    })

    return () => {
      canceled = true
    }
  }, [isInlineEditing, message.id, message.attachments])

  React.useEffect(() => {
    return () => {
      editableAttachments.forEach((item) => {
        if (item.kind === 'new' && item.previewUrl?.startsWith('blob:')) {
          URL.revokeObjectURL(item.previewUrl)
        }
      })
    }
  }, [editableAttachments])

  const addPendingAttachments = React.useCallback((items: NewInlineAttachment[]): void => {
    if (items.length === 0) return
    const now = Date.now()
    const next: EditableAttachment[] = items.map((item, idx) => {
      const tempId = `inline-new-${now}-${idx}-${Math.random().toString(36).slice(2)}`
      return {
        kind: 'new',
        id: tempId,
        attachment: {
          id: tempId,
          filename: item.filename,
          mediaType: item.mediaType,
          localPath: '',
          size: item.size,
        },
        base64: item.data,
        previewUrl: item.mediaType.startsWith('image/') ? `data:${item.mediaType};base64,${item.data}` : undefined,
      }
    })
    setEditableAttachments((prev) => [...prev, ...next])
  }, [])

  const handleSelectAttachments = React.useCallback(async (): Promise<void> => {
    try {
      const result = await window.electronAPI.openFileDialog()
      addPendingAttachments(result.files.map((file) => ({
        filename: file.filename,
        mediaType: file.mediaType,
        size: file.size,
        data: file.data,
      })))
    } catch (error) {
      console.error('[ChatMessageItem] 选择附件失败:', error)
    }
  }, [addPendingAttachments])

  const fileToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => {
        const result = reader.result as string
        resolve(result.split(',')[1])
      }
      reader.onerror = reject
      reader.readAsDataURL(file)
    })
  }

  const handleDropFiles = React.useCallback(async (files: File[]): Promise<void> => {
    const converted: NewInlineAttachment[] = []
    for (const file of files) {
      try {
        const base64 = await fileToBase64(file)
        converted.push({
          filename: file.name || `粘贴附件-${Date.now()}`,
          mediaType: file.type || 'application/octet-stream',
          size: file.size,
          data: base64,
        })
      } catch (error) {
        console.error('[ChatMessageItem] 处理附件失败:', error)
      }
    }
    addPendingAttachments(converted)
  }, [addPendingAttachments])

  const removeEditableAttachment = React.useCallback((id: string): void => {
    setEditableAttachments((prev) => {
      const target = prev.find((item) => item.id === id)
      if (target?.kind === 'new' && target.previewUrl?.startsWith('blob:')) {
        URL.revokeObjectURL(target.previewUrl)
      }
      return prev.filter((item) => item.id !== id)
    })
  }, [])

  const canSubmitInline = editingContent.trim().length > 0 || editableAttachments.length > 0

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

  // 并排模式下，user 消息不使用 from="user" 以避免右对齐
  const messageFrom = isParallelMode ? 'assistant' : message.role

  return (
    <>
      <Message from={messageFrom}>
        {/* assistant 头像 + 模型名 + 时间 */}
        {message.role === 'assistant' && (
          <MessageHeader
            model={message.model}
            time={formatMessageTime(message.createdAt)}
            logo={
              <img
                src={getModelLogo(message.model ?? '')}
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
              <span className="text-[10px] text-foreground/[0.38] leading-none">{formatMessageTime(message.createdAt)}</span>
            </div>
          </div>
        )}

        <MessageContent>
          {message.role === 'assistant' ? (
            <>
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
              ) : message.stopped ? (
                <MessageStopped />
              ) : null}
            </>
          ) : (
            /* 用户消息 - 附件 + 可折叠文本 */
            <>
              {!isInlineEditing && message.attachments && message.attachments.length > 0 && (
                <MessageAttachments attachments={message.attachments} />
              )}
              {isInlineEditing ? (
                <div
                  className={cn(
                    'space-y-2 rounded-xl border border-border/60 bg-background/40 p-2',
                    isDragOver && 'border-dashed border-primary/70 bg-primary/5',
                  )}
                  onDragOver={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    setIsDragOver(true)
                  }}
                  onDragLeave={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    setIsDragOver(false)
                  }}
                  onDrop={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    setIsDragOver(false)
                    const files = Array.from(event.dataTransfer.files)
                    if (files.length > 0) {
                      void handleDropFiles(files)
                    }
                  }}
                >
                  {editableAttachments.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {editableAttachments.map((item) => (
                        <AttachmentPreviewItem
                          key={item.id}
                          filename={item.attachment.filename}
                          mediaType={item.attachment.mediaType}
                          previewUrl={item.previewUrl}
                          onRemove={() => removeEditableAttachment(item.id)}
                        />
                      ))}
                    </div>
                  )}
                  <textarea
                    value={editingContent}
                    onChange={(event) => setEditingContent(event.target.value)}
                    onPaste={(event) => {
                      const files = Array.from(event.clipboardData.files || [])
                      if (files.length === 0) return
                      event.preventDefault()
                      void handleDropFiles(files)
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && !event.shiftKey) {
                        event.preventDefault()
                        if (!canSubmitInline || !onSubmitInlineEdit) return
                        const payload: InlineEditSubmitPayload = {
                          content: editingContent.trim(),
                          keepExistingAttachments: editableAttachments
                            .filter((item) => item.kind === 'existing')
                            .map((item) => item.attachment),
                          newAttachments: editableAttachments
                            .filter((item) => item.kind === 'new')
                            .map((item) => ({
                              filename: item.attachment.filename,
                              mediaType: item.attachment.mediaType,
                              size: item.attachment.size,
                              data: item.base64,
                            })),
                        }
                        void onSubmitInlineEdit(message, payload)
                      }
                    }}
                    className="w-full min-h-[92px] resize-y rounded-xl border border-border bg-background/80 px-3 py-2 text-sm outline-none focus:border-foreground/30"
                    placeholder="编辑消息..."
                    autoFocus
                  />
                  <div className="flex items-center justify-end gap-1.5">
                    <MessageAction
                      tooltip="添加附件"
                      onClick={() => { void handleSelectAttachments() }}
                    >
                      <Paperclip className="size-3.5" />
                    </MessageAction>
                    <MessageAction
                      tooltip="取消"
                      onClick={() => onCancelInlineEdit?.()}
                    >
                      <X className="size-3.5" />
                    </MessageAction>
                    <MessageAction
                      tooltip="发送"
                      onClick={() => {
                        if (!canSubmitInline || !onSubmitInlineEdit) return
                        const payload: InlineEditSubmitPayload = {
                          content: editingContent.trim(),
                          keepExistingAttachments: editableAttachments
                            .filter((item) => item.kind === 'existing')
                            .map((item) => item.attachment),
                          newAttachments: editableAttachments
                            .filter((item) => item.kind === 'new')
                            .map((item) => ({
                              filename: item.attachment.filename,
                              mediaType: item.attachment.mediaType,
                              size: item.attachment.size,
                              data: item.base64,
                            })),
                        }
                        void onSubmitInlineEdit(message, payload)
                      }}
                    >
                      <SendHorizontal className="size-3.5" />
                    </MessageAction>
                  </div>
                </div>
              ) : message.content && (
                <UserMessageContent>{message.content}</UserMessageContent>
              )}
            </>
          )}
        </MessageContent>

        {/* 操作按钮（非 streaming 时显示，hover 时可见） */}
        {(message.content || (message.attachments && message.attachments.length > 0)) && !isStreaming && !isInlineEditing && (
          <MessageActions className="pl-[46px] mt-0.5">
            <CopyButton content={message.content} />
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
                <PencilLine className="size-3.5" />
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
            {message.role === 'assistant' && message.stopped && (
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
}
