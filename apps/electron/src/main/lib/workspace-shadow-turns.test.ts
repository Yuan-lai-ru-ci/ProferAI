/**
 * turn 边界采集入口的行为测试。
 *
 * 这里不测 git（那在 @profer/session-store 里），只锁三件编排器依赖的契约：
 * 1. 没有底座时，begin 返回 promise 并真的建立首个基线；
 * 2. 有底座且队列空闲时，begin 返回 **undefined**——编排器据此保持「取得执行权后同步可见」的时序，
 *    这条一旦退化成返回 promise，会让所有「同步占用会话」的断言失效（真实回归成本很高）；
 * 3. end 在后台补 turn-after，begin 能等到它落盘。
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { readShadowForkRelation, readShadowTurnAttributions, waitForWorkspaceShadowIdle } from '@profer/session-store'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getAgentWorkspace } from './agent-workspace-manager'

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
const WORKSPACE_ID = 'workspace-turns-test'
let shadowTurns: typeof import('./workspace-shadow-turns')
let shadowGit: typeof import('./workspace-shadow-git')

function writeWorkspaceIndex(): void {
  const workspace = {
    id: WORKSPACE_ID,
    name: 'turn 边界测试',
    slug: 'turns-test',
    createdAt: 1,
    updatedAt: 1,
    type: 'personal',
    storageMode: 'project',
    rootPath: projectRoot,
  }
  writeFileSync(join(root, 'agent-workspaces.json'), JSON.stringify({ version: 4, workspaces: [workspace] }), 'utf8')
}

function journalReasons(): string[] {
  const path = join(root, 'workspace-shadow', WORKSPACE_ID, 'journal.json')
  if (!existsSync(path)) return []
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { entries?: Array<{ reason?: string }> }
  return (parsed.entries ?? []).map((entry) => entry.reason ?? '')
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'profer-shadow-turns-'))
  projectRoot = join(root, 'project')
  mkdirSync(join(projectRoot, 'src'), { recursive: true })
  writeFileSync(join(projectRoot, 'src', 'app.ts'), 'export {}\n', 'utf8')
  process.env.PROFER_CONFIG_DIR = root
  writeWorkspaceIndex()
  const cacheKey = `${Date.now()}-${Math.random()}`
  shadowTurns = await import(`./workspace-shadow-turns?shadow-turns-test=${cacheKey}`)
  shadowGit = await import(`./workspace-shadow-git?shadow-turns-test=${cacheKey}`)
})

afterEach(() => {
  delete process.env.PROFER_CONFIG_DIR
  if (root) rmSync(root, { recursive: true, force: true })
})

describe('beginWorkspaceShadowTurn / endWorkspaceShadowTurn', () => {
  test('首个基线：begin 返回 promise 并写入 initial 记录', async () => {
    const pending = shadowTurns.beginWorkspaceShadowTurn(WORKSPACE_ID)
    expect(pending).toBeInstanceOf(Promise)
    await pending

    expect(existsSync(join(root, 'workspace-shadow', WORKSPACE_ID, 'repo.git'))).toBe(true)
    expect(journalReasons()).toContain('initial')
  })

  test('已有底座：begin 也采一次 turn-before（用户在两轮之间改过的文件不能被算成 Agent 操作）', async () => {
    await shadowTurns.beginWorkspaceShadowTurn(WORKSPACE_ID)
    // 每轮开头都要采：否则「用户两轮之间新建的文件」会被记成 Agent 新建。
    await shadowTurns.beginWorkspaceShadowTurn(WORKSPACE_ID)
    expect(journalReasons()).toContain('turn-before')
  })

  test('end 后台补 turn-after，begin 能等到它落盘', async () => {
    await shadowTurns.beginWorkspaceShadowTurn(WORKSPACE_ID)
    shadowTurns.endWorkspaceShadowTurn(WORKSPACE_ID)

    const pending = shadowTurns.beginWorkspaceShadowTurn(WORKSPACE_ID)
    expect(pending).toBeInstanceOf(Promise)
    await pending

    const reasons = journalReasons()
    expect(reasons).toContain('turn-after')
    // begin 采完 turn-before 后队列必须回到空闲，且 turn-before 一定发生在 turn-after 之后。
    await shadowTurns.beginWorkspaceShadowTurn(WORKSPACE_ID)
    const after = journalReasons()
    expect(after.lastIndexOf('turn-before')).toBeGreaterThan(after.indexOf('turn-after'))
  })

  test('工作区未知 / id 非法：两个入口都安静返回，不抛错', async () => {
    expect(shadowTurns.beginWorkspaceShadowTurn(undefined)).toBeUndefined()
    expect(shadowTurns.beginWorkspaceShadowTurn('not-exist')).toBeUndefined()
    expect(() => shadowTurns.endWorkspaceShadowTurn(undefined)).not.toThrow()
    expect(() => shadowTurns.endWorkspaceShadowTurn('not-exist')).not.toThrow()
  })
})

describe('turn 归属记录（Phase 2）', () => {
  test('有会话身份时：turn-after 落盘后写入 diff × 证据的归属记录', async () => {
    await shadowTurns.beginWorkspaceShadowTurn(WORKSPACE_ID)
    writeFileSync(join(projectRoot, 'src', 'agent.ts'), 'export const a = 1\n', 'utf8')

    shadowTurns.endWorkspaceShadowTurn(WORKSPACE_ID, {
      sessionId: 'session-1',
      turnId: 'user-msg-1',
      runtime: 'pi',
      evidence: [
        { seq: 1, toolName: 'write', path: join(projectRoot, 'src', 'agent.ts'), source: 'write' },
        { seq: 2, toolName: 'edit', path: join(projectRoot, 'src', 'noop.ts'), source: 'edit' },
      ],
    })
    await waitForWorkspaceShadowIdle(WORKSPACE_ID)

    const records = readShadowTurnAttributions(shadowGit.getWorkspaceShadowDir(WORKSPACE_ID))
    expect(records).toHaveLength(1)
    const record = records[0]!
    expect(record).toMatchObject({
      sessionId: 'session-1',
      turnId: 'user-msg-1',
      turnIdSource: 'user-message',
      runtime: 'pi',
      partial: false,
    })
    expect(record.beforeCommitId).toBeTruthy()
    expect(record.afterCommitId).not.toBe(record.beforeCommitId)
    // 树差异里唯一的变化就是这次受控写入 → confirmed。
    expect(record.changes.map((change) => [change.path, change.status, change.attribution])).toEqual([
      ['src/agent.ts', 'added', 'confirmed'],
    ])
    // 证据里有、树里没有的写入要单独记下（写入失败/改回原样），不能悄悄丢掉。
    expect(record.unchangedEvidence.map((item) => item.reason)).toEqual(['no-net-change'])
  })

  test('没有会话身份时：采集照做，但不写归属记录（不伪造「谁都不是」的归属）', async () => {
    await shadowTurns.beginWorkspaceShadowTurn(WORKSPACE_ID)
    writeFileSync(join(projectRoot, 'src', 'manual.ts'), 'export {}\n', 'utf8')
    shadowTurns.endWorkspaceShadowTurn(WORKSPACE_ID, { runtime: 'pi' })
    await waitForWorkspaceShadowIdle(WORKSPACE_ID)

    expect(journalReasons()).toContain('turn-after')
    expect(readShadowTurnAttributions(shadowGit.getWorkspaceShadowDir(WORKSPACE_ID))).toEqual([])
  })
})

describe('turn 身份来源（Phase 2）', () => {
  test('没有用户消息 uuid 时用采集 id 兜底，并标记 turnIdSource=capture', async () => {
    await shadowTurns.beginWorkspaceShadowTurn(WORKSPACE_ID)
    shadowTurns.endWorkspaceShadowTurn(WORKSPACE_ID, { sessionId: 'session-2', runtime: 'pi' })
    await waitForWorkspaceShadowIdle(WORKSPACE_ID)

    const [record] = readShadowTurnAttributions(shadowGit.getWorkspaceShadowDir(WORKSPACE_ID))
    expect(record?.turnIdSource).toBe('capture')
    expect(record?.turnId).toBeTruthy()
    expect(record?.turnId).not.toBe('user-msg-1')
  })
})

describe('会话级附加目录与根集合变化（Phase 2-B）', () => {
  function makeAttachedDir(name: string): string {
    const dir = join(root, name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'note.md'), '# note\n', 'utf8')
    return dir
  }

  test('会话附加目录纳入采集：新根的文件标 rootIntroduced，不进「Agent 新建」', async () => {
    await shadowTurns.beginWorkspaceShadowTurn(WORKSPACE_ID)
    const attachedDir = makeAttachedDir('attached-session')

    shadowTurns.endWorkspaceShadowTurn(WORKSPACE_ID, {
      sessionId: 'session-attached',
      turnId: 'user-msg-attached',
      runtime: 'pi',
      sessionAttachedDirectories: [attachedDir],
      evidence: [{ seq: 1, path: join(attachedDir, 'note.md'), source: 'write', toolName: 'Write' }],
    })
    await waitForWorkspaceShadowIdle(WORKSPACE_ID)

    const [record] = readShadowTurnAttributions(shadowGit.getWorkspaceShadowDir(WORKSPACE_ID))
    expect(record?.roots.map((entry) => entry.kind)).toEqual(['project', 'attached'])
    expect(record?.rootSetChanges?.added).toEqual([record?.roots[1]?.rootId ?? ''])
    const change = record?.changes.find((item) => item.path === 'note.md')
    expect(change).toMatchObject({ status: 'added', attribution: 'confirmed', rootIntroduced: true })
    // 根路径先 realpath（macOS /var → /private/var），记录里的绝对路径必须是真实路径。
    expect(change?.absolutePath).toBe(realpathSync(join(attachedDir, 'note.md')))
  })

  test('会话取消附加目录：整根消失不算删除，rootSetChanges.removed 记录它', async () => {
    await shadowTurns.beginWorkspaceShadowTurn(WORKSPACE_ID)
    const attachedDir = makeAttachedDir('attached-removed')

    shadowTurns.endWorkspaceShadowTurn(WORKSPACE_ID, {
      sessionId: 'session-removed',
      turnId: 'user-msg-1',
      runtime: 'pi',
      sessionAttachedDirectories: [attachedDir],
    })
    await waitForWorkspaceShadowIdle(WORKSPACE_ID)
    const first = readShadowTurnAttributions(shadowGit.getWorkspaceShadowDir(WORKSPACE_ID), { sessionId: 'session-removed' })[0]
    const attachedRootId = first?.roots.find((entry) => entry.kind === 'attached')?.rootId
    expect(attachedRootId).toBeTruthy()

    // 第二轮不再附带这个目录：文件从 tree 里整体消失。
    shadowTurns.endWorkspaceShadowTurn(WORKSPACE_ID, {
      sessionId: 'session-removed',
      turnId: 'user-msg-2',
      runtime: 'pi',
    })
    await waitForWorkspaceShadowIdle(WORKSPACE_ID)

    const records = readShadowTurnAttributions(shadowGit.getWorkspaceShadowDir(WORKSPACE_ID), { sessionId: 'session-removed' })
    const second = records[1]!
    expect(second.rootSetChanges?.removed).toEqual([attachedRootId ?? ''])
    // 关键：整根消失不能变成「Agent 删了 note.md」。
    expect(second.changes.filter((item) => item.path === 'note.md')).toEqual([])
  })

  test('分叉：记录分叉关系，并在新会话第一条 turn 记录上带 forkOf', async () => {
    await shadowTurns.beginWorkspaceShadowTurn(WORKSPACE_ID)
    shadowTurns.recordWorkspaceShadowFork({
      sourceSessionId: 'session-source',
      newSessionId: 'session-forked',
      workspaceId: WORKSPACE_ID,
      upToMessageUuid: 'user-msg-src',
    })
    await waitForWorkspaceShadowIdle(WORKSPACE_ID)

    const relation = readShadowForkRelation(shadowGit.getWorkspaceShadowDir(WORKSPACE_ID), 'session-forked')
    expect(relation).toMatchObject({ sourceSessionId: 'session-source', upToMessageUuid: 'user-msg-src' })
    expect(relation?.commitId).toBeTruthy()

    shadowTurns.endWorkspaceShadowTurn(WORKSPACE_ID, {
      sessionId: 'session-forked',
      turnId: 'user-msg-fork-1',
      runtime: 'pi',
    })
    await waitForWorkspaceShadowIdle(WORKSPACE_ID)
    shadowTurns.endWorkspaceShadowTurn(WORKSPACE_ID, {
      sessionId: 'session-forked',
      turnId: 'user-msg-fork-2',
      runtime: 'pi',
    })
    await waitForWorkspaceShadowIdle(WORKSPACE_ID)

    const records = readShadowTurnAttributions(shadowGit.getWorkspaceShadowDir(WORKSPACE_ID), { sessionId: 'session-forked' })
    expect(records).toHaveLength(2)
    expect(records[0]?.forkOf).toEqual({
      sourceSessionId: 'session-source',
      commitId: relation?.commitId,
      upToMessageUuid: 'user-msg-src',
    })
    // 只有第一条带：后续 turn 与分叉无关。
    expect(records[1]?.forkOf).toBeUndefined()
  })
})

describe('turn 边界不被轮中外采采集推后（Phase 2-C）', () => {
  test('轮中插入一次外部采集：本轮 changes 仍包含本轮写入', async () => {
    // 本轮 turn-before：拿到基线。
    const baseline = await shadowTurns.beginWorkspaceShadowTurn(WORKSPACE_ID)
    expect(baseline?.commitId).toBeTruthy()

    // Agent 本轮写入。
    writeFileSync(join(projectRoot, 'src', 'agent-mid-turn.ts'), 'export const mid = 1\n', 'utf8')

    // 轮中外部采集（启动对账 / 另一会话轮末 / fork-before）：它把本轮写入提成了自己的 commit，
    // 于是 turn-after 的 previousCommitId 已经是别人，不再是本轮 before。
    const foreign = await shadowGit.captureWorkspaceShadow({
      workspace: getAgentWorkspace(WORKSPACE_ID)!,
      reason: 'startup-reconcile',
    })
    expect(foreign?.ok).toBe(true)

    shadowTurns.endWorkspaceShadowTurn(WORKSPACE_ID, {
      sessionId: 'session-foreign-capture',
      turnId: 'user-msg-foreign',
      runtime: 'pi',
      ...(baseline ? { baseline } : {}),
      evidence: [{ seq: 1, toolName: 'write', path: join(projectRoot, 'src', 'agent-mid-turn.ts'), source: 'write' }],
    })
    await waitForWorkspaceShadowIdle(WORKSPACE_ID)

    const [record] = readShadowTurnAttributions(shadowGit.getWorkspaceShadowDir(WORKSPACE_ID), {
      sessionId: 'session-foreign-capture',
    })
    // before 必须是本轮 begin 的基线，而不是 turn-after 采到的 foreign commit。
    expect(record?.beforeCommitId).toBe(baseline?.commitId)
    expect(record?.afterCommitId).not.toBe(record?.beforeCommitId)
    expect(record?.changes.map((change) => [change.path, change.status, change.attribution])).toEqual([
      ['src/agent-mid-turn.ts', 'added', 'confirmed'],
    ])
  })
})
