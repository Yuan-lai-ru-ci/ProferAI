// 本文件验收旧桌面 writer；新核默认与归属保护由 Core 专项测试覆盖。
process.env.PROFER_LOCAL_CORE_MODE = 'legacy'

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SDKMessage } from '@profer/shared'

mock.module('electron', () => ({
  BrowserWindow: { getAllWindows: () => [], fromWebContents: () => undefined },
  app: { getPath: () => '', isPackaged: false },
  clipboard: { readText: () => '', writeText: () => undefined },
  dialog: {},
  nativeImage: {},
  nativeTheme: {},
  Notification: class {},
  powerMonitor: {},
  powerSaveBlocker: {},
  safeStorage: {},
  screen: {},
  shell: {},
  systemPreferences: {},
}))

let root = ''
let storageService: typeof import('./storage-service')
let sessions: typeof import('./agent-session-manager')
let blobStore: typeof import('./blob-store')
let configPaths: typeof import('./config-paths')

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'profer-storage-blob-test-'))
  process.env.PROFER_CONFIG_DIR = root
  const key = `${Date.now()}-${Math.random()}`
  storageService = await import(`./storage-service?blob-test=${key}`)
  sessions = await import(`./agent-session-manager?blob-test=${key}`)
  blobStore = await import(`./blob-store?blob-test=${key}`)
  configPaths = await import(`./config-paths?blob-test=${key}`)
  mkdirSync(configPaths.getAgentSessionsDir(), { recursive: true })
})

afterEach(() => {
  delete process.env.PROFER_CONFIG_DIR
  if (root) rmSync(root, { recursive: true, force: true })
})

/** 走真实写入路径造一个「被会话引用的 blob」 */
function createSessionWithExternalizedPayload(): void {
  const meta = sessions.createAgentSession('blob category')
  const message = {
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text: 'ok' }] }] },
    tool_use_result: { content: [{ type: 'text', text: 'R'.repeat(400_000) }] },
  } as unknown as SDKMessage
  sessions.appendSDKMessages(meta.id, [message])
}

/** 手写一个孤儿 blob（没有任何会话引用它） */
function writeOrphanBlob(content: string): string {
  const hash = blobStore.hashOfBlobContent(content)
  const path = blobStore.blobPathFor(hash)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content, 'utf-8')
  return path
}

const blobsCategory = async (): Promise<{ bytes: number; count: number; orphanBytes: number; orphanCount: number }> => {
  const stats = await storageService.calculateStorageStats()
  const category = stats.categories.find((c) => c.key === 'session-blobs')
  expect(category).toBeDefined()
  return category!
}

describe('存储统计 · 会话外置内容', () => {
  test('Given 有被引用的 blob When 统计 Then 计入且不算孤儿', async () => {
    createSessionWithExternalizedPayload()

    const category = await blobsCategory()

    expect(category.count).toBe(1)
    expect(category.bytes).toBe(400_000)   // 恰好就是那个 40 万字符的载荷
    expect(category.orphanCount).toBe(0)
  })

  test('Given 混有孤儿 blob When 统计 Then 只有孤儿被计入 orphanCount', async () => {
    createSessionWithExternalizedPayload()
    writeOrphanBlob('orphan-one')
    writeOrphanBlob('orphan-two')

    const category = await blobsCategory()

    expect(category.count).toBe(3)          // 1 被引用 + 2 孤儿
    expect(category.orphanCount).toBe(2)
    expect(category.orphanBytes).toBeGreaterThan(0)
  })

  test('Given 没有任何 blob When 统计 Then 该项为 0 且无孤儿', async () => {
    const category = await blobsCategory()
    expect(category.count).toBe(0)
    expect(category.bytes).toBe(0)
    expect(category.orphanCount).toBe(0)
  })
})

