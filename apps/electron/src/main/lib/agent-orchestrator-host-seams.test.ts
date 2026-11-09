import { randomUUID } from 'node:crypto'
import type { AgentSendInput } from '@profer/shared'
import { AgentRunLedger, createInMemoryRunLedgerPort, createAgentRunContext, stampRunMessage, appendRunOriginPrompt, createRunTriggerMessage } from '@profer/agent-runtime'
import type { AgentRun, AgentRunContext } from '@profer/agent-runtime'
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import type { AgentRuntimeQuery, AgentRuntimePreparedContext, AgentRuntimePorts, PermissionPort, PreviewPort, SessionPort, ToolAssemblyPort } from '@profer/agent-runtime'
import { normalizeAgentRuntime, appendAgentTaskPrompt } from '@profer/shared'
import type { AgentSessionMeta, AgentStreamPayload, SDKMessage } from '@profer/shared'
import { isPartialSDKMessage, tryReserveQueuedMessage, shouldPreInterruptQueuedMessage } from './agent-orchestrator-p0-guards'
// GAP-D1：标题来源收集与命名窗口的编排已移到共享模块（旧链与新 runtime 链共用），
// 切片编译必须注入真实实现，否则 `regenerateTitle` 会在求值处抛 ReferenceError。
import { collectSessionTitleSources, runSessionTitleNaming } from './agent-session-title-naming'
import { AgentFilePreviewSessionManager } from './agent-file-preview-session'
import { createAgentQueryPreparationPort, createAgentRunOwnershipRegistry, createAgentRunOwnershipView, createAgentRunRejectionError } from '@profer/agent-runtime'
import type { AgentRunOwnershipRegistry, AgentRunOwnershipView } from '@profer/agent-runtime'
import { createElectronPermissionPort } from './agent-runtime-permission-port'

// 复用 Goal bridge 的真实源码编译方式，只执行构造和端口 seam；不加载宿主单例或模型 SDK。
const source = readFileSync(new URL('./agent-orchestrator.ts', import.meta.url), 'utf8')
const classSource = source.slice(source.indexOf('export class AgentOrchestrator'))
const compiled = new Bun.Transpiler({ loader: 'ts', target: 'bun' }).transformSync(classSource.replace('export class', 'class'))
interface SeamFixture {
  sessionPort: SessionPort
  activeSessions: AgentRunOwnershipView
  ownership: AgentRunOwnershipRegistry
  activeSkillRoutings: Map<string, Promise<unknown>>
  activeRuntimeRegistrations: Map<string, Promise<boolean>>
  activeTaskPromptSelectors: Map<string, Promise<((message: string) => string) | undefined>>
  generateTitle(input: unknown): Promise<string>
  regenerateTitle(sessionId: string, channelId: string, modelId: string): Promise<string | null>
  createApprovalLifecycle(sessionId: string, facts: { run: AgentRun; context: AgentRunContext; started: boolean; onStart(): void | Promise<void>; messageIds: WeakMap<object, string>; logicalMessageIds: Map<string, string>; pendingApprovalRequestIds?: Set<string>; finished?: boolean } | undefined): {
    wait(requestId: string): void
    resume(requestId: string, signal: AbortSignal): void
    clear(): void
  }
  createRunScopedCanUseTool(sessionId: string, facts: { run: AgentRun; context: AgentRunContext; started: boolean; onStart(): void | Promise<void>; messageIds: WeakMap<object, string>; logicalMessageIds: Map<string, string>; pendingApprovalRequestIds?: Set<string>; finished?: boolean } | undefined, permissions: PermissionPort, sendPermissionRequest: (request: import('@profer/shared').PermissionRequest) => void, sendAskUserRequest: (request: import('@profer/shared').AskUserRequest) => void): import('@profer/agent-runtime').RuntimeCanUseTool
  runApprovalWithLifecycle<T>(sessionId: string, facts: { run: AgentRun; context: AgentRunContext; started: boolean; onStart(): void | Promise<void>; messageIds: WeakMap<object, string>; logicalMessageIds: Map<string, string>; pendingApprovalRequestIds?: Set<string>; finished?: boolean } | undefined, signal: AbortSignal, operation: (publish: (requestId: string, emit: () => void) => void) => Promise<T>): Promise<T>
  finishLedgerRun(facts: { run: AgentRun; context: AgentRunContext; started: boolean; onStart(): void | Promise<void>; messageIds: WeakMap<object, string>; logicalMessageIds: Map<string, string> }, outcome: Parameters<AgentRunLedger['finish']>[1]): AgentRun
  stampMessage(sessionId: string, message: SDKMessage): SDKMessage
  activeRunFacts: Map<string, { run: AgentRun; context: AgentRunContext; started: boolean; onStart(): void | Promise<void>; messageIds: WeakMap<object, string>; logicalMessageIds: Map<string, string> }>
  persistSDKMessages(sessionId: string, messages: SDKMessage[], durationMs?: number): void
  persistSkillRoutingNotice(sessionId: string, routed: unknown): void
  queueMessage(sessionId: string, text: string, rawText?: string, priority?: string, uuid?: string): Promise<string>
  permissionPort: PermissionPort
  previewPort: PreviewPort
  queryPreparations: Map<string, AbortController>
  stoppedBySessions: Set<string>
  prepareProviderQuery(input: AgentRuntimeQuery): Promise<AgentRuntimePreparedContext>
  queryPreparedProvider(input: AgentRuntimeQuery, options: object): Promise<AsyncIterable<SDKMessage>>
  buildPiBuiltinTools(sdk: unknown, context: unknown): Promise<{ tools: readonly unknown[]; collaborationAvailable?: boolean }>
}
function fixture(ports: AgentRuntimePorts & { runLedger?: AgentRunLedger } = {}, adapter: object = {}) {
  const manager = new AgentFilePreviewSessionManager(100)
  const events: Array<{ sessionId: string; payload: AgentStreamPayload }> = []
  const builtinResult = { tools: [{ name: 'legacy-tool' }], collaborationAvailable: false }
  let legacyBuilds = 0
  const dependencies = {
    getAgentSessionMeta() {}, appendSDKMessages() {}, updateAgentSessionMeta() {},
    lockAgentSessionRuntime() {},
    getAgentSessionSDKMessages: () => [], getAgentSessionMessages: () => [],
    registerCollaborationEventBus() {}, setHeadlessAgentRunner() {}, setAgentStopper() {},
    agentFilePreviewSessionManager: manager,
    createElectronPermissionPort,
    createAgentQueryPreparationPort,
    randomUUID, createAgentRunContext, stampRunMessage, appendRunOriginPrompt, createRunTriggerMessage,
    createAgentRunOwnershipRegistry,
    createAgentRunOwnershipView,
    createAgentRunRejectionError,
    appendAgentTaskPrompt,
    console: { log() {}, warn() {}, error() {} },
    collectSessionTitleSources, runSessionTitleNaming, isPartialSDKMessage,
    normalizeAgentRuntime, tryReserveQueuedMessage, shouldPreInterruptQueuedMessage,
    getAgentWorkspace: () => undefined,
    buildReferencedSessionsPrompt: () => '',
    selectAgentPromptMode: () => 'standard',
    browserController: { getUserContext: () => undefined },
    routeSkillsForTask: () => ({ selected: [], hints: [], diagnostics: [], prompt: '' }),
    buildSkillRoutingNotice: () => 'fixture skill notice',
    buildPiBuiltinTools: async () => { legacyBuilds++; return builtinResult },
    // Shadow Git turn 边界（Phase 1）：本 fixture 不关心采集，注入空实现保持可编译。
    beginWorkspaceShadowTurn: async () => {},
    endWorkspaceShadowTurn: () => {},
  }
  const Constructor = new Function(...Object.keys(dependencies), `${compiled}\nreturn AgentOrchestrator`)(...Object.values(dependencies)) as new (
    adapter: object,
    eventBus: { emit(sessionId: string, payload: AgentStreamPayload): void },
    ports: AgentRuntimePorts,
    ownership: AgentRunOwnershipRegistry,
  ) => SeamFixture
  // 执行权归共享登记表：测试用同一实例模拟「会话已在运行」。
  const ownership = createAgentRunOwnershipRegistry()
  const instance = new Constructor(adapter, { emit: (sessionId, payload) => events.push({ sessionId, payload }) }, ports, ownership)
  return { instance, manager, events, builtinResult, legacyBuilds: () => legacyBuilds, ownership }
}

