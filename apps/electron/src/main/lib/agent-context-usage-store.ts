import type { AgentContextUsageSnapshot as Snapshot } from '@profer/shared'
import { getSessionStorageLayout } from '@profer/session-store'
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { open, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { nextContextUsageReading } from './agent-context-usage-reading'
import { getConfigDir } from './config-root'
import { isValidProjectSessionId } from './project-session-paths'

const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
function valid(s: Snapshot | null): s is Snapshot {
  return !!s && count(s.inputTokens) && s.inputTokens > 0 &&
    [s.outputTokens, s.cacheReadTokens, s.cacheCreationTokens, s.usageUpdatedAt].every(v => v === undefined || count(v)) &&
    (s.contextWindow === undefined || (count(s.contextWindow) && s.contextWindow > 0)) &&
    (s.model === undefined || (typeof s.model === 'string' && s.model.length <= 1024))
}

// 同一会话的迁移与实时写入按调用顺序串行；不同会话互不等待。
const pending = new Map<string, Promise<unknown>>()
function ordered<T>(id: string, task: () => Promise<T>): Promise<T> {
  const next = (pending.get(id) ?? Promise.resolve()).catch(() => {}).then(task)
  pending.set(id, next)
  return next.finally(() => { if (pending.get(id) === next) pending.delete(id) })
}

async function paths(id: string) {
  const layout = getSessionStorageLayout(id)
  const project = layout?.kind === 'project' ? layout.dataDir : undefined
  const root = project ? resolve(project, '../../..') : getConfigDir()
  const rel = project ? join('.profer', 'sessions', id) : 'agent-sessions'
  const dir = join(root, rel)
  if (project && resolve(project) !== dir) return null
  // 根目录本身允许别名，以下任何一级都不能重定向到另一会话。
  if (await realpath(dir) !== join(await realpath(root), rel)) return null
  const messages = join(dir, project ? 'messages.jsonl' : `${id}.jsonl`)
  return { messages, snapshot: `${messages}.context-usage.json` }
}

export async function flushAgentContextUsageWrites(): Promise<void> {
  await Promise.allSettled([...pending.values()])
}

const readFlags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | constants.O_NONBLOCK
async function readSnapshotFile(path: string) {
  const fd = await open(path, readFlags)
  try {
    const st = await fd.stat()
    if (!st.isFile() || st.size > 8192) throw new Error('无效快照')
    const data = Buffer.alloc(st.size)
    const { bytesRead } = await fd.read(data, 0, data.length, 0)
    return JSON.parse(data.toString('utf8', 0, bytesRead))
  } finally { await fd.close() }
}

// 按字节寻换行，整行组装后才解码，避免截断 UTF-8。单行超限无法排除压缩边界，停止恢复。
async function* reverseLines(path: string) {
  const fd = await open(path, readFlags)
  try {
    const info = await fd.stat()
    if (!info.isFile()) return
    let pos = info.size, length = 0
    let pieces: Buffer[] = []
    while (pos > 0) {
      const chunk = Buffer.allocUnsafe(Math.min(65536, pos))
      pos -= chunk.length
      if ((await fd.read(chunk, 0, chunk.length, pos)).bytesRead !== chunk.length) throw new Error('历史已变化')
      let end = chunk.length
      while (end > 0) {
        const nl = chunk.lastIndexOf(10, end - 1)
        const piece = chunk.subarray(nl + 1, end)
        length += piece.length
        if (length > 8 * 1024 * 1024) throw new Error('无法确定超大行是否为压缩边界')
        pieces.push(piece)
        if (nl < 0) break
        yield Buffer.concat(pieces.reverse(), length).toString('utf8')
        pieces = []; length = 0; end = nl
      }
    }
    if (length) yield Buffer.concat(pieces.reverse(), length).toString('utf8')
  } finally { await fd.close() }
}

// 指纹绑定具体历史版本：删除、清空、截断、复制或改写历史后均不复用旧快照。
async function revision(path: string) {
  if (await realpath(path) !== join(await realpath(dirname(path)), basename(path))) return null
  const s = await stat(path, { bigint: true })
  return s.isFile() && s.size > 0n ? `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}` : null
}
async function recover(path: string, prior?: Snapshot): Promise<Snapshot | null> {
  let single: Snapshot | null = null
  let result
  for await (const line of reverseLines(path)) {
    if (!line.trim()) continue
    let m
    try { m = JSON.parse(line) } catch { return null }
    if (!m || m.parent_tool_use_id != null || m.isSidechain || m.isReplay || m.error) continue
    const time = m._createdAt ?? m.timestamp
    const timestamp = typeof time === 'string' ? Date.parse(time) : time
    const usageUpdatedAt = count(timestamp) ? timestamp : undefined
    if (m.type === 'system' && m.subtype === 'compact_boundary') {
      const post = m.compact_metadata?.post_tokens
      return single ?? (count(post) && post > 0 ? { inputTokens: post, usageUpdatedAt } : null)
    }
    if (m.type === 'result') {
      if (single) return single
      result = m
      const reading = nextContextUsageReading(undefined, m, undefined, usageUpdatedAt ?? 0)
      if (reading && valid(reading)) single = { ...reading, usageUpdatedAt }
      continue
    }
    if (m.type === 'user' && !(Array.isArray(m.message?.content) && m.message.content.some((b: { type?: string }) => b?.type === 'tool_result'))) {
      if (single) return single
      result = undefined
    }
    if (m.type !== 'assistant' || !m.message?.usage) continue
    const model = m._channelModelId ?? m.message.model
    const window = result?.modelUsage?.[model]?.contextWindow ?? result?.modelUsage?.[m.message.model]?.contextWindow
    const measured = count(window) && window > 0 ? window : undefined
    const snapshot = nextContextUsageReading(undefined, m, measured, usageUpdatedAt ?? 0)
    if (!snapshot || !valid(snapshot)) return single
    snapshot.usageUpdatedAt = usageUpdatedAt
    if (prior && prior.inputTokens === snapshot.inputTokens && prior.model === snapshot.model &&
        prior.cacheReadTokens === snapshot.cacheReadTokens && prior.cacheCreationTokens === snapshot.cacheCreationTokens &&
        prior.outputTokens === snapshot.outputTokens) {
      snapshot.contextWindow = measured ?? prior.contextWindow ?? snapshot.contextWindow
      snapshot.usageUpdatedAt ??= prior.usageUpdatedAt
    }
    return snapshot
  }
  return single
}
async function persist(path: string, rev: string, snapshot: Snapshot) {
  const tmp = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(tmp, JSON.stringify({ version: 1, rev, snapshot }), { flag: 'wx', mode: 0o600 })
    await rename(tmp, path)
  } finally { await unlink(tmp).catch(() => {}) }
}
export async function readAgentContextUsageSnapshot(id: string): Promise<Snapshot | null> {
  if (!isValidProjectSessionId(id)) return null
  return ordered(id, async () => {
    try {
      const p = await paths(id)
      if (!p) return null
      const rev = await revision(p.messages)
      if (!rev) return null
      let prior: Snapshot | undefined
      try {
        const data = await readSnapshotFile(p.snapshot)
        if (data.version === 1 && typeof data.rev === 'string' && valid(data.snapshot)) {
          if (data.rev === rev) return data.snapshot
          const [dev, ino, size] = data.rev.split(':')
          const [nextDev, nextIno, nextSize] = rev.split(':')
          if (dev === nextDev && ino === nextIno && Number(size) < Number(nextSize)) prior = data.snapshot
        }
      } catch { /* 没有可用快照，按需回填。 */ }
      const snapshot = await recover(p.messages, prior)
      if (await revision(p.messages) !== rev) return null
      if (snapshot) await persist(p.snapshot, rev, snapshot).catch(() => {})
      return snapshot
    } catch { return null }
  })
}
export async function saveAgentContextUsageSnapshot(id: string, snapshot: Snapshot): Promise<void> {
  if (!isValidProjectSessionId(id) || !valid(snapshot)) return
  return ordered(id, async () => {
    try {
      const p = await paths(id)
      if (!p) return
      const rev = await revision(p.messages)
      if (rev) await persist(p.snapshot, rev, snapshot)
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
  })
}

/** 删除会话时在注销布局之前 await；不依赖消息文件仍然存在。 */
export async function deleteAgentContextUsageSnapshot(id: string): Promise<void> {
  if (!isValidProjectSessionId(id)) return
  return ordered(id, async () => {
    try {
      const p = await paths(id)
      if (p) await unlink(p.snapshot)
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
  })
}