describe('孤儿清理 · 只删没被引用的载荷', () => {
  test('Given 混合 When 清理孤儿 Then 在用的保留、孤儿删除', async () => {
    createSessionWithExternalizedPayload()
    const usedPath = findOnlyBlobPath()          // 真实写入路径造出来的那个被引用的 blob
    const orphanPath = writeOrphanBlob('to-be-removed')

    expect(existsSync(usedPath)).toBe(true)
    expect(existsSync(orphanPath)).toBe(true)

    const result = await storageService.cleanupStorage({ categories: ['session-blobs'], orphansOnly: true, archivedBeforeDays: 0 })

    // 关键安全断言：在用的那条绝不能被删
    expect(existsSync(usedPath)).toBe(true)
    expect(existsSync(orphanPath)).toBe(false)
    expect(result.deletedCount).toBe(1)
    expect(result.freedBytes).toBeGreaterThan(0)
  })

  test('Given 只有被引用载荷 When 清理孤儿 Then 一个都不删', async () => {
    createSessionWithExternalizedPayload()
    const before = await blobsCategory()

    const result = await storageService.cleanupStorage({ categories: ['session-blobs'], orphansOnly: true, archivedBeforeDays: 0 })

    expect(result.deletedCount).toBe(0)
    const after = await blobsCategory()
    expect(after.count).toBe(before.count)
    expect(after.count).toBe(1)
  })

  test('Given 清理完 When 再统计 Then 孤儿归零', async () => {
    createSessionWithExternalizedPayload()
    writeOrphanBlob('o1')
    writeOrphanBlob('o2')

    await storageService.cleanupStorage({ categories: ['session-blobs'], orphansOnly: true, archivedBeforeDays: 0 })

    const category = await blobsCategory()
    expect(category.orphanCount).toBe(0)
    expect(category.count).toBe(1)
  })
})

/** 在 blob 目录里找出唯一的文件的完整路径（即被引用的那个） */
function findOnlyBlobPath(): string {
  const found: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walk(full)
      else if (!entry.includes('.tmp-')) found.push(full)
    }
  }
  walk(blobStore.blobRootDir())
  expect(found).toHaveLength(1)
  return found[0]!
}

// ─── 文件检查点 ───────────────────────────────────────────────────────────────

/** 造一份复制引擎快照：清单里直接记字节数 */
function writeCopyCheckpoint(sessionId: string, id: string, bytes: number): string {
  const dir = join(configPaths.getPiCheckpointsDir(), sessionId, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '.manifest.json'), JSON.stringify({ version: 2, bytes, files: ['a.txt', 'b.txt'] }))
  return dir
}

/**
 * 造一份 git 引擎快照：清单里的 repoBytes 是「创建时仓库总量」，会随回收变小，
 * 因此统计必须以 shadow.git 实际占用为准，不能相加清单里的数。
 */
function writeGitCheckpoint(sessionId: string, id: string, objectBytes: number, claimedRepoBytes = 50_000): string {
  const sessionDir = join(configPaths.getPiCheckpointsDir(), sessionId)
  mkdirSync(sessionDir, { recursive: true })
  writeFileSync(join(sessionDir, `${id}.json`), JSON.stringify({ version: 3, repoBytes: claimedRepoBytes, files: ['a.txt'] }))
  const objectsDir = join(sessionDir, 'shadow.git', 'objects')
  mkdirSync(objectsDir, { recursive: true })
  writeFileSync(join(objectsDir, id), 'x'.repeat(objectBytes))
  return sessionDir
}

async function checkpointsCategory(): Promise<{ bytes: number; count: number; orphanBytes: number; orphanCount: number; archivedBytes?: number; archivedSessions?: number }> {
  const stats = await storageService.calculateStorageStats()
  const category = stats.categories.find((c) => c.key === 'agent-checkpoints')
  expect(category).toBeDefined()
  return category!
}

