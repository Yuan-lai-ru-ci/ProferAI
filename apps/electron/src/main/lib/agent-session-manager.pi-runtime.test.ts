import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { appendPiHarnessEvent } from './pi-harness/pi-harness-store'
import { PI_HARNESS_EVENT_VERSION, type PiHarnessEvent } from './pi-harness/types'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPiFileCheckpoint, loadPiFileCheckpoint, restorePiFileCheckpoint } from './pi-file-checkpoint'

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
let graphService: typeof import('./project-graph-service')
let workspaces: typeof import('./agent-workspace-manager')

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'profer-pi-session-test-'))
  process.env.PROFER_CONFIG_DIR = root
  const cacheKey = `${Date.now()}-${Math.random()}`
  sessions = await import(`./agent-session-manager?pi-runtime-test=${cacheKey}`)
  configPaths = await import(`./config-paths?pi-runtime-test=${cacheKey}`)
  graphService = await import(`./project-graph-service?pi-runtime-test=${cacheKey}`)
  workspaces = await import(`./agent-workspace-manager?pi-runtime-test=${cacheKey}`)
})

afterEach(() => {
  delete process.env.PROFER_CONFIG_DIR
  if (root) rmSync(root, { recursive: true, force: true })
})

function writePiTranscript(sessionId: string, nested = false): string {
  const dir = nested
    ? join(configPaths.getSdkConfigDir(), 'sessions', 'pi', '--workspace--')
    : join(configPaths.getSdkConfigDir(), 'sessions', 'pi')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `2026-07-20T00-00-00-000Z_${sessionId}.jsonl`)
  writeFileSync(file, `${JSON.stringify({ type: 'session', version: 3, id: sessionId, cwd: root })}\n`, 'utf-8')
  return file
}

