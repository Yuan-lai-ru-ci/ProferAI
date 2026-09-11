/**
 * ChatInput - 输入区域
 *
 * 完整输入体验，包含：
 * - RichTextInput (TipTap 编辑器) 替代原生 textarea
 * - 附件预览区域（pendingAttachments 缩略图列表）
 * - Footer 工具栏（左右分布）：
 *   左侧：Paperclip 附件按钮、ModelSelector、ThinkingButton、SpeechButton、ContextSettingsPopover、ClearContextButton
 *   右侧：Send/Stop 按钮
 * - 拖放文件支持（onDragOver/onDragLeave/onDrop）
 * - 监听 proma:clear-context 和 proma:focus-input 自定义事件
 * - 卡片式容器样式
 */

import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { CornerDownLeft, Square, Brain, Paperclip, Library, X } from 'lucide-react'
import type { KnowledgeReference } from '@profer/shared'
import { KnowledgeReferencePicker } from '@/components/knowledge-base/KnowledgeReferencePicker'
import { openKnowledgePreview } from '@/components/knowledge-base/KnowledgePreviewPanel'
import { ModelSelector } from './ModelSelector'
import { ClearContextButton } from './ClearContextButton'
import { ContextSettingsPopover } from './ContextSettingsPopover'
import { ToolSelectorPopover } from './ToolSelectorPopover'
import { AttachmentPreviewItem } from './AttachmentPreviewItem'
import { RichTextInput } from '@/components/ai-elements/rich-text-input'
import { SpeechButton, useLoadVoiceDictationSettings } from '@/components/ai-elements/speech-button'
import { voiceDictationEnabledAtom } from '@/atoms/voice-dictation-atoms'
import { InputToolbarOverflow, type ToolbarItem } from '@/components/ai-elements/InputToolbarOverflow'
import { AgentComposerToolTrigger } from '@/components/ai-elements/composer/ComposerTool'
import { getActiveAccelerator, getAcceleratorDisplay } from '@/lib/shortcut-registry'
import {
  conversationDraftsAtom,
} from '@/atoms/chat-atoms'
import type { PendingAttachment } from '@/atoms/chat-atoms'
import {
  useConversationModel,
  useConversationThinkingEnabled,
} from '@/hooks/useConversationSettings'
import { cn } from '@/lib/utils'
import { fileToBase64, formatFileNames } from '@/lib/file-utils'
import { MAX_ATTACHMENT_SIZE } from '@profer/shared'
import { sendWithCmdEnterAtom } from '@/atoms/shortcut-atoms'
import { toast } from 'sonner'
import { dedupPendingAgainst, formatDuplicateSummary } from './dedup-helpers'

interface ChatInputProps {
  /** 当前对话 ID */
  conversationId: string
  /** 是否正在流式生成 */
  streaming: boolean
  /** 待发送附件列表 */
  pendingAttachments: PendingAttachment[]
  /** 设置待发送附件 */
  onSetPendingAttachments: React.Dispatch<React.SetStateAction<PendingAttachment[]>>
  /** 当前待导入的资料引用 */
  pendingKnowledgeReferences?: KnowledgeReference[]
  /** 写入待导入资料引用 */
  onSetPendingKnowledgeReferences?: React.Dispatch<React.SetStateAction<KnowledgeReference[]>>
  /** 发送消息回调 */
  onSend: (content: string) => void
  /** 停止生成回调 */
  onStop: () => void
  /** 清除上下文回调 */
  onClearContext?: () => void
  /** 自定义占位文字 */
  placeholder?: string
}

