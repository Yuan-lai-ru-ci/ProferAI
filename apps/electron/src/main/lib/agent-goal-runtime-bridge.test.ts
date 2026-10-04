import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { resolveRunInitiator } from '@profer/shared'
import type { AgentMessage, AgentSendInput, AgentStreamPayload, SDKMessage } from '@profer/shared'
import type { AgentOrchestrator, SessionCallbacks } from './agent-orchestrator'
import { AgentRunAlreadyActiveError, releaseActiveSession, tryAcquireActiveSession } from './agent-orchestrator-p0-guards'
import { normalizeAgentEndReason } from './agent-end-reason'
import { shouldClearSessionUnreadOnRunStart, shouldMarkSessionUnreadOnCompletion } from './agent-unread-policy'
import { createAgentRunOutcomeReporter } from './agent-run-outcome'

// 编译真实 service 函数和 orchestrator 类，显式注入边界依赖。
// 不导入 Electron 单例、不读写用户目录、不加载或修改 Claude/Pi adapter。
// 这里验证 bridge/lifecycle 契约，不把受控回调测试声称为真实模型 E2E。
const transpiler = new Bun.Transpiler({ loader: 'ts', target: 'bun' })
function compile<T>(source: string, symbol: string, dependencies: Record<string, unknown>): T {
  const compiled = transpiler.transformSync(source.replace(/export /g, ''))
  return new Function(...Object.keys(dependencies), `${compiled}\nreturn ${symbol}`)(...Object.values(dependencies)) as T
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const quietConsole = { log() {}, info() {}, warn() {}, error() {} }
const serviceSource = readFileSync(new URL('./agent-service.ts', import.meta.url), 'utf8')
// 从 `resolveInputInitiator` 起切：runAgent 入口的发起者推断与三条未读策略 helper 都是 run 生命周期
// 自身的真实逻辑，必须一起编译进来，只把它们的边界依赖（设置模式 / 未读落盘 / 策略判定）注入。
// 若只从 `export async function runAgent(` 起切，slice 会引用未注入的模块级 helper，编译期不报、
// 运行时才 ReferenceError，整类契约会静默失效。
const runAgentSource = serviceSource.slice(serviceSource.indexOf('function resolveInputInitiator('), serviceSource.indexOf('/**\n * 无渲染进程'))
if (!runAgentSource.includes('export async function runAgent(')) throw new Error('runAgent slice 起点已失效：未包含 runAgent 函数体')
const orchestratorSource = readFileSync(new URL('./agent-orchestrator.ts', import.meta.url), 'utf8')

type RunOutcome = Parameters<NonNullable<AgentSendInput['onRunOutcome']>>[0]
type UnreadPolicyMode = 'auto' | 'manual'
function serviceFixture(sendMessage: (input: AgentSendInput, callbacks: SessionCallbacks) => Promise<void>, isActive = () => false, unreadMode: UnreadPolicyMode = 'auto') {
  const events: AgentStreamPayload[] = []
  const unreadWrites: Array<{ sessionId: string; unread: boolean }> = []
  const webContents = { isDestroyed: () => false, send() {} }
  const run = compile<(input: AgentSendInput, wc: typeof webContents) => Promise<void>>(runAgentSource, 'runAgent', {
    orchestrator: { sendMessage, isActive },
    createAgentRunOutcomeReporter,
    // 入口发起者推断与未读策略判定都用真实实现；只把「模式设置」与「未读落盘」两个边界注入。
    resolveRunInitiator,
    getAgentUnreadPolicyMode: () => unreadMode,
    shouldClearSessionUnreadOnRunStart,
    shouldMarkSessionUnreadOnCompletion,
    setAgentSessionUnread: (sessionId: string, unread: boolean) => { unreadWrites.push({ sessionId, unread }); return null },
    registerWebContents() {},
    activeStreamEventBacklogs: new Map(),
    completedStreamEventBacklogs: new Map(),
    updateAgentSessionMeta() {},
    getAgentSessionMeta: () => undefined,
    publishAgentSessionProjection() {},
    sessionWebContents: new Map(),
    eventBus: { emit: (_id: string, payload: AgentStreamPayload) => events.push(payload) },
    runtimeContextStore: { clear() {} },
    preserveCompletedBacklog() {},
    AgentRunAlreadyActiveError,
    serializeErrorDetail: String,
    AGENT_IPC_CHANNELS: {},
    console: quietConsole,
  })
  return { run: (input: AgentSendInput) => run(input, webContents), events, unreadWrites }
}

function ownerFixture() {
  const credentials = deferred<{ ok: false; code: string }>()
  const aborted: string[] = []
  let routingFailure = false
  const Orchestrator = compile<typeof AgentOrchestrator>(orchestratorSource.slice(orchestratorSource.indexOf('export class AgentOrchestrator')), 'AgentOrchestrator', {
    registerCollaborationEventBus() {}, setHeadlessAgentRunner() {}, setAgentStopper() {},
    normalizeAgentRuntime: (runtime?: string) => runtime ?? 'claude',
    getAgentSessionMeta: () => undefined,
    isAgentSessionForking: () => false,
    randomUUID, tryAcquireActiveSession, releaseActiveSession, AgentRunAlreadyActiveError,
    routePluginModel: (_key: string, input: AgentSendInput) => {
      if (routingFailure) throw new Error('routing failed')
      return input
    },
    createCommandExecutionLedger: () => new Map(),
    updateAgentSessionMeta() {}, appendSDKMessages() {},
    getChannelById: () => ({ provider: 'anthropic' }),
    isXaiChannelAvailableForRuntime: () => true,
    DEFAULT_MODEL_ID: 'test',
    resolveRuntimeCredentials: () => credentials.promise,
    settlePiHarnessRun() {}, pauseActivePiHarnessRun() {},
    browserController: { cancelSession() {} }, stopDelegationsForParent() {},
    permissionService: { clearSessionPending() {} }, exitPlanService: { clearSessionPending() {} },
    normalizeAgentEndReason,
    console: quietConsole,
  })
  // 只触发本测试覆盖的 preflight/stop 边界，adapter.query 不会执行。
  const adapter = { abort: (id: string) => { aborted.push(id) }, errorHelpers: {} }
  const instance = new Orchestrator(adapter as unknown as ConstructorParameters<typeof AgentOrchestrator>[0], { emit() {} } as unknown as ConstructorParameters<typeof AgentOrchestrator>[1])
  const callbacks: SessionCallbacks = { onError() {}, onComplete() {}, onTitleUpdated() {} }
  const input: AgentSendInput = { sessionId: 'session', channelId: 'channel', userMessage: '', triggeredBy: 'goal', goalRunId: 'goal-run-1' }
  return { instance, input, credentials, callbacks, aborted, failRouting: () => { routingFailure = true } }
}

for (const runtime of ['claude', 'pi'] as const) {
  describe(`${runtime} Goal bridge`, () => {
    test('正常上下文传递 input，完整 runtime 消息回调不依赖 isolatedRuntimeSession', async () => {
      const messages = [
        { type: 'assistant', message: { content: [{ type: 'text', text: 'work' }] } },
        { type: 'result', subtype: 'success', usage: { input_tokens: 4, output_tokens: 3 } },
      ] as unknown as SDKMessage[]
      const received: SDKMessage[] = []
      const outcomes: RunOutcome[] = []
      const { run } = serviceFixture(async (input, callbacks) => {
        callbacks.onRunOwned?.()
        expect(input.agentRuntime).toBe(runtime)
        expect(input.goalRunId).toBe('turn')
        expect(input.isolatedRuntimeSession).toBeUndefined()
        expect(input.suppressUserMessagePersistence).toBe(true)
        for (const message of messages) input.onRuntimeMessage?.(message)
        callbacks.onComplete([], { resultSubtype: 'success' })
      })
      await run({ sessionId: 'session', channelId: 'channel', userMessage: '', internalPrompt: 'continue', agentRuntime: runtime, goalRunId: 'turn', suppressUserMessagePersistence: true, onRuntimeMessage: msg => received.push(msg), onRunOutcome: outcome => outcomes.push(outcome) })
      expect(received).toEqual(messages)
      expect(outcomes).toEqual([{ status: 'completed' }])
    })

    test('错误被服务吸收后仍回传 failed，停止覆盖错误，busy 不发假终态', async () => {
      for (const mode of ['error-success', 'subtype', 'throw', 'stop', 'busy'] as const) {
        const outcomes: RunOutcome[] = []
        const { run, events } = serviceFixture(async (_input, callbacks) => {
          if (mode === 'busy') throw new AgentRunAlreadyActiveError(false)
          callbacks.onRunOwned?.()
          if (mode === 'throw') throw new Error('provider failed')
          if (mode === 'error-success' || mode === 'stop') callbacks.onError('provider failed')
          callbacks.onComplete([], { resultSubtype: mode === 'subtype' ? 'error_during_execution' : 'success', stoppedByUser: mode === 'stop' })
        }, () => mode === 'busy')
        const promise = run({ sessionId: 'session', channelId: 'channel', userMessage: '', agentRuntime: runtime, onRunOutcome: outcome => outcomes.push(outcome) })
        if (mode === 'busy') {
          await expect(promise).rejects.toBeInstanceOf(AgentRunAlreadyActiveError)
          expect(outcomes).toEqual([])
          expect(events).toEqual([])
        } else {
          expect(await promise).toBeUndefined()
          expect(outcomes).toHaveLength(1)
          expect(outcomes[0]?.status).toBe(mode === 'stop' ? 'stopped' : 'failed')
        }
      }
    })

    test('获得锁才登记 Goal owner；普通 busy 和错误 runId 不能停止 owner', async () => {
      const f = ownerFixture()
      const owner = f.instance.sendMessage({ ...f.input, agentRuntime: runtime }, f.callbacks)
      expect(f.instance.isGoalRunActive('session', 'goal-run-1')).toBe(true)
      await expect(f.instance.sendMessage({ ...f.input, goalRunId: 'goal-run-2' }, f.callbacks)).rejects.toBeInstanceOf(AgentRunAlreadyActiveError)
      expect(f.instance.isGoalRunActive('session', 'goal-run-2')).toBe(false)
      await f.instance.stopGoalRunAndWait('session', 'goal-run-2')
      expect(f.aborted).toEqual([])
      expect(f.instance.isActive('session')).toBe(true)
      const stopped = f.instance.stopGoalRunAndWait('session', 'goal-run-1')
      expect(f.aborted).toEqual(['session'])
      let completed = false
      void stopped.then(() => { completed = true })
      await Promise.resolve()
      expect(completed).toBe(false)
      f.credentials.resolve({ ok: false, code: 'token_expired' })
      await owner
      await stopped
      expect(f.instance.isGoalRunActive('session')).toBe(false)
      expect(f.instance.isActive('session')).toBe(false)
    })

    test('preflight/setup await 中停止后，即使出错 complete 也必须标 stopped', async () => {
      const f = ownerFixture()
      const completions: Array<Parameters<SessionCallbacks['onComplete']>[1]> = []
      const owner = f.instance.sendMessage({ ...f.input, agentRuntime: runtime }, { ...f.callbacks, onComplete: (_messages, opts) => completions.push(opts) })
      const stopping = f.instance.stopGoalRunAndWait('session', 'goal-run-1')
      f.credentials.resolve({ ok: false, code: 'token_expired' })
      await owner
      await stopping
      expect(completions).toHaveLength(1)
      expect(completions[0]?.stoppedByUser).toBe(true)
      expect(completions[0]?.endReason).toBe('stopped_by_user')
    })
  })
}

test('Claude/Pi 共用 query bridge，消息回调不依赖 isolatedRuntimeSession', () => {
  const resumeOptions = orchestratorSource.slice(orchestratorSource.indexOf('resumeSessionId: existingSdkSessionId,'), orchestratorSource.indexOf('// 回退后 resume', orchestratorSource.indexOf('resumeSessionId: existingSdkSessionId,')))
  expect(resumeOptions).toContain('onRuntimeMessage: input.onRuntimeMessage')
  expect(resumeOptions.indexOf('onRuntimeMessage: input.onRuntimeMessage')).toBeLessThan(resumeOptions.indexOf('...(input.isolatedRuntimeSession'))
})

test('Goal 真实 onRunStarted 才建立前端运行态', async () => {
  const startedAt = 123456
  const h = serviceFixture(async (_input, callbacks) => {
    callbacks.onRunOwned?.()
    await callbacks.onRunStarted?.({ startedAt })
    callbacks.onComplete([], { resultSubtype: 'success', startedAt })
  })
  await h.run({ sessionId: 'session', channelId: 'channel', userMessage: '', triggeredBy: 'goal', goalRunId: 'run' })
  const events = h.events.filter((payload) => payload.kind === 'profer_event' && payload.event.type === 'external_run_started')
  expect(events).toEqual([{ kind: 'profer_event', event: { type: 'external_run_started', source: 'goal', sessionId: 'session', startedAt, title: undefined, workspaceId: undefined, modelId: undefined, session: undefined } }])
})

// Goal 路径的未读口径：关闭态保真（入口即清、终态不写），开启态按发起者收敛（Goal 不清、完成才写）。
// 这两条锁住 618ead56 新引入的 initiator/未读接线在 Goal 运行上的可观测行为。
test('关闭态（auto）Goal 请求入口即清未读，终态不写未读', async () => {
  const h = serviceFixture(async (_input, callbacks) => {
    callbacks.onRunOwned?.()
    await callbacks.onRunStarted?.({ startedAt: 1 })
    callbacks.onComplete([], { resultSubtype: 'success' })
  })
  await h.run({ sessionId: 'session', channelId: 'channel', userMessage: '', triggeredBy: 'goal', goalRunId: 'run' })
  expect(h.unreadWrites).toEqual([{ sessionId: 'session', unread: false }])
})

test('开启态（manual）Goal 运行不清既有未读，完整一轮结束才写未读', async () => {
  const h = serviceFixture(async (_input, callbacks) => {
    callbacks.onRunOwned?.()
    await callbacks.onRunStarted?.({ startedAt: 1 })
    callbacks.onComplete([], { resultSubtype: 'success' })
  }, () => false, 'manual')
  await h.run({ sessionId: 'session', channelId: 'channel', userMessage: '', triggeredBy: 'goal', goalRunId: 'run' })
  expect(h.unreadWrites).toEqual([{ sessionId: 'session', unread: true }])
})

test('普通 run 不成为 Goal owner，Goal busy 拒绝不影响普通运行', async () => {
  const f = ownerFixture()
  const ordinary = f.instance.sendMessage({ ...f.input, goalRunId: undefined, triggeredBy: undefined }, f.callbacks)
  expect(f.instance.isGoalRunActive('session')).toBe(false)
  await expect(f.instance.sendMessage(f.input, f.callbacks)).rejects.toBeInstanceOf(AgentRunAlreadyActiveError)
  await f.instance.stopGoalRunAndWait('session', 'goal-run-1')
  expect(f.aborted).toEqual([])
  f.credentials.resolve({ ok: false, code: 'token_expired' })
  await ordinary
})

test('model routing 抛错也进入 owner finally，不能泄漏 active/Goal 锁', async () => {
  const f = ownerFixture()
  f.failRouting()
  await expect(f.instance.sendMessage(f.input, f.callbacks)).rejects.toThrow('routing failed')
  expect(f.instance.isActive('session')).toBe(false)
  expect(f.instance.isGoalRunActive('session')).toBe(false)
})
