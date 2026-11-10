import { parentPort } from 'node:worker_threads'
import { readFile, appendFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { SDKMessage } from '@profer/shared'
import { setBlobRootDirDirect, setBlobRootDirForWorker } from './blob-store'
import { externalizeSerializedSessionLine } from './session-payload-externalize'

interface AppendBatch {
  type: 'append'
  id: number
  batchId: string
  configDir: string
  sessionsDir: string
  sessionId: string
  messages: SDKMessage[]
  /** 主进程按会话布局算好的消息文件路径；缺省时回退全局 sessionsDir 拼装。 */
  messagesPath?: string
  /** 主进程按会话布局算好的 blob 根目录（project 会话在 <root>/.profer/blobs）。 */
  blobRoot?: string
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

/** 磁盘标记恢复只补缺失行；绝不重写或截断已有历史。 */
export async function persistBatch(batch: AppendBatch): Promise<void> {
  setBlobRootDirForWorker(batch.configDir)
  if (batch.blobRoot) setBlobRootDirDirect(batch.blobRoot)
  const path = batch.messagesPath ?? join(batch.sessionsDir, `${batch.sessionId}.jsonl`)
  await mkdir(dirname(path), { recursive: true })
  let existing = ''
  try { existing = await readFile(path, 'utf8') }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  // 无换行即不能证明末行提交完整，即使恰好能 parse 也不擅自修补。
  if (existing && !existing.endsWith('\n')) throw new Error('JSONL 尾行未完整提交，待恢复；未追加或覆盖历史')
  const marks = new Map<number, string>()
  for (const line of existing.split('\n')) {
    if (!line) continue
    let stored: { _proferPersistence?: { batchId: string; count: number; index: number } }
    try { stored = JSON.parse(line) }
    catch { throw new Error('JSONL 存在损坏行，待恢复；未追加或覆盖历史') }
    const mark = stored?._proferPersistence
    if (mark?.batchId !== batch.batchId) continue
    if (mark.count !== batch.messages.length || !Number.isInteger(mark.index) || mark.index < 0 || mark.index >= batch.messages.length) {
      throw new Error('保存批次标记冲突，待恢复')
    }
    if (marks.has(mark.index)) throw new Error('保存批次存在重复索引标记，待恢复')
    marks.set(mark.index, line)
  }
  // 每行单独 append。失败若留下完整行，下次由稳定 batchId/index 跳过；
  // 若留下残缺尾行，下次显式失败，不能把新 JSON 拼到坏尾部。
  for (const [index, message] of batch.messages.entries()) {
    if (marks.has(index)) continue
    const stored = JSON.parse(serializeLine(message, batch.sessionId))
    stored._proferPersistence = { batchId: batch.batchId, index, count: batch.messages.length }
    await appendFile(path, `${JSON.stringify(stored)}\n`, 'utf8')
  }
}

// message 事件的 async handler 本身不会串行；显式串联以隔离全局 blob 根和同批次重放。
let pending = Promise.resolve()
parentPort.on('message', (batch: AppendBatch) => {
  if (batch.type !== 'append') return
  pending = pending.then(async () => {
    try {
      await persistBatch(batch)
      parentPort!.postMessage({ type: 'saved', id: batch.id })
    } catch (error) {
      parentPort!.postMessage({ type: 'failed', id: batch.id, error: error instanceof Error ? error.message : String(error) })
    }
  })
})
