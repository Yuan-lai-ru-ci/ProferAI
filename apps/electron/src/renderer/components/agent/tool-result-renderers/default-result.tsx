/**
 * 默认工具结果渲染器 — Key-Value 表格 / 纯文本
 *
 * 用于未匹配到专属渲染器的工具（包括 MCP 工具）
 */

import * as React from 'react'
import { Download } from 'lucide-react'
import { ImageLightbox } from '@/components/ui/image-lightbox'
import { CollapsibleResult } from './collapsible-result'

interface DefaultResultRendererProps {
  result: string
  isError: boolean
}

/** 尝试将结果解析为 key-value 对 */
function tryParseKeyValue(text: string): Array<{ key: string; value: string }> | null {
  // 尝试 JSON 解析
  try {
    const parsed = JSON.parse(text)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return Object.entries(parsed as Record<string, unknown>).map(([key, value]) => ({
        key,
        value: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
      }))
    }
  } catch {
    // 非 JSON
  }
  return null
}

/** 从文本中提取 PROMA_IMAGE_ATTACHMENT 标记 */
function parseGeneratedImages(text: string): { images: Array<{ localPath: string; filename: string; mediaType: string }>; cleanText: string } {
  const markerRegex = /\[PROMA_IMAGE_ATTACHMENT:(.+?)\]/g
  const images: Array<{ localPath: string; filename: string; mediaType: string }> = []
  let match: RegExpExecArray | null
  while ((match = markerRegex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1]!)
      if (parsed.localPath && parsed.filename) {
        images.push(parsed)
      }
    } catch { /* 忽略 */ }
  }
  const cleanText = text.replace(markerRegex, '').replace(/\n{3,}/g, '\n\n').trim()
  return { images, cleanText }
}

/** 生成图片缩略图 */
function GeneratedImageThumb({ image }: { image: { localPath: string; filename: string; mediaType: string } }): React.ReactElement {
  const [imageSrc, setImageSrc] = React.useState<string | null>(null)
  const [lightboxOpen, setLightboxOpen] = React.useState(false)

  React.useEffect(() => {
    window.electronAPI
      .readAttachment(image.localPath)
      .then((base64) => setImageSrc(`data:${image.mediaType};base64,${base64}`))
      .catch((err) => console.error('[DefaultResult] 读取图片失败:', err))
  }, [image.localPath, image.mediaType])

  const handleSave = React.useCallback((): void => {
    window.electronAPI.saveImageAs(image.localPath, image.filename)
  }, [image.localPath, image.filename])

  if (!imageSrc) {
    return <div className="w-full max-w-[240px] h-[160px] rounded-lg bg-muted/30 animate-pulse shrink-0" />
  }

  return (
    <div className="relative group inline-block">
      <img
        src={imageSrc}
        alt={image.filename}
        className="max-w-[300px] max-h-[250px] rounded-lg object-contain cursor-pointer border border-border/50"
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
      />
    </div>
  )
}

export function DefaultResultRenderer({ result, isError }: DefaultResultRendererProps): React.ReactElement {
  if (isError) {
    return (
      <pre className="rounded-md p-3 text-[12px] font-mono text-destructive/80 bg-destructive/5 whitespace-pre-wrap break-all overflow-x-auto">
        {result}
      </pre>
    )
  }

  // 解析生成图片标记（MCP 生图工具）
  const { images, cleanText } = React.useMemo(() => parseGeneratedImages(result), [result])

  // 纯文本 fallback
  if (images.length === 0) {
    const keyValues = tryParseKeyValue(cleanText)

    if (keyValues && keyValues.length > 0) {
      return (
        <div className="rounded-md bg-muted/20 overflow-hidden">
          <table className="w-full text-[12px]">
            <tbody>
              {keyValues.map(({ key, value }, i) => (
                <tr key={i} className="border-b border-border/20 last:border-b-0">
                  <td className="px-3 py-1.5 text-muted-foreground/60 font-mono whitespace-nowrap align-top">
                    {key}
                  </td>
                  <td className="px-3 py-1.5 text-foreground/70 font-mono whitespace-pre-wrap break-all">
                    {value}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    }

    return (
      <CollapsibleResult
        content={cleanText}
        renderContent={(text) => (
          <pre className="rounded-md p-3 text-[12px] font-mono text-foreground/60 bg-muted/30 whitespace-pre-wrap break-all overflow-x-auto max-h-[400px] overflow-y-auto">
            {text}
          </pre>
        )}
      />
    )
  }

  // 有图片时：先渲染图片缩略图，再渲染剩余文本
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-3">
        {images.map((img, i) => (
          <GeneratedImageThumb key={`${img.localPath}:${i}`} image={img} />
        ))}
      </div>
      {cleanText && (
        <CollapsibleResult
          content={cleanText}
          renderContent={(text) => (
            <pre className="rounded-md p-3 text-[12px] font-mono text-foreground/60 bg-muted/30 whitespace-pre-wrap break-all overflow-x-auto max-h-[400px] overflow-y-auto">
              {text}
            </pre>
          )}
        />
      )}
    </div>
  )
}
