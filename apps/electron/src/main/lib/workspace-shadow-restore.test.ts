/**
 * 回退执行入口的行为测试（Phase 3）。
 *
 * 这里验证的是「编排正确」，不是合并算法（那在 session-store 里测）：
 * 1. 保护快照先于写盘，采不到就不动文件；
 * 2. journal 有 pending → completed，崩溃可见性成立；
 * 3. 写盘后补 `rewind-after` 边界，历史里能看出「回退发生过」；
 * 4. 没有归属记录时拒绝执行，而不是「猜一个边界」。
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readShadowRestoreJournal, waitForWorkspaceShadowIdle } from '@profer/session-store'

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

let root = ''
let projectRoot = ''
const WORKSPACE_ID = 'workspace-restore-test'
const SESSION_ID = 'session-restore'

let shadowTurns: typeof import('./workspace-shadow-turns')
let shadowGit: typeof import('./workspace-shadow-git')
let shadowRestore: typeof import('./workspace-shadow-restore')

function writeWorkspaceIndex(): void {
  writeFileSync(
    join(root, 'agent-workspaces.json'),
    JSON.stringify({
      version: 4,
      workspaces: [
        {
          id: WORKSPACE_ID,
          name: '回退测试',
          slug: 'restore-test',
          createdAt: 1,
          updatedAt: 1,
          type: 'personal',
          storageMode: 'project',
          rootPath: projectRoot,
        },
      ],
    }),
    'utf8',
  )
}

/** 跑一轮完整的 turn 边界：initial → Agent 写文件 → turn-after。 */
async function runTurn(options: { relativePath: string; content: string }): Promise<string> {
  await shadowTurns.beginWorkspaceShadowTurn(WORKSPACE_ID)
  const target = join(projectRoot, options.relativePath)
  mkdirSync(join(target, '..'), { recursive: true })
  writeFileSync(target, options.content, 'utf8')
  shadowTurns.endWorkspaceShadowTurn(WORKSPACE_ID, {
    sessionId: SESSION_ID,
    turnId: 'user-msg-restore',
    runtime: 'pi',
    evidence: [{ seq: 1, path: target, source: 'write' }],
  })
  await waitForWorkspaceShadowIdle(WORKSPACE_ID)
  return target
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'profer-shadow-restore-'))
  projectRoot = join(root, 'project')
  mkdirSync(join(projectRoot, 'src'), { recursive: true })
  writeFileSync(join(projectRoot, 'src', 'keep.ts'), 'export const keep = 1\n', 'utf8')
  process.env.PROFER_CONFIG_DIR = root
  writeWorkspaceIndex()
  const cacheKey = `${Date.now()}-${Math.random()}`
  shadowTurns = await import(`./workspace-shadow-turns?restore-test=${cacheKey}`)
  shadowGit = await import(`./workspace-shadow-git?restore-test=${cacheKey}`)
  shadowRestore = await import(`./workspace-shadow-restore?restore-test=${cacheKey}`)
})

afterEach(() => {
  delete process.env.PROFER_CONFIG_DIR
  if (root) rmSync(root, { recursive: true, force: true })
})

describe('restoreWorkspaceShadowTurn', () => {
  test('Agent 新建的文件被删除，journal 有 pending→completed 与保护快照', async () => {
    const created = await runTurn({ relativePath: 'src/agent.ts', content: 'export const agent = 1\n' })
    expect(existsSync(created)).toBe(true)

    const result = await shadowRestore.restoreWorkspaceShadowTurn({
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      turnId: 'user-msg-restore',
    })

    expect(result.ok).toBe(true)
    expect(result.counts).toMatchObject({ deleted: 1 })
    expect(existsSync(created)).toBe(false)
    // 用户自己的文件不能被牵连。
    expect(readFileSync(join(projectRoot, 'src', 'keep.ts'), 'utf8')).toBe('export const keep = 1\n')

    expect(result.protectionCommitId).toBeTruthy()
    const journal = readShadowRestoreJournal(shadowGit.getWorkspaceShadowDir(WORKSPACE_ID))
    expect(journal.map((entry) => entry.status)).toEqual(['pending', 'completed'])
    expect(journal[1]?.counts).toMatchObject({ deleted: 1 })
    expect(journal[1]?.outcomes?.[0]).toMatchObject({ action: 'delete' })
    // pending 里必须已经有计划：中途崩溃后才知道原本打算动哪些文件。
    expect(journal[0]?.outcomes?.length).toBe(1)
    expect(journal[0]?.outcomes?.[0]).toMatchObject({ action: 'delete' })
  })

  test('回退后补 rewind-before / rewind-after 边界，历史里能看出回退发生过', async () => {
    await runTurn({ relativePath: 'src/agent.ts', content: 'export const agent = 1\n' })
    await shadowRestore.restoreWorkspaceShadowTurn({
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      turnId: 'user-msg-restore',
    })

    const journalPath = shadowGit.getWorkspaceShadowJournalPath(WORKSPACE_ID)
    const parsed = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: Array<{ reason: string }> }
    const reasons = parsed.entries.map((entry) => entry.reason)
    expect(reasons).toContain('rewind-before')
    expect(reasons).toContain('rewind-after')
    // 顺序也重要：保护快照必须早于回退后的边界。
    expect(reasons.indexOf('rewind-before')).toBeLessThan(reasons.indexOf('rewind-after'))
  })

  test('dryRun 不写盘、不产生保护快照、不写 journal', async () => {
    const created = await runTurn({ relativePath: 'src/agent.ts', content: 'export const agent = 1\n' })

    const result = await shadowRestore.restoreWorkspaceShadowTurn({
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      turnId: 'user-msg-restore',
      dryRun: true,
    })

    expect(result.ok).toBe(true)
    expect(result.counts).toMatchObject({ deleted: 1 })
    expect(existsSync(created)).toBe(true)
    expect(readShadowRestoreJournal(shadowGit.getWorkspaceShadowDir(WORKSPACE_ID))).toEqual([])
  })

  test('早期记录缺少 roots/changes：不报错也不写盘', async () => {
    const dir = shadowGit.getWorkspaceShadowDir(WORKSPACE_ID)
    mkdirSync(dir, { recursive: true })
    // Phase 2-B1 之前的记录长这样：没有 roots 快照、没有 changes。
    writeFileSync(
      join(dir, 'turns.jsonl'),
      `${JSON.stringify({ schemaVersion: 1, workspaceId: WORKSPACE_ID, sessionId: SESSION_ID, turnId: 'legacy-turn', createdAt: 1 })}\n`,
      'utf8',
    )

    const result = await shadowRestore.restoreWorkspaceShadowTurn({
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      turnId: 'legacy-turn',
    })

    expect(result.ok).toBe(true)
    expect(result.entries).toEqual([])
    // 没有变化就不该采保护快照、也不该往 restore journal 写东西。
    expect(readShadowRestoreJournal(dir)).toEqual([])
  })

  test('找不到归属记录时拒绝执行（不猜边界）', async () => {
    await shadowTurns.beginWorkspaceShadowTurn(WORKSPACE_ID)
    const result = await shadowRestore.restoreWorkspaceShadowTurn({
      workspaceId: WORKSPACE_ID,
      sessionId: 'someone-else',
      turnId: 'unknown-turn',
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('找不到该轮次的归属记录')
    expect(result.counts).toEqual({ restored: 0, deleted: 0, kept: 0, skipped: 0 })
  })
})
