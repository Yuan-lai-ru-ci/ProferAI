import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { isChannelEnabledForRuntime, resolveRunInitiator, normalizeAgentRuntime, AgentSessionRuntimeMismatchError } from '@profer/shared'
import { buildAgentSessionUiProjection } from './agent-session-ui-projection'
import type { AgentSessionMeta, AgentMessage, AgentSendInput, AgentStreamPayload, SDKMessage } from '@profer/shared'
import type { AgentOrchestrator, SessionCallbacks } from './agent-orchestrator'
import { AgentRunAlreadyActiveError, releaseActiveSession, tryAcquireActiveSession, isPartialSDKMessage } from './agent-orchestrator-p0-guards'
import { normalizeAgentEndReason } from './agent-end-reason'
import { shouldClearSessionUnreadOnRunStart, shouldMarkSessionUnreadOnCompletion } from './agent-unread-policy'
import { createAgentRunOutcomeReporter } from './agent-run-outcome'
import { AgentRunLedger, createInMemoryRunLedgerPort, createAgentRunContext, stampRunMessage, appendRunOriginPrompt, createRunTriggerMessage, createAgentQueryPreparationPort, createAgentRunOwnershipRegistry, createAgentRunOwnershipView, createAgentRunRejectionError } from '@profer/agent-runtime'
import { createElectronPermissionPort } from './agent-runtime-permission-port'
import { resolveCredentialPreflightTypedError } from './agent-preflight-typed-errors'
import { normalizeHeadlessSendInput } from './agent-input-origin'
import { forwardHeadlessAgentCompletion } from './agent-headless-runner-registry'

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

/** 切一段真实 service 源码；标记失效立即抛错，避免“切到空串仍假绿”。 */
function serviceSlice(label: string, startMarker: string, endMarker: string): string {
  const start = serviceSource.indexOf(startMarker)
  const end = serviceSource.indexOf(endMarker, start + startMarker.length)
  if (start < 0 || end <= start) throw new Error(`${label} 切片标记已失效：${startMarker}`)
  return serviceSource.slice(start, end)
}

// 切片只能落在函数边界，因此 runAgent / runAgentHeadless 会引用位于切片外的真实 helper。
// 活跃判定、未读策略、headless 开关判定本身就是 run 生命周期逻辑，必须编译真实实现，
// 只注入它们的边界依赖（模块单例 / 未读落盘 / 设置模式）；用等价闭包代替会让被验证的契约静默失效。
const activeSessionHelpersSource = serviceSlice('活跃判定 helper', 'function isAgentExecutionActive(', 'export function restoreActiveAgentStreams(')
const unreadPolicyHelpersSource = serviceSlice('未读策略 helper', 'function clearSessionUnreadOnRequestEntry(', 'export async function runAgent(')
const headlessGateSource = serviceSlice('headless 开关判定', 'function canUseRuntimeHeadless(', '/**\n * 将完整 headless 输入交给 runtime coordinator')

// 从 `resolveInputInitiator` 起切：runAgent 入口的发起者推断与三条未读策略 helper 都是 run 生命周期
// 自身的真实逻辑，必须一起编译进来，只把它们的边界依赖（设置模式 / 未读落盘 / 策略判定）注入。
// 若只从 `export async function runAgent(` 起切，slice 会引用未注入的模块级 helper，编译期不报、
// 运行时才 ReferenceError，整类契约会静默失效。
const runAgentSource = `${activeSessionHelpersSource}\n${serviceSlice('runAgent', 'function resolveInputInitiator(', '/**\n * 无渲染进程')}`
if (!runAgentSource.includes('export async function runAgent(')) throw new Error('runAgent slice 起点已失效：未包含 runAgent 函数体')
const orchestratorSource = readFileSync(new URL('./agent-orchestrator.ts', import.meta.url), 'utf8')

