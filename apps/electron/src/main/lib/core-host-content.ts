import { createHash } from 'node:crypto'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'

export interface CoreHostContent { name: string; base64: string; sha256: string; byteLength: number }
interface StagedContent { filePath: string; sha256: string }

/** 桌面仅接收经 Core 授权传输的内容，绝不把远端路径解析为本地路径。 */
export class CoreHostContentStore {
  private readonly staged = new Map<string, StagedContent>()
  constructor(private readonly cacheRoot: string) {}

  async stage(coreId: string, sessionId: string, content: CoreHostContent): Promise<StagedContent> {
    if (!coreId || !sessionId || !content || typeof content.name !== 'string' || !content.name
      || content.name.length > 240 || /[\\/:\x00-\x1f]/.test(content.name) || content.name === '.' || content.name === '..'
      || typeof content.base64 !== 'string' || content.base64.length > 24 * 1024 * 1024
      || !Number.isInteger(content.byteLength) || content.byteLength < 0 || content.byteLength > 16 * 1024 * 1024
      || !/^[a-f0-9]{64}$/.test(content.sha256)) throw new Error('Core 预览内容无效')
    const bytes = Buffer.from(content.base64, 'base64')
    const digest = createHash('sha256').update(bytes).digest('hex')
    if (bytes.byteLength !== content.byteLength || digest !== content.sha256) throw new Error('Core 预览内容校验失败')
    const scope = createHash('sha256').update(JSON.stringify([coreId, sessionId])).digest('hex')
    const key = `${scope}:${digest}:${content.name}`
    const existing = this.staged.get(key)
    if (existing) return existing
    const dir = join(this.cacheRoot, scope, digest)
    await mkdir(dir, { recursive: true })
    const filePath = join(dir, content.name)
    await writeFile(filePath, bytes, { mode: 0o600 })
    const entry = { filePath, sha256: digest }
    this.staged.set(key, entry)
    return entry
  }

  /** 仅清除此实例管理的传输缓存；cacheRoot 必须由桌面提供独立临时目录。 */
  async clearSession(coreId: string, sessionId: string): Promise<void> {
    const scope = createHash('sha256').update(JSON.stringify([coreId, sessionId])).digest('hex')
    await rm(join(this.cacheRoot, scope), { recursive: true, force: true })
    for (const key of this.staged.keys()) if (key.startsWith(`${scope}:`)) this.staged.delete(key)
  }
}
