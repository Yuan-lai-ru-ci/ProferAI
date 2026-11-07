import { mkdir, open, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join, relative, resolve, sep } from 'node:path'
import type { SessionStorePaths } from './contracts'
import { sessionRewindPath } from './paths'

export type StoredFileVersion =
  | { kind: 'absent' }
  | { kind: 'file'; contentRef: string; sha256: string; size: number; mode?: number }

export interface RewindJournalFileAction {
  sessionId: string
  rootId: string
  relativePath: string
  action: 'restore' | 'delete'
  before: StoredFileVersion
  after: StoredFileVersion
  currentRevision: string
  afterRevision: string
  ownerKey?: string
  completed?: boolean
}

export interface RewindManifest {
  recoveryId: string
  sessionId: string
  status: 'ready' | 'applying' | 'committed' | 'recovery-required'
  createdAt: number
  refs: string[]
  metadata?: Record<string, unknown>
}

export interface RewindJournal {
  operationId: string
  sessionId: string
  status: 'started' | 'committed' | 'failed' | 'recovery-required'
  phase: string
  createdAt: number
  updatedAt: number
  refs: string[]
  actions: Array<RewindJournalFileAction & { path?: string; completed?: boolean }>
  metadata?: Record<string, unknown>
  error?: string
}

export class RewindStoreError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'RewindStoreError'
  }
}

