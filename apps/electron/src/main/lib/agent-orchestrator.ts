/**
 * AgentOrchestrator — Agent 编排层
 *
 * 从 agent-service.ts 提取的核心业务逻辑，负责：
 * - 并发守卫（同一会话不允许并行请求）
 * - 渠道查找 + API Key 解密
 * - 环境变量构建 + SDK 路径解析
 * - 用户/助手消息持久化
 * - 事件流遍历 + 文本累积 + 事件持久化
 * - 错误处理 + 部分内容保存
 * - 自动标题生成
 *
 * 通过 EventBus 分发 AgentEvent，通过 SessionCallbacks 发送控制信号，
 * 完全解耦 Electron IPC，可独立测试（mock Adapter + EventBus）。
 */

import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import type { AgentSendInput, AgentMessage, AgentGenerateTitleInput, AgentProviderAdapter, AgentQueryInput, AgentSessionMeta, TypedError, RetryAttempt, SDKMessage, SDKAssistantMessage, AgentStreamPayload, RewindSessionResult, SdkBeta, ProviderType } from '@profer/shared'
import {
  PROFER_DEFAULT_PERMISSION_MODE,
  SAFE_TOOLS,
  THINKING_SIGNATURE_ERROR_CODE,
  THINKING_SIGNATURE_ERROR_MESSAGE,
  THINKING_SIGNATURE_ERROR_TITLE,
  supports1MContext,
  resolveAgentSdkModelId,
} from '@profer/shared'
import type { PermissionRequest, ProferPermissionMode, AskUserRequest, ExitPlanModeRequest } from '@profer/shared'
import { AgentEventBus } from './agent-event-bus'
import { decryptApiKey, getChannelById, isCommercialMode, listChannels, canSelfConfig } from './channel-manager'
import { getTeamAuthWithRefresh } from './auth-service'
import { injectAutomationMcpServer } from './automation-agent-tools'
import { injectKbMcpServer } from './kb-agent-tools'
import { buildAgentKnowledgePrompt } from './agent-knowledge-prompt'
import { injectTaskGraphMcpServer } from './task-graph-agent-tools'
import {
  delegationLinkFromResult,
  delegationToGraphEvents,
  isDelegateAgentTool,
  nativeTaskToolToGraphEvents,
  structuredTaskAutoLinkEvent,
  structuredTaskToolCurrentTaskId,
  type TaskToolInvocation,
} from './task-graph-event-converter'
import { appendGraphEvent } from './project-graph-service'
import {
  injectAgentCollaborationMcpServer,
  registerCollaborationEventBus,
} from './agent-collaboration-tools'
import { setHeadlessAgentRunner, setAgentStopper } from './agent-headless-runner-registry'
import { getAdapter, fetchTitle } from '@profer/core'
import { getFetchFn } from './proxy-fetch'
import { getEffectiveProxyUrl } from './proxy-settings-service'
import { isCommercialBuild } from './build-target'
import { appendSDKMessages, updateAgentSessionMeta, getAgentSessionMeta, getAgentSessionMessages, truncateSDKMessages, resolveUserUuidFromSDK, rewindFilesFromSnapshot } from './agent-session-manager'
import { getAgentWorkspace, getWorkspaceMcpConfig, getWorkspaceAutoMemoryDir, ensurePluginManifest } from './agent-workspace-manager'
import { getAgentWorkspacePath, getAgentSessionWorkspacePath, getSdkConfigDir, getBundledCliPath } from './config-paths'
import { getRuntimeStatus } from './runtime-init'
import { getSettings } from './settings-service'
import { buildSystemPrompt, buildDynamicContext } from './agent-prompt-builder'
import { permissionService } from './agent-permission-service'
import type { PermissionResult, CanUseToolOptions } from './agent-permission-service'
import { askUserService } from './agent-ask-user-service'
import { exitPlanService, type ExitPlanPermissionResult } from './agent-exit-plan-service'
import { applyAgentModelRoutingToEnv, resolveAgentModelRouting } from './agent-model-routing'

import { validateToolInput } from './agent-tool-input-validator'
import { estimateTokenCount, WRITE_CONTENT_TOKEN_THRESHOLD } from './agent-tool-token-estimator'

// 已提取的工具模块
import { sdkPermissionModeForProferMode, extractApiError, isAutoRetryableTypedError, isAutoRetryableCatchError, isSessionNotFoundError, getRetryDelayMs, MAX_AUTO_RETRIES, MAX_AUTO_RETRY_WAIT_MS } from './agent-retry-utils'
import { extractSDKToolSummary, buildContextPrompt, buildRecoveryPrompt, escapeContextAttr, buildReferencedSessionsPrompt, TITLE_PROMPT, MAX_TITLE_LENGTH, DEFAULT_SESSION_TITLE, DEFAULT_MODEL_ID, MAX_CONTEXT_MESSAGES } from './agent-prompt-utils'
import { resolveSDKCliPath } from './agent-sdk-cli-path'
import { collectAttachedDirectories } from './agent-directory-utils'
import { applySdkCredentials, isPlanModeMarkdownPath, isPlanModeMcpTool, releaseActiveSession, tryAcquireActiveSession } from './agent-orchestrator-p0-guards'

// ===== 类型定义 =====

/**
 * 会话控制信号回调
 *
 * 解耦 Electron webContents，使 Orchestrator 可独立测试。
 * agent-service.ts 负责将这些回调绑定到 webContents.send()。
 */
export interface SessionCallbacks {
  /** 发送流式错误 */
  onError: (error: string) => void
  /** 发送流式完成（携带已持久化的消息列表） */
  onComplete: (messages?: AgentMessage[], opts?: { stoppedByUser?: boolean; startedAt?: number; resultSubtype?: string; resultErrors?: string[]; backgroundTasksPending?: boolean }) => void
  /** 发送标题更新 */
  onTitleUpdated: (title: string) => void
  /** 用户消息已持久化，外部入口可据此通知前端切到实时会话 */
  onRunStarted?: (opts: { startedAt: number }) => void
}

// ===== 错误诊断工具 =====

/** 将捕获的 unknown error 序列化为详细诊断信息，用于控制台日志排查 */
export function serializeErrorDetail(error: unknown): string {
  if (error === null) return 'error 为 null'
  if (error === undefined) return 'error 为 undefined'
  const type = typeof error
  if (type === 'string') return `[类型: string] ${error as string}`
  if (type === 'number') return `[类型: number] ${String(error)}`
  if (type === 'boolean') return `[类型: boolean] ${String(error)}`
  if (type === 'bigint') return `[类型: bigint] ${String(error)}`
  if (type === 'symbol') return `[类型: symbol] ${String(error)}`
  if (type === 'function') return `[类型: function] ${(error as () => void).name || 'anonymous'}`

  if (error instanceof Error) {
    const parts: string[] = [
      `[类型: ${error.constructor.name}]`,
      `message: ${error.message || '(空)'}`,
      `name: ${error.name}`,
    ]
    if (error.stack) {
      // 取前 3 行 stack（含 message 行）
      const stackLines = error.stack.split('\n').slice(0, 4)
      parts.push(`stack(前4行): ${stackLines.join('\n    ')}`)
    }
    if (error.cause) {
      parts.push(`cause: ${serializeErrorDetail(error.cause)}`)
    }
    // 也列出其他可枚举属性（如 statusCode, code 等）
    const extra = Object.keys(error).filter((k) => !['message', 'name', 'stack', 'cause'].includes(k))
    if (extra.length > 0) {
      parts.push(`额外属性: ${JSON.stringify(extra.reduce((acc, k) => ({ ...acc, [k]: (error as unknown as Record<string, unknown>)[k] }), {}))}`)
    }
    return parts.join('\n  | ')
  }

  // 普通对象或其他
  try {
    return `[类型: object, constructor: ${(error as object).constructor?.name || 'unknown'}] keys: ${Object.keys(error as object).join(', ') || '(无)'} | JSON: ${JSON.stringify(error)}`
  } catch {
    return `[类型: object] (无法序列化)`
  }
}

// ===== AgentOrchestrator =====

export class AgentOrchestrator {
  private adapter: AgentProviderAdapter
  private eventBus: AgentEventBus
  /** sessionId → 本轮不可复用的运行令牌；避免并发和旧运行 finally 误清理新状态。 */
  private activeSessions = new Map<string, string>()

  /** 队列消息本地记录（sessionId → UUID 集合，用于防重） */
  private queuedMessageUuids = new Map<string, Set<string>>()

  /** 被用户手动中止的会话集合（在 stop 中标记，catch block 中消费） */
  private stoppedBySessions = new Set<string>()

  /** 运行中会话的当前权限模式（支持运行时动态切换） */
  private sessionPermissionModes = new Map<string, ProferPermissionMode>()

  /** 每轮真实运行的退出信号；不能以 activeSessions 判断 stop 后是否已退出。 */
  private runCompletions = new Map<string, { token: string; promise: Promise<void>; resolve: () => void }>()

  /** 删除期间禁止同一会话从 UI、队列或 headless 路径重新进入。 */
  private deletingSessions = new Set<string>()

  constructor(adapter: AgentProviderAdapter, eventBus: AgentEventBus) {
    this.adapter = adapter
    this.eventBus = eventBus
    registerCollaborationEventBus(eventBus)

    // 注册 headless runner，供协作工具 / 自动任务 / 桥接命令等非 UI 场景调用
    setHeadlessAgentRunner((input, callbacks) =>
      this.sendMessage(input, callbacks)
    )
    setAgentStopper((sessionId) => {
      this.stop(sessionId)
    })
  }

  /**
   * 消费一次用户手动停止标记。
   *
   * SDK 在 query.close() 后不一定走异常路径：某些版本会先正常 yield result 再结束迭代。
   * 因此停止标记必须在所有终态路径统一消费，而不能只依赖 catch 块。
   */
  private consumeStoppedByUser(sessionId: string): boolean {
    const stoppedByUser = this.stoppedBySessions.has(sessionId)
    this.stoppedBySessions.delete(sessionId)
    return stoppedByUser
  }

  /**
   * 构建 SDK 环境变量
   *
   * 注入 API Key、Base URL、代理、Shell 配置等。
   * 对 Kimi Coding Plan / MiniMax Coding Plan：使用 Bearer 认证（ANTHROPIC_AUTH_TOKEN）。
   */
  private async buildSdkEnv(
    apiKey: string,
    baseUrl: string | undefined,
    provider: ProviderType,
    forceBearerAuth = false,
  ): Promise<Record<string, string | undefined>> {
    // 从 process.env 继承系统变量，但清理所有 ANTHROPIC_ 前缀的变量，
    // 防止本地开发环境（如 ANTHROPIC_AUTH_TOKEN、ANTHROPIC_API_KEY、
    // ANTHROPIC_BASE_URL 等）干扰 SDK 的认证和请求目标。
    // 即使 index.ts 启动时已清理过一次，initializeRuntime() 中的
    // loadShellEnv() 可能从 shell 配置文件（~/.zshrc 等）重新注入这些变量。
    const cleanEnv: Record<string, string | undefined> = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (!key.startsWith('ANTHROPIC_')) {
        cleanEnv[key] = value
      }
    }

    const sdkEnv: Record<string, string | undefined> = {
      ...cleanEnv,
      // 提升输出 token 上限，避免 "exceeded 32000 output token maximum" 错误
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: '64000',
      // 暴露打包进 App 的 proma CLI 路径，供 session-cleaner 等 skill / Agent 调用
      // （开发模式无编译二进制，getBundledCliPath 返回 undefined，此处不注入，
      //   skill 回退到源码运行 bun apps/cli/src/index.ts）。
      ...(getBundledCliPath() ? { PROMA_CLI: getBundledCliPath() } : {}),
      // 启用 Tasks 功能
      CLAUDE_CODE_ENABLE_TASKS: 'true',
      // 禁用实验性 beta 功能，使用稳定模式
      CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
      // 配置隔离：让 SDK 使用独立的配置目录，不读取用户的 ~/.claude.json
      CLAUDE_CONFIG_DIR: getSdkConfigDir(),
    }

    // 凭证只写入本次 query 的 env，不回写主进程 process.env。
    applySdkCredentials(sdkEnv, apiKey, baseUrl, provider, forceBearerAuth)

    const proxyUrl = await getEffectiveProxyUrl()
    if (proxyUrl) {
      sdkEnv.HTTPS_PROXY = proxyUrl
      sdkEnv.HTTP_PROXY = proxyUrl
    }

    // Windows 平台：配置 Shell 环境
    if (process.platform === 'win32') {
      const runtimeStatus = getRuntimeStatus()
      const shellStatus = runtimeStatus?.shell

      if (shellStatus) {
        if (shellStatus.gitBash?.available && shellStatus.gitBash.path) {
          sdkEnv.CLAUDE_CODE_SHELL = shellStatus.gitBash.path
          console.log(`[Agent 编排] 配置 Shell 环境: Git Bash (${shellStatus.gitBash.path})`)
        } else if (shellStatus.wsl?.available) {
          sdkEnv.CLAUDE_CODE_SHELL = 'wsl'
          console.log(`[Agent 编排] 配置 Shell 环境: WSL ${shellStatus.wsl.version} (${shellStatus.wsl.defaultDistro})`)
        } else {
          console.warn('[Agent 编排] Windows 平台未检测到可用的 Shell 环境（Git Bash / WSL）')
        }
        sdkEnv.CLAUDE_BASH_NO_LOGIN = '1'
      }
    }