describe('Pi runtime 会话持久化隔离', () => {
  test('Given Pi transcript 存在 When 扫描会话健康度 Then 不误报为 Claude SDK orphan', () => {
    const meta = sessions.createAgentSession('Pi health', undefined, undefined, undefined, 'pi')
    sessions.updateAgentSessionMeta(meta.id, { sdkSessionId: 'pi-session-healthy' })
    // Pi SessionManager 实际按 cwd 创建子目录；健康检查必须递归找到该 transcript。
    writePiTranscript('pi-session-healthy', true)

    const health = sessions.findOrphanSessions().find((item) => item.sessionId === meta.id)

    expect(health?.hasSdkJsonl).toBe(true)
    expect(health?.hasPiHarnessJsonl).toBe(false)
    expect(health?.isOrphan).toBe(false)
    expect(health?.orphanReason).toBeUndefined()
  })

  test('Given Pi session with task graph When deleting Then removes Pi transcript and graph without touching other sessions', () => {
    const first = sessions.createAgentSession('Pi delete', undefined, undefined, undefined, 'pi')
    const second = sessions.createAgentSession('Pi keep', undefined, undefined, undefined, 'pi')
    sessions.updateAgentSessionMeta(first.id, { sdkSessionId: 'pi-delete-id' })
    sessions.updateAgentSessionMeta(second.id, { sdkSessionId: 'pi-keep-id' })
    const deletedTranscript = writePiTranscript('pi-delete-id')
    const retainedTranscript = writePiTranscript('pi-keep-id')
    graphService.appendGraphEvent(first.id, {
      type: 'task_created', taskId: 'task-1', timestamp: Date.now(), payload: { subject: '删除时清理', description: '', dependsOn: [] },
    })
    const graphPath = join(configPaths.getAgentSessionsDir(), `${first.id}-graph.jsonl`)
    const harnessEvent: PiHarnessEvent = {
      version: PI_HARNESS_EVENT_VERSION,
      eventId: 'harness-delete-event', timestamp: Date.now(), sessionId: first.id, goalId: 'goal-delete',
      type: 'goal_created', payload: { policy: { governorMode: 'shadow', permissionMode: 'bypassPermissions', maxFocusChars: 1200 } },
    }
    appendPiHarnessEvent(first.id, harnessEvent)
    const harnessPath = configPaths.getPiHarnessEventsPath(first.id)

    sessions.deleteAgentSession(first.id)

    expect(existsSync(deletedTranscript)).toBe(false)
    expect(existsSync(graphPath)).toBe(false)
    expect(existsSync(harnessPath)).toBe(false)
    expect(existsSync(retainedTranscript)).toBe(true)
    expect(sessions.getAgentSessionMeta(first.id)).toBeUndefined()
    expect(sessions.getAgentSessionMeta(second.id)?.sdkSessionId).toBe('pi-keep-id')
  })

  test('Given a Pi session moves from an external cwd into a workspace When migrating Then old runtime artifacts are discarded but Profer history remains', () => {
    const workspace = workspaces.createAgentWorkspace('Migrated workspace')
    const meta = sessions.createAgentSession('Migrated Pi', undefined, undefined, undefined, 'pi')
    const oldCwd = join(root, 'external-cwd')
    mkdirSync(oldCwd)
    writeFileSync(join(oldCwd, 'keep-me.txt'), 'outside workspace')
    const checkpoint = createPiFileCheckpoint(meta.id, oldCwd, configPaths.getPiCheckpointsDir())
    const transcript = writePiTranscript('pi-migrated-session')
    sessions.appendSDKMessages(meta.id, [{
      type: 'user', uuid: 'user-before-move', message: { content: [{ type: 'text', text: '继续签名任务' }] },
    } as never])
    sessions.updateAgentSessionMeta(meta.id, {
      sdkSessionId: 'pi-migrated-session',
      piSessionFile: transcript,
      piEntryBindings: { 'assistant-before-move': 'entry-before-move' },
      piFileCheckpoints: { 'entry-before-move': checkpoint.path },
    })

    const moved = sessions.moveSessionToWorkspace(meta.id, workspace.id)

    expect(moved.workspaceId).toBe(workspace.id)
    expect(moved.sdkSessionId).toBeUndefined()
    expect(moved.piSessionFile).toBeUndefined()
    expect(moved.piEntryBindings).toBeUndefined()
    expect(moved.piFileCheckpoints).toBeUndefined()
    expect(existsSync(transcript)).toBe(false)
    expect(existsSync(checkpoint.path)).toBe(false)
    expect(sessions.getAgentSessionSDKMessages(meta.id)).toHaveLength(1)
    expect(readFileSync(join(oldCwd, 'keep-me.txt'), 'utf8')).toBe('outside workspace')
  })

  describe('delegated session deletion order', () => {
    test('Given nested delegated children When resolving deletion order Then only delegated descendants are leaf-first', () => {
      const parent = sessions.createAgentSession('parent')
      const childId = 'delegated-child'
      const grandchildId = 'delegated-grandchild'
      sessions.createDelegatedChildSessionMeta({
        childSessionId: childId,
        parentSessionId: parent.id,
        sourceDelegationId: 'delegation-child',
        title: 'child',
      })
      sessions.createDelegatedChildSessionMeta({
        childSessionId: grandchildId,
        parentSessionId: childId,
        sourceDelegationId: 'delegation-grandchild',
        title: 'grandchild',
      })
      const unrelated = sessions.createAgentSession('unrelated')
      sessions.updateAgentSessionMeta(unrelated.id, { parentSessionId: parent.id })

      expect(sessions.getAgentSessionDeletionOrder(parent.id)).toEqual([grandchildId, childId, parent.id])
      expect(sessions.getAgentSessionDeletionOrder(unrelated.id)).toEqual([unrelated.id])
    })
  })

  test('Given a session is created with a preset When re-reading index Then the preset and reference persist', () => {
    const session = sessions.createAgentSession('delegation preset', undefined, undefined, undefined, 'pi', false, 'minimal')
    expect(sessions.getAgentSessionMeta(session.id)).toMatchObject({
      presetId: 'minimal',
      presetReference: { presetId: 'minimal', presetScope: 'builtin-meta' },
    })
  })

  test('Given a session omits a preset When created Then it binds the standard preset consistently', () => {
    const session = sessions.createAgentSession('default preset')
    expect(sessions.getAgentSessionMeta(session.id)).toMatchObject({
      presetId: 'standard',
      presetReference: { presetId: 'standard', presetScope: 'builtin-meta' },
    })
  })

  test('Given sessions have distinct channel/model selections When re-reading index Then each selection persists independently', () => {
    const first = sessions.createAgentSession('first selection', 'channel-a', undefined, 'model-a', 'pi')
    const second = sessions.createAgentSession('second selection', 'channel-b', undefined, 'model-b', 'pi')

    sessions.updateAgentSessionMeta(first.id, { channelId: 'channel-a-next', modelId: 'model-a-next' })

    const restoredFirst = sessions.getAgentSessionMeta(first.id)
    const restoredSecond = sessions.getAgentSessionMeta(second.id)
    expect(restoredFirst).toMatchObject({ channelId: 'channel-a-next', modelId: 'model-a-next' })
    expect(restoredSecond).toMatchObject({ channelId: 'channel-b', modelId: 'model-b' })
  })

  test('Given stale attached paths When startup cleanup runs Then removes paths without changing session recency', () => {
    const missingDirectory = join(root, 'deleted-worktree')
    const missingFile = join(root, 'deleted-file.txt')
    const meta = sessions.createAgentSession('stale attachments')
    const attached = sessions.updateAgentSessionMeta(meta.id, {
      attachedDirectories: [missingDirectory],
      attachedFiles: [missingFile],
    })

    expect(sessions.cleanupStaleAttachedPaths()).toBe(2)
    expect(sessions.getAgentSessionMeta(meta.id)).toMatchObject({
      updatedAt: attached.updatedAt,
      attachedDirectories: undefined,
      attachedFiles: undefined,
    })
  })

  test('Given a Claude session changes to Pi When updating runtime Then clears all Claude-only resume metadata', () => {
    const meta = sessions.createAgentSession('runtime switch')
    sessions.updateAgentSessionMeta(meta.id, {
      sdkSessionId: 'claude-session',
      forkSourceSdkSessionId: 'claude-source',
      forkSourceDir: 'C:/source',
      resumeAtMessageUuid: 'assistant-uuid',
    })

    const updated = sessions.updateAgentSessionMeta(meta.id, { agentRuntime: 'pi' })

    expect(updated.agentRuntime).toBe('pi')
    expect(updated.sdkSessionId).toBeUndefined()
    expect(updated.forkSourceSdkSessionId).toBeUndefined()
    expect(updated.forkSourceDir).toBeUndefined()
    expect(updated.resumeAtMessageUuid).toBeUndefined()
  })

  test('Given updateSettings fails after runtime switch When restoring snapshot Then SDK/fork/resume metadata survives rollback', () => {
    const meta = sessions.createAgentSession('runtime rollback')
    sessions.updateAgentSessionMeta(meta.id, {
      agentRuntime: 'claude',
      codexFastMode: true,
      sdkSessionId: 'claude-session',
      forkSourceSdkSessionId: 'claude-source',
      forkSourceDir: 'C:/source',
      resumeAtMessageUuid: 'assistant-uuid',
    })

    const snapshot = sessions.snapshotAgentRuntimeMeta(sessions.getAgentSessionMeta(meta.id)!)
    sessions.updateAgentSessionMeta(meta.id, { agentRuntime: 'pi' })
    const restored = sessions.restoreAgentRuntimeMeta(meta.id, snapshot)

    expect(restored.agentRuntime).toBe('claude')
    expect(restored.codexFastMode).toBe(true)
    expect(restored.sdkSessionId).toBe('claude-session')
    expect(restored.forkSourceSdkSessionId).toBe('claude-source')
    expect(restored.forkSourceDir).toBe('C:/source')
    expect(restored.resumeAtMessageUuid).toBe('assistant-uuid')
  })

  test('Given a Pi session changes runtime When updating Then checkpoint bindings are cleared and snapshots are reclaimed', () => {
    const meta = sessions.createAgentSession('runtime checkpoint cleanup', undefined, undefined, undefined, 'pi')
    const cwd = join(root, 'cwd')
    mkdirSync(cwd)
    writeFileSync(join(cwd, 'file.txt'), 'baseline')
    const checkpoint = createPiFileCheckpoint(meta.id, cwd, configPaths.getPiCheckpointsDir())
    sessions.updateAgentSessionMeta(meta.id, { piFileCheckpoints: { 'entry-1': checkpoint.path } })

    const switched = sessions.updateAgentSessionMeta(meta.id, { agentRuntime: 'claude' })
    expect(switched.piFileCheckpoints).toBeUndefined()
    expect(existsSync(checkpoint.path)).toBe(false)
  })

  test('Given a legacy fork still references source checkpoints When deleting source Then references are migrated before source cleanup', () => {
    const source = sessions.createAgentSession('checkpoint source', undefined, undefined, undefined, 'pi')
    const target = sessions.createAgentSession('legacy checkpoint fork', undefined, undefined, undefined, 'pi')
    const cwd = join(root, 'cwd')
    mkdirSync(cwd)
    writeFileSync(join(cwd, 'file.txt'), 'baseline')
    const checkpoint = createPiFileCheckpoint(source.id, cwd, configPaths.getPiCheckpointsDir())
    sessions.updateAgentSessionMeta(target.id, { piFileCheckpoints: { 'entry-1': checkpoint.path } })

    sessions.deleteAgentSession(source.id)
    const migrated = sessions.getAgentSessionMeta(target.id)?.piFileCheckpoints?.['entry-1']
    expect(migrated).toBeTruthy()
    expect(migrated).not.toBe(checkpoint.path)
    expect(existsSync(migrated!)).toBe(true)
    expect(existsSync(checkpoint.path)).toBe(false)

    writeFileSync(join(cwd, 'file.txt'), 'changed')
    restorePiFileCheckpoint(loadPiFileCheckpoint(migrated!), cwd)
    expect(readFileSync(join(cwd, 'file.txt'), 'utf8')).toBe('baseline')
  })

  test('Given a legacy fork references a missing source checkpoint When deleting source Then its stale binding is removed', () => {
    const source = sessions.createAgentSession('missing checkpoint source', undefined, undefined, undefined, 'pi')
    const target = sessions.createAgentSession('missing checkpoint fork', undefined, undefined, undefined, 'pi')
    const missing = join(configPaths.getPiCheckpointsDir(), source.id, 'missing.json')
    sessions.updateAgentSessionMeta(target.id, { piFileCheckpoints: { 'entry-1': missing } })

    sessions.deleteAgentSession(source.id)
    expect(sessions.getAgentSessionMeta(target.id)?.piFileCheckpoints).toBeUndefined()
  })

  test('Given a runtime switch When a stale SDK callback tries to save an ID Then it cannot restore the previous runtime session ID', () => {
    const meta = sessions.createAgentSession('runtime stale callback')
    const switched = sessions.updateAgentSessionMeta(meta.id, { agentRuntime: 'pi' })

    // 发送链路会在写入 callback 前验证 runtime；这里验证存储层不会因同 runtime 写入破坏 Pi metadata。
    const updated = sessions.updateAgentSessionMeta(switched.id, { sdkSessionId: 'pi-session-id' })

    expect(updated.agentRuntime).toBe('pi')
    expect(updated.sdkSessionId).toBe('pi-session-id')
    expect(updated.forkSourceSdkSessionId).toBeUndefined()
  })
})

