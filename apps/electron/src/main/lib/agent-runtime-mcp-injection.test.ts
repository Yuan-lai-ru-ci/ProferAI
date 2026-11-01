/**
 * GAP-4 单元测试：内置 MCP 注入端口的「决定 / 执行 / 不可用记录」三件事。
 *
 * 与旧链的**行为等价性**在 `agent-runtime-mcp-injection.parity.test.ts` 用真实旧源码切片对照，
 * 本文件只负责端口自身的契约：纯决策函数的条件、执行器的失败语义、默认端口真的接线到生产注入器。
 */

import { describe, expect, test } from 'bun:test'
import {
  BUILTIN_MCP_INJECTION_ORDER,
  builtinMcpPlanInputFromContext,
  createElectronBuiltinMcpInjectionPort,
  planBuiltinMcpServers,
  runBuiltinMcpInjection,
  type BuiltinMcpInjectionContext,
  type BuiltinMcpInjectionPort,
  type BuiltinMcpInjectionRequest,
  type BuiltinMcpPlanInput,
  type BuiltinMcpServerId,
  type ClaudeSdkNamespace,
  type McpServerTable,
} from './agent-runtime-mcp-injection'

/** 假 SDK：只记录 `createSdkMcpServer` 的服务器名与工具名，不连接任何真实传输。 */
const fakeSdk = {
  tool: (name: string) => ({ name }),
  createSdkMcpServer: (options: { name: string; version?: string; tools?: unknown[] }) => ({
    type: 'sdk',
    name: options.name,
    instance: { tools: options.tools ?? [] },
  }),
} as unknown as ClaudeSdkNamespace

function planInput(overrides: Partial<BuiltinMcpPlanInput> = {}): BuiltinMcpPlanInput {
  return {
    promptMode: 'standard',
    runtime: 'claude',
    disabledToolGroups: [],
    hasMemoryArchive: true,
    hasGoalReport: true,
    ...overrides,
  }
}

function enabledIds(input: BuiltinMcpPlanInput): BuiltinMcpServerId[] {
  return planBuiltinMcpServers(input).filter(entry => entry.enabled).map(entry => entry.id)
}

function context(overrides: Partial<BuiltinMcpInjectionContext> = {}): BuiltinMcpInjectionContext {
  return {
    sessionId: 's-1',
    channelId: 'c-1',
    modelId: 'm-1',
    workspaceId: 'w-1',
    workspaceSlug: 'ws-a',
    runtime: 'claude',
    triggeredBy: 'user',
    preset: { source: 'user', allowedOperations: [] },
    ...overrides,
  }
}

function request(ctx: BuiltinMcpInjectionContext, input: BuiltinMcpPlanInput, mcpServers: McpServerTable = {}): BuiltinMcpInjectionRequest {
  return { context: ctx, mcpServers, sdk: fakeSdk, planInput: input }
}

