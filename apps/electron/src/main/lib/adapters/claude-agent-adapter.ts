/**
 * Claude Agent SDK 适配器
 *
 * 实现 AgentProviderAdapter 接口，直接透传 SDK 的 SDKMessage 流。
 * 使用 includePartialMessages: false 获取完整 JSON 对象，无需逐 chunk 翻译。
 */

import type {
  AgentQueryInput,
  AgentProviderAdapter,
  TypedError,
  ErrorCode,
  ThinkingConfig,
  AgentEffort,
  AgentDefinition,
  SdkBeta,
  JsonSchemaOutputFormat,
  SDKMessage,
} from '@proma/shared'
import type { CanUseToolOptions, PermissionResult } from '../agent-permission-service'

// ============================================================================
// Claude 适配器专用查询选项
// ============================================================================

/** Claude SDK 查询选项（扩展通用 AgentQueryInput） */
export interface ClaudeAgentQueryOptions extends AgentQueryInput {
  /** SDK CLI 路径 */
  sdkCliPath: string
  /** 运行时可执行文件 */
  executable: { type: 'node' | 'bun'; path: string }
  /** 运行时额外参数 */
  executableArgs: string[]
  /** 环境变量（含 API Key、Base URL、代理等） */
  env: Record<string, string | undefined>
  /** 最大轮次（undefined = SDK 默认） */
  maxTurns?: number
  /** SDK 权限模式（直接使用 SDK 原生模式） */
  sdkPermissionMode: 'acceptEdits' | 'bypassPermissions' | 'plan'
  /** 是否跳过权限检查 */
  allowDangerouslySkipPermissions: boolean
  /** 自定义权限处理器（匹配 SDK CanUseTool 签名） */
  canUseTool?: (
    toolName: string,
    input: Record<string, unknown>,
    options: CanUseToolOptions,
  ) => Promise<PermissionResult>
  /** 只读工具白名单 */
  allowedTools?: string[]
  /** 系统提示词 */
  systemPrompt: { type: 'preset'; preset: 'claude_code'; append: string }
  /** SDK session ID（用于 resume） */
  resumeSessionId?: string
  /** MCP 服务器配置 */
  mcpServers?: Record<string, unknown>
  /** 插件配置 */
  plugins?: Array<{ type: 'local'; path: string }>
  /** stderr 回调 */
  onStderr?: (data: string) => void
  /** SDK session ID 捕获回调 */
  onSessionId?: (sdkSessionId: string) => void
  /** 模型确认回调 */
  onModelResolved?: (model: string) => void
  /** 上下文窗口缓存回调 */
  onContextWindow?: (contextWindow: number) => void

  // ===== SDK 0.2.52 ~ 0.2.63 新增选项 =====

  /** 思考模式配置（替代已废弃的 maxThinkingTokens） */
  thinking?: ThinkingConfig
  /** 推理深度等级（与 adaptive thinking 配合使用） */
  effort?: AgentEffort
  /** 自定义子代理定义 */
  agents?: Record<string, AgentDefinition>
  /** 主线程使用的代理名称（必须在 agents 中定义） */
  agent?: string
  /** 启用文件检查点（支持 rewindFiles 回退） */
  enableFileCheckpointing?: boolean
  /** 禁止使用的工具名称列表 */
  disallowedTools?: string[]
  /** 备用模型（主模型不可用时使用） */
  fallbackModel?: string
  /** 最大预算（美元），超出后停止查询 */
  maxBudgetUsd?: number
  /** 结构化 JSON 输出格式 */
  outputFormat?: JsonSchemaOutputFormat
  /** Beta 特性（如 1M context window） */
  betas?: SdkBeta[]
  /** 是否持久化会话到磁盘（默认 true） */
  persistSession?: boolean
  /** resume 时是否 fork 为新会话 */
  forkSession?: boolean
  /** 指定 SDK 会话 ID（替代自动生成，与 AgentQueryInput.sessionId 区分） */
  sdkSessionId?: string
  /** 附加的外部目录（SDK additionalDirectories） */
  additionalDirectories?: string[]
}

// ============================================================================
// SDK 错误消息友好化
// ============================================================================

/** 已知 SDK 错误 → 用户友好提示映射 */
const FRIENDLY_ERROR_MESSAGES: Array<{ pattern: RegExp; message: string }> = [
  {
    pattern: /not logged in|please run \/login/i,
    message: '请检查是否选择了正确的 Proma 供应渠道和模型',
  },
]

