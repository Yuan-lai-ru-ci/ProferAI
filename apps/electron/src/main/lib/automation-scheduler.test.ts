import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { AgentRun } from '@profer/agent-runtime'
import type { HeadlessAgentRunCallbacks } from './agent-headless-runner-registry'
import { buildAutomationDispatchMetadata, createAutomationTriggerId, transitionAutomationTrigger, isSettledAutomationTrigger } from './automation-dispatch'
import { normalizeAgentRuntime, AUTOMATION_DEFAULT_SESSION_MODE, AUTOMATION_MAX_CONSECUTIVE_FAILURES, type AgentRuntime, type AgentSessionMeta, type AgentSendInput, type Automation, type AutomationRun, type AutomationTriggerRecord } from '@profer/shared'

// 真实调度函数配受控 headless/存储边界；不启动调度器、不连接模型或发送通知。
const source = readFileSync(new URL('./automation-scheduler.ts', import.meta.url), 'utf8')
const start = source.indexOf('export async function runAutomation(')
const body = source.slice(start, source.indexOf('/** 立即运行一次', start)).replace('export ', '')
const transpiler = new Bun.Transpiler({ loader: 'ts', target: 'bun' })
function fixture(runtime: AgentRuntime, taskRuntime: AgentRuntime, mode: 'reuse' | 'daily', graduated = false, blocked?: unknown, initiallyBusy = false, runnerThrows = false, controlled = false, workspaceMissing = false) {
  const original: AgentSessionMeta = {
    id: 'old', title: 'old history', createdAt: 1, updatedAt: 2, agentRuntime: runtime,
    channelId: 'channel', workspaceId: 'workspace', modelId: 'model', presetId: 'standard',
    sdkSessionId: 'native-old', piSessionFile: runtime === 'pi' ? '/old.jsonl' : undefined,
    agentRuntimeLocked: true, automationGraduated: graduated,
  }
  const sessions = new Map<string, AgentSessionMeta>([['old', original]])
  const updates: Array<{ id: string; patch: Partial<AgentSessionMeta> }> = []
  const inputs: AgentSendInput[] = []
  const runtimeInputs: AgentSendInput[] = []
  /** 只记旧入口：用来断言「新分支确实没走旧入口」。 */
  const legacyInputs: AgentSendInput[] = []
  const runs: AutomationRun[] = []
  const lastIds: string[] = []
  const notifications: AutomationRun[] = []
  const updateCalls: Array<{ id: string; active?: boolean }> = []
  const triggers: AutomationTriggerRecord[] = []
  const broadcasts: Array<Array<Pick<AutomationTriggerRecord, 'triggerId' | 'status' | 'runId' | 'error'>>> = []
  const sharedRuns = new Map<string, AgentRun>()
  let ledgerError: Error | undefined
  let capturedCallbacks: HeadlessAgentRunCallbacks | undefined
  let resolveRunner: () => void = () => { throw new Error('runner not started') }
  let rejectRunner: (error: Error) => void = () => { throw new Error('runner not started') }
  const setSharedOutcome = (status: AgentRun['status'], error?: string): void => {
    const input = runtimeInputs.at(-1) ?? inputs.at(-1)
    const run = input?.triggerId ? sharedRuns.get(input.triggerId) : undefined
    if (!run) throw new Error('shared run not started')
    sharedRuns.set(run.triggerId, { ...run, status, failureReason: error,
      finishedAt: status === 'completed' || status === 'failed' || status === 'stopped' ? Date.now() : undefined })
  }
  const invokeHeadless = (input: AgentSendInput, callbacks: HeadlessAgentRunCallbacks): Promise<void> => {
    capturedCallbacks = callbacks
    if (runnerThrows) throw new Error('fixture runner failed')
    sharedRuns.set(input.triggerId!, { schemaVersion: 1, id: `run:${input.triggerId}`, triggerId: input.triggerId!, sessionRef: input.sessionId,
      executorRef: 'fixture', runtime: taskRuntime, status: 'running', createdAt: Date.now(), startedAt: Date.now() })
    if (controlled) return new Promise<void>((resolve, reject) => { resolveRunner = resolve; rejectRunner = reject })
    setSharedOutcome('completed')
    callbacks.onComplete([], { resultSubtype: 'success' })
    return Promise.resolve()
  }
  let sessionBusy = initiallyBusy
  const deps = {
    normalizeAgentRuntime, AUTOMATION_DEFAULT_SESSION_MODE, AUTOMATION_MAX_CONSECUTIVE_FAILURES,
    randomUUID, createAutomationTriggerId, buildAutomationDispatchMetadata, transitionAutomationTrigger, isSettledAutomationTrigger,
    findAgentRunForTrigger: (triggerId: string) => { if (ledgerError) throw ledgerError; return sharedRuns.get(triggerId) },
    validateBoundAutomationChannel: (automation: Automation, session: AgentSessionMeta, channel: { enabled: boolean; provider: string; agentRuntimes?: AgentRuntime[]; agentExperimentalEnabled?: boolean; models: Array<{ id: string; enabled: boolean }> } | undefined) => {
      if (!channel?.enabled || !channel.models.some((model) => model.id === session.modelId && model.enabled)) return { valid: false, reason: 'fixture channel unavailable' } as const
      if (automation.modelId && automation.modelId !== session.modelId) return { valid: false, reason: 'fixture model mismatch' } as const
      return { valid: true } as const
    },
    validateBoundAutomationSession: (automation: Automation, session: AgentSessionMeta | undefined, expectedPresetId?: string) => {
      if (!session) return { valid: false, reason: '绑定会话不存在或不可访问' } as const
      if (session.workspaceId !== automation.workspaceId || session.channelId !== automation.channelId || (session.agentRuntime ?? 'claude') !== (automation.agentRuntime ?? 'claude')) {
        return { valid: false, reason: '绑定会话配置不匹配' } as const
      }
      if (expectedPresetId && session.presetId !== expectedPresetId) return { valid: false, reason: '绑定会话预设不匹配' } as const
      return { valid: true } as const
    },
    enqueueAutomationTrigger: (record: AutomationTriggerRecord) => {
      const existing = triggers.find((trigger) => trigger.triggerId === record.triggerId)
      if (existing) return existing
      triggers.push(record)
      return record
    },
    getAutomationTrigger: (triggerId: string) => triggers.find((trigger) => trigger.triggerId === triggerId),
    getPendingAutomationTrigger: (automationId: string) => triggers.find((trigger) =>
      trigger.automationId === automationId && (trigger.status === 'queued' || trigger.status === 'blocked' || trigger.status === 'running'),
    ),
    transitionAutomationTriggerRecord: (triggerId: string, status: AutomationTriggerRecord['status'], patch: Partial<AutomationTriggerRecord> = {}) => {
      const position = triggers.findIndex((trigger) => trigger.triggerId === triggerId)
      if (position < 0) return undefined
      triggers[position] = transitionAutomationTrigger(triggers[position]!, status, Date.now(), patch)
      return triggers[position]
    },
    linkAutomationTriggerRun: (triggerId: string, runId: string, sessionId?: string) => {
      const trigger = triggers.find((record) => record.triggerId === triggerId)
      if (trigger) { trigger.runId = runId; if (sessionId) trigger.targetSessionId = sessionId }
      return trigger
    },
    settleAutomationTrigger: (triggerId: string, run: AutomationRun) => {
      const position = triggers.findIndex((record) => record.triggerId === triggerId)
      const trigger = triggers[position]
      if (!trigger || !['queued', 'blocked', 'running'].includes(trigger.status)) return undefined
      triggers[position] = transitionAutomationTrigger(trigger, run.status === 'success' ? 'completed' : 'failed', Date.now(), { runId: run.runId, error: run.error, targetSessionId: run.sessionId })
      runs.push(run)
      return { active: true, consecutiveFailures: 0 }
    },
    isAgentSessionActive: () => sessionBusy,
    setSessionBusy: (busy: boolean) => { sessionBusy = busy },
    runningAutomations: new Set<string>(), RUN_TIMEOUT_MS: 10000, DAILY_CONTEXT_ROLLOVER_THRESHOLD: 0.7,
    isSameLocalDay: () => true, getSessionContextUsageRatio: () => 0.2,
    getAgentSessionMeta: (id: string) => sessions.get(id), getAgentWorkspace: () => (workspaceMissing ? undefined : { slug: 'workspace' }), getChannelById: () => ({ enabled: true, provider: 'fixture', models: [{ id: 'model', enabled: true }] }),
    // 调度器改用可见变体；该 harness 直接求值源码文本，需同步提供导出。
    getVisibleChannelById: () => ({ enabled: true, provider: 'fixture', models: [{ id: 'model', enabled: true }] }),
    getAgentWorkspacePath: () => '/tmp/fixture-workspace',
    getDefaultPresetId: () => 'standard', resolvePresetId: (_slug: string, preset: string) => preset,
    createAgentSession: (title: string, channelId: string, workspaceId: string, modelId: string, runtime: AgentRuntime) => {
      const session: AgentSessionMeta = { id: 'new', title, channelId, workspaceId, modelId, agentRuntime: runtime, agentRuntimeLocked: false, createdAt: 3, updatedAt: 3 }
      sessions.set(session.id, session); return session
    },
    updateAgentSessionMeta: (id: string, patch: Partial<AgentSessionMeta>) => { updates.push({ id, patch }); sessions.set(id, { ...sessions.get(id)!, ...patch }) },
    setLastSessionId: (_id: string, sessionId: string) => lastIds.push(sessionId),
    getAutomation: () => undefined, updateAutomation: (input: { id: string; active?: boolean }) => { updateCalls.push(input) }, broadcastChanged: () => { broadcasts.push(triggers.map(({ triggerId, status, runId, error }) => ({ triggerId, status, runId, error }))) },
    appendRun: (_id: string, run: AutomationRun) => runs.push(run),
    notifyAutomationRunFinished: async ({ run }: { run: AutomationRun }) => { notifications.push(run) },
    formatScheduleLabel: () => 'fixture',
    runAgentHeadless: (input: AgentSendInput, callbacks: HeadlessAgentRunCallbacks) => { inputs.push(input); legacyInputs.push(input); return invokeHeadless(input, callbacks) },
    // 默认已切新链：两条路由都把 input 记进 inputs（断言「选中了哪个会话」与链无关），
    // runtimeInputs 只用于「哪条分支被调用」的比较。
    runAgentRuntimeHeadless: (input: AgentSendInput, callbacks: HeadlessAgentRunCallbacks) => { inputs.push(input); runtimeInputs.push(input); return invokeHeadless(input, callbacks) },
    // runtime 分支的预检依赖：默认返回 undefined（无阻塞）；用例可注入阻塞原因。
    peekAgentRunClaimFailureForSession: () => blocked,
    describeAgentRunRejection: () => 'fixture rejection',
    setTimeout, clearTimeout, console: { log() {}, warn() {}, error() {} },
  }
  const run = new Function(...Object.keys(deps), `${transpiler.transformSync(body)}\nreturn runAutomation`)(...Object.values(deps)) as (input: Automation, manual?: boolean) => Promise<void>
  const task = { id: 'task', name: 'task', prompt: 'work', channelId: 'channel', workspaceId: 'workspace', modelId: 'model', lastSessionId: 'old', lastRunAt: Date.now(), nextRunAt: 7, sessionMode: mode, agentRuntime: taskRuntime } as Automation
  return { run: (input: Automation = task, manual = false) => run(input, manual), task, sessions, original, updates, inputs, runtimeInputs, legacyInputs, runs, notifications, lastIds, triggers, broadcasts, updateCalls,
    sharedRuns, setSharedOutcome, setLedgerError: (error?: Error) => { ledgerError = error }, callbacks: () => capturedCallbacks!, resolveRunner: () => resolveRunner(), rejectRunner: (error: Error) => rejectRunner(error), setSessionBusy: deps.setSessionBusy }
}

