import * as React from 'react'
import { AlertCircle, Loader2, RefreshCw } from 'lucide-react'
import type { AgentFilePreviewReport, FileAccessOptions } from '@profer/shared'
import { Button } from '@/components/ui/button'
import {
  createOfficeViewer,
  destroyOfficeViewer,
  normalizeOfficeFormat,
  type OfficeFormat,
  type OfficeViewerHandle,
} from './silurus-bridge'
import { registerOfficialPptxPreview } from './official-preview-session'

interface OfficePreviewProps {
  filePath: string
  fileName?: string
  access?: FileAccessOptions
  className?: string
  /** Silurus 失败后的旧 HTML 预览。组件会在回退前销毁 viewer。 */
  fallback?: React.ReactNode
  onError?: (error: Error) => void
  onReady?: () => void
  /** 仅由 Agent 正式 PPTX 预览请求传入；绑定同一用户可见 viewer 的回执与观察。 */
  agentPreviewSession?: { sessionId: string; requestId: string; revision: string }
}

type Status = 'loading' | 'ready' | 'error'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Office 文件解析失败'
}

export function OfficePreview({
  filePath,
  fileName = filePath,
  access,
  className,
  fallback,
  onError,
  onReady,
  agentPreviewSession,
}: OfficePreviewProps): React.ReactElement {
  const containerRef = React.useRef<HTMLDivElement>(null)
  const viewerHostRef = React.useRef<HTMLDivElement>(null)
  const viewerRef = React.useRef<OfficeViewerHandle | null>(null)
  const [status, setStatus] = React.useState<Status>('loading')
  const [error, setError] = React.useState('')
  const [sourceUrl, setSourceUrl] = React.useState('')
  const [retryVersion, setRetryVersion] = React.useState(0)
  const format = normalizeOfficeFormat(fileName)
  const previewSessionId = agentPreviewSession?.sessionId
  const previewRequestId = agentPreviewSession?.requestId
  const previewRevision = agentPreviewSession?.revision
  const callbacksRef = React.useRef({ onError, onReady })
  callbacksRef.current = { onError, onReady }
  const registrationCleanupRef = React.useRef<(() => void) | null>(null)
  const currentSlideRef = React.useRef(1)
  const scaleRef = React.useRef<number | undefined>(undefined)

  const reportPreview = React.useCallback((partial: Pick<AgentFilePreviewReport, 'status'> & Partial<AgentFilePreviewReport>) => {
    if (!previewSessionId || !previewRequestId || !previewRevision || format !== 'pptx') return
    void window.electronAPI.reportAgentFilePreview({
      requestId: previewRequestId,
      sessionId: previewSessionId,
      filePath,
      revision: previewRevision,
      currentSlide: currentSlideRef.current,
      scale: scaleRef.current,
      ...partial,
    }).catch((reportError) => console.error('[OfficePreview] 正式预览回执失败:', reportError))
  }, [filePath, format, previewRequestId, previewRevision, previewSessionId])

  const destroyViewer = React.useCallback(() => {
    registrationCleanupRef.current?.()
    registrationCleanupRef.current = null
    destroyOfficeViewer(viewerRef.current)
    viewerRef.current = null
  }, [])

  const load = React.useCallback(async (signal: AbortSignal, officeFormat: OfficeFormat): Promise<void> => {
    destroyViewer()
    setStatus('loading')
    setError('')
    setSourceUrl('')

    if (officeFormat === 'pptx' && previewRevision) {
      const beforeRevision = await window.electronAPI.getAgentFilePreviewRevision(filePath, access)
      if (beforeRevision !== previewRevision) throw new Error('正式 PPTX 预览已过期：加载前磁盘 revision 与请求不一致')
    }
    const resolved = await window.electronAPI.resolveFilePath(filePath, access)
    if (signal.aborted) return
    if (!resolved?.url) throw new Error('无法读取 Office 文件')
    setSourceUrl(resolved.url)

    const container = viewerHostRef.current
    if (!container) return
    const viewer = await createOfficeViewer(
      officeFormat,
      container,
      resolved.url,
      (scale) => { scaleRef.current = scale },
      (viewerError) => {
        // load 阶段的错误会由 createOfficeViewer 抛给外层 catch；这里只处理 ready 后的异步渲染错误。
        if (!signal.aborted && viewerRef.current) {
          registrationCleanupRef.current?.()
          registrationCleanupRef.current = null
          setStatus('error')
          setError(viewerError.message)
          callbacksRef.current.onError?.(viewerError)
          reportPreview({ status: 'error', error: viewerError.message })
        }
      },
      (index) => { currentSlideRef.current = index + 1 },
    )
    if (signal.aborted) {
      destroyOfficeViewer(viewer)
      return
    }
    if (officeFormat === 'pptx' && previewRevision) {
      const afterRevision = await window.electronAPI.getAgentFilePreviewRevision(filePath, access)
      if (afterRevision !== previewRevision) {
        destroyOfficeViewer(viewer)
        throw new Error('正式 PPTX 预览已过期：viewer 加载期间磁盘文件发生变化')
      }
    }
    viewerRef.current = viewer
    scaleRef.current = viewer.getScale?.()
    currentSlideRef.current = 1
    if (officeFormat === 'pptx' && previewSessionId && previewRevision) {
      registrationCleanupRef.current = registerOfficialPptxPreview(previewSessionId, {
        filePath,
        revision: previewRevision,
        viewer,
        host: container,
        getCurrentSlide: () => currentSlideRef.current,
      })
    }
    // 表格以实际已使用区域适配可视空间，避免“适应宽度”仍留下横向滚动条。
    // 随后的 ResizeObserver 会在面板尺寸变化时重新适配。
    if (officeFormat === 'xlsx') viewer.fitPage?.()
    setStatus('ready')
    callbacksRef.current.onReady?.()
    reportPreview({ status: 'ready', slideCount: viewer.slideCount })
  }, [access, destroyViewer, filePath, previewRevision, previewSessionId, reportPreview])

  React.useEffect(() => {
    const controller = new AbortController()
    if (!format) {
      setStatus('error')
      setError('暂不支持此 Office 文件格式')
      return () => controller.abort()
    }

    void load(controller.signal, format).catch((caught: unknown) => {
      if (controller.signal.aborted) return
      destroyViewer()
      const nextError = caught instanceof Error ? caught : new Error(errorMessage(caught))
      setStatus('error')
      setError(nextError.message)
      callbacksRef.current.onError?.(nextError)
      reportPreview({ status: 'error', error: nextError.message })
    })

    return () => {
      controller.abort()
      destroyViewer()
    }
  }, [destroyViewer, filePath, format, load, reportPreview, retryVersion])

  React.useEffect(() => {
    if (format !== 'xlsx' || status !== 'ready' || !containerRef.current) return
    const observer = new ResizeObserver(() => viewerRef.current?.fitPage?.())
    observer.observe(containerRef.current)
    return () => observer.disconnect()
  }, [format, status])

  if (status === 'error' && fallback) return <>{fallback}</>

  return (
    <div className={`relative flex h-full min-h-0 flex-col bg-surface-raised ${className ?? ''}`}>
      <div ref={containerRef} className="relative min-h-0 flex-1 overflow-hidden" data-office-format={format ?? undefined} data-office-source={sourceUrl || undefined}>
        <div ref={viewerHostRef} className="relative h-full min-h-0 w-full [&>div]:h-full [&>div]:w-full">
          {status === 'loading' && (
            <div className="flex h-full min-h-32 items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />正在加载 {format?.toUpperCase() ?? 'Office'} 预览
            </div>
          )}
          {status === 'error' && (
            <div className="flex h-full min-h-32 flex-col items-center justify-center gap-3 px-6 text-center text-sm text-muted-foreground">
              <AlertCircle className="size-5 text-destructive" />
              <span>高保真预览失败：{error}</span>
              <Button variant="outline" size="sm" onClick={() => setRetryVersion((version) => version + 1)}>
                <RefreshCw className="mr-1 size-3.5" />重新加载
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
