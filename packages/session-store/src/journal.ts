import { readFile, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWriteJson } from './atomic-write'

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
    await atomicWriteJson(path, journal)
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