describe('定时任务复用会话遵守内核归属', () => {
  for (const mode of ['reuse', 'daily'] as const) {
    test.each(['pi', 'claude'] as const)(`${mode}: %s 任务更换内核时新建会话，旧恢复字段原样保留`, async (runtime) => {
      const f = fixture(runtime, runtime === 'pi' ? 'claude' : 'pi', mode)
      await f.run()
      expect(f.inputs).toHaveLength(1)
      expect(f.inputs[0]?.sessionId).toBe('new')
      expect(f.inputs[0]?.agentRuntime).not.toBe(runtime)
      expect(f.lastIds).toEqual(['new'])
      expect(f.sessions.get('old')).toEqual(f.original)
      expect(f.updates.some((update) => update.id === 'old')).toBe(false)
      expect(f.runs[0]).toMatchObject({ status: 'success', sessionId: 'new' })
    })
    test.each(['pi', 'claude'] as const)(`${mode}: %s 相同内核复用旧会话，不丢上下文`, async (runtime) => {
      const f = fixture(runtime, runtime, mode)
      await f.run()
      expect(f.inputs[0]).toMatchObject({ sessionId: 'old', agentRuntime: runtime })
      expect(f.lastIds).toEqual([])
      expect(f.sessions.get('old')).toEqual(f.original)
      expect(f.updates).toEqual([])
    })
  }
  test('被用户接管的会话即使内核相同也不复用', async () => {
    const f = fixture('pi', 'pi', 'reuse', true)
    await f.run()
    expect(f.inputs[0]?.sessionId).toBe('new')
    expect(f.sessions.get('old')).toEqual(f.original)
  })

  test('旧会话被移动到别的项目后不再复用，避免在旧项目里执行', async () => {
    const f = fixture('claude', 'claude', 'reuse')
    f.sessions.set('old', { ...f.original, workspaceId: 'other-project' })

    await f.run()

    expect(f.inputs[0]?.sessionId).toBe('new')
    expect(f.lastIds).toEqual(['new'])
  })
})

