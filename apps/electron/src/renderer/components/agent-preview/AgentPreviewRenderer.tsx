/** 隐藏 Agent 预览窗口的 renderer 入口；只接受主进程签发的受控 profer-file 资源。 */
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { AGENT_PREVIEW_LIMITS, type AgentPreviewImage, type AgentPreviewRenderTask } from '@profer/shared'
import { createOfficeViewer, destroyOfficeViewer, normalizeOfficeFormat, type OfficeViewerHandle } from '@/components/file-browser/office-preview/silurus-bridge'
import { markdownToHtml } from '@/lib/markdown-rich-text'

const MAX_OVERVIEW_PAGES = 12
const nextPaint = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
const settleViewer = async (): Promise<void> => {
  await nextPaint()
  await new Promise((resolve) => setTimeout(resolve, 140))
  await nextPaint()
}

interface RenderedPreview {
  viewer: OfficeViewerHandle | null
  pageCount: number
  navigate?: (page: number) => Promise<void>
}

function PreviewCanvas({ task, onRendered, onFailure }: {
  task: AgentPreviewRenderTask
  onRendered: (preview: RenderedPreview) => void
  onFailure: (error: unknown) => void
}): React.ReactElement {
  const hostRef = React.useRef<HTMLDivElement>(null)
  const viewerRef = React.useRef<OfficeViewerHandle | null>(null)
  const format = normalizeOfficeFormat(task.fileName)

  React.useEffect(() => {
    let cancelled = false
    const host = hostRef.current
    if (!host) return
    const run = async (): Promise<void> => {
      try {
        if (format) {
          const viewer = await createOfficeViewer(format, host, task.sourceUrl)
          if (cancelled) { destroyOfficeViewer(viewer); return }
          viewerRef.current = viewer
          viewer.fitPage?.()
          await settleViewer()
          if (!cancelled) onRendered({ viewer, pageCount: viewer.slideCount ?? viewer.pageCount ?? viewer.sheetCount ?? 1 })
          return
        }
        if (task.kind === 'markdown') {
          host.innerHTML = markdownToHtml(task.text ?? '')
        } else if (task.kind === 'image') {
          const image = document.createElement('img')
          image.src = task.sourceUrl
          image.alt = ''
          image.style.cssText = 'display:block;max-width:100%;max-height:852px;margin:auto;object-fit:contain;'
          host.replaceChildren(image)
          await new Promise<void>((resolve, reject) => {
            image.addEventListener('load', () => resolve(), { once: true })
            image.addEventListener('error', () => reject(new Error('图片加载失败')), { once: true })
          })
        } else {
          // HTML/PDF 的 URL 只能是主进程签发的 opaque profer-file URL；iframe 不获得 Electron API。
          const iframe = document.createElement('iframe')
          iframe.src = task.sourceUrl
          iframe.setAttribute('sandbox', 'allow-scripts')
          iframe.style.cssText = 'width:100%;height:852px;border:0;display:block;background:white;'
          host.replaceChildren(iframe)
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('嵌入预览加载超时')), 20_000)
            iframe.addEventListener('load', () => { clearTimeout(timer); resolve() }, { once: true })
            iframe.addEventListener('error', () => { clearTimeout(timer); reject(new Error('嵌入预览加载失败')) }, { once: true })
          })
          if (task.kind === 'pdf') {
            const ready = await new Promise<number>((resolve, reject) => {
              const timer = setTimeout(() => { window.removeEventListener('message', onMessage); reject(new Error('PDF 解析超时')) }, 20_000)
              const onMessage = (event: MessageEvent): void => {
                if (event.source !== iframe.contentWindow || event.data?.type !== 'agent-preview:pdf-ready') return
                clearTimeout(timer)
                window.removeEventListener('message', onMessage)
                resolve(Number(event.data.pageCount))
              }
              window.addEventListener('message', onMessage)
            })
            const navigate = async (page: number): Promise<void> => {
              await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(() => { window.removeEventListener('message', onMessage); reject(new Error('PDF 页面渲染超时')) }, 20_000)
                const onMessage = (event: MessageEvent): void => {
                  if (event.source !== iframe.contentWindow || event.data?.type !== 'agent-preview:pdf-page-rendered' || event.data?.page !== page) return
                  clearTimeout(timer)
                  window.removeEventListener('message', onMessage)
                  resolve()
                }
                window.addEventListener('message', onMessage)
                iframe.contentWindow?.postMessage({ type: 'agent-preview:select-pdf-page', page }, '*')
              })
              await settleViewer()
            }
            if (!cancelled) onRendered({ viewer: null, pageCount: ready, navigate })
            return
          }
        }
        await settleViewer()
        if (!cancelled) onRendered({ viewer: null, pageCount: 1 })
      } catch (error) {
        if (!cancelled) onFailure(error)
      }
    }
    void run()
    return () => {
      cancelled = true
      destroyOfficeViewer(viewerRef.current)
      viewerRef.current = null
      host.replaceChildren()
    }
  }, [format, onFailure, onRendered, task])

  return <main ref={hostRef} style={{ width: 1200, minHeight: 852, padding: 24, background: '#fff', color: '#111', overflow: 'hidden' }} />
}

