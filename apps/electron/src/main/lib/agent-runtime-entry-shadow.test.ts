/**
 * 新链的 Shadow Git turn 归属。
 *
 * 旧编排器在 run 前 `beginWorkspaceShadowTurn`、终态后 `endWorkspaceShadowTurn`，并把
 * 「runtime 声明自己写过什么」作为证据带过去。新链此前这两步都没有，于是回退时报
 * 「该会话还没有文件变化记录」。本文件锁三件事：
 *
 * 1. 正常一轮：begin 一次、end 一次，且 end 拿到 sessionId / turnId / 证据；
 * 2. 证据来自 assistant 的 `tool_use`（两个 runtime 通用），Write → write、Edit → edit；
 * 3. 没真正开始（并发拒绝）的请求不记 turn，避免多出一个空 turn 干扰回退。
 */
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentSendInput, SDKMessage } from '@profer/shared'
import type { AgentRunOutcome, AgentRuntimeCallbacks, AgentRuntimeQuery, AgentRuntimeRunHandle } from '@profer/agent-runtime'

interface ShadowCall {
  kind: 'begin' | 'end'
  workspaceId: string | undefined
  payload?: Record<string, unknown>
}

const calls: ShadowCall[] = []

mock.module('./workspace-shadow-turns', () => ({
  beginWorkspaceShadowTurn: (workspaceId: string | undefined) => {
    calls.push({ kind: 'begin', workspaceId })
    return Promise.resolve({ commitId: 'base-1' })
  },
  endWorkspaceShadowTurn: (workspaceId: string | undefined, payload: Record<string, unknown>) => {
    calls.push({ kind: 'end', workspaceId, payload })
  },
}))

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

const root = mkdtempSync(join(tmpdir(), 'profer-runtime-shadow-'))
process.env.PROFER_CONFIG_DIR = root

const entry = await import('./agent-runtime-entry')
const sessions = await import('./agent-session-manager')

afterAll(() => {
  delete process.env.PROFER_CONFIG_DIR
  rmSync(root, { recursive: true, force: true })
})

beforeEach(() => {
  calls.length = 0
})

function sendInput(sessionId: string, overrides: Partial<AgentSendInput> = {}): AgentSendInput {
  return {
    sessionId,
    userMessage: '写个文件',
    channelId: 'channel-1',
    modelId: 'model-1',
    uuid: 'turn-uuid-1',
    startedAt: Date.now(),
    ...overrides,
  } as AgentSendInput
}

function deps(script: (callbacks: AgentRuntimeCallbacks) => AgentRunOutcome) {
  return {
    resolveRunContext: () => ({ runtime: 'pi' as const, cwd: root, toolAssemblyContext: {} }),
    run: (query: AgentRuntimeQuery, callbacks: AgentRuntimeCallbacks): AgentRuntimeRunHandle => ({
      sessionId: query.sessionId,
      runtime: query.runtime,
      promise: Promise.resolve(script(callbacks)),
      stop: async () => {},
    }),
    sessions: {
      getMeta: sessions.getAgentSessionMeta,
      appendMessages: () => {},
      updateMeta: sessions.updateAgentSessionMeta,
      getMessages: () => [] as SDKMessage[],
    },
    messages: () => [],
    emitPlanModeEvent: () => {},
    onRunStarted: () => {},
    applyCompletionUnread: () => {},
    sink: { onError: () => {}, onComplete: () => {} },
  } as unknown as Parameters<typeof entry.runRuntimeHeadlessEntry>[2]
}

function assistantToolUse(id: string, name: string, input: Record<string, unknown>): SDKMessage {
  return {
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id, name, input }] },
    parent_tool_use_id: null,
  } as unknown as SDKMessage
}

describe('runtime entry shadow turn', () => {
  test('正常一轮：begin 一次、end 一次，并把 tool_use 写入证据带过去', async () => {
    const meta = sessions.createAgentSession('shadow', 'channel-1', undefined, 'model-1', 'pi')

    const outcome = await entry.runRuntimeHeadlessEntry(sendInput(meta.id), { onEvent: () => {} }, deps((callbacks) => {
      callbacks.onRunStarted?.({ startedAt: 1000 })
      callbacks.onMessage?.(assistantToolUse('tool-1', 'Write', { file_path: '/tmp/ws/a.md' }))
      callbacks.onMessage?.(assistantToolUse('tool-2', 'Edit', { file_path: '/tmp/ws/b.md' }))
      return { status: 'completed' }
    }))

    expect(outcome).toEqual({ status: 'completed' })
    expect(calls.filter(call => call.kind === 'begin')).toHaveLength(1)
    const ends = calls.filter(call => call.kind === 'end')
    expect(ends).toHaveLength(1)
    const payload = ends[0]!.payload as {
      sessionId: string
      turnId?: string
      runtime?: string
      evidence?: Array<{ path: string; source: string }>
    }
    expect(payload.sessionId).toBe(meta.id)
    expect(payload.turnId).toBe('turn-uuid-1')
    expect(payload.runtime).toBe('pi')
    expect(payload.evidence?.map(item => [item.path, item.source])).toEqual([
      ['/tmp/ws/a.md', 'write'],
      ['/tmp/ws/b.md', 'edit'],
    ])
  })

  test('没真正开始的请求不记 turn（并发拒绝不产生空 turn）', async () => {
    const meta = sessions.createAgentSession('shadow-rejected', 'channel-1', undefined, 'model-1', 'pi')
    const rejected = deps(() => ({ status: 'completed' }))
    rejected.run = () => {
      throw new Error('该会话已有运行中的请求')
    }

    await expect(entry.runRuntimeHeadlessEntry(sendInput(meta.id), { onEvent: () => {} }, rejected)).rejects.toThrow()
    expect(calls.filter(call => call.kind === 'end')).toHaveLength(0)
  })

  test('非写入类工具不产生证据', async () => {
    const meta = sessions.createAgentSession('shadow-read', 'channel-1', undefined, 'model-1', 'pi')
    await entry.runRuntimeHeadlessEntry(sendInput(meta.id), { onEvent: () => {} }, deps((callbacks) => {
      callbacks.onRunStarted?.({ startedAt: 1000 })
      callbacks.onMessage?.(assistantToolUse('tool-9', 'Read', { file_path: '/tmp/ws/a.md' }))
      return { status: 'completed' }
    }))

    const payload = calls.find(call => call.kind === 'end')!.payload as { evidence?: unknown[] }
    expect(payload.evidence).toEqual([])
  })
})