    // 针对 claude-agent-sdk 0.2.111+ 的 options.env 叠加语义加固：
    // SDK 将 options.env 叠加到 process.env 之上传递给子进程。
    // 若 shell 中存在 ANTHROPIC_CUSTOM_HEADERS、ANTHROPIC_MODEL 等变量，
    // 且 sdkEnv 未显式管理，叠加后会回流到 SDK 子进程。
    // 对于 sdkEnv 未显式管理的 ANTHROPIC_* 变量，显式置空字符串以覆盖回流。
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('ANTHROPIC_') && !(key in sdkEnv)) {
        sdkEnv[key] = ''
      }
    }

    return sdkEnv
  }

  /**
   * 构建工作区 MCP 服务器配置
   */
  private buildMcpServers(workspaceSlug: string | undefined): Record<string, Record<string, unknown>> {
    const mcpServers: Record<string, Record<string, unknown>> = {}
    if (!workspaceSlug) return mcpServers

    const mcpConfig = getWorkspaceMcpConfig(workspaceSlug)
    for (const [name, entry] of Object.entries(mcpConfig.servers ?? {})) {
      if (!entry.enabled) continue
      if (name === 'memos-cloud') continue

      if (entry.type === 'stdio' && entry.command) {
        const mergedEnv: Record<string, string> = {
          ...(process.env.PATH && { PATH: process.env.PATH }),
          ...entry.env,
        }
        mcpServers[name] = {
          type: 'stdio',
          command: entry.command,
          ...(entry.args && entry.args.length > 0 && { args: entry.args }),
          ...(Object.keys(mergedEnv).length > 0 && { env: mergedEnv }),
          required: false,
          startup_timeout_sec: entry.timeout ?? 30,
        }
      } else if ((entry.type === 'http' || entry.type === 'sse') && entry.url) {
        mcpServers[name] = {
          type: entry.type,
          url: entry.url,
          ...(entry.headers && Object.keys(entry.headers).length > 0 && { headers: entry.headers }),
          required: false,
        }
      } else {
        console.warn(`[Agent 编排] MCP 服务器 "${name}" 配置不完整，已跳过（type=${entry.type}, command=${entry.command ?? '无'}, url=${entry.url ?? '无'}）`)
      }
    }

    if (Object.keys(mcpServers).length > 0) {
      console.log(`[Agent 编排] 已加载 ${Object.keys(mcpServers).length} 个 MCP 服务器`)
    }

    return mcpServers
  }

  /**
   * 生成 Agent 会话标题
   *
   * 使用 Provider 适配器系统，支持所有渠道。任何错误返回 null。
   */
  async generateTitle(input: AgentGenerateTitleInput): Promise<string | null> {
    const { userMessage, channelId, modelId } = input
    console.log('[Agent 标题生成] 开始生成标题:', { channelId, modelId, userMessage: userMessage.slice(0, 50) })

    try {
      const channels = listChannels()
      const channel = channels.find((c) => c.id === channelId)
      if (!channel) {
        console.warn('[Agent 标题生成] 渠道不存在:', channelId)
        return null
      }

      let apiKey: string
      let proxyBaseUrl = ''
      if ((isCommercialBuild() || isCommercialMode()) && channel.id?.startsWith('newapi-')) {
        const auth = await getTeamAuthWithRefresh()
        if (!auth) {
          console.warn('[Agent 标题生成] 团队账号登录已过期，跳过 AI 标题生成')
          return null
        }
        const proxyPath = (this.adapter.isAnthropicProxyProvider?.(channel.provider) ?? true) ? '/v1/proxy/messages' : '/v1/proxy/chat'
        proxyBaseUrl = `${auth.baseUrl}${proxyPath}`
        apiKey = auth.proxyToken || auth.token
      } else {
        apiKey = decryptApiKey(channelId)
      }

      const providerAdapter = getAdapter(channel.provider)
      const request = providerAdapter.buildTitleRequest({
        baseUrl: proxyBaseUrl || channel.baseUrl,
        apiKey,
        modelId,
        prompt: TITLE_PROMPT + userMessage,
      })
      if (proxyBaseUrl) request.url = proxyBaseUrl

      const proxyUrl = await getEffectiveProxyUrl()
      const fetchFn = getFetchFn(proxyUrl)
      const title = await fetchTitle(request, providerAdapter, fetchFn)
      if (!title) {
        console.warn('[Agent 标题生成] API 返回空标题')
        return null
      }

      const cleaned = title.trim().replace(/^["'""''「《]+|["'""''」》]+$/g, '').trim()
      const result = cleaned.slice(0, MAX_TITLE_LENGTH) || null

      console.log(`[Agent 标题生成] 生成标题成功: "${result}"`)
      return result
    } catch (error) {
      console.warn('[Agent 标题生成] 生成失败:', error)
      return null
    }
  }

  /**
   * 流完成后自动生成标题
   *
   * 如果会话标题仍为默认值，自动调用标题生成并通过回调通知。
   */
  private async autoGenerateTitle(
    sessionId: string,
    userMessage: string,
    channelId: string,
    modelId: string,
    callbacks: SessionCallbacks,
  ): Promise<void> {
    try {
      const meta = getAgentSessionMeta(sessionId)
      if (!meta || meta.title !== DEFAULT_SESSION_TITLE) return

      const title = await this.generateTitle({ userMessage, channelId, modelId })
      if (!title) return

      updateAgentSessionMeta(sessionId, { title })
      callbacks.onTitleUpdated(title)
      console.log(`[Agent 编排] 自动标题生成完成: "${title}"`)
    } catch (error) {
      console.warn('[Agent 编排] 自动标题生成失败:', error)
    }
  }

  /**
   * Session-not-found 恢复：清除失效的 sdkSessionId，切换到上下文回填模式
   *
   * 当 resume 的目标 session 已过期/被清理时，SDK 会抛出 "No conversation found" 错误。
   * 此方法执行恢复的公共逻辑，调用方负责设置 existingSdkSessionId = undefined 和流程控制（break/continue）。
   *
   * @returns lastRetryableError 描述字符串
   */
  private prepareSessionNotFoundRecovery(
    sessionId: string,
    queryOptions: AgentQueryInput & Record<string, unknown>,
    contextualMessage: string,
    agentCwd: string,
    accumulatedMessages: SDKMessage[],
    queryStartedAt: number,
  ): string {
    return this.prepareResumeFallbackRecovery(
      sessionId,
      queryOptions,
      contextualMessage,
      agentCwd,
      accumulatedMessages,
      queryStartedAt,
      '检测到 session-not-found 错误，清除 sdkSessionId 并切换到上下文回填模式',
      'Session 已失效，切换到上下文回填模式',
    )
  }

  /**
   * Resume 失败恢复：清除 SDK resume 关系，注入 session 自引用让 Agent 读取完整历史继续工作。
   *
   * 适用于 SDK session 过期、thinking signature 跨模型不兼容等场景。
   * 使用 <session_recovery> 标签指向当前会话的 JSONL 历史文件，Agent 会自动读取并恢复上下文，
   * 比 buildContextPrompt（仅注入 20 条摘要）提供完整得多的上下文连续性。
   */
  private prepareResumeFallbackRecovery(
    sessionId: string,
    queryOptions: AgentQueryInput & Record<string, unknown>,
    contextualMessage: string,
    agentCwd: string,
    accumulatedMessages: SDKMessage[],
    queryStartedAt: number,
    logMessage: string,
    retryReason: string,
  ): string {
    console.log(`[Agent 编排] ${logMessage}`)
    // 先持久化当前已累积的消息，确保 JSONL 文件包含最新内容
    this.persistSDKMessages(sessionId, accumulatedMessages, Date.now() - queryStartedAt)
    accumulatedMessages.length = 0
    // 清除失效的 SDK session，新 SDK 会话产生的 sdkSessionId 会通过 onSessionId 回调自动保存
    // 此操作必须成功，否则下次打开会话仍会尝试 resume 已失效的 session，陷入无限恢复循环
    try {
      updateAgentSessionMeta(sessionId, { sdkSessionId: undefined })
    } catch (clearErr) {
      console.error(`[Agent 编排] ⚠️ 清除失效 sdkSessionId 失败！下次打开此会话可能仍触发 session-not-found 恢复:`, clearErr)
      // 写诊断文件供后续排查
      try {
        const diagDir = join(getAgentSessionWorkspacePath(
          getAgentWorkspace(getAgentSessionMeta(sessionId)?.workspaceId ?? '')?.slug ?? 'unknown',
          sessionId,
        ), '.context')
        if (!existsSync(diagDir)) mkdirSync(diagDir, { recursive: true })
        appendFileSync(join(diagDir, 'session-errors.log'),
          `[${new Date().toISOString()}] session-not-found 恢复时清除 sdkSessionId 失败: ${clearErr}\n`)
      } catch { /* 诊断写入是尽力而为的 */ }
    }
    queryOptions.resumeSessionId = undefined
    queryOptions.resumeSessionAt = undefined
    queryOptions.prompt = buildRecoveryPrompt(sessionId, contextualMessage, { agentCwd })
    return retryReason
  }

  /**
   * 持久化累积的 SDKMessage（Phase 4: 直接存储原始 SDKMessage）
   *
   * 只持久化 assistant、user、result 和需要长期可见的 system 消息
   * （跳过 tool_progress、compacting 等临时消息）。
   */
  private persistSDKMessages(
    sessionId: string,
    accumulatedMessages: SDKMessage[],
    durationMs?: number,
  ): void {
    if (accumulatedMessages.length === 0) return

    const toPersist = accumulatedMessages.filter(
      (m) => m.type === 'assistant' || m.type === 'user' || m.type === 'result'
        || (m.type === 'system' && ['compact_boundary', 'permission_denied'].includes((m as import('@profer/shared').SDKSystemMessage).subtype ?? ''))
    ).filter((m) => {
      // 过滤 SDK 内部生成的 user 文本消息（如 Skill 展开 prompt），与实时流过滤逻辑一致
      if (m.type === 'user') {
        const content = (m as { message?: { content?: Array<{ type: string }> } }).message?.content
        const hasToolResult = Array.isArray(content) && content.some((b) => b.type === 'tool_result')
        if (!hasToolResult) return false
      }
      return true
    })

    if (toPersist.length === 0) return

    // 为没有 _createdAt 的消息补上时间戳（assistant 消息来自 SDK 原始输出，不含时间）
    const now = Date.now()
    const withTimestamps = toPersist.map((m) => {
      const msg = m as Record<string, unknown>
      if (typeof msg._createdAt === 'number') return m
      // 为 result 消息附加 _durationMs
      if (m.type === 'result' && durationMs != null) {
        return { ...m, _createdAt: now, _durationMs: durationMs } as unknown as SDKMessage
      }
      return { ...m, _createdAt: now } as unknown as SDKMessage
    })

    appendSDKMessages(sessionId, withTimestamps)
  }

  /**
   * 发送消息并流式推送事件
   *
   * 核心编排方法，从 agent-service.ts 的 runAgent 提取。
   * 通过 EventBus 分发 AgentEvent，通过 callbacks 发送控制信号。
   */
  async sendMessage(input: AgentSendInput, callbacks: SessionCallbacks): Promise<void> {
    const { sessionId, userMessage, channelId, modelId, workspaceId, additionalDirectories, customMcpServers, permissionModeOverride, mentionedSkills, mentionedMcpServers, mentionedSessionIds, automationContext } = input
    const stderrChunks: string[] = []

    // 0. 并发保护
    // 在任意 await 前原子占用会话，商业渠道认证刷新也不得留下并发窗口。
    const runGeneration = randomUUID()
    const streamStartedAt = input.startedAt ?? Date.now()
    if (this.deletingSessions.has(sessionId)) {
      callbacks.onError('会话正在删除，无法发送消息')
      callbacks.onComplete([], { startedAt: input.startedAt })
      return
    }
    if (!tryAcquireActiveSession(this.activeSessions, sessionId, runGeneration)) {
      console.warn(`[Agent 编排] 会话 ${sessionId} 正在处理中，拒绝新请求`)
      callbacks.onError('上一条消息仍在处理中，请稍候再试')
      callbacks.onComplete([], { startedAt: input.startedAt })
      return
    }
    let resolveCompletion!: () => void
    const completion = new Promise<void>((resolve) => { resolveCompletion = resolve })
    this.runCompletions.set(sessionId, { token: runGeneration, promise: completion, resolve: resolveCompletion })
    const releaseActiveRun = (): void => {
      if (!releaseActiveSession(this.activeSessions, sessionId, runGeneration)) return
      this.sessionPermissionModes.delete(sessionId)
      this.queuedMessageUuids.delete(sessionId)
    }

    try {
    // 0.5 清除上一轮中断标记
    try { updateAgentSessionMeta(sessionId, { stoppedByUser: false }) } catch { /* 会话可能已删除 */ }

    // 环境 / 配置类错误的统一上报：持久化为 TypedError 消息，由 SDKMessageRenderer 渲染
    const reportPreflightError = (typedError: TypedError) => {
      const errorContent = typedError.title
        ? `${typedError.title}: ${typedError.message}`
        : typedError.message
      const errorSDKMsg: SDKMessage = {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: errorContent }],
        },
        parent_tool_use_id: null,
        error: { message: typedError.message, errorType: typedError.code },
        _createdAt: Date.now(),
        _errorCode: typedError.code,
        _errorTitle: typedError.title,
        _errorDetails: typedError.details,
        _errorCanRetry: typedError.canRetry,
        _errorActions: typedError.actions,
      } as unknown as SDKMessage
      try { appendSDKMessages(sessionId, [errorSDKMsg]) } catch (e) {
        console.error('[Agent 编排] 持久化 preflight error 失败:', e)
      }
      callbacks.onError(errorContent)
      callbacks.onComplete([], { startedAt: input.startedAt })
    }

    // 1. Windows 平台：检查 Shell 环境可用性
    if (process.platform === 'win32') {
      const runtimeStatus = getRuntimeStatus()
      const shellStatus = runtimeStatus?.shell

      if (shellStatus && !shellStatus.gitBash?.available && !shellStatus.wsl?.available) {
        reportPreflightError({
          code: 'windows_shell_missing',
          title: 'Windows 环境未就绪',
          message:
            '需要 Git Bash 或 WSL 才能运行 Agent。建议安装 Git for Windows（自带 Git Bash），安装完成后点「打开环境检测」刷新状态。',
          details: [
            `Git Bash: ${shellStatus.gitBash?.error || '未检测到'}`,
            `WSL: ${shellStatus.wsl?.error || '未检测到'}`,
          ],
          actions: [
            { key: 'e', label: '打开环境检测', action: 'open_environment_check' },
            { key: 'g', label: '去官方下载 Git', action: 'open_external', payload: 'https://git-scm.com/download/win' },
          ],
          canRetry: false,
        })
        return
      }
    }

    // 2. 获取渠道信息并解密 API Key
    const channel = getChannelById(channelId)
    if (!channel) {
      reportPreflightError({
        code: 'channel_not_found',
        title: '渠道不存在',
        message: '当前会话引用的渠道已被删除或不可用，请在设置中重新选择。',
        actions: [
          { key: 's', label: '打开渠道设置', action: 'open_channel_settings' },
        ],
        canRetry: false,
      })
      return
    }

    let apiKey: string
    let agentUrl = (channel as any).agentBaseUrl || channel.baseUrl
    const isOfficialChannel = channel.id?.startsWith('newapi-')
    const forceBearerAuth = (isCommercialBuild() || isCommercialMode()) && isOfficialChannel
    if (forceBearerAuth) {
      const auth = await getTeamAuthWithRefresh()
      if (!auth) {
        reportPreflightError({
          code: 'token_expired',
          title: '团队账号登录已过期',
          message: '请重新登录团队账号后再使用 Agent 商业渠道。',
          actions: [{ key: 's', label: '打开设置', action: 'settings' }],
          canRetry: false,
        })
        return
      }
      apiKey = auth.proxyToken || auth.token
      agentUrl = `${auth.baseUrl}/v1/proxy`
    } else {
      try {
        apiKey = decryptApiKey(channelId)
      } catch {
        reportPreflightError({
          code: 'api_key_decrypt_failed',
          title: 'API Key 解密失败',
          message: '无法解密此渠道的 API Key，可能是系统密钥环异常。请到设置中重新填写 API Key。',
          actions: [
            { key: 's', label: '打开渠道设置', action: 'open_channel_settings' },
          ],
          canRetry: false,
        })
        return
      }
    }

    // 5. 持久化用户消息（SDKMessage 格式）——在所有 preflight 检查之前写入，
    // 确保即使后续渠道/Key 检查失败，用户输入也不会丢失。
    const userSDKMsg: SDKMessage = {
      type: 'user',
      message: {
        content: [{ type: 'text', text: userMessage }],
      },
      parent_tool_use_id: null,
      _createdAt: Date.now(),
    } as unknown as SDKMessage
    appendSDKMessages(sessionId, [userSDKMsg])
    callbacks.onRunStarted?.({ startedAt: streamStartedAt })
    const completeRun = (
      messages?: AgentMessage[],
      opts?: { stoppedByUser?: boolean; startedAt?: number; resultSubtype?: string; resultErrors?: string[] },
    ): void => {
      releaseActiveRun()
      callbacks.onComplete(messages, opts)
    }
    // 轻量完成：turn 主体结束但仍有后台任务在飞行。
    // 关键区别——不调用 releaseActiveRun，保留 activeSessions/activeChannels/sessionPermissionModes，
    // 以便 ① adapter 保持的通道在任务完成时自动续轮 ② 用户在等待期手动注入消息能复用通道。
    // UI 侧通过 backgroundTasksPending 进入"空闲可输入"态（spinner 停、输入框启用）。
    const idleComplete = (
      messages?: AgentMessage[],
      opts?: { startedAt?: number; resultSubtype?: string; resultErrors?: string[] },
    ): void => {
      callbacks.onComplete(messages, { ...opts, backgroundTasksPending: true })
    }
    const failRun = (
      error: string,
      messages?: AgentMessage[],
      opts?: { stoppedByUser?: boolean; startedAt?: number; resultSubtype?: string; resultErrors?: string[] },
    ): void => {
      releaseActiveRun()
      callbacks.onError(error)
      callbacks.onComplete(messages, opts)
    }

    // 3. 构建本轮专属 SDK 环境。绝不修改主进程 process.env，避免并发 session 串扰凭证。
    const modelRouting = resolveAgentModelRouting({ modelId: modelId || DEFAULT_MODEL_ID, provider: channel.provider })
    const sdkEnv = await this.buildSdkEnv(apiKey, agentUrl, channel.provider, forceBearerAuth)
    applyAgentModelRoutingToEnv(sdkEnv, modelRouting)

    // 4. 读取已有的 SDK session ID（用于 resume）
    const sessionMeta = getAgentSessionMeta(sessionId)
    let existingSdkSessionId = sessionMeta?.sdkSessionId

    // 4.1 检测回退后的 resume 截断点（快照回退功能）
    let rewindResumeAt: string | undefined
    if (sessionMeta?.resumeAtMessageUuid) {
      rewindResumeAt = sessionMeta.resumeAtMessageUuid
      // 消费一次后清除
      updateAgentSessionMeta(sessionId, { resumeAtMessageUuid: undefined })
      console.log(`[Agent 编排] 检测到回退 resume: resumeSessionAt=${rewindResumeAt}`)
    }

    console.log(`[Agent 编排] Resume 状态: sdkSessionId=${existingSdkSessionId || '无'}, proma sessionId=${sessionId}`)

    // 6. 状态初始化
    const accumulatedMessages: SDKMessage[] = []
    let resolvedModel = modelId || DEFAULT_MODEL_ID
    let titleGenerationStarted = false
    let agentCwd: string | undefined
    let workspaceSlug: string | undefined
    let workspace: import('@profer/shared').AgentWorkspace | undefined

      // 8. 动态导入 SDK
      const sdk = await import('@anthropic-ai/claude-agent-sdk')

      // 9. 构建 SDK query
      const cliPath = resolveSDKCliPath()

      if (!existsSync(cliPath)) {
        const subpkg = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`
        console.error(`[Agent 编排] SDK native binary 不存在: ${cliPath}`)
        reportPreflightError({
          code: 'claude_binary_not_found',
          title: 'Claude 核心未就绪',
          message:
            '应用安装包里缺少 Claude Agent SDK 的核心可执行文件（claude.exe）。这通常是打包时未包含当前平台的 SDK 组件导致。请重新下载最新安装包，或提交 issue 告知我们。',
          details: [
            `缺失文件: ${cliPath}`,
            `需要的子包: ${subpkg}`,
          ],
          actions: [
            {
              key: 'd',
              label: '下载最新安装包',
              action: 'open_external',
              payload: 'https://proma.cool/download',
            },
            {
              key: 'i',
              label: '报告问题',
              action: 'open_external',
              payload: 'https://github.com/Yuan-lai-ru-ci/Profer/issues/new',
            },
          ],
          canRetry: false,
        })
        return
      }

      console.log(
        `[Agent 编排] 启动 SDK — binary: ${cliPath}, 模型: ${modelId || DEFAULT_MODEL_ID}, resume: ${existingSdkSessionId ?? '无'}`,
      )

      // 确定 Agent 工作目录
      agentCwd = homedir()
      workspaceSlug = undefined
      workspace = undefined
      if (workspaceId) {
        const ws = getAgentWorkspace(workspaceId)
        if (ws) {
          agentCwd = getAgentSessionWorkspacePath(ws.slug, sessionId)
          workspaceSlug = ws.slug
          workspace = ws
          console.log(`[Agent 编排] 使用 session 级别 cwd: ${agentCwd} (${ws.name}/${sessionId})`)

          ensurePluginManifest(ws.slug, ws.name)

          if (existingSdkSessionId) {
            console.log(`[Agent 编排] 将尝试 resume: ${existingSdkSessionId}`)
          } else {
            console.log(`[Agent 编排] 无 sdkSessionId，将作为新会话启动（回填历史上下文）`)
          }
        }
      }

      // 9.4.1 Fork session JSONL 迁移已在 forkAgentSession 中完成，
      // fork 后的会话直接使用自己的 cwd，无需回退到源目录。
      // forkSourceDir 仅作为备用参考字段保留，不再影响 agentCwd。

      // 9.5 确保 SDK 项目设置（plansDirectory → .context）
      {
        const claudeSettingsDir = join(agentCwd, '.claude')
        if (!existsSync(claudeSettingsDir)) mkdirSync(claudeSettingsDir, { recursive: true })
        const settingsPath = join(claudeSettingsDir, 'settings.json')
        let sdkProjectSettings: Record<string, unknown> = {}
        try {
          sdkProjectSettings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
        } catch { /* 文件不存在或解析失败 */ }
        let needsWrite = false
        if (sdkProjectSettings.plansDirectory !== '.context') {
          sdkProjectSettings.plansDirectory = '.context'
          needsWrite = true
        }
        if (sdkProjectSettings.skipWebFetchPreflight !== true) {
          sdkProjectSettings.skipWebFetchPreflight = true
          needsWrite = true
        }
        const autoMemoryDirectory = workspaceSlug ? getWorkspaceAutoMemoryDir(workspaceSlug) : undefined
        if (sdkProjectSettings.autoMemoryDirectory !== autoMemoryDirectory) {
          sdkProjectSettings.autoMemoryDirectory = autoMemoryDirectory
          needsWrite = true
        }
        if (needsWrite) {
          writeFileSync(settingsPath, JSON.stringify(sdkProjectSettings, null, 2))
          console.log(`[Agent 编排] 已设置 SDK settings (plansDirectory, skipWebFetchPreflight, autoMemoryDirectory, autoCompact)`)
        }
      }

      // 9.6 直接信任已保存的 sdkSessionId，跳过 listSessions 预验证
      // 原因：listSessions({ dir }) 基于 cwd 路径哈希查找，但 session 级别的 cwd
      // （如 ~/.proma/agent-workspaces/workspace-xxx/sessionId）与 SDK 内部存储的路径哈希可能不匹配，
      // 导致 listSessions 始终返回 0 个会话，误杀有效的 resume。
      // SDK 本身会优雅处理无效的 resume ID（回退为新会话），无需预验证。
      if (existingSdkSessionId) {
        console.log(`[Agent 编排] 将直接使用已保存的 sdkSessionId 进行 resume: ${existingSdkSessionId}`)
      }

      // 10. 构建 MCP 服务器配置 + 自定义工具（生图工具仅 Chat 模式可用）
      const mcpServers = this.buildMcpServers(workspaceSlug)
      await injectAutomationMcpServer(sdk, mcpServers, {
        sessionId,
        channelId,
        modelId,
        workspaceId,
        triggeredBy: input.triggeredBy as 'user' | 'automation' | undefined,
      })
      await injectKbMcpServer(sdk, mcpServers, {
        sessionId,
        workspaceId,
      })
      await injectAgentCollaborationMcpServer(sdk, mcpServers, {
        sessionId,
        channelId,
        modelId,
        workspaceId,
        permissionMode: input.permissionModeOverride,
        triggeredBy: input.triggeredBy,
      })
      await injectTaskGraphMcpServer(sdk, mcpServers, { sessionId })

      // 合并外部注入的自定义 MCP 服务器（如飞书群聊工具）
      if (customMcpServers) {
        Object.assign(mcpServers, customMcpServers)
        console.log(`[Agent 编排] 已合并 ${Object.keys(customMcpServers).length} 个自定义 MCP 服务器`)
      }

      // 11. 构建动态上下文和最终 prompt
      const dynamicCtx = buildDynamicContext({
        workspaceName: workspace?.name,
        workspaceSlug,
        agentCwd,
      })

      // 11.5 注入 mention 引用指令（Skill/MCP/会话）— 仅影响 prompt，不影响持久化
      let enrichedMessage = userMessage
      const referencedSessionsBlock = buildReferencedSessionsPrompt(sessionId, mentionedSessionIds, workspaceId)
      if (referencedSessionsBlock) {
        enrichedMessage = `${referencedSessionsBlock}\n\n${enrichedMessage}`
        console.log(`[Agent 编排] 注入 referenced_sessions: ${mentionedSessionIds?.length ?? 0} sessions`)
      }
      if (mentionedSkills?.length || mentionedMcpServers?.length) {
        const toolLines: string[] = ['用户在消息中明确引用了以下工具，请在本次回复中主动调用：']
        for (const slug of mentionedSkills ?? []) {
          const qualifiedName = workspaceSlug
            ? `profer-workspace-${workspaceSlug}:${slug}`
            : slug
          toolLines.push(`- Skill: ${qualifiedName}（请立即调用此 Skill）`)
        }
        for (const name of mentionedMcpServers ?? []) {
          toolLines.push(`- MCP 服务器: ${name}（请使用此 MCP 服务器的工具来完成任务）`)
        }
        enrichedMessage = `<mentioned_tools>\n${toolLines.join('\n')}\n</mentioned_tools>\n\n${userMessage}`
        console.log(`[Agent 编排] 注入 mentioned_tools: ${mentionedSkills?.length ?? 0} skills, ${mentionedMcpServers?.length ?? 0} MCP`)
      }

      const knowledgePrompt = buildAgentKnowledgePrompt(sessionMeta?.knowledgeReferences || [])
      if (knowledgePrompt) console.log(`[Agent 编排] 已注入受控资料读取指令: ${sessionMeta?.knowledgeReferences?.length ?? 0} 份`)
      const contextualMessage = `${dynamicCtx}${knowledgePrompt ? `\n\n${knowledgePrompt}` : ''}\n\n${enrichedMessage}`

      const isCompactCommand = userMessage.trim() === '/compact'
      const finalPrompt = isCompactCommand
        ? '/compact'
        : existingSdkSessionId
          ? contextualMessage
          : buildContextPrompt(sessionId, contextualMessage, { agentCwd })

      if (existingSdkSessionId) {
        console.log(`[Agent 编排] 使用 resume 模式，SDK session ID: ${existingSdkSessionId}`)
      } else if (finalPrompt !== contextualMessage) {
        console.log(`[Agent 编排] 无 resume，已回填历史上下文（最近 ${MAX_CONTEXT_MESSAGES} 条消息）`)
      }

      // 12. 读取应用设置并确定权限模式
      // 权限模式只属于当前 session；新会话默认完全自动模式。
      const appSettings = getSettings()
      const initialPermissionMode: ProferPermissionMode = permissionModeOverride
        ?? PROFER_DEFAULT_PERMISSION_MODE
      // 注册到 Map，支持运行中动态切换
      this.sessionPermissionModes.set(sessionId, initialPermissionMode)
      console.log(`[Agent 编排] 权限模式: ${initialPermissionMode}${permissionModeOverride ? '（外部覆盖）' : ''}`)

      const emitPlanModeChanged = (active: boolean, source: 'initial' | 'tool' | 'permission'): void => {
        this.eventBus.emit(sessionId, {
          kind: 'profer_event',
          event: { type: 'plan_mode_changed', sessionId, active, source },
        })
      }

      // 当初始模式为 plan 时，通知渲染进程展示计划模式 UI（如「Agent 正在规划」横幅）
      if (initialPermissionMode === 'plan') {
        this.eventBus.emit(sessionId, { kind: 'profer_event', event: { type: 'enter_plan_mode', sessionId } })
        emitPlanModeChanged(true, 'initial')
      }

      /** 读取当前会话的实时权限模式（支持运行中切换） */
      const getPermissionMode = (): ProferPermissionMode =>
        this.sessionPermissionModes.get(sessionId) ?? initialPermissionMode

      // ExitPlanMode 拦截器：plan 模式下走 UI 审批流程
      const handleExitPlanMode = (toolInput: Record<string, unknown>, signal: AbortSignal): Promise<ExitPlanPermissionResult> => {
        return exitPlanService.handleExitPlanMode(
          sessionId,
          toolInput,
          signal,
          (request: ExitPlanModeRequest) => {
            this.eventBus.emit(sessionId, { kind: 'profer_event', event: { type: 'exit_plan_mode_request', request } })
          },
        )
      }

      // 始终创建 auto 权限回调（运行中可能切换到 auto）
      const autoCanUseTool = permissionService.createCanUseTool(
        sessionId,
        (request: PermissionRequest) => {
          this.eventBus.emit(sessionId, { kind: 'profer_event', event: { type: 'permission_request', request } })
        },
        (sid, toolInput, signal, sendAskUser) => askUserService.handleAskUserQuestion(sid, toolInput, signal, sendAskUser),
        (request: AskUserRequest) => {
          this.eventBus.emit(sessionId, { kind: 'profer_event', event: { type: 'ask_user_request', request } })
        },
      )

      /**
       * 判断 Bash 命令是否是只读的（计划模式下安全可执行）
       * 检测写操作特征：文件重定向、破坏性命令、包管理写操作、git 写操作等
       */
      const isBashCommandReadOnly = (command: string): boolean => {
        // 输出重定向：匹配未被数字或 & 前置的 > 符号（排除 2>/dev/null、&> 等 fd 重定向）
        if (/(?<![0-9&])>/.test(command)) return false
        // 破坏性文件操作
        if (/\b(rm|rmdir)\s/.test(command)) return false
        if (/\bsed\s+[^|&;]*-i/.test(command)) return false  // sed -i 原地编辑
        if (/\b(chmod|chown|chattr|truncate)\s/.test(command)) return false
        if (/\b(mv|cp)\s/.test(command)) return false
        if (/\b(mkdir|touch|mktemp)\s/.test(command)) return false
        // 包管理器写操作
        if (/\b(npm|pnpm|yarn|bun)\s+(install|i\b|add|remove|uninstall|update|upgrade|link|unlink)\b/.test(command)) return false
        if (/\bpip[23]?\s+(install|uninstall|upgrade)\b/.test(command)) return false
        if (/\b(apt|apt-get|brew|yum|dnf)\s+(install|remove|purge|uninstall|upgrade)\b/.test(command)) return false
        // Git 写操作
        if (/\bgit\s+(commit|push|checkout\s+-[bB]|branch\s+-[mMdD]|merge\b|rebase\b|reset\b|stash\s+(drop|pop)\b|add\b|apply\b|cherry-pick\b)/.test(command)) return false
        // 进程控制
        if (/\b(kill|killall|pkill)\s/.test(command)) return false
        // 脚本执行（具有潜在副作用，如 node script.js / python main.py）
        if (/\b(node|python[23]?|ruby|perl|php)\s+[^-]/.test(command)) return false
        return true
      }

      // Plan 模式下允许的只读工具（不包含 Write/Edit/Bash 等写操作）
      const PLAN_MODE_ALLOWED_TOOLS = new Set([
        'Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch',
        'Agent', 'TodoRead', 'TodoWrite', 'TaskOutput',
        'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet',
        'ListMcpResourcesTool', 'ReadMcpResourceTool',
      ])
      const DEFERRED_OR_PROACTIVE_TOOLS = new Set([
        'REPL', 'Workflow', 'ScheduleWakeup', 'Monitor', 'PushNotification',
        'CronCreate', 'CronDelete', 'RemoteTrigger',
      ])

      /** Plan 模式是否已被 Agent 进入（初始 plan 模式时天然为 true，其他模式需 EnterPlanMode 触发） */
      let planModeEntered = initialPermissionMode === 'plan'

      const syncPlanModeFromToolUse = (toolName: string): void => {
        if (toolName === 'EnterPlanMode') {
          planModeEntered = true
          emitPlanModeChanged(true, 'tool')
          return
        }
        if (toolName === 'ExitPlanMode' && getPermissionMode() === 'bypassPermissions') {
          planModeEntered = false
          emitPlanModeChanged(false, 'tool')
          return
        }
        // auto/plan 下 ExitPlanMode 只是发起退出计划的审批请求。
        // 真正退出由用户审批结果触发，不能在工具开始时提前清掉计划态。
      }

      // 动态 canUseTool：每次调用读取当前权限模式，支持运行中切换
      const canUseTool = async (toolName: string, input: Record<string, unknown>, options: CanUseToolOptions): Promise<PermissionResult> => {
        const currentMode = getPermissionMode()

        // ── 参数校验守卫（所有模式、所有工具，优先于权限检查） ──
        const validationFailure = validateToolInput(toolName, input)
        if (validationFailure) {
          console.warn(`[Agent 工具验证] 参数缺失: tool=${toolName}, mode=${currentMode}`)
          return validationFailure
        }

        // ── Write 大文件 token 截断防护 ──
        if (toolName === 'Write' && typeof input.content === 'string') {
          const estimatedTokens = estimateTokenCount(input.content)
          if (estimatedTokens > WRITE_CONTENT_TOKEN_THRESHOLD) {
            console.warn(
              `[Agent 工具验证] Write 内容过大: tokens≈${estimatedTokens}, chars=${input.content.length}, file=${String(input.file_path)}`,
            )
            return {
              behavior: 'deny' as const,
              message:
                `The content for Write tool (~${estimatedTokens} estimated tokens, ${input.content.length} chars) is too large and may be truncated. ` +
                `Please split the write into smaller sequential steps: write the first portion of the file now, then use Edit tool to append remaining sections incrementally.`,
            }
          }
        }

        // ── EnterPlanMode / ExitPlanMode 处理 ──

        // 完全自动模式：计划进入和退出都透明化，保持 bypassPermissions 的无人值守语义。
        if (currentMode === 'bypassPermissions' && (toolName === 'EnterPlanMode' || toolName === 'ExitPlanMode')) {
          const active = toolName === 'EnterPlanMode'
          planModeEntered = active
          emitPlanModeChanged(active, 'tool')
          return { behavior: 'allow' as const, updatedInput: input }
        }

        // ExitPlanMode：auto/plan 模式下必须让用户确认计划。
        if (toolName === 'ExitPlanMode') {
          console.log(`[canUseTool] ExitPlanMode: signal.aborted=${options.signal.aborted}, planModeEntered=${planModeEntered}, mode=${currentMode}`)
          const result = await handleExitPlanMode(input, options.signal)
          if (result.behavior === 'allow' && 'targetMode' in result && result.targetMode) {
            // 更新 Map，后续 canUseTool 调用使用新模式
            this.sessionPermissionModes.set(sessionId, result.targetMode)
            planModeEntered = false
            emitPlanModeChanged(false, 'permission')
            // 同步通知 SDK 侧切换权限模式
            if (this.adapter.setPermissionMode) {
              this.adapter.setPermissionMode(sessionId, sdkPermissionModeForProferMode(result.targetMode)).catch((err: unknown) => {
                console.warn(`[Agent 编排] SDK 权限模式切换失败:`, err)
              })
            }
          }
          return result
        }

        // EnterPlanMode：标记进入状态，通知渲染进程
        if (toolName === 'EnterPlanMode') {
          planModeEntered = true
          emitPlanModeChanged(true, 'tool')
          this.eventBus.emit(sessionId, { kind: 'profer_event', event: { type: 'enter_plan_mode', sessionId } })
          return { behavior: 'allow' as const, updatedInput: input }
        }

        // AskUserQuestion：始终走交互式问答流程，不受权限模式影响
        if (toolName === 'AskUserQuestion') {
          return askUserService.handleAskUserQuestion(
            sessionId, input, options.signal,
            (request: AskUserRequest) => {
              this.eventBus.emit(sessionId, { kind: 'profer_event', event: { type: 'ask_user_request', request } })
            },
          )
        }

        // ── 普通工具的权限分派 ──

        switch (currentMode) {
          case 'bypassPermissions':
            return { behavior: 'allow' as const, updatedInput: input }

          case 'plan': {
            // Plan 模式：只允许只读工具；Write/Edit 仅能写入当前会话计划目录。
            if (PLAN_MODE_ALLOWED_TOOLS.has(toolName)) {
              return { behavior: 'allow' as const, updatedInput: input }
            }
            if (toolName === 'Write' || toolName === 'Edit') {
              const filePath = typeof input.file_path === 'string' ? input.file_path : ''
              if (isPlanModeMarkdownPath(agentCwd, filePath)) return { behavior: 'allow' as const, updatedInput: input }
              return { behavior: 'deny' as const, message: '计划模式下仅允许写入当前会话 .context/plan/ 目录内的 Markdown 计划文件' }
            }
            // Bash 工具：只读命令（find、grep、cat 等）允许执行，写操作拒绝
            if (toolName === 'Bash') {
              const command = typeof input.command === 'string' ? input.command : ''
              if (isBashCommandReadOnly(command)) {
                return { behavior: 'allow' as const, updatedInput: input }
              }
              return { behavior: 'deny' as const, message: '计划模式下不允许执行写操作，请在计划审批通过后再执行' }
            }
            // MCP 默认拒绝：名称无法可靠表达只读性，避免自动化、协作和外部服务产生副作用。
            if (isPlanModeMcpTool(toolName)) {
              return { behavior: 'deny' as const, message: '计划模式下不允许调用 MCP 工具；请在计划审批通过后执行可能具有副作用的外部操作' }
            }
            if (DEFERRED_OR_PROACTIVE_TOOLS.has(toolName)) {
              return { behavior: 'deny' as const, message: '计划模式下不允许启动后台、定时、通知或脚本执行能力，请在计划审批通过后再执行' }
            }
            // 其余工具拒绝
            return { behavior: 'deny' as const, message: '计划模式下不允许执行写操作，请在计划审批通过后再执行' }
          }

          case 'auto':
            return autoCanUseTool(toolName, input, options)

          default:
            return { behavior: 'allow' as const, updatedInput: input }
        }
      }

      // 13. 构建 Adapter 查询选项
      // 检测用户选用的模型是否为 Claude 系列，决定 SubAgent 是否使用独立模型分层
      const claudeAvailable = (modelId || DEFAULT_MODEL_ID).toLowerCase().includes('claude')
      const maxTurns = appSettings.agentMaxTurns && appSettings.agentMaxTurns > 0
        ? appSettings.agentMaxTurns
        : undefined
      const queryOptions: AgentQueryInput & Record<string, unknown> = {
        sessionId,
        prompt: finalPrompt,
        model: resolveAgentSdkModelId(modelId || DEFAULT_MODEL_ID),
        cwd: agentCwd,
        sdkCliPath: cliPath,
        env: sdkEnv,
        ...(maxTurns != null && { maxTurns }),
        sdkPermissionMode: sdkPermissionModeForProferMode(initialPermissionMode),
        // permissionMode 负责表达 auto/plan/bypassPermissions。
        // 当提供 canUseTool 回调时这里必须为 false，否则 CLI 同时收到
        // --allow-dangerously-skip-permissions 和 --permission-prompt-tool stdio
        // 两个矛盾的指令，导致 ExitPlanMode/AskUserQuestion 等交互式工具失败。
        // bypassPermissions 下 SDK 可能在 canUseTool 前直接放行工具，因此计划态还会
        // 从实际 tool_use 流里同步，避免 UI 停留在计划阶段。
        allowDangerouslySkipPermissions: !canUseTool,
        canUseTool,
        ...(sdkPermissionModeForProferMode(initialPermissionMode) === 'auto' && { allowedTools: [...SAFE_TOOLS] }),
        // claude_code preset 提供基础环境信息（platform/shell/OS/git/model/知识截止日期等）
        // buildSystemPrompt 追加 Profer 特有指令（角色定义、SubAgent 策略、工作区信息等）
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          append: buildSystemPrompt({
            workspaceName: workspace?.name,
            workspaceSlug,
            sessionId,
            permissionMode: initialPermissionMode,
            claudeAvailable,
            deepSeekSubagentModel: modelRouting.subagentModel,
          }) + (automationContext ? `\n\n## 定时任务执行上下文\n\n${automationContext}` : ''),
        },
        resumeSessionId: existingSdkSessionId,
        // 回退后 resume：从指定消息处继续（SDK 在同一 JSONL 内创建分支）
        ...(rewindResumeAt && { resumeSessionAt: rewindResumeAt }),
        ...(Object.keys(mcpServers).length > 0 && { mcpServers }),
        ...(workspaceSlug && { plugins: [{ type: 'local' as const, path: getAgentWorkspacePath(workspaceSlug) }] }),
        // 合并附加目录：用户当次输入 + 会话级 + 工作区级（详见 collectAttachedDirectories）
        ...(() => {
          const allDirs = collectAttachedDirectories({
            extraDirs: additionalDirectories,
            sessionMeta,
            workspaceSlug,
          })
          return allDirs.length > 0 ? { additionalDirectories: allDirs } : {}
        })(),
        // 启用文件检查点，支持 rewindFiles 回退
        enableFileCheckpointing: true,
        // SDK 0.2.52+ 新增选项（从 settings 读取）
        ...(appSettings.agentThinking && { thinking: appSettings.agentThinking }),
        effort: appSettings.agentEffort ?? 'high',
        ...(appSettings.agentMaxBudgetUsd != null && appSettings.agentMaxBudgetUsd > 0 && {
          maxBudgetUsd: appSettings.agentMaxBudgetUsd,
        }),
        // 1M context window: 支持的模型自动启用 beta（Claude: Sonnet 4+ / Opus 4.6+ / 4.7 / 4.8、DeepSeek V4 系列）
        // 未启用时 SDK 默认 200K 并在约 150K 触发压缩；启用后上限提升至 1M
        ...(supports1MContext(modelId || DEFAULT_MODEL_ID) && {
          betas: ['context-1m-2025-08-07'] as SdkBeta[],
        }),
        onStderr: (data: string) => {
          stderrChunks.push(data)
          console.error(`[Agent SDK stderr] ${data}`)
        },
        onSessionId: (sdkSessionId: string) => {
          // 仅在 session_id 真正变化时才持久化。SDK v2 几乎每条消息都会回调 onSessionId，
          // 旧逻辑误用「初始快照后永不更新」的 existingSdkSessionId 作比较（回调里更新的是
          // capturedSdkSessionId），导致新会话每条消息都全量读写会话索引（readIndex + 原子写 +
          // 备份），再叠加一次读回验证。历史会话多 + 多会话并发时引发同步 fsync 风暴，周期性
          // 卡死主进程事件循环。capturedSdkSessionId 已初始化为 existingSdkSessionId，并在
          // session-not-found 重试时与其同步重置，比较它即可正确判定「真正变化」。
          const isNewSessionId = sdkSessionId !== capturedSdkSessionId
          capturedSdkSessionId = sdkSessionId
          if (isNewSessionId) {
            try {
              updateAgentSessionMeta(sessionId, { sdkSessionId })
              console.log(`[Agent 编排] 已保存 SDK session_id: ${sdkSessionId}`)
            } catch (err) {
              console.error(`[Agent 编排] 保存 SDK session_id 失败:`, err)
            }
          }

          // SDK 初始化完成后立即触发标题生成，使多会话并发时用户能快速区分
          if (!titleGenerationStarted) {
            titleGenerationStarted = true
            this.autoGenerateTitle(sessionId, userMessage, channelId, resolvedModel, callbacks)
              .catch((err) => console.error('[Agent 编排] 标题生成未捕获异常:', err))
          }
        },
        onModelResolved: (model: string) => {
          resolvedModel = model
          console.log(`[Agent 编排] SDK 确认模型: ${resolvedModel}`)
          // 通知渲染进程更新流式状态中的模型信息
          this.eventBus.emit(sessionId, { kind: 'profer_event', event: { type: 'model_resolved', model } })
        },
        onContextWindow: (cw: number) => {
          console.log(`[Agent 编排] 缓存 contextWindow: ${cw}`)
          // result 消息里的真实 contextWindow 透传到 renderer，
          // 覆盖流式过程中按模型名推断的 fallback 值（智谱等端点会把 [1m] 等后缀剥掉，导致 fallback 不准）
          this.eventBus.emit(sessionId, {
            kind: 'profer_event',
            event: { type: 'context_window', contextWindow: cw },
          })
        },
      }

      console.log(`[Agent 编排] 开始通过 Adapter 遍历事件流...`)

      // 14. 遍历 Adapter 产出的 AgentEvent 流（含自动重试）
      let lastRetryableError: string | undefined
      let retryDelayElapsedMs = 0
      let retryAttemptsScheduled = 0
      let retrySucceeded = false
      let skipNextRetryDelay = false
      let thinkingSignatureRecoveryAttempted = false
      let invisibleRecoveryAttempts = 0
      /** 前 N 次自动重试静默执行，不向 UI 发送事件，减少网络瞬断时的界面噪音 */
      const RETRY_VISIBILITY_THRESHOLD = 5
      const canAutoRetry = (attempt: number): boolean =>
        attempt <= MAX_AUTO_RETRIES && retryDelayElapsedMs < MAX_AUTO_RETRY_WAIT_MS

      /** 捕获到的 SDK session ID（用于 resume / recovery） */
      let capturedSdkSessionId = existingSdkSessionId
      const canTryThinkingSignatureRecovery = (attempt: number): boolean =>
        !thinkingSignatureRecoveryAttempted &&
        canAutoRetry(attempt) &&
        !!(existingSdkSessionId || capturedSdkSessionId || queryOptions.resumeSessionId)

      const queryStartedAt = Date.now()

      for (let attempt = 1; attempt <= MAX_AUTO_RETRIES + 1; attempt++) {
        // 非首次尝试：等待 + 发送重试事件到 UI
        if (attempt > 1) {
          if (skipNextRetryDelay) {
            skipNextRetryDelay = false
            console.log(`[Agent 编排] 已切换到上下文回填模式，立即重试`)
          } else {
            const retryAttempt = Math.max(1, attempt - 1 - invisibleRecoveryAttempts)
            const delayMs = getRetryDelayMs(retryAttempt, retryDelayElapsedMs)
            if (delayMs <= 0) {
              console.log(`[Agent 编排] 自动重试等待预算已耗尽 (${MAX_AUTO_RETRY_WAIT_MS}ms)，停止重试`)
              break
            }
            retryDelayElapsedMs += delayMs
            retryAttemptsScheduled = retryAttempt
            const delaySec = delayMs / 1000
            const attemptData: RetryAttempt = {
              attempt: retryAttempt,
              timestamp: Date.now(),
              reason: lastRetryableError ?? '未知错误',
              errorMessage: lastRetryableError ?? '',
              delaySeconds: delaySec,
            }

            // 前 RETRY_VISIBILITY_THRESHOLD 次重试静默执行，避免网络瞬断时 UI 频繁弹黄条
            if (retryAttempt > RETRY_VISIBILITY_THRESHOLD) {
              this.eventBus.emit(sessionId, {
                kind: 'profer_event',
                event: { type: 'retry', status: 'starting', attempt: retryAttempt, maxAttempts: MAX_AUTO_RETRIES, delaySeconds: delaySec, reason: lastRetryableError ?? '未知错误' },
              })
              this.eventBus.emit(sessionId, {
                kind: 'profer_event',
                event: { type: 'retry', status: 'attempt', attemptData },
              })
            }

            console.log(`[Agent 编排] 第 ${retryAttempt} 次重试${retryAttempt <= RETRY_VISIBILITY_THRESHOLD ? '(静默)' : ''}，等待 ${delaySec}s...`)
            await new Promise((r) => setTimeout(r, delayMs))

            // 等待期间如果会话被中止，退出
            if (!this.activeSessions.has(sessionId)) {
              const wasStoppedByUser = this.consumeStoppedByUser(sessionId)
              this.persistSDKMessages(sessionId, accumulatedMessages, Date.now() - queryStartedAt)
              try { updateAgentSessionMeta(sessionId, { stoppedByUser: wasStoppedByUser }) } catch { /* 会话可能已删除 */ }
              completeRun(getAgentSessionMessages(sessionId), { stoppedByUser: wasStoppedByUser, startedAt: streamStartedAt })
              return
            }
          }
        }

        let shouldRetryFromError = false

        try {
          // 获取异步迭代器（手动 .next() 以支持 Promise.race 中断）
          const queryIterable = this.adapter.query(queryOptions)
          const queryIterator = queryIterable[Symbol.asyncIterator]()

          // 手动事件循环：Promise.race（SDKMessage vs result drain timeout）
          let pendingNext: Promise<IteratorResult<SDKMessage>> | null = null
          // 捕获 result.subtype 以传递给前端（用于区分 success/error_max_turns/error_max_budget_usd）
          let capturedResultSubtype: string | undefined
          // 捕获 result.errors[] 错误详情：SDK 在 error_during_execution 等场景下会把真实错误原因
          // 放进 errors[]，透传到前端用于展示具体错误（而非泛泛的"任务执行过程中发生错误"）。
          let capturedResultErrors: string[] | undefined
          // result 收到后的安全超时：adapter 层 channel.close() 应让 iterator 自然关闭，
          // 此 timeout 仅作安全网，防止极端情况下 iterator 仍未关闭
          let drainTimeoutPromise: Promise<'drain_timeout'> | null = null
          const RESULT_DRAIN_TIMEOUT_MS = 2_000
          // 后台任务等待态：result 走轻量完成后置 true，下一轮真正开始（收到 assistant/user/task 消息）时
          // 置回 false 并发 run_resumed，让 UI 从空闲态恢复运行态。
          let awaitingBackgroundWake = false
          // Native task tools are persisted here, before renderer delivery, so headless
          // runs and renderer reloads cannot lose graph history.
          const taskToolUses = new Map<string, TaskToolInvocation>()
          let currentTaskId: string | null = null
          let lastCompletedTaskId: string | null = null

          while (true) {
            if (!pendingNext) {
              pendingNext = queryIterator.next()
            }

            const racePromises: Array<Promise<{ kind: string; result: IteratorResult<SDKMessage> | null }>> = [
              pendingNext.then((r) => ({ kind: 'event' as const, result: r })),
            ]
            if (drainTimeoutPromise) {
              racePromises.push(drainTimeoutPromise.then(() => ({ kind: 'drain_timeout' as const, result: null })))
            }

            const raceResult = await Promise.race(racePromises)

            if (raceResult.kind === 'drain_timeout') {
              // 安全网：channel.close() 后 SDK 仍未在超时内关闭 iterator，强制退出
              console.warn(`[Agent 编排] drain timeout: SDK iterator 在 result 后 ${RESULT_DRAIN_TIMEOUT_MS}ms 内未关闭，强制退出`)
              pendingNext?.catch(() => {})
              pendingNext = null
              queryIterator.return?.(undefined as never).catch(() => {})
              break
            }

            const iterResult = raceResult.result
            if (!iterResult || iterResult.done) break

            pendingNext = null
            const msg = iterResult.value

            // 后台任务唤醒：轻量完成后处于等待态，收到新一轮的首条实质消息时
            // 发 run_resumed，让 UI 从"空闲可输入"恢复到"运行中"。
            // applyAgentEvent 的流式分支不会重置 running，故必须显式通知。
            if (awaitingBackgroundWake) {
              const sub = msg.type === 'system' ? (msg as { subtype?: string }).subtype : undefined
              if (msg.type === 'assistant' || msg.type === 'user' || sub === 'task_started' || sub === 'task_progress') {
                awaitingBackgroundWake = false
                this.eventBus.emit(sessionId, { kind: 'profer_event', event: { type: 'run_resumed', sessionId } })
              }
            }

            // SDK 权限模式可能在 canUseTool 前直接批准工具（如 bypassPermissions）。
            // 因此计划阶段状态要从实际 tool_use 流里同步，不能只依赖权限回调。
            if (msg.type === 'assistant') {
              const assistantMsg = msg as SDKAssistantMessage
              if (!assistantMsg.isReplay) {
                for (const block of assistantMsg.message.content) {
                  if (block.type === 'tool_use' && 'name' in block && typeof block.name === 'string') {
                    syncPlanModeFromToolUse(block.name)
                  }
                }
              }
            }

            // 收集 tool_use，待对应 user.tool_result 到达后写入原生任务图事件。
            if (msg.type === 'assistant') {
              const assistantMsg = msg as SDKAssistantMessage
              if (!assistantMsg.isReplay) {
                for (const block of assistantMsg.message.content) {
                  if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
                    taskToolUses.set(block.id, {
                      toolUseId: block.id,
                      toolName: block.name,
                      input: typeof block.input === 'object' && block.input !== null
                        ? block.input as Record<string, unknown>
                        : {},
                    })
                  }
                }
              }
            }

            // 主进程是任务图持久化权威：仅原生 Task 工具在此转换。
            // 结构化 MCP handler 已直接 appendGraphEvent，只更新当前任务以关联后续委派。
            if (msg.type === 'user') {
              const content = (msg as { message?: { content?: Array<{ type?: string; tool_use_id?: string; content?: unknown }> } }).message?.content
              for (const block of content ?? []) {
                if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue
                const invocation = taskToolUses.get(block.tool_use_id)
                if (!invocation) continue
                invocation.result = block.content

                if (invocation.toolName === 'TaskCreate' || invocation.toolName === 'TaskUpdate') {
                  const conversion = nativeTaskToolToGraphEvents(invocation, sessionId, Date.now(), {
                    currentTaskId,
                    lastCompletedTaskId,
                  })
                  for (const graphEvent of conversion.events) {
                    appendGraphEvent(sessionId, graphEvent)
                    if (graphEvent.type === 'task_status_changed' && graphEvent.payload.newStatus === 'completed') {
                      lastCompletedTaskId = graphEvent.taskId
                      currentTaskId = null
                    }
                  }
                  if (conversion.nextCurrentTaskId) currentTaskId = conversion.nextCurrentTaskId
                } else {
                  const structuredTaskId = structuredTaskToolCurrentTaskId(invocation)
                  const autoLink = structuredTaskAutoLinkEvent(invocation, Date.now(), {
                    currentTaskId,
                    lastCompletedTaskId,
                  })
                  if (autoLink) appendGraphEvent(sessionId, autoLink)
                  if (invocation.toolName.endsWith('proma_task_update') && invocation.input.status === 'completed' && structuredTaskId) {
                    lastCompletedTaskId = structuredTaskId
                    currentTaskId = null
                  } else if (structuredTaskId) {
                    currentTaskId = structuredTaskId
                  }
                  if (isDelegateAgentTool(invocation.toolName) && currentTaskId) {
                    const delegation = delegationLinkFromResult(block.content)
                    if (delegation) {
                      const timestamp = Date.now()
                      appendGraphEvent(sessionId, {
                        type: 'task_session_linked',
                        taskId: currentTaskId,
                        timestamp,
                        payload: { sessionId: delegation.delegationId, childSessionId: delegation.childSessionId },
                      })
                      for (const graphEvent of delegationToGraphEvents(currentTaskId, delegation, invocation, timestamp)) {
                        appendGraphEvent(sessionId, graphEvent)
                      }
                    }
                  }
                }
                taskToolUses.delete(block.tool_use_id)
              }
            }

            // 检测 assistant 消息中的 SDK 错误
            if (msg.type === 'assistant') {
              const assistantMsg = msg as SDKAssistantMessage
              if (assistantMsg.error) {
                console.error(`[Agent 编排] ═══ SDK assistant 错误 原始数据 ═══`)
                console.error(`[Agent 编排] error.errorType: ${assistantMsg.error.errorType ?? '(空)'}`)
                console.error(`[Agent 编排] error.message: ${assistantMsg.error.message ?? '(空)'}`)
                console.error(`[Agent 编排] message.content 文本块:`,
                  (assistantMsg.message?.content ?? [])
                    .filter((b: { type: string }) => b.type === 'text')
                    .map((b) => (b as { text?: string }).text?.slice(0, 500))
                )
                try { console.error(`[Agent 编排] 完整 assistantMsg (JSON keys):`, Object.keys(assistantMsg)) } catch {}
                try { console.error(`[Agent 编排] assistantMsg JSON (截断):`, JSON.stringify(assistantMsg).slice(0, 2000)) } catch {}
                console.error(`[Agent 编排] ═══ SDK assistant 错误 原始数据 结束 ═══`)
                const { detailedMessage, originalError } = this.adapter.errorHelpers.extractErrorDetails(assistantMsg as unknown as Parameters<typeof this.adapter.errorHelpers.extractErrorDetails>[0])
                // SDK 的 error 字段可能是字符串（错误码）或对象 {message, errorType}
                const rawError = assistantMsg.error as unknown
                let errorCode = (typeof rawError === 'object' && rawError !== null
                  ? (rawError as Record<string, unknown>).errorType as string
                  : undefined)
                  ?? (typeof rawError === 'string' ? rawError : undefined)
                  ?? 'unknown_error'
                console.error(`[Agent 编排] rawError 类型=${typeof rawError}, errorCode=${errorCode}`)
                if (this.adapter.errorHelpers.isPromptTooLongError(detailedMessage, originalError)) {
                  errorCode = 'prompt_too_long'
                }
                const typedError = this.adapter.errorHelpers.mapSDKErrorToTypedError(errorCode, this.adapter.errorHelpers.friendlyErrorMessage(detailedMessage), originalError)
                console.error(`[Agent 编排] mapSDKErrorToTypedError 结果:`)
                console.error(`  code: ${typedError.code}`)
                console.error(`  title: ${typedError.title || '(空)'}`)
                console.error(`  message: ${typedError.message || '(空)'}`)
                console.error(`  canRetry: ${typedError.canRetry}`)
                console.error(`  originalError: ${typedError.originalError?.slice(0, 300) || '(空)'}`)

                // Session 不存在错误：清除 sdkSessionId，切换到上下文回填模式重试
                if (isSessionNotFoundError(detailedMessage, originalError) && existingSdkSessionId && canAutoRetry(attempt)) {
                  existingSdkSessionId = undefined
                  capturedSdkSessionId = undefined
                  lastRetryableError = this.prepareSessionNotFoundRecovery(sessionId, queryOptions, contextualMessage, agentCwd, accumulatedMessages, queryStartedAt)
                  shouldRetryFromError = true
                  break
                }

                // Thinking signature 不兼容：通常由跨模型 resume 触发。
                // 先自动清除 SDK resume 关系，改用 Profer 已持久化上下文重跑一次；再失败才展示用户提示。
                if (
                  typedError.code === THINKING_SIGNATURE_ERROR_CODE &&
                  canTryThinkingSignatureRecovery(attempt)
                ) {
                  thinkingSignatureRecoveryAttempted = true
                  invisibleRecoveryAttempts += 1
                  existingSdkSessionId = undefined
                  capturedSdkSessionId = undefined
                  skipNextRetryDelay = true
                  lastRetryableError = this.prepareResumeFallbackRecovery(
                    sessionId,
                    queryOptions,
                    contextualMessage,
                    agentCwd,
                    accumulatedMessages,
                    queryStartedAt,
                    '检测到 thinking signature 不兼容，清除 sdkSessionId 并切换到上下文回填模式',
                    '思考签名不兼容，切换到上下文回填模式',
                  )
                  stderrChunks.length = 0
                  shouldRetryFromError = true
                  break
                }

                // 判断是否可自动重试
                if (isAutoRetryableTypedError(typedError) && canAutoRetry(attempt)) {
                  lastRetryableError = typedError.title
                    ? `${typedError.title}: ${typedError.message}`
                    : typedError.message
                  console.log(`[Agent 编排] 可重试错误 (assistant error): ${typedError.code} - ${lastRetryableError}`)
                  this.persistSDKMessages(sessionId, accumulatedMessages, Date.now() - queryStartedAt)
                  accumulatedMessages.length = 0
                  // 与 catch 路径（isAutoRetryableCatchError）和思考签名回填路径保持一致：
                  // 重试前清空已累积的 stderr，避免 25 次重试上限内字符串无限增长
                  stderrChunks.length = 0
                  shouldRetryFromError = true
                  break
                }

                // 不可重试 → 终止
                this.persistSDKMessages(sessionId, accumulatedMessages, Date.now() - queryStartedAt)

                const errorContent = typedError.title
                    ? `${typedError.title}: ${typedError.message}`
                    : typedError.message
                const errorSDKMsg: SDKMessage = {
                  type: 'assistant',
                  message: {
                    content: [{ type: 'text', text: errorContent }],
                  },
                  parent_tool_use_id: null,
                  error: { message: typedError.message, errorType: typedError.code },
                  _createdAt: Date.now(),
                  _errorCode: typedError.code,
                  _errorTitle: typedError.title,
                  _errorDetails: typedError.details,
                  _errorCanRetry: typedError.canRetry,
                  _errorActions: typedError.actions,
                } as unknown as SDKMessage
                appendSDKMessages(sessionId, [errorSDKMsg])
                console.log(`[Agent 编排] 已保存 TypedError 消息: ${typedError.code} - ${typedError.title}`)

                // 如果之前有可见重试记录，发送 retry_failed
                if (retryAttemptsScheduled > RETRY_VISIBILITY_THRESHOLD && lastRetryableError) {
                  this.eventBus.emit(sessionId, {
                    kind: 'profer_event',
                    event: { type: 'retry', status: 'failed', attemptData: { attempt: retryAttemptsScheduled, timestamp: Date.now(), reason: lastRetryableError, errorMessage: typedError.message, delaySeconds: 0 } },
                  })
                }

                // 透传归一化后的错误消息到前端，避免 SDK 原始 API Error 直接暴露给用户。
                this.eventBus.emit(sessionId, { kind: 'sdk_message', message: errorSDKMsg })
                try { updateAgentSessionMeta(sessionId, {}) } catch { /* 忽略 */ }
                completeRun(getAgentSessionMessages(sessionId), { startedAt: streamStartedAt })
                return
              }
            }

            // 累积 assistant 和 user 消息用于持久化
            // - 跳过 replay 消息，避免 resume 时重复写入
            // - 对 user 消息，仅累积含 tool_result 的（初始用户消息已在步骤 5 手动持久化）
            // - 对 system 消息，仅累积 compact_boundary（上下文压缩分界线需要持久化显示）
            if (msg.type === 'assistant' || msg.type === 'user' || msg.type === 'result') {
              const msgRecord = msg as Record<string, unknown>
              if (!msgRecord.isReplay) {
                if (msg.type === 'user') {
                  // 仅累积包含 tool_result 的 user 消息（跳过 SDK 重新发出的初始用户消息）
                  const content = (msg as { message?: { content?: Array<{ type: string }> } }).message?.content
                  const hasToolResult = Array.isArray(content) && content.some((b) => b.type === 'tool_result')
                  if (hasToolResult) {
                    accumulatedMessages.push(msg)
                  }
                } else {
                  // 为 assistant 消息注入渠道 modelId，确保持久化后能正确匹配模型显示名
                  if (msg.type === 'assistant' && modelId) {
                    (msg as Record<string, unknown>)._channelModelId = modelId
                  }
                  accumulatedMessages.push(msg)
                }
              }
            } else if (msg.type === 'system') {
              const sysMsg = msg as import('@profer/shared').SDKSystemMessage
              if (sysMsg.subtype === 'compact_boundary' || sysMsg.subtype === 'permission_denied') {
                accumulatedMessages.push(msg)
              }
            }

            // Turn 结束时：持久化累积消息
            if (msg.type === 'result') {
              capturedResultSubtype = (msg as { subtype?: string }).subtype
              // SDK 的 SDKResultError 在 errors[] 中携带真实错误原因（error_during_execution 等场景），
              // 捕获后透传到前端展示具体错误。
              const rawResultErrors = (msg as { errors?: unknown }).errors
              capturedResultErrors = Array.isArray(rawResultErrors)
                ? rawResultErrors.filter((e): e is string => typeof e === 'string' && e.trim().length > 0)
                : undefined
              this.persistSDKMessages(sessionId, accumulatedMessages, Date.now() - queryStartedAt)
              accumulatedMessages.length = 0
              // 软中断 / 延迟工具 / hook 暂停等场景下，adapter 保留 channel
              // 等待队列或后续消息继续 drive Query，此处跳过 drain 超时以免误关闭事件循环。
              // 完整白名单见 adapters/claude-agent-adapter.ts 的 CONTINUABLE_TERMINAL_REASONS。
              const resultTerminalReason = (msg as { terminal_reason?: string }).terminal_reason
              // adapter 在"本轮结束但仍有后台任务/定时任务在飞行"时打的注解：
              // 走轻量完成（UI 空闲可输入、host 保留会话），等待 task_notification 自动续轮。
              const keptOpenForTasks = (msg as Record<string, unknown>)._keepChannelOpenForTasks === true
              const keepChannelOpen = this.adapter.errorHelpers.shouldKeepChannelOpen(resultTerminalReason) || keptOpenForTasks
              // 分类打点：跟踪线上哪种 terminal_reason 最常见，配合 deferred_tool_use 回填决策
              const hasDeferredTool = (msg as { deferred_tool_use?: unknown }).deferred_tool_use != null
              console.log(
                `[Agent 编排] result 到达: sessionId=${sessionId}, subtype=${capturedResultSubtype ?? 'unknown'}, ` +
                `terminal_reason=${resultTerminalReason ?? 'undefined'}, keepChannelOpen=${keepChannelOpen}` +
                (keptOpenForTasks ? ', keptOpenForTasks=true' : '') +
                (hasDeferredTool ? ', hasDeferredTool=true' : ''),
              )
              if (keptOpenForTasks) {
                // 轻量完成：UI 置空闲可输入，但 host 保持运行态（不 releaseActiveRun、不 break、不启动 drain 超时），
                // while 循环继续 park 在 queryIterator.next()，等待后台任务完成时 SDK 自动 yield 的新一轮消息。
                awaitingBackgroundWake = true
                idleComplete(getAgentSessionMessages(sessionId), { startedAt: streamStartedAt, resultSubtype: capturedResultSubtype, resultErrors: capturedResultErrors })
              } else if (!keepChannelOpen && !drainTimeoutPromise) {
                // 启动 drain 超时安全网：adapter 层 channel.close() 应让 iterator 自然关闭，
                // 此处仅在极端情况下（如 SDK 版本不兼容）保护事件循环不无限挂起
                drainTimeoutPromise = new Promise((resolve) =>
                  setTimeout(() => resolve('drain_timeout'), RESULT_DRAIN_TIMEOUT_MS),
                )
              }
            }

            // 过滤 SDK 内部生成的 user 消息（如 Skill 展开文本），避免在前端渲染为用户消息
            // 仅允许含 tool_result 的 user 消息通过（这些是工具调用的响应，需要展示）
            // 初始用户消息已通过前端乐观注入显示，无需 SDK 重复推送
            let shouldEmit = true
            if (msg.type === 'user') {
              const content = (msg as { message?: { content?: Array<{ type: string }> } }).message?.content
              const hasToolResult = Array.isArray(content) && content.some((b) => b.type === 'tool_result')
              if (!hasToolResult) {
                shouldEmit = false
              }
            }

            if (!shouldEmit) {
              // 跳过 SDK 内部 user 消息的前端推送
            } else {
              this.eventBus.emit(sessionId, { kind: 'sdk_message', message: msg })
            }
          }

          // 错误 break 触发了 → 继续循环
          if (shouldRetryFromError) {
            continue
          }

          const wasStoppedByUser = this.consumeStoppedByUser(sessionId)

          // 正常完成 — 如果之前有重试，发送 retry_cleared
          if (!wasStoppedByUser && retryAttemptsScheduled > 0) {
            this.eventBus.emit(sessionId, { kind: 'profer_event', event: { type: 'retry', status: 'cleared' } })
            console.log(`[Agent 编排] 重试成功，已在第 ${attempt} 次尝试后恢复`)
          }
          retrySucceeded = true

          // 15. 持久化 assistant 消息
          this.persistSDKMessages(sessionId, accumulatedMessages, Date.now() - queryStartedAt)

          try { updateAgentSessionMeta(sessionId, wasStoppedByUser ? { stoppedByUser: true } : {}) } catch { /* 忽略 */ }

          // Plan 模式：Agent 完成规划后注入"接受计划"建议
          if (initialPermissionMode === 'plan' && planModeEntered && this.activeSessions.has(sessionId)) {
            this.eventBus.emit(sessionId, {
              kind: 'sdk_message',
              message: { type: 'prompt_suggestion', suggestion: '请执行该计划' } as unknown as SDKMessage,
            })
            console.log(`[Agent 编排] Plan 模式：已注入计划确认建议`)
          }

          // 发送完成信号
          completeRun(getAgentSessionMessages(sessionId), { stoppedByUser: wasStoppedByUser, startedAt: streamStartedAt, resultSubtype: capturedResultSubtype, resultErrors: capturedResultErrors })

          break  // 成功完成，退出重试循环

        } catch (error) {
          // 打印 stderr
          const fullStderr = stderrChunks.join('').trim()
          if (fullStderr) {
            console.error(`[Agent 编排] 完整 stderr 输出 (${fullStderr.length} 字符):`)
            console.error(fullStderr)
          } else {
            console.error(`[Agent 编排] stderr 为空`)
          }

          // 用户主动中止
          if (!this.activeSessions.has(sessionId)) {
            const wasStoppedByUser = this.consumeStoppedByUser(sessionId)
            console.log(`[Agent 编排] 会话 ${sessionId} 已被用户中止`)
            this.persistSDKMessages(sessionId, accumulatedMessages, Date.now() - queryStartedAt)
            // 持久化中断状态到会话 meta
            try { updateAgentSessionMeta(sessionId, { stoppedByUser: wasStoppedByUser }) } catch { /* 会话可能已删除 */ }
            completeRun(getAgentSessionMessages(sessionId), { stoppedByUser: wasStoppedByUser, startedAt: streamStartedAt })
            return
          }

          // 从 stderr 提取 API 错误
          const stderrOutput = stderrChunks.join('').trim()
          const apiError = extractApiError(stderrOutput)
          const rawErrorMessage = error instanceof Error ? error.message : ''

          // Session 不存在错误：清除 sdkSessionId，切换到上下文回填模式重试
          if (isSessionNotFoundError(rawErrorMessage, stderrOutput) && existingSdkSessionId && canAutoRetry(attempt)) {
            existingSdkSessionId = undefined
            capturedSdkSessionId = undefined
            lastRetryableError = this.prepareSessionNotFoundRecovery(sessionId, queryOptions, contextualMessage, agentCwd, accumulatedMessages, queryStartedAt)
            stderrChunks.length = 0
            continue  // 进入下一次 retry 循环
          }

          // Thinking signature 不兼容：先自动清除 SDK resume 关系并用上下文回填重跑一次。
          if (
            this.adapter.errorHelpers.isThinkingSignatureError(apiError?.message ?? '', rawErrorMessage, stderrOutput) &&
            canTryThinkingSignatureRecovery(attempt)
          ) {
            thinkingSignatureRecoveryAttempted = true
            invisibleRecoveryAttempts += 1
            existingSdkSessionId = undefined
            capturedSdkSessionId = undefined
            skipNextRetryDelay = true
            lastRetryableError = this.prepareResumeFallbackRecovery(
              sessionId,
              queryOptions,
              contextualMessage,
              agentCwd,
              accumulatedMessages,
              queryStartedAt,
              '检测到 thinking signature 不兼容，清除 sdkSessionId 并切换到上下文回填模式',
              '思考签名不兼容，切换到上下文回填模式',
            )
            stderrChunks.length = 0
            continue  // 进入下一次 retry 循环
          }

          // 判断是否可重试
          if (isAutoRetryableCatchError(apiError, rawErrorMessage, stderrOutput) && canAutoRetry(attempt)) {
            lastRetryableError = apiError
              ? `API Error ${apiError.statusCode}: ${apiError.message}`
              : (error instanceof Error ? error.message : '未知错误')
            console.log(`[Agent 编排] 可重试错误 (catch, attempt ${attempt}/${MAX_AUTO_RETRIES}): ${lastRetryableError}`)
            // 保存部分内容
            this.persistSDKMessages(sessionId, accumulatedMessages, Date.now() - queryStartedAt)
            accumulatedMessages.length = 0
            stderrChunks.length = 0
            continue  // 进入下一次 retry 循环
          }

          // 不可重试 — 走原有终止逻辑
          console.error(`[Agent 编排] ══════════ 不可重试错误 诊断开始 ══════════`)
          console.error(`[Agent 编排] sessionId: ${sessionId}`)
          console.error(`[Agent 编排] attempt: ${attempt}/${MAX_AUTO_RETRIES}`)
          console.error(`[Agent 编排] modelId: ${modelId || '(default)'}`)
          console.error(`[Agent 编排] channelId: ${channelId}`)
          console.error(`[Agent 编排] raw error 详细诊断:\n${serializeErrorDetail(error)}`)
          console.error(`[Agent 编排] error instanceof Error: ${error instanceof Error}`)
          console.error(`[Agent 编排] typeof error: ${typeof error}`)
          if (apiError) {
            console.error(`[Agent 编排] apiError statusCode: ${apiError.statusCode}`)
            console.error(`[Agent 编排] apiError message: ${apiError.message}`)
          } else {
            console.error(`[Agent 编排] apiError: 未提取到 API 错误`)
          }
          console.error(`[Agent 编排] rawErrorMessage: ${rawErrorMessage || '(空)'}`)
          console.error(`[Agent 编排] stderrOutput (${stderrOutput.length} 字符):`)
          if (stderrOutput) console.error(stderrOutput)
          else console.error(`  (空)`)
          console.error(`[Agent 编排] fullStderr (${fullStderr.length} 字符):`)
          if (fullStderr) console.error(fullStderr)
          else console.error(`  (空)`)
          console.error(`[Agent 编排] accumulatedMessages: ${accumulatedMessages.length} 条`)
          const errorMessage = error instanceof Error ? error.message : '未知错误'
          console.error(`[Agent 编排] errorMessage: ${errorMessage || '(空字符串)'}`)

          // 保存已累积的部分内容
          if (accumulatedMessages.length > 0) {
            try {
              this.persistSDKMessages(sessionId, accumulatedMessages, Date.now() - queryStartedAt)
              console.log(`[Agent 编排] 已保存部分执行结果 (${accumulatedMessages.length} 条消息)`)
            } catch (saveError) {
              console.error('[Agent 编排] 保存部分内容失败:', saveError)
            }
          }

          let userFacingError: string
          if (apiError) {
            userFacingError = this.adapter.errorHelpers.friendlyErrorMessage(`API 错误 (${apiError.statusCode}):\n${apiError.message}`)
          } else {
            userFacingError = this.adapter.errorHelpers.friendlyErrorMessage(errorMessage)
          }
          console.error(`[Agent 编排] userFacingError (friendlyErrorMessage 之后):\n  ${userFacingError}`)

          // 保存错误消息到 JSONL
          try {
            // 检测是否为 prompt too long 错误
            const isPromptTooLong = this.adapter.errorHelpers.isPromptTooLongError(
              userFacingError,
              error instanceof Error ? (error.stack ?? error.message) : String(error),
              stderrOutput,
            )
            const isThinkingSignature = this.adapter.errorHelpers.isThinkingSignatureError(
              apiError?.message ?? '',
              userFacingError,
              rawErrorMessage,
              error instanceof Error ? (error.stack ?? error.message) : String(error),
              stderrOutput,
            )
            const errorCode = isPromptTooLong
              ? 'prompt_too_long'
              : isThinkingSignature
                ? THINKING_SIGNATURE_ERROR_CODE
                : 'unknown_error'
            const errorTitle = isPromptTooLong
              ? '上下文过长'
              : isThinkingSignature
                ? THINKING_SIGNATURE_ERROR_TITLE
                : '执行错误'
            const errorContent = isPromptTooLong
              ? '上下文过长：当前对话的上下文已超出模型限制，请压缩上下文或开启新会话'
              : isThinkingSignature
                ? `${THINKING_SIGNATURE_ERROR_TITLE}：${THINKING_SIGNATURE_ERROR_MESSAGE}`
                : userFacingError
            const errorActions = isThinkingSignature
              ? [
                  { key: 'n', label: '在新对话继续', action: 'retry_in_new_session' },
                  { key: 'r', label: '重试', action: 'retry' },
                ]
              : undefined
            userFacingError = errorContent
            console.error(`[Agent 编排] 最终 errorContent:\n  errorCode: ${errorCode}`)
            console.error(`  errorTitle: ${errorTitle}`)
            console.error(`  errorContent: ${errorContent || '(空)'}`)
            console.error(`  isPromptTooLong: ${isPromptTooLong}, isThinkingSignature: ${isThinkingSignature}`)
            console.error(`[Agent 编排] ══════════ 不可重试错误 诊断结束 ══════════`)

            const errMsg: SDKMessage = {
              type: 'assistant',
              message: {
                content: [{ type: 'text', text: errorContent }],
              },
              parent_tool_use_id: null,
              error: { message: errorContent, errorType: errorCode },
              _createdAt: Date.now(),
              _errorCode: errorCode,
              _errorTitle: errorTitle,
              _errorActions: errorActions,
            } as unknown as SDKMessage
            appendSDKMessages(sessionId, [errMsg])
            console.log(`[Agent 编排] 已保存错误消息到 JSONL`)
          } catch (saveError) {
            console.error('[Agent 编排] 保存错误消息失败:', saveError)
          }

          // 如果之前有重试记录，发送 retry_failed
          if (retryAttemptsScheduled > 0 && lastRetryableError) {
            this.eventBus.emit(sessionId, {
              kind: 'profer_event',
              event: { type: 'retry', status: 'failed', attemptData: { attempt: retryAttemptsScheduled, timestamp: Date.now(), reason: lastRetryableError, errorMessage: userFacingError, delaySeconds: 0 } },
            })
          }

          failRun(userFacingError, getAgentSessionMessages(sessionId), { startedAt: streamStartedAt })

          // 保留 sdkSessionId，确保下一轮能继续 resume（修复 #903）。
          // 此终止分支只会被「非 session-not-found」的错误命中（session 失效已在上文
          // isSessionNotFoundError 分支单独处理并切到恢复模式）。网络断连、服务端 5xx、
          // 未知错误都不代表 SDK 会话本身失效——其完整历史 JSONL 仍保存在
          // ~/.proma/sdk-config/projects/.../{sdkSessionId}.jsonl 中，依旧可 resume。
          // 此前这里对 `!apiError`（如普通断连解析不出状态码）一律清除指针，导致下一轮
          // 退化为「仅回填最近 N 条」的冷启动，上下文从满载骤降（#903）。
          if (existingSdkSessionId) {
            console.log(`[Agent 编排] 保留 sdkSessionId 以便下一轮 resume（错误未表明会话失效）`)
          }

          return
        }
      }

      // 重试循环结束（达到最大次数仍失败）
      if (!retrySucceeded && lastRetryableError) {
        const retryFailureMessage = retryDelayElapsedMs >= MAX_AUTO_RETRY_WAIT_MS
          ? '重试等待已达到 5 分钟后仍然失败'
          : `重试 ${retryAttemptsScheduled || MAX_AUTO_RETRIES} 次后仍然失败`
        this.eventBus.emit(sessionId, {
          kind: 'profer_event',
          event: { type: 'retry', status: 'failed', attemptData: { attempt: retryAttemptsScheduled || MAX_AUTO_RETRIES, timestamp: Date.now(), reason: lastRetryableError, errorMessage: retryFailureMessage, delaySeconds: 0 } },
        })

        // 保存错误消息
        const retryErrorContent = `${retryFailureMessage}: ${lastRetryableError}`
        const retryErrorSDKMsg: SDKMessage = {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: retryErrorContent }],
          },
          parent_tool_use_id: null,
          error: { message: retryErrorContent, errorType: 'unknown_error' },
          _createdAt: Date.now(),
          _errorCode: 'unknown_error',
          _errorTitle: '重试失败',
        } as unknown as SDKMessage
        appendSDKMessages(sessionId, [retryErrorSDKMsg])

        failRun(`${retryFailureMessage}: ${lastRetryableError}`, getAgentSessionMessages(sessionId), { startedAt: streamStartedAt })
      }

    } finally {
      // 凭证仅存在于 queryOptions.env；这里只清理本轮运行态。
      // 只在 generation 匹配时才清理，防止旧流的 finally 误删新流的注册
      releaseActiveRun()
      permissionService.clearSessionPending(sessionId)
      // askUserService 不在 turn 结束时清理——AskUserQuestion 的生命周期由用户交互决定，
      // 仅在会话真正删除时（DELETE_SESSION IPC）才清理。
      exitPlanService.clearSessionPending(sessionId)
      const currentCompletion = this.runCompletions.get(sessionId)
      if (currentCompletion?.token === runGeneration) {
        this.runCompletions.delete(sessionId)
        currentCompletion.resolve()
      }
    }
  }

  /** 标记会话删除中，阻止其从任意 Agent 入口重新运行。 */
  beginDeletion(sessionId: string): void {
    this.deletingSessions.add(sessionId)
  }

  /** 清理删除锁；仅在删除成功或失败的 finally 中调用。 */
  endDeletion(sessionId: string): void {
    this.deletingSessions.delete(sessionId)
  }

  /** 请求停止并等待 sendMessage 的 finally 真正完成。 */
  async stopAndWait(sessionId: string, timeoutMs = 15_000): Promise<void> {
    const completion = this.runCompletions.get(sessionId)?.promise
    if (!completion) return
    this.stop(sessionId)
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        completion,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error(`停止 Agent 会话超时: ${sessionId}`)), timeoutMs)
        }),
      ])
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  }

  /**
   * 中止指定会话的 Agent 执行
   *
   * 先从 activeSessions 移除（供 sendMessage catch 块检测用户中止），
   * 再调用 adapter.abort() 中止底层 SDK 进程。
   */
  stop(sessionId: string): void {
    this.activeSessions.delete(sessionId)
    this.sessionPermissionModes.delete(sessionId)
    this.stoppedBySessions.add(sessionId)
    this.queuedMessageUuids.delete(sessionId)
    this.adapter.abort(sessionId)
    console.log(`[Agent 编排] 已中止会话: ${sessionId}`)
  }

  /** 检查指定会话是否正在处理中 */
  isActive(sessionId: string): boolean {
    return this.activeSessions.has(sessionId)
  }

  /**
   * 运行中动态切换会话的权限模式
   *
   * 同时更新 Profer 侧（canUseTool 闭包读取的 Map）和 SDK 侧（query.setPermissionMode）。
   * 典型场景：用户在 Agent 运行中通过 PermissionModeSelector 切换模式。
   */
  async updateSessionPermissionMode(sessionId: string, mode: ProferPermissionMode): Promise<void> {
    if (!this.activeSessions.has(sessionId)) return
    this.sessionPermissionModes.set(sessionId, mode)
    this.eventBus.emit(sessionId, {
      kind: 'profer_event',
      event: { type: 'plan_mode_changed', sessionId, active: mode === 'plan', source: 'permission' },
    })
    // 同步通知 SDK 侧
    if (this.adapter.setPermissionMode) {
      await this.adapter.setPermissionMode(sessionId, sdkPermissionModeForProferMode(mode))
    }
    console.log(`[Agent 编排] 运行中权限模式已切换: sessionId=${sessionId}, mode=${mode}`)
  }

  // ===== 快照回退 =====

  /**
   * 回退会话到指定消息点
   *
   * 1. 直接从 SDK JSONL 的 file-history-snapshot 恢复文件到目标时刻的状态
   * 2. 截断 Profer JSONL 到 assistantMessageUuid（inclusive）
   * 3. 记录 resumeAtMessageUuid，下次发消息时 SDK 从该点分支继续
   *
   * 文件恢复通过解析 SDK JSONL 中的快照完成，无需运行中的 Query。
   * 文件恢复失败时仍然截断对话（优雅降级）。
   */
  async rewindSession(
    sessionId: string,
    assistantMessageUuid: string,
  ): Promise<RewindSessionResult> {
    // 0. 阻止运行中会话回退（JSONL 并发写入会损坏文件）
    if (this.activeSessions.has(sessionId)) {
      throw new Error('会话正在运行中，请停止后再回退')
    }

    const sessionMeta = getAgentSessionMeta(sessionId)
    if (!sessionMeta?.sdkSessionId) {
      throw new Error('会话没有 SDK session ID，无法回退')
    }

    // 0.5 从 SDK session JSONL 解析对应的 user message UUID（rewindFiles 需要）
    let projectDir: string | undefined
    let workspaceSlug: string | undefined
    if (sessionMeta.workspaceId) {
      const ws = getAgentWorkspace(sessionMeta.workspaceId)
      if (ws) {
        workspaceSlug = ws.slug
        projectDir = getAgentSessionWorkspacePath(ws.slug, sessionMeta.id)
      }
    }
    const userMessageUuid = resolveUserUuidFromSDK(sessionMeta.sdkSessionId, assistantMessageUuid, projectDir, sessionMeta.forkSourceSdkSessionId)
    console.log(`[Agent 编排] 回退: 解析 user uuid=${userMessageUuid || '未找到'} (assistant uuid=${assistantMessageUuid}, forkSource=${sessionMeta.forkSourceSdkSessionId ?? 'none'})`)

    // 1. 文件恢复：直接从 SDK JSONL 的 file-history-snapshot 恢复，无需临时 Query
    let fileRewindResult: { canRewind: boolean; error?: string; filesChanged?: string[]; insertions?: number; deletions?: number } | undefined
    if (userMessageUuid === '__LAST_TURN__') {
      // 最后一个 turn：当前文件系统已是该 turn 完成后的状态，无需回退文件
      console.log(`[Agent 编排] 回退: 最后一个 turn，跳过文件恢复`)
      fileRewindResult = { canRewind: true, filesChanged: [] }
    } else if (userMessageUuid) {
      try {
        // 确定 cwd（文件的基准路径）
        let cwd = homedir()
        if (projectDir) cwd = projectDir
        // 收集附加目录（必须与 sendMessage 中传给 SDK 的 additionalDirectories 一致，
        // 否则会话级 attachedDirectories 内的文件会因路径越界检查被静默跳过）
        const rewindAttachedDirs = collectAttachedDirectories({ sessionMeta, workspaceSlug })
        console.log(`[Agent 编排] 回退: 直接从 snapshot 恢复文件 (cwd=${cwd}, forkSource=${sessionMeta.forkSourceSdkSessionId ?? 'none'}, attachedDirs=${rewindAttachedDirs.length})`)
        fileRewindResult = rewindFilesFromSnapshot(sessionMeta.sdkSessionId, userMessageUuid, cwd, projectDir, sessionMeta.forkSourceSdkSessionId, rewindAttachedDirs)
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        console.warn('[Agent 编排] 文件恢复失败，继续截断对话:', errMsg)
        if (err instanceof Error && err.stack) console.warn('[Agent 编排] 文件恢复错误堆栈:', err.stack)
        fileRewindResult = { canRewind: false, error: errMsg }
      }
    } else {
      fileRewindResult = { canRewind: false, error: '无法从 SDK session 中解析 user message UUID' }
    }

    // 2. 截断 Profer JSONL
    const kept = truncateSDKMessages(sessionId, assistantMessageUuid)

    // 3. 记录 resumeAtMessageUuid，下次发消息时 SDK 从此点继续
    updateAgentSessionMeta(sessionId, { resumeAtMessageUuid: assistantMessageUuid })

    console.log(`[Agent 编排] 回退完成: sessionId=${sessionId}, 保留 ${kept.length} 条消息, 文件恢复=${fileRewindResult?.canRewind ?? '跳过'}`)

    return {
      remainingMessages: kept.length,
      fileRewind: fileRewindResult,
    }
  }

  /** 中止所有活跃的 Agent 会话（应用退出时调用） */
  stopAll(): void {
    if (this.activeSessions.size > 0) {
      console.log(`[Agent 编排] 正在中止所有活跃会话 (${this.activeSessions.size} 个)...`)
    }
    // 即便 activeSessions 为空，也要调 dispose 清理可能残留的 pidMap / 子进程
    this.adapter.dispose()
    this.activeSessions.clear()
    this.sessionPermissionModes.clear()
    this.queuedMessageUuids.clear()
  }

  // ===== 队列消息管理 =====

  /**
   * 流式追加消息
   *
   * 在 Agent 运行中注入用户消息到 SDK，使用 'now' 优先级立即处理。
   * 消息立即持久化到 JSONL。
   *
   * @returns 消息 UUID
   */
  async queueMessage(
    sessionId: string,
    text: string,
    rawText?: string,
    _priority?: string,
    presetUuid?: string,
    opts?: { interrupt?: boolean },
    mentionedSkills?: string[],
    mentionedMcpServers?: string[],
    mentionedSessionIds?: string[],
  ): Promise<string> {
    if (this.deletingSessions.has(sessionId)) {
      throw new Error(`[Agent 编排] 会话正在删除，无法追加消息: ${sessionId}`)
    }
    if (!this.activeSessions.has(sessionId)) {
      throw new Error(`[Agent 编排] 会话未运行，无法追加消息: ${sessionId}`)
    }

    if (!this.adapter.sendQueuedMessage) {
      throw new Error('[Agent 编排] 当前适配器不支持流式追加消息')
    }

    const uuid = presetUuid || randomUUID()

    // 防重记录
    const uuids = this.queuedMessageUuids.get(sessionId) ?? new Set<string>()
    uuids.add(uuid)
    this.queuedMessageUuids.set(sessionId, uuids)

    // 注入 mention 引用指令（Skill/MCP/会话）— 仅影响发往 SDK 的 prompt，不影响持久化。
    // 与 sendMessage 路径保持一致的拼装逻辑。
    let enrichedText = text
    const sessionMeta = getAgentSessionMeta(sessionId)
    const workspaceId = sessionMeta?.workspaceId
    const workspaceSlug = workspaceId ? getAgentWorkspace(workspaceId)?.slug : undefined
    const referencedSessionsBlock = buildReferencedSessionsPrompt(sessionId, mentionedSessionIds, workspaceId)
    if (referencedSessionsBlock) {
      enrichedText = `${referencedSessionsBlock}\n\n${enrichedText}`
    }
    if (mentionedSkills?.length || mentionedMcpServers?.length) {
      const toolLines: string[] = ['用户在消息中明确引用了以下工具，请在本次回复中主动调用：']
      for (const slug of mentionedSkills ?? []) {
        const qualifiedName = workspaceSlug
          ? `profer-workspace-${workspaceSlug}:${slug}`
          : slug
        toolLines.push(`- Skill: ${qualifiedName}（请立即调用此 Skill）`)
      }
      for (const name of mentionedMcpServers ?? []) {
        toolLines.push(`- MCP 服务器: ${name}（请使用此 MCP 服务器的工具来完成任务）`)
      }
      enrichedText = `<mentioned_tools>\n${toolLines.join('\n')}\n</mentioned_tools>\n\n${text}`
    }

    // 构造 SDKUserMessage 并注入（'next' 优先级 = 等当前 turn 完成再处理）
    const sdkMessage = {
      type: 'user' as const,
      message: { role: 'user' as const, content: enrichedText },
      parent_tool_use_id: null,
      priority: 'next' as const,
      uuid,
      session_id: sessionId,
    }

    try {
      // interrupt=true：先软中断当前 turn 再注入（下一轮消费本条）；
      // 否则排队不打断：消息直接入 channel FIFO，priority:'next' 告知 CLI 等当前 turn 完成后再处理。
      if (opts?.interrupt && this.adapter.interruptQuery) {
        try {
          await this.adapter.interruptQuery(sessionId)
        } catch (error) {
          console.warn(`[Agent 编排] 软中断失败（将继续追加消息）:`, error)
        }
      }

      await this.adapter.sendQueuedMessage(sessionId, sdkMessage)
      console.log(`[Agent 编排] 追加消息已注入: sessionId=${sessionId}, uuid=${uuid}, interrupt=${!!opts?.interrupt}`)

      // 立即持久化到 JSONL — 仅存原始文本（rawText），不含 prompt 工程块
      const persistMsg: SDKMessage = {
        type: 'user',
        uuid,
        message: {
          content: [{ type: 'text', text: rawText ?? text }],
        },
        parent_tool_use_id: null,
        _createdAt: Date.now(),
      } as unknown as SDKMessage
      appendSDKMessages(sessionId, [persistMsg])
    } catch (error) {
      uuids.delete(uuid)
      throw error
    }

    return uuid
  }
}
