import { dirname, extname } from 'node:path'
import { writeClipboardText } from './clipboard-agent-tools'
import { executeAgentPreviewTool, executeOpenFilePreviewTool, executeInspectFilePreviewTool, type OpenFilePreviewContext } from './agent-preview-tools'
import { CoreHostContentStore, type CoreHostContent } from './core-host-content'

interface HostIdentity { coreId: string; sessionId: string; runId: string; requestId: string }
export interface CoreHostIncomingRequest extends HostIdentity { operation: string; payload: unknown }
export type CoreHostOutgoingResponse = HostIdentity & ({ ok: true; value: unknown } | { ok: false; error: string })
export interface CoreHostHandlerPorts {
  coreId: string
  contentStore: CoreHostContentStore
  /** 校验请求来自当前已连接 Core，且会话/运行投影仍绑定此连接。 */
  isBoundRun(sessionId: string, runId: string): boolean
  /** 使用已有正式预览 request/inspect 事件回执，不创建第二套渲染器。 */
  previewContext(sessionId: string): Pick<OpenFilePreviewContext, 'onRequest' | 'onInspectRequest'>
}

/** Core 已审批的宿主 RPC 执行端；响应由父连接通过同一认证 socket 发回。 */
export class CoreHostHandler {
  private readonly seen = new Set<string>()
  constructor(private readonly ports: CoreHostHandlerPorts) {}

  async handle(request: CoreHostIncomingRequest): Promise<CoreHostOutgoingResponse> {
    const identity: HostIdentity = { coreId: request.coreId, sessionId: request.sessionId, runId: request.runId, requestId: request.requestId }
    try {
      const assertBound = (): void => {
        if (request.coreId !== this.ports.coreId || !request.requestId || !request.sessionId || !request.runId
          || !this.ports.isBoundRun(request.sessionId, request.runId)) throw new Error('宿主请求与当前 Core 连接或运行不匹配')
      }
      assertBound()
      if (this.seen.has(request.requestId)) throw new Error('宿主请求已执行或正在执行')
      // 有界防重放账本；达到上限后要求新连接，避免淘汰旧 ID 后再次执行副作用。
      if (this.seen.size >= 10_000) throw new Error('宿主连接请求额度已满，请重新连接')
      this.seen.add(request.requestId)
      if (!request.payload || typeof request.payload !== 'object') throw new Error('宿主请求内容无效')
      const payload = request.payload as Record<string, unknown>
      if (request.operation === 'clipboard.write') {
        if (typeof payload.text !== 'string' || Buffer.byteLength(payload.text) > 1024 * 1024) throw new Error('剪贴板文本无效或过大')
        assertBound()
        return { ...identity, ok: true, value: writeClipboardText(payload.text) }
      }
      if (request.operation !== 'preview.open' && request.operation !== 'preview.inspect') throw new Error('不支持的宿主操作')
      const staged = await this.ports.contentStore.stage(request.coreId, request.sessionId, payload.content as CoreHostContent)
      assertBound()
      const raw = payload.options && typeof payload.options === 'object' ? payload.options as Record<string, unknown> : {}
      const options = {
        page: typeof raw.page === 'number' && Number.isInteger(raw.page) && raw.page >= 1 ? raw.page : undefined,
        scope: raw.scope === 'page' || raw.scope === 'all' || raw.scope === 'overview' ? raw.scope : undefined,
        previousRevision: typeof raw.previousRevision === 'string' && raw.previousRevision.length <= 200 ? raw.previousRevision : undefined,
        mode: raw.mode === 'content' || raw.mode === 'visual' || raw.mode === 'both' ? raw.mode : undefined,
      } satisfies { page?: number; scope?: 'page' | 'all' | 'overview'; mode?: 'content' | 'visual' | 'both'; previousRevision?: string }
      const context: OpenFilePreviewContext = { ...this.ports.previewContext(request.sessionId), sessionId: request.sessionId,
        agentCwd: dirname(staged.filePath), allowedRoots: [dirname(staged.filePath)] }
      const pptx = extname(staged.filePath).toLowerCase() === '.pptx'
      const value = request.operation === 'preview.open'
        ? await executeOpenFilePreviewTool({ filePath: staged.filePath, readOnly: true }, context)
        : pptx
          ? await executeInspectFilePreviewTool({ filePath: staged.filePath, page: options.page, scope: options.scope }, context)
          : await executeAgentPreviewTool({ filePath: staged.filePath, ...options }, context)
      assertBound()
      return { ...identity, ok: true, value }
    } catch (error) {
      return { ...identity, ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
}