describe('planBuiltinMcpServers：条件与旧链逐条对齐', () => {
  test('standard + claude + 全组启用 + 有工作区/Goal 回调 → 七条全启用，顺序与旧链一致', () => {
    const plan = planBuiltinMcpServers(planInput())
    expect(plan.map(entry => entry.id)).toEqual([...BUILTIN_MCP_INJECTION_ORDER])
    expect(plan.every(entry => entry.enabled)).toBe(true)
    expect(plan.every(entry => entry.reason === 'enabled')).toBe(true)
  })

  test('light 模式：整块跳过内置注入（与旧链 promptMode === light 一致）', () => {
    const plan = planBuiltinMcpServers(planInput({ promptMode: 'light' }))
    expect(plan.every(entry => !entry.enabled)).toBe(true)
    expect(plan.every(entry => entry.reason === 'prompt-mode-light')).toBe(true)
  })

  test('预设禁用工具组：只影响对应服务器，planning 跟随 automation 组', () => {
    expect(enabledIds(planInput({ disabledToolGroups: ['automation'] }))).toEqual(['memory-archive', 'collaboration', 'task-graph', 'goal', 'agent-presets'])
    expect(enabledIds(planInput({ disabledToolGroups: ['memory'] }))).toEqual(['automation', 'collaboration', 'task-graph', 'goal', 'agent-presets', 'planning'])
    expect(enabledIds(planInput({ disabledToolGroups: ['collaboration'] }))).toEqual(['automation', 'memory-archive', 'task-graph', 'goal', 'agent-presets', 'planning'])
    expect(enabledIds(planInput({ disabledToolGroups: ['task-graph'] }))).toEqual(['automation', 'memory-archive', 'collaboration', 'goal', 'agent-presets', 'planning'])
  })

  test('禁用原因可解释：组禁用 → tool-group-disabled，缺工作区 → context-missing', () => {
    const plan = planBuiltinMcpServers(planInput({ disabledToolGroups: ['memory'], hasMemoryArchive: false }))
    expect(plan.find(entry => entry.id === 'memory-archive')?.reason).toBe('tool-group-disabled')
    const noWorkspace = planBuiltinMcpServers(planInput({ hasMemoryArchive: false }))
    expect(noWorkspace.find(entry => entry.id === 'memory-archive')?.reason).toBe('context-missing')
  })

  test('runtime 门禁：goal / planning 只对 claude 注入，pi 下记为 runtime-unsupported', () => {
    const pi = planBuiltinMcpServers(planInput({ runtime: 'pi' }))
    expect(pi.find(entry => entry.id === 'goal')).toMatchObject({ enabled: false, reason: 'runtime-unsupported' })
    expect(pi.find(entry => entry.id === 'planning')).toMatchObject({ enabled: false, reason: 'runtime-unsupported' })
    expect(pi.filter(entry => entry.enabled).map(entry => entry.id)).toEqual(['automation', 'memory-archive', 'collaboration', 'task-graph', 'agent-presets'])
  })

  test('缺 Goal 报告回调：claude 下 goal 记为 context-missing（新路径不迁移 Goal 回调面）', () => {
    const plan = planBuiltinMcpServers(planInput({ hasGoalReport: false }))
    expect(plan.find(entry => entry.id === 'goal')).toMatchObject({ enabled: false, reason: 'context-missing' })
  })

  test('builtinMcpPlanInputFromContext：从上下文推导决定项', () => {
    expect(builtinMcpPlanInputFromContext(context({ workspaceSlug: undefined }), 'standard', ['memory'])).toEqual({
      promptMode: 'standard',
      runtime: 'claude',
      disabledToolGroups: ['memory'],
      hasMemoryArchive: false,
      hasGoalReport: false,
    })
    const goal = { iteration: 2, report: () => {} }
    expect(builtinMcpPlanInputFromContext(context({ goal }), 'light', [])).toMatchObject({ hasGoalReport: true, promptMode: 'light' })
  })
})

describe('runBuiltinMcpInjection：缺端口 / 缺单个服务器都必须记录，不静默放行也不整体失败', () => {
  const input = planInput()
  const ctx = context()

  test('缺端口：portAvailable=false，计划内的服务器逐条记为 port-missing，且不写入任何服务器', () => {
    const mcpServers: McpServerTable = {}
    return runBuiltinMcpInjection(undefined, request(ctx, input, mcpServers)).then(outcome => {
      expect(outcome.portAvailable).toBe(false)
      expect(outcome.injected).toEqual([])
      expect(outcome.unavailable.map(entry => entry.id)).toEqual([...BUILTIN_MCP_INJECTION_ORDER])
      expect(outcome.unavailable.every(entry => entry.reason === 'port-missing')).toBe(true)
      expect(Object.keys(mcpServers)).toEqual([])
    })
  })

  test('计划抛错：整轮记为 plan-failed，不抛异常、不产生半套服务器', async () => {
    const port: BuiltinMcpInjectionPort = {
      plan: () => { throw new Error('plan boom') },
      inject: async () => {},
    }
    const mcpServers: McpServerTable = {}
    const outcome = await runBuiltinMcpInjection(port, request(ctx, input, mcpServers))
    expect(outcome.injected).toEqual([])
    expect(outcome.unavailable).toHaveLength(BUILTIN_MCP_INJECTION_ORDER.length)
    expect(outcome.unavailable.every(entry => entry.reason === 'plan-failed' && entry.detail === 'plan boom')).toBe(true)
    expect(Object.keys(mcpServers)).toEqual([])
  })

  test('单个注入器抛错：只有该条记为 injector-failed，其余继续注入', async () => {
    const port: BuiltinMcpInjectionPort = {
      plan: planBuiltinMcpServers,
      inject: async (entry, req) => {
        if (entry.id === 'task-graph') throw new Error('boom')
        req.mcpServers[entry.id] = { type: 'sdk' }
      },
    }
    const mcpServers: McpServerTable = {}
    const outcome = await runBuiltinMcpInjection(port, request(ctx, input, mcpServers))
    expect(outcome.injected).toEqual(['automation', 'memory-archive', 'collaboration', 'goal', 'agent-presets', 'planning'])
    expect(outcome.unavailable).toEqual([{ id: 'task-graph', reason: 'injector-failed', detail: 'boom' }])
  })

  test('注入器静默无产物：记为 injector-noop，不得当作已注入', async () => {
    const port: BuiltinMcpInjectionPort = {
      plan: planBuiltinMcpServers,
      inject: async (entry, req) => {
        if (entry.id === 'memory-archive') return
        req.mcpServers[entry.id] = { type: 'sdk' }
      },
    }
    const outcome = await runBuiltinMcpInjection(port, request(ctx, input, {}))
    expect(outcome.injected).not.toContain('memory-archive')
    expect(outcome.unavailable).toEqual([{ id: 'memory-archive', reason: 'injector-noop' }])
  })

  test('策略跳过项只出现在 skipped，不进入 unavailable（不是失败）', async () => {
    const light = planInput({ promptMode: 'light' })
    const outcome = await runBuiltinMcpInjection(createElectronBuiltinMcpInjectionPort({ injectors: noopInjectors() }), request(ctx, light, {}))
    expect(outcome.unavailable).toEqual([])
    expect(outcome.injected).toEqual([])
    expect(outcome.skipped).toHaveLength(BUILTIN_MCP_INJECTION_ORDER.length)
  })
})

