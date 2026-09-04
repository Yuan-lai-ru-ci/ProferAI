import {
  AGENT_PREVIEW_LIMITS,
  type AgentFilePreviewInspectRequest,
  type AgentFilePreviewInspectResult,
} from '@profer/shared'
import { getRenderedPptxSlideCanvas, type OfficeViewerHandle } from './silurus-bridge'

interface RegisteredPreview {
  filePath: string
  revision: string
  viewer: OfficeViewerHandle
  host: HTMLElement
  getCurrentSlide: () => number
}

const sessions = new Map<string, RegisteredPreview>()

export function registerOfficialPptxPreview(sessionId: string, preview: RegisteredPreview): () => void {
  sessions.set(sessionId, preview)
  return () => {
    if (sessions.get(sessionId) === preview) sessions.delete(sessionId)
  }
}

function nextFrames(count = 2): Promise<void> {
  return new Promise((resolve) => {
    const tick = (): void => {
      if (count-- <= 0) resolve()
      else requestAnimationFrame(tick)
    }
    tick()
  })
}

function canvasHasVisualContent(canvas: HTMLCanvasElement): boolean {
  const sampleWidth = Math.min(64, canvas.width)
  const sampleHeight = Math.min(36, canvas.height)
  const sample = document.createElement('canvas')
  sample.width = sampleWidth
  sample.height = sampleHeight
  const sampleContext = sample.getContext('2d')
  if (!sampleContext) return false
  // 即使源画布使用 bitmaprenderer，仍可作为 drawImage 的 CanvasImageSource 采样。
  sampleContext.drawImage(canvas, 0, 0, sampleWidth, sampleHeight)
  const pixels = sampleContext.getImageData(0, 0, sampleWidth, sampleHeight).data
  let min = 255
  let max = 0
  for (let index = 0; index < pixels.length; index += 4) {
    const luminance = (pixels[index]! + pixels[index + 1]! + pixels[index + 2]!) / 3
    min = Math.min(min, luminance)
    max = Math.max(max, luminance)
  }
  return max - min >= 2
}

async function waitForRenderedCanvas(preview: RegisteredPreview, page: number): Promise<HTMLCanvasElement> {
  const deadline = performance.now() + 3_000
  while (performance.now() < deadline) {
    await nextFrames(2)
    const canvas = getRenderedPptxSlideCanvas(preview.viewer, page - 1)
    if (canvas && canvasHasVisualContent(canvas)) return canvas
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`正式 PPTX 预览第 ${page} 页未在 3 秒内产生有效像素，拒绝返回空白图`)
}

async function capturePage(preview: RegisteredPreview, page: number): Promise<string> {
  preview.viewer.scrollToSlide?.(page - 1, { behavior: 'auto' })
  const canvas = await waitForRenderedCanvas(preview, page)
  return canvas.toDataURL('image/png').replace(/^data:image\/png;base64,/, '')
}

export async function inspectOfficialPptxPreview(request: AgentFilePreviewInspectRequest): Promise<AgentFilePreviewInspectResult> {
  const preview = sessions.get(request.sessionId)
  if (!preview) throw new Error('当前会话没有 ready 的用户可见 PPTX 正式预览')
  if (preview.filePath !== request.filePath) throw new Error('当前正式预览打开的不是请求文件')
  if (preview.revision !== request.revision) throw new Error('当前正式预览 revision 已过期，请重新调用 open_file_preview')
  const slideCount = preview.viewer.slideCount ?? 0
  if (slideCount < 1) throw new Error('正式 PPTX 预览未报告有效页数')
  if (slideCount > AGENT_PREVIEW_LIMITS.maxPages && request.scope === 'all') {
    throw new Error(`PPTX 共 ${slideCount} 页，超过单次全部观察上限 ${AGENT_PREVIEW_LIMITS.maxPages} 页；请改用 overview 或 page。`)
  }
  if (request.scope === 'page' && (!request.page || request.page > slideCount)) throw new Error(`请求页码超出范围：${request.page ?? 0}/${slideCount}`)

  const originalSlide = Math.max(1, Math.min(slideCount, preview.getCurrentSlide()))
  const originalScale = preview.viewer.getScale?.()
  const pages = request.scope === 'page'
    ? [request.page!]
    : request.scope === 'overview'
      ? [...new Set([1, Math.ceil(slideCount / 2), slideCount])]
      : Array.from({ length: slideCount }, (_, index) => index + 1)
  const images: AgentFilePreviewInspectResult['images'] = []
  let payloadBytes = 0
  try {
    for (const page of pages) {
      const data = await capturePage(preview, page)
      payloadBytes += Math.floor(data.length * 0.75)
      if (payloadBytes > AGENT_PREVIEW_LIMITS.maxPayloadBytes) {
        throw new Error(`正式 PPTX 预览图像载荷超过 ${AGENT_PREVIEW_LIMITS.maxPayloadBytes} 字节上限，请缩小观察范围。`)
      }
      images.push({ page, data, mediaType: 'image/png' })
    }
    if (images.length > 1 && new Set(images.map((image) => image.data)).size === 1) {
      throw new Error('正式 PPTX 预览返回的多页图像完全相同，拒绝作为视觉评价依据')
    }
    return {
      requestId: request.requestId,
      sessionId: request.sessionId,
      filePath: request.filePath,
      revision: request.revision,
      slideCount,
      currentSlide: originalSlide,
      scale: originalScale,
      images,
    }
  } finally {
    if (typeof originalScale === 'number') preview.viewer.setScale?.(originalScale)
    preview.viewer.scrollToSlide?.(originalSlide - 1, { behavior: 'auto' })
  }
}