type RunOutcome = Parameters<NonNullable<AgentSendInput['onRunOutcome']>>[0]
type UnreadPolicyMode = 'auto' | 'manual'
function serviceFixture(sendMessage: (input: AgentSendInput, callbacks: SessionCallbacks) => Promise<void>, isActive = () => false, unreadMode: UnreadPolicyMode = 'auto') {
  const events: AgentStreamPayload[] = []
  const unreadWrites: Array<{ sessionId: string; unread: boolean }> = []
  const webContents = { isDestroyed: () => false, send() {} }
  const run = compile<(input: AgentSendInput, wc: typeof webContents) => Promise<void>>(runAgentSource, 'runAgent', {
    orchestrator: { sendMessage, isActive, checkEntryGuards: () => undefined },
    // 桌面 runtime 开关默认关：本 fixture 固定走旧分支（新分支由入口路由 parity 覆盖）。
    resolveDesktopRunChain: () => 'orchestrator',
    // isAgentExecutionActive 真实实现读两个模块单例：旧 orchestrator 与新 runtime coordinator。
    runtimeCoordinator: { isRunning: () => false },
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
    AgentRunAlreadyActiveError, AgentSessionRuntimeMismatchError,
    serializeErrorDetail: String,
    AGENT_IPC_CHANNELS: {},
    console: quietConsole,
  })
  return { run: (input: AgentSendInput) => run(input, webContents), events, unreadWrites }
}

test('桌面与 headless 的内核不匹配拒绝不广播假终态，也不清除已有 backlog', async () => {
  const outcomes: RunOutcome[] = []
  const h = serviceFixture(async () => { throw new AgentSessionRuntimeMismatchError('pi', 'claude') }, () => true)
  await expect(h.run({ sessionId: 'session', channelId: 'channel', userMessage: 'late', agentRuntime: 'claude', onRunOutcome: outcome => outcomes.push(outcome) })).rejects.toBeInstanceOf(AgentSessionRuntimeMismatchError)
  expect(h.events).toEqual([])
  expect(outcomes).toEqual([])

  const events: AgentStreamPayload[] = []
  const backlog = new Map([['session', [{ kind: 'sdk_message' }]]])
  const notifications: string[] = []
  const source = `${activeSessionHelpersSource}\n${unreadPolicyHelpersSource}\n${headlessGateSource}\n${serviceSlice('runAgentHeadless', 'export async function runAgentHeadless(', '// headless run 的渲染进程 completion')}`
  const headless = compile<(input: AgentSendInput, callbacks: { onError: () => void; onComplete: () => void; onTitleUpdated: () => void }) => Promise<void>>(source, 'runAgentHeadless', {
    getMainRendererWebContents: () => undefined,
    normalizeHeadlessSendInput,
    resolveRunInitiator,
    orchestrator: { isActive: () => true, sendMessage: async () => { throw new AgentSessionRuntimeMismatchError('pi', 'claude') } },
    runtimeCoordinator: { isRunning: () => false },
    activeStreamEventBacklogs: backlog,
    completedStreamEventBacklogs: new Map(),
    AgentRunAlreadyActiveError, AgentSessionRuntimeMismatchError,
    eventBus: { emit: (_id: string, payload: AgentStreamPayload) => events.push(payload) },
    runtimeContextStore: { clear: () => notifications.push('clear') },
    sessionWebContents: new Map(), preserveCompletedBacklog: () => notifications.push('preserve'),
    // 宿主事实边界：窗口登记、会话元数据读写、未读落盘、设置模式。
    registerWebContents: () => {},
    getAgentSessionMeta: () => undefined,
    updateAgentSessionMeta: () => undefined,
    publishAgentSessionProjection: () => {},
    getAgentUnreadPolicyMode: () => 'auto' as UnreadPolicyMode,
    setAgentSessionUnread: () => null,
    shouldClearSessionUnreadOnRunStart, shouldMarkSessionUnreadOnCompletion,
    forwardHeadlessAgentCompletion,
    serializeErrorDetail: String,
    // 本用例只覆盖旧路径拒绝语义；若开关被打开会在此显式失败，而不是静默走错分支。
    runAgentRuntimeHeadless: () => { throw new Error('fixture 未覆盖 runtime headless 分支：PROFER_RUNTIME_HEADLESS 必须保持未开启') },
    console: quietConsole,
  })
  await expect(headless({ sessionId: 'session', channelId: 'channel', userMessage: 'late', agentRuntime: 'claude' }, {
    onError: () => notifications.push('error'), onComplete: () => notifications.push('complete'), onTitleUpdated() {},
  })).rejects.toBeInstanceOf(AgentSessionRuntimeMismatchError)
  expect(events).toEqual([])
  expect(notifications).toEqual([])
  expect(backlog.get('session')).toHaveLength(1)
})