export function createRewindStore(paths: Pick<SessionStorePaths, 'configDir' | 'rewindDir'>, sessionId: string) {
  const rootDir = resolve(sessionRewindPath(paths, sessionId))
  const objectDir = join(rootDir, 'objects')
  const manifestDir = join(rootDir, 'manifests')
  const journalDir = join(rootDir, 'operations')
  const safeId = (value: string): string => {
    if (!/^[a-zA-Z0-9_-]{1,160}$/.test(value)) throw new RewindStoreError('INVALID_ID', '无效恢复记录标识')
    return value
  }
  const objectPath = (hash: string): string => {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new RewindStoreError('INVALID_HASH', '无效内容 hash')
    return join(objectDir, hash)
  }
  const manifestPath = (id: string): string => join(manifestDir, `${safeId(id)}.json`)
  const journalPath = (id: string): string => join(journalDir, `${safeId(id)}.json`)

  const putVersion = async (version: { kind: 'absent' } | { kind: 'file'; content: Uint8Array; mode?: number }): Promise<StoredFileVersion> => {
    if (version.kind === 'absent') return { kind: 'absent' }
    const content = Buffer.from(version.content)
    const sha256 = createHash('sha256').update(content).digest('hex')
    const target = objectPath(sha256)
    await mkdir(objectDir, { recursive: true, mode: 0o700 })
    try {
      const existing = await readFile(target)
      if (hash(existing) !== sha256) throw new RewindStoreError('OBJECT_HASH_MISMATCH', `内容对象损坏: ${sha256}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await atomicWrite(target, content, 0o600)
    }
    return { kind: 'file', contentRef: sha256, sha256, size: content.length, ...(version.mode === undefined ? {} : { mode: version.mode }) }
  }

  const readObject = async (contentRef: string): Promise<Buffer> => {
    const content = await readFile(objectPath(contentRef))
    if (hash(content) !== contentRef) throw new RewindStoreError('OBJECT_HASH_MISMATCH', `内容对象校验失败: ${contentRef}`)
    return content
  }

  const readVersion = async (version: StoredFileVersion): Promise<Buffer | undefined> => {
    if (version.kind === 'absent') return undefined
    if (version.contentRef !== version.sha256) throw new RewindStoreError('OBJECT_HASH_MISMATCH', '内容引用与版本 hash 不一致')
    let content: Buffer
    try { content = await readFile(objectPath(version.contentRef)) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new RewindStoreError('OBJECT_MISSING', `内容对象缺失: ${version.contentRef}`)
      throw error
    }
    if (content.length !== version.size || hash(content) !== version.sha256) {
      throw new RewindStoreError('OBJECT_HASH_MISMATCH', `内容对象校验失败: ${version.contentRef}`)
    }
    return content
  }

  const writeManifest = async (manifest: RewindManifest): Promise<void> => {
    if (manifest.sessionId !== sessionId) throw new RewindStoreError('SESSION_MISMATCH', '恢复记录 sessionId 不匹配')
    for (const ref of manifest.refs) objectPath(ref)
    await atomicJson(manifestPath(manifest.recoveryId), manifest)
  }
  const readManifest = async (id: string): Promise<RewindManifest | undefined> => {
    const manifest = await readJson<RewindManifest>(manifestPath(id))
    if (manifest && manifest.sessionId !== sessionId) {
      throw new RewindStoreError('SESSION_MISMATCH', '恢复记录 sessionId 不匹配')
    }
    return manifest
  }
  const readManifestBySession = async (id: string, expectedSessionId: string): Promise<RewindManifest | undefined> => {
    if (expectedSessionId !== sessionId) throw new RewindStoreError('SESSION_MISMATCH', '恢复记录 sessionId 不匹配')
    return readManifest(id)
  }
  const listManifests = async (): Promise<RewindManifest[]> => {
    const manifests = await listJson<RewindManifest>(manifestDir)
    for (const manifest of manifests) {
      if (manifest.sessionId !== sessionId) throw new RewindStoreError('SESSION_MISMATCH', '恢复记录 sessionId 不匹配')
    }
    return manifests
  }
  const listManifestsBySession = async (expectedSessionId: string): Promise<RewindManifest[]> => {
    if (expectedSessionId !== sessionId) throw new RewindStoreError('SESSION_MISMATCH', '恢复记录 sessionId 不匹配')
    return listManifests()
  }

  const writeJournal = async (journal: RewindJournal): Promise<void> => {
    if (journal.sessionId !== sessionId) throw new RewindStoreError('SESSION_MISMATCH', '操作 journal sessionId 不匹配')
    for (const ref of journal.refs) objectPath(ref)
    await atomicJson(journalPath(journal.operationId), journal)
  }
  const readJournal = async (id: string): Promise<RewindJournal | undefined> => {
    const journal = await readJson<RewindJournal>(journalPath(id))
    if (journal && journal.sessionId !== sessionId) throw new RewindStoreError('SESSION_MISMATCH', '操作 journal sessionId 不匹配')
    return journal
  }
  const readJournalBySession = async (id: string, expectedSessionId: string): Promise<RewindJournal | undefined> => {
    if (expectedSessionId !== sessionId) throw new RewindStoreError('SESSION_MISMATCH', '操作 journal sessionId 不匹配')
    return readJournal(id)
  }
  const listJournals = async (): Promise<RewindJournal[]> => {
    const journals = await listJson<RewindJournal>(journalDir)
    for (const journal of journals) {
      if (journal.sessionId !== sessionId) throw new RewindStoreError('SESSION_MISMATCH', '操作 journal sessionId 不匹配')
    }
    return journals
  }
  const listJournalsBySession = async (expectedSessionId: string): Promise<RewindJournal[]> => {
    if (expectedSessionId !== sessionId) throw new RewindStoreError('SESSION_MISMATCH', '操作 journal sessionId 不匹配')
    return listJournals()
  }
  const removeJournal = async (id: string): Promise<void> => unlinkMissing(journalPath(id))

  const collectGarbage = async (options: { olderThan: number; retainedRefs?: readonly string[] }): Promise<{ deletedObjects: number; deletedManifests: number }> => {
    const manifests = await listManifests()
    const journals = await listJournals()
    const incomplete = new Set(journals.filter((item) => item.status !== 'committed').flatMap((item) => item.refs))
    const retainedManifests = manifests.filter((item) => item.status === 'applying' || item.status === 'recovery-required' || item.createdAt >= options.olderThan)
    const retainedRefs = new Set([...retainedManifests.flatMap((item) => item.refs), ...incomplete, ...(options.retainedRefs ?? [])])
    for (const ref of retainedRefs) objectPath(ref)
    let deletedManifests = 0
    for (const manifest of manifests) {
      if (!retainedManifests.includes(manifest)) {
        await unlinkMissing(manifestPath(manifest.recoveryId))
        deletedManifests += 1
      }
    }
    let deletedObjects = 0
    for (const name of await listNames(objectDir)) {
      if (!retainedRefs.has(name)) {
        await unlinkMissing(objectPath(name))
        deletedObjects += 1
      }
    }
    return { deletedObjects, deletedManifests }
  }

  return {
    paths: { rootDir, objectDir, manifestDir, journalDir, objectPath, manifestPath, journalPath },
    putVersion, readVersion, readObject, writeManifest, readManifest, readManifestBySession, listManifests, listManifestsBySession,
    writeJournal, readJournal, readJournalBySession, listJournals, listJournalsBySession, removeJournal, collectGarbage,
  }
}

export function resolveProjectRelativePath(projectRoot: string, filePath: string): string {
  const root = resolve(projectRoot)
  const candidate = resolve(root, filePath)
  const rel = relative(root, candidate)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || resolve(candidate) === root) {
    throw new RewindStoreError('INVALID_RELATIVE_PATH', '恢复路径必须是项目内文件相对路径')
  }
  return rel.split(sep).join('/')
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  await atomicWrite(path, Buffer.from(`${JSON.stringify(value, null, 2)}\n`), 0o600)
}

async function atomicWrite(path: string, content: Buffer, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const tempPath = `${path}.${randomUUID()}.tmp`
  const handle = await open(tempPath, 'wx', mode)
  try {
    await handle.writeFile(content)
    await handle.sync()
  } catch (error) {
    await handle.close()
    await unlinkMissing(tempPath)
    throw error
  }
  await handle.close()
  try {
    await rename(tempPath, path)
    const dir = await open(dirname(path), 'r')
    try { await dir.sync() } finally { await dir.close() }
  } catch (error) {
    await unlinkMissing(tempPath)
    throw error
  }
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(path, 'utf8')) as T }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

async function listJson<T>(dir: string): Promise<T[]> {
  const names = (await listNames(dir)).filter((name) => name.endsWith('.json')).sort()
  return Promise.all(names.map(async (name) => JSON.parse(await readFile(join(dir, name), 'utf8')) as T))
}

async function listNames(dir: string): Promise<string[]> {
  try { return await readdir(dir) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

async function unlinkMissing(path: string): Promise<void> {
  try { await unlink(path) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

function hash(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}