const identity = { sessionId: 'session-seam', filePath: '/safe/deck.pptx', revision: 'sha256:seam' }
const open = { ...identity, type: 'preview_requested' as const, requestId: 'seam-open', readOnly: true }
const inspect = { ...identity, requestId: 'seam-inspect', scope: 'page' as const, page: 1 }

describe('AgentOrchestrator Run ledger seams', () => {
  function facts(ledger: AgentRunLedger) {
    const context = createAgentRunContext({ sessionId: 's', uuid: 'input' }, randomUUID)
    const run = ledger.begin({ trigger: context.trigger, sessionRef: 's', executorRef: 's', runtime: 'pi' }).run
    return { run, context, started: false, onStart() {}, messageIds: new WeakMap<object, string>(), logicalMessageIds: new Map<string, string>() }
  }

  test.each(['pi', 'claude'] as const)('Given %s 准备成功 When provider 启动/重试 Then 同一 Run 只 start 一次', async runtime => {
    const port = createInMemoryRunLedgerPort()
    const ledger = new AgentRunLedger(port)
    const state = facts(ledger)
    const order: string[] = []
    state.onStart = () => { order.push('start') }
    const h = fixture({ runLedger: ledger, queryPreparation: { prepare: async () => {
      order.push(`prepare:${ledger.get(state.run.id)!.status}`)
      return {}
    } } }, { query: () => { order.push(`query:${ledger.get(state.run.id)!.status}`); return (async function* () {})() } })
    h.instance.activeRunFacts.set('s', state)
    h.ownership.claim({ sessionId: 's', runtime, token: 'owner' })
    for (let attempt = 0; attempt < 2; attempt++) await h.instance.queryPreparedProvider({ sessionId: 's', runtime, prompt: 'go' }, { sessionId: 's', prompt: 'go' })
    expect(order).toEqual(['prepare:queued', 'start', 'query:running', 'prepare:running', 'query:running'])
    expect(port.load().events.filter(event => event.type === 'started')).toHaveLength(1)
    h.manager.dispose()
  })

  test('Given 无 uuid 的 partial/final When 同逻辑消息广播并持久化 Then provenance 稳定且不写入 uuid', () => {
    const ledger = new AgentRunLedger(createInMemoryRunLedgerPort())
    const h = fixture({ runLedger: ledger })
    h.instance.activeRunFacts.set('s', facts(ledger))
    const partial = { type: 'assistant', _partial: true, message: { content: [{ type: 'text', text: 'a' }] } } as SDKMessage
    const final = { type: 'assistant', uuid: 'provider-final-uuid', message: { content: [{ type: 'text', text: 'ab' }] } } as SDKMessage
    const first = h.instance.stampMessage('s', partial)
    const second = h.instance.stampMessage('s', partial)
    const done = h.instance.stampMessage('s', final)
    expect(first._provenance?.messageId).toBe(second._provenance?.messageId)
    expect(done._provenance?.messageId).toBe(first._provenance?.messageId)
    expect(first).not.toHaveProperty('uuid')
    expect(done).toHaveProperty('uuid', 'provider-final-uuid')
    expect(done).toMatchObject({ type: 'assistant', _provenance: { author: { type: 'agent', id: 's' } } })
    const tool = h.instance.stampMessage('s', { type: 'user', uuid: 'tool-result', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] } } as SDKMessage)
    expect(tool).toMatchObject({ type: 'user', uuid: 'tool-result', _provenance: { messageId: 'tool-result', author: { type: 'system' } } })
    h.manager.dispose()
  })

  test.each(['pi', 'claude'] as const)('Given %s 普通权限审批 When request 等待并获准 Then 同一 Run 经 request resume 后继续 running', async runtime => {
    const ledger = new AgentRunLedger(createInMemoryRunLedgerPort())
    const state = facts(ledger)
    state.run = ledger.start(state.run.id)
    state.started = true
    const h = fixture({ runLedger: ledger })
    h.instance.activeRunFacts.set('s', state)
    const lifecycle = h.instance.createApprovalLifecycle('s', state)
    let resolve!: (value: string) => void
    const response = new Promise<string>(done => { resolve = done })
    let resumed!: (requestId: string) => void
    const pending = h.instance.runApprovalWithLifecycle('s', state, new AbortController().signal, publish => {
      resumed = requestId => publish(requestId, () => {})
      resumed('permission-1')
      return response
    })
    expect(ledger.get(state.run.id)).toMatchObject({ status: 'waiting', waitingFor: { type: 'request', id: 'permission-1' } })
    resolve('allow')
    await expect(pending).resolves.toBe('allow')
    expect(ledger.get(state.run.id)).toMatchObject({ status: 'running', triggerId: state.context.trigger.id })
    expect(ledger.list()).toHaveLength(1)
    h.manager.dispose()
  })

  test.each(['pi', 'claude'] as const)('Given %s AskUserQuestion When response returns Then same Run resumes and request-linked trigger is recorded', async runtime => {
    const port = createInMemoryRunLedgerPort()
    const ledger = new AgentRunLedger(port)
    const state = facts(ledger)
    state.run = ledger.start(state.run.id)
    state.started = true
    const h = fixture({ runLedger: ledger })
    h.instance.activeRunFacts.set('s', state)
    let finish!: (value: string) => void
    const response = new Promise<string>(resolve => { finish = resolve })
    const pending = h.instance.runApprovalWithLifecycle('s', state, new AbortController().signal, publish => {
      publish('ask-1', () => {})
      return response
    })
    expect(ledger.get(state.run.id)?.status).toBe('waiting')
    finish('answered')
    await pending
    expect(ledger.findByTrigger(`resume:${state.run.id}:ask-1`)?.id).toBe(state.run.id)
    expect(port.load().events.map(event => event.type)).toEqual(['queued', 'started', 'waiting', 'resumed'])
    h.manager.dispose()
  })

  test('Given approval abort When handler returns denied Then it does not fabricate a resume trigger', async () => {
    const port = createInMemoryRunLedgerPort()
    const ledger = new AgentRunLedger(port)
    const state = facts(ledger)
    state.run = ledger.start(state.run.id)
    state.started = true
    const h = fixture({ runLedger: ledger })
    h.instance.activeRunFacts.set('s', state)
    const controller = new AbortController()
    const pending = h.instance.runApprovalWithLifecycle('s', state, controller.signal, publish => {
      publish('ask-aborted', () => {})
      return new Promise<string>(resolve => { controller.signal.addEventListener('abort', () => resolve('deny'), { once: true }) })
    })
    expect(ledger.get(state.run.id)?.status).toBe('waiting')
    controller.abort()
    await pending
    expect(ledger.get(state.run.id)?.status).toBe('waiting')
    expect(port.load().events.map(event => event.type)).toEqual(['queued', 'started', 'waiting'])
    h.manager.dispose()
  })

  test('Given run stop When cleanup clears approvals Then late response cannot resume the stopped run', () => {
    const port = createInMemoryRunLedgerPort()
    const ledger = new AgentRunLedger(port)
    const state = facts(ledger)
    state.run = ledger.start(state.run.id)
    state.started = true
    const h = fixture({ runLedger: ledger })
    h.instance.activeRunFacts.set('s', state)
    const lifecycle = h.instance.createApprovalLifecycle('s', state)
    lifecycle.wait('stop-request')
    lifecycle.clear()
    state.run = ledger.finish(state.run.id, { status: 'stopped' })
    lifecycle.resume('stop-request', new AbortController().signal)
    expect(ledger.get(state.run.id)?.status).toBe('stopped')
    expect(port.load().events.map(event => event.type)).toEqual(['queued', 'started', 'waiting', 'stopped'])
    h.manager.dispose()
  })

  test('Given parallel approvals When one resolves Then ledger remains waiting until the last request resolves', async () => {
    const ledger = new AgentRunLedger(createInMemoryRunLedgerPort())
    const state = facts(ledger)
    state.run = ledger.start(state.run.id)
    state.started = true
    const h = fixture({ runLedger: ledger })
    h.instance.activeRunFacts.set('s', state)
    const controller = new AbortController()
    const first = h.instance.runApprovalWithLifecycle('s', state, controller.signal, publish => {
      publish('one', () => {})
      return new Promise<void>(resolve => setTimeout(resolve, 5))
    })
    const second = h.instance.runApprovalWithLifecycle('s', state, controller.signal, publish => {
      publish('two', () => {})
      return new Promise<void>(resolve => setTimeout(resolve, 15))
    })
    await first
    expect(ledger.get(state.run.id)).toMatchObject({ status: 'waiting', waitingFor: { id: 'two' } })
    await second
    expect(ledger.get(state.run.id)?.status).toBe('running')
    h.manager.dispose()
  })

  test('Given no ledger When approval resolves Then it leaves no waiting or resume history', async () => {
    const h = fixture()
    const result = await h.instance.runApprovalWithLifecycle('s', undefined, new AbortController().signal, publish => {
      publish('untracked', () => {})
      return Promise.resolve('ok')
    })
    expect(result).toBe('ok')
    h.manager.dispose()
  })

  test.each(['pi', 'claude'] as const)('Given %s createCanUseTool emits request When wrapper resolves Then same Run waits/resumes through real PermissionPort shape', async runtime => {
    const ledger = new AgentRunLedger(createInMemoryRunLedgerPort())
    const state = facts(ledger)
    state.run = ledger.start(state.run.id)
    state.started = true
    const h = fixture({ runLedger: ledger })
    h.instance.activeRunFacts.set('s', state)
    let resolve!: (value: { behavior: 'allow'; updatedInput: Record<string, unknown> }) => void
    const permission: PermissionPort = {
      createCanUseTool: ({ sendPermissionRequest }) => async (_name, input) => {
        sendPermissionRequest({ requestId: `permission-${runtime}`, sessionId: 's', toolName: 'Write', toolInput: input, description: 'approve', dangerLevel: 'normal' })
        return new Promise(done => { resolve = done })
      },
    }
    const requested: string[] = []
    const wrapped = h.instance.createRunScopedCanUseTool('s', state, permission, request => requested.push(request.requestId), () => {})
    const pending = wrapped('Write', { file_path: '/tmp/x', content: 'x' }, { signal: new AbortController().signal } as never)
    expect(requested).toEqual([`permission-${runtime}`])
    expect(ledger.get(state.run.id)?.status).toBe('waiting')
    resolve({ behavior: 'allow', updatedInput: { file_path: '/tmp/x', content: 'x' } })
    await expect(pending).resolves.toMatchObject({ behavior: 'allow' })
    expect(ledger.get(state.run.id)?.status).toBe('running')
    h.manager.dispose()
  })

  test('Given wrapped permission callback aborts Then ledger stays waiting and no resume event is written', async () => {
    const port = createInMemoryRunLedgerPort()
    const ledger = new AgentRunLedger(port)
    const state = facts(ledger)
    state.run = ledger.start(state.run.id)
    state.started = true
    const h = fixture({ runLedger: ledger })
    h.instance.activeRunFacts.set('s', state)
    const controller = new AbortController()
    const permission: PermissionPort = {
      createCanUseTool: ({ sendPermissionRequest }) => async () => {
        sendPermissionRequest({ requestId: 'permission-abort', sessionId: 's', toolName: 'Write', toolInput: {}, description: 'approve', dangerLevel: 'normal' })
        return new Promise(resolve => { controller.signal.addEventListener('abort', () => resolve({ behavior: 'deny' as const, message: 'aborted' }), { once: true }) })
      },
    }
    const wrapped = h.instance.createRunScopedCanUseTool('s', state, permission, () => {}, () => {})
    const pending = wrapped('Write', {}, { signal: controller.signal } as never)
    controller.abort()
    await pending
    expect(ledger.get(state.run.id)?.status).toBe('waiting')
    expect(port.load().events.map(event => event.type)).toEqual(['queued', 'started', 'waiting'])
    h.manager.dispose()
  })

  test('Given stop clears pending request When late permission result arrives Then no resume is emitted', () => {
    const port = createInMemoryRunLedgerPort()
    const ledger = new AgentRunLedger(port)
    const state = facts(ledger)
    state.run = ledger.start(state.run.id)
    state.started = true
    const h = fixture({ runLedger: ledger })
    h.instance.activeRunFacts.set('s', state)
    const lifecycle = h.instance.createApprovalLifecycle('s', state)
    lifecycle.wait('permission-stop')
    lifecycle.clear()
    state.run = ledger.finish(state.run.id, { status: 'stopped' })
    lifecycle.resume('permission-stop', new AbortController().signal)
    expect(port.load().events.map(event => event.type)).toEqual(['queued', 'started', 'waiting', 'stopped'])
    h.manager.dispose()
  })

  test.each(['completed', 'failed', 'stopped'] as const)('Given %s 终态与迟到重复收束 When finish Then 只保存一次', status => {
    const port = createInMemoryRunLedgerPort()
    const ledger = new AgentRunLedger(port)
    const state = facts(ledger)
    ledger.start(state.run.id)
    const h = fixture({ runLedger: ledger })
    h.instance.activeRunFacts.set('s', state)
    h.instance.finishLedgerRun(state, { status, ...(status === 'failed' ? { error: 'failed' } : {}) })
    const before = port.load()
    h.instance.finishLedgerRun(state, { status: 'failed', error: 'late' })
    expect(port.load()).toEqual(before)
    expect(port.load().events.filter(event => ['completed', 'failed', 'stopped'].includes(event.type))).toHaveLength(1)
    h.manager.dispose()
  })

  test('Given 本轮 provenance 被外部消息伪造 When 写入 Then author 被可信运行覆盖且逻辑标识保持', () => {
    const ledger = new AgentRunLedger(createInMemoryRunLedgerPort())
    const state = facts(ledger)
    const h = fixture({ runLedger: ledger })
    h.instance.activeRunFacts.set('s', state)
    const first = h.instance.stampMessage('s', { type: 'assistant', message: { content: [] } } as SDKMessage)
    const copied = h.instance.stampMessage('s', { ...first, _provenance: { ...first._provenance!, author: { type: 'user' } } })
    expect(copied._provenance?.author).toEqual({ type: 'agent', id: 's' })
    expect(copied._provenance?.messageId).toBe(first._provenance?.messageId)
    h.manager.dispose()
  })

  test('Given ledger start 保存失败 When 准备已成功 Then provider 不启动且仍可 queued→failed', async () => {
    const memory = createInMemoryRunLedgerPort()
    let saves = 0
    const ledger = new AgentRunLedger({ load: memory.load, save: snapshot => {
      if (++saves === 2) throw new Error('ledger start failed')
      memory.save(snapshot)
    } })
    const state = facts(ledger)
    let effects = 0
    const h = fixture({ runLedger: ledger, queryPreparation: { prepare: async () => ({}) } }, { query: () => { effects++; return (async function* () {})() } })
    h.instance.activeRunFacts.set('s', state)
    await expect(h.instance.queryPreparedProvider({ sessionId: 's', runtime: 'pi', prompt: 'go' }, { sessionId: 's', prompt: 'go' })).rejects.toThrow('ledger start failed')
    h.instance.finishLedgerRun(state, { status: 'failed', error: 'ledger start failed' })
    expect(effects).toBe(0)
    expect(ledger.get(state.run.id)).toMatchObject({ status: 'failed' })
    expect(ledger.get(state.run.id)?.startedAt).toBeUndefined()
    h.manager.dispose()
  })

  test('Given provider 副作用完成而 finish 保存失败 When 迟到收束 Then 不重跑副作用或 finish', async () => {
    const memory = createInMemoryRunLedgerPort()
    let saves = 0
    const ledger = new AgentRunLedger({ load: memory.load, save: snapshot => {
      if (++saves === 3) throw new Error('ledger finish failed')
      memory.save(snapshot)
    } })
    const state = facts(ledger)
    let effects = 0
    const h = fixture({ runLedger: ledger, queryPreparation: { prepare: async () => ({}) } }, { query: () => { effects++; return (async function* () {})() } })
    h.instance.activeRunFacts.set('s', state)
    await h.instance.queryPreparedProvider({ sessionId: 's', runtime: 'pi', prompt: 'go' }, { sessionId: 's', prompt: 'go' })
    expect(() => h.instance.finishLedgerRun(state, { status: 'completed' })).toThrow('ledger finish failed')
    h.instance.finishLedgerRun(state, { status: 'completed' })
    expect(effects).toBe(1)
    expect(saves).toBe(3)
    expect(ledger.get(state.run.id)?.status).toBe('running')
    h.manager.dispose()
  })

  test('Given queue input When provider 接收 Then attachInput 关联原 Run 且落盘和广播共享新 trigger 来源', async () => {
    const ledger = new AgentRunLedger(createInMemoryRunLedgerPort())
    const state = facts(ledger)
    ledger.start(state.run.id)
    const persisted: SDKMessage[] = []
    const h = fixture({ runLedger: ledger, sessions: { getMeta: () => undefined, appendMessages: (_id, messages) => { persisted.push(...messages) }, updateMeta() {} } }, { sendQueuedMessage: async () => {} })
    h.instance.activeRunFacts.set('s', state)
    h.ownership.claim({ sessionId: 's', runtime: 'pi', token: 'owner' })
    h.instance.activeSkillRoutings.set('s', Promise.resolve({}))
    h.instance.activeRuntimeRegistrations.set('s', Promise.resolve(true))
    h.instance.activeTaskPromptSelectors.set('s', Promise.resolve(() => ''))
    await h.instance.queueMessage('s', 'follow-up', undefined, undefined, 'queued')
    expect(ledger.findByTrigger('message:s:queued')?.id).toBe(state.run.id)
    expect(persisted[0]).toMatchObject({ uuid: 'queued', _provenance: { runId: state.run.id, triggerId: 'message:s:queued', author: { type: 'user' } } })
    expect(h.events[0]!.payload).toEqual({ kind: 'sdk_message', message: persisted[0]! })
    h.manager.dispose()
  })
  test('Given queue 接收后原 Run 结束且新 Run 启动 When 落盘和广播 Then 保留接收时的业务来源', async () => {
    const ledger = new AgentRunLedger(createInMemoryRunLedgerPort())
    const state = facts(ledger)
    ledger.start(state.run.id)
    const persisted: SDKMessage[] = []
    const h = fixture({ runLedger: ledger, sessions: { getMeta: () => undefined, appendMessages: (_id, messages) => { persisted.push(...messages) }, updateMeta() {} } }, { sendQueuedMessage: async () => {
      ledger.finish(state.run.id, { status: 'completed' })
      const nextContext = createAgentRunContext({ sessionId: 's', uuid: 'next' }, randomUUID)
      const nextRun = ledger.begin({ trigger: nextContext.trigger, sessionRef: 's', executorRef: 's', runtime: 'pi' }).run
      h.instance.activeRunFacts.set('s', { ...state, run: nextRun, context: nextContext })
    } })
    h.instance.activeRunFacts.set('s', state)
    h.ownership.claim({ sessionId: 's', runtime: 'pi', token: 'owner' })
    h.instance.activeSkillRoutings.set('s', Promise.resolve({}))
    h.instance.activeRuntimeRegistrations.set('s', Promise.resolve(true))
    h.instance.activeTaskPromptSelectors.set('s', Promise.resolve(() => ''))
    await expect(h.instance.queueMessage('s', 'late-accepted', undefined, undefined, 'queued')).rejects.toThrow('已接收的追加输入')
    expect(persisted[0]).toMatchObject({ uuid: 'queued', _provenance: { runId: state.run.id, triggerId: 'message:s:queued' } })
    expect(h.events[0]!.payload).toEqual({ kind: 'sdk_message', message: persisted[0]! })
    h.manager.dispose()
  })
})