describe('Automation session binding and queue', () => {
  test('boundSessionId wins over daily/reuse child routing and carries trusted origin plus author', async () => {
    const f = fixture('pi', 'pi', 'daily')
    await f.run({
      id: 'task', name: 'task', prompt: 'work', channelId: 'channel', workspaceId: 'workspace', modelId: 'model',
      lastSessionId: 'old', lastRunAt: Date.now(), nextRunAt: 7, sessionMode: 'daily', agentRuntime: 'pi',
      boundSessionId: 'old', promptAuthor: { type: 'agent', id: 'source-session' },
    } as Automation)
    const sent = f.runtimeInputs[0] ?? f.inputs[0]
    expect(sent).toMatchObject({
      sessionId: 'old',
      taskId: 'automation:task',
      triggerId: 'task:7',
      taskOrigin: { actor: { type: 'automation', id: 'task' } },
      taskAuthorization: { kind: 'scheduled', sourceRef: { type: 'automation', id: 'task' } },
      messageAuthor: { type: 'agent', id: 'source-session' },
    })
  })

  test('busy bound target stays queued without a run, then resumes the same trigger', async () => {
    const f = fixture('claude', 'claude', 'reuse', false, undefined, true)
    const task = {
      id: 'task', name: 'task', prompt: 'work', channelId: 'channel', workspaceId: 'workspace', modelId: 'model',
      lastSessionId: 'old', lastRunAt: Date.now(), nextRunAt: 7, sessionMode: 'reuse', agentRuntime: 'claude', boundSessionId: 'old',
    } as Automation
    await f.run(task)
    expect(f.triggers[0]).toMatchObject({ triggerId: 'task:7', status: 'queued' })
    expect(f.runs).toHaveLength(0)
    f.setSessionBusy(false)
    await f.run(task)
    expect(f.inputs[0]?.sessionId).toBe('old')
    expect(f.triggers[0]?.status).toBe('completed')
    expect(f.triggers).toHaveLength(1)
  })

  test('synchronous runner failure settles the claimed trigger instead of leaving it running', async () => {
    const f = fixture('claude', 'claude', 'reuse', false, undefined, false, true)
    await f.run()
    expect(f.triggers[0]).toMatchObject({ status: 'failed', error: 'fixture runner failed' })
    expect(f.runs[0]).toMatchObject({ status: 'error', error: 'fixture runner failed' })
  })

  test('deleted bound target is retained as blocked with a reason, not rerouted or counted as a run', async () => {
    const f = fixture('claude', 'claude', 'reuse')
    await f.run({
      id: 'task', name: 'task', prompt: 'work', channelId: 'channel', workspaceId: 'workspace', modelId: 'model',
      lastSessionId: 'old', lastRunAt: Date.now(), nextRunAt: 7, sessionMode: 'reuse', agentRuntime: 'claude', boundSessionId: 'missing',
    } as Automation)
    expect(f.triggers[0]).toMatchObject({ status: 'blocked', error: '定时任务目标会话不可用：绑定会话不存在或不可访问' })
    expect(f.runs).toHaveLength(0)
    expect(f.inputs).toHaveLength(0)
    expect(f.runtimeInputs).toHaveLength(0)
    expect(f.sessions.has('new')).toBe(false)
    expect(f.lastIds).toHaveLength(0)
    expect(f.updates).toHaveLength(0)
  })
})

