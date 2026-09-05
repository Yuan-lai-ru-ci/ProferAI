/**
 * Workspace MCP 配置的窄依赖入口。
 *
 * Prompt 构建器只需要读取 MCP 配置，不应因此把整个工作区管理器作为测试 mock 边界；
 * 单独的入口也避免 Bun 同批测试运行时的模块 mock 污染其它工作区服务。
 */
export { getWorkspaceMcpConfig } from './agent-workspace-manager'
