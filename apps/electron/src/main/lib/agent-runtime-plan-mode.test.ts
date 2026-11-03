/**
 * 计划模式状态 / 事件投影 / 审批责任方的行为测试。
 *
 * 覆盖（对应交付清单第 7 条）：
 * - plan / auto / bypassPermissions 三种初始模式的进入与退出语义；
 * - EnterPlanMode / ExitPlanMode 的工具态与事件顺序（与旧编排逐字一致）；
 * - ExitPlanMode 审批：批准（auto / bypassPermissions）、拒绝、反馈、取消；
 * - plan 只读工具面：浏览器白名单、MCP 拒绝、计划目录 Markdown 白名单、未分类工具交回宿主判定；
 * - 通过真实权限端口 + 真实 exitPlanService 的接线闭环，以及未接线时不新增隐藏行为。
 */

import { afterEach, describe, expect, test } from 'bun:test'
import type { ProferPermissionMode } from '@profer/shared'
import type { RuntimeCanUseTool, RuntimePermissionResult } from '@profer/agent-runtime'
import {
  clearAgentRuntimePlanMode,
  createAgentRuntimePlanModeController,
  createAgentRuntimePlanModeFromPolicy,
  createPlanModeGatedCanUseTool,
  createSharedPlanModeToolPolicy,
  getAgentRuntimePlanMode,
  registerAgentRuntimePlanMode,
  resetAgentRuntimePlanModeRegistry,
  type AgentRuntimePlanModeEvent,
} from './agent-runtime-plan-mode'
import { resolveAgentRuntimePolicySnapshot } from './agent-runtime-policy-snapshot'
import { createElectronPermissionPort } from './agent-runtime-permission-port'
import { exitPlanService } from './agent-exit-plan-service'
import { permissionService } from './agent-permission-service'

const sessionId = 'plan-mode-session'
const agentCwd = '/tmp/plan-mode-cwd'

afterEach(() => {
  resetAgentRuntimePlanModeRegistry()
  exitPlanService.clearSessionPending(sessionId)
  permissionService.clearSessionPending(sessionId)
})

function policySnapshot(mode: ProferPermissionMode) {
  return resolveAgentRuntimePolicySnapshot({
    preset: { id: 'plan-preset', name: '计划预设', description: '', isBuiltin: false, createdAt: 0, updatedAt: 0, permissionMode: mode },
    presetReference: { presetId: 'plan-preset', presetScope: 'user-global' },
  })
}

interface GateFixture {
  controller: ReturnType<typeof createAgentRuntimePlanModeController>
  gate: RuntimeCanUseTool
  events: AgentRuntimePlanModeEvent[]
  innerCalls: string[]
  approvalRequests: number
}

function createGate(options: {
  mode: ProferPermissionMode
  planToolPolicy?: ReturnType<typeof createSharedPlanModeToolPolicy>
  approve?: RuntimePermissionResult
  approvalSignal?: AbortSignal
}): GateFixture {
  const events: AgentRuntimePlanModeEvent[] = []
  const innerCalls: string[] = []
  const controller = createAgentRuntimePlanModeController({
    sessionId,
    initialMode: options.mode,
    agentCwd,
    emit: event => events.push(event),
    ...(options.planToolPolicy ? { planToolPolicy: options.planToolPolicy } : {}),
  })
  const inner: RuntimeCanUseTool = async (toolName, toolInput) => {
    innerCalls.push(toolName)
    return { behavior: 'allow', updatedInput: toolInput }
  }
  const fixture: GateFixture = { controller, events, innerCalls, approvalRequests: 0, gate: inner }
  fixture.gate = createPlanModeGatedCanUseTool({
    controller,
    inner,
    requestExitPlanApproval: async () => {
      fixture.approvalRequests += 1
      return options.approve ?? { behavior: 'deny', message: '无审批通道' }
    },
  })
  return fixture
}

const signal = new AbortController().signal
const eventTypes = (events: readonly AgentRuntimePlanModeEvent[]): string[] => events.map(event => event.type)