describe('Automation trigger visibility broadcasts', () => {
  test('queue creation broadcasts immediately even if an unbound target is busy', async () => {
    const f = fixture('claude', 'claude', 'reuse', false, undefined, true)
    await f.run()
    expect(f.inputs).toHaveLength(0)
    expect(f.broadcasts.some((snapshot) => snapshot.some((trigger) => trigger.status === 'queued'))).toBe(true)
  })

  test('running state, real Run linkage and terminal settlement each refresh the existing LIST projection', async () => {
    const f = fixture('claude', 'claude', 'reuse', false, undefined, false, false, true)
    const pending = f.run()
    expect(f.broadcasts.some((snapshot) => snapshot.some((trigger) => trigger.status === 'running'))).toBe(true)
    expect(f.broadcasts.at(-1)?.[0]).toMatchObject({ status: 'running', runId: 'run:task:7' })
    f.setSharedOutcome('completed')
    f.callbacks().onComplete([], { resultSubtype: 'success' })
    f.resolveRunner()
    await pending
    expect(f.broadcasts.at(-1)?.[0]?.status).toBe('completed')
  })

  test('blocked reason and recovery to queued broadcast while the target remains busy', async () => {
    const f = fixture('claude', 'claude', 'reuse', false, undefined, true)
    const task = { ...f.task, boundSessionId: 'missing' }
    await f.run(task)
    expect(f.broadcasts.at(-1)?.[0]?.status).toBe('blocked')
    f.sessions.set('missing', { ...f.original, id: 'missing' })
    await f.run(task)
    expect(f.broadcasts.at(-1)?.[0]).toMatchObject({ status: 'queued', error: undefined })
  })
})