/** 全部为 noop 的注入器表：避免加载生产注入器模块，同时保持「计划 → 执行」路径真实。 */
function noopInjectors(): Partial<Record<BuiltinMcpServerId, (sdk: ClaudeSdkNamespace, table: McpServerTable, ...args: readonly unknown[]) => Promise<void>>> {
  const table: Partial<Record<BuiltinMcpServerId, (sdk: ClaudeSdkNamespace, table: McpServerTable, ...args: readonly unknown[]) => Promise<void>>> = {}
  for (const id of BUILTIN_MCP_INJECTION_ORDER) table[id] = async () => {}
  return table
}

describe('默认端口：确实接线到生产注入器（不是空实现）', () => {
  test('真实注入器注册全部七条内置服务器，注册键与 id 逐条一致', async () => {
    // 先加载 agent-service，让已知模块循环（orchestrator → collaboration-tools → service）按生产顺序求值。
    await import('./agent-service')
    const port = createElectronBuiltinMcpInjectionPort()
    const mcpServers: McpServerTable = {}
    const outcome = await runBuiltinMcpInjection(
      port,
      request(context({ goal: { iteration: 0, report: () => {} } }), planInput(), mcpServers),
    )
    expect(outcome.unavailable).toEqual([])
    expect(outcome.injected).toEqual([...BUILTIN_MCP_INJECTION_ORDER])
    for (const id of BUILTIN_MCP_INJECTION_ORDER) {
      expect(Object.prototype.hasOwnProperty.call(mcpServers, id)).toBe(true)
    }
    // 服务器对象是 SDK in-process MCP 描述符，不是空壳。
    expect((mcpServers.goal as { name?: string }).name).toBe('goal')
    expect((mcpServers['memory-archive'] as { name?: string }).name).toBe('memory-archive')
  })

  test('goal 的 report 回调由端口透传给真实注入器（注入即生效，不是占位）', async () => {
    await import('./agent-service')
    const port = createElectronBuiltinMcpInjectionPort()
    const mcpServers: McpServerTable = {}
    const reports: unknown[] = []
    const outcome = await runBuiltinMcpInjection(
      port,
      request(context({ goal: { iteration: 7, report: result => reports.push(result) } }), planInput(), mcpServers),
    )
    expect(outcome.injected).toContain('goal')
    expect((mcpServers.goal as { name?: string }).name).toBe('goal')
  })
})

describe('内置 MCP 的真实运行引用', () => {
  test('automation 与 collaboration 收到源 Run，未提供时保持旧参数形状', async () => {
    const received: Record<string, unknown>[] = []
    const port = createElectronBuiltinMcpInjectionPort({
      injectors: Object.fromEntries(BUILTIN_MCP_INJECTION_ORDER.map(id => [id, async (_sdk: unknown, table: McpServerTable, ctx: unknown) => {
        if (id === 'automation' || id === 'collaboration') received.push(ctx as Record<string, unknown>)
        table[id] = { type: 'sdk' }
      }])) as NonNullable<Parameters<typeof createElectronBuiltinMcpInjectionPort>[0]>['injectors'],
      resolveMemoryArchivePath: () => '/tmp/fixture',
    })
    await runBuiltinMcpInjection(port, request(context({ sourceRunId: 'admitted-run' }), planInput()))
    expect(received).toHaveLength(2)
    expect(received.every(ctx => ctx.sourceRunId === 'admitted-run')).toBe(true)
  })
})