describe('存储统计 · 文件检查点', () => {
  test('Given 复制快照与 git 快照 When 统计 Then 两者都计入且不重复计算影子仓库', async () => {
    const session = sessions.createAgentSession('checkpoint copy')
    writeCopyCheckpoint(session.id, 'snap-1', 1000)

    const gitSession = sessions.createAgentSession('checkpoint git')
    // 同一会话两份 git 快照共用仓库：两份对象各 4000 字节，清单却都声称仓库有 50KB
    writeGitCheckpoint(gitSession.id, 'snap-1', 4000)
    writeGitCheckpoint(gitSession.id, 'snap-2', 4000)

    const category = await checkpointsCategory()

    // 1KB 复制快照 + 8KB 对象；清单里的 50KB 是创建时快照，不能参与相加
    expect(category.bytes).toBeGreaterThan(9000)
    expect(category.bytes).toBeLessThan(12000)
    expect(category.orphanCount).toBe(0)
  })

  test('Given 会话已不存在 When 统计 Then 记为孤儿并可清理', async () => {
    // 会话 ID 不在索引里 = 已删除会话留下的残留目录（直接删会话会连检查点一起清，造不出孤儿）
    const orphanId = '11111111-2222-3333-4444-555555555555'
    const dir = writeCopyCheckpoint(orphanId, 'snap-1', 2000)

    const before = await checkpointsCategory()
    expect(before.orphanCount).toBe(2)          // 清单里记的两个文件
    expect(existsSync(dir)).toBe(true)

    const result = await storageService.cleanupStorage({ categories: ['agent-checkpoints'], orphansOnly: true, archivedBeforeDays: 0 })

    expect(existsSync(dir)).toBe(false)
    expect(result.deletedCount).toBe(1)
    const after = await checkpointsCategory()
    expect(after.bytes).toBe(0)
  })

  test('Given 已归档会话 When 普通归档清理 Then 检查点不动；显式回收才删', async () => {
    const session = sessions.createAgentSession('checkpoint archived')
    const dir = writeCopyCheckpoint(session.id, 'snap-1', 3000)
    sessions.updateAgentSessionMeta(session.id, { archived: true })

    const before = await checkpointsCategory()
    expect(before.archivedSessions).toBe(1)
    expect(before.archivedBytes).toBeGreaterThan(0)

    // 只按归档天数清理消息文件：检查点必须原样保留
    await storageService.cleanupStorage({ categories: ['agent-checkpoints'], orphansOnly: false, archivedBeforeDays: 1 })
    expect(existsSync(dir)).toBe(true)

    const result = await storageService.cleanupStorage({
      categories: ['agent-checkpoints'],
      orphansOnly: false,
      archivedBeforeDays: 0,
      includeArchivedSessions: true,
    })

    expect(existsSync(dir)).toBe(false)
    expect(result.deletedCount).toBe(1)
    const after = await checkpointsCategory()
    expect(after.bytes).toBe(0)
  })
})

describe('归档数据清理 · Pi 原生会话文件', () => {
  test('Given 已归档且超期的 Pi 会话 When 按天数清理 Then 消息文件与原生 JSONL 一起删除', async () => {
    const session = sessions.createAgentSession('pi archived')
    const sdkId = '01a1aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee'
    sessions.updateAgentSessionMeta(session.id, { sdkSessionId: sdkId, agentRuntime: 'pi', archived: true })

    const messagePath = join(configPaths.getAgentSessionsDir(), `${session.id}.jsonl`)
    writeFileSync(messagePath, '{"type":"user"}\n')

    const piDir = join(configPaths.getSdkConfigDir(), 'sessions', 'pi')
    mkdirSync(piDir, { recursive: true })
    const piFile = join(piDir, `2026-09-01T00-00-00-000Z_${sdkId}.jsonl`)
    writeFileSync(piFile, `${JSON.stringify({ type: 'session', version: 3, id: sdkId, cwd: root })}\n`)

    // 把 updatedAt 推到 40 天前：清理只处理「归档且超期」的会话
    const indexPath = join(configPaths.getConfigDir(), 'agent-sessions.json')
    const index = JSON.parse(readFileSync(indexPath, 'utf-8')) as { sessions: Array<{ id: string; updatedAt: number }> }
    const target = index.sessions.find((item) => item.id === session.id)
    expect(target).toBeDefined()
    target!.updatedAt = Date.now() - 40 * 24 * 60 * 60 * 1000
    writeFileSync(indexPath, JSON.stringify(index))

    const result = await storageService.cleanupStorage({ categories: ['sdk-config'], orphansOnly: false, archivedBeforeDays: 30 })

    expect(existsSync(messagePath)).toBe(false)
    expect(existsSync(piFile)).toBe(false)
    expect(result.deletedCount).toBe(2)
  })
})

// ─── Agent 会话文件（消息 + 侧车）────────────────────────────────────────────

/** 在 agent-sessions 目录里写一个指定文件名的会话文件，返回其绝对路径 */
function writeSessionFile(fileName: string, content: string): string {
  const path = join(configPaths.getAgentSessionsDir(), fileName)
  writeFileSync(path, content)
  return path
}

const agentSessionsCategory = async (): Promise<{ bytes: number; count: number; orphanBytes: number; orphanCount: number }> => {
  const stats = await storageService.calculateStorageStats()
  const category = stats.categories.find((c) => c.key === 'agent-sessions')
  expect(category).toBeDefined()
  return category!
}

