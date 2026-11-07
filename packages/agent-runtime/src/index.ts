/**
 * @profer/agent-runtime 根入口：只导出宿主无关的执行核心。
 *
 * 边界规则（由 test/isolation/dependency-boundary.test.ts 与 check:isolation 守住）：
 * - 这里不导出任何 provider 专用实现（Pi / Claude），也不 import 任何 provider SDK。
 * - provider 实现放在独立包内，由宿主注入 `AgentRuntimePorts` 与 adapters 集合；
 *   coordinator 与 RuntimeRoutingAgentAdapter 对未注册的 runtime 返回明确不可用错误。
 * - 不提供指向 provider 的兼容转发：肋骨与脊柱必须能被独立安装、类型检查、构建和加载。
 */

export * from './query-preparation'
export * from './contract'
export * from './ports'
export * from './events'
export * from './outcome'
export * from './coordinator'
export * from './runtime-context'
export * from './stream-drain'
export * from './stream-reader'
export * from './retry'
export * from './error-patterns'
export * from './run-ledger'
export * from './run-ownership'
export * from './runtime-guards'
export * from './runtime-routing-adapter'
export * from './provider-bridge'
export * from './run-context'
export * from './run-origin-prompt'
export * from './delegation-blocked'