describe('Automation shared Run settlement', () => {
  for (const runtime of ['claude', 'pi'] as const) {
    test(`${runtime}: background completion and onError keep the trigger open until the ledger finishes`, async () => {
      const f = fixture(runtime, runtime, 'reuse', false, undefined, false, false, true)
      const pending = f.run()
      f.callbacks().onComplete([], { backgroundTasksPending: true })
      f.callbacks().onError('recoverable provider error')
      expect(f.runs).toHaveLength(0)
      expect(f.notifications).toHaveLength(0)
      expect(f.triggers[0]).toMatchObject({ status: 'running', runId: 'run:task:7' })
      f.setSharedOutcome('completed')
      f.callbacks().onComplete([], { resultSubtype: 'success' })
      f.resolveRunner()
      await pending
      expect(f.triggers[0]).toMatchObject({ status: 'completed', runId: 'run:task:7' })
      expect(f.runs).toHaveLength(1)
      expect(f.runs[0]).toMatchObject({ status: 'success', runId: 'run:task:7' })
    })

    test(`${runtime}: nominal completion cannot succeed before shared Run finish`, async () => {
      const f = fixture(runtime, runtime, 'reuse', false, undefined, false, false, true)
      const pending = f.run()
      f.callbacks().onComplete([], { resultSubtype: 'success' })
      expect(f.runs).toHaveLength(0)
      f.setSharedOutcome('completed')
      f.resolveRunner()
      await pending
      expect(f.runs[0]).toMatchObject({ status: 'success', runId: 'run:task:7' })
    })

    test(`${runtime}: preparation error waits for real completion and fails instead of succeeding`, async () => {
      const f = fixture(runtime, runtime, 'reuse', false, undefined, false, false, true)
      const pending = f.run()
      f.callbacks().onError('preparation failed')
      expect(f.runs).toHaveLength(0)
      f.setSharedOutcome('failed', 'preparation failed')
      f.callbacks().onComplete([], { resultSubtype: 'error_during_execution', resultErrors: ['preparation failed'] })
      f.resolveRunner()
      await pending
      expect(f.triggers[0]).toMatchObject({ status: 'failed', runId: 'run:task:7' })
      expect(f.runs[0]).toMatchObject({ status: 'error', error: 'preparation failed', runId: 'run:task:7' })
    })

    test(`${runtime}: rejected headless promise settles failure with its real Run ID`, async () => {
      const f = fixture(runtime, runtime, 'reuse', false, undefined, false, false, true)
      const pending = f.run()
      f.rejectRunner(new Error('headless rejected'))
      await pending
      expect(f.triggers[0]).toMatchObject({ status: 'failed', runId: 'run:task:7' })
      expect(f.runs[0]).toMatchObject({ status: 'error', error: 'headless rejected', runId: 'run:task:7' })
    })
  }

  for (const status of ['completed', 'failed', 'stopped', 'running', 'waiting', 'queued'] as const) {
    test(`existing ${status} shared Run is reconciled before session routing and never replayed`, async () => {
      const f = fixture('claude', 'claude', 'daily')
      f.sharedRuns.set('task:7', { schemaVersion: 1, id: 'prior-run', triggerId: 'task:7', sessionRef: 'prior-session',
        runtime: 'claude', executorRef: 'fixture', status, createdAt: 1, startedAt: 2,
        ...(['completed', 'failed', 'stopped'].includes(status) ? { finishedAt: 3 } : {}),
        ...(status === 'failed' ? { failureReason: 'original failure' } : {}) })
      await f.run({ ...f.task, lastSessionId: undefined })
      expect(f.inputs).toHaveLength(0)
      expect(f.runtimeInputs).toHaveLength(0)
      expect(f.sessions.has('new')).toBe(false)
      expect(f.triggers[0]?.runId).toBe('prior-run')
      if (status === 'completed') {
        expect(f.triggers[0]?.status).toBe('completed')
        expect(f.runs[0]).toMatchObject({ status: 'success', runId: 'prior-run', sessionId: 'prior-session' })
      } else if (status === 'failed' || status === 'stopped') {
        expect(f.triggers[0]?.status).toBe('failed')
        expect(f.runs[0]).toMatchObject({ status: 'error', runId: 'prior-run' })
      } else {
        expect(f.triggers[0]?.status).toBe('blocked')
        expect(f.triggers[0]?.error).toContain(status)
        expect(f.runs).toHaveLength(0)
      }
    })
  }

  test('Promise rejection remains failure even if a terminal ledger snapshot was observed without completion', async () => {
    const f = fixture('claude', 'claude', 'reuse', false, undefined, false, false, true)
    const pending = f.run()
    f.setSharedOutcome('completed')
    f.rejectRunner(new Error('headless rejected after ledger write'))
    await pending
    expect(f.runs[0]).toMatchObject({ status: 'error', error: 'headless rejected after ledger write', runId: 'run:task:7' })
  })

  test('preparation completion with only endReason preserves failure without a shared Run', async () => {
    const f = fixture('claude', 'claude', 'reuse', false, undefined, false, false, true)
    const pending = f.run()
    f.sharedRuns.clear()
    f.callbacks().onComplete([], { endReason: 'error', endReasonLabel: '准备运行失败' })
    f.resolveRunner()
    await pending
    expect(f.runs[0]).toMatchObject({ status: 'error', error: '准备运行失败' })
  })

  test('ledger read failures before dispatch or during lightweight completion never launch/replay or claim success', async () => {
    const blocked = fixture('claude', 'claude', 'reuse')
    blocked.setLedgerError(new Error('ledger unavailable'))
    await blocked.run()
    expect(blocked.inputs).toHaveLength(0)
    expect(blocked.triggers[0]).toMatchObject({ status: 'blocked' })
    expect(blocked.triggers[0]?.error).toContain('ledger unavailable')
    const active = fixture('claude', 'claude', 'reuse', false, undefined, false, false, true)
    const pending = active.run()
    active.setLedgerError(new Error('ledger unavailable'))
    expect(() => active.callbacks().onComplete([], { backgroundTasksPending: true })).not.toThrow()
    expect(active.runs).toHaveLength(0)
    active.resolveRunner()
    await pending
    expect(active.triggers[0]?.status).toBe('blocked')
    expect(active.runs).toHaveLength(0)
  })

  test('runtime coordinator route preserves background wait and both provider Run IDs', async () => {
    await withRuntimeAutomation(async () => {
      for (const runtime of ['claude', 'pi'] as const) {
        const f = fixture(runtime, runtime, 'reuse', false, undefined, false, false, true)
        const pending = f.run()
        f.callbacks().onComplete([], { backgroundTasksPending: true })
        f.callbacks().onError('transient error')
        expect(f.runs).toHaveLength(0)
        f.setSharedOutcome('completed')
        f.callbacks().onComplete([], { resultSubtype: 'success' })
        f.resolveRunner()
        await pending
        expect(f.runtimeInputs).toHaveLength(1)
        expect(f.legacyInputs).toHaveLength(0)
        expect(f.runs[0]).toMatchObject({ status: 'success', runId: 'run:task:7' })
      }
    })
  })

  test('headless resolution with a still-running shared Run blocks until a later ledger reconciliation', async () => {
    const f = fixture('claude', 'claude', 'reuse', false, undefined, false, false, true)
    const pending = f.run()
    f.callbacks().onComplete([], { backgroundTasksPending: true })
    f.resolveRunner()
    await pending
    expect(f.triggers[0]).toMatchObject({ status: 'blocked', runId: 'run:task:7' })
    expect(f.runs).toHaveLength(0)
    f.setSharedOutcome('completed')
    await f.run()
    expect(f.runs[0]).toMatchObject({ status: 'success', runId: 'run:task:7' })
    expect(f.inputs).toHaveLength(1)
  })

  test('repeated terminal callbacks and Promise completion settle once', async () => {
    const f = fixture('claude', 'claude', 'reuse', false, undefined, false, false, true)
    const pending = f.run()
    f.setSharedOutcome('completed')
    f.callbacks().onComplete([], { resultSubtype: 'success' })
    f.callbacks().onComplete([], { resultSubtype: 'success' })
    f.callbacks().onError('late duplicate error')
    f.resolveRunner()
    await pending
    expect(f.runs).toHaveLength(1)
    expect(f.notifications).toHaveLength(1)
    expect(f.runs[0]?.status).toBe('success')
  })

  test('completion without a shared Run never reports success; preparation errors still settle failure', async () => {
    for (const preparationFailed of [false, true]) {
      const f = fixture('claude', 'claude', 'reuse', false, undefined, false, false, true)
      const pending = f.run()
      f.sharedRuns.clear()
      if (preparationFailed) f.callbacks().onError('setup failed before Run creation')
      expect(f.runs).toHaveLength(0)
      f.callbacks().onComplete([], preparationFailed ? { resultErrors: ['setup failed before Run creation'] } : { resultSubtype: 'success' })
      f.resolveRunner()
      await pending
      if (preparationFailed) {
        expect(f.triggers[0]?.status).toBe('failed')
        expect(f.runs[0]).toMatchObject({ status: 'error', error: 'setup failed before Run creation' })
      } else {
        expect(f.triggers[0]?.status).toBe('blocked')
        expect(f.runs).toHaveLength(0)
      }
    }
  })

  test('waiting/queued run is polled to its eventual terminal state without a second headless call', async () => {
    const f = fixture('claude', 'claude', 'reuse')
    const shared: AgentRun = { schemaVersion: 1, id: 'prior-run', triggerId: 'task:7', sessionRef: 'old',
      runtime: 'claude', executorRef: 'fixture', status: 'queued', createdAt: 1 }
    f.sharedRuns.set(shared.triggerId, shared)
    await f.run()
    expect(f.triggers[0]?.status).toBe('blocked')
    f.sharedRuns.set(shared.triggerId, { ...shared, status: 'completed', startedAt: 2, finishedAt: 3 })
    await f.run()
    await f.run()
    expect(f.runs).toHaveLength(1)
    expect(f.runs[0]).toMatchObject({ status: 'success', runId: 'prior-run' })
    expect(f.inputs).toHaveLength(0)
  })

  test('completed without finishedAt and a prior execution target without Run both block instead of replay', async () => {
    const f = fixture('claude', 'claude', 'reuse')
    f.sharedRuns.set('task:7', { schemaVersion: 1, id: 'unfinished-terminal', triggerId: 'task:7', sessionRef: 'old',
      runtime: 'claude', executorRef: 'fixture', status: 'completed', createdAt: 1 })
    await f.run()
    expect(f.triggers[0]?.status).toBe('blocked')
    expect(f.runs).toHaveLength(0)
    expect(f.inputs).toHaveLength(0)
    const missing = fixture('claude', 'claude', 'reuse')
    missing.triggers.push({ triggerId: 'task:7', occurrenceId: 'task:7', automationId: 'task', scheduledAt: 7,
      status: 'queued', targetSessionId: 'old', createdAt: 1, updatedAt: 1 })
    await missing.run()
    expect(missing.triggers[0]?.status).toBe('blocked')
    expect(missing.inputs).toHaveLength(0)
  })

  test('missing shared Run for a previously linked trigger blocks without replay', async () => {
    const f = fixture('claude', 'claude', 'daily')
    f.triggers.push({ triggerId: 'task:7', occurrenceId: 'task:7', automationId: 'task', scheduledAt: 7,
      status: 'queued', runId: 'missing-run', createdAt: 1, updatedAt: 1 })
    await f.run()
    expect(f.inputs).toHaveLength(0)
    expect(f.triggers[0]).toMatchObject({ status: 'blocked', runId: 'missing-run' })
    expect(f.triggers[0]?.error).toContain('无法确认')
  })

  test('restart-interrupted trigger remains terminal and is never replayed', async () => {
    const f = fixture('claude', 'claude', 'daily')
    f.triggers.push({ triggerId: 'task:7', occurrenceId: 'task:7', automationId: 'task', scheduledAt: 7,
      status: 'interrupted', runId: 'interrupted-run', createdAt: 1, updatedAt: 1 })
    await f.run()
    expect(f.inputs).toHaveLength(0)
    expect(f.triggers[0]).toMatchObject({ status: 'interrupted', runId: 'interrupted-run' })
    expect(f.runs).toHaveLength(0)
  })
})