function ownerFixture(initialSession?: AgentSessionMeta, runLedger?: AgentRunLedger) {
  let session = initialSession
  let bindingFailure = false
  const events: AgentStreamPayload[] = []
  const bindingCalls: string[] = []
  const credentials = deferred<{ ok: false; code: 'token_expired' | 'api_key_decrypt_failed' }>()
  const aborted: string[] = []
  const permissionCleanup: string[] = []
  let routingFailure = false
  const lockRuntime = (id: string, runtime: 'claude' | 'pi') => {
    bindingCalls.push(id)
    if (bindingFailure) throw new Error('binding write failed')
    if (!session || normalizeAgentRuntime(session.agentRuntime) !== runtime) throw new Error('runtime mismatch')
    session = { ...session, agentRuntimeLocked: true, revision: (session.revision ?? 0) + 1 }
    return session
  }
  const Orchestrator = compile<typeof AgentOrchestrator>(orchestratorSource.slice(orchestratorSource.indexOf('export class AgentOrchestrator')), 'AgentOrchestrator', {
    registerCollaborationEventBus() {}, setHeadlessAgentRunner() {}, setAgentStopper() {},
    normalizeAgentRuntime,
    getAgentSessionMeta: () => session,
    getAgentSessionMessages: () => [],
    getAgentSessionSDKMessages: () => [],
    lockAgentSessionRuntime: lockRuntime,
    buildAgentSessionUiProjection,
    isAgentSessionForking: () => false,
    randomUUID, tryAcquireActiveSession, releaseActiveSession, createAgentRunOwnershipRegistry, createAgentRunOwnershipView, createAgentRunRejectionError, AgentRunAlreadyActiveError, AgentSessionRuntimeMismatchError,
    routePluginModel: (_key: string, input: AgentSendInput) => {
      if (routingFailure) throw new Error('routing failed')
      return input
    },
    createCommandExecutionLedger: () => new Map(),
    updateAgentSessionMeta() {}, appendSDKMessages() {},
    getChannelById: () => ({ provider: 'anthropic', enabled: true, agentRuntimes: ['pi', 'claude'] }),
    isChannelEnabledForRuntime,
    isXaiChannelAvailableForRuntime: () => true,
    DEFAULT_MODEL_ID: 'test',
    resolveRuntimeCredentials: () => credentials.promise,
    settlePiHarnessRun() {}, pauseActivePiHarnessRun() {},
    browserController: { cancelSession() {} }, stopDelegationsForParent() {},
    createElectronPermissionPort,
    createAgentQueryPreparationPort, createAgentRunContext, stampRunMessage, appendRunOriginPrompt, createRunTriggerMessage, isPartialSDKMessage,
    resolveCredentialPreflightTypedError,
    permissionService: { clearSessionPending() {} }, exitPlanService: { clearSessionPending() {} },
    normalizeAgentEndReason,
    console: quietConsole,
  })
  // 只触发本测试覆盖的 preflight/stop 边界，adapter.query 不会执行。
  const adapter = { abort: (id: string) => { aborted.push(id) }, errorHelpers: {} }
  const ports = {
    runLedger,
    sessions: {
      getMeta: () => session,
      appendMessages(): undefined {},
      updateMeta(): undefined {},
      lockRuntime,
      getMessages: () => [],
      getAgentMessages: () => [],
    },
    credentials: { resolve: () => credentials.promise },
    permissions: {
      ...createElectronPermissionPort(),
      clearSessionPending: (sessionId: string) => permissionCleanup.push(`pending:${sessionId}`),
      clearSessionWhitelist: (sessionId: string) => permissionCleanup.push(`whitelist:${sessionId}`),
    },
  }
  const instance = new Orchestrator(
    adapter as unknown as ConstructorParameters<typeof AgentOrchestrator>[0],
    { emit: (_id: string, payload: AgentStreamPayload) => events.push(payload) } as unknown as ConstructorParameters<typeof AgentOrchestrator>[1],
    ports,
  )
  const callbacks: SessionCallbacks = { onError() {}, onComplete() {}, onTitleUpdated() {} }
  const input: AgentSendInput = { sessionId: 'session', channelId: 'channel', userMessage: '', triggeredBy: 'goal', goalRunId: 'goal-run-1' }
  return { instance, input, credentials, callbacks, aborted, events, bindingCalls, permissionCleanup, getSession: () => session, failBinding: () => { bindingFailure = true }, failRouting: () => { routingFailure = true } }
}

