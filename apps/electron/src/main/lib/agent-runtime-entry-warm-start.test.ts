/**
 * 新 runtime 链的热启动接缝。
 *
 * 背景：新链（`runRuntimeHeadlessEntry` / `createElectronAgentRuntimeQuery`）曾经完全不读会话元数据，
 * 每一轮都在 provider 侧新建 session —— 历史与缓存全部重建。本文件锁三件事：
 *
 * 1. 非隔离会话必须把 `meta.sdkSessionId` 作为 `runtimeSessionId` 交给 provider（热启动）；
 * 2. 回退后的 `resumeAtMessageUuid` / `pendingRewindNotice` 注入本轮，并在首条 assistant/user
 *    消息后消费（与旧编排链同一口径）；
 * 3. resume 失效（`No conversation found`）时清除原生会话、按截断后的历史重建一次，
 *    且第一次失败不向调用方投递错误。
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentSendInput, SDKMessage } from '@profer/shared'
import type { AgentRunOutcome, AgentRuntimeCallbacks, AgentRuntimeQuery, AgentRuntimeRunHandle } from '@profer/agent-runtime'

let root = ''
let entry: typeof import('./agent-runtime-entry')
let sessions: typeof import('./agent-session-manager')

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

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'profer-runtime-warm-start-'))
  process.env.PROFER_CONFIG_DIR = root
  const cacheKey = `${Date.now()}-${Math.random()}`
  entry = await import(`./agent-runtime-entry?warm-start-test=${cacheKey}`)
  sessions = await import(`./agent-session-manager?warm-start-test=${cacheKey}`)
})

afterEach(() => {
  delete process.env.PROFER_CONFIG_DIR
  if (root) rmSync(root, { recursive: true, force: true })
})

function sendInput(sessionId: string, overrides: Partial<AgentSendInput> = {}): AgentSendInput {
  return {
    sessionId,
    userMessage: '继续',
    channelId: 'channel-1',
    modelId: 'model-1',
    startedAt: Date.now(),
    ...overrides,
  } as AgentSendInput
}

interface Harness {
  run: (query: AgentRuntimeQuery, callbacks: AgentRuntimeCallbacks) => AgentRuntimeRunHandle
  queries: AgentRuntimeQuery[]
  outerErrors: string[]
  completions: number
}

function harness(script: Array<(callbacks: AgentRuntimeCallbacks) => AgentRunOutcome | Promise<AgentRunOutcome>>): Harness {
  const queries: AgentRuntimeQuery[] = []
  const outerErrors: string[] = []
  let completions = 0
  let index = 0
  return {
    queries,
    outerErrors,
    get completions() { return completions },
    run(query, callbacks) {
      queries.push(query)
      const step = script[Math.min(index, script.length - 1)]!
      index += 1
      return {
        sessionId: query.sessionId,
        runtime: query.runtime,
        promise: Promise.resolve(step(callbacks)),
        stop: () => {},
      } as AgentRuntimeRunHandle
    },
  } as Harness
}

function deps(h: Harness, outerErrors: string[]): Parameters<typeof entry.runRuntimeHeadlessEntry>[2] {
  return {
    resolveRunContext: () => ({ runtime: 'claude' as const, cwd: root, toolAssemblyContext: {} }),
    run: h.run,
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
    sink: {
      onError: (error: string) => outerErrors.push(error),
      onComplete: () => {},
    },
  } as unknown as Parameters<typeof entry.runRuntimeHeadlessEntry>[2]
}

const notice = {
  createdAt: 111,
  mode: 'both' as const,
  restoredCount: 1,
  deletedCount: 0,
  keptPaths: ['src/kept.ts'],
  keptCount: 1,
}

describe('runtime headless entry warm start', () => {
  test('resumes the persisted native session and injects the rewind notice once', async () => {
    const meta = sessions.createAgentSession('热启动', 'channel-1', undefined, 'model-1', 'claude')
    sessions.updateAgentSessionMeta(meta.id, {
      sdkSessionId: 'sdk-existing',
      resumeAtMessageUuid: 'a-boundary',
      pendingRewindNotice: notice,
    })

    const h = harness([(callbacks) => {
      callbacks.onRunStarted?.({ startedAt: Date.now() })
      callbacks.onMessage?.({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } } as unknown as SDKMessage)
      return { status: 'completed' }
    }])

    const outcome = await entry.runRuntimeHeadlessEntry(sendInput(meta.id), { onEvent: () => {} }, deps(h, h.outerErrors))
    expect(outcome).toEqual({ status: 'completed' })

    const query = h.queries[0]!
    expect(query.runtimeSessionId).toBe('sdk-existing')
    expect((query.providerInput as Record<string, unknown>).resumeSessionAt).toBe('a-boundary')
    expect(query.prompt.startsWith('<workspace_rewind_notice>')).toBe(true)
    expect(query.prompt).toContain('src/kept.ts')

    const after = sessions.getAgentSessionMeta(meta.id)!
    expect(after.resumeAtMessageUuid).toBeUndefined()
    expect(after.pendingRewindNotice).toBeUndefined()
    // 原生 session id 是热启动事实，不属于一次性状态：不能被消费掉。
    expect(after.sdkSessionId).toBe('sdk-existing')
  })

  test('isolated sessions use the caller-provided runtime session and ignore rewind state', async () => {
    const meta = sessions.createAgentSession('隔离', 'channel-1', undefined, 'model-1', 'claude')
    sessions.updateAgentSessionMeta(meta.id, {
      sdkSessionId: 'sdk-session',
      resumeAtMessageUuid: 'a-boundary',
      pendingRewindNotice: notice,
    })

    const h = harness([() => ({ status: 'completed' })])
    await entry.runRuntimeHeadlessEntry(
      sendInput(meta.id, { isolatedRuntimeSession: true, runtimeSessionId: 'goal-session' }),
      { onEvent: () => {} },
      deps(h, h.outerErrors),
    )

    const query = h.queries[0]!
    expect(query.runtimeSessionId).toBe('goal-session')
    expect((query.providerInput as Record<string, unknown>)?.resumeSessionAt).toBeUndefined()
    expect(query.prompt).not.toContain('<workspace_rewind_notice>')
  })

  test('a stale native session is cleared and retried once with the recovery prompt', async () => {
    const meta = sessions.createAgentSession('resume 失效', 'channel-1', undefined, 'model-1', 'claude')
    sessions.updateAgentSessionMeta(meta.id, { sdkSessionId: 'sdk-stale', resumeAtMessageUuid: 'a-boundary' })

    const h = harness([
      (callbacks) => {
        const error = 'No conversation found with session ID sdk-stale'
        callbacks.onError?.(error)
        return { status: 'failed', error }
      },
      () => ({ status: 'completed' }),
    ])

    const outcome = await entry.runRuntimeHeadlessEntry(sendInput(meta.id), { onEvent: () => {} }, deps(h, h.outerErrors))
    expect(outcome).toEqual({ status: 'completed' })

    expect(h.queries).toHaveLength(2)
    const retry = h.queries[1]!
    expect(retry.runtimeSessionId).toBeUndefined()
    expect((retry.providerInput as Record<string, unknown>)?.resumeSessionAt).toBeUndefined()
    expect(retry.prompt).toContain('<session_recovery>')

    // 第一次失败被压住：调用方只看到最终结果，不看到一次假错误。
    expect(h.outerErrors).toEqual([])
    const after = sessions.getAgentSessionMeta(meta.id)!
    expect(after.sdkSessionId).toBeUndefined()
    expect(after.resumeAtMessageUuid).toBeUndefined()
  })

  test('a non-resume failure is replayed to the caller unchanged', async () => {
    const meta = sessions.createAgentSession('普通失败', 'channel-1', undefined, 'model-1', 'claude')
    sessions.updateAgentSessionMeta(meta.id, { sdkSessionId: 'sdk-ok' })

    const h = harness([(callbacks) => {
      callbacks.onError?.('模型返回 500')
      return { status: 'failed', error: '模型返回 500' }
    }])

    const outcome = await entry.runRuntimeHeadlessEntry(sendInput(meta.id), { onEvent: () => {} }, deps(h, h.outerErrors))
    expect(outcome.status).toBe('failed')
    expect(h.queries).toHaveLength(1)
    expect(h.outerErrors).toEqual(['模型返回 500'])
  })
})
