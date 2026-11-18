import { constants, existsSync, lstatSync, mkdirSync, openSync, closeSync, writeFileSync, fsyncSync, realpathSync, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isValidProjectSessionId } from '@profer/session-store/project-session-paths'

export const CORE_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024
export const CORE_ATTACHMENT_BODY_MAX_BYTES = 14 * 1024 * 1024 + 4096
export interface CoreSavedAttachment { filename: string; path: string; size: number }

function assertFilename(filename: string): void {
  // 不净化为另一个名字；Windows保留名/ADS/尾部点在Linux Core上同样拒绝，保持跨平台身份。
  if (!filename || filename.length > 180 || filename.trim() !== filename || /[<>:"/\\|?*\u0000-\u001f\u007f]/.test(filename)
    || filename === '.' || filename === '..' || /[. ]$/.test(filename)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(filename)) throw new Error('附件文件名无效')
}
function inside(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path))
  return !!rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}
function assertPrivatePath(root: string, path: string): void {
  if (!inside(root, path)) throw new Error('附件写入路径越界')
  let cursor = resolve(root)
  for (const segment of relative(resolve(root), resolve(path)).split(sep)) {
    cursor = join(cursor, segment)
    try { if (lstatSync(cursor).isSymbolicLink()) throw new Error('附件写入路径包含符号链接') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  if (existsSync(path) && !inside(realpathSync(root), realpathSync(path))) throw new Error('附件真实写入路径越界')
}
function writeExclusive(root: string, path: string, bytes: Buffer): void {
  assertPrivatePath(root, path)
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
  try { writeFileSync(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) }
  assertPrivatePath(root, path)
}

/** Core单会话工作台写入；不接收客户端授权根，不覆盖用户附件，不移动既有数据。 */
export function saveCoreAttachment(configRoot: string, sessionId: string, filename: string, base64: string): CoreSavedAttachment {
  if (!isValidProjectSessionId(sessionId)) throw new Error('附件会话身份无效')
  assertFilename(filename)
  if (typeof base64 !== 'string' || !base64 || base64.length > Math.ceil(CORE_ATTACHMENT_MAX_BYTES / 3) * 4
    || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw new Error('附件Base64数据无效或超过10MB')
  const bytes = Buffer.from(base64, 'base64')
  if (!bytes.length || bytes.length > CORE_ATTACHMENT_MAX_BYTES || bytes.toString('base64') !== base64) throw new Error('附件数据为空、损坏或超过10MB')
  if (!existsSync(configRoot) || !statSync(configRoot).isDirectory()) throw new Error('Core配置目录不可用')
  const uploadId = randomUUID()
  const directory = join(configRoot, 'session-workspaces', sessionId, 'attachments', uploadId)
  const backupDirectory = join(configRoot, 'agent-attachment-backups', sessionId, uploadId)
  for (const path of [backupDirectory, directory]) {
    assertPrivatePath(configRoot, path)
    mkdirSync(path, { recursive: true, mode: 0o700 })
    assertPrivatePath(configRoot, path)
  }
  const path = join(directory, filename)
  // 任何部分失败均保留已写的保护副本，不返回成功、不做范围不明的自动清理。
  writeExclusive(configRoot, join(backupDirectory, filename), bytes)
  writeExclusive(configRoot, path, bytes)
  return { filename, path, size: bytes.length }
}