describe('旧编排器持久 Run 生命周期', () => {
  test.each(['pi', 'claude'] as const)('%s claim 后同步 queued，preflight 失败仅 finish 一次且无 startedAt', async runtime => {
    const port = createInMemoryRunLedgerPort()
    const ledger = new AgentRunLedger(port)
    let finishes = 0
    const finish = ledger.finish.bind(ledger)
    ledger.finish = (id, outcome) => { finishes++; return finish(id, outcome) }
    const f = ownerFixture(undefined, ledger)
    const run = f.instance.sendMessage({ ...f.input, agentRuntime: runtime, uuid: 'user-message' }, f.callbacks)
    expect(ledger.list()).toHaveLength(1)
    expect(ledger.list()[0]).toMatchObject({ status: 'queued', triggerId: 'message:session:user-message', executorRef: 'session', sessionRef: 'session', runtime })
    expect(ledger.list()[0]!.id).not.toBe((f.instance as unknown as { activeSessions: { get(id: string): string } }).activeSessions.get('session'))
    f.credentials.resolve({ ok: false, code: 'token_expired' })
    await run
    expect(ledger.list()[0]!.status).toBe('failed')
    expect(ledger.list()[0]!.startedAt).toBeUndefined()
    expect(port.load().events.map(event => event.type)).toEqual(['queued', 'failed'])
    expect(finishes).toBe(1)
    expect(f.instance.isActive('session')).toBe(false)
  })

  test('准备中停止后发生 preflight 错误仍只记 stopped', async () => {
    const port = createInMemoryRunLedgerPort()
    const ledger = new AgentRunLedger(port)
    const f = ownerFixture(undefined, ledger)
    const run = f.instance.sendMessage({ ...f.input, agentRuntime: 'pi' }, f.callbacks)
    f.instance.stop('session')
    f.credentials.resolve({ ok: false, code: 'token_expired' })
    await run
    expect(ledger.list()[0]!.status).toBe('stopped')
    expect(ledger.list()[0]!.startedAt).toBeUndefined()
    expect(port.load().events.map(event => event.type)).toEqual(['queued', 'stopped'])
  })

  test('begin/finish 保存失败均可见且 owner 释放，finish 不重试', async () => {
    for (const failAt of [1, 2]) {
      const port = createInMemoryRunLedgerPort()
      let saves = 0
      const ledger = new AgentRunLedger({ load: port.load, save: snapshot => {
        if (++saves === failAt) throw new Error('ledger save failed')
        port.save(snapshot)
      } })
      const f = ownerFixture(undefined, ledger)
      f.credentials.resolve({ ok: false, code: 'token_expired' })
      await expect(f.instance.sendMessage({ ...f.input, agentRuntime: 'pi' }, f.callbacks)).rejects.toThrow('ledger save failed')
      expect(f.instance.isActive('session')).toBe(false)
      expect(saves).toBe(failAt)
      if (failAt === 2) expect(ledger.list()[0]!.status).toBe('queued')
    }
  })

  test('run owned 回调抛错也收束 failed 并释放 owner', async () => {
    const ledger = new AgentRunLedger(createInMemoryRunLedgerPort())
    const f = ownerFixture(undefined, ledger)
    await expect(f.instance.sendMessage({ ...f.input, agentRuntime: 'pi' }, { ...f.callbacks, onRunOwned: () => { throw new Error('owned observer failed') } })).rejects.toThrow('owned observer failed')
    expect(ledger.list()[0]!.status).toBe('failed')
    expect(f.instance.isActive('session')).toBe(false)
  })
})