describe('runtime coordinator automation 默认路由', () => {
  test('Given the default scheduler When running automation Then the runtime chain is the default and explicit 0 rolls back', () => {
    expect(source).toContain("process.env.PROFER_RUNTIME_AUTOMATION !== '0'")
    expect(source).toContain('runAgentRuntimeHeadless(')
    expect(source).toContain('runAgentHeadless(headlessInput, callbacks)')
    expect(source).toContain('automationContext:')
  })
})

/** 打开 runtime 分支的开关，跑完恢复（避免污染其它测试文件）。 */
async function withRuntimeAutomation<T>(body: () => Promise<T>): Promise<T> {
  const previous = process.env.PROFER_RUNTIME_AUTOMATION
  process.env.PROFER_RUNTIME_AUTOMATION = '1'
  try {
    return await body()
  } finally {
    if (previous === undefined) delete process.env.PROFER_RUNTIME_AUTOMATION
    else process.env.PROFER_RUNTIME_AUTOMATION = previous
  }
}

describe('AutomationRun 字段语义：新分支与旧分支不漂移', () => {
  test('成功一轮：两侧都只写 {status:success, durationMs}，且通知收到同一份 run', async () => {
    const legacy = fixture('claude', 'claude', 'reuse')
    await legacy.run()
    const runtime = await withRuntimeAutomation(async () => {
      const f = fixture('claude', 'claude', 'reuse')
      await f.run()
      return f
    })

    for (const f of [legacy, runtime]) {
      expect(f.runs).toHaveLength(1)
      const run = f.runs[0]!
      expect(run.status).toBe('success')
      expect(typeof run.durationMs).toBe('number')
      // finish() 统一构造 `{ runAt, sessionId, status, durationMs, error }`：成功时 error 为 undefined
      // （JSON 落盘时被丢弃），两侧一致。
      expect(run.error).toBeUndefined()
      expect(Object.prototype.hasOwnProperty.call(run, 'skipReason')).toBe(false)
      expect(f.notifications).toEqual([run])
    }
    // 新分支确实走的是 runtime 入口（不是旧入口）
    expect(runtime.runtimeInputs).toHaveLength(1)
    expect(runtime.legacyInputs).toHaveLength(0)
    expect(legacy.inputs).toHaveLength(1)
    expect(runtime.runtimeInputs[0]).toMatchObject({
      taskId: 'automation:task',
      triggerId: 'task:7',
      taskOrigin: { actor: { type: 'automation', id: 'task' } },
      taskAuthorization: { kind: 'scheduled' },
      messageAuthor: { type: 'automation', id: 'task' },
    })
    expect(legacy.inputs[0]).toMatchObject({
      taskId: 'automation:task',
      triggerId: 'task:7',
      taskOrigin: { actor: { type: 'automation', id: 'task' } },
      taskAuthorization: { kind: 'scheduled' },
      messageAuthor: { type: 'automation', id: 'task' },
    })
  })

  test('未取得执行权时保持 queued，不写 skipped 或失败运行，也不启动 Agent', async () => {
    await withRuntimeAutomation(async () => {
      const f = fixture('claude', 'claude', 'reuse', false, { reason: 'session_busy' })
      await f.run()
      expect(f.runs).toHaveLength(0)
      expect(f.triggers[0]).toMatchObject({ status: 'queued', automationId: 'task' })
      expect(f.runtimeInputs).toHaveLength(0)
      expect(f.inputs).toHaveLength(0)
      expect(f.notifications).toEqual([])
    })
  })

  test('预检为阻塞时两侧都保持 queued，不产生跳过历史或失败运行', async () => {
    const legacy = fixture('claude', 'claude', 'reuse', false, { reason: 'session_busy' })
    await legacy.run()
    expect(legacy.runs).toHaveLength(0)
    expect(legacy.triggers[0]?.status).toBe('queued')
    expect(legacy.inputs).toHaveLength(0)

    await withRuntimeAutomation(async () => {
      const runtime = fixture('claude', 'claude', 'reuse', false, { reason: 'session_busy' })
      await runtime.run()
      expect(runtime.runs).toHaveLength(0)
      expect(runtime.triggers[0]?.status).toBe('queued')
      expect(runtime.runtimeInputs).toHaveLength(0)
    })
  })

  test('源码核对：两侧共用同一组 callbacks，busy 分支保留队列而不启动 run', () => {
    expect(source).toContain('const callbacks: HeadlessAgentRunCallbacks = {')
    expect(source).toContain('onError: (error) => { observedError = error }')
    expect(source).toContain('if (opts?.backgroundTasksPending)')
    expect(source).toContain('runAgentRuntimeHeadless(headlessInput, callbacks)')
    expect(source).toContain('runAgentHeadless(headlessInput, callbacks)')
    const busy = source.slice(source.indexOf('if (automationBlocked) {'), source.indexOf('const runtimeRun = useRuntimeAutomation'))
    expect(busy).toContain('resolveRun()')
    expect(busy).not.toContain("status: 'skipped'")
    expect(busy).not.toContain('finish(')
  })

  test('字段集核对：AutomationRun 只有 status/durationMs/error/skipReason，没有 endReason 系列', () => {
    const sharedSource = readFileSync(new URL('../../../../../packages/shared/src/types/automation.ts', import.meta.url), 'utf8')
    const runInterface = sharedSource.slice(
      sharedSource.indexOf('export interface AutomationRun {'),
      sharedSource.indexOf('/** 调度模式 */'),
    )
    expect(runInterface).toContain("status: 'success' | 'error' | 'skipped'")
    expect(runInterface).toContain('durationMs?')
    expect(runInterface).toContain('error?')
    expect(runInterface).toContain('skipReason?')
    // endReason / endReasonLabel / resultErrors 属于 run_completed 事件（渲染层 toast），不属于运行记录。
    expect(runInterface).not.toContain('endReason')
    expect(runInterface).not.toContain('resultErrors')
  })

  test('连续失败退避：只有 error 累加，skipped/success 清零（appendRun 源码核对）', () => {
    const managerSource = readFileSync(new URL('./automation-manager.ts', import.meta.url), 'utf8')
    const appendRun = managerSource.slice(
      managerSource.indexOf('export function appendRun('),
      managerSource.indexOf('/** 设置 nextRunAt'),
    )
    expect(appendRun).toContain("if (run.status === 'error') {")
    expect(appendRun).toContain('target.consecutiveFailures = (target.consecutiveFailures ?? 0) + 1')
    // skipped 不推进 nextRunAt / runCount（否则重入跳过会把周期拉长）
    expect(appendRun).toContain("if (run.status !== 'skipped') {")
  })
})