describe('计划模式进入与投影', () => {
  test('Given 策略初始模式为 plan When 本轮开始 Then 投影 enter_plan_mode 与 plan_mode_changed(initial)', () => {
    const events: AgentRuntimePlanModeEvent[] = []
    const controller = createAgentRuntimePlanModeFromPolicy({
      sessionId,
      snapshot: policySnapshot('plan'),
      emit: event => events.push(event),
      agentCwd,
    })
    controller.start()
    expect(eventTypes(events)).toEqual(['enter_plan_mode', 'plan_mode_changed'])
    expect(events[1]).toMatchObject({ type: 'plan_mode_changed', sessionId, active: true, source: 'initial' })
    expect(controller.isPlanActive()).toBe(true)
  })

  test('Given 策略初始模式为 auto 或 bypassPermissions When 本轮开始 Then 不投影计划模式事件', () => {
    for (const mode of ['auto', 'bypassPermissions'] as const) {
      const events: AgentRuntimePlanModeEvent[] = []
      const controller = createAgentRuntimePlanModeFromPolicy({
        sessionId,
        snapshot: policySnapshot(mode),
        emit: event => events.push(event),
        agentCwd,
      })
      controller.start()
      expect(events).toEqual([])
      expect(controller.isPlanActive()).toBe(false)
    }
  })

  test('Given 运行中切换权限模式 When setMode Then 计划态变化才投影事件', () => {
    const events: AgentRuntimePlanModeEvent[] = []
    const controller = createAgentRuntimePlanModeController({ sessionId, initialMode: 'auto', emit: event => events.push(event), agentCwd })
    controller.setMode('plan')
    expect(events).toEqual([{ type: 'plan_mode_changed', sessionId, active: true, source: 'permission' }])
    controller.setMode('plan')
    expect(events).toHaveLength(1)
    controller.setMode('bypassPermissions')
    expect(eventTypes(events)).toEqual(['plan_mode_changed', 'plan_mode_changed'])
    expect(events[1]).toMatchObject({ active: false, source: 'permission' })
  })
})

describe('EnterPlanMode / ExitPlanMode 工具语义', () => {
  test('Given bypassPermissions When 调用 EnterPlanMode Then 只同步工具态并放行（不弹审批、不发 enter_plan_mode）', async () => {
    const fixture = createGate({ mode: 'bypassPermissions' })
    const result = await fixture.gate('EnterPlanMode', { plan: 'x' }, { signal })
    expect(result).toMatchObject({ behavior: 'allow' })
    expect(eventTypes(fixture.events)).toEqual(['plan_mode_changed'])
    expect(fixture.events[0]).toMatchObject({ active: true, source: 'tool' })
    expect(fixture.innerCalls).toEqual([])
  })

  test('Given auto When 调用 EnterPlanMode Then 先同步工具态再投影 enter_plan_mode', async () => {
    const fixture = createGate({ mode: 'auto' })
    const result = await fixture.gate('EnterPlanMode', { plan: 'x' }, { signal })
    expect(result).toMatchObject({ behavior: 'allow' })
    expect(eventTypes(fixture.events)).toEqual(['plan_mode_changed', 'enter_plan_mode'])
    expect(fixture.controller.isPlanActive()).toBe(true)
  })

  test('Given bypassPermissions When 调用 ExitPlanMode Then 同步工具态并直接放行', async () => {
    const fixture = createGate({ mode: 'bypassPermissions' })
    fixture.controller.start()
    const result = await fixture.gate('ExitPlanMode', { plan: 'x' }, { signal })
    expect(result).toMatchObject({ behavior: 'allow' })
    expect(fixture.approvalRequests).toBe(0)
    expect(eventTypes(fixture.events)).toEqual(['plan_mode_changed'])
    expect(fixture.events[0]).toMatchObject({ active: false, source: 'tool' })
  })

  test('Given plan When 调用 ExitPlanMode 且用户批准为完全自动 Then 切换模式并投影 permission 来源', async () => {
    const fixture = createGate({ mode: 'plan', approve: { behavior: 'allow', updatedInput: { plan: 'x' }, targetMode: 'bypassPermissions' } })
    const modes: ProferPermissionMode[] = []
    const controller = createAgentRuntimePlanModeController({
      sessionId,
      initialMode: 'plan',
      agentCwd,
      emit: event => fixture.events.push(event),
      onPermissionModeChange: mode => modes.push(mode),
    })
    const gate = createPlanModeGatedCanUseTool({
      controller,
      inner: async () => ({ behavior: 'allow' }),
      requestExitPlanApproval: async () => ({ behavior: 'allow', updatedInput: { plan: 'x' }, targetMode: 'bypassPermissions' }),
    })
    const result = await gate('ExitPlanMode', { plan: 'x' }, { signal })
    expect(result).toMatchObject({ behavior: 'allow', targetMode: 'bypassPermissions' })
    expect(controller.getMode()).toBe('bypassPermissions')
    expect(controller.isPlanActive()).toBe(false)
    expect(eventTypes(fixture.events)).toEqual(['plan_mode_changed'])
    expect(fixture.events[0]).toMatchObject({ active: false, source: 'permission' })
    expect(modes).toEqual(['bypassPermissions'])
  })

  test('Given auto When 用户拒绝计划 Then 拒绝且保持计划态（不投影退出事件）', async () => {
    const fixture = createGate({ mode: 'auto', approve: { behavior: 'deny', message: '用户拒绝了计划' } })
    const result = await fixture.gate('ExitPlanMode', { plan: 'x' }, { signal })
    expect(result).toMatchObject({ behavior: 'deny', message: '用户拒绝了计划' })
    expect(fixture.events).toEqual([])
  })

  test('Given plan When 用户要求修改计划（反馈）Then 拒绝并保持计划态', async () => {
    const fixture = createGate({ mode: 'plan', approve: { behavior: 'deny', message: '用户要求修改计划' } })
    const result = await fixture.gate('ExitPlanMode', { plan: 'x' }, { signal })
    expect(result).toMatchObject({ behavior: 'deny', message: '用户要求修改计划' })
    expect(fixture.controller.getMode()).toBe('plan')
    expect(fixture.events).toEqual([])
  })
})