test('run finally 清 turn pending，不清除会话白名单', async () => {
  const h = ownerFixture({ id: 'session', title: 'fixture', createdAt: 1, updatedAt: 1, agentRuntime: 'pi', agentRuntimeLocked: true })
  h.credentials.resolve({ ok: false, code: 'token_expired' })
  await h.instance.sendMessage({ ...h.input, agentRuntime: 'pi' }, h.callbacks)
  expect(h.permissionCleanup).toEqual(['pending:session'])
})

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

describe('会话内核绑定与 owner 顺序', () => {
  const meta = (runtime: 'claude' | 'pi'): AgentSessionMeta => ({ id: 'session', title: 'empty', agentRuntime: runtime, agentRuntimeLocked: false, createdAt: 1, updatedAt: 1 })
  test.each(['claude', 'pi'] as const)('%s 首次请求在凭证 await 前固定，失败和停止不解锁', async (runtime) => {
    const f = ownerFixture(meta(runtime))
    const run = f.instance.sendMessage({ ...f.input, agentRuntime: runtime }, f.callbacks)
    expect(f.instance.isActive('session')).toBe(true)
    expect(f.getSession()?.agentRuntimeLocked).toBe(true)
    expect(f.events[0]).toMatchObject({ kind: 'session_projection', operation: 'upsert', session: { agentRuntime: runtime, agentRuntimeLocked: true } })
    const stop = f.instance.stopGoalRunAndWait('session', 'goal-run-1')
    f.credentials.resolve({ ok: false, code: 'token_expired' })
    await run
    await stop
    expect(f.getSession()?.agentRuntimeLocked).toBe(true)
    expect(f.instance.isActive('session')).toBe(false)
  })
  test.each(['claude', 'pi'] as const)('%s headless 请求不能覆盖会话内核，也不能释放已有 owner', async (runtime) => {
    const f = ownerFixture(meta(runtime))
    const other = runtime === 'pi' ? 'claude' : 'pi'
    await expect(f.instance.sendMessage({ ...f.input, agentRuntime: other }, f.callbacks)).rejects.toThrow('AGENT_SESSION_RUNTIME_MISMATCH')
    expect(f.bindingCalls).toEqual([])
    expect(f.events).toEqual([])
    expect(f.instance.isActive('session')).toBe(false)
    const owner = f.instance.sendMessage({ ...f.input, agentRuntime: runtime }, f.callbacks)
    await expect(f.instance.sendMessage({ ...f.input, agentRuntime: other }, f.callbacks)).rejects.toThrow('AGENT_SESSION_RUNTIME_MISMATCH')
    expect(f.instance.isActive('session')).toBe(true)
    f.credentials.resolve({ ok: false, code: 'token_expired' })
    await owner
    expect(f.bindingCalls).toEqual(['session'])
  })
  test('绑定写盘失败时不执行 adapter 并释放 active/Goal owner', async () => {
    const f = ownerFixture(meta('pi'))
    f.failBinding()
    await expect(f.instance.sendMessage({ ...f.input, agentRuntime: 'pi' }, f.callbacks)).rejects.toThrow('binding write failed')
    expect(f.instance.isActive('session')).toBe(false)
    expect(f.instance.isGoalRunActive('session')).toBe(false)
    expect(f.getSession()?.agentRuntimeLocked).toBe(false)
    expect(f.events.some((event) => event.kind === 'session_projection')).toBe(false)
  })
})

test('Claude/Pi 共用 query bridge，消息回调不依赖 isolatedRuntimeSession', () => {
  const resumeOptions = orchestratorSource.slice(orchestratorSource.indexOf('resumeSessionId: existingSdkSessionId,'), orchestratorSource.indexOf('// 回退后 resume', orchestratorSource.indexOf('resumeSessionId: existingSdkSessionId,')))
  expect(resumeOptions).toContain('input.onRuntimeMessage?.(this.stampMessage(sessionId, message, undefined, runFacts))')
  expect(resumeOptions).toContain(': input.onRuntimeMessage,')
  expect(resumeOptions.indexOf('onRuntimeMessage:')).toBeLessThan(resumeOptions.indexOf('...(input.isolatedRuntimeSession'))
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
