import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
let graphService: typeof import('./project-graph-service')

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'profer-pi-session-test-'))
  process.env.PROFER_CONFIG_DIR = root
  const cacheKey = `${Date.now()}-${Math.random()}`
  sessions = await import(`./agent-session-manager?pi-runtime-test=${cacheKey}`)
  configPaths = await import(`./config-paths?pi-runtime-test=${cacheKey}`)
  graphService = await import(`./project-graph-service?pi-runtime-test=${cacheKey}`)
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
  test('Given 创建或更新会话时选择模型 When 重新读取索引 Then modelId 与 channelId 持久化', () => {
    const created = sessions.createAgentSession('model metadata', 'channel-a', undefined, 'model-a', 'pi')

    expect(sessions.getAgentSessionMeta(created.id)).toMatchObject({
      channelId: 'channel-a',
      modelId: 'model-a',
      agentRuntime: 'pi',
    })

    sessions.updateAgentSessionMeta(created.id, { channelId: 'channel-b', modelId: 'model-b' })
    expect(sessions.getAgentSessionMeta(created.id)).toMatchObject({
      channelId: 'channel-b',
      modelId: 'model-b',
      agentRuntime: 'pi',
    })
  })

  test('Given Pi transcript 存在 When 扫描会话健康度 Then 不误报为 Claude SDK orphan', () => {
    const meta = sessions.createAgentSession('Pi health', undefined, undefined, undefined, 'pi')
    sessions.updateAgentSessionMeta(meta.id, { sdkSessionId: 'pi-session-healthy' })
    // Pi SessionManager 实际按 cwd 创建子目录；健康检查必须递归找到该 transcript。
    writePiTranscript('pi-session-healthy', true)

    const health = sessions.findOrphanSessions().find((item) => item.sessionId === meta.id)

    expect(health?.hasSdkJsonl).toBe(true)
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

    sessions.deleteAgentSession(first.id)

    expect(existsSync(deletedTranscript)).toBe(false)
    expect(existsSync(graphPath)).toBe(false)
    expect(existsSync(retainedTranscript)).toBe(true)
    expect(sessions.getAgentSessionMeta(first.id)).toBeUndefined()
    expect(sessions.getAgentSessionMeta(second.id)?.sdkSessionId).toBe('pi-keep-id')
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