describe('plan 只读工具面', () => {
  test('Given plan 模式 When 调用只读浏览器工具 Then 放行；写操作类浏览器工具拒绝', async () => {
    const fixture = createGate({ mode: 'plan' })
    await expect(fixture.gate('BrowserObserve', {}, { signal })).resolves.toMatchObject({ behavior: 'allow' })
    await expect(fixture.gate('BrowserListTabs', {}, { signal })).resolves.toMatchObject({ behavior: 'allow' })
    await expect(fixture.gate('BrowserClick', {}, { signal })).resolves.toMatchObject({ behavior: 'deny' })
    await expect(fixture.gate('BrowserExecuteJavaScript', {}, { signal })).resolves.toMatchObject({ behavior: 'deny' })
    // 计划模式下浏览器门禁优先于宿主通用判定，不产生审批弹窗。
    expect(fixture.innerCalls).toEqual([])
  })

  test('Given plan 模式 When 调用 MCP 工具 Then 一律拒绝', async () => {
    const fixture = createGate({ mode: 'plan' })
    await expect(fixture.gate('mcp__task-graph__profer_task_create', {}, { signal })).resolves.toMatchObject({ behavior: 'deny' })
    expect(fixture.innerCalls).toEqual([])
  })

  test('Given plan 模式 When 写计划目录内 Markdown Then 放行；写其他路径拒绝', async () => {
    const fixture = createGate({ mode: 'plan' })
    await expect(fixture.gate('Write', { file_path: `${agentCwd}/.context/plan/next.md`, content: 'x' }, { signal }))
      .resolves.toMatchObject({ behavior: 'allow' })
    await expect(fixture.gate('Edit', { file_path: `${agentCwd}/.context/plan/next.md` }, { signal }))
      .resolves.toMatchObject({ behavior: 'allow' })
    await expect(fixture.gate('Write', { file_path: `${agentCwd}/src/index.ts` }, { signal }))
      .resolves.toMatchObject({ behavior: 'deny' })
    await expect(fixture.gate('Write', { file_path: `${agentCwd}/.context/plan/notes.txt` }, { signal }))
      .resolves.toMatchObject({ behavior: 'deny' })
  })

  test('Given plan 模式 When 调用共享策略无法分类的工具 Then 交回宿主既有判定（不静默放行、也不越权拒绝）', async () => {
    const fixture = createGate({ mode: 'plan' })
    await expect(fixture.gate('Read', { file_path: '/tmp/x' }, { signal })).resolves.toMatchObject({ behavior: 'allow' })
    expect(fixture.innerCalls).toEqual(['Read'])
    // 宿主策略注入后由宿主规则决定；此处验证注入点生效。
    const injected = createGate({ mode: 'plan', planToolPolicy: () => ({ behavior: 'deny', message: '宿主规则：计划模式下禁止 Bash' }) })
    await expect(injected.gate('Bash', { command: 'rm -rf /' }, { signal })).resolves.toMatchObject({ behavior: 'deny', message: '宿主规则：计划模式下禁止 Bash' })
    expect(injected.innerCalls).toEqual([])
  })

  test('Given 非 plan 模式 When 调用任何工具 Then 不进入计划门禁', async () => {
    const fixture = createGate({ mode: 'auto' })
    await expect(fixture.gate('Bash', { command: 'ls' }, { signal })).resolves.toMatchObject({ behavior: 'allow' })
    await expect(fixture.gate('mcp__x__y', {}, { signal })).resolves.toMatchObject({ behavior: 'allow' })
    expect(fixture.innerCalls).toEqual(['Bash', 'mcp__x__y'])
  })
})