function requestedPages(task: AgentPreviewRenderTask, pageCount: number, canNavigate: boolean): number[] {
  if (!Number.isInteger(pageCount) || pageCount < 1) throw new Error('预览没有返回有效页数')
  if (task.scope === 'page') {
    if (!task.page || task.page > pageCount) throw Object.assign(new Error(`页码 ${task.page ?? 0} 超出范围（共 ${pageCount} 页）`), { code: 'page_out_of_range' })
    if (!canNavigate && task.page > 1) throw Object.assign(new Error(`页码 ${task.page} 超出当前格式可检查范围`), { code: 'page_out_of_range' })
    return [task.page]
  }
  if (task.scope === 'all') {
    if (pageCount > AGENT_PREVIEW_LIMITS.maxPages) throw new Error(`页数超过 ${AGENT_PREVIEW_LIMITS.maxPages} 页限制`)
    if (!canNavigate && pageCount > 1) throw new Error('该格式当前无法逐页截图')
    return Array.from({ length: pageCount }, (_, index) => index + 1)
  }
  // overview is deliberately a bounded sample, not a falsely-labelled full-document capture.
  return Array.from({ length: Math.min(pageCount, MAX_OVERVIEW_PAGES) }, (_, index) => index + 1)
}

function AgentPreviewApp(): React.ReactElement {
  const [task, setTask] = React.useState<AgentPreviewRenderTask | null>(null)

  const handleRendered = React.useCallback((preview: RenderedPreview) => {
    if (!task || !window.agentPreviewAPI) return
    void (async () => {
      try {
        const canNavigate = typeof preview.viewer?.scrollToSlide === 'function'
          || typeof preview.viewer?.scrollToPage === 'function'
          || typeof preview.viewer?.goToSheet === 'function'
          || typeof preview.navigate === 'function'
        const pages = requestedPages(task, preview.pageCount, canNavigate)
        const images: AgentPreviewImage[] = []
        for (const page of pages) {
          if (preview.navigate) {
            await preview.navigate(page)
          } else if (preview.viewer?.scrollToSlide && page !== 1) {
            preview.viewer.scrollToSlide(page - 1, { behavior: 'auto' })
            await settleViewer()
          } else if (preview.viewer?.scrollToPage && page !== 1) {
            preview.viewer.scrollToPage(page - 1, { behavior: 'auto' })
            await settleViewer()
          } else if (preview.viewer?.goToSheet && page !== 1) {
            await preview.viewer.goToSheet(page - 1)
            await settleViewer()
          }
          images.push({ data: await window.agentPreviewAPI!.capture(task.id), mediaType: 'image/png', page })
        }
        const warnings: string[] = []
        if (task.scope === 'overview' && preview.pageCount > pages.length) warnings.push(`概览仅包含前 ${pages.length} 页（共 ${preview.pageCount} 页）；可用 scope=all 或 scope=page 继续检查。`)
        if (!preview.viewer && task.scope !== 'page') warnings.push('该格式当前返回单个渲染视口。')
        window.agentPreviewAPI!.sendResult(task.id, { images, warnings: warnings.length ? warnings : undefined })
      } catch (error) {
        const payload = error as { code?: string; message?: string }
        window.agentPreviewAPI!.sendError(task.id, { code: payload.code, message: payload.message || '截图失败' })
      }
    })
  }, [task])

  const handleFailure = React.useCallback((error: unknown) => {
    if (!task || !window.agentPreviewAPI) return
    window.agentPreviewAPI.sendError(task.id, { message: error instanceof Error ? error.message : '预览渲染失败' })
  }, [task])

  React.useEffect(() => {
    if (!window.agentPreviewAPI) return
    window.agentPreviewAPI.notifyReady()
    return window.agentPreviewAPI.onRender((nextTask) => setTask(nextTask))
  }, [])

  if (!task) return <div style={{ width: 1200, height: 900, background: '#fff' }} />
  return <PreviewCanvas key={task.id} task={task} onRendered={handleRendered} onFailure={handleFailure} />
}

export function mountAgentPreviewRenderer(): void {
  createRoot(document.getElementById('root')!).render(<AgentPreviewApp />)
}
