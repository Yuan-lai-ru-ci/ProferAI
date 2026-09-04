/**
 * ImageLightbox - 图片预览弹窗
 *
 * 类似 macOS Quick Look 的全屏图片预览效果：
 * - 点击图片打开，点击遮罩层或按 Esc 关闭
 * - 深色半透明背景 + 居中大图
 * - 支持下载按钮
 */

import * as React from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { Download, X } from 'lucide-react'
import { cn } from '@/lib/utils'

const MIN_ZOOM = 0.5
const MAX_ZOOM = 3
const ZOOM_STEP = 1.1

interface ImageLightboxProps {
  /** 图片 src（data URL 或普通 URL） */
  src: string | null
  /** 图片 alt / 文件名 */
  alt?: string
  /** 是否打开 */
  open: boolean
  /** 关闭回调 */
  onOpenChange: (open: boolean) => void
  /** 下载回调（可选） */
  onSave?: () => void
}

export function ImageLightbox({
  src,
  alt,
  open,
  onOpenChange,
  onSave,
}: ImageLightboxProps): React.ReactElement | null {
  const [zoom, setZoom] = React.useState(1)
  const imageRef = React.useRef<HTMLImageElement>(null)

  React.useEffect(() => {
    setZoom(1)
  }, [open, src])

  // React 的 wheel 合成事件在部分 Electron 环境可能是 passive，改用原生监听器以可靠阻止默认滚动。
  React.useEffect(() => {
    const image = imageRef.current
    if (!image || !open) return

    const handleWheel = (event: WheelEvent): void => {
      event.preventDefault()
      setZoom((currentZoom) => {
        const nextZoom = currentZoom * (event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP)
        return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, nextZoom))
      })
    }

    image.addEventListener('wheel', handleWheel, { passive: false })
    return () => image.removeEventListener('wheel', handleWheel)
  }, [open, src])

  if (!src) return null

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        {/* 遮罩层 — 点击关闭。图片预览语义不同于普通弹窗：背景需要"消失"让图片成为焦点，
         * 所以 80% 深 + md blur，对比 Dialog 的 40% sm blur 更强烈。
         */}
        <DialogPrimitive.Overlay
          className={cn(
            'fixed inset-0 z-[200] bg-black/80 backdrop-blur-md titlebar-no-drag',
            'data-[state=open]:animate-in data-[state=closed]:animate-out',
            'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0'
          )}
        />
        {/* 内容层 */}
        <DialogPrimitive.Content
          data-browser-blocking
          className={cn(
            'fixed inset-0 z-[200] flex items-center justify-center titlebar-no-drag',
            'data-[state=open]:animate-in data-[state=closed]:animate-out',
            'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
            'data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
            'duration-200'
          )}
          /* 点击背景区域（非图片）关闭 */
          onClick={(e) => {
            if (e.target === e.currentTarget) onOpenChange(false)
          }}
        >
          {/* 隐藏的标题（无障碍） */}
          <DialogPrimitive.Title className="sr-only">
            {alt || '图片预览'}
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            预览图片：{alt || '图片'}
          </DialogPrimitive.Description>

          {/* 大图：指针位于图片上时，滚轮缩放，不影响弹窗空白区域。 */}
          <img
            src={src}
            alt={alt}
            className="max-w-[90vw] max-h-[90vh] rounded-lg object-contain shadow-2xl select-none cursor-zoom-in"
            ref={imageRef}
            style={{ transform: `scale(${zoom})` }}
            draggable={false}
            title="在图片上滚动滚轮可缩放"
          />

          {/* 右上角关闭按钮 */}
          <DialogPrimitive.Close
            className={cn(
              'absolute top-4 right-4 p-2 rounded-full',
              'bg-black/50 text-white/80 backdrop-blur-sm',
              'hover:bg-black/70 hover:text-white transition-colors',
              'focus:outline-none'
            )}
          >
            <X className="size-5" />
          </DialogPrimitive.Close>

          {/* 底部下载按钮（可选） */}
          {onSave && (
            <button
              type="button"
              onClick={onSave}
              className={cn(
                'absolute bottom-6 right-6 p-2.5 rounded-full',
                'bg-black/50 text-white/80 backdrop-blur-sm',
                'hover:bg-black/70 hover:text-white transition-colors'
              )}
              title="保存图片"
            >
              <Download className="size-5" />
            </button>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
