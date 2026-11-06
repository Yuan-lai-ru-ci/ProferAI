import { parentPort } from 'node:worker_threads'
import { appendFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { SDKMessage } from '@profer/shared'
import { setBlobRootDirForWorker } from './blob-store'
import { externalizeSerializedSessionLine } from './session-payload-externalize'

interface AppendBatch {
  type: 'append'
  id: number
  configDir: string
  sessionsDir: string
  sessionId: string
  messages: SDKMessage[]
}

if (!parentPort) throw new Error('会话持久化 Worker 缺少 parentPort')

/**
 * 单行落盘：优先完整外部化；无法在预算内收敛时退回截断兜底。
 *
 * strict 模式一旦抛出会让整批进入无限重试并卡住 FIFO 队列，
 * 后续所有会话消息都写不进去；这里与同步写入路径保持同一语义：
 * 先尽力保住原文，确实抽不动才截断，绝不阻塞队列。
 */
function serializeLine(message: unknown, sessionId: string): string {
  const serialized = JSON.stringify(message)
  if (serialized.length <= 256 * 1024) return serialized
  try {
    return externalizeSerializedSessionLine(serialized, sessionId, { strict: true })
  } catch {
    return externalizeSerializedSessionLine(serialized, sessionId)
  }
}

parentPort.on('message', async (batch: AppendBatch) => {
  if (batch.type !== 'append') return
  try {
    setBlobRootDirForWorker(batch.configDir)
    const lines = batch.messages.map((message) => serializeLine(message, batch.sessionId))
    const path = join(batch.sessionsDir, `${batch.sessionId}.jsonl`)
    await mkdir(dirname(path), { recursive: true })
    await appendFile(path, `${lines.join('\n')}\n`, 'utf8')
    parentPort!.postMessage({ type: 'saved', id: batch.id })
  } catch (error) {
    parentPort!.postMessage({ type: 'failed', id: batch.id, error: error instanceof Error ? error.message : String(error) })
  }
})
