import { Worker } from 'node:worker_threads'
import { join, sep } from 'node:path'
import type { SDKMessage } from '@profer/shared'

/**
 * Worker 线程不经过 Electron 的 asar 读补丁，只能从真实文件加载。
 * 打包后 __dirname 位于 app.asar 内，需要改指到 asarUnpack 出来的副本。
 */
export function resolvePersistenceWorkerPath(runtimeDir: string = __dirname): string {
  const path = join(runtimeDir, 'session-persistence-worker.cjs')
  const asarSegment = `app.asar${sep}`
  return path.includes(asarSegment) ? path.replace(asarSegment, `app.asar.unpacked${sep}`) : path
}

const MAX_QUEUED_MESSAGES = 2_000
const MAX_QUEUED_BYTES = 64 * 1024 * 1024
const MAX_BATCH_BYTES = 8 * 1024 * 1024
const RETRY_DELAY_MS = 1_000
const FLUSH_TIMEOUT_MS = 1_500

interface Batch {
  id: number
  sessionId: string
  messages: SDKMessage[]
  attempts: number
  estimatedBytes: number
}

interface WorkerReply { type: 'saved' | 'failed'; id: number; error?: string }

function estimatePayloadBytes(value: unknown, budget = MAX_QUEUED_BYTES): number {
  let total = 0
  const seen = new Set<object>()
  const visit = (node: unknown): void => {
    if (total >= budget || node === null || node === undefined) return
    if (typeof node === 'string') { total += node.length * 2; return }
    if (typeof node !== 'object') return
    if (seen.has(node)) return
    seen.add(node)
    if (Array.isArray(node)) {
      for (const item of node) visit(item)
    } else {
      for (const [key, item] of Object.entries(node)) { total += key.length * 2; visit(item) }
    }
  }
  visit(value)
  return Math.min(total, budget)
}

export interface SessionPersistenceQueueOptions {
  configDir: string
  sessionsDir: string
  workerPath?: string
  createWorker?: () => Worker
  onStatus?: (sessionId: string, status: 'pending' | 'saved' | 'failed', error?: string) => void
}

/** 运行消息的有界、进程内 FIFO 持久化旁路。 */
export class SessionPersistenceQueue {
  private readonly queue: Batch[] = []
  private worker?: Worker
  private nextId = 1
  private active = false
  private retryTimer?: NodeJS.Timeout
  private readonly configDir: string
  private readonly sessionsDir: string
  private readonly createWorker: () => Worker
  private readonly onStatus?: SessionPersistenceQueueOptions['onStatus']
  private disposed = false

  constructor(options: SessionPersistenceQueueOptions) {
    this.configDir = options.configDir
    this.sessionsDir = options.sessionsDir
    this.createWorker = options.createWorker ?? (() => new Worker(options.workerPath ?? resolvePersistenceWorkerPath()))
    this.onStatus = options.onStatus
  }

  enqueue(sessionId: string, messages: readonly SDKMessage[]): void {
    if (this.disposed || messages.length === 0) return
    const estimatedBytes = estimatePayloadBytes(messages)
    const queuedMessages = this.queue.reduce((count, batch) => count + batch.messages.length, 0)
    const queuedBytes = this.queue.reduce((count, batch) => count + batch.estimatedBytes, 0)
    if (estimatedBytes > MAX_BATCH_BYTES || queuedMessages + messages.length > MAX_QUEUED_MESSAGES || queuedBytes + estimatedBytes > MAX_QUEUED_BYTES) {
      this.onStatus?.(sessionId, 'failed', estimatedBytes > MAX_BATCH_BYTES ? '单批消息超过 8 MiB 持久化上限，本批未保存' : '持久化队列容量已满，本批消息未保存')
      console.error(`[Agent 会话] 持久化队列容量已满，拒收 ${messages.length} 条消息: session=${sessionId}`)
      return
    }
    const batch = { id: this.nextId++, sessionId, messages: [...messages], attempts: 0, estimatedBytes }
    this.queue.push(batch)
    this.onStatus?.(sessionId, 'pending')
    setImmediate(() => this.pump())
  }

  async flush(timeoutMs = FLUSH_TIMEOUT_MS): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while ((this.active || this.queue.length > 0) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    return !this.active && this.queue.length === 0
  }

  dispose(): void {
    this.disposed = true
    if (this.retryTimer) clearTimeout(this.retryTimer)
    void this.worker?.terminate()
    this.worker = undefined
  }

  private pump(): void {
    if (this.disposed || this.active || this.retryTimer || this.queue.length === 0) return
    let worker: Worker
    try {
      worker = this.worker ??= this.createWorker()
    } catch (error) {
      this.scheduleRetry(error)
      return
    }
    const batch = this.queue[0]!
    this.active = true
    const onMessage = (reply: WorkerReply): void => {
      if (reply.id !== batch.id) return
      worker.off('message', onMessage)
      worker.off('error', onError)
      worker.off('exit', onExit)
      this.active = false
      if (reply.type === 'saved') {
        this.queue.shift()
        this.onStatus?.(batch.sessionId, 'saved')
        this.pump()
      } else {
        this.onStatus?.(batch.sessionId, 'failed', reply.error)
        this.scheduleRetry(reply.error)
      }
    }
    const onError = (error: Error): void => {
      worker.off('message', onMessage)
      worker.off('error', onError)
      worker.off('exit', onExit)
      this.active = false
      this.worker = undefined
      void worker.terminate()
      this.onStatus?.(batch.sessionId, 'failed', error.message)
      this.scheduleRetry(error)
    }
    const onExit = (code: number): void => {
      if (!this.active) return
      onError(new Error(`持久化 Worker 意外退出 (${code})`))
    }
    worker.on('message', onMessage)
    worker.once('error', onError)
    worker.once('exit', onExit)
    try {
      worker.postMessage({
        type: 'append', id: batch.id, configDir: this.configDir, sessionsDir: this.sessionsDir,
        sessionId: batch.sessionId, messages: batch.messages,
      })
    } catch (error) {
      worker.off('message', onMessage)
      worker.off('error', onError)
      worker.off('exit', onExit)
      this.active = false
      this.onStatus?.(batch.sessionId, 'failed', error instanceof Error ? error.message : String(error))
      this.scheduleRetry(error)
    }
  }

  private scheduleRetry(error: unknown): void {
    const batch = this.queue[0]
    if (!batch) return
    batch.attempts += 1
    console.error(`[Agent 会话] 持久化暂不可用，后台重试 (${batch.attempts}):`, error)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined
      this.pump()
    }, Math.min(RETRY_DELAY_MS * batch.attempts, 30_000))
  }
}