describe('会话文件名解析', () => {
  test('Given 消息文件与两种侧车 When 解析 Then 回到同一个 baseSessionId', () => {
    // UUID 本身含 '-'：绝不能按第一段切
    const id = '0f9c1a2b-3d4e-4f5a-8b6c-7d8e9f0a1b2c'

    expect(storageService.parseAgentSessionFileName(`${id}.jsonl`))
      .toEqual({ baseSessionId: id, kind: 'messages' })
    expect(storageService.parseAgentSessionFileName(`${id}-graph.jsonl`))
      .toEqual({ baseSessionId: id, kind: 'graph' })
    expect(storageService.parseAgentSessionFileName(`${id}-pi-harness.jsonl`))
      .toEqual({ baseSessionId: id, kind: 'pi-harness' })
  })

  test('Given 非 .jsonl 或无会话 ID When 解析 Then 返回 null', () => {
    expect(storageService.parseAgentSessionFileName('notes.txt')).toBeNull()
    expect(storageService.parseAgentSessionFileName('session.json')).toBeNull()
    expect(storageService.parseAgentSessionFileName('.jsonl')).toBeNull()
    expect(storageService.parseAgentSessionFileName('-graph.jsonl')).toBeNull()
    expect(storageService.parseAgentSessionFileName('-pi-harness.jsonl')).toBeNull()
  })
})

describe('孤儿清理 · 会话侧车文件', () => {
  test('Given 活跃会话带侧车、已删除会话带侧车 When 统计 Then 只把已删除会话的三个文件算孤儿', async () => {
    const active = sessions.createAgentSession('active with sidecars')
    writeSessionFile(`${active.id}.jsonl`, '{"type":"user"}\n')
    writeSessionFile(`${active.id}-graph.jsonl`, '{"graph":1}\n')
    writeSessionFile(`${active.id}-pi-harness.jsonl`, '{"harness":1}\n')

    // 索引里不存在这个会话：模拟会话被删除后残留的三件套
    const orphanId = '11111111-2222-3333-4444-555555555555'
    writeSessionFile(`${orphanId}.jsonl`, 'x'.repeat(100))
    writeSessionFile(`${orphanId}-graph.jsonl`, 'x'.repeat(200))
    writeSessionFile(`${orphanId}-pi-harness.jsonl`, 'x'.repeat(300))

    const category = await agentSessionsCategory()

    expect(category.count).toBe(6)
    // 关键断言：活跃会话的侧车不能计入孤儿
    expect(category.orphanCount).toBe(3)
    expect(category.orphanBytes).toBe(600)
  })

  test('Given 活跃会话带侧车、已删除会话带侧车 When 清理孤儿 Then 活跃三件套全保留、孤儿三件套删除', async () => {
    const active = sessions.createAgentSession('active with sidecars')
    const activeFiles = [
      writeSessionFile(`${active.id}.jsonl`, '{"type":"user"}\n'),
      writeSessionFile(`${active.id}-graph.jsonl`, '{"graph":1}\n'),
      writeSessionFile(`${active.id}-pi-harness.jsonl`, '{"harness":1}\n'),
    ]

    const orphanId = '11111111-2222-3333-4444-555555555555'
    const orphanFiles = [
      writeSessionFile(`${orphanId}.jsonl`, 'x'.repeat(100)),
      writeSessionFile(`${orphanId}-graph.jsonl`, 'x'.repeat(200)),
      writeSessionFile(`${orphanId}-pi-harness.jsonl`, 'x'.repeat(300)),
    ]

    const result = await storageService.cleanupStorage({ categories: ['agent-sessions'], orphansOnly: true, archivedBeforeDays: 0 })

    expect(result.deletedCount).toBe(3)
    expect(result.freedBytes).toBe(600)
    expect(result.errors).toEqual([])

    // 关键安全断言：活跃会话的消息与两种侧车一个都不能少
    for (const path of activeFiles) expect(existsSync(path)).toBe(true)
    for (const path of orphanFiles) expect(existsSync(path)).toBe(false)

    const after = await agentSessionsCategory()
    expect(after.count).toBe(3)
    expect(after.orphanCount).toBe(0)
  })

  test('Given 解析不出会话 ID 的 .jsonl When 统计并清理 Then 计入总量但不算孤儿、不被删除', async () => {
    // 空索引是合法 fixture；缺索引且有历史文件属于恢复保护，不属于孤儿清理。
    writeFileSync(join(configPaths.getConfigDir(), 'agent-sessions.json'), JSON.stringify({ version: 1, sessions: [] }))
    const unparsable = writeSessionFile('.jsonl', 'y'.repeat(50))

    const before = await agentSessionsCategory()
    expect(before.count).toBe(1)
    expect(before.orphanCount).toBe(0)

    const result = await storageService.cleanupStorage({ categories: ['agent-sessions'], orphansOnly: true, archivedBeforeDays: 0 })

    expect(result.deletedCount).toBe(0)
    expect(existsSync(unparsable)).toBe(true)
  })
})