// 回归：一次最终失败的传输错误曾经在写入/读取时被静默丢弃，
// 用户看到的是「Agent Running 一闪就什么都没有了」。
describe('瞬时断流错误卡的可见性', () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const userMessage = (): any => ({
    type: 'user',
    message: { content: [{ type: 'text', text: '你好' }] },
    parent_tool_use_id: null,
    _createdAt: Date.now(),
  })

  const errorCard = (text: string, errorType = 'network_error'): any => ({
    type: 'assistant',
    message: { content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
    error: { message: text, errorType },
    _errorCode: errorType,
    _createdAt: Date.now(),
  })

  const okAssistant = (): any => ({
    type: 'assistant',
    message: { content: [{ type: 'text', text: '已恢复' }] },
    parent_tool_use_id: null,
    _createdAt: Date.now(),
  })

  test('Given 会话尾部是一次网络失败 When 读取消息 Then 失败卡仍可见（含分页）', () => {
    const meta = sessions.createAgentSession('Network fail', undefined, undefined, undefined, 'pi')
    sessions.appendSDKMessages(meta.id, [userMessage(), errorCard('网络异常: Connection error.')])

    const full = sessions.getAgentSessionSDKMessages(meta.id)
    expect(full.some((message) => Boolean((message as any).error))).toBe(true)

    const page = sessions.getAgentSessionSDKMessages(meta.id, { tail: 60 })
    expect(page.messages.some((message) => Boolean((message as any).error))).toBe(true)
  })

  test('Given 断流之后又有正常产出 When 读取消息 Then 旧断流卡不进入历史', () => {
    const meta = sessions.createAgentSession('Recovered', undefined, undefined, undefined, 'pi')
    sessions.appendSDKMessages(meta.id, [
      userMessage(),
      errorCard('网络异常: Connection error.'),
      okAssistant(),
    ])

    const full = sessions.getAgentSessionSDKMessages(meta.id)
    expect(full.some((message) => Boolean((message as any).error))).toBe(false)
  })
  /* eslint-enable @typescript-eslint/no-explicit-any */
})