/** 将 SDK 原始错误消息转换为用户友好的提示（无匹配则返回原文） */
export function friendlyErrorMessage(raw: string): string {
  for (const { pattern, message } of FRIENDLY_ERROR_MESSAGES) {
    if (pattern.test(raw)) return message
  }
  return raw
}

// ============================================================================
// 错误映射
// ============================================================================

/** Prompt too long 错误关键词匹配 */
const PROMPT_TOO_LONG_PATTERNS = [
  'prompt is too long',
  'prompt_too_long',
  'input is too long',
  'context_length_exceeded',
  'maximum context length',
  'token limit',
  'exceeds the model',
] as const

/** 检测错误消息是否为 prompt too long 类型 */
export function isPromptTooLongError(...messages: string[]): boolean {
  const combined = messages.join(' ').toLowerCase()
  return PROMPT_TOO_LONG_PATTERNS.some((p) => combined.includes(p))
}

/** 将 SDK 错误映射为 TypedError */
export function mapSDKErrorToTypedError(
  errorCode: string,
  detailedMessage: string,
  originalError: string,
): TypedError {
  const errorMap: Record<string, { code: ErrorCode; title: string; message: string; canRetry: boolean }> = {
    'authentication_failed': {
      code: 'invalid_api_key',
      title: '认证失败',
      message: '无法通过 API 认证，API Key 可能无效或已过期',
      canRetry: true,
    },
    'billing_error': {
      code: 'billing_error',
      title: '账单错误',
      message: '您的账户存在账单问题',
      canRetry: false,
    },
    'rate_limited': {
      code: 'rate_limited',
      title: '请求频率限制',
      message: '请求过于频繁，请稍后再试',
      canRetry: true,
    },
    'overloaded': {
      code: 'provider_error',
      title: '服务繁忙',
      message: 'API 服务当前过载，请稍后再试',
      canRetry: true,
    },
    'prompt_too_long': {
      code: 'prompt_too_long',
      title: '上下文过长',
      message: '当前对话的上下文已超出模型限制，请压缩上下文或开启新会话',
      canRetry: false,
    },
  }

  const mapped = errorMap[errorCode] || {
    code: 'unknown_error' as ErrorCode,
    title: '',
    message: detailedMessage || errorCode,
    canRetry: false,
  }

  return {
    code: mapped.code,
    title: mapped.title,
    message: detailedMessage || mapped.message,
    actions: [
      { key: 's', label: '设置', action: 'settings' },
      ...(mapped.canRetry ? [{ key: 'r', label: '重试', action: 'retry' }] : []),
      ...(mapped.code === 'prompt_too_long' ? [{ key: 'c', label: '压缩上下文', action: 'compact' }] : []),
    ],
    canRetry: mapped.canRetry,
    retryDelayMs: mapped.canRetry ? 1000 : undefined,
    originalError,
  }
}

/** 从 assistant 错误消息中提取详细信息 */
export function extractErrorDetails(msg: { error?: { message: string }; message?: { content?: Array<Record<string, unknown>> } }): { detailedMessage: string; originalError: string } {
  let detailedMessage = msg.error?.message ?? '未知错误'
  let originalError = msg.error?.message ?? '未知错误'

  try {
    const content = msg.message?.content
    if (Array.isArray(content) && content.length > 0) {
      const textBlock = content.find((block) => block.type === 'text')
      if (textBlock && 'text' in textBlock && typeof textBlock.text === 'string') {
        const fullText = textBlock.text
        originalError = fullText

        const apiErrorMatch = fullText.match(/API Error:\s*\d+\s*(\{.*\})/s)
        if (apiErrorMatch?.[1]) {
          try {
            const apiErrorObj = JSON.parse(apiErrorMatch[1])
            if (apiErrorObj.error?.message) {
              detailedMessage = apiErrorObj.error.message
            }
          } catch {
            detailedMessage = fullText
          }
        } else {
          detailedMessage = fullText
        }
      }
    }
  } catch {
    // 提取失败，使用原始 error 字段
  }

  return { detailedMessage, originalError }
}

// ============================================================================
// ClaudeAgentAdapter
// ============================================================================

/** 活跃的 AbortController 映射（sessionId → controller） */
const activeControllers = new Map<string, AbortController>()

export class ClaudeAgentAdapter implements AgentProviderAdapter {

  abort(sessionId: string): void {
    const controller = activeControllers.get(sessionId)
    if (controller) {
      controller.abort()
      activeControllers.delete(sessionId)
    }
  }

