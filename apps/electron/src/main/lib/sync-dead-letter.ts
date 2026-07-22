/**
 * 同步死信队列：超过重试上限的 envelope 仍落入本队列，而非静默丢弃。
 * 持久化到 ~/.profer/sync-dead-letters.jsonl，供 UI 查看 / 手动重试 / 导出。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getConfigDir } from './config-paths'

interface SyncEnvelope {
  id?: string
  retryCount?: number
  lastError?: string
  [key: string]: unknown
}

let deadLetterPath: string | null = null

function getDeadLetterPath(): string {
  if (deadLetterPath) return deadLetterPath
  const dir = join(getConfigDir(), 'sync')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  deadLetterPath = join(dir, 'dead-letters.jsonl')
  return deadLetterPath
}

export function writeDeadLetterEnvelopes(envelopes: SyncEnvelope[]): void {
  const path = getDeadLetterPath()
  const stamp = Date.now()
  for (const env of envelopes) {
    const record = { ...env, dead_letter_at: stamp }
    appendFileSync(path, JSON.stringify(record) + '\n', 'utf-8')
  }
  console.warn(`[同步] ${envelopes.length} 条变更已移入死信队列: ${path}`)
}

export function readDeadLetters(): SyncEnvelope[] {
  const path = getDeadLetterPath()
  if (!existsSync(path)) return []
  try {
    const raw = readFileSync(path, 'utf-8').trim()
    if (!raw) return []
    return raw.split('\n').map((line) => JSON.parse(line))
  } catch (e) {
    console.error('[同步] 读取死信队列失败:', e)
    return []
  }
}

export function getDeadLetterFilePath(): string {
  return getDeadLetterPath()
}
