/**
 * Agent Provider 适配器接口
 *
 * 定义 Profer 自己的 Agent 接口层，让底层 SDK 可替换。
 * 当前实现：ClaudeAgentAdapter（基于 @anthropic-ai/claude-agent-sdk）
 * 未来可扩展：PiAgentAdapter 等。
 */

import type { SDKMessage, TypedError } from './agent'

/** Agent runtime 实现。未知/旧持久化值一律按 Claude 回退。 */
export type AgentRuntime = 'claude' | 'pi'

/** 默认 runtime。Pi 完成执行链路与灰度前，产品默认始终保持 Claude。 */
export const DEFAULT_AGENT_RUNTIME: AgentRuntime = 'claude'

/** 严格校验外部输入是否为受支持 runtime。 */
export function isAgentRuntime(value: unknown): value is AgentRuntime {
  return value === 'claude' || value === 'pi'
}

/** 将历史缺省或未知持久化值安全归一化为 Claude。 */
export function normalizeAgentRuntime(value: unknown): AgentRuntime {
  return isAgentRuntime(value) ? value : DEFAULT_AGENT_RUNTIME
}

/** SDK 用户消息（队列消息注入用，匹配 SDK SDKUserMessage 结构） */
export interface SDKUserMessageInput {
  type: 'user'
  message: { role: 'user'; content: string }
  parent_tool_use_id: null
  priority?: 'now' | 'next' | 'later'
  uuid?: string
  session_id: string
}

/** Queue delivery controls shared by Claude and Pi adapters. */
export interface SendQueuedMessageOptions {
  /** Cancel the current turn and deliver this input as the next turn. */
  interrupt?: boolean
  /** Explicitly mentioned workspace skills, resolved by the adapter before delivery. */
  skillMentions?: string[]
  /** Called only after the runtime accepts the message. */
  onAccepted?: () => void
}

/**
 * Agent 查询输入（Provider 无关）
 *
 * 包含所有 Provider 都需要的通用字段。
 * SDK 特定配置通过 Adapter 的扩展输入类型传入。
 */
export interface AgentQueryInput {
  /** 会话 ID */
  sessionId: string
  /** 用户 prompt（已包含上下文注入） */
  prompt: string
  /** 模型 ID */
  model?: string
  /** 要使用的 Agent runtime；持久化缺省值由调用方归一化为 Claude。 */
  agentRuntime?: AgentRuntime
  /** Agent 工作目录 */
  cwd?: string
  /** 中止信号 */
  abortSignal?: AbortSignal
}

/**
 * Agent 错误处理辅助函数集合
 *
 * 这些函数包含 Provider 特化的错误判断逻辑。
 * 每个 Adapter 实现负责提供自己的错误辅助。
 */
export interface AgentErrorHelpers {
  /** 将原始错误信息转换为用户友好的错误消息 */
  friendlyErrorMessage(raw: string): string
  /** 判断是否是 prompt 过长错误 */
  isPromptTooLongError(...messages: string[]): boolean
  /** 判断是否是 thinking signature 不兼容错误 */
  isThinkingSignatureError(...messages: string[]): boolean
  /** 将 SDK 错误码映射为结构化 TypedError */
  mapSDKErrorToTypedError(errorCode: string, userMessage: string, originalError?: string): TypedError
  /** 从 SDK 错误对象中提取详细错误信息 */
  extractErrorDetails(msg: { error?: string | { message?: string; errorType?: string }; message?: { content?: Array<Record<string, unknown>> } }): { detailedMessage: string; originalError: string }
  /** 判断 terminal reason 是否应保持 channel 打开 */
  shouldKeepChannelOpen(terminalReason: string | undefined): boolean
}

/**
 * Agent Provider 适配器接口
 *
 * 职责：接收查询输入，返回 SDKMessage 异步迭代流。
 * SDK 返回完整 JSON 对象（includePartialMessages: false），外部直接透传。
 */
export interface AgentProviderAdapter {
  /** 发起查询，返回 SDKMessage 异步迭代流 */
  query(input: AgentQueryInput): AsyncIterable<SDKMessage>
  /** 中止指定会话的执行 */
  abort(sessionId: string): void
  /**
   * 软中断当前 turn，但保留活跃 Query/Channel 以便继续注入下一条用户消息。
   * 与 abort() 的区别：不杀子进程，允许立即续跑新消息。
   */
  interruptQuery?(sessionId: string): Promise<void>
  /** 释放资源 */
  dispose(): void
  /** 向活跃查询注入队列消息（可选，仅支持队列的 Provider 实现） */
  sendQueuedMessage?(sessionId: string, message: SDKUserMessageInput, options?: SendQueuedMessageOptions): Promise<void>
  /** 取消队列中的待发送消息（可选） */
  cancelQueuedMessage?(sessionId: string, messageUuid: string): Promise<void>
  /** 动态切换活跃查询的权限模式（可选，仅支持 SDK 原生 setPermissionMode 的 Provider） */
  setPermissionMode?(sessionId: string, mode: string): Promise<void>
  /** 错误处理辅助函数（Provider 特化逻辑由 Adapter 提供） */
  errorHelpers: AgentErrorHelpers
  /** 判断 provider 是否通过 Anthropic 兼容代理路由（用于团队版代理路径选择） */
  isAnthropicProxyProvider?(provider: string): boolean
}
