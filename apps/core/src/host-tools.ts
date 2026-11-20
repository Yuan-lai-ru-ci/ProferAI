import { basename } from 'node:path'
import { createHash } from 'node:crypto'
import type { CoreDesktopHostBridge } from './host-bridge'

export const MAX_HOST_PREVIEW_BYTES = 16 * 1024 * 1024
export interface CoreHostToolContext {
  connectionId: string
  sessionId: string
  runId: string
  signal: AbortSignal
}
export interface CoreHostFilePort {
  /** 必须使用所属 Core 的授权文件读取器，含路径/符号链接边界和大小限制；不可直接信任工具传入路径。 */
  readAuthorizedFile(path: string, maxBytes: number, signal: AbortSignal): Promise<{ name: string; bytes: Uint8Array }>
}
export interface HostPreviewContent { name: string; base64: string; sha256: string; byteLength: number }

/** 工具端口只传内容，不把 Core 绝对路径交给桌面当本机文件打开。 */
export class CoreHostTools {
  constructor(private readonly bridge: CoreDesktopHostBridge, private readonly files: CoreHostFilePort) {}

  async preview(context: CoreHostToolContext, input: { path: string; inspect?: boolean; options?: { page?: number; scope?: 'overview' | 'page' | 'all'; mode?: 'content' | 'visual' | 'both' } }): Promise<unknown> {
    if (context.signal.aborted) throw new Error('预览请求已取消')
    if (!this.bridge.isConnected(context.connectionId)) throw new Error('桌面宿主未连接')
    if (input.options?.page !== undefined && (!Number.isInteger(input.options.page) || input.options.page < 1)) throw new Error('预览页码无效')
    const file = await this.files.readAuthorizedFile(input.path, MAX_HOST_PREVIEW_BYTES, context.signal)
    if (file.bytes.byteLength > MAX_HOST_PREVIEW_BYTES) throw new Error('预览内容超过桌面传输大小限制')
    const name = basename(file.name)
    if (!name || name === '.' || name === '..' || /[\\/\x00-\x1f]/.test(name)) throw new Error('预览文件名无效')
    const content: HostPreviewContent = { name, base64: Buffer.from(file.bytes).toString('base64'),
      sha256: createHash('sha256').update(file.bytes).digest('hex'), byteLength: file.bytes.byteLength }
    return this.bridge.request({ ...context, operation: input.inspect ? 'preview.inspect' : 'preview.open',
      payload: { content, options: input.options ?? {} } })
  }

  async clipboardWrite(context: CoreHostToolContext, text: string): Promise<unknown> {
    if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 1024 * 1024) throw new Error('剪贴板文本无效或超过 1 MiB')
    return this.bridge.request({ ...context, operation: 'clipboard.write', payload: { text } })
  }
}
