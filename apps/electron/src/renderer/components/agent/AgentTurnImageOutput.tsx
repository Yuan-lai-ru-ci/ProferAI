/** 模型输出的图片：作为本轮回复的一等内容渲染，不挂在工具行或折叠过程里。 */
import * as React from 'react'
import { Download } from 'lucide-react'
import { ImageLightbox } from '@profer/ui/primitives/image-lightbox'
import {
  ChatImageContextMenu,
  useCopyChatImageAction,
} from '@/components/chat/chat-image-context-menu'
import type { ParsedAgentImageAttachment } from './image-attachment-marker'

function ImageOutputItem({ image }: { image: ParsedAgentImageAttachment }): React.ReactElement {
  const [imageSrc, setImageSrc] = React.useState<string | null>(null)
  const [loadFailed, setLoadFailed] = React.useState(false)
  const [lightboxOpen, setLightboxOpen] = React.useState(false)

  React.useEffect(() => {
    let active = true
    setImageSrc(null)
    setLoadFailed(false)
    window.electronAPI
      .readAttachment(image.localPath)
      .then((base64) => {
        if (active) setImageSrc(`data:${image.mediaType};base64,${base64}`)
      })
      .catch((err) => {
        console.error('[AgentImageOutput] 读取图片失败:', err)
        if (active) setLoadFailed(true)
      })
    return () => { active = false }
  }, [image.localPath, image.mediaType])

  const handleSave = React.useCallback((): void => {
    window.electronAPI.saveImageAs(image.localPath, image.filename)
  }, [image.localPath, image.filename])

  /** 复制图片到剪贴板（主进程 clipboard.writeImage） */
  const copyImage = useCopyChatImageAction()
  const handleCopy = React.useCallback((): void => {
    void copyImage({ localPath: image.localPath })
  }, [copyImage, image.localPath])

  if (loadFailed) {
    return (
      <div className="flex h-40 w-full max-w-[420px] items-center justify-center rounded-2xl bg-muted/30 px-4 text-center text-xs text-muted-foreground">
        图片已失效：{image.filename}
      </div>
    )
  }

  if (!imageSrc) {
    return <div className="h-52 w-full max-w-[420px] animate-pulse rounded-2xl bg-muted/30" />
  }

  return (
    <ChatImageContextMenu localPath={image.localPath} onSave={handleSave}>
      <figure className="group relative inline-flex max-w-[min(100%,560px)] flex-col">
        <img
          src={imageSrc}
          alt={image.filename}
          loading="lazy"
          decoding="async"
          className="max-h-[420px] w-auto max-w-full cursor-zoom-in rounded-2xl object-contain shadow-sm ring-1 ring-border/40"
          onClick={() => setLightboxOpen(true)}
        />
        <button
          type="button"
          onClick={handleSave}
          className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-lg bg-black/55 px-2 py-1 text-[11px] text-white opacity-0 backdrop-blur-sm transition-opacity hover:bg-black/70 focus-visible:opacity-100 group-hover:opacity-100"
          title={`保存图片：${image.filename}`}
        >
          <Download className="size-3.5" />
          保存
        </button>
        <figcaption className="mt-1.5 px-0.5 text-[11px] text-muted-foreground/70">
          {image.filename}
        </figcaption>
        <ImageLightbox
          src={imageSrc}
          alt={image.filename}
          open={lightboxOpen}
          onOpenChange={setLightboxOpen}
          onSave={handleSave}
          onCopy={handleCopy}
        />
      </figure>
    </ChatImageContextMenu>
  )
}

export function AgentTurnImageOutput({ images }: { images: ParsedAgentImageAttachment[] }): React.ReactElement | null {
  if (images.length === 0) return null
  return (
    <div className="my-3 flex flex-wrap items-start gap-3" data-agent-image-output>
      {images.map((image, index) => (
        <ImageOutputItem key={`${image.localPath}:${index}`} image={image} />
      ))}
    </div>
  )
}
