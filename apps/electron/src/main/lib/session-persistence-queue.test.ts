import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { Worker as RealWorker } from 'node:worker_threads'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Worker } from 'node:worker_threads'
import type { SDKMessage } from '@profer/shared'
import { resolvePersistenceWorkerPath, SessionPersistenceQueue } from './session-persistence-queue'

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
    const workerPath = await buildWorker(root)
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
    const workerPath = await buildWorker(root)
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
    expect(statuses).toEqual(['pending', 'pending', 'saved'])
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

  test('loads the worker from app.asar.unpacked after packaging', () => {
    const packaged = join('/Applications', 'Profer.app', 'Contents', 'Resources', 'app.asar', 'dist')
    expect(resolvePersistenceWorkerPath(packaged)).toBe(
      join('/Applications', 'Profer.app', 'Contents', 'Resources', 'app.asar.unpacked', 'dist', 'session-persistence-worker.cjs'),
    )
    expect(resolvePersistenceWorkerPath('/repo/apps/electron/dist')).toBe(
      join('/repo/apps/electron/dist', 'session-persistence-worker.cjs'),
    )
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

test('receipt stays pending until ACK and rejects disposed enqueue explicitly', async () => {
  const worker = new FakeWorker()
  worker.postMessage = batch => { worker.posts.push(batch) }
  const queue = new SessionPersistenceQueue({ configDir: '/tmp/config', sessionsDir: '/tmp/sessions', createWorker: () => worker as unknown as Worker })
  try {
    const receipt = queue.enqueue('a', [message('delayed')])
    expect(receipt.accepted).toBe(true)
    expect(await queue.flush(30)).toBe(false)
    worker.emit('message', { type: 'saved', id: worker.posts[0]!.id })
    if (receipt.accepted) expect((await receipt.completion).status).toBe('saved')
    queue.dispose()
    expect(queue.enqueue('a', [message('late')])).toMatchObject({ accepted: false, reason: 'disposed' })
  } finally { queue.dispose() }
})

test('bounded failures isolate sessions and do not overtake same-session predecessors', async () => {
  const worker = new FakeWorker()
  worker.postMessage = batch => {
    worker.posts.push(batch)
    queueMicrotask(() => worker.emit('message', { type: batch.sessionId === 'a' ? 'failed' : 'saved', id: batch.id, error: 'disk full' }))
  }
  const queue = new SessionPersistenceQueue({ configDir: '/tmp/config', sessionsDir: '/tmp/sessions', createWorker: () => worker as unknown as Worker, retryDelayMs: 5, maxAttempts: 2 })
  try {
    const a = queue.enqueue('a', [message('a1')])
    const a2 = queue.enqueue('a', [message('a2')])
    const b = queue.enqueue('b', [message('b1')])
    if (!a.accepted || !a2.accepted || !b.accepted) throw new Error('unexpected rejection')
    expect((await b.completion).status).toBe('saved')
    expect((await a.completion).status).toBe('failed')
    expect((await a2.completion).status).toBe('failed')
    expect(worker.posts.filter(p => p.sessionId === 'a')).toHaveLength(2)
    expect(await queue.flush(100)).toBe(false)
  } finally { queue.dispose() }
})

async function buildWorker(root: string): Promise<string> {
  const path = join(root, 'session-persistence-worker.cjs')
  const result = await Bun.build({ entrypoints: [join(import.meta.dir, 'session-persistence-worker.ts')], target: 'node', format: 'cjs' })
  if (!result.success) throw new Error(result.logs.join('\n'))
  await Bun.write(path, result.outputs[0]!)
  return path
}

test('disk batch identity survives ACK loss and worker restart without duplicate lines', async () => {
  const root = mkdtempSync(join(tmpdir(), 'profer-persistence-replay-'))
  let worker: RealWorker | undefined
  try {
    const path = await buildWorker(root)
    const batch = { type: 'append', id: 1, batchId: 'stable-batch', configDir: root, sessionsDir: join(root, 'sessions'), sessionId: 'replay', messages: [message('one'), message('two')] }
    const send = async (): Promise<void> => {
      worker = new RealWorker(path)
      await new Promise<void>((resolve, reject) => {
        worker!.once('error', reject)
        worker!.once('message', reply => reply.type === 'saved' ? resolve() : reject(new Error(reply.error)))
        worker!.postMessage(batch)
      })
      await worker.terminate()
      worker = undefined
    }
    // 第一次 ACK 被调用方丢弃；全新 worker 重发同一批次，去重事实只来自磁盘。
    await send()
    await send()
    const lines = readFileSync(join(root, 'sessions/replay.jsonl'), 'utf8').trim().split('\n')
    expect(lines.map(line => JSON.parse(line).uuid)).toEqual(['one', 'two'])
  } finally { await worker?.terminate(); rmSync(root, { recursive: true, force: true }) }
})

test('silent ACK loss is bounded and other session eventually proceeds', async () => {
  const worker = new FakeWorker()
  worker.postMessage = batch => {
    worker.posts.push(batch)
    if (batch.sessionId === 'b') queueMicrotask(() => worker.emit('message', { type: 'saved', id: batch.id }))
  }
  const queue = new SessionPersistenceQueue({ configDir: '/tmp/config', sessionsDir: '/tmp/sessions', createWorker: () => worker as unknown as Worker, ackTimeoutMs: 15, retryDelayMs: 5, maxAttempts: 2 })
  try {
    const a = queue.enqueue('a', [message('lost')])
    const b = queue.enqueue('b', [message('good')])
    if (!a.accepted || !b.accepted) throw new Error('unexpected rejection')
    expect((await b.completion).status).toBe('saved')
    expect((await a.completion).status).toBe('failed')
    expect(worker.posts.filter(batch => batch.sessionId === 'a')).toHaveLength(2)
  } finally { queue.dispose() }
})

test('real disk failure yields failed receipt while unrelated session saves', async () => {
  const root = mkdtempSync(join(tmpdir(), 'profer-persistence-disk-fault-'))
  const { writeFileSync } = await import('node:fs')
  const blocked = join(root, 'not-a-directory')
  writeFileSync(blocked, 'fixture')
  const workerPath = await buildWorker(root)
  const queue = new SessionPersistenceQueue({ configDir: root, sessionsDir: join(root, 'sessions'), workerPath,
    resolveMessagesPath: session => session === 'broken' ? join(blocked, 'messages.jsonl') : join(root, 'sessions', `${session}.jsonl`),
    retryDelayMs: 5, maxAttempts: 2 })
  try {
    const broken = queue.enqueue('broken', [message('broken')])
    const healthy = queue.enqueue('healthy', [message('healthy')])
    if (!broken.accepted || !healthy.accepted) throw new Error('unexpected rejection')
    expect((await broken.completion).status).toBe('failed')
    expect((await healthy.completion).status).toBe('saved')
    expect(queue.enqueue('broken', [message('later')])).toMatchObject({ accepted: false, reason: 'session_failed' })
    expect(await queue.flush(100)).toBe(false)
  } finally { queue.dispose(); rmSync(root, { recursive: true, force: true }) }
})

test('failed worker termination quarantines the writer and settles every receipt', async () => {
  const worker = new FakeWorker()
  worker.postMessage = batch => { worker.posts.push(batch) }
  worker.terminate = () => Promise.reject(new Error('termination refused'))
  const queue = new SessionPersistenceQueue({
    configDir: '/tmp/config', sessionsDir: '/tmp/sessions',
    createWorker: () => worker as unknown as Worker, ackTimeoutMs: 5,
  })
  const first = queue.enqueue('a', [message('uncertain')])
  const second = queue.enqueue('b', [message('also-uncertain')])
  if (!first.accepted || !second.accepted) throw new Error('unexpected rejection')
  expect((await first.completion).status).toBe('failed')
  expect((await second.completion).status).toBe('failed')
  expect(queue.enqueue('c', [message('must-not-write')])).toMatchObject({ accepted: false, reason: 'worker_unavailable' })
  expect(await queue.flush(30)).toBe(false)
  expect(worker.posts).toHaveLength(1)
  queue.dispose()
})

test('capacity rejection and dispose settle pending receipts without claiming saved', async () => {
  const worker = new FakeWorker()
  worker.postMessage = batch => { worker.posts.push(batch) }
  const queue = new SessionPersistenceQueue({ configDir: '/tmp/config', sessionsDir: '/tmp/sessions', createWorker: () => worker as unknown as Worker })
  const receipt = queue.enqueue('full', Array.from({ length: 2_000 }, (_, index) => message(String(index))))
  expect(queue.enqueue('full', [message('overflow')])).toMatchObject({ accepted: false, reason: 'capacity' })
  queue.dispose()
  if (!receipt.accepted) throw new Error('unexpected rejection')
  expect((await receipt.completion).status).toBe('failed')
  expect(await queue.flush(30)).toBe(false)
})

test('real worker resumes missing batch indexes without rewriting concurrent sync history', async () => {
  const root = mkdtempSync(join(tmpdir(), 'profer-persistence-append-only-'))
  const { appendFileSync, mkdirSync, statSync } = await import('node:fs')
  let worker: RealWorker | undefined
  try {
    const path = await buildWorker(root)
    const sessionsDir = join(root, 'sessions')
    mkdirSync(sessionsDir)
    const file = join(sessionsDir, 'resume.jsonl')
    const first = JSON.stringify({ ...message('first'), _proferPersistence: { batchId: 'partial', index: 0, count: 3 } }) + '\n'
    appendFileSync(file, first)
    const inode = statSync(file).ino
    worker = new RealWorker(path)
    const batch = { type: 'append', id: 1, batchId: 'partial', configDir: root, sessionsDir, sessionId: 'resume', messages: [message('first'), message('second'), message('third')] }
    let counter = 0
    const syncLines: string[] = []
    const timer = setInterval(() => {
      const line = JSON.stringify({ type: 'user', uuid: `sync-${counter++}` }) + '\n'
      appendFileSync(file, line)
      syncLines.push(line)
    }, 1)
    try {
      await new Promise<void>((resolve, reject) => {
        worker!.once('error', reject)
        worker!.once('message', reply => reply.type === 'saved' ? resolve() : reject(new Error(reply.error)))
        worker!.postMessage(batch)
      })
    } finally { clearInterval(timer) }
    expect(syncLines.length).toBeGreaterThan(0)
    const content = readFileSync(file, 'utf8')
    expect(content.startsWith(first)).toBe(true)
    for (const line of syncLines) expect(content.includes(line)).toBe(true)
    expect(statSync(file).ino).toBe(inode)
    const own = content.trim().split('\n').map(line => JSON.parse(line)).filter(m => m._proferPersistence?.batchId === 'partial')
    expect(own.map(m => m.uuid)).toEqual(['first', 'second', 'third'])
  } finally { await worker?.terminate(); rmSync(root, { recursive: true, force: true }) }
})

  test('real worker refuses duplicate batch indexes instead of acknowledging an ambiguous replay', async () => {
    const root = mkdtempSync(join(tmpdir(), 'profer-persistence-duplicate-mark-'))
    const { appendFileSync, mkdirSync } = await import('node:fs')
    let worker: RealWorker | undefined
    try {
      const path = await buildWorker(root)
      const sessionsDir = join(root, 'sessions')
      mkdirSync(sessionsDir)
      const file = join(sessionsDir, 'duplicate.jsonl')
      const mark = { batchId: 'dup', index: 0, count: 2 }
      appendFileSync(file, `${JSON.stringify({ uuid: 'one', _proferPersistence: mark })}\n${JSON.stringify({ uuid: 'one-again', _proferPersistence: mark })}\n`)
      worker = new RealWorker(path)
      const reply = await new Promise<{ type: string; error?: string }>((resolve, reject) => {
        worker!.once('error', reject)
        worker!.once('message', resolve)
        worker!.postMessage({ type: 'append', id: 1, batchId: 'dup', configDir: root, sessionsDir, sessionId: 'duplicate', messages: [message('one'), message('two')] })
      })
      expect(reply.type).toBe('failed')
      expect(reply.error).toContain('重复索引')
    } finally { await worker?.terminate(); rmSync(root, { recursive: true, force: true }) }
  })

  test('real worker refuses torn JSONL tail and preserves every existing byte', async () => {
  const root = mkdtempSync(join(tmpdir(), 'profer-persistence-torn-tail-'))
  const { writeFileSync } = await import('node:fs')
  let worker: RealWorker | undefined
  try {
    const path = await buildWorker(root)
    const file = join(root, 'broken.jsonl')
    const previous = '{"uuid":"old"}\n{"uuid":"torn'
    writeFileSync(file, previous)
    worker = new RealWorker(path)
    const reply = await new Promise<{ type: string; error?: string }>((resolve, reject) => {
      worker!.once('error', reject)
      worker!.once('message', resolve)
      worker!.postMessage({ type: 'append', id: 1, batchId: 'torn', configDir: root, sessionsDir: root, messagesPath: file, sessionId: 'broken', messages: [message('new')] })
    })
    expect(reply.type).toBe('failed')
    expect(reply.error).toContain('待恢复')
    expect(readFileSync(file, 'utf8')).toBe(previous)
  } finally { await worker?.terminate(); rmSync(root, { recursive: true, force: true }) }
})
