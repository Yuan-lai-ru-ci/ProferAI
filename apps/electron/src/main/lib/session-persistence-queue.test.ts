import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Worker } from 'node:worker_threads'
import type { SDKMessage } from '@profer/shared'
import { SessionPersistenceQueue } from './session-persistence-queue'

class FakeWorker extends EventEmitter {
  posts: Array<{ id: number; sessionId: string; messages: SDKMessage[] }> = []
  failNext = false

  postMessage(batch: { id: number; sessionId: string; messages: SDKMessage[] }): void {
    this.posts.push(batch)
    queueMicrotask(() => {
      if (this.failNext) {
        this.failNext = false
        this.emit('message', { type: 'failed', id: batch.id, error: 'disk full' })
      } else {
        this.emit('message', { type: 'saved', id: batch.id })
      }
    })
  }

  terminate(): Promise<number> { return Promise.resolve(0) }
}

const message = (uuid: string): SDKMessage => ({ type: 'assistant', uuid } as SDKMessage)

describe('SessionPersistenceQueue', () => {
  test('writes a batch through the real worker and resolves the persisted blob', async () => {
    const root = mkdtempSync(join(tmpdir(), 'profer-persistence-worker-'))
    const sessionsDir = join(root, 'sessions')
    const workerPath = join(import.meta.dir, '../../../dist/session-persistence-worker.cjs')
    const queue = new SessionPersistenceQueue({ configDir: root, sessionsDir, workerPath })
    try {
      const payload = 'B'.repeat(300_000)
      queue.enqueue('real-worker', [{ type: 'user', payload } as SDKMessage])
      expect(await queue.flush(5_000)).toBe(true)
      const line = readFileSync(join(sessionsDir, 'real-worker.jsonl'), 'utf8').trim()
      const hash = createHash('sha256').update(payload, 'utf8').digest('hex')
      const reference = (JSON.parse(line) as { _proferBlobs: Array<{ hash: string }> })._proferBlobs[0]!
      expect(reference.hash).toBe(`sha256:${hash}`)
      const blobPath = join(root, 'blobs', hash.slice(0, 2), hash.slice(2, 4), hash)
      expect(readFileSync(blobPath, 'utf8')).toBe(payload)
    } finally {
      queue.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('falls back to truncation instead of stalling the queue when a line cannot converge', async () => {
    const root = mkdtempSync(join(tmpdir(), 'profer-persistence-unconvergeable-'))
    const sessionsDir = join(root, 'sessions')
    const workerPath = join(import.meta.dir, '../../../dist/session-persistence-worker.cjs')
    const queue = new SessionPersistenceQueue({ configDir: root, sessionsDir, workerPath })
    try {
      // 每段都低于第二级抽取阈值（512），整行却超过 256K：外部化无法收敛，只能截断。
      const content = Array.from({ length: 700 }, (_, index) => ({ type: 'text', text: `${index}:${'x'.repeat(400)}` }))
      queue.enqueue('unconvergeable', [{ type: 'assistant', message: { content } } as unknown as SDKMessage])
      queue.enqueue('unconvergeable', [message('after')])
      expect(await queue.flush(5_000)).toBe(true)
      const lines = readFileSync(join(sessionsDir, 'unconvergeable.jsonl'), 'utf8').trim().split('\n')
      // 第一行超限但仍落盘，后续批次继续前进，队列不会卡死。
      expect(lines).toHaveLength(2)
      expect((JSON.parse(lines[1]!) as { uuid?: string }).uuid).toBe('after')
    } finally {
      queue.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('preserves FIFO order and reports saved status', async () => {
    const worker = new FakeWorker()
    const statuses: string[] = []
    const queue = new SessionPersistenceQueue({
      configDir: '/tmp/config', sessionsDir: '/tmp/sessions', createWorker: () => worker as unknown as Worker,
      onStatus: (_id, status) => statuses.push(status),
    })
    queue.enqueue('a', [message('1')])
    queue.enqueue('a', [message('2')])
    expect(await queue.flush(500)).toBe(true)
    expect(worker.posts.map(batch => (batch.messages[0] as { uuid?: string }).uuid)).toEqual(['1', '2'])
    expect(statuses).toEqual(['pending', 'pending', 'saved', 'saved'])
    queue.dispose()
  })

  test('retries a failed batch without allowing the error to escape enqueue', async () => {
    const worker = new FakeWorker()
    worker.failNext = true
    const queue = new SessionPersistenceQueue({
      configDir: '/tmp/config', sessionsDir: '/tmp/sessions', createWorker: () => worker as unknown as Worker,
    })
    expect(() => queue.enqueue('a', [message('retry')])).not.toThrow()
    await new Promise(resolve => setTimeout(resolve, 1_100))
    expect(await queue.flush(500)).toBe(true)
    expect(worker.posts.map(batch => (batch.messages[0] as { uuid?: string }).uuid)).toEqual(['retry', 'retry'])
    queue.dispose()
  })

  test('bounds payload memory by estimated byte size', () => {
    const worker = new FakeWorker()
    const errors: string[] = []
    const queue = new SessionPersistenceQueue({
      configDir: '/tmp/config', sessionsDir: '/tmp/sessions', createWorker: () => worker as unknown as Worker,
      onStatus: (_id, status, error) => { if (status === 'failed' && error) errors.push(error) },
    })
    queue.enqueue('a', [message('huge'), { type: 'assistant', message: { content: [{ type: 'text', text: 'x'.repeat(65 * 1024 * 1024) }] } } as SDKMessage])
    expect(errors).toEqual(['单批消息超过 8 MiB 持久化上限，本批未保存'])
    queue.dispose()
  })

  test('bounds message count and does not block when the queue overflows', () => {
    const worker = new FakeWorker()
    const errors: string[] = []
    const queue = new SessionPersistenceQueue({
      configDir: '/tmp/config', sessionsDir: '/tmp/sessions', createWorker: () => worker as unknown as Worker,
      onStatus: (_id, status, error) => { if (status === 'failed' && error) errors.push(error) },
    })
    const batch = Array.from({ length: 2_000 }, (_, index) => message(String(index)))
    queue.enqueue('a', batch)
    expect(() => queue.enqueue('a', [message('overflow')])).not.toThrow()
    expect(errors).toEqual(['持久化队列容量已满，本批消息未保存'])
    queue.dispose()
  })
})
