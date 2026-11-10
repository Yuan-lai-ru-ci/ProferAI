import { randomUUID } from 'node:crypto'
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
  messagesPath?: string
  blobRoot?: string
  batchId: string
  retryAt: number
  settle: (ack: PersistenceAck) => void
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

export interface PersistenceAck {
  status: 'saved' | 'failed'
  sessionId: string
  watermark: number
  error?: string
}
export type PersistenceReceipt =
  | { accepted: false; reason: 'disposed' | 'empty' | 'capacity' | 'session_failed' | 'deleted' | 'worker_unavailable'; error?: string }
  | { accepted: true; sessionId: string; watermark: number; batchId: string; completion: Promise<PersistenceAck> }

export interface SessionPersistenceQueueOptions {
  ackTimeoutMs?: number
  retryDelayMs?: number
  maxAttempts?: number
  configDir: string
  sessionsDir: string
  workerPath?: string
  createWorker?: () => Worker
  onStatus?: (sessionId: string, status: 'pending' | 'saved' | 'failed', error?: string) => void
  /**
   * 按会话布局解析消息文件路径。
   *
   * project 会话写在 `<root>/.profer/sessions/<sid>/messages.jsonl`，worker 是独立
   * 线程、没有布局注册表，必须由主进程在入队时算好传下去；缺省回退 sessionsDir。
   */
  resolveMessagesPath?: (sessionId: string) => string
  /** 按会话布局解析 blob 根目录，同样必须由主进程注入。 */
  resolveBlobRoot?: (sessionId: string) => string
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
  private readonly resolveMessagesPath?: SessionPersistenceQueueOptions['resolveMessagesPath']
  private readonly resolveBlobRoot?: SessionPersistenceQueueOptions['resolveBlobRoot']
  private disposed = false
  private quarantined?: string
  private readonly failedSessions = new Set<string>()
  private cleanupActive?: () => void
  private readonly ackTimeoutMs: number
  private readonly retryDelayMs: number
  private readonly maxAttempts: number

  constructor(options: SessionPersistenceQueueOptions) {
    this.ackTimeoutMs = options.ackTimeoutMs ?? 5_000
    this.retryDelayMs = options.retryDelayMs ?? RETRY_DELAY_MS
    this.maxAttempts = options.maxAttempts ?? 3
    this.configDir = options.configDir
    this.sessionsDir = options.sessionsDir
    this.createWorker = options.createWorker ?? (() => new Worker(options.workerPath ?? resolvePersistenceWorkerPath()))
    this.onStatus = options.onStatus
    this.resolveMessagesPath = options.resolveMessagesPath
    this.resolveBlobRoot = options.resolveBlobRoot
  }

  enqueue(sessionId: string, messages: readonly SDKMessage[]): PersistenceReceipt {
    if (this.disposed) return { accepted: false, reason: 'disposed' }
    if (this.quarantined) return { accepted: false, reason: 'worker_unavailable', error: this.quarantined }
    if (messages.length === 0) return { accepted: false, reason: 'empty' }
    if (this.failedSessions.has(sessionId)) return { accepted: false, reason: 'session_failed' }
    const estimatedBytes = estimatePayloadBytes(messages)
    const queuedMessages = this.queue.reduce((count, batch) => count + batch.messages.length, 0)
    const queuedBytes = this.queue.reduce((count, batch) => count + batch.estimatedBytes, 0)
    if (estimatedBytes > MAX_BATCH_BYTES || queuedMessages + messages.length > MAX_QUEUED_MESSAGES || queuedBytes + estimatedBytes > MAX_QUEUED_BYTES) {
      this.status(sessionId, 'failed', estimatedBytes > MAX_BATCH_BYTES ? '单批消息超过 8 MiB 持久化上限，本批未保存' : '持久化队列容量已满，本批消息未保存')
      console.error(`[Agent 会话] 持久化队列容量已满，拒收 ${messages.length} 条消息: session=${sessionId}`)
      return { accepted: false, reason: 'capacity' }
    }
    let settle!: Batch['settle']
    const completion = new Promise<PersistenceAck>(resolve => { settle = resolve })
    const batch: Batch = { id: this.nextId++, sessionId, messages: structuredClone([...messages]), attempts: 0, estimatedBytes, batchId: randomUUID(), retryAt: 0, settle }
    // 布局解析失败不能让消息丢：回退 undefined，worker 侧用全局 sessionsDir 拼装。
    try {
      batch.messagesPath = this.resolveMessagesPath?.(sessionId)
    } catch {
      batch.messagesPath = undefined
    }
    try {
      batch.blobRoot = this.resolveBlobRoot?.(sessionId)
    } catch {
      batch.blobRoot = undefined
    }
    this.queue.push(batch)
    this.status(sessionId, 'pending')
    setImmediate(() => this.pump())
    return { accepted: true, sessionId, watermark: batch.id, batchId: batch.batchId, completion }
  }

