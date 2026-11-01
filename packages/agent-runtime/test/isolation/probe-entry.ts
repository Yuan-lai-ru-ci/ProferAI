/**
 * 入口探针：对"已加载的核心入口模块对象"做可执行断言。
 *
 * 同一份断言被两处复用：
 * - `core-boundary.test.ts`：在 monorepo 内直接 import 源码入口。
 * - `run-isolation-check.ts`：在无 provider SDK 的沙箱里分别加载**源码入口**与**构建产物**。
 * 这样"缺 SDK 也能加载"和"导出面收窄"两件事用的是同一标准，不会出现只测其中一处的偏差。
 */

/** provider 从核心移除的出口；它们必须只存在于 provider 包。 */
export const REMOVED_PROVIDER_EXPORTS = [
  'createPiCommandBashOperations',
  'createPiPowerShellToolDefinition',
  'createPiRetryTerminalGate',
  'getPiNativeRetryOutcome',
  'mapPiNativeRetryEvent',
  'createPartialMessageCoalescer',
  'mapPiHarnessLifecycleEvent',
  'normalizeClaudeTaskEvent',
] as const

/** 宿主注入脊柱所依赖的核心出口，必须继续可用。 */
export const REQUIRED_CORE_EXPORTS = [
  'AgentRunLedger',
  'createInMemoryRunLedgerPort',
  'AgentRuntimeCoordinator',
  'createAgentRuntimeCoordinator',
  'RuntimeRoutingAgentAdapter',
  'createAgentRuntimeProviderAdapter',
  'createAgentQueryPreparationPort',
  'createAgentRuntimeGuard',
  'createAgentRunOutcomeReporter',
  'readAgentStreamNext',
  'closeAgentStreamIterator',
  'waitForRetryDelay',
  'classifyNetworkError',
] as const

interface RuntimeRoutingAdapterLike {
  query(input: { sessionId: string; prompt: string; agentRuntime: string }): AsyncIterable<unknown>
}

interface CoordinatorLike {
  run(input: { sessionId: string; runtime: string; prompt: string }): { promise: Promise<unknown> }
}

export interface CoreEntryModule {
  RuntimeRoutingAgentAdapter: new (adapters: Record<string, never>) => RuntimeRoutingAdapterLike
  AgentRuntimeCoordinator: new (options: { adapters: Record<string, never> }) => CoordinatorLike
  [exportName: string]: unknown
}

function fail(label: string, message: string): never {
  throw new Error(`[${label}] ${message}`)
}

/**
 * 断言模块对象就是收窄后的核心入口，并真实执行"未注册 provider"拒绝路径。
 * 任何失败都会抛出 —— 调用方负责把异常转成非零退出码。
 */
export async function assertCoreEntryModule(module: Record<string, unknown>, label: string): Promise<void> {
  for (const name of REQUIRED_CORE_EXPORTS) {
    if (typeof module[name] !== 'function') {
      fail(label, `缺少核心出口 ${name}（实际 ${typeof module[name]}）`)
    }
  }
  for (const name of REMOVED_PROVIDER_EXPORTS) {
    if (name in module) fail(label, `provider 出口 ${name} 仍从核心入口导出`)
  }
  const leakedNames = Object.keys(module).filter((name) => /^Pi[A-Z]|^Claude[A-Z]|^createPi|^mapPi|^normalizeClaude/.test(name))
  if (leakedNames.length > 0) fail(label, `核心入口出现 provider 命名出口：${leakedNames.join(', ')}`)

  const core = module as CoreEntryModule
  const router = new core.RuntimeRoutingAgentAdapter({})
  for (const runtime of ['pi', 'claude']) {
    let outcome: string
    try {
      for await (const _message of router.query({ sessionId: `s-${runtime}`, prompt: 'fixture', agentRuntime: runtime })) {
        fail(label, `未注册的 ${runtime} provider 不应产生任何消息`)
      }
      outcome = 'no-error'
    } catch (error) {
      outcome = error instanceof Error ? error.message : String(error)
    }
    if (!outcome.includes('当前不可用')) {
      fail(label, `未注册的 ${runtime} provider 未返回明确不可用错误，而是：${outcome}`)
    }
  }

  const coordinator = new core.AgentRuntimeCoordinator({ adapters: {} })
  const failing = await coordinator.run({ sessionId: 's-pi', runtime: 'pi', prompt: 'fixture' }).promise
  const expected = { status: 'failed', error: 'pi runtime unavailable' }
  if (JSON.stringify(failing) !== JSON.stringify(expected)) {
    fail(label, `未注册 provider 的 coordinator 终态应为 ${JSON.stringify(expected)}，实际 ${JSON.stringify(failing)}`)
  }
}
