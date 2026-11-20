import { constants, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { extname, join, relative, resolve, sep } from 'node:path'
import type { AttachmentSaveInput, FileAttachment } from '@profer/shared'
import { CORE_ATTACHMENT_MAX_BYTES } from './core-attachment-service'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export function assertChatId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error('Chat对话身份无效')
}
/** Chat只授权本Core附件目录中的双UUID相对路径；绝不接受客户端绝对路径。 */
export function createCoreChatAttachments(configDir: string, hasConversation: (id: string) => boolean) {
  const root = resolve(configDir)
  function checked(localPath: string, mustExist = true): string {
    if (typeof localPath !== 'string' || localPath.includes('\\')) throw new Error('Chat附件路径无效')
    const parts = localPath.split('/')
    if (parts.length !== 2 || !UUID.test(parts[0]!) || !UUID.test(parts[1]!.replace(/\.[a-zA-Z0-9]{1,12}$/, ''))) throw new Error('Chat附件路径无效')
    if (!hasConversation(parts[0]!)) throw new Error('Chat附件所属对话不存在')
    const path = join(root, 'attachments', ...parts)
    let cursor = root
    for (const segment of ['attachments', ...parts]) {
      cursor = join(cursor, segment)
      if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new Error('Chat附件路径包含符号链接')
    }
    if (mustExist) {
      const rel = relative(realpathSync(root), realpathSync(path))
      if (rel.startsWith(`..${sep}`) || rel === '..' || !lstatSync(path).isFile()) throw new Error('Chat附件真实路径越界')
      if (lstatSync(path).size > CORE_ATTACHMENT_MAX_BYTES) throw new Error('Chat附件超过10MB')
    }
    return path
  }
  function read(localPath: string): Buffer { return readFileSync(checked(localPath)) }
  function save(input: AttachmentSaveInput): { attachment: FileAttachment } {
    assertChatId(input.conversationId)
    if (typeof input.filename !== 'string' || !input.filename || input.filename.length > 180 || /[\\/\u0000-\u001f]/.test(input.filename)) throw new Error('Chat附件文件名无效')
    if (typeof input.mediaType !== 'string' || !/^(image\/(png|jpeg|gif|webp)|text\/[a-zA-Z0-9.+-]+|application\/(json|xml))$/.test(input.mediaType)) throw new Error('Core Chat当前仅支持图片和文本附件；文档解析尚未装配')
    if (typeof input.data !== 'string' || input.data.length > Math.ceil(CORE_ATTACHMENT_MAX_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.data)) throw new Error('Chat附件Base64无效或超过10MB')
    const bytes = Buffer.from(input.data, 'base64')
    if (!bytes.length || bytes.length > CORE_ATTACHMENT_MAX_BYTES || bytes.toString('base64') !== input.data) throw new Error('Chat附件Base64无效或超过10MB')
    const id = randomUUID()
    const extension = extname(input.filename)
    const localPath = `${input.conversationId}/${id}${/^\.[a-zA-Z0-9]{1,12}$/.test(extension) ? extension : ''}`
    const path = checked(localPath, false)
    mkdirSync(join(root, 'attachments', input.conversationId), { recursive: true, mode: 0o700 })
    checked(localPath, false)
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
    try { writeFileSync(fd, bytes) } finally { closeSync(fd) }
    return { attachment: { id, filename: input.filename, mediaType: input.mediaType, localPath, size: bytes.length } }
  }
  return { save, readBase64: (path: string) => read(path).toString('base64'), extractText: async (path: string) => read(path).toString('utf8'), remove: (path: string) => unlinkSync(checked(path)), validate: checked }
}