  private status(sessionId: string, status: 'pending' | 'saved' | 'failed', error?: string): void {
    try { this.onStatus?.(sessionId, status, error) } catch (cause) { console.error('[Agent 会话] 保存状态观察者失败', cause) }
  }

  async flush(timeoutMs = FLUSH_TIMEOUT_MS): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while ((this.active || this.queue.length > 0) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    return !this.active && this.queue.length === 0 && this.failedSessions.size === 0
  }

  dispose(): void {
    this.disposed = true
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.cleanupActive?.()
    this.active = false
    for (const batch of this.queue.splice(0)) this.fail(batch, '保存队列已关闭，尚未确认保存')
    const worker = this.worker
    if (worker) void worker.terminate().then(() => {
      if (this.worker === worker) this.worker = undefined
    }, error => console.error('[Agent 会话] 关闭持久化 Worker 失败', error))
  }

  private quarantine(error: string): void {
    this.quarantined = error
    this.active = false
    for (const batch of this.queue.splice(0)) this.fail(batch, error)
  }

  private fail(batch: Batch, error: string): void {
    this.failedSessions.add(batch.sessionId)
    batch.settle({ status: 'failed', sessionId: batch.sessionId, watermark: batch.id, error })
    this.status(batch.sessionId, 'failed', error)
  }

  private pump(): void {
    if (this.disposed || this.quarantined || this.active || this.queue.length === 0) return
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = undefined }
    // 只调度各会话的头批次；失败退避期间允许其他会话前进。
    const seen = new Set<string>()
    const heads = this.queue.filter(item => {
      if (seen.has(item.sessionId)) return false
      seen.add(item.sessionId)
      return true
    })
    const batch = heads.find(item => item.retryAt <= Date.now())
    if (!batch) {
      const delay = Math.max(1, Math.min(...heads.map(item => item.retryAt)) - Date.now())
      this.retryTimer = setTimeout(() => { this.retryTimer = undefined; this.pump() }, delay)
      return
    }
    batch.attempts += 1
    let worker: Worker
    try { worker = this.worker ??= this.createWorker() }
    catch (error) { this.retry(batch, String(error)); return }
    this.active = true
    let finished = false
    let timer: NodeJS.Timeout
    const cleanup = (): void => {
      finished = true
      clearTimeout(timer)
      worker.off('message', onMessage)
      worker.off('error', onError)
      worker.off('exit', onExit)
      this.cleanupActive = undefined
    }
    const finish = (error?: string, reset = false): void => {
      if (finished) return
      cleanup()
      this.active = false
      if (reset) {
        // 旧 Worker 确认退出前不创建新写者；超时期间宁可保留 pending，不能并发重放同一 JSONL。
        this.active = true
        this.worker = worker
        void worker.terminate().then(() => {
          if (this.worker === worker) this.worker = undefined
          this.active = false
          if (!this.disposed) this.retry(batch, error ?? '持久化 Worker 已退出')
        }, cause => {
          this.quarantine(`无法确认持久化 Worker 已退出: ${String(cause)}`)
        })
        return
      }
      if (error) this.retry(batch, error)
      else {
        this.queue.splice(this.queue.indexOf(batch), 1)
        batch.settle({ status: 'saved', sessionId: batch.sessionId, watermark: batch.id })
        // 兼容 session 状态只在该 session 的所有已接收批次均 ACK 后报告 saved。
        if (!this.queue.some(item => item.sessionId === batch.sessionId)) this.status(batch.sessionId, 'saved')
        this.pump()
      }
    }
    const onMessage = (reply: WorkerReply): void => {
      if (reply.id !== batch.id) return
      if (reply.type === 'saved') finish()
      else if (reply.type === 'failed') finish(reply.error ?? '保存失败')
    }
    const onError = (error: Error): void => finish(error.message, true)
    const onExit = (code: number): void => finish(`持久化 Worker 意外退出 (${code})`, true)
    this.cleanupActive = cleanup
    worker.on('message', onMessage)
    worker.once('error', onError)
    worker.once('exit', onExit)
    timer = setTimeout(() => finish('保存 ACK 超时，结果可能已写入', true), this.ackTimeoutMs)
    try {
      worker.postMessage({ type: 'append', id: batch.id, batchId: batch.batchId,
        configDir: this.configDir, sessionsDir: this.sessionsDir, sessionId: batch.sessionId,
        messages: batch.messages, messagesPath: batch.messagesPath, blobRoot: batch.blobRoot })
    } catch (error) { finish(String(error), true) }
  }

  private retry(batch: Batch, error: string): void {
    if (batch.attempts >= this.maxAttempts) {
      // 无法证明前批次已保存时，后批次不能越过它；明确失败而非静默丢弃。
      const blocked = this.queue.filter(item => item.sessionId === batch.sessionId)
      for (const item of blocked) {
        this.queue.splice(this.queue.indexOf(item), 1)
        this.fail(item, error)
      }
    } else batch.retryAt = Date.now() + this.retryDelayMs * batch.attempts
    this.pump()
  }
}
