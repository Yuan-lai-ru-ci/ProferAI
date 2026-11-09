/**
 * Phase 4 边界兜底：有目标轮 uuid、但归属记录里找不到对应记录时，
 * 文件侧必须明确不可用，而不是拿 assistant 下标去切归属记录（两套编号混用会撤错轮）。
 *
 * 这里走真实 resolver（经 `createElectronAgentRewindService` → `prepare`），
 * 只断言产品可见的契约：both 直接拒绝并说明原因；conversation 降级时
 * capability.supportsFiles=false，且计划里没有 files / shadowTurns。
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

const WORKSPACE_ID = 'workspace-rewind-boundary'
const SESSION_ID = 'session-rewind-boundary'

let root = ''
let host: typeof import('./agent-rewind-host')

function message(type: 'user' | 'assistant', uuid: string): string {
  return JSON.stringify({ type, uuid, message: { role: type, content: [{ type: 'text', text: uuid }] } })
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'profer-rewind-boundary-'))
  process.env.PROFER_CONFIG_DIR = root
  writeFileSync(
    join(root, 'agent-sessions.json'),
    JSON.stringify({
      version: 1,
      sessions: [
        { id: SESSION_ID, workspaceId: WORKSPACE_ID, agentRuntime: 'pi', title: '边界兜底测试', createdAt: 1, updatedAt: 1 },
      ],
    }),
    'utf8',
  )
  mkdirSync(join(root, 'agent-sessions'), { recursive: true })
  writeFileSync(
    join(root, 'agent-sessions', `${SESSION_ID}.jsonl`),
    [message('user', 'u1'), message('assistant', 'a1'), message('user', 'u2'), message('assistant', 'a2')].join('\n') + '\n',
    'utf8',
  )
  // 归属记录存在，但 turnId 是别的身份：目标轮 u2 在记录里找不到。
  const shadowDir = join(root, 'workspace-shadow', WORKSPACE_ID)
  mkdirSync(shadowDir, { recursive: true })
  const records = [
    { schemaVersion: 1, workspaceId: WORKSPACE_ID, sessionId: SESSION_ID, turnId: 'u1', createdAt: 1, beforeCommitId: 'b1', afterCommitId: 'a1', roots: [], changes: [] },
    { schemaVersion: 1, workspaceId: WORKSPACE_ID, sessionId: SESSION_ID, turnId: 'stale-turn-identity', createdAt: 2, beforeCommitId: 'a1', afterCommitId: 'a2', roots: [], changes: [] },
  ]
  writeFileSync(join(shadowDir, 'turns.jsonl'), records.map((record) => JSON.stringify(record)).join('\n') + '\n', 'utf8')
  const cacheKey = `${Date.now()}-${Math.random()}`
  host = await import(`./agent-rewind-host?rewind-boundary-test=${cacheKey}`)
})

afterEach(() => {
  delete process.env.PROFER_CONFIG_DIR
  if (root) rmSync(root, { recursive: true, force: true })
})

describe('目标轮在归属记录里找不到时的边界兜底', () => {
  // 回退到 assistant a2（第 2 轮）之前：assistant 下标 = 1，若被当成记录条数切，
  // 会撤掉「第 2 条记录之后」的轮次——与真实的轮次边界无关。
  const target = { kind: 'message' as const, messageUuid: 'a2' }

  test('both 模式：文件侧明确不可用，理由说明无法按轮次定位', async () => {
    const service = host.createElectronAgentRewindService()
    await expect(service.prepare({ sessionId: SESSION_ID, mode: 'both', target })).rejects.toThrow(
      '无法按轮次定位文件变化记录',
    )
  })

  test('conversation 模式：capability.supportsFiles=false，且计划不带 files / shadowTurns', async () => {
    const service = host.createElectronAgentRewindService()
    const { plan } = await service.prepare({ sessionId: SESSION_ID, mode: 'conversation', target })
    expect(plan.capability.supportsFiles).toBe(false)
    expect(plan.capability.reasons?.files).toBe('无法按轮次定位文件变化记录')
    expect(plan.files).toBeUndefined()
    expect(plan.shadowTurns).toBeUndefined()
  })
})
