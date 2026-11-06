import { appendFile, mkdir, rename, writeFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import type { SDKMessage } from '@profer/shared'
import { readSessionMessagesFromString } from '@profer/session-core'
import type { SessionMessagePage, SessionMessageStore, SessionStorePaths } from './contracts'
import { sessionMessagesDir, sessionMessagesPath } from './paths'

export function createSessionMessageStore(paths: SessionStorePaths): SessionMessageStore {
  const read = async (sessionId: string): Promise<SDKMessage[]> => {
    const messages: SDKMessage[] = []
    for await (const line of readLines(sessionMessagesPath(paths, sessionId))) {
      messages.push(...readSessionMessagesFromString(line))
    }
    return messages
  }

  const readPage = async (sessionId: string, options: { tail?: number; before?: number }): Promise<SessionMessagePage> => {
    const pageSize = Math.max(1, options.tail ?? 60)
    const before = options.before === undefined ? Number.POSITIVE_INFINITY : Math.max(0, options.before)
    const selected: string[] = []
    let total = 0
    for await (const line of readLines(sessionMessagesPath(paths, sessionId))) {
      if (total < before) {
        selected.push(line)
        if (selected.length > pageSize) selected.shift()
      }
      total += 1
    }
    const end = Math.min(total, before)
    const startIndex = Math.max(0, end - selected.length)
    const messages = selected.flatMap((line) => readSessionMessagesFromString(line))
    return { messages, total, startIndex, endIndex: end - 1, hasMore: startIndex > 0 }
  }

  const append = async (sessionId: string, messages: readonly SDKMessage[]): Promise<void> => {
    if (messages.length === 0) return
    const filePath = sessionMessagesPath(paths, sessionId)
    await mkdir(sessionMessagesDir(paths, sessionId), { recursive: true })
    await appendFile(filePath, `${messages.map((message) => JSON.stringify(message)).join('\n')}\n`, 'utf8')
  }

  const replace = async (sessionId: string, messages: readonly SDKMessage[]): Promise<void> => {
    const filePath = sessionMessagesPath(paths, sessionId)
    await mkdir(sessionMessagesDir(paths, sessionId), { recursive: true })
    const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`
    await writeFile(tempPath, messages.length > 0 ? `${messages.map((message) => JSON.stringify(message)).join('\n')}\n` : '', 'utf8')
    await rename(tempPath, filePath)
  }

  const clear = async (sessionId: string): Promise<void> => replace(sessionId, [])

  return { append, read, readPage, replace, clear }
}

async function* readLines(filePath: string): AsyncGenerator<string> {
  let stream: ReturnType<typeof createReadStream>
  try {
    stream = createReadStream(filePath, { encoding: 'utf8' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }

  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      if (line.trim()) yield line
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  } finally {
    lines.close()
    stream.destroy()
  }
}
