import type {
  AgentFilePreviewInspectRequest,
  AgentFilePreviewInspectResult,
  AgentFilePreviewReport,
  ProferEvent,
} from '@profer/shared'

interface Pending<T> {
  sessionId: string
  filePath: string
  revision: string
  timer: ReturnType<typeof setTimeout>
  resolve: (value: T) => void
  reject: (error: Error) => void
}

type PreviewEvent = Extract<ProferEvent, { type: 'preview_requested' | 'preview_inspection_requested' }>

export class AgentFilePreviewSessionManager {
  private readonly openRequests = new Map<string, Pending<AgentFilePreviewReport>>()
  private readonly inspectRequests = new Map<string, Pending<AgentFilePreviewInspectResult>>()

  constructor(private readonly timeoutMs = 20_000) {}

  waitUntilReady(
    event: Extract<ProferEvent, { type: 'preview_requested' }>,
    emit: (event: PreviewEvent) => void,
  ): Promise<AgentFilePreviewReport> {
    return this.wait(this.openRequests, event, emit, '正式 PPTX 预览加载超时')
  }

  inspect(
    request: AgentFilePreviewInspectRequest,
    emit: (event: PreviewEvent) => void,
  ): Promise<AgentFilePreviewInspectResult> {
    return this.wait(this.inspectRequests, request, emit, '正式 PPTX 预览观察超时')
  }

  reportReady(report: AgentFilePreviewReport): boolean {
    const pending = this.openRequests.get(report.requestId)
    if (!pending) return false
    this.openRequests.delete(report.requestId)
    clearTimeout(pending.timer)
    const mismatch = this.validateIdentity(pending, report)
    if (mismatch) {
      pending.reject(new Error(mismatch))
    } else if (report.status === 'error') {
      pending.reject(new Error(report.error || '正式 PPTX 预览加载失败'))
    } else if (!Number.isInteger(report.slideCount) || (report.slideCount ?? 0) < 1) {
      pending.reject(new Error('正式 PPTX viewer ready 回执缺少有效页数'))
    } else if (!Number.isInteger(report.currentSlide) || (report.currentSlide ?? 0) < 1 || (report.currentSlide ?? 0) > report.slideCount!) {
      pending.reject(new Error('正式 PPTX viewer ready 回执页码无效'))
    } else {
      pending.resolve(report)
    }
    return true
  }

  reportInspection(result: AgentFilePreviewInspectResult): boolean {
    const pending = this.inspectRequests.get(result.requestId)
    if (!pending) return false
    this.inspectRequests.delete(result.requestId)
    clearTimeout(pending.timer)
    const mismatch = this.validateIdentity(pending, result)
    if (mismatch) pending.reject(new Error(mismatch))
    else if (result.error) pending.reject(new Error(result.error))
    else if (!Number.isInteger(result.slideCount) || result.slideCount < 1 || result.images.length < 1) pending.reject(new Error('正式 PPTX 预览观察没有返回有效页图'))
    else if (result.images.some((image) => image.page < 1 || image.page > result.slideCount || !image.data)) pending.reject(new Error('正式 PPTX 预览观察返回了无效页码或空图像'))
    else pending.resolve(result)
    return true
  }

  dispose(): void {
    for (const requests of [this.openRequests, this.inspectRequests] as const) {
      for (const pending of requests.values()) {
        clearTimeout(pending.timer)
        pending.reject(new Error('正式 PPTX 预览会话已关闭'))
      }
      requests.clear()
    }
  }

  private wait<T extends { requestId: string; sessionId: string; filePath: string; revision: string }>(
    requests: Map<string, Pending<T>>,
    input: { requestId: string; sessionId: string; filePath: string; revision: string },
    emit: (event: PreviewEvent) => void,
    timeoutMessage: string,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        requests.delete(input.requestId)
        reject(new Error(timeoutMessage))
      }, this.timeoutMs)
      requests.set(input.requestId, {
        sessionId: input.sessionId,
        filePath: input.filePath,
        revision: input.revision,
        timer,
        resolve,
        reject,
      })
      try {
        if ('type' in input) emit(input as unknown as PreviewEvent)
        else emit({ type: 'preview_inspection_requested', request: input as AgentFilePreviewInspectRequest })
      } catch (error) {
        requests.delete(input.requestId)
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private validateIdentity(
    pending: Pick<Pending<unknown>, 'sessionId' | 'filePath' | 'revision'>,
    actual: { sessionId: string; filePath: string; revision: string },
  ): string | null {
    if (actual.sessionId !== pending.sessionId || actual.filePath !== pending.filePath) {
      return '正式 PPTX 预览回执与当前会话或文件不匹配'
    }
    if (actual.revision !== pending.revision) return '正式 PPTX 预览已过期：viewer revision 与磁盘文件不一致'
    return null
  }
}

export const agentFilePreviewSessionManager = new AgentFilePreviewSessionManager()
