import { mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'

export type SessionJournalOperation = 'delete' | 'fork' | 'rewind'
export type SessionJournalStatus = 'started' | 'committed' | 'failed'

export interface SessionOperationJournal {
  operationId: string
  operation: SessionJournalOperation
  sessionId: string
  status: SessionJournalStatus
  phase: string
  createdAt: number
  updatedAt: number
  destinationSessionId?: string
  sessionIds?: string[]
  error?: string
}

export function createSessionJournalStore(rootDir: string) {
  const pathFor = (operationId: string): string => {
    if (!/^[a-zA-Z0-9_-]{1,160}$/.test(operationId)) throw new Error('无效 operationId')
    return join(rootDir, `${operationId}.json`)
  }

  const write = async (journal: SessionOperationJournal): Promise<void> => {
    const path = pathFor(journal.operationId)
    await atomicJson(path, journal)
  }

  const read = async (operationId: string): Promise<SessionOperationJournal | undefined> => {
    try {
      return JSON.parse(await readFile(pathFor(operationId), 'utf8')) as SessionOperationJournal
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  const list = async (): Promise<SessionOperationJournal[]> => {
    let names: string[]
    try { names = await readdir(rootDir) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    return Promise.all(names.filter((name) => name.endsWith('.json')).sort().map(async (name) =>
      JSON.parse(await readFile(join(rootDir, name), 'utf8')) as SessionOperationJournal,
    ))
  }

  const remove = async (operationId: string): Promise<void> => {
    try { await unlink(pathFor(operationId)) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  return { pathFor, write, read, list, remove }
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const tempPath = `${path}.${randomUUID()}.tmp`
  const handle = await open(tempPath, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
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

async function unlinkMissing(path: string): Promise<void> {
  try { await unlink(path) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}
