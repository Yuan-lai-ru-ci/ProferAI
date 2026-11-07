/**
 * @profer/agent-provider-claude
 *
 * Claude Agent SDK provider：完整 ClaudeAgentAdapter、Claude 专属 helper（task events、
 * 认证 env、后台任务记录、写入前置校验）。宿主（Electron 或最小 headless runner）
 * 通过 ClaudeProviderDependencies 注入 SDK 加载、进程生命周期与权限回调。
 */

export * from './task-events'
export * from './background-task-manager'
export * from './agent-sdk-auth-env'
export * from './write-target-guard'
export * from './claude-agent-adapter'
export * from './rewind-evidence'
