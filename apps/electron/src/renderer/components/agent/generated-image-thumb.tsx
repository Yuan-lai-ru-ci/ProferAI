/**
 * GeneratedImageThumb — Agent 图片产出缩略图
 *
 * 从 ContentBlock.tsx 与 tool-result-renderers/default-result.tsx 的重复实现抽取
 * （send_local_image 结构化附件、generate_image、旧版文本 marker 共用）。
 * 两处历史尺寸差异由 variant 保留：default 400×350（工具调用块），compact 300×250（工具结果块）。
 *
 * 右键菜单（复制/保存）与 Lightbox 复制按钮由 ChatImageContextMenu 体系提供。
 */

import * as React from 'react'
import { Download } from 'lucide-react'
import { ImageLightbox } from '@profer/ui/primitives/image-lightbox'
import {
  ChatImageContextMenu,
  useCopyChatImageAction,
} from '@/components/chat/chat-image-context-menu'
import type { ParsedAgentImageAttachment } from './image-attachment-marker'

export function GeneratedImageThumb({
  image,
  variant = 'default',
}: {
  image: ParsedAgentImageAttachment
  variant?: 'default' | 'compact'
}): React.ReactElement {
  const [imageSrc, setImageSrc] = React.useState<string | null>(null)
  const [lightboxOpen, setLightboxOpen] = React.useState(false)
  const copyImage = useCopyChatImageAction()

  React.useEffect(() => {
    window.electronAPI
      .readAttachment(image.localPath)
      .then((base64) => setImageSrc(`data:${image.mediaType};base64,${base64}`))
      .catch((err) => console.error('[GeneratedImage] 读取图片失败:', err))
  }, [image.localPath, image.mediaType])

  const handleSave = React.useCallback((): void => {
    window.electronAPI.saveImageAs(image.localPath, image.filename)
  }, [image.localPath, image.filename])

  const handleCopy = React.useCallback((): void => {
    void copyImage({ localPath: image.localPath })
  }, [copyImage, image.localPath])

  if (!imageSrc) {
    return (
      <div
        className={cnPlaceholder(variant)}
      />
    )
  }

  return (
    <ChatImageContextMenu localPath={image.localPath} onSave={handleSave}>
      <div className="relative group inline-block">
        <img
          src={imageSrc}
          alt={image.filename}
          className={cnImage(variant)}
          onClick={() => setLightboxOpen(true)}
        />
        <button
          type="button"
          onClick={handleSave}
          className="absolute bottom-2 right-2 p-1.5 rounded-md bg-black/50 text-white opacity-0 group-hover:opacity-100 transition-opacity hover:bg-black/70"
          title="保存图片"
        >
          <Download className="size-4" />
        </button>
        <ImageLightbox
          src={imageSrc}
          alt={image.filename}
          open={lightboxOpen}
          onOpenChange={setLightboxOpen}
          onSave={handleSave}
          onCopy={handleCopy}
        />
      </div>
    </ChatImageContextMenu>
  )
}

/** 两处历史尺寸：default 供工具调用块，compact 供工具结果块 */
function cnImage(variant: 'default' | 'compact'): string {
  return variant === 'compact'
    ? 'max-w-[300px] max-h-[250px] rounded-lg object-contain cursor-pointer border border-border/50'
    : 'max-w-[400px] max-h-[350px] rounded-lg object-contain cursor-pointer border border-border/50'
}

function cnPlaceholder(variant: 'default' | 'compact'): string {
  const size = variant === 'compact' ? 'max-w-[240px] h-[160px]' : 'max-w-[300px] h-[200px]'
  return `w-full ${size} rounded-lg bg-muted/30 animate-pulse shrink-0`
}
