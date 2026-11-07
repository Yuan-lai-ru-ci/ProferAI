import { createHash, randomUUID } from 'node:crypto'
import { lstat, readFile, rename, unlink, open, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve as resolveFsPath, sep } from 'node:path'
import type { StoredFileVersion } from '@profer/session-store'
import { RewindStoreError } from '@profer/session-store'

export interface RewindFileRoot {
  rootId: string
  rootPath: string
  kind: 'managed' | 'project'
}

export interface RewindFilePort {
  resolve(rootId: string, relativePath: string): Promise<string>
  inspect(rootId: string, relativePath: string): Promise<{ version: StoredFileVersion; content?: Buffer }>
  write(rootId: string, relativePath: string, content: Buffer | undefined, mode: number | undefined, expected: StoredFileVersion): Promise<StoredFileVersion>
}

const digest = (data: Buffer) => createHash('sha256').update(data).digest('hex')

/** Root authorization is resolved on each operation; callers must not retain resolved paths across plans. */
export function createRewindFilePort(input: {
  roots(): Promise<RewindFileRoot[]>
  protectedPaths?: string[] | (() => string[])
  storeVersion?(content: Buffer | undefined, mode?: number): Promise<StoredFileVersion>
}): RewindFilePort {
  const getRoot = async (rootId: string): Promise<{ rootId: string; rootPath: string; kind: RewindFileRoot['kind'] }> => {
    const root = (await input.roots()).find(item => item.rootId === rootId)
    if (!root || !isAbsolute(root.rootPath)) throw new RewindStoreError('ROOT_UNAUTHORIZED', '回退根目录未获授权')
    const canonical = await realpath(root.rootPath)
    return { ...root, rootPath: canonical }
  }

  const resolve = async (rootId: string, filePath: string): Promise<string> => {
    if (!filePath || isAbsolute(filePath) || filePath.split(/[\\/]/).some(part => part === '..' || part === '.' || part === '')) {
      throw new RewindStoreError('INVALID_RELATIVE_PATH', '回退路径必须是规范的相对文件路径')
    }
    const root = await getRoot(rootId)
    const candidate = resolveFsPath(root.rootPath, filePath)
    const rel = relative(root.rootPath, candidate)
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`)) throw new RewindStoreError('INVALID_RELATIVE_PATH', '回退路径越界')
    const protectedPaths = (typeof input.protectedPaths === 'function' ? input.protectedPaths() : input.protectedPaths ?? []).map(p => resolveFsPath(p, '.'))
    const privateSegments = rel.split(sep)
    if (privateSegments.some(part => ['.profer', '.git', '.runtime', '.claude', '.context'].includes(part.toLowerCase())) ||
        protectedPaths.some(p => isWithin(p, candidate))) {
      throw new RewindStoreError('PROTECTED_PATH', '回退路径位于受保护目录')
    }
    await inspectParents(root.rootPath, candidate)
    return candidate
  }

  const inspect = async (rootId: string, filePath: string) => {
    const target = await resolve(rootId, filePath)
    let stat
    try { stat = await lstat(target) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: { kind: 'absent' } as const }
      throw error
    }
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) throw new RewindStoreError('UNSAFE_FILE', '仅支持普通、非链接且无硬链接的文件')
    const content = await readFile(target)
    const sha256 = digest(content)
    const stored = await input.storeVersion?.(content, stat.mode & 0o777)
    return { version: stored ?? { kind: 'file', contentRef: sha256, sha256, size: content.length, mode: stat.mode & 0o777 }, content }
  }

  const write = async (rootId: string, filePath: string, content: Buffer | undefined, mode: number | undefined, expected: StoredFileVersion) => {
    const target = await resolve(rootId, filePath)
    const current = await inspect(rootId, filePath)
    if (!sameVersion(current.version, expected)) throw new RewindStoreError('CAS_MISMATCH', '文件在回退前已变化')
    if (content === undefined) {
      if (current.version.kind === 'file') await unlink(target)
      return { kind: 'absent' } as const
    }
    const sha256 = digest(content)
    const stored = await input.storeVersion?.(content, mode)
    const version = stored ?? { kind: 'file' as const, contentRef: sha256, sha256, size: content.length, ...(mode === undefined ? {} : { mode }) }
    const parentStat = await lstat(dirname(target))
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new RewindStoreError('UNSAFE_PARENT', '目标父目录不安全')
    const temp = join(dirname(target), `.profer-rewind-${randomUUID()}.tmp`)
    const handle = await open(temp, 'wx', mode ?? 0o600)
    try { await handle.writeFile(content); await handle.sync() } finally { await handle.close() }
    const check = await inspect(rootId, filePath)
    if (!sameVersion(check.version, expected)) {
      await unlink(temp)
      throw new RewindStoreError('CAS_MISMATCH', '文件在原子替换前已变化')
    }
    try { await rename(temp, target) }
    catch (error) { try { await unlink(temp) } catch {} throw error }
    return version
  }

  return { resolve, inspect, write }
}

function isWithin(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}
function sameVersion(a: StoredFileVersion, b: StoredFileVersion): boolean {
  if (a.kind !== b.kind) return false
  return a.kind === 'absent' || (b.kind === 'file' && a.sha256 === b.sha256 && a.size === b.size)
}
async function inspectParents(root: string, target: string): Promise<void> {
  const rel = relative(root, target).split(sep)
  let current = root
  for (const segment of rel.slice(0, -1)) {
    current = join(current, segment)
    try {
      const stat = await lstat(current)
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new RewindStoreError('UNSAFE_PARENT', '路径父级包含链接或非目录')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break
      throw error
    }
  }
  const rootStat = await lstat(root)
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new RewindStoreError('UNSAFE_ROOT', '授权根目录不安全')
}
