import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { SDKMessage } from '@profer/shared'
import type { SessionMessagePage, SyncSessionMessageStore, SyncSessionMessageStoreOptions } from './contracts'
import { readSessionMessagesFromString } from '@profer/session-core'
import { sessionMessagesDir, sessionMessagesPath } from './paths'

export function createSyncSessionMessageStore(
  getPaths: () => { sessionsDir: string },
  options: SyncSessionMessageStoreOptions = {},
): SyncSessionMessageStore {
  const parseLine = (sessionId: string, line: string): SDKMessage | undefined => {
    if (options.parseMessage) return options.parseMessage(sessionId, line)
    return readSessionMessagesFromString(line)[0]
  }

  const readLines = (sessionId: string): string[] => {
    const path = sessionMessagesPath(getPaths(), sessionId)
    if (!existsSync(path)) return []
    try {
      return readFileSync(path, 'utf8').split('\n').filter((line) => line.trim())
    } catch {
      return []
    }
  }

  const read = (sessionId: string): SDKMessage[] => readLines(sessionId)
    .map((line) => parseLine(sessionId, line))
    .filter((message): message is SDKMessage => message !== undefined)

  const readPage = (sessionId: string, optionsPage: { tail?: number; before?: number }): SessionMessagePage => {
    const lines = readLines(sessionId)
    const total = lines.length
    const before = optionsPage.before === undefined ? total : Math.max(0, Math.min(optionsPage.before, total))
    const pageSize = optionsPage.tail ?? 60
    const startIndex = Math.max(0, before - pageSize)
    const messages = lines.slice(startIndex, before)
      .map((line) => parseLine(sessionId, line))
      .filter((message): message is SDKMessage => message !== undefined)
    return { messages, total, startIndex, endIndex: before - 1, hasMore: startIndex > 0 }
  }

  const append = (sessionId: string, messages: readonly SDKMessage[]): void => {
    if (messages.length === 0) return
    const paths = getPaths()
    const filePath = sessionMessagesPath(paths, sessionId)
    mkdirSync(sessionMessagesDir(paths, sessionId), { recursive: true })
    const content = messages.map((message) => options.serializeMessage?.(sessionId, message) ?? JSON.stringify(message)).join('\n') + '\n'
    appendFileSync(filePath, content, 'utf8')
  }

  const replace = (sessionId: string, messages: readonly SDKMessage[]): void => {
    const paths = getPaths()
    const filePath = sessionMessagesPath(paths, sessionId)
    mkdirSync(dirname(filePath), { recursive: true })
    const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`
    writeFileSync(tempPath, messages.length > 0
      ? `${messages.map((message) => options.serializeMessage?.(sessionId, message) ?? JSON.stringify(message)).join('\n')}\n`
      : '', 'utf8')
    renameSync(tempPath, filePath)
  }

  return { append, read, readPage, replace, clear: (sessionId) => replace(sessionId, []) }
}
