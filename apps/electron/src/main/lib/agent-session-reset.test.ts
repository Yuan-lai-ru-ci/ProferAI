/**
 * 「清空整段对话」能力的回归测试。
 *
 * 场景：首轮就失败时没有可保留的 assistant 锚点，普通回退（保留目标消息 + 截断其后）
 * 无处可落，只能整段清空并重置运行时会话。这里覆盖两条 runtime 路径的落盘结果与降级提示，
 * 以及「清空后下一轮不会 resume 出被清掉的那段对话」这一关键点（清 sdkSessionId）。
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 会话管理器经 workspace 服务间接导入 Electron；Bun 单测需提供最小主进程 mock。
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
let sessions: typeof import('./agent-session-manager')
let configPaths: typeof import('./config-paths')

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'profer-session-reset-test-'))
  process.env.PROFER_CONFIG_DIR = root
  const cacheKey = `${Date.now()}-${Math.random()}`
  sessions = await import(`./agent-session-manager?session-reset-test=${cacheKey}`)
  configPaths = await import(`./config-paths?session-reset-test=${cacheKey}`)
})

afterEach(() => {
  delete process.env.PROFER_CONFIG_DIR
  if (root) rmSync(root, { recursive: true, force: true })
})

function seedMessages(sessionId: string, lines: unknown[]): string {
  const dir = configPaths.getAgentSessionsDir()
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${sessionId}.jsonl`)
  writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf-8')
  return file
}

function writeSdkJsonl(sdkSessionId: string, lines: unknown[]): string {
  const dir = join(configPaths.getSdkConfigDir(), 'projects', 'fixture-project')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${sdkSessionId}.jsonl`)
  writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf-8')
  return file
}

function writePiTranscript(sessionId: string, piSessionId: string): string {
  const dir = join(configPaths.getSdkConfigDir(), 'sessions', 'pi')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `2026-07-20T00-00-00-000Z_${piSessionId}.jsonl`)
  writeFileSync(file, `${JSON.stringify({ type: 'session', version: 3, id: piSessionId, cwd: root })}\n`, 'utf-8')
  return file
}

const userMsg = (text: string) => ({ type: 'user', uuid: `u-${text}`, message: { content: [{ type: 'text', text }] } })
const assistantMsg = (uuid: string) => ({ type: 'assistant', uuid, message: { content: [{ type: 'text', text: '回复' }] } })
const toolResultMsg = () => ({ type: 'user', uuid: 'tr-1', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } })

describe('clearSDKMessages', () => {
  test('清空会话消息文件，会话本身保留', () => {
    const meta = sessions.createAgentSession('首轮失败', undefined, undefined, undefined, 'claude')
    const file = seedMessages(meta.id, [userMsg('第一条'), assistantMsg('a1')])
    expect(sessions.getAgentSessionSDKMessages(meta.id)).toHaveLength(2)

    const kept = sessions.clearSDKMessages(meta.id)

    expect(kept).toEqual([])
    expect(existsSync(file)).toBe(true)
    expect(readFileSync(file, 'utf-8')).toBe('')
    expect(sessions.getAgentSessionSDKMessages(meta.id)).toEqual([])
    expect(sessions.getAgentSessionMeta(meta.id)?.title).toBe('首轮失败')
  })
})

describe('resolveFirstUserUuidFromSDK', () => {
  test('返回首条真实用户消息的 uuid，跳过 tool_result', () => {
    const sdkSessionId = 'sdk-first-user'
    writeSdkJsonl(sdkSessionId, [toolResultMsg(), userMsg('第一条'), assistantMsg('a1'), userMsg('第二条')])
    expect(sessions.resolveFirstUserUuidFromSDK(sdkSessionId)).toBe('u-第一条')
  })

  test('找不到 JSONL 时返回 undefined（调用方据此降级提示）', () => {
    expect(sessions.resolveFirstUserUuidFromSDK('sdk-not-exist')).toBeUndefined()
  })
})

describe('resetClaudeSession', () => {
  test('清空对话并清掉 sdkSessionId，避免下一轮 resume 出被清掉的失败轮', () => {
    const meta = sessions.createAgentSession('首轮就错', undefined, undefined, undefined, 'claude')
    const sdkSessionId = 'sdk-reset-1'
    sessions.updateAgentSessionMeta(meta.id, { sdkSessionId, resumeAtMessageUuid: 'a-old' })
    seedMessages(meta.id, [userMsg('第一条就失败'), assistantMsg('a-err')])
    // SDK JSONL 里没有 file-history-snapshot：文件恢复应优雅降级，不能拖垮清空
    writeSdkJsonl(sdkSessionId, [userMsg('第一条就失败'), assistantMsg('a-err')])

    const result = sessions.resetClaudeSession(meta.id, sessions.getAgentSessionMeta(meta.id)!)

    expect(result.remainingMessages).toBe(0)
    expect(sessions.getAgentSessionSDKMessages(meta.id)).toEqual([])
    const after = sessions.getAgentSessionMeta(meta.id)
    expect(after?.sdkSessionId).toBeUndefined()
    expect(after?.resumeAtMessageUuid).toBeUndefined()
    // 没有快照时必须明确说明「文件未回退」，而不是静默假装已回退
    expect(result.fileRewind?.canRewind).toBe(false)
    expect(result.fileRewind?.error).toBeString()
  })

  test('会话还没有 SDK session 时也清空对话，并说明文件未回退', () => {
    const meta = sessions.createAgentSession('从未成功启动', undefined, undefined, undefined, 'claude')
    seedMessages(meta.id, [userMsg('第一条就失败')])

    const result = sessions.resetClaudeSession(meta.id, sessions.getAgentSessionMeta(meta.id)!)

    expect(result.remainingMessages).toBe(0)
    expect(result.fileRewind).toEqual({ canRewind: false, error: '会话还没有 SDK session，文件未回退' })
  })
})

describe('resetPiSession', () => {
  test('transcript 截断到 header、清空绑定与检查点绑定，并说明文件未恢复', async () => {
    const meta = sessions.createAgentSession('Pi 首轮就错', undefined, undefined, undefined, 'pi')
    const piSessionFile = writePiTranscript(meta.id, 'pi-first-fail')
    sessions.updateAgentSessionMeta(meta.id, {
      piSessionFile,
      piEntryBindings: { 'a-err': 'entry-1' },
      piFileCheckpoints: { 'entry-1': join(root, 'missing-checkpoint') },
    })
    seedMessages(meta.id, [userMsg('第一条就失败'), assistantMsg('a-err')])

    const result = await sessions.resetPiSession(meta.id, sessions.getAgentSessionMeta(meta.id)!)

    expect(result.remainingMessages).toBe(0)
    expect(sessions.getAgentSessionSDKMessages(meta.id)).toEqual([])

    // transcript 只剩 header
    const lines = readFileSync(piSessionFile, 'utf-8').split('\n').filter(Boolean)
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]!).type).toBe('session')

    const after = sessions.getAgentSessionMeta(meta.id)
    expect(after?.piEntryBindings).toBeUndefined()
    expect(after?.piFileCheckpoints).toBeUndefined()
    expect(after?.resumeAtMessageUuid).toBeUndefined()

    // 没有可用检查点：只清对话，并明确告知文件未被改动
    expect(result.fileRewind?.canRewind).toBe(false)
    expect(result.fileRewind?.error).toBeString()
  })
})

describe('resolveFirstTurnCheckpoint（第一轮基线定位）', () => {
  test('取主路径上最早一个有绑定的 entry 对应的检查点', () => {
    expect(sessions.resolveFirstTurnCheckpoint({
      branchEntryIds: ['entry-1', 'entry-2', 'entry-3'],
      bindings: { 'a-1': 'entry-1', 'a-2': 'entry-3' },
      checkpoints: { 'entry-1': '/cp/turn-1', 'entry-3': '/cp/turn-3' },
    })).toBe('/cp/turn-1')
  })

  test('第一轮没有检查点时不向后找（后面的基线不是会话起点）', () => {
    expect(sessions.resolveFirstTurnCheckpoint({
      branchEntryIds: ['entry-1', 'entry-2'],
      bindings: { 'a-1': 'entry-1', 'a-2': 'entry-2' },
      checkpoints: { 'entry-2': '/cp/turn-2' },
    })).toBeUndefined()
  })

  test('绑定不在主路径上（已被截断/分叉）时返回 undefined', () => {
    expect(sessions.resolveFirstTurnCheckpoint({
      branchEntryIds: ['entry-9'],
      bindings: { 'a-1': 'entry-1' },
      checkpoints: { 'entry-1': '/cp/turn-1' },
    })).toBeUndefined()
  })
})

describe('resetPiSession（找到第一轮但检查点不可读）', () => {
  test('检查点文件缺失时只清对话并带上原因，不取消清空', async () => {
    const meta = sessions.createAgentSession('Pi 首轮检查点缺失', undefined, undefined, undefined, 'pi')
    const piSessionFile = writePiTranscript(meta.id, 'pi-missing-cp')
    // 主路径上放一个有绑定的 entry，使 firstTurnEntry 能被定位到
    writeFileSync(
      piSessionFile,
      `${readFileSync(piSessionFile, 'utf-8')}${JSON.stringify({ type: 'message', id: 'entry-1', parentId: null, timestamp: 1, message: { role: 'user', content: '第一条就失败' } })}\n`,
      'utf-8',
    )
    sessions.updateAgentSessionMeta(meta.id, {
      piSessionFile,
      piEntryBindings: { 'a-err': 'entry-1' },
      piFileCheckpoints: { 'entry-1': join(root, 'does-not-exist-checkpoint.json') },
    })
    seedMessages(meta.id, [userMsg('第一条就失败'), assistantMsg('a-err')])

    const result = await sessions.resetPiSession(meta.id, sessions.getAgentSessionMeta(meta.id)!)

    expect(result.remainingMessages).toBe(0)
    expect(sessions.getAgentSessionSDKMessages(meta.id)).toEqual([])
    expect(result.fileRewind?.canRewind).toBe(false)
    expect(result.fileRewind?.error).toBeString()
    const lines = readFileSync(piSessionFile, 'utf-8').split('\n').filter(Boolean)
    expect(lines).toHaveLength(1)
  })
})
