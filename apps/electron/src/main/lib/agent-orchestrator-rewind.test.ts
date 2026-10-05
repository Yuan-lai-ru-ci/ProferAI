/**
 * 会话级「回退 / 重新生成 / 清空」编排入口的回归测试。
 *
 * 覆盖 `AgentOrchestrator.rewindSession` 的三条分派与降级口径：
 * - 带锚点 + 有 SDK session：截断并记录 resume 点；
 * - 带锚点 + 没有 SDK session：仍然截断对话，只把文件恢复降级（不能整体拒绝）；
 * - 没有锚点（首轮就失败）：整段清空，并按 runtime 重置运行时会话。
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  safeStorage: {},
  screen: {},
  shell: {},
  systemPreferences: {},
}))

let root = ''
let orchestrator: { rewindSession: (sessionId: string, assistantMessageUuid?: string) => Promise<{ remainingMessages: number; fileRewind?: { canRewind: boolean; error?: string } }> }
let sessions: typeof import('./agent-session-manager')
let configPaths: typeof import('./config-paths')

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'profer-orch-rewind-test-'))
  process.env.PROFER_CONFIG_DIR = root
  const cacheKey = `${Date.now()}-${Math.random()}`
  const { AgentOrchestrator } = await import(`./agent-orchestrator?orch-rewind-test=${cacheKey}`)
  sessions = await import(`./agent-session-manager?orch-rewind-test=${cacheKey}`)
  configPaths = await import(`./config-paths?orch-rewind-test=${cacheKey}`)
  orchestrator = new AgentOrchestrator({} as never, { on: () => {}, emit: () => {} } as never) as never
})

afterEach(() => {
  delete process.env.PROFER_CONFIG_DIR
  if (root) rmSync(root, { recursive: true, force: true })
})

function seedMessages(sessionId: string, lines: unknown[]): void {
  const dir = configPaths.getAgentSessionsDir()
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${sessionId}.jsonl`), lines.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf-8')
}

function writeSdkJsonl(sdkSessionId: string, lines: unknown[]): void {
  const dir = join(configPaths.getSdkConfigDir(), 'projects', 'fixture-project')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${sdkSessionId}.jsonl`), lines.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf-8')
}

const userMsg = (text: string) => ({ type: 'user', uuid: `u-${text}`, message: { content: [{ type: 'text', text }] } })
const assistantMsg = (uuid: string) => ({ type: 'assistant', uuid, message: { content: [{ type: 'text', text: '回复' }] } })

describe('AgentOrchestrator.rewindSession', () => {
  test('带锚点且没有 SDK session：仍然截断对话，只把文件恢复降级', async () => {
    const meta = sessions.createAgentSession('无 SDK session', undefined, undefined, undefined, 'claude')
    seedMessages(meta.id, [userMsg('一问'), assistantMsg('a1'), userMsg('二问'), assistantMsg('a2')])

    const result = await orchestrator.rewindSession(meta.id, 'a1')

    // 对话确实被截断到锚点（含锚点）
    expect(result.remainingMessages).toBe(2)
    expect(sessions.getAgentSessionSDKMessages(meta.id).map((m) => (m as { uuid?: string }).uuid)).toEqual(['u-一问', 'a1'])
    // 没有 sdkSessionId 就没有可 resume 的 SDK 会话，残留值必须清掉（下一轮按已截断历史回填）
    expect(sessions.getAgentSessionMeta(meta.id)?.resumeAtMessageUuid).toBeUndefined()
    // 文件恢复明确降级，而不是整体拒绝
    expect(result.fileRewind?.canRewind).toBe(false)
    expect(result.fileRewind?.error).toBe('会话没有 SDK session ID，文件未回退')
  })

  test('带锚点且有 SDK session：记录 resume 截断点，文件无快照时降级', async () => {
    const meta = sessions.createAgentSession('有 SDK session', undefined, undefined, undefined, 'claude')
    const sdkSessionId = 'sdk-anchor-1'
    sessions.updateAgentSessionMeta(meta.id, { sdkSessionId })
    seedMessages(meta.id, [userMsg('一问'), assistantMsg('a1'), userMsg('二问'), assistantMsg('a2')])
    writeSdkJsonl(sdkSessionId, [userMsg('一问'), assistantMsg('a1'), userMsg('二问'), assistantMsg('a2')])

    const result = await orchestrator.rewindSession(meta.id, 'a1')

    expect(result.remainingMessages).toBe(2)
    expect(sessions.getAgentSessionMeta(meta.id)?.resumeAtMessageUuid).toBe('a1')
    expect(result.fileRewind?.canRewind).toBe(false)
    expect(result.fileRewind?.error).toBeString()
  })

  test('没有锚点（首轮就失败）：清空整段对话并清掉 sdkSessionId', async () => {
    const meta = sessions.createAgentSession('首轮失败', undefined, undefined, undefined, 'claude')
    const sdkSessionId = 'sdk-reset-orch'
    sessions.updateAgentSessionMeta(meta.id, { sdkSessionId, resumeAtMessageUuid: 'a-old' })
    seedMessages(meta.id, [userMsg('第一条就失败'), assistantMsg('a-err')])
    writeSdkJsonl(sdkSessionId, [userMsg('第一条就失败'), assistantMsg('a-err')])

    const result = await orchestrator.rewindSession(meta.id)

    expect(result.remainingMessages).toBe(0)
    expect(sessions.getAgentSessionSDKMessages(meta.id)).toEqual([])
    const after = sessions.getAgentSessionMeta(meta.id)
    expect(after?.sdkSessionId).toBeUndefined()
    expect(after?.resumeAtMessageUuid).toBeUndefined()
  })

  test('Pi 会话没有锚点时走清空：transcript 截断到 header', async () => {
    const meta = sessions.createAgentSession('Pi 首轮失败', undefined, undefined, undefined, 'pi')
    const piDir = join(configPaths.getSdkConfigDir(), 'sessions', 'pi')
    mkdirSync(piDir, { recursive: true })
    const piSessionFile = join(piDir, `2026-07-20T00-00-00-000Z_${meta.id}.jsonl`)
    writeFileSync(piSessionFile, `${JSON.stringify({ type: 'session', version: 3, id: meta.id, cwd: root })}\n`, 'utf-8')
    sessions.updateAgentSessionMeta(meta.id, { piSessionFile })
    seedMessages(meta.id, [userMsg('第一条就失败'), assistantMsg('a-err')])

    const result = await orchestrator.rewindSession(meta.id)

    expect(result.remainingMessages).toBe(0)
    expect(sessions.getAgentSessionSDKMessages(meta.id)).toEqual([])
    const lines = readFileSync(piSessionFile, 'utf-8').split('\n').filter(Boolean)
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]!).type).toBe('session')
  })

  test('Pi 会话带锚点但 artifact 缺失时拒绝回退（避免留下未截断的 Pi 上下文）', async () => {
    const meta = sessions.createAgentSession('Pi 无 artifact', undefined, undefined, undefined, 'pi')
    sessions.updateAgentSessionMeta(meta.id, { piSessionFile: join(root, 'missing-pi-session.jsonl') })
    seedMessages(meta.id, [userMsg('一问'), assistantMsg('a1'), userMsg('二问'), assistantMsg('a2')])

    await expect(orchestrator.rewindSession(meta.id, 'a1')).rejects.toThrow('未找到 Pi session artifact，无法回退')
    // 拒绝时不能已经改过对话
    expect(sessions.getAgentSessionSDKMessages(meta.id)).toHaveLength(4)
  })
})