describe('工作区已移除时绝不执行（P1-3）', () => {
  test('定时触发：workspace 解析不到时停用任务、不建会话、不进 headless（不会以 homedir 为 cwd）', async () => {
    const f = fixture('claude', 'claude', 'reuse', false, undefined, false, false, false, true)

    await f.run()

    expect(f.inputs).toHaveLength(0)
    expect(f.runtimeInputs).toHaveLength(0)
    expect(f.sessions.has('new')).toBe(false)
    expect(f.lastIds).toHaveLength(0)
    expect(f.updates).toHaveLength(0)
    expect(f.runs).toHaveLength(0)
    // 任务被停用（否则每个 tick 都会重试）
    expect(f.updateCalls).toEqual([{ id: 'task', active: false }])
    expect(f.broadcasts.length).toBeGreaterThan(0)
  })

  test('手动触发：同样不执行，并抛可操作错误提示用户重选工作区', async () => {
    const f = fixture('claude', 'claude', 'reuse', false, undefined, false, false, false, true)

    await expect(f.run(f.task, true)).rejects.toThrow('该定时任务绑定的项目已被移除')

    expect(f.inputs).toHaveLength(0)
    expect(f.runtimeInputs).toHaveLength(0)
    expect(f.updateCalls).toEqual([{ id: 'task', active: false }])
  })
})
