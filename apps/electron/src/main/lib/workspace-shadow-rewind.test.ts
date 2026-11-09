/**
 * Phase 4：目标边界 → 需要撤销的 turn（只读解析，不写盘）。
 *
 * 这里刻意写「手搓」的归属记录：真实数据里会出现 partial、unconfirmed、
 * 同一路径多轮改动这些形状，边界算错一个 turn 就会多撤或少撤一轮。
 *
 * 边界用「最后保留那轮的下标 + 1」表示：会话层与文件层共用同一次换算，
 * 避免两套 turn 词表（合成 id vs 用户消息 uuid）各解一次导致错位。
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (v: string) => Buffer.from(v), decryptString: (v: Buffer) => v.toString() },
  screen: {},
  shell: {},
  systemPreferences: {},
}))

const WORKSPACE_ID = 'workspace-rewind-shadow'
const SESSION_ID = 'session-rewind-shadow'
let root = ''
let rewind: typeof import('./workspace-shadow-rewind')

function change(overrides: Record<string, unknown>) {
  return {
    rootId: 'main',
    path: 'src/a.ts',
    absolutePath: '/tmp/project/src/a.ts',
    status: 'modified',
    attribution: 'confirmed',
    boundarySource: 'shadow-git',
    ...overrides,
  }
}

const records = [
  {
    schemaVersion: 1,
    workspaceId: WORKSPACE_ID,
    sessionId: SESSION_ID,
    turnId: 'T1',
    createdAt: 1,
    beforeCommitId: 'b1',
    afterCommitId: 'a1',
    roots: [{ rootId: 'main', rootPath: '/tmp/project', kind: 'workspace-root' }],
    changes: [
      change({ path: 'src/a.ts' }),
      // 同一路径在 T1、T2 都改过：计划里只能出现一次。
      change({ path: 'src/shared.ts', absolutePath: '/tmp/project/src/shared.ts' }),
      // 没有写入证据：不能撤销。
      change({ path: 'src/bash-only.ts', absolutePath: '/tmp/project/src/bash-only.ts', attribution: 'unconfirmed' }),
      // 树差异说是新增，但写入前已有内容：用户自建文件，不能报成 delete。
      change({ path: 'src/preexisting.ts', absolutePath: '/tmp/project/src/preexisting.ts', status: 'added', preexisting: true }),
    ],
  },
  {
    schemaVersion: 1,
    workspaceId: WORKSPACE_ID,
    sessionId: SESSION_ID,
    turnId: 'T2',
    createdAt: 2,
    partial: true,
    beforeCommitId: 'a1',
    afterCommitId: 'a2',
    roots: [{ rootId: 'main', rootPath: '/tmp/project', kind: 'workspace-root' }],
    changes: [
      change({ path: 'src/shared.ts', absolutePath: '/tmp/project/src/shared.ts', status: 'added' }),
      change({ path: 'src/created.ts', absolutePath: '/tmp/project/src/created.ts', status: 'added' }),
      change({ path: 'src/gone.ts', absolutePath: '/tmp/project/src/gone.ts', status: 'deleted' }),
    ],
  },
]

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'profer-shadow-rewind-'))
  process.env.PROFER_CONFIG_DIR = root
  writeFileSync(
    join(root, 'agent-sessions.json'),
    JSON.stringify({
      version: 1,
      sessions: [
        { id: SESSION_ID, workspaceId: WORKSPACE_ID, agentRuntime: 'pi', title: '回退测试', createdAt: 1, updatedAt: 1 },
      ],
    }),
    'utf8',
  )
  const dir = join(root, 'workspace-shadow', WORKSPACE_ID)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'turns.jsonl'), records.map((record) => JSON.stringify(record)).join('\n') + '\n', 'utf8')
  const cacheKey = `${Date.now()}-${Math.random()}`
  rewind = await import(`./workspace-shadow-rewind?rewind-test=${cacheKey}`)
})

afterEach(() => {
  delete process.env.PROFER_CONFIG_DIR
  if (root) rmSync(root, { recursive: true, force: true })
})

describe('resolveWorkspaceShadowRewind', () => {
  test('从第 1 轮开始撤：同一路径只出现一次', async () => {
    const resolved = await rewind.resolveWorkspaceShadowRewind({ sessionId: SESSION_ID, fromTurnIndex: 0 })
    expect(resolved.available).toBe(true)
    expect(resolved.turns).toEqual(['T1', 'T2'])
    const paths = resolved.items.map((item) => item.path)
    expect(paths.filter((path) => path.endsWith('src/shared.ts'))).toHaveLength(1)
    // T2 里 shared.ts 是「新建」且记录 partial：撤销它等于删除，不能做。
    expect(resolved.items.find((item) => item.path.endsWith('src/shared.ts'))?.action).toBe('keep')
  })

  test('从第 2 轮开始撤：只撤之后那一轮', async () => {
    const resolved = await rewind.resolveWorkspaceShadowRewind({ sessionId: SESSION_ID, fromTurnIndex: 1 })
    expect(resolved.turns).toEqual(['T2'])
  })

  test('边界之后没有记录时范围为空（回退目标是最新一轮）', async () => {
    const resolved = await rewind.resolveWorkspaceShadowRewind({ sessionId: SESSION_ID, fromTurnIndex: 2 })
    expect(resolved.available).toBe(true)
    expect(resolved.turns).toEqual([])
    expect(resolved.items).toEqual([])
  })

  test('没有写入证据与 partial 新建都不进入写盘动作', async () => {
    const resolved = await rewind.resolveWorkspaceShadowRewind({ sessionId: SESSION_ID, fromTurnIndex: 0 })
    const byPath = new Map(resolved.items.map((item) => [item.path, item]))
    expect(byPath.get('/tmp/project/src/bash-only.ts')).toMatchObject({ action: 'keep', reason: 'unconfirmed-change' })
    // 写入前已有内容（用户自建）：与 reverse-patch 的 keep-current 同口径。
    expect(byPath.get('/tmp/project/src/preexisting.ts')).toMatchObject({ action: 'keep', reason: 'preexisting-file' })
    // partial 新建只恢复、不删除。
    expect(byPath.get('/tmp/project/src/created.ts')).toMatchObject({ action: 'keep', reason: 'partial-evidence' })
    // 删除是可确认的恢复动作（partial 只禁止删，不禁止恢复）。
    expect(byPath.get('/tmp/project/src/gone.ts')).toMatchObject({ action: 'restore' })
    expect(byPath.get('/tmp/project/src/a.ts')).toMatchObject({ action: 'restore' })
  })

  test('计划计数与 reverse-patch 对齐：preexisting 不算 delete', async () => {
    const resolved = await rewind.resolveWorkspaceShadowRewind({ sessionId: SESSION_ID, fromTurnIndex: 0 })
    // 已确认的删除一个也没有：created/preexisting 是用户自建，partial 新建不删。
    expect(resolved.counts).toEqual({ restore: 2, delete: 0, keep: 4 })
    expect(resolved.items.filter((item) => item.action === 'delete')).toEqual([])
  })

  test('无归属记录时明确不可用，而不是猜边界', async () => {
    const other = await rewind.resolveWorkspaceShadowRewind({ sessionId: 'session-without-records', fromTurnIndex: 0 })
    expect(other.available).toBe(false)
    expect(other.turns).toEqual([])
  })
})
