/**
 * AttachmentPreviewItem - 附件预览卡片
 *
 * 对标 Cherry Studio 的 AttachmentPreview 风格：
 * - 图片：紧凑缩略图 + 圆角
 * - 非图片：teal 色标签 + 文件名截断
 * - hover 显示关闭按钮
 */

import * as React from 'react'
import { X, Paperclip } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ImageLightbox } from '@profer/ui/primitives/image-lightbox'
import { Tooltip, TooltipTrigger, TooltipContent } from '@profer/ui/primitives/tooltip'
import { ChatImageContextMenu, useCopyChatImageAction } from './chat-image-context-menu'

interface AttachmentPreviewItemProps {
  /** 原始文件名 */
  filename: string
  /** MIME 类型 */
  mediaType: string
  /** 本地预览 URL（blob URL / data URL，图片用） */
  previewUrl?: string
  /** 删除回调 */
  onRemove: () => void
  /** 点击回调（用于打开文件预览等） */
  onClick?: () => void
  className?: string
}

/** 判断是否为图片类型 */
function isImage(mediaType: string): boolean {
  return mediaType.startsWith('image/')
}

export function AttachmentPreviewItem({
  filename,
  mediaType,
  previewUrl,
  onRemove,
  onClick,
  className,
}: AttachmentPreviewItemProps): React.ReactElement {
  const [lightboxOpen, setLightboxOpen] = React.useState(false)
  const copyImage = useCopyChatImageAction()
  const handleCopy = React.useCallback((): void => {
    if (previewUrl) void copyImage({ src: previewUrl })
  }, [copyImage, previewUrl])
  const handleRemoveClick = React.useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    onRemove()
  }, [onRemove])
  const handleRemoveKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLButtonElement>) => {
    event.stopPropagation()
  }, [])

  if (isImage(mediaType) && previewUrl) {
    // 图片预览 — 紧凑缩略图，点击可预览大图；右键复制（待发送附件尚未落盘，走预览 URL）
    return (
      <ChatImageContextMenu src={previewUrl}>
        <div
          className={cn(
            'group/attachment relative size-[72px] shrink-0 rounded-lg overflow-hidden',
            className
          )}
        >
          <img
            src={previewUrl}
            alt={filename}
            className="size-full object-cover cursor-pointer"
            onClick={() => setLightboxOpen(true)}
          />
          {/* hover 关闭按钮 */}
          <button
            type="button"
            onClick={handleRemoveClick}
            onKeyDown={handleRemoveKeyDown}
            className={cn(
              'absolute top-1 right-1 size-[18px] rounded-full',
              'bg-black/50 text-white backdrop-blur-sm',
              'flex items-center justify-center',
              'opacity-0 group-hover/attachment:opacity-100 transition-opacity duration-200',
              'hover:bg-black/70'
            )}
          >
            <X className="size-3" />
          </button>
          <ImageLightbox
            src={previewUrl}
            alt={filename}
            open={lightboxOpen}
            onOpenChange={setLightboxOpen}
            onCopy={handleCopy}
          />
        </div>
      </ChatImageContextMenu>
    )
  }

  // 文件预览 — teal 标签样式（对标 Cherry Studio）
  // hover 时 Tooltip 显示完整文件名：CSS truncate 仅做视觉截断，Tooltip 让用户可查看全名。
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className={cn(
            'group/attachment relative flex items-center gap-2 shrink-0',
            'rounded-lg bg-[#37a5aa]/10 border border-[#37a5aa]/20',
            'pl-2.5 pr-7 py-1.5 text-[13px] text-[#37a5aa]',
            'transition-colors hover:bg-[#37a5aa]/15',
            onClick && 'cursor-pointer',
            className
          )}
          onClick={onClick}
          role={onClick ? 'button' : undefined}
          tabIndex={onClick ? 0 : undefined}
          onKeyDown={onClick ? (e: React.KeyboardEvent) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              onClick()
            }
          } : undefined}
        >
          <Paperclip className="size-4 shrink-0" />
          <span className="max-w-[200px] truncate">{filename}</span>
          {/* 关闭按钮 */}
          <button
            type="button"
            onClick={handleRemoveClick}
            onKeyDown={handleRemoveKeyDown}
            className={cn(
              'absolute top-1/2 right-1.5 -translate-y-1/2 size-[18px] rounded-full',
              'flex items-center justify-center',
              'text-[#37a5aa]/60 hover:text-[#37a5aa] hover:bg-[#37a5aa]/20',
              'opacity-0 group-hover/attachment:opacity-100 transition-all duration-200'
            )}
          >
            <X className="size-3" />
          </button>
        </div>
      </TooltipTrigger>
      <TooltipContent side="top">
        <p className="max-w-xs break-all">{filename}</p>
      </TooltipContent>
    </Tooltip>
  )
}