  dispose(): void {
    for (const [, controller] of activeControllers) {
      controller.abort()
    }
    activeControllers.clear()
  }

  /**
   * 发起查询，返回 SDKMessage 异步迭代流
   *
   * 使用 includePartialMessages: false 获取完整 JSON 对象，直接透传。
   */
  async *query(input: AgentQueryInput): AsyncIterable<SDKMessage> {
    const options = input as ClaudeAgentQueryOptions

    // 创建 AbortController
    const controller = new AbortController()
    activeControllers.set(options.sessionId, controller)

    try {
      // 动态导入 SDK
      const sdk = await import('@anthropic-ai/claude-agent-sdk')

      // SDK options 构建
      const sdkOptions = {
        // 基础字段
        pathToClaudeCodeExecutable: options.sdkCliPath,
        executable: options.executable.type,
        executableArgs: options.executableArgs,
        model: options.model || 'claude-sonnet-4-5-20250929',
        ...(options.maxTurns != null && { maxTurns: options.maxTurns }),
        permissionMode: options.sdkPermissionMode,
        allowDangerouslySkipPermissions: options.allowDangerouslySkipPermissions,
        // 关键：false 获取完整消息，与 v2 stream() 返回格式一致
        includePartialMessages: false,
        promptSuggestions: true,
        cwd: options.cwd,
        abortController: controller,
        env: options.env,
        systemPrompt: options.systemPrompt,
        // 不加载 user 级别的 ~/.claude/settings.json
        settingSources: ['project'],

        // 条件字段
        ...(options.canUseTool && { canUseTool: options.canUseTool }),
        ...(options.allowedTools && { allowedTools: options.allowedTools }),
        ...(options.resumeSessionId ? { resume: options.resumeSessionId } : {}),
        ...(options.mcpServers && Object.keys(options.mcpServers).length > 0 && {
          mcpServers: options.mcpServers as Record<string, import('@anthropic-ai/claude-agent-sdk').McpServerConfig>,
        }),
        ...(options.plugins && { plugins: options.plugins }),
        ...(options.onStderr && { stderr: options.onStderr }),

        // SDK 0.2.52+ 新增选项透传
        ...(options.thinking && { thinking: options.thinking }),
        ...(options.effort && { effort: options.effort }),
        ...(options.agents && { agents: options.agents }),
        ...(options.agent && { agent: options.agent }),
        ...(options.enableFileCheckpointing != null && { enableFileCheckpointing: options.enableFileCheckpointing }),
        ...(options.disallowedTools && { disallowedTools: options.disallowedTools }),
        ...(options.fallbackModel && { fallbackModel: options.fallbackModel }),
        ...(options.maxBudgetUsd != null && { maxBudgetUsd: options.maxBudgetUsd }),
        ...(options.outputFormat && { outputFormat: options.outputFormat }),
        ...(options.betas && { betas: options.betas }),
        ...(options.persistSession != null && { persistSession: options.persistSession }),
        ...(options.forkSession != null && { forkSession: options.forkSession }),
        ...(options.sdkSessionId && { sessionId: options.sdkSessionId }),
        ...(options.additionalDirectories && options.additionalDirectories.length > 0 && {
          additionalDirectories: options.additionalDirectories,
        }),
      } as import('@anthropic-ai/claude-agent-sdk').Options

      const queryIterator = sdk.query({
        prompt: options.prompt,
        options: sdkOptions,
      })

      for await (const sdkMessage of queryIterator) {
        if (controller.signal.aborted) break

        const msg = sdkMessage as Record<string, unknown>

        // 捕获 SDK session_id
        if ('session_id' in msg && typeof msg.session_id === 'string' && msg.session_id) {
          options.onSessionId?.(msg.session_id)
        }

        // 捕获 system init 中的模型确认
        if (msg.type === 'system' && msg.subtype === 'init') {
          if (typeof msg.model === 'string') {
            options.onModelResolved?.(msg.model)
          }
        }

        // 捕获 result 中的 contextWindow
        if (msg.type === 'result') {
          const resultMsg = msg as { modelUsage?: Record<string, { contextWindow?: number }> }
          if (resultMsg.modelUsage) {
            const firstEntry = Object.values(resultMsg.modelUsage)[0]
            if (firstEntry?.contextWindow) {
              options.onContextWindow?.(firstEntry.contextWindow)
            }
          }
        }

        yield sdkMessage as SDKMessage
      }
    } finally {
      activeControllers.delete(options.sessionId)
    }
  }
}