export function ChatInput({ conversationId, streaming, pendingAttachments, onSetPendingAttachments, pendingKnowledgeReferences = [], onSetPendingKnowledgeReferences, onSend, onStop, onClearContext, placeholder }: ChatInputProps): React.ReactElement {
  const sendWithCmdEnter = useAtomValue(sendWithCmdEnterAtom)
  // 从 Map atom 读写草稿
  const draftsMap = useAtomValue(conversationDraftsAtom)
  const setDraftsMap = useSetAtom(conversationDraftsAtom)
  const content = draftsMap.get(conversationId) ?? ''
  const setContent = React.useCallback((value: string) => {
    setDraftsMap((prev) => {
      const map = new Map(prev)
      if (value.trim() === '') {
        map.delete(conversationId)
      } else {
        map.set(conversationId, value)
      }
      return map
    })
  }, [conversationId, setDraftsMap])

  const [selectedModel] = useConversationModel()
  const [thinkingEnabled, setThinkingEnabled] = useConversationThinkingEnabled()
  const setPendingAttachments = onSetPendingAttachments
  const [isDragOver, setIsDragOver] = React.useState(false)
  const [knowledgePickerOpen, setKnowledgePickerOpen] = React.useState(false)
  const stagedAttachmentDataRef = React.useRef(new Map<string, { base64: string; previewUrl?: string }>())

  // 异步准备附件时先暂存资源；只有真正进入 state 的附件才写入全局缓存。
  // 被判重/准备失败的候选会在这里回收，避免 base64 和 blob URL 成为孤儿资源。
  React.useEffect(() => {
    const currentIds = new Set(pendingAttachments.map((attachment) => attachment.id))
    for (const [id, staged] of stagedAttachmentDataRef.current) {
      if (currentIds.has(id)) {
        if (!window.__pendingAttachmentData) window.__pendingAttachmentData = new Map<string, string>()
        window.__pendingAttachmentData.set(id, staged.base64)
        stagedAttachmentDataRef.current.delete(id)
      } else {
        if (staged.previewUrl?.startsWith('blob:')) URL.revokeObjectURL(staged.previewUrl)
        stagedAttachmentDataRef.current.delete(id)
      }
    }
  }, [pendingAttachments])

  React.useEffect(() => () => {
    for (const staged of stagedAttachmentDataRef.current.values()) {
      if (staged.previewUrl?.startsWith('blob:')) URL.revokeObjectURL(staged.previewUrl)
    }
    stagedAttachmentDataRef.current.clear()
  }, [])

  const canSend = (content.trim().length > 0 || pendingAttachments.length > 0 || pendingKnowledgeReferences.length > 0) && selectedModel !== null && !streaming

  /**
   * 将文件列表添加为附件（race-free 去重）
   *
   * 设计要点（原 PR #122 review 反馈）：
   * 不能先读 pendingAttachments 闭包快照判重，再异步写——快速重复拖入或两入口
   * 并发时两次调用读到同一旧快照，会重复入 atom。
   *
   * 修法：把判重与写入都放进 setPendingAttachments(prev => ...) 的 prev 回调内，
   * 由 React/Jotai 序列化执行 prev 回调，每次回调拿到的 prev 都是链上最新值，
   * 从根上消除"读陈旧快照"的竞态。判重逻辑复用 dedup-helpers 的纯函数。
   */
  const addFilesAsAttachments = React.useCallback(async (files: File[]): Promise<void> => {
    const oversized: string[] = []
    const okFiles: File[] = []

    for (const file of files) {
      if (file.size > MAX_ATTACHMENT_SIZE) {
        oversized.push(file.name)
      } else {
        okFiles.push(file)
      }
    }

    if (oversized.length > 0) {
      toast.error(`以下文件超过 100MB，Chat 附件暂不支持，已跳过：${formatFileNames(oversized)}`)
    }

    if (okFiles.length === 0) return

    // 并行准备所有 base64 + PendingAttachment（异步仍不可避免，但仅此处有 race）
    // 下面是 catch + map forEach 收集成功的 Attachment，失败的文件静默忽略（沿袭旧行为）
    const prepared = (
      await Promise.all(
        okFiles.map(async (file): Promise<{ name: string; size: number; attachment: PendingAttachment } | null> => {
          try {
            const base64 = await fileToBase64(file)

            // 创建 blob URL 仅用于图片本地预览
            const previewUrl = file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined

            const pendingAttachment: PendingAttachment = {
              id: `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`,
              filename: file.name,
              mediaType: file.type || 'application/octet-stream',
              localPath: '', // 发送时填充
              size: file.size,
              previewUrl,
            }

            stagedAttachmentDataRef.current.set(pendingAttachment.id, { base64, previewUrl })

            return { name: file.name, size: file.size, attachment: pendingAttachment }
          } catch (error) {
            console.error('[ChatInput] 添加附件失败:', error)
            return null
          }
        })
      )
    ).filter((item): item is { name: string; size: number; attachment: PendingAttachment } => item !== null)

    if (prepared.length === 0) return

    const candidates = prepared.map((p) => ({ fileLike: { name: p.name, size: p.size }, item: p.attachment }))
    // Toast 是事件副作用，不能放进可能被 React 重放的 state updater。
    // 判重写入仍在 updater 内完成；这里的提示基于当前快照，重复候选即使并发时
    // 被 updater 再次过滤，也只会少提示而不会重复入 atom。
    const duplicateSummary = formatDuplicateSummary(dedupPendingAgainst(pendingAttachments, candidates).duplicateNames)
    if (duplicateSummary) toast.info(`已跳过重复文件：${duplicateSummary}`, { id: 'chat-attach-skip-dup' })

    setPendingAttachments((prev) => {
      const result = dedupPendingAgainst(prev, candidates)
      return result.accepted.length > 0 ? [...prev, ...result.accepted] : prev
    })
  }, [pendingAttachments, setPendingAttachments])

  /** 通过 IPC 打开文件选择对话框（race-free 去重） */
  const handleOpenFileDialog = React.useCallback(async (): Promise<void> => {
    try {
      const result = await window.electronAPI.openFileDialog()
      const largeFiles = result.largeFiles ?? []
      const skippedFiles = result.skippedFiles ?? []
      if (result.files.length === 0 && largeFiles.length === 0 && skippedFiles.length === 0) return

      if (largeFiles.length > 0) {
        toast.error(`以下文件超过 100MB，Chat 附件暂不支持，已跳过：${formatFileNames(largeFiles.map((f) => f.filename))}`)
      }
      if (skippedFiles.length > 0) {
        toast.warning(`以下文件无法读取，已跳过：${formatFileNames(skippedFiles.map((f) => f.filename))}`)
      }

      // 构建候选（包含 oversized 冗余检查，防御 IPC 未来不再预分大文件）
      const oversized: string[] = []
      const candidates: Array<{ name: string; size: number; attachment: PendingAttachment }> = []

      for (const fileInfo of result.files) {
        if (fileInfo.size > MAX_ATTACHMENT_SIZE) {
          oversized.push(fileInfo.filename)
          continue
        }

        const previewUrl = fileInfo.mediaType.startsWith('image/')
          ? `data:${fileInfo.mediaType};base64,${fileInfo.data}`
          : undefined

        const pendingAttachment: PendingAttachment = {
          id: `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          filename: fileInfo.filename,
          mediaType: fileInfo.mediaType,
          localPath: '',
          size: fileInfo.size,
          previewUrl,
        }

        stagedAttachmentDataRef.current.set(pendingAttachment.id, { base64: fileInfo.data })
        candidates.push({ name: fileInfo.filename, size: fileInfo.size, attachment: pendingAttachment })
      }

      if (oversized.length > 0) {
        toast.error(`以下文件超过 100MB，Chat 附件暂不支持，已跳过：${formatFileNames(oversized)}`)
      }

      if (candidates.length === 0) return

      const candidateItems = candidates.map((c) => ({ fileLike: { name: c.name, size: c.size }, item: c.attachment }))
      const duplicateSummary = formatDuplicateSummary(dedupPendingAgainst(pendingAttachments, candidateItems).duplicateNames)
      if (duplicateSummary) toast.info(`已跳过重复文件：${duplicateSummary}`, { id: 'chat-attach-skip-dup' })

      // 原子判重 + 写入：复用同一 dedup helper，与 addFilesAsAttachments 走同一条 race-free 路径
      setPendingAttachments((prev) => {
        const result = dedupPendingAgainst(prev, candidateItems)
        return result.accepted.length > 0 ? [...prev, ...result.accepted] : prev
      })
    } catch (error) {
      console.error('[ChatInput] 文件选择对话框失败:', error)
    }
  }, [pendingAttachments, setPendingAttachments])

  /** 移除待发送附件 */
  const handleRemoveAttachment = React.useCallback((id: string): void => {
    setPendingAttachments((prev) => {
      const attachment = prev.find((a) => a.id === id)
      // 回收 blob URL
      if (attachment?.previewUrl?.startsWith('blob:')) {
        URL.revokeObjectURL(attachment.previewUrl)
      }
      // 清理临时 base64 缓存
      window.__pendingAttachmentData?.delete(id)
      return prev.filter((a) => a.id !== id)
    })
  }, [setPendingAttachments])

  /** 发送消息 */
  const handleSend = React.useCallback((): void => {
    if (!canSend) return
    onSend(content.trim())
    setContent('')
    // 附件清理由 ChatView 的 handleSend 负责
  }, [canSend, content, onSend])

  /** 粘贴文件回调 */
  const handlePasteFiles = React.useCallback((files: File[]): void => {
    addFilesAsAttachments(files)
  }, [addFilesAsAttachments])

  // 拖放处理
  const handleDragOver = React.useCallback((e: React.DragEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(true)
  }, [])

  const handleDragLeave = React.useCallback((e: React.DragEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
  }, [])

  const handleDrop = React.useCallback((e: React.DragEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)

    const files = Array.from(e.dataTransfer.files)
    if (files.length === 0) return


    addFilesAsAttachments(files)
  }, [addFilesAsAttachments])

  // 监听快捷键系统分发的 clear-context 事件（Cmd+K）
  React.useEffect(() => {
    const handler = (): void => {
      onClearContext?.()
    }
    window.addEventListener('profer:clear-context', handler)
    return () => window.removeEventListener('profer:clear-context', handler)
  }, [onClearContext])

  // 监听快捷键系统分发的 focus-input 事件（Cmd+L）
  React.useEffect(() => {
    const handler = (): void => {
      // 聚焦 TipTap 编辑器：查找 Chat 输入框内的 ProseMirror 元素
      const proseMirror = document.querySelector('[data-input-mode="chat"] .ProseMirror') as HTMLElement | null
      proseMirror?.focus()
    }
    window.addEventListener('profer:focus-input', handler)
    return () => window.removeEventListener('profer:focus-input', handler)
  }, [])

  const voiceDictationEnabled = useAtomValue(voiceDictationEnabledAtom)
  useLoadVoiceDictationSettings()
  const toolbarItems = React.useMemo<ToolbarItem[]>(() => [
    // 模型选择是 Chat 的一级动作，固定放在最左侧；窄窗口时也优先保留。
    { key: 'model', node: <ModelSelector composerTool /> },
    // 资料库入口已暂时关闭，恢复时取消下面注释即可
    /*
    {
      key: 'knowledge-library',
      node: <Tooltip><TooltipTrigger asChild><Button type="button" variant="ghost" size="icon" className="size-[36px] shrink-0 rounded-full text-primary hover:bg-primary/10 hover:text-primary" onClick={() => setKnowledgePickerOpen(true)}><Library className="size-5"/></Button></TooltipTrigger><TooltipContent side="top"><p>从资料库导入</p></TooltipContent></Tooltip>,
    },
    */
    {
      key: 'attach',
      node: (
        <AgentComposerToolTrigger label="添加附件" tooltip="添加附件" onClick={handleOpenFileDialog}>
          <Paperclip className="size-5" />
        </AgentComposerToolTrigger>
      ),
    },
    {
      key: 'thinking',
      node: (
        <AgentComposerToolTrigger
          label={thinkingEnabled ? '关闭思考模式' : '开启思考模式'}
          tooltip={thinkingEnabled ? '关闭思考模式' : '开启思考模式'}
          state={thinkingEnabled ? 'active' : 'default'}
          onClick={() => setThinkingEnabled(!thinkingEnabled)}
        >
          <Brain className="size-5" />
        </AgentComposerToolTrigger>
      ),
    },
    ...(voiceDictationEnabled ? [{ key: 'speech', node: <SpeechButton composerTool /> }] : []),
    { key: 'tools', node: <ToolSelectorPopover composerTool /> },
    { key: 'context', node: <ContextSettingsPopover composerTool /> },
    { key: 'clear', node: <ClearContextButton composerTool onClick={onClearContext} /> },
  ], [handleOpenFileDialog, thinkingEnabled, setThinkingEnabled, onClearContext, voiceDictationEnabled])

  const trailingNode = streaming ? (
    <AgentComposerToolTrigger
      label="停止生成"
      tooltip={`停止生成 (${getAcceleratorDisplay(getActiveAccelerator('stop-generation'))})`}
      state="destructive"
      onClick={onStop}
    >
      <Square className="size-[16px]" fill="currentColor" strokeWidth={0} />
    </AgentComposerToolTrigger>
  ) : (
    <AgentComposerToolTrigger
      label="发送消息"
      tooltip="发送消息"
      state={canSend ? 'active' : 'muted'}
      onClick={handleSend}
      disabled={!canSend}
    >
      <CornerDownLeft className="size-[22px]" />
    </AgentComposerToolTrigger>
  )

  return (
    <div className="px-2.5 pb-2.5 md:px-[18px] md:pb-[18px]" data-input-mode="chat">
        {/* 卡片式输入容器 — 对标 Cherry Studio: border-radius 17px, 0.5px border */}
        <div
          className={cn(
            'agent-input-surface rounded-[17px] border-[0.5px] border-surface-border bg-input/70 backdrop-blur-sm transition-all duration-200',
            'focus-within:border-focus/40 focus-within:ring-2 focus-within:ring-focus/10',
            isDragOver && 'border-[2px] border-dashed border-[#2ecc71] bg-[#2ecc71]/[0.03]'
          )}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {/* 附件预览区域 — Cherry Studio: padding 5px 15px, flex-wrap, gap 4px */}
          {(pendingAttachments.length > 0 || pendingKnowledgeReferences.length > 0) && (
            <div className="flex flex-wrap gap-1 px-[15px] pt-[10px] pb-[15px]">
              {pendingKnowledgeReferences.map((reference) => <span key={reference.itemId} className="inline-flex h-8 max-w-[260px] items-center gap-1 rounded border border-primary/20 bg-primary/5 px-2 text-xs text-primary"><button type="button" onClick={() => openKnowledgePreview(reference)} className="inline-flex min-w-0 items-center gap-1 hover:underline"><Library className="size-3.5 shrink-0"/><span className="truncate">{reference.title}</span></button><button type="button" aria-label={`移除资料 ${reference.title}`} onClick={() => onSetPendingKnowledgeReferences?.((items) => items.filter((item) => item.itemId !== reference.itemId))}><X className="size-3.5"/></button></span>)}
              {pendingAttachments.map((att) => (
                <AttachmentPreviewItem
                  key={att.id}
                  filename={att.filename}
                  mediaType={att.mediaType}
                  previewUrl={att.previewUrl}
                  onRemove={() => handleRemoveAttachment(att.id)}
                />
              ))}
            </div>
          )}

          {/* TipTap 富文本编辑器 */}
          <RichTextInput
            value={content}
            onChange={setContent}
            onSubmit={handleSend}
            onPasteFiles={handlePasteFiles}
            placeholder={placeholder ?? (sendWithCmdEnter ? '输入消息... (⌘/Ctrl+Enter 发送，Enter 换行)' : '输入消息... (Enter 发送，Shift+Enter 换行)')}
            autoFocusTrigger={conversationId}
            sendWithCmdEnter={sendWithCmdEnter}
          />

          {/* Footer 工具栏 — 容器变窄时尾部按钮自动折叠进「更多」Popover */}
          <InputToolbarOverflow items={toolbarItems} trailing={trailingNode} />
        </div>

        <KnowledgeReferencePicker open={knowledgePickerOpen} onOpenChange={setKnowledgePickerOpen} onConfirm={async (itemIds) => {
          const snapshot = await window.electronAPI.knowledge.listItems()
          const itemsById = new Map(snapshot.map((item) => [item.id, item]))
          const additions = itemIds.map((itemId) => {
            const item = itemsById.get(itemId)
            return item ? { itemId: item.id, title: item.title, kind: item.kind, origin: item.origin, importedAt: Date.now() } : null
          }).filter((item): item is KnowledgeReference => item !== null)
          onSetPendingKnowledgeReferences?.((current) => [...new Map([...current, ...additions].map((item) => [item.itemId, item])).values()].slice(0, 10))
        }} />

    </div>
  )
}