describe('与真实权限端口的接线', () => {
  test('Given 已注册本轮控制器 When 权限端口创建 canUseTool Then 走计划门禁并投影审批请求', async () => {
    const events: AgentRuntimePlanModeEvent[] = []
    const controller = createAgentRuntimePlanModeFromPolicy({
      sessionId,
      snapshot: policySnapshot('plan'),
      emit: event => events.push(event),
      agentCwd,
    })
    registerAgentRuntimePlanMode(controller)
    controller.start()

    const port = createElectronPermissionPort()
    const canUseTool = port.createCanUseTool!({ sessionId, sendPermissionRequest: () => { throw new Error('计划模式不应走通用审批') } })

    const approval = canUseTool('ExitPlanMode', { plan: 'fixture', allowedPrompts: [{ tool: 'Bash', prompt: 'run tests' }] }, { signal })
    const pending = exitPlanService.getPendingRequests()
    expect(pending).toHaveLength(1)
    expect(eventTypes(events)).toEqual(['enter_plan_mode', 'plan_mode_changed', 'exit_plan_mode_request'])
    expect(pending[0]!.allowedPrompts).toEqual([{ tool: 'Bash', prompt: 'run tests' }])

    expect(exitPlanService.respondToExitPlanMode({ requestId: pending[0]!.requestId, action: 'approve_edit' })).toMatchObject({ sessionId, targetMode: 'auto' })
    await expect(approval).resolves.toMatchObject({ behavior: 'allow', targetMode: 'auto' })
    expect(controller.getMode()).toBe('auto')
    expect(eventTypes(events)).toEqual(['enter_plan_mode', 'plan_mode_changed', 'exit_plan_mode_request', 'plan_mode_changed'])
    expect(events.at(-1)).toMatchObject({ active: false, source: 'permission' })
  })

  test('Given 审批挂起时取消 When 运行中止 Then 审批被拒绝且不投影退出计划', async () => {
    const events: AgentRuntimePlanModeEvent[] = []
    const controller = createAgentRuntimePlanModeFromPolicy({
      sessionId,
      snapshot: policySnapshot('plan'),
      emit: event => events.push(event),
      agentCwd,
    })
    registerAgentRuntimePlanMode(controller)
    controller.start()
    const abort = new AbortController()
    const port = createElectronPermissionPort()
    const canUseTool = port.createCanUseTool!({ sessionId, sendPermissionRequest: () => { throw new Error('计划模式不应走通用审批') } })
    const approval = canUseTool('ExitPlanMode', { plan: 'fixture' }, { signal: abort.signal })
    expect(exitPlanService.getPendingRequests()).toHaveLength(1)

    abort.abort()
    await expect(approval).resolves.toMatchObject({ behavior: 'deny', message: '操作已中止' })
    expect(controller.getMode()).toBe('plan')
    expect(eventTypes(events)).toEqual(['enter_plan_mode', 'plan_mode_changed', 'exit_plan_mode_request'])
  })

  test('Given 运行结束清理 When 注销控制器 Then 权限端口回到既有行为', async () => {
    const controller = createAgentRuntimePlanModeFromPolicy({
      sessionId,
      snapshot: policySnapshot('plan'),
      emit: () => {},
      agentCwd,
    })
    registerAgentRuntimePlanMode(controller)
    expect(getAgentRuntimePlanMode(sessionId)).toBe(controller)

    clearAgentRuntimePlanMode(sessionId)
    expect(getAgentRuntimePlanMode(sessionId)).toBeUndefined()

    const port = createElectronPermissionPort()
    const requests: string[] = []
    const canUseTool = port.createCanUseTool!({ sessionId, sendPermissionRequest: request => { requests.push(request.requestId) } })
    const pending = canUseTool('Write', { file_path: `${agentCwd}/src/index.ts` }, { signal })
    expect(requests).toHaveLength(1)
    permissionService.respondToPermission(requests[0]!, 'deny', false)
    await expect(pending).resolves.toMatchObject({ behavior: 'deny' })
  })
})