describe('AgentOrchestrator host seams', () => {
  test('Given injected session storage When persisting assistant output Then partial frames and plain SDK user text are filtered before the synchronous write', () => {
    const persisted: SDKMessage[] = []
    const sessions: SessionPort = {
      getMeta: () => undefined,
      updateMeta() {},
      appendMessages: (_id, messages) => { persisted.push(...messages) },
    }
    const h = fixture({ sessions })
    const complete = { type: 'assistant', uuid: 'complete', message: { content: [{ type: 'text', text: 'complete' }] } } as SDKMessage
    const partial = { ...complete, uuid: 'partial', _partial: true } as SDKMessage
    const plainUser = { type: 'user', message: { content: [{ type: 'text', text: 'SDK internal' }] }, parent_tool_use_id: null } as SDKMessage
    const toolResult = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }] }, parent_tool_use_id: null } as SDKMessage
    const result = { type: 'result', subtype: 'success', session_id: 'port-session', usage: { input_tokens: 0, output_tokens: 0 } } as SDKMessage
    h.instance.persistSDKMessages('port-session', [partial, plainUser, complete, toolResult, result], 20)
    expect(persisted.map(message => message.type)).toEqual(['assistant', 'user', 'result'])
    expect(persisted[0]).toMatchObject({ uuid: 'complete' })
    expect(persisted[2]).toMatchObject({ _durationMs: 20 })
    expect(persisted.every(message => typeof (message as { _createdAt?: number })._createdAt === 'number')).toBe(true)
    sessions.appendMessages = () => { throw new Error('session write failed') }
    expect(() => h.instance.persistSDKMessages('port-session', [complete])).toThrow('session write failed')
    h.manager.dispose()
  })

  test('Given an injected transcript When regenerating title Then reads, revision guard and metadata writes stay within the port', async () => {
    let meta: AgentSessionMeta = { id: 'port-title', title: 'old', createdAt: 1, updatedAt: 1, revision: 1 }
    const writes: Array<Partial<AgentSessionMeta>> = []
    const sessions: SessionPort = {
      getMeta: () => meta,
      getMessages: () => [{ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'text', text: '实现一个购物管理系统' }] } } as SDKMessage],
      appendMessages() {},
      updateMeta: (_id, patch) => { writes.push(patch); meta = { ...meta, ...patch } },
    }
    const h = fixture({ sessions })
    h.instance.generateTitle = async () => '购物管理系统'
    await expect(h.instance.regenerateTitle(meta.id, 'channel', 'model')).resolves.toBe('购物管理系统')
    expect(writes[0]).toMatchObject({ title: '购物管理系统' })
    h.instance.generateTitle = async () => { meta = { ...meta, revision: 2 }; return '过期标题' }
    await expect(h.instance.regenerateTitle(meta.id, 'channel', 'model')).rejects.toThrow('生成期间会话状态已变化')
    expect(writes).toHaveLength(1)
    h.manager.dispose()
  })

  test('Given a task prompt selector When a queued message arrives Then the adapter receives only guidance for that message under the frozen tool snapshot', async () => {
    let received = ''
    let resolveSelector!: (selector: (message: string) => string) => void
    const persisted: SDKMessage[] = []
    const sessions: SessionPort = {
      getMeta: () => ({ id: 'guidance-queue', title: 'fixture', agentRuntime: 'pi', createdAt: 1, updatedAt: 1 }),
      updateMeta() {}, appendMessages: (_id, messages) => { persisted.push(...messages) },
    }
    const h = fixture({ sessions }, { sendQueuedMessage: async (_id: string, message: { message: { content: string } }) => {
      received = message.message.content
    } })
    h.ownership.claim({ sessionId: 'guidance-queue', runtime: 'pi', token: 'run-1' })
    h.instance.activeSkillRoutings.set('guidance-queue', Promise.resolve({}))
    h.instance.activeRuntimeRegistrations.set('guidance-queue', Promise.resolve(true))
    h.instance.activeTaskPromptSelectors.set('guidance-queue', new Promise(resolve => { resolveSelector = resolve }))
    const queued = h.instance.queueMessage('guidance-queue', '打开网页。', undefined, undefined, 'guidance-1')
    await Promise.resolve()
    expect(received).toBe('')
    resolveSelector(message => message.includes('网页') ? 'BROWSER_GUIDANCE' : '')
    await queued
    expect(received).toContain('<turn_guidance>')
    expect(received).toContain('BROWSER_GUIDANCE')
    expect(received).toContain('打开网页。')
    expect(persisted).toHaveLength(2)
    const persistedUser = persisted[0]
    expect(persistedUser?.type).toBe('user')
    if (persistedUser?.type === 'user') {
      expect(persistedUser.message).toMatchObject({ content: [{ type: 'text', text: '打开网页。' }] })
    }
    expect(JSON.stringify(persisted)).not.toContain('BROWSER_GUIDANCE')
    h.manager.dispose()
  })

  test('Given a running session When queuing a user message Then adapter acceptance precedes port persistence and the skill notice follows the user message', async () => {
    const order: string[] = []
    const sessions: SessionPort = {
      getMeta: () => ({ id: 'port-queue', title: 'fixture', agentRuntime: 'pi', createdAt: 1, updatedAt: 1 }),
      updateMeta() {},
      appendMessages: (_id, messages) => { order.push(...messages.map(message => `persist:${message.type}`)) },
    }
    const h = fixture({ sessions }, { sendQueuedMessage: async () => { order.push('adapter') } })
    // 执行权在共享登记表里（activeSessions 是它的只读视图）。
    h.ownership.claim({ sessionId: 'port-queue', runtime: 'pi', token: 'run-1' })
    h.instance.activeSkillRoutings.set('port-queue', Promise.resolve({}))
    h.instance.activeRuntimeRegistrations.set('port-queue', Promise.resolve(true))
    h.instance.activeTaskPromptSelectors.set('port-queue', Promise.resolve(() => ''))
    expect(await h.instance.queueMessage('port-queue', 'queue', undefined, undefined, 'queue-1')).toBe('queue-1')
    expect(order).toEqual(['adapter', 'persist:user', 'persist:system'])
    await h.instance.queueMessage('port-queue', 'retry', undefined, undefined, 'queue-1')
    expect(order).toHaveLength(3)
    h.manager.dispose()
  })

  test('Given an accepted queued message When persistence fails Then UUID remains reserved and retry does not reinject', async () => {
    let accepted = 0
    let writes = 0
    const sessions: SessionPort = {
      getMeta: () => ({ id: 'failed-queue', title: 'fixture', agentRuntime: 'pi', createdAt: 1, updatedAt: 1 }),
      updateMeta() {},
      appendMessages: () => { writes++; throw new Error('write failed') },
      enqueueMessages: () => {},
    }
    const h = fixture({ sessions }, { sendQueuedMessage: async () => { accepted++ } })
    h.ownership.claim({ sessionId: 'failed-queue', runtime: 'pi', token: 'run-1' })
    h.instance.activeSkillRoutings.set('failed-queue', Promise.resolve({}))
    h.instance.activeRuntimeRegistrations.set('failed-queue', Promise.resolve(true))
    h.instance.activeTaskPromptSelectors.set('failed-queue', Promise.resolve(() => ''))
    await expect(h.instance.queueMessage('failed-queue', 'queue', undefined, undefined, 'fixed-uuid')).resolves.toBe('fixed-uuid')
    await h.instance.queueMessage('failed-queue', 'retry', undefined, undefined, 'fixed-uuid')
    expect(accepted).toBe(1)
    expect(writes).toBe(0) // 队列接受消息；实际持久化由 Electron Worker 旁路执行。
    h.manager.dispose()
  })

  test('Given the legacy constructor When permissions are requested Then the complete host adapter remains available', async () => {
    const h = fixture()
    const canUseTool = h.instance.permissionPort.createCanUseTool!({ sessionId: 'legacy-permission', sendPermissionRequest() { throw new Error('只读工具不应请求审批') } })
    await expect(canUseTool('Read', { file_path: '/safe/file' }, { signal: new AbortController().signal })).resolves.toMatchObject({ behavior: 'allow' })
    expect(typeof h.instance.permissionPort.handleAskUserQuestion).toBe('function')
    expect(typeof h.instance.permissionPort.handleExitPlanMode).toBe('function')
    h.manager.dispose()
  })

  test('Given injected permissions When the constructor selects a port Then the supplied port is kept', () => {
    const permissions = { clearSessionPending() {} }
    const h = fixture({ permissions })
    expect(h.instance.permissionPort).toBe(permissions)
    h.manager.dispose()
  })

  test('Given injected preview When orchestrator is constructed Then it uses the port without calling the legacy viewer manager', async () => {
    const ready = { ...identity, requestId: open.requestId, status: 'ready' as const, slideCount: 1, currentSlide: 1 }
    const inspected = { ...inspect, slideCount: 1, currentSlide: 1, images: [{ page: 1, data: 'fixture-image', mediaType: 'image/png' as const }] }
    const preview: PreviewPort = {
      open: async (event) => { expect(event).toBe(open); return ready },
      inspect: async (request) => { expect(request).toBe(inspect); return inspected },
    }
    const h = fixture({ preview })
    expect(h.instance.previewPort).toBe(preview)
    expect(await h.instance.previewPort.open(open)).toBe(ready)
    expect(await h.instance.previewPort.inspect(inspect)).toBe(inspected)
    expect(h.events).toEqual([])
    expect(h.manager.reportReady(ready)).toBe(false)
    h.manager.dispose()
  })

  test('Given no preview port When the legacy constructor opens and inspects Then both requests emit and matching receipts resolve', async () => {
    const h = fixture()
    const opened = h.instance.previewPort.open(open)
    h.manager.reportReady({ ...open, status: 'ready', slideCount: 1, currentSlide: 1 })
    await expect(opened).resolves.toMatchObject({ status: 'ready' })
    const inspected = h.instance.previewPort.inspect(inspect)
    h.manager.reportInspection({ ...inspect, slideCount: 1, currentSlide: 1, images: [{ page: 1, data: 'fixture-image', mediaType: 'image/png' }] })
    await expect(inspected).resolves.toMatchObject({ slideCount: 1 })
    expect(h.events).toEqual([
      { sessionId: identity.sessionId, payload: { kind: 'profer_event', event: open } },
      { sessionId: identity.sessionId, payload: { kind: 'profer_event', event: { type: 'preview_inspection_requested', request: inspect } } },
    ])
    h.manager.dispose()
  })

  test('Given injected tool assembly When builtin tools are built Then SDK, context and availability are preserved without fallback', async () => {
    const sdk = { fixture: 'sdk' }
    const context = { sessionId: 'session-seam', channelId: 'channel-seam' }
    const result = { tools: [{ name: 'injected-tool' }], collaborationAvailable: true }
    const toolAssembly: ToolAssemblyPort = { build: async (input) => {
      expect(input.sdk).toBe(sdk)
      expect(input.context).toBe(context)
      return result
    } }
    const h = fixture({ toolAssembly })
    expect(await h.instance.buildPiBuiltinTools(sdk, context)).toBe(result)
    expect(h.legacyBuilds()).toBe(0)
    h.manager.dispose()
  })

  test('Given production prepared query entry When adapter starts Then preset prompt, dynamic permission and frozen tools reach it with current retry credentials', async () => {
    const calls: string[] = []
    const callback = async () => ({ behavior: 'allow' as const, updatedInput: {} })
    const tools = [{ name: 'frozen' }]
    const prepared: AgentRuntimePreparedContext = { resources: {}, canUseTool: callback, tools, skills: [], mcpServers: {}, systemPrompt: { type: 'preset', preset: 'claude_code', append: 'frozen policy' } }
    const h = fixture({ queryPreparation: { prepare: async (input, signal) => {
      expect(signal.aborted).toBe(false)
      calls.push(`prepare:${input.prepared?.credentials?.apiKey}`)
      return createAgentQueryPreparationPort({}).prepare(input, signal)
    } } }, { query: (input: { prepared: AgentRuntimePreparedContext; env: object }) => {
      calls.push(`query:${input.prepared.credentials?.apiKey}`)
      expect(input.prepared.systemPrompt).toBe(prepared.systemPrompt)
      expect(input.prepared.tools).toBe(tools)
      expect(input.prepared.canUseTool).toBe(callback)
      expect(input.env).toEqual({ HOST: 'keep' })
      return (async function* () {})()
    } })
    for (const apiKey of ['initial', 'refreshed']) {
      await h.instance.queryPreparedProvider({ sessionId: 's', runtime: 'claude', prompt: 'turn', channelId: 'c', prepared: { ...prepared, credentials: { apiKey, baseUrl: undefined, provider: 'anthropic', forceBearerAuth: true } } }, { sessionId: 's', prompt: 'turn', env: { HOST: 'keep' } })
    }
    expect(calls).toEqual(['prepare:initial', 'query:initial', 'prepare:refreshed', 'query:refreshed'])
    expect(h.instance.queryPreparations.size).toBe(0)
    h.manager.dispose()
  })

  test('Given a custom preparation returns a partial snapshot When provider starts Then existing prepared fields are preserved', async () => {
    const existing = { credentials: { apiKey: 'keep', baseUrl: undefined, provider: 'anthropic' as const, forceBearerAuth: false }, tools: [{ name: 'keep' }], systemPrompt: 'keep prompt' }
    let received: AgentRuntimePreparedContext | undefined
    const h = fixture({ queryPreparation: { prepare: async () => ({ resources: { systemPrompt: 'partial' } }) } }, { query: (input: { prepared: AgentRuntimePreparedContext }) => { received = input.prepared; return (async function* () {})() } })
    await h.instance.queryPreparedProvider({ sessionId: 's', runtime: 'pi', prompt: 'turn', prepared: existing }, { sessionId: 's', prompt: 'turn' })
    expect(received).toMatchObject({ credentials: existing.credentials, tools: existing.tools, systemPrompt: existing.systemPrompt, resources: { systemPrompt: 'partial' } })
    h.manager.dispose()
  })

  test('Given stop during provider preparation When an uncooperative builder resolves Then adapter never starts and preparation scope clears', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let calls = 0
    const h = fixture({ queryPreparation: { prepare: async () => { await gate; return {} } } }, { query: () => { calls++; return (async function* () {})() } })
    const pending = h.instance.queryPreparedProvider({ sessionId: 's', runtime: 'pi', prompt: 'turn' }, { sessionId: 's', prompt: 'turn' })
    h.instance.queryPreparations.get('s')!.abort(new Error('stopped'))
    release()
    await expect(pending).rejects.toThrow('stopped')
    expect(calls).toBe(0)
    expect(h.instance.queryPreparations.size).toBe(0)
    h.manager.dispose()
  })

  test('Given no tool assembly port When builtin tools are built Then the legacy builder still runs', async () => {
    const h = fixture()
    expect(await h.instance.buildPiBuiltinTools({}, { sessionId: 'session-seam', channelId: 'channel-seam' })).toBe(h.builtinResult)
    expect(h.legacyBuilds()).toBe(1)
    h.manager.dispose()
  })
})
