import { routePluginModel } from './plugins/plugin-routing'
import { buildPluginAgentTools } from './plugins/plugin-agent-tools'
import { injectGoalMcpServer } from './goal-tools'
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
import type {
  AgentSendInput,
  AgentMessage,
  AgentGenerateTitleInput,
  AgentProviderAdapter,
  AgentQueryInput,
  AgentSessionMeta,
  TypedError,
  RetryAttempt,
  SDKMessage,
  SDKAssistantMessage,
  AgentStreamPayload,
  RewindSessionResult,
  SdkBeta,
  ProviderType,
  AgentThinkingLevel,
  ErrorCode,
} from '@profer/shared'
import { normalizeAgentRuntime, AgentSessionRuntimeMismatchError } from '@profer/shared'
import {
  SAFE_TOOLS,
  THINKING_SIGNATURE_ERROR_CODE,
  THINKING_SIGNATURE_ERROR_MESSAGE,
  THINKING_SIGNATURE_ERROR_TITLE,
  resolveAgentSdk1MSelection,
  inferAgentSdkContextWindow,
  strip1MContextSuffix,
  AGENT_PRESET_CAPABILITY_GROUPS,
  createEffectiveAgentPresetPolicy,
  withLoadedMcpServerNames,
  isEffectiveAgentPresetMcpServerAllowed,
  isChannelEnabledForRuntime,
} from '@profer/shared'
import type { PermissionRequest, ProferPermissionMode, AskUserRequest, ExitPlanModeRequest, EffectiveAgentPresetPolicy } from '@profer/shared'
import { buildPiRuntimeCredentialOptions, resolveRuntimeCredentials } from './agent-runtime-credentials'
import {
  decryptApiKey,
  getChannelById,
  isCommercialMode,
  listChannels,
  canSelfConfig,
  persistCodexOAuthCredentials,
  resolveCodexOAuthCredentials,
} from './channel-manager'
import { AgentEventBus } from './agent-event-bus'
import { createAgentQueryPreparationPort, createAgentRunOwnershipRegistry, createAgentRunOwnershipView, createAgentRunRejectionError, createAgentStreamDrainController, readAgentStreamNext, waitForRetryDelay } from '@profer/agent-runtime'
import type { AgentRunOwnershipRegistry, AgentRunOwnershipView, AgentRuntimeQuery, AgentRuntimeQueryPreparationPort, AgentStreamDrainState } from '@profer/agent-runtime'
import type { AgentRuntimePorts, CredentialPort, EventPort, PermissionPort, PreviewPort, ResourcePort, RuntimeCanUseTool, RuntimePermissionResult, SessionPort, ToolAssemblyPort } from '@profer/agent-runtime'
import { injectAutomationMcpServer } from './automation-agent-tools'
import { injectMemoryArchiveMcpServer } from './memory-archive-agent-tools'
import { injectTaskGraphMcpServer } from './task-graph-agent-tools'
import { injectAgentPresetMcpServer } from './agent-preset-tools'
import {
  clearPendingPresetChange,
  evaluateAgentPresetOperationIntents,
  getPendingPresetChange,
  isPresetChangeCancellation,
  isPresetChangeConfirmation,
} from './agent-preset-operations'
import {
  delegationLinkFromResult,
  delegationToGraphEvents,
  isDelegateAgentTool,
  nativeTaskToolToGraphEvents,
  resolveRecentAutoLinkTaskId,
  structuredTaskAutoLinkEvent,
  structuredTaskToolCurrentTaskId,
  type TaskToolInvocation,
} from './task-graph-event-converter'
import { appendGraphEvent } from './project-graph-service'
import { injectAgentCollaborationMcpServer, registerCollaborationEventBus, stopDelegationsForParent } from './agent-collaboration-tools'
import { setHeadlessAgentRunner, setAgentStopper } from './agent-headless-runner-registry'
import { getAdapter, resolveTitleBaseUrl, fetchTitleWithRetry } from '@profer/core'
import { resolveEditionBearerToken } from '@profer/edition-contract'
import { getFetchFn } from './proxy-fetch'
import { getEffectiveProxyUrl } from './proxy-settings-service'
import { generateCodexTitle } from './adapters/pi-codex-title-generator'
import { buildTitlePrompt, buildWindowTitlePrompt, sanitizeGeneratedTitle } from './title-generation'
import { collectSessionTitleSources, runSessionTitleNaming } from './agent-session-title-naming'
import type { SessionTitleNamingLogger } from './agent-session-title-naming'
import { editionProviders } from './edition'
import {
  appendSDKMessages,
  lockAgentSessionRuntime,
  updateAgentSessionMeta,
  getAgentSessionMeta,
  getAgentSessionMessages,
  getAgentSessionSDKMessages,
  isAgentSessionForking,
  truncateSDKMessages,
  resetClaudeSession,
  resolveUserUuidFromSDK,
  rewindFilesFromSnapshot,
  rewindPiSession,
  resetPiSession,
  collectForeignCheckpointPaths,
} from './agent-session-manager'
import { buildAgentSessionUiProjection } from './agent-session-ui-projection'
import { normalizeAgentEndReason } from './agent-end-reason'
import { createPiFileCheckpoint, prunePiFileCheckpoints } from './pi-file-checkpoint'
import {
  getAgentWorkspace,
  getWorkspaceMcpConfig,
  getWorkspaceAutoMemoryDir,
  getWorkspaceMemoryArchivePath,
  ensurePluginManifest,
} from './agent-workspace-manager'
import { getAgentWorkspacePath, getAgentSessionWorkspacePath, agentSessionVisualizationsDir, getPiCheckpointsDir, getSdkConfigDir } from './config-paths'
import { prepareRuntimeSkills } from './global-skill-manager'
import { buildSkillRoutingNotice, routeSkillsForTask, type SkillRoutingResult, type SkillRoutingSnapshot } from './skill-routing'
import { buildSkillRuntimeOptions, prepareAgentSkillRouting } from './skill-runtime-routing'
import { captureSkillToolInventory } from './skill-tool-inventory'
import { getRuntimeStatus } from './runtime-init'
import { shouldStartPiHarness } from './pi-harness/feature-gate'
import { pauseActivePiHarnessRun, settlePiHarnessRun, startPiHarnessRun } from './pi-harness/orchestrator-bridge'
import type { CommandExecutionResult } from './command-execution'
import { createCommandExecutionLedger } from './pi-execution-ledger'
import { getSettings } from './settings-service'
import { buildDynamicContext } from './agent-prompt-context'
import { selectAgentPromptMode, type AgentPromptMode } from './agent-prompt-mode'
import { assembleAgentSystemPrompt } from './agent-prompt-assembly'
import { resolveAgentSystemPromptPolicy } from './agent-system-prompt-policy'
import { injectPlanningMcpServer } from './planning-agent-tools'
import { ensurePresetSystemReady, getAgentPresetByReference, presetReferenceForId } from './agent-preset-manager'
import type { PermissionResult, CanUseToolOptions } from './agent-permission-service'
import type { ExitPlanPermissionResult } from './agent-exit-plan-service'
import { createElectronPermissionPort } from './agent-runtime-permission-port'
import { resolveCredentialPreflightTypedError } from './agent-preflight-typed-errors'
import { applyAgentModelRoutingToEnv, resolveAgentModelRouting } from './agent-model-routing'

import { validateToolInput, validateToolPathPlatform, validateWriteTargetParent } from './agent-tool-input-validator'
import { estimateTokenCount, WRITE_CONTENT_TOKEN_THRESHOLD } from './agent-tool-token-estimator'

// 已提取的工具模块
import {
  sdkPermissionModeForProferMode,
  extractApiError,
  isAutoRetryableTypedError,
  isAutoRetryableCatchError,
  isInvalidRelayTokenError,
  isSessionNotFoundError,
  getRetryDelayMs,
  getRetryDisplayReason,
  getMaxAutoRetries,
  classifyCatchError,
  isRetryBudgetExhausted,
  MAX_AUTO_RETRIES,
  MAX_AUTO_RETRY_WAIT_MS,
} from './agent-retry-utils'
import {
  extractSDKToolSummary,
  buildContextPrompt,
  buildRecoveryPrompt,
  escapeContextAttr,
  buildReferencedSessionsPrompt,
  DEFAULT_SESSION_TITLE,
  DEFAULT_MODEL_ID,
  MAX_CONTEXT_MESSAGES,
} from './agent-prompt-utils'
import { resolveSDKCliPath } from './agent-sdk-cli-path'
import { collectAttachedDirectories, collectProductArtifactDirectories } from './agent-directory-utils'
import { resolveHostAgentRuntimeEnv } from './agent-runtime-env-host'
import { buildAgentSdkEnv } from './agent-sdk-env'
import type { PiAgentQueryOptions } from './adapters/pi-agent-adapter'
import type { PiRetryUpdate } from './adapters/pi-retry-control'
import { buildPiBuiltinTools } from './adapters/pi-builtin-tools'
import type { PiBuiltinToolsContext, PiBuiltinToolsResult } from './adapters/pi-builtin-tools'
import { buildPreparedPiTools, preparedPiToolsCollaborationAvailable } from './agent-prepared-pi-tools'
import { buildPiMcpTools, getMcpPolicyToolName } from './adapters/pi-mcp-tools'
import { injectClaudeBrowserMcpServer } from './claude-browser-tools'
import { injectClaudeClipboardMcpServer } from './claude-clipboard-tools'
import { evaluatePptCapability } from './ppt-capability-gate'
import { injectAgentImageOutputMcpServer } from './agent-image-output-tools'
import { injectAgentGptImageMcpServer, isAgentGptImageAvailable } from './agent-gpt-image-tools'
import { injectAgentSkinMcpServer } from './agent-skin-tools'
import { injectAgentPreviewMcpServer } from './agent-preview-tools'
import { injectVisualizationMcpServer } from './agent-visualization-tools'
import { agentFilePreviewSessionManager } from './agent-file-preview-session'
import { injectPptDeliveryMcpServer } from './ppt-delivery-agent-tools'
import { browserController } from './browser-controller'
import {
  AgentRunAlreadyActiveError,
  isBrowserToolName,
  isPartialSDKMessage,
  isXaiChannelAvailableForRuntime,
  resolvePlanModeBrowserPermission,
  shouldPreInterruptQueuedMessage,
  tryReserveQueuedMessage,
} from './agent-orchestrator-p0-guards'
// 计划模式只读工具面的唯一实现（GAP-5）：旧局部量已删除，与新 runtime 路径的计划模式门禁共享同一份规则。
import { createPlanModeToolPolicy } from './plan-mode-tool-policy'
import { EMPTY_OUTPUT_ERROR_MESSAGE, hasTerminalErrorWithContent, stripErrorFromContentMessage } from './adapters/pi-message-adapter'
import { resolvePiThinkingLevel } from './agent-thinking-level'
import { buildPiAdditionalDirectoriesPrompt } from './pi-additional-directories-prompt'
import { detectAttachedDirectoryProjects } from './attached-directory-project-detector'

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
  onComplete: (
    messages?: AgentMessage[],
    opts?: {
      stoppedByUser?: boolean
      startedAt?: number
      resultSubtype?: string
      resultErrors?: string[]
      backgroundTasksPending?: boolean
      endReason?: import('@profer/shared').AgentEndReason
      endReasonLabel?: string
    },
  ) => void
  /** 发送标题更新 */
  onTitleUpdated: (title: string) => void
  /** 已获得本轮运行权；并发拒绝不会调用。 */
  onRunOwned?: () => void
  /** 用户消息已持久化，外部入口可据此通知前端切到实时会话 */
  onRunStarted?: (opts: { startedAt: number }) => void | Promise<void>
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
    const parts: string[] = [`[类型: ${error.constructor.name}]`, `message: ${error.message || '(空)'}`, `name: ${error.name}`]
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
  private readonly sessionPort: SessionPort
  private readonly credentialPort: CredentialPort
  private readonly resourcePort: ResourcePort
  private readonly permissionPort: PermissionPort
  private readonly eventPort: EventPort
  private readonly toolAssemblyPort?: ToolAssemblyPort
  private readonly queryPreparationPort: AgentRuntimeQueryPreparationPort
  private readonly queryPreparations = new Map<string, AbortController>()
  private readonly previewPort: PreviewPort
  /**
   * 共享执行权登记表（唯一事实源）。注入同一个实例即获得跨引擎互斥；
   * 不注入时自建一份，行为与改造前等价（只在本编排器内互斥）。
   */
  private readonly ownership: AgentRunOwnershipRegistry
  /** 共享登记表的只读视图（保留 Map 风格的调用点：get/has/keys/size）。 */
  private readonly activeSessions: AgentRunOwnershipView

  /** 每个会话至多一个 Goal owner；用于拒绝迟到的停止和清理。 */
  private goalRunOwners = new Map<string, string>()

  /** 队列消息本地记录（sessionId → UUID 集合，用于防重） */
  private queuedMessageUuids = new Map<string, Set<string>>()

  /** 被用户手动中止的会话集合（在 stop 中标记，catch block 中消费） */
  private stoppedBySessions = new Set<string>()

  /** 运行中会话的当前权限模式（支持运行时动态切换） */
  private sessionPermissionModes = new Map<string, ProferPermissionMode>()

  /** 每轮真实运行的退出信号；仅 owner finally 可以 resolve。 */
  private runCompletions = new Map<string, { token: string; promise: Promise<void>; resolve: () => void }>()

  /** 当前运行实际加载的预设能力；队列消息必须跟随它，而不是盲信运行中途刚切换的会话元数据。 */
  private activePresetPolicies = new Map<string, EffectiveAgentPresetPolicy>()

  /** 删除期间禁止同一会话从 UI、队列或 headless 路径重新进入。 */
  private deletingSessions = new Set<string>()
  /** Goal 内部 turn 不写入普通会话 transcript。 */
  private nonPersistingGoalSessions = new Set<string>()

  /** 运行期间的装配模式，确保插队任务不会沿用无工具的问候上下文。 */
  private activePromptModes = new Map<string, AgentPromptMode>()
  /** 队列复用当前 run 的 Skill 快照；初始化失败 resolve(undefined)，不得悬挂或放宽策略。 */
  private activeSkillRoutings = new Map<string, Promise<SkillRoutingSnapshot | undefined>>()
  private activeRuntimeRegistrations = new Map<string, Promise<boolean>>()

  constructor(adapter: AgentProviderAdapter, eventBus: AgentEventBus, ports?: Pick<AgentRuntimePorts, 'sessions' | 'credentials' | 'resources' | 'permissions' | 'events' | 'toolAssembly' | 'preview' | 'queryPreparation'>, ownership: AgentRunOwnershipRegistry = createAgentRunOwnershipRegistry()) {
    // ⚠️ 必须在构造函数体内赋值：字段初始化器先于参数属性赋值执行。
    this.ownership = ownership
    this.activeSessions = createAgentRunOwnershipView(ownership)
    const legacyPorts: { sessions: SessionPort; credentials: CredentialPort; resources: ResourcePort; permissions: PermissionPort; events: EventPort } = {
      sessions: {
        getMeta: getAgentSessionMeta,
        lockRuntime: lockAgentSessionRuntime,
        appendMessages: (sessionId, messages): undefined => { appendSDKMessages(sessionId, [...messages]) },
        updateMeta: (sessionId, patch): undefined => { updateAgentSessionMeta(sessionId, patch) },
        getMessages: getAgentSessionSDKMessages,
        getAgentMessages: getAgentSessionMessages,
      },
      credentials: {
        async resolve(input) {
          if (!input.channelId) throw new Error('运行时凭据解析缺少 channelId')
          const channel = getChannelById(input.channelId)
          if (!channel) throw new Error(`渠道不存在: ${input.channelId}`)
          return resolveRuntimeCredentials(channel, input.runtime)
        },
      },
      resources: {
        load: () => ({}),
        getMcpConfig: ({ workspaceSlug }) => getWorkspaceMcpConfig(workspaceSlug),
      },
      permissions: createElectronPermissionPort(),
      events: {
        emit: (sessionId, payload) => eventBus.emit(sessionId, payload),
      },
    }
    this.adapter = adapter
    this.eventBus = eventBus
    this.sessionPort = ports?.sessions ?? legacyPorts.sessions
    this.credentialPort = ports?.credentials ?? legacyPorts.credentials
    this.resourcePort = ports?.resources ?? legacyPorts.resources
    this.permissionPort = ports?.permissions ?? legacyPorts.permissions
    this.eventPort = ports?.events ?? legacyPorts.events
    this.toolAssemblyPort = ports?.toolAssembly
    this.queryPreparationPort = ports?.queryPreparation ?? createAgentQueryPreparationPort({
      credentials: this.credentialPort, resources: this.resourcePort,
      permissions: this.permissionPort, events: this.eventPort, toolAssembly: this.toolAssemblyPort,
    })
    this.previewPort = ports?.preview ?? {
      open: (event) => agentFilePreviewSessionManager.waitUntilReady(event, (previewEvent) => {
        this.eventPort.emit(event.sessionId, { kind: 'profer_event', event: previewEvent })
      }),
      inspect: (request) => agentFilePreviewSessionManager.inspect(request, (previewEvent) => {
        this.eventPort.emit(request.sessionId, { kind: 'profer_event', event: previewEvent })
      }),
    }
    registerCollaborationEventBus(eventBus)

    // 注册 headless runner，供协作工具 / 自动任务 / 桥接命令等非 UI 场景调用
    setHeadlessAgentRunner((input, callbacks) => this.sendMessage(input, callbacks))
    setAgentStopper((sessionId) => {
      this.stop(sessionId)
    })
  }

  /** 每次重试都使用当前凭据和已冻结策略；停止可中断异步准备。 */
  private async prepareProviderQuery(input: AgentRuntimeQuery) {
    const controller = new AbortController()
    this.queryPreparations.set(input.sessionId, controller)
    if (this.stoppedBySessions.has(input.sessionId)) controller.abort()
    try {
      const prepared = await this.queryPreparationPort.prepare(input, controller.signal)
      controller.signal.throwIfAborted()
      return { ...input.prepared, ...prepared }
    } finally {
      if (this.queryPreparations.get(input.sessionId) === controller) this.queryPreparations.delete(input.sessionId)
    }
  }

  /** provider options 保持宿主字段，prepared 快照通过同一生产入口交给 adapter。 */
  private async queryPreparedProvider(input: AgentRuntimeQuery, options: AgentQueryInput) {
    const prepared = await this.prepareProviderQuery(input)
    const providerQuery = { ...options, prepared }
    return this.adapter.query(providerQuery)
  }

  private async buildPiBuiltinTools(sdk: unknown, context: PiBuiltinToolsContext): Promise<PiBuiltinToolsResult> {
    if (this.toolAssemblyPort) {
      return await this.toolAssemblyPort.build({ sdk, context }) as PiBuiltinToolsResult
    }
    return buildPiBuiltinTools(sdk as Parameters<typeof buildPiBuiltinTools>[0], context)
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
  private async buildSdkEnv(credentials: {
    apiKey: string
    baseUrl: string | undefined
    provider: ProviderType
    forceBearerAuth: boolean
  }): Promise<Record<string, string | undefined>> {
    // 实现已抽到 `agent-sdk-env.ts`：新链的 provider preparation 与旧链共用同一份完整 SDK env
    // （PATH / 代理 / 配置隔离目录 / 随包 CLI / Windows shell / ANTHROPIC_* 回流加固）。
    return buildAgentSdkEnv(credentials)
  }

  /**
   * 构建工作区 MCP 服务器配置
   *
   * @param workspaceSlug 工作区 slug
   * @param mcpNameFilter 预设声明的 MCP 白名单；undefined 表示不裁剪。
   *   只作用于工作区用户配置的 MCP；产品内置 MCP（automation/task-graph 等）由注入器追加，不受影响。
   */
  private buildMcpServers(sessionId: string, workspaceSlug: string | undefined, mcpNameFilter?: string[]): Record<string, Record<string, unknown>> {
    const mcpServers: Record<string, Record<string, unknown>> = {}
    if (!workspaceSlug) return mcpServers

    const mcpConfig = this.resourcePort.getMcpConfig?.({ sessionId, workspaceSlug }) ?? getWorkspaceMcpConfig(workspaceSlug)
    for (const [name, entry] of Object.entries(mcpConfig.servers ?? {})) {
      if (!entry.enabled) continue
      if (name === 'memos-cloud') continue
      // 预设 MCP 白名单：未列出的工作区 MCP 不加载
      if (mcpNameFilter !== undefined && !mcpNameFilter.includes(name)) {
        console.log(`[Agent 编排] MCP 服务器 "${name}" 被预设白名单裁剪`)
        continue
      }

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
          ...(entry.headers &&
            Object.keys(entry.headers).length > 0 && {
              headers: entry.headers,
            }),
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
  async generateTitle(input: AgentGenerateTitleInput, options?: { onFailure?: (reason: string) => void }): Promise<string | null> {
    const { userMessage, channelId, contextMessages } = input
    // SDK 回报的模型名可能是 `deepseek-v4-pro[1m]` 这类 1M 变体：该后缀只对 Claude Agent SDK
    // 有意义，发给供应商 API 会指向不存在的模型。标题请求必须用真实模型 ID。
    const modelId = strip1MContextSuffix(input.modelId)
    const titlePrompt = contextMessages && contextMessages.length > 0
      ? buildWindowTitlePrompt(contextMessages)
      : buildTitlePrompt(userMessage)
    // 失败必须返回 null 并把原因交给调用方：本地「首条消息前 20 字」兜底会伪装成
    // 模型命名（并重新锁定标题），让用户以为重命名成功但其实没生效。
    const fail = (reason: string): null => {
      options?.onFailure?.(reason)
      console.warn(`[Agent 标题生成] ${reason}`)
      return null
    }
    console.log('[Agent 标题生成] 开始生成标题:', {
      channelId,
      modelId,
      sourceCount: contextMessages?.length ?? 1,
      userMessage: userMessage.slice(0, 50),
    })

    try {
      const channels = listChannels()
      const channel = channels.find((c) => c.id === channelId)
      if (!channel) {
        return fail(`渠道不存在: ${channelId}`)
      }

      if (channel.provider === 'xai') {
        // xAI subscription uses Pi's provider-specific OAuth transport; title generation's
        // generic channel adapter only understands API keys.
        return fail('xAI 订阅渠道暂不支持标题生成')
      }

      if (channel.provider === 'openai-codex') {
        try {
          const [credentials, proxyUrl] = await Promise.all([resolveCodexOAuthCredentials(channelId), getEffectiveProxyUrl()])
          const generatedTitle = await generateCodexTitle({
            modelId,
            prompt: titlePrompt,
            credentials,
            proxyUrl,
            onCredentialsRefreshed: (refreshed) => persistCodexOAuthCredentials(channelId, refreshed),
          })
          const title = generatedTitle ? sanitizeGeneratedTitle(generatedTitle) : null
          if (title) {
            console.log(`[Agent 标题生成] ChatGPT OAuth 语义标题生成成功: "${title}"`)
            return title
          }
          console.warn('[Agent 标题生成] ChatGPT OAuth 返回空标题')
        } catch (error) {
          console.warn('[Agent 标题生成] ChatGPT OAuth 语义标题生成失败:', error)
        }
        return fail('ChatGPT OAuth 未返回可用标题')
      }

      let apiKey: string
      let proxyBaseUrl = ''
      if (editionProviders.credentials.shouldUseBearerAuth(channel)) {
        const auth = await editionProviders.account.getSession()
        if (!auth) {
          return fail('团队账号登录已过期')
        }
        const proxyPath = (this.adapter.isAnthropicProxyProvider?.(channel.provider) ?? true) ? '/v1/proxy/messages' : '/v1/proxy/chat'
        proxyBaseUrl = `${auth.baseUrl}${proxyPath}`
        apiKey = resolveEditionBearerToken(auth)
      } else {
        apiKey = decryptApiKey(channelId)
      }

      const providerAdapter = getAdapter(channel.provider, channel.apiProtocol, proxyBaseUrl || channel.baseUrl)
      const titleBaseUrl = proxyBaseUrl || resolveTitleBaseUrl(channel.provider, channel.baseUrl, channel.apiProtocol) || channel.baseUrl
      const request = providerAdapter.buildTitleRequest({
        baseUrl: titleBaseUrl,
        apiKey,
        modelId,
        prompt: titlePrompt,
      })
      if (proxyBaseUrl) request.url = proxyBaseUrl

      const proxyUrl = await getEffectiveProxyUrl()
      const fetchFn = getFetchFn(proxyUrl)
      const title = await fetchTitleWithRetry(request, providerAdapter, fetchFn)
      if (!title.title) {
        return fail(title.diagnostics?.reason ?? '标题模型没有返回可用结果')
      }

      const cleaned = sanitizeGeneratedTitle(title.title)
      if (!cleaned) {
        return fail('标题清洗后为空')
      }
      const result = cleaned

      console.log(`[Agent 标题生成] 生成标题成功: "${result}"`)
      return result
    } catch (error) {
      return fail(`生成失败: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * 共享命名模块的日志出口：本链自己的 `console`。
   *
   * 切片编译时 `console` 是注入的安静实现（旧链的日志本来就走它），共享模块因此不会绕过
   * 宿主的日志路由。写成方法而不是模块级常量：本类只取类源码被多份切片编译，模块级符号
   * 必须靠注入表提供，未注入时在 catch 里引用会让异常处理器自己再抛。
   */
  private titleNamingLog(): SessionTitleNamingLogger {
    return {
      log: (message, ...rest) => console.log(message, ...rest),
      warn: (message, ...rest) => console.warn(message, ...rest),
    }
  }

  /**
   * 自动命名：首条有效用户消息触发；寒暄/命令跳过；生成成功或本地兜底后立即定稿。
   *
   * 窗口编排（何时生成 / 生成几次 / 何时锁定 / 覆盖保护）的唯一实现在
   * `agent-session-title-naming.ts` —— 新 runtime 链调用同一份，本方法只注入宿主事实。
   */
  private async autoGenerateTitle(sessionId: string, userMessage: string, channelId: string, modelId: string, callbacks: SessionCallbacks): Promise<void> {
    // 日志标签刻意用**方法内局部量**而不是模块级常量：本类的多处切片编译（parity / goal bridge）
    // 只取类源码，模块级符号必须靠注入表提供；一旦 catch 里引用未注入的符号，异常处理器自己会再抛。
    const logTag = '[Agent 编排]'
    try {
      await runSessionTitleNaming({
        sessionId,
        userMessage,
        channelId,
        modelId,
        defaultTitle: DEFAULT_SESSION_TITLE,
        getMeta: id => this.sessionPort.getMeta(id),
        updateMeta: (id, patch) => this.sessionPort.updateMeta(id, patch),
        readMessages: id => this.sessionPort.getMessages?.(id) ?? [],
        generate: input => this.generateTitle(input),
        onTitleUpdated: title => callbacks.onTitleUpdated(title),
        log: this.titleNamingLog(),
        logTag,
      })
    } catch (error) {
      // 调用点位于本轮运行的 `try` 块内（`sendMessage` 成功分支）：这里一旦抛出就会被当成
      // 「本轮运行失败」。共享模块内部已有兜底，此处再兜一层，把「标题失败不阻断本轮」
      // 变成结构性保证（依表缺失等意外也不会污染终态）。
      console.warn(`${logTag} 自动标题生成失败:`, error)
    }
  }

  /**
   * 手动「重新生成标题」：绕过定稿锁定，用当前会话的有效用户消息重新命名并重新锁定。
   */
  async regenerateTitle(sessionId: string, channelId: string, modelId: string): Promise<string | null> {
    const meta = this.sessionPort.getMeta(sessionId)
    if (!meta) return null
    const requestRevision = meta.revision ?? 0

    const sources = collectSessionTitleSources({
      sessionId,
      meta,
      fallbackMessage: '',
      readMessages: id => this.sessionPort.getMessages?.(id) ?? [],
      log: this.titleNamingLog(),
      logTag: '[Agent 编排]',
    })
    if (sources.length === 0) {
      throw new Error('重新生成标题失败：当前会话没有可用于生成标题的有效用户消息')
    }

    let failureReason = ''
    const title = await this.generateTitle({
      userMessage: sources[0] ?? '',
      channelId,
      modelId,
      contextMessages: sources,
    }, { onFailure: (reason) => { failureReason = reason } })
    if (!title) {
      throw new Error(`重新生成标题失败：${failureReason || '标题模型没有返回可用结果'}`)
    }

    const latestMeta = this.sessionPort.getMeta(sessionId)
    if (!latestMeta || (latestMeta.revision ?? 0) !== requestRevision) {
      throw new Error('重新生成标题失败：生成期间会话状态已变化，请重试')
    }
    this.sessionPort.updateMeta(sessionId, {
      title,
      titleAutoGeneratedAt: Date.now(),
      titleLockedAt: Date.now(),
    })
    console.log(`[Agent 编排] 手动重新生成标题完成: "${title}"（来源 ${sources.length} 条）`)
    return title
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
    if (queryOptions.isolatedRuntimeSession) {
      // Goal runtime 的 resume 关系只属于 Goal 状态；恢复时不能清除普通 Agent 会话 metadata，
      // 也不能把普通 transcript 作为新 Goal 的上下文来源。
      queryOptions.resumeSessionId = undefined
      queryOptions.resumeSessionAt = undefined
      queryOptions.prompt = contextualMessage
      return retryReason
    }
    // 先持久化当前已累积的消息，确保 JSONL 文件包含最新内容
    this.persistSDKMessages(sessionId, accumulatedMessages, Date.now() - queryStartedAt)
    accumulatedMessages.length = 0
    // 清除失效的 SDK session，新 SDK 会话产生的 sdkSessionId 会通过 onSessionId 回调自动保存
    // 此操作必须成功，否则下次打开会话仍会尝试 resume 已失效的 session，陷入无限恢复循环
    try {
      this.sessionPort.updateMeta(sessionId, { sdkSessionId: undefined })
    } catch (clearErr) {
      console.error(`[Agent 编排] ⚠️ 清除失效 sdkSessionId 失败！下次打开此会话可能仍触发 session-not-found 恢复:`, clearErr)
      // 写诊断文件供后续排查
      try {
        const diagDir = join(
          getAgentSessionWorkspacePath(getAgentWorkspace(this.sessionPort.getMeta(sessionId)?.workspaceId ?? '')?.slug ?? 'unknown', sessionId),
          '.context',
        )
        if (!existsSync(diagDir)) mkdirSync(diagDir, { recursive: true })
        appendFileSync(join(diagDir, 'session-errors.log'), `[${new Date().toISOString()}] session-not-found 恢复时清除 sdkSessionId 失败: ${clearErr}\n`)
      } catch {
        /* 诊断写入是尽力而为的 */
      }
    }
    queryOptions.resumeSessionId = undefined
    queryOptions.resumeSessionAt = undefined
    queryOptions.prompt = buildRecoveryPrompt(sessionId, contextualMessage, {
      agentCwd,
    })
    return retryReason
  }

  /**
   * 持久化累积的 SDKMessage（Phase 4: 直接存储原始 SDKMessage）
   *
   * 只持久化 assistant、user、result 和需要长期可见的 system 消息
   * （跳过 tool_progress、compacting 等临时消息）。
   */
  /** 用户点名的 Skill 没加载时落盘一条系统提示并推给界面；失败只记日志，不影响本轮运行。 */
  private persistSkillRoutingNotice(sessionId: string, routed: SkillRoutingResult): void {
    const notice = buildSkillRoutingNotice(routed)
    if (!notice) return
    const message = { type: 'system', subtype: 'skill_routing_notice', message: notice, _createdAt: Date.now() } as unknown as SDKMessage
    try {
      this.sessionPort.appendMessages(sessionId, [message])
      this.eventPort.emit(sessionId, { kind: 'sdk_message', message })
    } catch (error) {
      console.warn(`[Skill 路由] 未加载提示写入失败: sessionId=${sessionId}`, error)
    }
  }

  private persistSDKMessages(sessionId: string, accumulatedMessages: SDKMessage[], durationMs?: number): void {
    if (this.nonPersistingGoalSessions.has(sessionId)) return
    if (accumulatedMessages.length === 0) return

    const toPersist = accumulatedMessages
      .filter(
        (m) =>
          m.type === 'assistant' ||
          m.type === 'user' ||
          m.type === 'result' ||
          (m.type === 'system' &&
            ['compact_boundary', 'permission_denied', 'compact_skipped'].includes((m as import('@profer/shared').SDKSystemMessage).subtype ?? '')),
      )
      .filter((m) => {
      // Pi partial 仅用于实时预览；即使未来调用方误传，也不能污染 JSONL 历史。
      if (isPartialSDKMessage(m)) return false
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
        return {
          ...m,
          _createdAt: now,
          _durationMs: durationMs,
        } as unknown as SDKMessage
      }
      return { ...m, _createdAt: now } as unknown as SDKMessage
    })

    this.sessionPort.appendMessages(sessionId, withTimestamps)
  }

  /**
   * 发送消息并流式推送事件
   *
   * 核心编排方法，从 agent-service.ts 的 runAgent 提取。
   * 通过 EventBus 分发 AgentEvent，通过 callbacks 发送控制信号。
   */
  async sendMessage(input: AgentSendInput, callbacks: SessionCallbacks): Promise<void> {
    const credentialPort = this.credentialPort
    const boundSession = this.sessionPort.getMeta(input.sessionId)
    const agentRuntime = normalizeAgentRuntime(boundSession ? boundSession.agentRuntime : input.agentRuntime)
    // 内部/headless 入口也不能用请求覆盖已存在会话的内核。拒绝发生在取得 owner 之前。
    if (boundSession && input.agentRuntime !== undefined && input.agentRuntime !== agentRuntime) {
      throw new AgentSessionRuntimeMismatchError(agentRuntime, input.agentRuntime)
    }
    const {
      sessionId,
      userMessage,
      workspaceId,
      additionalDirectories,
      customMcpServers,
      permissionModeOverride,
      mentionedSkills,
      mentionedMcpServers,
      mentionedSessionIds,
      automationContext,
    } = input
    const goalIsolated = input.isolatedRuntimeSession === true
    const runtimeUserMessage = input.internalPrompt ?? userMessage
    let { channelId, modelId } = input
    // Pi/Claude 的错误结构和可恢复语义不同；Router 必须按本次请求 runtime 提供 helper。
    const errorHelpers = this.adapter.getErrorHelpers?.(agentRuntime) ?? this.adapter.errorHelpers
    const stderrChunks: string[] = []

    // 0. 并发保护
    // 在任意 await 前原子占用会话，商业渠道认证刷新也不得留下并发窗口。
    const streamStartedAt = input.startedAt ?? Date.now()
    // 删除 / 分叉守卫的唯一来源（与桌面 runtime 入口共用同一组文案与判定顺序）。
    const guardReason = this.checkEntryGuards(sessionId)
    if (guardReason !== undefined) {
      callbacks.onError(guardReason)
      callbacks.onComplete([], { startedAt: input.startedAt })
      return
    }
    const runGeneration = randomUUID()
    // 已有 owner：对用户而言就是「上一条消息仍在处理中」，与改造前 `tryAcquireActiveSession` 同义。
    // 内核不匹配由上面的会话元数据检查负责（同样在取得 owner 之前）；
    // 两步之间没有任何 await，因此不存在竞态窗口。
    if (this.ownership.isOwned(sessionId)) {
      const stopping = this.stoppedBySessions.has(sessionId)
      const hungCompletion = this.runCompletions.get(sessionId)
      console.warn(
        `[Agent 编排] 会话 ${sessionId} 正在${stopping ? '停止' : '处理中'}，拒绝新请求; ` +
        `activeSessionsToken=${String(this.activeSessions.get(sessionId) ?? '(empty/hung)')}, ` +
        `runCompletionsPending=${hungCompletion ? 'true(finally未释放)' : 'false'}`,
      )
      throw new AgentRunAlreadyActiveError(stopping)
    }
    // 执行权取得走共享登记表：与 runtime 引擎（coordinator.claim）共用同一份 owner 表，
    // 因此「桌面持有 → headless 被拒」「headless 持有 → 桌面被拒」两个方向都由同一处保证。
    const runClaim = this.ownership.claim({ sessionId, runtime: agentRuntime, token: runGeneration })
    if (!runClaim.ok) {
      // 登记表层面的结构性拒绝（例如另一个内核已持有）：不伪造终态，直接抛具名错误。
      throw createAgentRunRejectionError(runClaim, { stopping: this.stoppedBySessions.has(sessionId) })
    }
    if (input.goalRunId) this.goalRunOwners.set(sessionId, input.goalRunId)
    if (goalIsolated) this.nonPersistingGoalSessions.add(sessionId)
    ;({ channelId, modelId } = input)
    let resolveCompletion!: () => void
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve
    })
    this.runCompletions.set(sessionId, {
      token: runGeneration,
      promise: completion,
      resolve: resolveCompletion,
    })
    callbacks.onRunOwned?.()
    let resolveSkillRouting!: (snapshot: SkillRoutingSnapshot | undefined) => void
    this.activeSkillRoutings.set(sessionId, new Promise(resolve => { resolveSkillRouting = resolve }))
    let resolveRuntimeRegistered!: (ready: boolean) => void
    this.activeRuntimeRegistrations.set(sessionId, new Promise(resolve => { resolveRuntimeRegistered = resolve }))
    const releaseActiveRun = (): boolean => this.ownership.release(sessionId, runGeneration)
    type CompleteOptions = {
      stoppedByUser?: boolean
      startedAt?: number
      resultSubtype?: string
      resultErrors?: string[]
      endReason?: import('@profer/shared').AgentEndReason
      endReasonLabel?: string
    }
    // completeRun 必须延后到 owner finally 才通知 renderer；因此状态必须与 finally 同作用域。
    let pendingTerminalCompletion: {
      messages?: AgentMessage[]
      opts?: CompleteOptions
    } | null = null
    // 运行级错误标志：preflight / 异常 catch / TypedError 无 subtype 等无 resultSubtype 的错误路径
    // 据此归一化为 error。必须放在 try 之外，owner finally 需要读取它。
    let runEndedWithError = false
    let piHarnessScope: ReturnType<typeof startPiHarnessRun> | undefined
    let harnessStopped = false
    const executionResultsByToolUse = createCommandExecutionLedger()
    // 受控写入事实：toolCallId → 本轮确定写过的路径。
    // 渲染层只信这份账本，不再从 Bash 命令文本推断路径。
    const fileWritesByToolUse = new Map<string, Array<{ path: string; source: string }>>()

    try {
      // 在任何 await 之前锁定；preflight 失败、停止、重启都不能再次选择另一内核。
      if (boundSession && boundSession.agentRuntimeLocked !== true) {
        if (!this.sessionPort.lockRuntime) throw new Error('SessionPort 缺少同步内核绑定能力')
        const locked = this.sessionPort.lockRuntime(sessionId, agentRuntime)
        this.eventPort.emit(sessionId, { kind: 'session_projection', operation: 'upsert', session: buildAgentSessionUiProjection(locked) })
      }
    // 0.5 清除上一轮中断标记
      input = routePluginModel(`agent:${sessionId}`, input, agentRuntime)
      ;({ channelId, modelId } = input)
      try {
        this.sessionPort.updateMeta(sessionId, { stoppedByUser: false })
      } catch {
        /* 会话可能已删除 */
      }

    // 环境 / 配置类错误的统一上报：持久化为 TypedError 消息，由 SDKMessageRenderer 渲染
    const reportPreflightError = (typedError: TypedError) => {
        const errorContent = typedError.title ? `${typedError.title}: ${typedError.message}` : typedError.message
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
        try {
          this.sessionPort.appendMessages(sessionId, [errorSDKMsg])
        } catch (e) {
        console.error('[Agent 编排] 持久化 preflight error 失败:', e)
      }
      callbacks.onError(errorContent)
      // owner finally 释放 activeSessions 后才发 complete，避免 renderer 先进入 idle。
      runEndedWithError = true
        pendingTerminalCompletion = {
          messages: [],
          opts: { startedAt: input.startedAt },
        }
    }

    // 1. Windows 平台：检查 Shell 环境可用性
    if (process.platform === 'win32') {
      const runtimeStatus = getRuntimeStatus()
      const shellStatus = runtimeStatus?.shell

      if (shellStatus && !shellStatus.gitBash?.available && !shellStatus.wsl?.available) {
        reportPreflightError({
          code: 'windows_shell_missing',
          title: 'Windows 环境未就绪',
            message: '需要 Git Bash 或 WSL 才能运行 Agent。建议安装 Git for Windows（自带 Git Bash），安装完成后点「打开环境检测」刷新状态。',
            details: [`Git Bash: ${shellStatus.gitBash?.error || '未检测到'}`, `WSL: ${shellStatus.wsl?.error || '未检测到'}`],
          actions: [
              {
                key: 'e',
                label: '打开环境检测',
                action: 'open_environment_check',
              },
              {
                key: 'g',
                label: '去官方下载 Git',
                action: 'open_external',
                payload: 'https://git-scm.com/download/win',
              },
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
            {
              key: 's',
              label: '打开渠道设置',
              action: 'open_channel_settings',
            },
        ],
        canRetry: false,
      })
      return
    }

    if (!isXaiChannelAvailableForRuntime(channel, agentRuntime)) {
      reportPreflightError({
        code: 'invalid_request',
        title: agentRuntime !== 'pi' ? 'xAI 仅支持 Pi Agent' : 'xAI Agent 尚未开启',
        message: agentRuntime !== 'pi'
          ? 'xAI 当前仅支持 Pi Agent 运行时，请新建 Pi 会话使用该渠道。'
          : 'xAI Agent 仍处于实验阶段，请先在 xAI 渠道设置中开启“启用实验性 Agent”。',
        actions: [{ key: 's', label: '打开渠道设置', action: 'open_channel_settings' }],
        canRetry: false,
      })
      return
    }

    if (!isChannelEnabledForRuntime(channel, agentRuntime)) {
      reportPreflightError({
        code: 'invalid_request',
        title: '渠道未启用当前 Agent 内核',
        message: '请在渠道设置中启用当前内核，或重新选择可用渠道。',
        actions: [{ key: 's', label: '打开渠道设置', action: 'open_channel_settings' }],
        canRetry: false,
      })
      return
    }

    console.info('[Agent 编排] 请求路由:', {
      sessionId,
      requestSource: 'agent-message',
      channelId,
      modelId: modelId || DEFAULT_MODEL_ID,
      provider: channel.provider,
    })

    const credentialResult = await credentialPort.resolve({ sessionId, runtime: agentRuntime, channelId, modelId })
    if (!credentialResult.ok) {
      // 文案来自宿主侧唯一来源（`agent-preflight-typed-errors`），与 runtime 新入口共用同一份：
      // 同一次凭证失败在两个入口下必须对用户显示相同内容（G3）。
      reportPreflightError(
        resolveCredentialPreflightTypedError(credentialResult.code)
          ?? {
            code: 'api_key_decrypt_failed',
            title: 'API Key 解密失败',
            message: '无法解密此渠道的 API Key，可能是系统密钥环异常。请到设置中重新填写 API Key。',
            actions: [{ key: 's', label: '打开渠道设置', action: 'open_channel_settings' }],
            canRetry: false,
          },
      )
      return
    }
      let runtimeCredentials = credentialResult.credentials

    // 5. 持久化用户消息（SDKMessage 格式）——在所有 preflight 检查之前写入。
    // Goal 内部 turn 使用 internalPrompt，仅供 runtime 消费，不写入 Profer 普通对话 transcript。
    if (!input.suppressUserMessagePersistence) {
      const userSDKMsg: SDKMessage = {
        type: 'user',
        message: {
          content: [{ type: 'text', text: userMessage }],
        },
        parent_tool_use_id: null,
        // 1.7.1：透传前端预生成的 uuid，使乐观气泡与持久化消息可按 uuid 匹配去重
        ...(input.uuid ? { uuid: input.uuid } : {}),
        // 旧调用方仍可使用 Goal 标记；新的 internalPrompt 路径不会写入消息。
        ...(input.triggeredBy === 'goal' ? { _goalIteration: input.goalIteration ?? true } : {}),
        _createdAt: Date.now(),
      } as unknown as SDKMessage
      this.sessionPort.appendMessages(sessionId, [userSDKMsg])
      // 运行中的用户输入只有本地乐观气泡是不够的：手机端（Pocket）没有这份本地状态，
      // 只能靠事件流看到电脑端发起的指令。桌面渲染层不消费 user 文本事件、乐观气泡
      // 按 uuid 去重，因此这里广播不会在电脑上产生重复气泡。
      this.eventPort.emit(sessionId, { kind: 'sdk_message', message: userSDKMsg })
    }
    await callbacks.onRunStarted?.({ startedAt: streamStartedAt })
      const completeRun = (messages?: AgentMessage[], opts?: CompleteOptions): void => {
      // 真正的 complete 必须等 owner finally 释放 activeSessions 后才通知 renderer，
      // 否则 UI 会先开放发送、主进程仍拒绝，导致用户草稿被清空。
      pendingTerminalCompletion = { messages, opts }
    }
    // 轻量完成：turn 主体结束但仍有后台任务在飞行。
    // 关键区别——不释放 active ownership，保留 adapter 通道与权限状态，
    // 以便 ① adapter 保持的通道在任务完成时自动续轮 ② 用户在等待期手动注入消息能复用通道。
    // UI 侧通过 backgroundTasksPending 进入"空闲可输入"态（spinner 停、输入框启用）。
    const idleComplete = (
      messages?: AgentMessage[],
        opts?: {
          startedAt?: number
          resultSubtype?: string
          resultErrors?: string[]
        },
    ): void => {
        callbacks.onComplete(messages, {
          ...opts,
          backgroundTasksPending: true,
        })
    }
      const failRun = (error: string, messages?: AgentMessage[], opts?: CompleteOptions): void => {
      callbacks.onError(error)
      runEndedWithError = true
      completeRun(messages, opts)
    }

    // 3. 构建本轮专属 SDK 环境。绝不修改主进程 process.env，避免并发 session 串扰凭证。
    const configuredModelId = modelId || DEFAULT_MODEL_ID
    // 渠道模型上的「1M」勾选决定本轮是否按 1M 上下文处理：
    // true 强开（未验证的网关也允许）、false 强关、缺省按模型 + provider 自动判定。
    // 模型 ID 比较不区分大小写（历史配置里存在 MiniMax-M3 这类写法差异）。
    const configuredModelKey = configuredModelId.toLowerCase()
    const configuredChannelModel = channel.models.find((model) => model.id.toLowerCase() === configuredModelKey)
    const context1mPreference = configuredChannelModel?.context1m ?? null
      const modelRouting = resolveAgentModelRouting({
        modelId: configuredModelId,
        provider: channel.provider,
        context1m: context1mPreference,
      })
    // 模型 ID 变体与 1M beta 必须一起决定，否则会出现「有后缀无 beta」的伪 1M。
    const sdk1MSelection = resolveAgentSdk1MSelection(configuredModelId, channel.provider, context1mPreference)
    const oneMillionContextEnabled = sdk1MSelection.oneMillionContextEnabled
    const effectiveSdkModelId = sdk1MSelection.modelId
    const initialContextWindow = inferAgentSdkContextWindow(configuredModelId, channel.provider, context1mPreference)
    if (agentRuntime === 'claude' && initialContextWindow != null) {
      // 兼容网关可能剥掉 [1m] 后缀或不返回 modelUsage；启动时先同步本轮最终窗口。
      this.eventPort.emit(sessionId, {
        kind: 'profer_event',
        event: { type: 'context_window', contextWindow: initialContextWindow },
      })
    }
    let sdkEnv = await this.buildSdkEnv(runtimeCredentials)
    applyAgentModelRoutingToEnv(sdkEnv, modelRouting)

    // 4. 读取已有的 SDK session ID（用于 resume）
    const sessionMeta = this.sessionPort.getMeta(sessionId)
    // Goal 只使用自己的 runtime session；普通会话的 SDK session 不得作为 resume 来源。
    let existingSdkSessionId = input.isolatedRuntimeSession ? input.runtimeSessionId : sessionMeta?.sdkSessionId

    // 4.1 检测回退后的 resume 截断点（快照回退功能）
    let rewindResumeAt: string | undefined
    if (sessionMeta?.resumeAtMessageUuid) {
      rewindResumeAt = sessionMeta.resumeAtMessageUuid
      // 消费一次后清除
      this.sessionPort.updateMeta(sessionId, { resumeAtMessageUuid: undefined })
      console.log(`[Agent 编排] 检测到回退 resume: resumeSessionAt=${rewindResumeAt}`)
    }

    console.log(`[Agent 编排] Resume 状态: sdkSessionId=${existingSdkSessionId || '无'}, proma sessionId=${sessionId}`)

    // 6. 状态初始化
    const accumulatedMessages: SDKMessage[] = []
    let resolvedModel = modelId || DEFAULT_MODEL_ID
    let agentCwd: string | undefined
    let workspaceSlug: string | undefined
    let workspace: import('@profer/shared').AgentWorkspace | undefined

      // 8. Claude runtime 才需要验证其 bundled CLI；Pi 是 in-process runtime。
      const skillToolInventory = captureSkillToolInventory(await import('@anthropic-ai/claude-agent-sdk'))
      const sdk = skillToolInventory.sdk
      const cliPath = agentRuntime === 'claude' ? resolveSDKCliPath() : undefined

      if (agentRuntime === 'claude' && (!cliPath || !existsSync(cliPath))) {
        const subpkg = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`
        console.error(`[Agent 编排] SDK native binary 不存在: ${cliPath}`)
        reportPreflightError({
          code: 'claude_binary_not_found',
          title: 'Claude 核心未就绪',
          message:
            '应用安装包里缺少 Claude Agent SDK 的核心可执行文件（claude.exe）。这通常是打包时未包含当前平台的 SDK 组件导致。请重新下载最新安装包，或提交 issue 告知我们。',
          details: [`缺失文件: ${cliPath}`, `需要的子包: ${subpkg}`],
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
        `[Agent 编排] 启动 ${agentRuntime} runtime — ${agentRuntime === 'claude' ? `binary: ${cliPath}` : 'in-process Pi'}，模型: ${modelId || DEFAULT_MODEL_ID}, resume: ${existingSdkSessionId ?? '无'}`,
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
        } catch {
          /* 文件不存在或解析失败 */
        }
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

      // Pi/Claude 都要求 Write 不能隐式创建父目录；产品约定的计划目录在这里显式准备。
      if (workspaceSlug) {
        const planDir = join(agentCwd, '.context', 'plan')
        if (!existsSync(planDir)) mkdirSync(planDir, { recursive: true })
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
      // Agent 预设提前解析：MCP 白名单裁剪在构建时生效；提示词/权限/effort 注入在后面复用同一对象。
      ensurePresetSystemReady()
      const presetSessionMeta = this.sessionPort.getMeta(sessionId)
      const sessionPreset = presetSessionMeta?.presetReference
        ? getAgentPresetByReference(presetSessionMeta.presetReference, workspaceSlug)
        : getAgentPresetByReference(presetReferenceForId(workspaceSlug, presetSessionMeta?.presetId), workspaceSlug)
      // 先把已解析预设转换为本轮冻结的有效策略；allowSubagents=false 等价禁用协作工具。
      const pptDecision = evaluatePptCapability({
        userMessage,
        active: presetSessionMeta?.pptCapabilityActive === true,
        hasActiveDeckProject: presetSessionMeta?.pptCapabilityActive === true,
      })
      const pptCapabilityActive = !sessionPreset.disabledToolGroups?.includes('ppt-materials') && pptDecision.active
      if (presetSessionMeta && pptCapabilityActive !== (presetSessionMeta.pptCapabilityActive === true)) {
        try {
          this.sessionPort.updateMeta(sessionId, { pptCapabilityActive })
        } catch {
          // 会话可能在并发删除；本轮仍使用已计算的 gate 结果。
        }
      }
      const presetOperationSource = input.triggeredBy ?? 'user'
      const pendingPresetChange = getPendingPresetChange(sessionId)
      const userConfirmedPresetChange = presetOperationSource === 'user'
        && pendingPresetChange !== undefined
        && isPresetChangeConfirmation(userMessage)
      if (presetOperationSource === 'user' && pendingPresetChange && isPresetChangeCancellation(userMessage)) {
        clearPendingPresetChange(sessionId)
      }
      const allowedPresetOperations = presetOperationSource === 'user'
        ? [
            ...evaluateAgentPresetOperationIntents(userMessage),
            ...(userConfirmedPresetChange ? ['commit_change' as const] : []),
          ]
        : []
      const currentPresetReference = presetSessionMeta?.presetReference
        ?? presetReferenceForId(workspaceSlug, presetSessionMeta?.presetId)
      const presetPolicy = createEffectiveAgentPresetPolicy(
        sessionPreset,
        currentPresetReference,
        {
          permissionMode: input.permissionModeOverride,
          triggeredBy: input.triggeredBy === 'goal' ? 'goal' : undefined,
          pptCapabilityActive,
          runtimeSupportsSubagents: this.adapter.getRuntimeCapabilities?.(agentRuntime)?.runtimeSupportsSubagents
            ?? this.adapter.getCapabilities?.().runtimeSupportsSubagents
            ?? false,
        },
      )
      const userBrowserContext = browserController.getUserContext(sessionId)
      const promptMode = selectAgentPromptMode({
        message: runtimeUserMessage,
        hasRuntimeSession: !!existingSdkSessionId,
        hasHistory: !existingSdkSessionId && (this.sessionPort.getMessages?.(sessionId).length ?? 0) > 1,
        hasBrowserContext: !!userBrowserContext,
        hasAttachedResources: !!sessionMeta?.attachedDirectories?.length || !!sessionMeta?.attachedFiles?.length,
        hasPresetInstructions: !!sessionPreset.promptSections?.length,
        permissionMode: presetPolicy.permissionMode,
        request: input,
      })
      this.activePromptModes.set(sessionId, promptMode)

      const disabledToolGroups = new Set(presetPolicy.disabledToolGroups)
      const disabledTools = presetPolicy.disabledTools ? [...presetPolicy.disabledTools] : undefined
      // Claude 原生工具不经过 in-process MCP，必须通过 SDK disallowedTools 同步硬禁用。
      const disabledClaudeTools = [
        ...AGENT_PRESET_CAPABILITY_GROUPS
          .filter((group) => presetPolicy.disabledToolGroups.includes(group.id))
          .flatMap((group) => group.toolNames),
        ...(disabledTools ?? []),
      ].filter((name) => name === 'WebSearch' || name === 'WebFetch')
        .filter((name, index, names) => names.indexOf(name) === index)
      const mcpServers = promptMode === 'light' ? {} : this.buildMcpServers(sessionId, workspaceSlug, presetPolicy.allowedMcpServerNames ? [...presetPolicy.allowedMcpServerNames] : undefined)
      // 先建立运行策略快照，再执行异步 MCP 注入，避免初始化期间的队列消息失去预设过滤。
      this.activePresetPolicies.set(sessionId, withLoadedMcpServerNames(presetPolicy, Object.keys(mcpServers)))
      if (promptMode === 'standard') {
        if (!disabledToolGroups.has('automation')) {
          await injectAutomationMcpServer(
            sdk,
            mcpServers,
            {
            sessionId,
            channelId,
            modelId,
            workspaceId,
            triggeredBy: input.triggeredBy as 'user' | 'automation' | undefined,
            },
            disabledTools,
          )
        }
        if (!disabledToolGroups.has('memory')) {
          await injectMemoryArchiveMcpServer(
            sdk,
            mcpServers,
            {
            memoryArchivePath: workspaceSlug ? getWorkspaceMemoryArchivePath(workspaceSlug) : undefined,
            workspaceSlug,
            },
            disabledTools,
          )
        }
        if (!disabledToolGroups.has('collaboration')) {
          await injectAgentCollaborationMcpServer(
            sdk,
            mcpServers,
            {
            sessionId,
            channelId,
            modelId,
            workspaceId,
            permissionMode: input.permissionModeOverride,
            triggeredBy: input.triggeredBy,
            },
            disabledTools,
          )
        }
        if (!disabledToolGroups.has('task-graph')) {
          await injectTaskGraphMcpServer(sdk, mcpServers, { sessionId }, disabledTools)
        }
        if (agentRuntime === 'claude' && input.reportGoalResult) {
          await injectGoalMcpServer(sdk, mcpServers, {
            iteration: input.goalIteration ?? 0,
            report: input.reportGoalResult,
          })
        }
        await injectAgentPresetMcpServer(sdk, mcpServers, {
          sessionId,
          workspaceSlug,
          source: presetOperationSource,
          allowedOperations: allowedPresetOperations,
          currentPresetReference,
          userMessage,
          pendingChange: userConfirmedPresetChange ? pendingPresetChange : undefined,
        })
        if (agentRuntime === 'claude' && !disabledToolGroups.has('automation')) {
          await injectPlanningMcpServer(sdk, mcpServers, {
            sessionId,
            workspaceId,
            disabledTools,
          })
        }
      }
      // 本地图片输出只在受工作区授权的会话注册；没有 workspace 的 cwd 是 homedir，不能默认授权整个用户目录。
      const attachedPreviewRoots = collectAttachedDirectories({
        extraDirs: additionalDirectories,
        sessionMeta,
        workspaceSlug,
      })
      const previewAllowedRoots = [
        // 产品自有产物目录（皮肤库/插件/Skill/附件）也是 Agent 产物的落地位置：
        // 不加进来，create_skin 产出的皮肤预览、Agent 自己写的本地页面都过不了授权根。
        ...(workspaceSlug && agentCwd ? [agentCwd] : []),
        ...attachedPreviewRoots,
        ...collectProductArtifactDirectories(),
      ]
      const imageOutputAllowedRoots = workspaceSlug && agentCwd ? previewAllowedRoots : []
      const emitImageGenerationUpdate = (record: import('@profer/shared').AgentImageGenerationCard): void => {
        this.eventPort.emit(sessionId, {
          kind: 'profer_event',
          event: { type: 'image_generation_updated', sessionId, record },
        })
      }
      let planModeEntered = presetPolicy.permissionMode === 'plan'
      const assertCanPresentVisualization = (): void => {
        if (this.stoppedBySessions.has(sessionId) || this.activeSessions.get(sessionId) !== runGeneration) throw new Error('本轮已取消，不能公布可视化')
        if (planModeEntered || (this.sessionPermissionModes.get(sessionId) ?? presetPolicy.permissionMode) === 'plan') throw new Error('计划模式不能公布可视化；请先完成计划审批')
      }
      const emitVisualizationUpdate = (record: import('@profer/shared').VisualizationRecord): void => {
        this.eventPort.emit(sessionId, { kind: 'profer_event', event: { type: 'visualization_updated', sessionId, record } })
      }
      if (promptMode === 'standard') {
        if (agentRuntime === 'claude' && workspaceSlug && agentCwd && !disabledToolGroups.has('preview')) {
          await injectVisualizationMcpServer(sdk, mcpServers, {
            sessionId, agentCwd, storageDir: agentSessionVisualizationsDir(sessionId), allowedRoots: previewAllowedRoots, onUpdate: emitVisualizationUpdate, assertCanPresent: assertCanPresentVisualization,
          }, disabledTools)
        }
        if (agentRuntime === 'claude' && !disabledToolGroups.has('preview')) {
          await injectAgentPreviewMcpServer(sdk, mcpServers, {
            sessionId,
            agentCwd: workspaceSlug ? agentCwd : '',
            allowedRoots: previewAllowedRoots,
            onRequest: (event) => this.previewPort.open(event),
            onInspectRequest: (request) => this.previewPort.inspect(request),
          }, disabledTools)
        }
        if (agentCwd && imageOutputAllowedRoots.length > 0 && !disabledToolGroups.has('image')) {
          await injectAgentImageOutputMcpServer(sdk, mcpServers, {
            agentCwd,
            allowedRoots: imageOutputAllowedRoots,
          }, disabledTools)
          if (agentRuntime === 'claude' && isAgentGptImageAvailable()) {
            await injectAgentGptImageMcpServer(sdk, mcpServers, {
              sessionId,
              agentCwd,
              allowedRoots: imageOutputAllowedRoots,
              onGenerationUpdate: emitImageGenerationUpdate,
            }, disabledTools)
          }
          if (agentRuntime === 'claude') {
            await injectAgentSkinMcpServer(sdk, mcpServers, {
              agentCwd,
              allowedRoots: imageOutputAllowedRoots,
              workspaceSlug,
            }, disabledTools)
          }
        }
        if (pptCapabilityActive) {
          await injectPptDeliveryMcpServer(sdk, mcpServers, disabledTools)
        }

        // Claude 通过 in-process MCP 使用与 Pi 相同的受管浏览器 controller；Pi 在后续分支注册 customTools。
        if (agentRuntime === 'claude' && !disabledToolGroups.has('clipboard')) {
          await injectClaudeClipboardMcpServer(sdk, mcpServers, disabledTools)
        }
        if (agentRuntime === 'claude' && !disabledToolGroups.has('browser')) {
          await injectClaudeBrowserMcpServer(sdk, mcpServers, {
            sessionId,
            workspaceId,
            agentCwd,
            allowedRoots: [
              ...new Set(
                [
              workspaceId ? agentCwd : undefined,
                  ...collectAttachedDirectories({
                    extraDirs: additionalDirectories,
                    sessionMeta,
                    workspaceSlug,
                  }),
                  ...collectProductArtifactDirectories(),
                ].filter((root): root is string => typeof root === 'string' && root.length > 0),
              ),
            ],
            executionSource: input.triggeredBy ?? 'user',
            disabledTools,
          })
        }

      }

      const pluginTools = promptMode === 'light' ? [] : await buildPluginAgentTools(sdk, mcpServers, (server, tool) =>
        isEffectiveAgentPresetMcpServerAllowed(presetPolicy, server)
        && !disabledTools?.includes(tool)
        && !disabledTools?.includes(`mcp__${server}__${tool}`),
      )

      // 合并外部注入的自定义 MCP 服务器（如飞书群聊工具），同样受当前预设白名单约束。
      if (promptMode === 'standard' && customMcpServers) {
        const customEntries = Object.entries(customMcpServers)
          .filter(([name]) => isEffectiveAgentPresetMcpServerAllowed(presetPolicy, name))
          // 外部 MCP 不得覆盖 Profer 已注册的内置 MCP（如 automation/planning）。
          .filter(([name]) => !Object.prototype.hasOwnProperty.call(mcpServers, name))
        Object.assign(mcpServers, Object.fromEntries(customEntries))
        const rejectedCount = Object.keys(customMcpServers).length - customEntries.length
        if (rejectedCount > 0) {
          console.log(`[Agent 编排] 预设 MCP 白名单裁剪了 ${rejectedCount} 个外部 MCP 服务器`)
        }
        console.log(`[Agent 编排] 已合并 ${customEntries.length} 个自定义 MCP 服务器`)
      }
      // 队列消息复用当前 SDK 运行时，必须使用本轮真正加载的能力快照；会话内切换预设只影响下一轮。
      const activePresetPolicy = this.activePresetPolicies.get(sessionId)
      if (activePresetPolicy) {
        this.activePresetPolicies.set(sessionId, withLoadedMcpServerNames(activePresetPolicy, Object.keys(mcpServers)))
      }

      // 11. 构建动态上下文和最终 prompt
      const dynamicCtx = promptMode === 'light' ? '' : buildDynamicContext({
        workspaceName: workspace?.name,
        workspaceSlug,
        agentCwd,
        mcpServerNames: Object.keys(mcpServers),
        disabledToolGroups: [...disabledToolGroups].filter((group): group is import('@profer/shared').AgentPresetToolGroup => AGENT_PRESET_CAPABILITY_GROUPS.some((item) => item.id === group)),
        disabledTools,
        userBrowserContext,
      })

      // 11.5 注入 mention 引用指令（Skill/MCP/会话）— 仅引用当前预设实际可用的能力。
      let enrichedMessage = runtimeUserMessage
      const referencedSessionsBlock = buildReferencedSessionsPrompt(sessionId, mentionedSessionIds, workspaceId)
      if (referencedSessionsBlock) {
        enrichedMessage = `${referencedSessionsBlock}\n\n${enrichedMessage}`
        console.log(`[Agent 编排] 注入 referenced_sessions: ${mentionedSessionIds?.length ?? 0} sessions`)
      }
      const allowedMentionedMcpServers = mentionedMcpServers?.filter((name) =>
        Object.prototype.hasOwnProperty.call(mcpServers, name),
      ) ?? []
      const toolLines: string[] = []
      for (const name of allowedMentionedMcpServers) {
        toolLines.push(`- MCP 服务器: ${name}（请使用此 MCP 服务器的工具来完成任务）`)
      }
      if (toolLines.length > 0) {
        enrichedMessage = `<mentioned_tools>\n用户在消息中明确引用了以下当前预设可用的工具，请在本次回复中主动调用：\n${toolLines.join('\n')}\n</mentioned_tools>\n\n${enrichedMessage}`
        console.log(`[Agent 编排] 注入 mentioned_tools: ${toolLines.length} 条（原始 ${mentionedSkills?.length ?? 0} skills, ${mentionedMcpServers?.length ?? 0} MCP）`)
      }

      let contextualMessage = [dynamicCtx, enrichedMessage].filter(Boolean).join('\n\n')

      const isCompactCommand = runtimeUserMessage.trim() === '/compact'
      let finalPrompt = isCompactCommand
        ? '/compact'
        : promptMode === 'light' || existingSdkSessionId
          ? contextualMessage
          : goalIsolated
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
      // Agent 预设：会话绑定的预设可覆盖权限模式与推理档位，并在系统提示词后追加预设专属段（sessionPreset 已在步骤 10 解析）。
      const initialPermissionMode: ProferPermissionMode = presetPolicy.permissionMode
      // Harness 默认启用；设置 PROFER_PI_HARNESS=0 可按进程关闭。初始化失败不能阻断普通 Agent turn。
      // Stop 可能发生在前面的异步 preflight 期间，此时不能再晚建 scope，
      // 否则 finally 会把用户主动停止的 Turn 误记为 completed。
      if (promptMode === 'standard' && shouldStartPiHarness(agentRuntime)) {
        if (this.stoppedBySessions.has(sessionId)) {
          harnessStopped = true
          console.log(`[Pi Harness] 检测到 scope 初始化前已停止，跳过本轮 scope (${sessionId})`)
        } else {
          try {
            piHarnessScope = startPiHarnessRun({
              sessionId,
              userMessage: runtimeUserMessage,
              prompt: finalPrompt,
              permissionMode: initialPermissionMode,
              manualCandidateContinuationTicket: input.piHarnessManualContinuationTicket,
            })
            if (piHarnessScope) finalPrompt = piHarnessScope.prompt
          } catch (error) {
            console.warn(`[Pi Harness] scope 初始化失败，继续普通 Pi turn (${sessionId}):`, error)
          }
        }
      }

      // 受管浏览器允许读取的根目录 = 会话工作目录 + 会话/工作区已授权目录（后者含工作区根与 workspace-files）。
      const browserAllowedRoots = [
        ...new Set(
          [
        workspaceId ? agentCwd : undefined,
            ...collectAttachedDirectories({
              extraDirs: additionalDirectories,
              sessionMeta,
              workspaceSlug,
            }),
            ...collectProductArtifactDirectories(),
          ].filter((root): root is string => typeof root === 'string' && root.length > 0),
        ),
      ]
      // Claude SDK 原生接收 mcpServers；Pi 必须将同一配置连接后转换为 customTools。
      // 在这里复用已完成的 Profer MCP 注入和过滤流程，避免两套配置来源漂移。
      let piCollaborationAvailable: boolean | undefined
      const piCustomTools =
        agentRuntime === 'pi' && promptMode === 'standard'
        ? await (async () => {
            const piSdk = await import('@earendil-works/pi-coding-agent')
            const builtin = await this.buildPiBuiltinTools(piSdk, {
              sessionId,
              channelId,
              modelId,
              agentRuntime,
              workspaceId,
              workspaceSlug,
              agentCwd,
              allowedRoots: browserAllowedRoots,
              visualizationStorageDir: workspaceSlug && agentCwd ? agentSessionVisualizationsDir(sessionId) : undefined,
              onVisualizationUpdate: emitVisualizationUpdate,
              assertCanPresentVisualization,
              onPreviewRequest: (event) => this.previewPort.open(event),
              onPreviewInspectRequest: (request) => this.previewPort.inspect(request),
              permissionMode: initialPermissionMode,
              triggeredBy: input.triggeredBy,
              goalIteration: input.goalIteration,
              reportGoalResult: input.reportGoalResult,
              allowedPresetOperations,
              currentPresetReference,
              presetOperationUserMessage: userMessage,
              pendingPresetChange: userConfirmedPresetChange ? pendingPresetChange : undefined,
              disabledToolGroups: [...disabledToolGroups],
              disabledTools,
              pptCapabilityActive,
            })
            const mcpTools = await buildPiMcpTools(mcpServers, presetPolicy)
            const preparedToolsContext = {
              sessionId,
              channelId,
              modelId,
              workspaceId,
              workspaceSlug,
              agentCwd,
              permissionMode: initialPermissionMode,
              triggeredBy: input.triggeredBy,
              disabledToolGroups: [...disabledToolGroups],
              disabledTools,
              allowedPresetOperations,
              currentPresetReference,
              collaborationAvailable: builtin.collaborationAvailable,
            }
            piCollaborationAvailable = preparedPiToolsCollaborationAvailable({ context: preparedToolsContext, builtin, mcpTools, pluginTools })
            return buildPreparedPiTools({ context: preparedToolsContext, builtin, mcpTools, pluginTools })
          })()
        : undefined
      // 注册到 Map，支持运行中动态切换
      this.sessionPermissionModes.set(sessionId, initialPermissionMode)
      console.log(`[Agent 编排] 权限模式: ${initialPermissionMode}${permissionModeOverride ? '（外部覆盖）' : ''}`)

      const emitPlanModeChanged = (active: boolean, source: 'initial' | 'tool' | 'permission'): void => {
        this.eventPort.emit(sessionId, {
          kind: 'profer_event',
          event: { type: 'plan_mode_changed', sessionId, active, source },
        })
      }

      // 当初始模式为 plan 时，通知渲染进程展示计划模式 UI（如「Agent 正在规划」横幅）
      if (initialPermissionMode === 'plan') {
        this.eventPort.emit(sessionId, {
          kind: 'profer_event',
          event: { type: 'enter_plan_mode', sessionId },
        })
        emitPlanModeChanged(true, 'initial')
      }

      /** 读取当前会话的实时权限模式（支持运行中切换） */
      const getPermissionMode = (): ProferPermissionMode => this.sessionPermissionModes.get(sessionId) ?? initialPermissionMode

      // ExitPlanMode 拦截器：plan 模式下走 UI 审批流程
      const handleExitPlanMode = (toolInput: Record<string, unknown>, signal: AbortSignal): Promise<ExitPlanPermissionResult> => {
        return this.permissionPort.handleExitPlanMode?.({
          sessionId,
          toolInput,
          signal,
          sendToRenderer: (request: ExitPlanModeRequest) => {
            this.eventPort.emit(sessionId, {
              kind: 'profer_event',
              event: { type: 'exit_plan_mode_request', request },
            })
          },
        }) as Promise<ExitPlanPermissionResult>
      }

      // 始终创建 auto 权限回调（运行中可能切换到 auto）
      const autoCanUseTool = this.permissionPort.createCanUseTool?.({
        sessionId,
        sendPermissionRequest: (request: PermissionRequest) => {
          this.eventPort.emit(sessionId, {
            kind: 'profer_event',
            event: { type: 'permission_request', request },
          })
        },
          handleAskUser: (sid, toolInput, signal, sendAskUser) => this.permissionPort.handleAskUserQuestion?.({
          sessionId: sid,
          toolInput,
          signal,
          sendToRenderer: sendAskUser,
        }) ?? Promise.resolve({ behavior: 'deny' as const, message: 'AskUser 服务不可用' }),
        sendAskUserRequest: (request: AskUserRequest) => {
          this.eventPort.emit(sessionId, {
            kind: 'profer_event',
            event: { type: 'ask_user_request', request },
          })
        },
      }) as RuntimeCanUseTool

      // 计划模式只读工具面（Bash 只读判定 / 白名单 / 延迟工具）的唯一实现已提取到
      // `plan-mode-tool-policy.ts`（GAP-5），此处只持有共享策略实例，不再保留局部副本。
      const planToolPolicy = createPlanModeToolPolicy(agentCwd)

      // 计划状态供工具公布守卫和权限审批共同读取，避免进入计划后只更新 UI。
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

        const writeParentFailure = validateWriteTargetParent(input, agentCwd, toolName)
        if (writeParentFailure) {
          console.warn(`[Agent 工具验证] Write 父目录不存在: tool=${toolName}, path=${String(input.file_path ?? input.path)}`)
          return writeParentFailure
        }

        // 非 Windows 平台上的 Windows 绝对路径会被 node:path 当成相对路径拼进会话目录，
        // 产生误导性的「文件不存在」。在共享边界直接纠正，两套 runtime 同享。
        const platformPathFailure = validateToolPathPlatform(toolName, input)
        if (platformPathFailure) {
          console.warn(`[Agent 工具验证] 平台路径不匹配: tool=${toolName}, path=${String(input.file_path ?? input.path)}`)
          return platformPathFailure
        }

        // ── Write 大文件 token 截断防护 ──
        if (toolName === 'Write' && typeof input.content === 'string') {
          const estimatedTokens = estimateTokenCount(input.content)
          if (estimatedTokens > WRITE_CONTENT_TOKEN_THRESHOLD) {
            console.warn(`[Agent 工具验证] Write 内容过大: tokens≈${estimatedTokens}, chars=${input.content.length}, file=${String(input.file_path)}`)
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
          this.eventPort.emit(sessionId, {
            kind: 'profer_event',
            event: { type: 'enter_plan_mode', sessionId },
          })
          return { behavior: 'allow' as const, updatedInput: input }
        }

        // AskUserQuestion：始终走交互式问答流程，不受权限模式影响
        if (toolName === 'AskUserQuestion') {
          return this.permissionPort.handleAskUserQuestion?.({
            sessionId,
            toolInput: input,
            signal: options.signal,
            sendToRenderer: (request: AskUserRequest) => {
              this.eventPort.emit(sessionId, {
                kind: 'profer_event',
                event: { type: 'ask_user_request', request },
              })
            },
          }) as Promise<PermissionResult>
        }

        // ── 受管浏览器：计划模式只读门禁 ──
        // 必须在通用权限 switch 之前：该 switch 的每个分支都会 return，
        // 放在其后会变成不可达代码，导致计划模式下 Browser 白名单从未生效。
        // 非 plan 模式不在这里处理，直接交给下面 switch，保持 auto / bypassPermissions 既有行为。
        // 受管浏览器对所有 Agent 会话开放；主进程仍隔离网页，并拒绝私网、下载、弹窗和网页权限，
        // 页面内容始终视为不可信输入。
        if (currentMode === 'plan' && isBrowserToolName(toolName)) {
          const decision = resolvePlanModeBrowserPermission(toolName)
          return decision.behavior === 'allow'
            ? { behavior: 'allow' as const, updatedInput: input }
            : { behavior: 'deny' as const, message: decision.message ?? '计划模式下不允许进行网页交互。' }
        }

        // ── 普通工具的权限分派 ──

        switch (currentMode) {
          case 'bypassPermissions':
            return { behavior: 'allow' as const, updatedInput: input }

          case 'plan': {
            // Plan 模式：只读工具面由共享策略唯一实现（GAP-5），本处不再保留第二份规则。
            const planDecision = planToolPolicy({ toolName, toolInput: input })
            if (planDecision) {
              return planDecision.behavior === 'allow'
                ? { behavior: 'allow' as const, updatedInput: input }
                : { behavior: 'deny' as const, message: planDecision.message ?? '计划模式下不允许该操作' }
            }
            // 宿主自有工具（AskUserQuestion / EnterPlanMode / ExitPlanMode）与受管浏览器已在
            // switch 之前处理，不会走到这里；保守拒绝，绝不静默放行。
            return {
              behavior: 'deny' as const,
              message: '计划模式下不允许执行写操作，请在计划审批通过后再执行',
            }
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
      const maxTurns = appSettings.agentMaxTurns && appSettings.agentMaxTurns > 0 ? appSettings.agentMaxTurns : undefined
      const promptPolicy = resolveAgentSystemPromptPolicy(appSettings)
      const selectedModelId = modelId || DEFAULT_MODEL_ID
      const allAdditionalDirectories = collectAttachedDirectories({
        extraDirs: additionalDirectories,
        sessionMeta,
        workspaceSlug,
      })
      const runtimeSkills = promptMode === 'standard' && workspaceSlug ? prepareRuntimeSkills(workspaceSlug) : undefined
      // 快照与工具清单必须基于同一份冻结策略，否则依赖检查与预设过滤会各按一份规则判断。
      const skillRoutingPolicy = this.activePresetPolicies.get(sessionId) ?? presetPolicy
      const skillRouting = await prepareAgentSkillRouting({
        projection: runtimeSkills,
        policy: skillRoutingPolicy,
        toolNames: agentRuntime === 'pi'
          ? ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', ...(piCustomTools?.map(getMcpPolicyToolName) ?? [])]
          : await skillToolInventory.getToolNames(mcpServers, skillRoutingPolicy),
      })
      resolveSkillRouting(skillRouting.snapshot)
      const routedSkills: SkillRoutingResult = promptMode === 'light'
        ? { prompt: '', selected: [], recommended: [], hints: [], diagnostics: [] }
        : routeSkillsForTask(skillRouting.snapshot, { userMessage, mentionedSkills })
      // 不污染用户持久化文本；仅本轮与 recovery prompt 携带已审查的路由结果。
      if (!isCompactCommand && routedSkills.prompt) {
        finalPrompt = `${routedSkills.prompt}\n\n${finalPrompt}`
        contextualMessage = `${routedSkills.prompt}\n\n${contextualMessage}`
      }
      if (!isCompactCommand && !input.suppressUserMessagePersistence) this.persistSkillRoutingNotice(sessionId, routedSkills)
      console.log('[Skill 路由]', JSON.stringify({ sessionId, allowed: skillRouting.snapshot.allowedSlugs, blocked: skillRouting.snapshot.skills.filter(skill => skill.blocked).map(skill => ({ slug: skill.slug, code: skill.blocked })), selected: routedSkills.selected, hints: routedSkills.hints, diagnostics: routedSkills.diagnostics }))
      const skillRuntimeOptions = buildSkillRuntimeOptions(skillRouting, promptMode === 'light' ? 'pi' : agentRuntime)
      const projectCandidates = promptMode === 'light' ? [] : detectAttachedDirectoryProjects(allAdditionalDirectories)
      const attachedDirectoriesPrompt = promptMode === 'light' ? '' : buildPiAdditionalDirectoriesPrompt(allAdditionalDirectories, projectCandidates)
      // Pi runtimeEnv 与旧链同源：宿主状态 / 登录 shell 快照 / 平台判定的唯一实现在
      // `agent-runtime-env-host.ts`（新链 provider preparation 调用同一个函数）。
      const piRuntimeEnv = agentRuntime === 'pi'
        ? await resolveHostAgentRuntimeEnv({ sessionId, cwd: agentCwd })
        : undefined
      const promptShellPath = agentRuntime === 'pi'
        ? piRuntimeEnv?.shellPath
        : process.env.SHELL
          ?? (process.platform === 'win32' ? undefined : process.platform === 'darwin' ? '/bin/zsh' : '/bin/sh')
      const promptAssembly = assembleAgentSystemPrompt({
        mode: promptMode,
        runtime: agentRuntime,
        policy: promptPolicy,
        context: {
          workspaceName: workspace?.name,
          workspaceSlug,
          sessionId,
          permissionMode: initialPermissionMode,
          presetName: presetPolicy.preset.name,
          allowedPresetOperations,
          // 方案 3：工具组禁用同步隐藏提示词段落，自动映射来自 shared 唯一事实表
          // （task-graph→task-graph、memory→memory、collaboration→subagents、automation→automation）
          suppressSections: [...presetPolicy.suppressPromptSections],
          claudeAvailable,
          deepSeekSubagentModel: modelRouting.subagentModel,
          isPiRuntime: agentRuntime === 'pi',
          disabledToolGroups: [...disabledToolGroups].filter((group): group is import('@profer/shared').AgentPresetToolGroup => AGENT_PRESET_CAPABILITY_GROUPS.some((item) => item.id === group)),
          disabledTools: disabledTools ? [...disabledTools] : undefined,
          pptCapabilityActive: presetPolicy.pptCapabilityActive,
          platform: process.platform,
          shellPath: promptShellPath,
          agentCwd,
          projectCandidates,
        },
        userMessage: runtimeUserMessage,
        toolNames: piCustomTools?.map((tool) => tool.name) ?? [],
        forceAutomation: input.triggeredBy === 'automation',
        skillCatalog: skillRuntimeOptions.skillCatalogPrompt,
        attachedDirectories: attachedDirectoriesPrompt,
        customSections: presetPolicy.preset.promptSections,
        automationContext,
      })
      console.log('[Agent 提示词]', JSON.stringify({
        sessionId, mode: promptMode, chars: promptAssembly.chars,
        permissionMode: presetPolicy.permissionMode, hasRuntimeSession: !!existingSdkSessionId,
        hasBrowserContext: !!userBrowserContext,
        hasAttachedResources: !!sessionMeta?.attachedDirectories?.length || !!sessionMeta?.attachedFiles?.length || !!input.additionalDirectories?.length,
        hasPresetInstructions: !!sessionPreset.promptSections?.length,
      }))
      // Pi 没有 Claude 的 file-history-snapshot；在每轮开始前保存工作区基线。
      // 编排层在该轮落盘后把基线绑定到 assistant entry，回退时由 session manager 恢复。
      // 基线存放在配置目录而非会话 cwd 内：它每轮一份全量副本，放进用户工作台会污染体积、
      // 且把快照目录放在被快照的树里本身就是隐患。
      let piCheckpointRoot: string | undefined
      let piTurnCheckpoint: ReturnType<typeof createPiFileCheckpoint> | undefined
      if (agentRuntime === 'pi') {
        // 文件回退是增强能力，绝不能因为权限、磁盘或第三方锁导致本轮模型请求失败。
        try {
          piCheckpointRoot = getPiCheckpointsDir()
          piTurnCheckpoint = createPiFileCheckpoint(sessionId, agentCwd, piCheckpointRoot)
        } catch (error) {
          console.warn(`[Agent 编排] Pi 文件检查点创建失败，本轮继续但不可文件回退 (${sessionId}):`, error)
        }
      }
      const browserAllowedToolAliases = SAFE_TOOLS
        .filter((toolName) => toolName.startsWith('Browser'))
        .map((toolName) => `mcp__browser__${toolName}`)
      const autoAllowedTools = [...new Set([...SAFE_TOOLS, ...browserAllowedToolAliases])]
      const sdkAllowedTools = sdkPermissionModeForProferMode(initialPermissionMode) === 'auto'
        ? { allowedTools: autoAllowedTools }
        : {}
      const piNativeRetryState = { exhausted: false }
      const queryOptions: AgentQueryInput & Record<string, unknown> = {
        sessionId,
        onRuntimeRegistered: () => resolveRuntimeRegistered(true),
        ...(promptMode === 'light' ? { tools: [] } : {}),
        agentRuntime,
        prompt: finalPrompt,
        // Pi must receive the channel model unchanged: Claude's `[1m]` suffix is not a provider model ID.
        model: agentRuntime === 'pi' ? selectedModelId : effectiveSdkModelId,
        cwd: agentCwd,
        ...(agentRuntime === 'claude' && { sdkCliPath: cliPath, env: sdkEnv }),
        ...(agentRuntime === 'pi' && {
          ...buildPiRuntimeCredentialOptions(channelId, runtimeCredentials),
          channelId,
          channelName: channel.name,
          // Pi 不做 SDK 侧 beta 協商，只用 1M 偏好决定注册的上下文窗口（影响压缩阈值与用量环）。
          ...(context1mPreference !== null && { context1m: context1mPreference }),
          permissionMode: initialPermissionMode,
          piAgentDir: getSdkConfigDir(),
          // Keep Pi JSONL session files below the SDK-isolated config directory, never in another workspace.
          piSessionDir: join(getSdkConfigDir(), 'sessions', 'pi'),
          // Pi model credentials stay in its request-local AuthStorage; never pass Claude auth env into Bash/tool processes.
          runtimeEnv: piRuntimeEnv,
          onToolExecutionResult: (toolCallId: string, result: CommandExecutionResult) => {
            executionResultsByToolUse.set(toolCallId, result)
          },
          onFileWrite: (toolCallId: string, fact: { path: string; source: string }) => {
            const existing = fileWritesByToolUse.get(toolCallId) ?? []
            if (!existing.some((item) => item.path === fact.path)) {
              existing.push(fact)
              fileWritesByToolUse.set(toolCallId, existing)
            }
          },
          onHarnessLifecycle: (event: import('./adapters/pi-harness-lifecycle').PiHarnessLifecycleEvent) => {
            piHarnessScope?.observeLifecycle(event)
          },
          thinkingLevel: resolvePiThinkingLevel(
            sessionMeta?.openAIThinkingLevel,
            // 预设 effort 作为无会话级覆盖时的默认档；会话级 agentEffort 手动切换优先
            {
              agentThinking: !(appSettings.agentThinking?.type === 'disabled'),
              agentEffort: sessionMeta?.agentEffort ?? presetPolicy.effort ?? appSettings.agentEffort,
            },
            channel.provider,
          ),
          additionalSkillPaths: skillRuntimeOptions.additionalSkillPaths,
          skillSlugs: skillRuntimeOptions.skillSlugs,
          skillMentions: skillRuntimeOptions.skillMentions,
          ...(piCustomTools && { prepared: { tools: piCustomTools, collaborationAvailable: piCollaborationAvailable } }),
          ...(sessionMeta?.codexFastMode && { codexFastMode: true }),
          ...(userMessage.trim() === '/compact' && { compactRequest: true }),
        }),
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
        ...sdkAllowedTools,
        ...(disabledClaudeTools.length > 0 && { disallowedTools: disabledClaudeTools }),
        // Claude 默认沿用 claude_code preset；Profer 只追加本轮按能力与策略组装的 prompt。
        systemPrompt: promptAssembly.systemPrompt,
        resumeSessionId: existingSdkSessionId,
        onRuntimeMessage: input.onRuntimeMessage,
        ...(input.isolatedRuntimeSession && {
          isolatedRuntimeSession: true,
          onRuntimeSessionId: input.onRuntimeSessionId,
        }),
        // 回退后 resume：从指定消息处继续（SDK 在同一 JSONL 内创建分支）
        ...(rewindResumeAt && { resumeSessionAt: rewindResumeAt }),
        ...(Object.keys(mcpServers).length > 0 && { mcpServers }),
        plugins: skillRuntimeOptions.plugins,
        skills: skillRuntimeOptions.skills,
        // 合并附加目录：用户当次输入 + 会话级 + 工作区级（详见 collectAttachedDirectories）
        ...(allAdditionalDirectories.length > 0 && {
          additionalDirectories: allAdditionalDirectories,
        }),
        // 启用文件检查点，支持 rewindFiles 回退
        enableFileCheckpointing: true,
        // SDK 0.2.52+ 新增选项（从 settings 读取）
        ...(appSettings.agentThinking && {
          thinking: appSettings.agentThinking,
        }),
        effort: sessionMeta?.agentEffort ?? presetPolicy.effort ?? appSettings.agentEffort ?? 'high',
        ...(appSettings.agentMaxBudgetUsd != null &&
          appSettings.agentMaxBudgetUsd > 0 && {
          maxBudgetUsd: appSettings.agentMaxBudgetUsd,
        }),
        // 按本轮最终 1M 选择注入 beta；用户显式开启未知模型时同样生效。
        ...(agentRuntime === 'claude' &&
          oneMillionContextEnabled && {
          betas: ['context-1m-2025-08-07'] as SdkBeta[],
        }),
        onStderr: (data: string) => {
          stderrChunks.push(data)
          console.error(`[Agent SDK stderr] ${data}`)
        },
        onSessionId: (sdkSessionId: string, piSessionFile?: string) => {
          // 仅在 session_id 真正变化时才持久化。SDK v2 几乎每条消息都会回调 onSessionId，
          // 旧逻辑误用「初始快照后永不更新」的 existingSdkSessionId 作比较（回调里更新的是
          // capturedSdkSessionId），导致新会话每条消息都全量读写会话索引（readIndex + 原子写 +
          // 备份），再叠加一次读回验证。历史会话多 + 多会话并发时引发同步 fsync 风暴，周期性
          // 卡死主进程事件循环。capturedSdkSessionId 已初始化为 existingSdkSessionId，并在
          // session-not-found 重试时与其同步重置，比较它即可正确判定「真正变化」。
          const isNewSessionId = sdkSessionId !== capturedSdkSessionId
          const latestSessionMeta = this.sessionPort.getMeta(sessionId)
          // Pi 同一 artifact 的每条消息都可能回调；仅在 artifact 真正更换（recovery 新建）时
          // 视为替换，此时旧 entry bindings 属于另一棵 Pi tree，必须原子替换而非合并。
          const artifactReplaced = !!piSessionFile && latestSessionMeta?.piSessionFile !== piSessionFile
          capturedSdkSessionId = sdkSessionId
          if (input.isolatedRuntimeSession && isNewSessionId) {
            input.onRuntimeSessionId?.(sdkSessionId, piSessionFile)
          }
          if (!input.isolatedRuntimeSession && (isNewSessionId || artifactReplaced)) {
            try {
              this.sessionPort.updateMeta(sessionId, {
                sdkSessionId,
                ...(piSessionFile ? { piSessionFile } : {}),
                ...(artifactReplaced ? { piEntryBindings: {} } : {}),
              })
              console.log(`[Agent 编排] 已保存 SDK session_id: ${sdkSessionId}`)
            } catch (err) {
              console.error(`[Agent 编排] 保存 SDK session_id 失败:`, err)
            }
          }
        },
        onModelResolved: (model: string) => {
          resolvedModel = model
          console.log(`[Agent 编排] SDK 确认模型: ${resolvedModel}`)
          // 通知渲染进程更新流式状态中的模型信息
          this.eventPort.emit(sessionId, {
            kind: 'profer_event',
            event: { type: 'model_resolved', model },
          })
        },
        onContextWindow: (cw: number) => {
          console.log(`[Agent 编排] 缓存 contextWindow: ${cw}`)
          // result 消息里的真实 contextWindow 透传到 renderer，
          // 覆盖流式过程中按模型名推断的 fallback 值（智谱等端点会把 [1m] 等后缀剥掉，导致 fallback 不准）
          this.eventPort.emit(sessionId, {
            kind: 'profer_event',
            event: { type: 'context_window', contextWindow: cw },
          })
        },
        // Pi 会话分叉/回退依赖 assistant UUID → Pi entry ID 映射；每轮落盘后合并增量映射。
        onPiEntryBindings: (bindings: Record<string, string>) => {
          const latest = this.sessionPort.getMeta(sessionId)
          const checkpoints = { ...(latest?.piFileCheckpoints ?? {}) }
          if (piTurnCheckpoint) {
            for (const entryId of Object.values(bindings)) checkpoints[entryId] = piTurnCheckpoint.path
          }
          // 每轮顺带回收检查点：未被回退点引用的目录直接删除，超出数量/体积上限的旧检查点
          // 一并删除并从映射里摘掉（该回退点会明确降级提示，而不是磁盘无限增长）。
          // 本轮新快照无论如何都在保留集内：bindings 为空时也不能把自己当孤儿删掉。
          // 分叉会话仍在引用的检查点同样视为已绑定，避免删掉别人还在用的回退点。
          const keepPaths = new Set(Object.values(checkpoints))
          if (piTurnCheckpoint) keepPaths.add(piTurnCheckpoint.path)
          for (const foreign of collectForeignCheckpointPaths(sessionId)) keepPaths.add(foreign)
          const prune = piTurnCheckpoint && piCheckpointRoot
            ? prunePiFileCheckpoints(piCheckpointRoot, sessionId, { keepPaths })
            : { removed: [], removedBound: 0 }
          const removedPaths = new Set(prune.removed)
          const keptCheckpoints = removedPaths.size > 0
            ? Object.fromEntries(Object.entries(checkpoints).filter(([, checkpointPath]) => !removedPaths.has(checkpointPath)))
            : checkpoints
          this.sessionPort.updateMeta(sessionId, {
            piEntryBindings: {
              ...(latest?.piEntryBindings ?? {}),
              ...bindings,
            },
            ...(piTurnCheckpoint ? { piFileCheckpoints: keptCheckpoints } : {}),
          })
        },
        onRetry: (retry: PiRetryUpdate) => {
          const normalizedRetry: PiRetryUpdate = retry.status === 'starting'
            ? { ...retry, reason: getRetryDisplayReason(channel.provider, retry.reason) }
            : retry.status === 'attempt'
              ? {
                  ...retry,
                  attemptData: {
                    ...retry.attemptData,
                    reason: getRetryDisplayReason(channel.provider, retry.attemptData.reason),
                    errorMessage: getRetryDisplayReason(channel.provider, retry.attemptData.errorMessage),
                  },
                }
              : retry.status === 'failed'
                ? {
                    ...retry,
                    attemptData: {
                      ...retry.attemptData,
                      reason: getRetryDisplayReason(channel.provider, retry.attemptData.reason),
                      errorMessage: getRetryDisplayReason(channel.provider, retry.attemptData.errorMessage),
                    },
                  }
                : retry
          this.eventPort.emit(sessionId, {
            kind: 'profer_event',
            event: { type: 'retry', ...normalizedRetry },
          })
        },
        onNativeRetryOutcome: (outcome: import('./adapters/pi-retry-control').PiNativeRetryOutcome) => {
          piNativeRetryState.exhausted = outcome === 'exhausted'
        },
      }

      console.log(`[Agent 编排] 开始通过 Adapter 遍历事件流...`)

      // 14. 遍历 Adapter 产出的 AgentEvent 流（含自动重试）
      let lastRetryableError: string | undefined
      let retryDelayElapsedMs = 0
      let retryAttemptsScheduled = 0
      let retrySucceeded = false
      // OpenAI 官方上游繁忙错误收敛为 8 次；其他瞬时错误保留通用上限。
      let retryMaxAttempts = MAX_AUTO_RETRIES
      let skipNextRetryDelay = false
      let thinkingSignatureRecoveryAttempted = false
      let invisibleRecoveryAttempts = 0
      // thinking-only 不是网络错误：最多做一次无感恢复，避免空回复触发 25 次长重试。
      let emptyOutputRecoveryAttempted = false
      /** 前 N 次自动重试静默执行，不向 UI 发送事件，减少网络瞬断时的界面噪音 */
      const RETRY_VISIBILITY_THRESHOLD = 0
      const canAutoRetry = (attempt: number, ...errorMessages: Array<string | undefined>): boolean => {
        if (piNativeRetryState.exhausted) return false
        retryMaxAttempts = Math.min(retryMaxAttempts, getMaxAutoRetries(channel.provider, ...errorMessages))
        return attempt <= retryMaxAttempts && retryDelayElapsedMs < MAX_AUTO_RETRY_WAIT_MS
      }

      // 记录交给 SDK 的脱敏路由输入；它证明本地配置，不宣称最终 TLS 对端。
      let agentUrlForLog: URL | undefined
      try {
        agentUrlForLog = new URL(runtimeCredentials.baseUrl ?? '')
      } catch {
        /* 无效 URL 将由 SDK/上游返回错误 */
      }
      console.info('[Agent 编排] SDK 路由输入:', {
        sessionId,
        channelId,
        provider: channel.provider,
        configuredModelId,
        effectiveSdkModelId,
        oneMillionContextEnabled,
        betaCount: oneMillionContextEnabled ? 1 : 0,
        authMode: runtimeCredentials.forceBearerAuth ? 'bearer' : 'api-key',
        agentUrlOrigin: agentUrlForLog?.origin ?? 'invalid',
        agentUrlPathname: agentUrlForLog?.pathname ?? '',
        appProxyEnabled: Boolean(sdkEnv.HTTP_PROXY || sdkEnv.HTTPS_PROXY),
      })

      let relayTokenRecoveryAttempted = false
      const recoverRelayTokenForAgent = async (): Promise<boolean> => {
        if (relayTokenRecoveryAttempted || (!runtimeCredentials.forceBearerAuth && channel.directDataPlane !== true)) return false
        relayTokenRecoveryAttempted = true

        const recovered = await editionProviders.account.recoverSession()
        if (!recovered) return false

        // 直连 canary 失败时同步一次渠道目录，将该用户切回 Relay；旧 Relay 令牌仍由服务端控制。
        if (channel.directDataPlane === true) {
          try {
            const { syncChannelsFromServer } = require('./channel-manager') as typeof import('./channel-manager')
            await syncChannelsFromServer(recovered.baseUrl, recovered.token)
          } catch (error) {
            console.warn('[Agent 编排] 直连失败后的 Relay 渠道同步失败:', error)
          }
        }
        const nextChannel = getChannelById(channelId)
        const nextCredentials = nextChannel
          ? await credentialPort.resolve({ sessionId, runtime: agentRuntime, channelId, modelId })
          : { ok: false as const, code: 'token_expired' as const }
        if (!nextCredentials.ok) return false

        runtimeCredentials = nextCredentials.credentials
        sdkEnv = await this.buildSdkEnv(runtimeCredentials)
        if (agentRuntime === 'claude') queryOptions.env = sdkEnv
        if (agentRuntime === 'pi') {
          Object.assign(queryOptions, buildPiRuntimeCredentialOptions(channelId, runtimeCredentials))
        }
        console.warn('[Agent 编排] 模型数据面失败，已切换到 Relay 重试')
        return true
      }

      /** 捕获到的 SDK session ID（用于 resume / recovery） */
      let capturedSdkSessionId = existingSdkSessionId
      const canTryThinkingSignatureRecovery = (attempt: number): boolean =>
        !thinkingSignatureRecoveryAttempted && canAutoRetry(attempt) && !!(existingSdkSessionId || capturedSdkSessionId || queryOptions.resumeSessionId)

      const queryStartedAt = Date.now()

      const stoppedBeforeQuery = this.consumeStoppedByUser(sessionId)
      if (stoppedBeforeQuery) {
        completeRun([...(this.sessionPort.getAgentMessages?.(sessionId) ?? [])], { stoppedByUser: true, startedAt: streamStartedAt })
        return
      }
      for (let attempt = 1; attempt <= MAX_AUTO_RETRIES + 1; attempt++) {
        if (this.stoppedBySessions.has(sessionId) || this.activeSessions.get(sessionId) !== runGeneration) {
          const wasStoppedByUser = this.consumeStoppedByUser(sessionId)
          completeRun([...(this.sessionPort.getAgentMessages?.(sessionId) ?? [])], {
            stoppedByUser: wasStoppedByUser,
            startedAt: streamStartedAt,
          })
          return
        }
        // 非首次尝试：等待 + 发送重试事件到 UI
        if (attempt > 1) {
          if (skipNextRetryDelay) {
            skipNextRetryDelay = false
            console.log(`[Agent 编排] 已切换到上下文回填模式，立即重试`)
          } else {
            const retryAttempt = Math.max(1, attempt - 1 - invisibleRecoveryAttempts)
            const errorCategory = classifyCatchError(lastRetryableError, stderrChunks.join('\n'))
            // 停止重试只看等待预算是否耗尽。delayMs === 0 是「立即重试」的合法语义
            // （stream_interrupted 的退避乘数为 0），若以它作为停止条件，一次瞬时断流
            // 会在第 1 次重试之前直接终止本轮，用户侧表现为「请求不到也不反复请求」。
            if (isRetryBudgetExhausted(retryDelayElapsedMs)) {
              console.log(`[Agent 编排] 自动重试等待预算已耗尽 (${MAX_AUTO_RETRY_WAIT_MS}ms)，停止重试`)
              break
            }
            const delayMs = getRetryDelayMs(retryAttempt, retryDelayElapsedMs, errorCategory)
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
              this.eventPort.emit(sessionId, {
                kind: 'profer_event',
                event: {
                  type: 'retry',
                  status: 'starting',
                  attempt: retryAttempt,
                  maxAttempts: retryMaxAttempts,
                  delaySeconds: delaySec,
                  reason: lastRetryableError ?? '未知错误',
                },
              })
              this.eventPort.emit(sessionId, {
                kind: 'profer_event',
                event: { type: 'retry', status: 'attempt', attemptData },
              })
            }

            console.log(`[Agent 编排] 第 ${retryAttempt} 次重试${retryAttempt <= RETRY_VISIBILITY_THRESHOLD ? '(静默)' : ''}，等待 ${delaySec}s...`)
            await waitForRetryDelay(delayMs, {
              shouldStop: () => this.stoppedBySessions.has(sessionId) || this.activeSessions.get(sessionId) !== runGeneration,
            })

            // 等待期间如果用户停止或本 run 已不再拥有会话，退出。
            if (this.stoppedBySessions.has(sessionId) || this.activeSessions.get(sessionId) !== runGeneration) {
              const wasStoppedByUser = this.consumeStoppedByUser(sessionId)
              this.persistSDKMessages(sessionId, accumulatedMessages, Date.now() - queryStartedAt)
              try {
                this.sessionPort.updateMeta(sessionId, {
                  stoppedByUser: wasStoppedByUser,
                })
              } catch {
                /* 会话可能已删除 */
              }
              completeRun([...(this.sessionPort.getAgentMessages?.(sessionId) ?? [])], {
                stoppedByUser: wasStoppedByUser,
                startedAt: streamStartedAt,
              })
              return
            }
          }
        }

        let shouldRetryFromError = false

        try {
          piNativeRetryState.exhausted = false
          // 获取异步迭代器（手动 .next() 以支持 Promise.race 中断）
          const queryIterable = await this.queryPreparedProvider({
            sessionId, runtime: agentRuntime, prompt: queryOptions.prompt,
            channelId, modelId, cwd: agentCwd,
            prepared: {
              credentials: runtimeCredentials,
              resources: {},
              systemPrompt: promptAssembly.systemPrompt,
              canUseTool,
              ...(agentRuntime === 'pi' ? { tools: piCustomTools, collaborationAvailable: piCollaborationAvailable } : {}),
              mcpServers,
              plugins: skillRuntimeOptions.plugins,
              skills: skillRuntimeOptions.skills,
              allowedTools: sdkAllowedTools.allowedTools,
              disallowedTools: disabledClaudeTools,
            },
          }, queryOptions)
          // preparation 返回到调用方也有一次 await；此间的 stop 不能让 lazy adapter 重新启动。
          if (this.stoppedBySessions.has(sessionId) || this.activeSessions.get(sessionId) !== runGeneration) {
            throw new DOMException('Agent query preparation was stopped', 'AbortError')
          }
          const queryIterator = queryIterable[Symbol.asyncIterator]()

          // Runtime 负责 next/stop/iterator.return 的生命周期；Electron 只处理消息业务。
          // result 不是 iterator 终态；adapter 必须先完成自己的 cleanup 并让 iterator 返回 done。
          const streamDrain = createAgentStreamDrainController()
          let streamDrainState: AgentStreamDrainState = streamDrain.state
          // 捕获 result.subtype 以传递给前端（用于区分 success/error_max_turns/error_max_budget_usd）
          let capturedResultSubtype: string | undefined
          // 捕获 result.errors[] 错误详情：SDK 在 error_during_execution 等场景下会把真实错误原因
          // 放进 errors[]，透传到前端用于展示具体错误（而非泛泛的"任务执行过程中发生错误"）。
          let capturedResultErrors: string[] | undefined
          // 后台任务等待态：result 走轻量完成后置 true，下一轮真正开始（收到 assistant/user/task 消息）时
          // 置回 false 并发 run_resumed，让 UI 从空闲态恢复运行态。
          let awaitingBackgroundWake = false
          // Native task tools are persisted here, before renderer delivery, so headless
          // runs and renderer reloads cannot lose graph history.
          const taskToolUses = new Map<string, TaskToolInvocation>()
          let currentTaskId: string | null = null
          let lastCompletedTaskId: string | null = null
          // 跨 run 自动串联兜底：单次 query 的内存在每次 run 重新归 null，导致跨 run 创建的新任务
          // 丢失“最近完成任务”上下文而孤立。这里在 run 启动时读一次持久化 graph，把最近完成/最近更新的
          // 任务 id（惰性读盘、run 内缓存）；auto-link 在内存无值时回退到它，从而让任务图随推进逐渐连成依赖链。
          let persistedRecentTaskId: string | null = null
          let resolvedPersistedRecentTask = false
          const resolvePersistedRecentTask = (): string | null => {
            if (resolvedPersistedRecentTask) return persistedRecentTaskId
            resolvedPersistedRecentTask = true
            persistedRecentTaskId = resolveRecentAutoLinkTaskId(sessionId)
            return persistedRecentTaskId
          }

          while (true) {
            const nextResult = await readAgentStreamNext(queryIterator, {
              shouldStop: () => this.stoppedBySessions.has(sessionId),
            })
            if (nextResult.kind === 'stopped') {
              // 用户主动停止，runtime 已调用 iterator.return；owner 仍由 finally 释放。
              streamDrainState = streamDrain.signal('stop')
              break
            }
            if (nextResult.kind === 'done') {
              streamDrainState = streamDrain.signal('iterator_done')
              break
            }

            const msg = nextResult.value
            if (msg.type === 'result' && configuredModelId) {
              const resultRecord = msg as Record<string, unknown>
              if (!resultRecord._channelModelId) resultRecord._channelModelId = configuredModelId
            }
            // Pi 的 partial 是累计全文预览，不是正式 turn 消息：不得进入持久化、错误终态或重试语义。
            const isPartialMessage = isPartialSDKMessage(msg)


            // 后台任务唤醒：轻量完成后处于等待态，收到新一轮的首条实质消息时
            // 发 run_resumed，让 UI 从"空闲可输入"恢复到"运行中"。
            // applyAgentEvent 的流式分支不会重置 running，故必须显式通知。
            if (awaitingBackgroundWake) {
              const sub = msg.type === 'system' ? (msg as { subtype?: string }).subtype : undefined
              if (msg.type === 'assistant' || msg.type === 'user' || sub === 'task_started' || sub === 'task_progress') {
                awaitingBackgroundWake = false
                this.eventPort.emit(sessionId, {
                  kind: 'profer_event',
                  event: { type: 'run_resumed', sessionId },
                })
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
                      input: typeof block.input === 'object' && block.input !== null ? (block.input as Record<string, unknown>) : {},
                    })
                  }
                }
              }
            }

            // 主进程是任务图持久化权威：仅原生 Task 工具在此转换。
            // 结构化 MCP handler 已直接 appendGraphEvent，只更新当前任务以关联后续委派。
            if (msg.type === 'user') {
              const content = (
                msg as {
                  message?: {
                    content?: Array<{
                      type?: string
                      tool_use_id?: string
                      content?: unknown
                      is_error?: boolean
                    }>
                  }
                }
              ).message?.content
              for (const block of content ?? []) {
                if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue
                // 把本轮确定发生过的写入挂到 tool_result block 上：
                // 渲染层据此出 chip，历史会话回放时也随 JSONL 一起恢复。
                const writes = fileWritesByToolUse.get(block.tool_use_id)
                if (writes && writes.length > 0) {
                  ;(block as Record<string, unknown>).proferFileChanges = writes
                  fileWritesByToolUse.delete(block.tool_use_id)
                }
                const invocation = taskToolUses.get(block.tool_use_id)
                if (!invocation) continue
                invocation.result = block.content
                invocation.executionResult = executionResultsByToolUse.get(block.tool_use_id)
                if (piHarnessScope) {
                  piHarnessScope.observeToolResult({
                    toolUseId: invocation.toolUseId,
                    toolName: invocation.toolName,
                    input: invocation.input,
                    result: block.content,
                    ...(invocation.executionResult ? { executionResult: invocation.executionResult } : {}),
                    isError: block.is_error === true,
                  })
                }

                if (invocation.toolName === 'TaskCreate' || invocation.toolName === 'TaskUpdate') {
                  const conversion = nativeTaskToolToGraphEvents(invocation, sessionId, Date.now(), {
                    currentTaskId,
                    lastCompletedTaskId: lastCompletedTaskId ?? resolvePersistedRecentTask(),
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
                    lastCompletedTaskId: lastCompletedTaskId ?? resolvePersistedRecentTask(),
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
                        payload: {
                          sessionId: delegation.delegationId,
                          childSessionId: delegation.childSessionId,
                        },
                      })
                      for (const graphEvent of delegationToGraphEvents(currentTaskId, delegation, invocation, timestamp)) {
                        appendGraphEvent(sessionId, graphEvent)
                      }
                    }
                  }
                }
                taskToolUses.delete(block.tool_use_id)
                executionResultsByToolUse.delete(block.tool_use_id)
              }
            }

            // 检测 assistant 消息中的 SDK 错误
            if (msg.type === 'assistant' && !isPartialMessage) {
              const assistantMsg = msg as SDKAssistantMessage
              if (assistantMsg.error) {
                console.error(`[Agent 编排] ═══ SDK assistant 错误 原始数据 ═══`)
                console.error(`[Agent 编排] error.errorType: ${assistantMsg.error.errorType ?? '(空)'}`)
                console.error(`[Agent 编排] error.message: ${assistantMsg.error.message ?? '(空)'}`)
                console.error(
                  `[Agent 编排] message.content 文本块:`,
                  (assistantMsg.message?.content ?? [])
                    .filter((b: { type: string }) => b.type === 'text')
                    .map((b) => (b as { text?: string }).text?.slice(0, 500)),
                )
                try {
                  console.error(`[Agent 编排] 完整 assistantMsg (JSON keys):`, Object.keys(assistantMsg))
                } catch {}
                try {
                  console.error(`[Agent 编排] assistantMsg JSON (截断):`, JSON.stringify(assistantMsg).slice(0, 2000))
                } catch {}
                console.error(`[Agent 编排] ═══ SDK assistant 错误 原始数据 结束 ═══`)

                // #1268 断流保消息：当终端错误同时携带有效正文时，先将正文作为正常消息推送
                if (hasTerminalErrorWithContent(msg)) {
                  const separated = stripErrorFromContentMessage(msg)
                  if (separated) {
                    console.log(
                      `[Agent 编排] #1268 断流保消息：分离正文（${separated.errorText}），正文长度=${
                        (separated.contentMessage as SDKAssistantMessage).message?.content
                          ?.filter((b: { type: string }) => b.type === 'text')
                          .map((b) => (b as { text: string }).text)
                          .join('').length ?? 0
                      }`,
                    )
                    // 先推送正文消息（无 error 字段），复用原 uuid 覆盖流式部分帧。
                    // 正文需要立即落盘；但若错误可自动恢复，不能提前追加红色终态错误卡，
                    // 否则 UI 会同时显示「已失败」和「Agent Running / 正在重试」两种矛盾状态。
                    this.eventPort.emit(sessionId, {
                      kind: 'sdk_message',
                      message: separated.contentMessage,
                    })
                    accumulatedMessages.push(separated.contentMessage)

                    // 先判定是否自动重试；重试中只保留已生成正文，最终失败时再追加错误摘要。
                    const rawError = assistantMsg.error as unknown
                    const errorCode: ErrorCode =
                      (typeof rawError === 'object' && rawError !== null ? ((rawError as Record<string, unknown>).errorType as ErrorCode) : undefined) ??
                      'unknown_error'
                    const willAutoRetry = isAutoRetryableTypedError({
                      code: errorCode,
                      title: '流式传输中断',
                      message: separated.errorText,
                      actions: [],
                      canRetry: true,
                    }) && canAutoRetry(attempt, separated.errorText)

                    if (willAutoRetry) {
                      this.persistSDKMessages(sessionId, accumulatedMessages, Date.now() - queryStartedAt)
                      accumulatedMessages.length = 0
                      lastRetryableError = getRetryDisplayReason(channel.provider, `连接中断：${separated.errorText}`)
                      console.log(`[Agent 编排] 可重试错误 (断流保消息): ${lastRetryableError}`)
                      stderrChunks.length = 0
                      shouldRetryFromError = true
                      break
                    }

                    // 已确定不会继续重试，此时才生成并持久化终态错误摘要。
                    const errorSummary: SDKMessage = {
                      type: 'assistant',
                      message: {
                        content: [
                          {
                            type: 'text',
                            text: `⚠️ 连接中断：${separated.errorText}`,
                          },
                        ],
                      },
                      parent_tool_use_id: null,
                      error: {
                        message: separated.errorText,
                        errorType: errorCode,
                      },
                      _createdAt: Date.now(),
                    } as unknown as SDKMessage
                    this.eventPort.emit(sessionId, {
                      kind: 'sdk_message',
                      message: errorSummary,
                    })
                    accumulatedMessages.push(errorSummary)
                    this.persistSDKMessages(sessionId, accumulatedMessages, Date.now() - queryStartedAt)
                    accumulatedMessages.length = 0

                    // 不可重试 → 终止
                    try {
                      this.sessionPort.updateMeta(sessionId, {})
                    } catch {
                      /* 忽略 */
                    }
                    runEndedWithError = true
                    completeRun([...(this.sessionPort.getAgentMessages?.(sessionId) ?? [])], {
                      startedAt: streamStartedAt,
                      resultSubtype: 'error_during_execution',
                      resultErrors: [separated.errorText],
                    })
                    return
                  }
                }

                const { detailedMessage, originalError } = errorHelpers.extractErrorDetails(
                  assistantMsg as unknown as Parameters<typeof errorHelpers.extractErrorDetails>[0],
                )
                // SDK 的 error 字段可能是字符串（错误码）或对象 {message, errorType}
                const rawError = assistantMsg.error as unknown
                let errorCode =
                  (typeof rawError === 'object' && rawError !== null ? ((rawError as Record<string, unknown>).errorType as string) : undefined) ??
                  (typeof rawError === 'string' ? rawError : undefined) ??
                  'unknown_error'
                console.error(`[Agent 编排] rawError 类型=${typeof rawError}, errorCode=${errorCode}`)
                if (errorHelpers.isPromptTooLongError(detailedMessage, originalError)) {
                  errorCode = 'prompt_too_long'
                }
                const typedError = errorHelpers.mapSDKErrorToTypedError(errorCode, errorHelpers.friendlyErrorMessage(detailedMessage), originalError)
                console.error(`[Agent 编排] mapSDKErrorToTypedError 结果:`)
                console.error(`  code: ${typedError.code}`)
                console.error(`  title: ${typedError.title || '(空)'}`)
                console.error(`  message: ${typedError.message || '(空)'}`)
                console.error(`  canRetry: ${typedError.canRetry}`)
                console.error(`  originalError: ${typedError.originalError?.slice(0, 300) || '(空)'}`)

                // Session 不存在错误：清除 sdkSessionId，切换到上下文回填模式重试
                if (isSessionNotFoundError(detailedMessage, originalError) && existingSdkSessionId && canAutoRetry(attempt, detailedMessage, originalError)) {
                  existingSdkSessionId = undefined
                  capturedSdkSessionId = undefined
                  lastRetryableError = this.prepareSessionNotFoundRecovery(
                    sessionId,
                    queryOptions,
                    contextualMessage,
                    agentCwd,
                    accumulatedMessages,
                    queryStartedAt,
                  )
                  shouldRetryFromError = true
                  break
                }

                // Thinking signature 不兼容：通常由跨模型 resume 触发。
                // 先自动清除 SDK resume 关系，改用 Profer 已持久化上下文重跑一次；再失败才展示用户提示。
                if (typedError.code === THINKING_SIGNATURE_ERROR_CODE && canTryThinkingSignatureRecovery(attempt)) {
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

                // thinking-only 空输出只恢复一次；第二次必须给用户可见反馈，不能静默成功。
                if (typedError.code === 'empty_output') {
                  if (!emptyOutputRecoveryAttempted && canAutoRetry(attempt)) {
                    emptyOutputRecoveryAttempted = true
                    lastRetryableError = EMPTY_OUTPUT_ERROR_MESSAGE
                    skipNextRetryDelay = true
                    stderrChunks.length = 0
                    console.warn(`[Agent 编排] 检测到 thinking-only 空回复，立即恢复一次 (attempt ${attempt})`)
                    shouldRetryFromError = true
                    break
                  }

                  const emptyOutputErrorContent = '模型未生成可见回复，请重试或更换模型。'
                  const emptyOutputErrorSDKMsg: SDKMessage = {
                    type: 'assistant',
                    message: {
                      content: [{ type: 'text', text: emptyOutputErrorContent }],
                    },
                    parent_tool_use_id: null,
                    error: {
                      message: emptyOutputErrorContent,
                      errorType: 'empty_output',
                    },
                    _createdAt: Date.now(),
                    _errorCode: 'empty_output',
                    _errorTitle: '模型未生成回复',
                    _errorCanRetry: true,
                    _errorActions: [{ key: 'r', label: '重试', action: 'retry' }],
                  } as unknown as SDKMessage
                  this.sessionPort.appendMessages(sessionId, [emptyOutputErrorSDKMsg])
                  this.eventPort.emit(sessionId, {
                    kind: 'sdk_message',
                    message: emptyOutputErrorSDKMsg,
                  })
                  runEndedWithError = true
                  completeRun([...(this.sessionPort.getAgentMessages?.(sessionId) ?? [])], {
                    startedAt: streamStartedAt,
                    resultSubtype: 'error_during_execution',
                    resultErrors: [emptyOutputErrorContent],
                  })
                  return
                }

                // 判断是否可自动重试
                if (isInvalidRelayTokenError(null, detailedMessage, originalError) && (await recoverRelayTokenForAgent())) {
                  lastRetryableError = 'relay 令牌已刷新'
                  skipNextRetryDelay = true
                  stderrChunks.length = 0
                  shouldRetryFromError = true
                  break
                }

                if (isAutoRetryableTypedError(typedError) && canAutoRetry(attempt, typedError.message, originalError)) {
                  lastRetryableError = getRetryDisplayReason(channel.provider, typedError.title ? `${typedError.title}: ${typedError.message}` : typedError.message)
                  console.log(`[Agent 编排] 自动重试决策:`, {
                    sessionId,
                    channelId,
                    modelId: modelId || DEFAULT_MODEL_ID,
                    provider: channel.provider,
                    httpStatus: originalError.match(/\b(?:API Error:|HTTP)\s*(\d{3})/i)?.[1] ?? 'unknown',
                    typedErrorCode: typedError.code,
                    retryDecision: 'auto_retry',
                  })
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

                const errorContent = typedError.title ? `${typedError.title}: ${typedError.message}` : typedError.message
                const errorSDKMsg: SDKMessage = {
                  type: 'assistant',
                  message: {
                    content: [{ type: 'text', text: errorContent }],
                  },
                  parent_tool_use_id: null,
                  error: {
                    message: typedError.message,
                    errorType: typedError.code,
                  },
                  _createdAt: Date.now(),
                  _errorCode: typedError.code,
                  _errorTitle: typedError.title,
                  _errorDetails: typedError.details,
                  _errorCanRetry: typedError.canRetry,
                  _errorActions: typedError.actions,
                } as unknown as SDKMessage
                this.sessionPort.appendMessages(sessionId, [errorSDKMsg])
                console.log(`[Agent 编排] 已保存 TypedError 消息: ${typedError.code} - ${typedError.title}`)

                // 如果之前有可见重试记录，发送 retry_failed
                if (retryAttemptsScheduled > RETRY_VISIBILITY_THRESHOLD && lastRetryableError) {
                  this.eventPort.emit(sessionId, {
                    kind: 'profer_event',
                    event: {
                      type: 'retry',
                      status: 'failed',
                      attemptData: {
                        attempt: retryAttemptsScheduled,
                        timestamp: Date.now(),
                        reason: lastRetryableError,
                        errorMessage: typedError.message,
                        delaySeconds: 0,
                      },
                    },
                  })
                }

                // 透传归一化后的错误消息到前端，避免 SDK 原始 API Error 直接暴露给用户。
                this.eventPort.emit(sessionId, {
                  kind: 'sdk_message',
                  message: errorSDKMsg,
                })
                try {
                  this.sessionPort.updateMeta(sessionId, {})
                } catch {
                  /* 忽略 */
                }
                runEndedWithError = true
                completeRun([...(this.sessionPort.getAgentMessages?.(sessionId) ?? [])], {
                  startedAt: streamStartedAt,
                })
                return
              }
            }

            // 调用方可观察完整 runtime 消息；普通 Goal 使用当前会话上下文并正常持久化。
            input.onRuntimeMessage?.(msg)
            // 累积 assistant 和 user 消息用于持久化
            // - 跳过 replay 消息，避免 resume 时重复写入
            // - 对 user 消息，仅累积含 tool_result 的（初始用户消息已在步骤 5 手动持久化）
            // - 对 system 消息，仅累积需要持久化显示的（compact_boundary / permission_denied）
            if (msg.type === 'assistant' || msg.type === 'user' || msg.type === 'result') {
              const msgRecord = msg as Record<string, unknown>
              if (!msgRecord.isReplay && !isPartialMessage) {
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
                    ;(msg as Record<string, unknown>)._channelModelId = modelId
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

            // 可恢复性 checkpoint：不能只等 result/run_completed 才写 JSONL。
            // AskUser、权限、ExitPlan 等工具会在 result 之前无限期等待用户；此时若 Pocket
            // 被系统杀掉，冷启动快照只能读取已有 JSONL。立即落盘每条非 partial 的持久化消息，
            // 才能保证“用户原始指令 → 已执行工具 → 待回答交互”在任意阻塞点可完整恢复。
            // partial 仍只用于实时预览，且上面的累积条件已经排除了 replay，故不会污染历史或重复写入。
            if (accumulatedMessages.length > 0) {
              this.persistSDKMessages(sessionId, accumulatedMessages, Date.now() - queryStartedAt)
              accumulatedMessages.length = 0
            }

            // Turn 结束时：持久化累积消息（正常情况下已由 checkpoint 清空；保留兜底语义）。
            if (msg.type === 'result') {
              piHarnessScope?.observeResult(msg)
              streamDrainState = streamDrain.signal('result')
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
              const keepChannelOpen = errorHelpers.shouldKeepChannelOpen(resultTerminalReason) || keptOpenForTasks
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
                idleComplete([...(this.sessionPort.getAgentMessages?.(sessionId) ?? [])], {
                  startedAt: streamStartedAt,
                  resultSubtype: capturedResultSubtype,
                  resultErrors: capturedResultErrors,
                })
              } else if (!keepChannelOpen) {
                // result 只表示收到本轮结果；iterator 仍可能在 adapter 内清理、发送尾部消息或完成压缩。
                // 不设置超时，不主动 return iterator。只有下一次 next() 返回 done 才结束本轮。
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
              this.eventPort.emit(sessionId, {
                kind: 'sdk_message',
                message: msg,
              })
            }
          }

          // 错误 break 触发了 → 继续循环
          if (shouldRetryFromError) {
            continue
          }

          // 正常退出只能来自 iterator done；用户停止则由 stop 分支显式打断。
          if (streamDrainState !== 'closed' && streamDrainState !== 'stopped') {
            throw new Error('Agent stream exited before iterator drain completed')
          }

          // 事件循环由 runtime reader 在 iterator done 或 stop 时完成 drain。

          const wasStoppedByUser = this.consumeStoppedByUser(sessionId)
          if (input.goalRunId && wasStoppedByUser) {
            callbacks.onError('Goal 运行已停止')
            completeRun([...(this.sessionPort.getAgentMessages?.(sessionId) ?? [])], { stoppedByUser: true, startedAt: streamStartedAt })
            return
          }

          // 正常完成 — 如果之前有重试，发送 retry_cleared
          if (!wasStoppedByUser && retryAttemptsScheduled > 0) {
            this.eventPort.emit(sessionId, {
              kind: 'profer_event',
              event: { type: 'retry', status: 'cleared' },
            })
            console.log(`[Agent 编排] 重试成功，已在第 ${attempt} 次尝试后恢复`)
          }
          retrySucceeded = true

          // 15. 持久化 assistant 消息
          this.persistSDKMessages(sessionId, accumulatedMessages, Date.now() - queryStartedAt)

          if (!wasStoppedByUser && !capturedResultErrors?.length) {
            // 自动命名是增强能力，不能占用终态路径：标题模型偶发慢请求/重试时，
            // 文本早已停止而 UI 仍显示「Agent Running」。这里推迟到下一轮事件循环，
            // 让 completeRun → owner finally → STREAM_COMPLETE 先走完；标题生成完成后
            // 仍通过 onTitleUpdated 正常投影。
            const titleSource = input.titleSourceText ?? userMessage
            const titleModelId = resolvedModel
            setImmediate(() => {
              void this.autoGenerateTitle(sessionId, titleSource, channelId, titleModelId, callbacks)
            })
          }

          try {
            this.sessionPort.updateMeta(sessionId, wasStoppedByUser ? { stoppedByUser: true } : {})
          } catch {
            /* 忽略 */
          }

          // Plan 模式：Agent 完成规划后注入"接受计划"建议
          if (initialPermissionMode === 'plan' && planModeEntered && this.activeSessions.get(sessionId) === runGeneration) {
            this.eventPort.emit(sessionId, {
              kind: 'sdk_message',
              message: {
                type: 'prompt_suggestion',
                suggestion: '请执行该计划',
              } as unknown as SDKMessage,
            })
            console.log(`[Agent 编排] Plan 模式：已注入计划确认建议`)
          }

          // 发送完成信号
          completeRun([...(this.sessionPort.getAgentMessages?.(sessionId) ?? [])], {
            stoppedByUser: wasStoppedByUser,
            startedAt: streamStartedAt,
            resultSubtype: capturedResultSubtype,
            resultErrors: capturedResultErrors,
          })

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

          // 用户主动中止：stopping 时仍保留 active ownership，直到 finally 真实释放。
          if (this.stoppedBySessions.has(sessionId)) {
            const wasStoppedByUser = this.consumeStoppedByUser(sessionId)
            console.log(`[Agent 编排] 会话 ${sessionId} 已被用户中止`)
            this.persistSDKMessages(sessionId, accumulatedMessages, Date.now() - queryStartedAt)
            // 持久化中断状态到会话 meta
            try {
              this.sessionPort.updateMeta(sessionId, {
                stoppedByUser: wasStoppedByUser,
              })
            } catch {
              /* 会话可能已删除 */
            }
            completeRun([...(this.sessionPort.getAgentMessages?.(sessionId) ?? [])], {
              stoppedByUser: wasStoppedByUser,
              startedAt: streamStartedAt,
            })
            return
          }

          // 从 stderr 提取 API 错误
          const stderrOutput = stderrChunks.join('').trim()
          const apiError = extractApiError(stderrOutput)
          const rawErrorMessage = error instanceof Error ? error.message : ''

          // Session 不存在错误：清除 sdkSessionId，切换到上下文回填模式重试
          if (isSessionNotFoundError(rawErrorMessage, stderrOutput) && existingSdkSessionId && canAutoRetry(attempt, rawErrorMessage, stderrOutput)) {
            existingSdkSessionId = undefined
            capturedSdkSessionId = undefined
            lastRetryableError = this.prepareSessionNotFoundRecovery(sessionId, queryOptions, contextualMessage, agentCwd, accumulatedMessages, queryStartedAt)
            stderrChunks.length = 0
            continue  // 进入下一次 retry 循环
          }

          // Thinking signature 不兼容：先自动清除 SDK resume 关系并用上下文回填重跑一次。
          if (errorHelpers.isThinkingSignatureError(apiError?.message ?? '', rawErrorMessage, stderrOutput) && canTryThinkingSignatureRecovery(attempt)) {
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
          if (isInvalidRelayTokenError(apiError, rawErrorMessage, stderrOutput) && (await recoverRelayTokenForAgent())) {
            lastRetryableError = 'relay 令牌已刷新'
            skipNextRetryDelay = true
            stderrChunks.length = 0
            continue
          }

          if (isAutoRetryableCatchError(apiError, rawErrorMessage, stderrOutput) && canAutoRetry(attempt, apiError?.message, rawErrorMessage, stderrOutput)) {
            lastRetryableError = getRetryDisplayReason(channel.provider, apiError ? `API Error ${apiError.statusCode}: ${apiError.message}` : error instanceof Error ? error.message : '未知错误')
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
            userFacingError = errorHelpers.friendlyErrorMessage(`API 错误 (${apiError.statusCode}):\n${apiError.message}`)
          } else {
            userFacingError = errorHelpers.friendlyErrorMessage(errorMessage)
          }
          console.error(`[Agent 编排] userFacingError (friendlyErrorMessage 之后):\n  ${userFacingError}`)

          // 保存错误消息到 JSONL
          try {
            // 检测是否为 prompt too long 错误
            const isPromptTooLong = errorHelpers.isPromptTooLongError(
              userFacingError,
              error instanceof Error ? (error.stack ?? error.message) : String(error),
              stderrOutput,
            )
            const isThinkingSignature = errorHelpers.isThinkingSignatureError(
              apiError?.message ?? '',
              userFacingError,
              rawErrorMessage,
              error instanceof Error ? (error.stack ?? error.message) : String(error),
              stderrOutput,
            )
            const errorCode = isPromptTooLong ? 'prompt_too_long' : isThinkingSignature ? THINKING_SIGNATURE_ERROR_CODE : 'unknown_error'
            const errorTitle = isPromptTooLong ? '上下文过长' : isThinkingSignature ? THINKING_SIGNATURE_ERROR_TITLE : '执行错误'
            const errorContent = isPromptTooLong
              ? '上下文过长：当前对话的上下文已超出模型限制，请压缩上下文或开启新会话'
              : isThinkingSignature
                ? `${THINKING_SIGNATURE_ERROR_TITLE}：${THINKING_SIGNATURE_ERROR_MESSAGE}`
                : userFacingError
            const errorActions = isThinkingSignature
              ? [
                  {
                    key: 'n',
                    label: '在新对话继续',
                    action: 'retry_in_new_session',
                  },
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
            this.sessionPort.appendMessages(sessionId, [errMsg])
            console.log(`[Agent 编排] 已保存错误消息到 JSONL`)
          } catch (saveError) {
            console.error('[Agent 编排] 保存错误消息失败:', saveError)
          }

          // 如果之前有重试记录，发送 retry_failed
          if (retryAttemptsScheduled > 0 && lastRetryableError) {
            this.eventPort.emit(sessionId, {
              kind: 'profer_event',
              event: {
                type: 'retry',
                status: 'failed',
                attemptData: {
                  attempt: retryAttemptsScheduled,
                  timestamp: Date.now(),
                  reason: lastRetryableError,
                  errorMessage: userFacingError,
                  delaySeconds: 0,
                },
              },
            })
          }

          failRun(userFacingError, [...(this.sessionPort.getAgentMessages?.(sessionId) ?? [])], {
            startedAt: streamStartedAt,
          })

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
        const retryFailureMessage =
          retryDelayElapsedMs >= MAX_AUTO_RETRY_WAIT_MS ? '重试等待已达到 5 分钟后仍然失败' : `重试 ${retryAttemptsScheduled || retryMaxAttempts} 次后仍然失败`
        this.eventPort.emit(sessionId, {
          kind: 'profer_event',
          event: {
            type: 'retry',
            status: 'failed',
            attemptData: {
              attempt: retryAttemptsScheduled || retryMaxAttempts,
              timestamp: Date.now(),
              reason: lastRetryableError,
              errorMessage: retryFailureMessage,
              delaySeconds: 0,
            },
          },
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
        this.sessionPort.appendMessages(sessionId, [retryErrorSDKMsg])

        failRun(`${retryFailureMessage}: ${lastRetryableError}`, [...(this.sessionPort.getAgentMessages?.(sessionId) ?? [])], { startedAt: streamStartedAt })
      }
    } catch (error) {
      // setup/query 失败可能发生在 Pi query 启动之前；Harness 仍必须看到 failed，
      // 不能让 finally 把已创建的 scope 误结算为 completed。
      runEndedWithError = true
      throw error
    } finally {
      // 凭证仅存在于 queryOptions.env；这里只清理本轮运行态。
      if (piHarnessScope && !harnessStopped) {
        try {
          settlePiHarnessRun(sessionId, runEndedWithError ? 'failed' : 'completed')
        } catch (error) {
          console.warn(`[Pi Harness] scope settle 失败，忽略 (${sessionId}):`, error)
        }
      }
      // 只在 generation 匹配时才清理，防止旧流的 finally 误删新流的注册
      // 只有仍持有本 generation 的 finally 能释放并清理 session scoped state。
      if (releaseActiveRun()) {
        if (input.goalRunId && this.goalRunOwners.get(sessionId) === input.goalRunId) {
          this.goalRunOwners.delete(sessionId)
        }
        this.nonPersistingGoalSessions.delete(sessionId)
        resolveSkillRouting(undefined)
        resolveRuntimeRegistered(false)
        this.activeRuntimeRegistrations.delete(sessionId)
        this.activeSkillRoutings.delete(sessionId)
        this.activePromptModes.delete(sessionId)
        this.activePresetPolicies.delete(sessionId)
        this.sessionPermissionModes.delete(sessionId)
        this.queuedMessageUuids.delete(sessionId)
        this.permissionPort.clearSessionPending?.(sessionId)
        const currentCompletion = this.runCompletions.get(sessionId)
        if (currentCompletion?.token === runGeneration) {
          this.runCompletions.delete(sessionId)
          currentCompletion.resolve()
        }
        // ownership 已释放，renderer 此时收到 STREAM_COMPLETE 后可安全开始下一轮。
        // 若 Stop 发生在 query/setup 尚未进入统一终态处理前，清掉残留标记，
        // 防止下一轮被误判为“启动前已停止”。
        const stoppedDuringRun = this.stoppedBySessions.has(sessionId)
        this.stoppedBySessions.delete(sessionId)
        if (pendingTerminalCompletion) {
          const completion = pendingTerminalCompletion
          // 1.1 统一结束原因判定：在任何终端路径的 complete 处归一化。
          // 后台任务续轮（backgroundTasksPending 的 idleComplete）走 onComplete 直达、不经此路径，
          // 因此不写 meta、不追加记录、不透传 endReason ——「假结束」不误判。
          const opts: CompleteOptions = completion.opts ?? {}
          const stopped = opts.stoppedByUser === true || stoppedDuringRun
          if (stopped) opts.stoppedByUser = true
          const hasError = runEndedWithError
          const rawSubtype = opts.resultSubtype
          // D3 防御：干净结束（无 subtype、无错误、未停止）视为 success，避免被误判为 unknown/中断
          const effectiveSubtype = !stopped && !hasError && rawSubtype == null ? 'success' : rawSubtype
          const { reason, label } = normalizeAgentEndReason({
            resultSubtype: effectiveSubtype,
            stoppedByUser: stopped,
            hasError,
          })

          if (reason === 'completed') {
            // 1.2 新一次正常完成：清除旧中断记录
            try {
              this.sessionPort.updateMeta(sessionId, {
                lastInterruptReason: undefined,
                lastInterruptLabel: undefined,
                lastInterruptAt: undefined,
              })
            } catch {
              /* 会话可能已删除 */
            }
          } else {
            // 1.3 追加对话记录条目（在 onComplete 前落盘，保证 STREAM_COMPLETE 触发的消息重载能看到）
            const now = Date.now()
            const record: SDKMessage = {
              type: 'system',
              subtype: 'interruption_record',
              message: label,
              _createdAt: now,
            } as unknown as SDKMessage
            try {
              this.sessionPort.appendMessages(sessionId, [record])
              if (completion.messages) completion.messages.push(record as unknown as AgentMessage)
            } catch {
              /* 忽略 */
            }
            // 1.2 持久化最近中断到 meta（同一时间戳，与 record 的 _createdAt 一致）
            try {
              this.sessionPort.updateMeta(sessionId, {
                lastInterruptReason: reason,
                lastInterruptLabel: label,
                lastInterruptAt: now,
              })
            } catch {
              /* 忽略 */
            }
          }

          // D9 透传 endReason（completed 时前端据此清除旧 chip；非 completed 时置位并驱动 toast）
          const finalOpts: CompleteOptions = {
            ...opts,
            endReason: reason,
            endReasonLabel: label,
          }
          callbacks.onComplete(completion.messages, finalOpts)
        }
        // 会话已空闲：通知协作层重查「父会话自动续跑」。
        // 场景：父会话发起 delegation 后结束等待子会话，期间用户手动压缩（/compact 占用了
        // active ownership）→ 子会话完成触发的 scheduleParentAutoContinuation 因 parent_active
        // 被跳过；此事件在压缩 run 结束后发出，协作层据此重新检查并续跑父会话，避免结果丢失。
        this.eventPort.emit(sessionId, {
          kind: 'profer_event',
          event: { type: 'run_idle', sessionId },
        })
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
   * 中止指定会话；Stop 仅标记并 abort，运行所有权由 owner finally 释放。
   */
  stop(sessionId: string): void {
    if (!this.activeSessions.has(sessionId) || this.stoppedBySessions.has(sessionId)) return
    this.stoppedBySessions.add(sessionId)
    this.queryPreparations.get(sessionId)?.abort()
    pauseActivePiHarnessRun(sessionId, 'user_stop')
    browserController.cancelSession(sessionId)
    try {
      this.adapter.abort(sessionId)
    } catch (err) {
      // abort 异常（如 Pi adapter 内部状态异常）不能阻断级联停止与 UI 反馈
      console.error(`[Agent 编排] 中止会话异常（已继续级联停止）: sessionId=${sessionId}`, err)
    }
    try {
      stopDelegationsForParent(sessionId)
    } catch (err) {
      console.error(`[Agent 编排] 级联停止子会话失败: sessionId=${sessionId}`, err)
    }
    console.log(`[Agent 编排] 已请求中止会话: ${sessionId}`)
  }

  /** Goal runId 归属检查；不带 runId 时只检查是否存在 Goal owner。 */
  isGoalRunActive(sessionId: string, runId?: string): boolean {
    const owner = this.goalRunOwners.get(sessionId)
    return owner !== undefined && this.activeSessions.has(sessionId) && (runId === undefined || owner === runId)
  }

  /** 只停止匹配 runId 的 Goal owner，并等待 owner finally 释放运行锁。 */
  async stopGoalRunAndWait(sessionId: string, runId: string, timeoutMs = 15_000): Promise<void> {
    if (!this.isGoalRunActive(sessionId, runId)) return
    await this.stopAndWait(sessionId, timeoutMs)
  }

  /** 检查指定会话是否正在处理或停止中。 */
  isActive(sessionId: string): boolean {
    return this.activeSessions.has(sessionId)
  }

  /**
   * 删除 / 分叉守卫的**唯一来源**。
   *
   * 旧 `sendMessage` 与新桌面 runtime 入口（`runDesktopRuntimeAgent`）共用同一组文案与判定顺序，
   * 因此「关闭态逐字节等价」与「开启态同一守卫」都由这一处保证，不各自维护一份。
   * 返回拦截原因（用户可见文案），`undefined` 表示放行。
   */
  checkEntryGuards(sessionId: string): string | undefined {
    if (this.deletingSessions.has(sessionId)) return '会话正在删除，无法发送消息'
    if (isAgentSessionForking(sessionId)) return '会话正在创建分叉，请稍候再试'
    return undefined
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
    this.eventPort.emit(sessionId, {
      kind: 'profer_event',
      event: {
        type: 'plan_mode_changed',
        sessionId,
        active: mode === 'plan',
        source: 'permission',
      },
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
   * 省略 `assistantMessageUuid` 时清空整段对话（见 `resetClaudeSession`）。
   */
  async rewindSession(sessionId: string, assistantMessageUuid?: string): Promise<RewindSessionResult> {
    // 0. 阻止运行中会话回退（JSONL 并发写入会损坏文件）
    if (this.activeSessions.has(sessionId)) {
      throw new Error('会话正在运行中，请停止后再回退')
    }

    const sessionMeta = this.sessionPort.getMeta(sessionId)
    if (!sessionMeta) {
      throw new Error(`Agent 会话不存在: ${sessionId}`)
    }
    const isPiSession = normalizeAgentRuntime(sessionMeta.agentRuntime) === 'pi'
    // Pi 使用自己的 session artifact + entry binding，不依赖 Claude SDK session ID。
    // 旧会话若尚未生成映射，会在 rewindPiSession 内返回可操作的恢复提示。
    if (isPiSession) {
      return assistantMessageUuid
        ? rewindPiSession(sessionId, assistantMessageUuid, sessionMeta)
        : resetPiSession(sessionId, sessionMeta)
    }
    // 没有锚点（首轮就失败）：清空整段对话，回到会话起点
    if (!assistantMessageUuid) {
      return resetClaudeSession(sessionId, sessionMeta)
    }
    // sdkSessionId 只影响「文件恢复」和「resume 截断点」：对话截断本身只看 Profer JSONL。
    // 所以缺失时降级为「只截断对话」而不是直接拒绝（例如 session-not-found 恢复过它的会话）。
    const sdkSessionId = sessionMeta.sdkSessionId
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
    const userMessageUuid = sdkSessionId
      ? resolveUserUuidFromSDK(sdkSessionId, assistantMessageUuid, projectDir, sessionMeta.forkSourceSdkSessionId)
      : undefined
    console.log(
      `[Agent 编排] 回退: 解析 user uuid=${userMessageUuid || '未找到'} (assistant uuid=${assistantMessageUuid}, forkSource=${sessionMeta.forkSourceSdkSessionId ?? 'none'})`,
    )

    // 1. 文件恢复：直接从 SDK JSONL 的 file-history-snapshot 恢复，无需临时 Query
    let fileRewindResult:
      | {
          canRewind: boolean
          error?: string
          filesChanged?: string[]
          insertions?: number
          deletions?: number
        }
      | undefined
    if (!sdkSessionId) {
      // 没有 SDK session 就没有 file-history-snapshot，只能降级；对话仍按下方完整截断
      console.log(`[Agent 编排] 回退: 会话没有 SDK session ID，跳过文件恢复`)
      fileRewindResult = { canRewind: false, error: '会话没有 SDK session ID，文件未回退' }
    } else if (userMessageUuid === '__LAST_TURN__') {
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
        const rewindAttachedDirs = collectAttachedDirectories({
          sessionMeta,
          workspaceSlug,
        })
        console.log(
          `[Agent 编排] 回退: 直接从 snapshot 恢复文件 (cwd=${cwd}, forkSource=${sessionMeta.forkSourceSdkSessionId ?? 'none'}, attachedDirs=${rewindAttachedDirs.length})`,
        )
        fileRewindResult = rewindFilesFromSnapshot(
          sdkSessionId,
          userMessageUuid,
          cwd,
          projectDir,
          sessionMeta.forkSourceSdkSessionId,
          rewindAttachedDirs,
        )
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        console.warn('[Agent 编排] 文件恢复失败，继续截断对话:', errMsg)
        if (err instanceof Error && err.stack) console.warn('[Agent 编排] 文件恢复错误堆栈:', err.stack)
        fileRewindResult = { canRewind: false, error: errMsg }
      }
    } else {
      fileRewindResult = {
        canRewind: false,
        error: '无法从 SDK session 中解析 user message UUID',
      }
    }

    // 2. 截断 Profer JSONL
    const kept = truncateSDKMessages(sessionId, assistantMessageUuid)

    // 3. 记录 resumeAtMessageUuid，下次发消息时 SDK 从此点继续。
    //    没有 sdkSessionId 时不存在可 resume 的 SDK 会话（清掉残留值），
    //    下一轮会作为新 SDK 会话按已截断的 Profer 历史回填上下文。
    this.sessionPort.updateMeta(sessionId, {
      resumeAtMessageUuid: sdkSessionId ? assistantMessageUuid : undefined,
    })

    console.log(`[Agent 编排] 回退完成: sessionId=${sessionId}, 保留 ${kept.length} 条消息, 文件恢复=${fileRewindResult?.canRewind ?? '跳过'}`)

    return {
      remainingMessages: kept.length,
      fileRewind: fileRewindResult,
    }
  }

  /** 中止所有活跃的 Agent 会话（应用退出时调用） */
  stopAll(): void {
    const activeSessionIds = Array.from(this.activeSessions.keys())
    if (activeSessionIds.length > 0) {
      console.log(`[Agent 编排] 正在请求中止所有活跃会话 (${activeSessionIds.length} 个)...`)
      for (const sessionId of activeSessionIds) this.stop(sessionId)
    }
    // 应用退出时仍需立即释放 adapter 资源；正常运行的 ownership 将由各自 finally 结算。
    this.adapter.dispose()
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
    const queueRunId = this.activeSessions.get(sessionId)
    if (!queueRunId) {
      throw new Error(`[Agent 编排] 会话未运行，无法追加消息: ${sessionId}`)
    }
    if (this.stoppedBySessions.has(sessionId)) {
      throw new Error(`[Agent 编排] 会话正在停止，无法追加消息: ${sessionId}`)
    }

    if (!this.adapter.sendQueuedMessage) {
      throw new Error('[Agent 编排] 当前适配器不支持流式追加消息')
    }

    const uuid = presetUuid || randomUUID()

    // 同一 UUID 的重试必须是幂等的：已被当前 run 接收的消息不再重复注入或落盘。
    const uuids = this.queuedMessageUuids.get(sessionId) ?? new Set<string>()
    if (!tryReserveQueuedMessage(uuids, uuid)) return uuid
    this.queuedMessageUuids.set(sessionId, uuids)

    // 注入 mention 引用指令（Skill/MCP/会话）— 仅影响发往 SDK 的 prompt，不影响持久化。
    // 与 sendMessage 路径保持一致的拼装逻辑。
    const sessionMeta = this.sessionPort.getMeta(sessionId)
    const workspaceId = sessionMeta?.workspaceId
    const workspaceSlug = workspaceId ? getAgentWorkspace(workspaceId)?.slug : undefined
    // 运行中的 Agent 收到队列消息时也必须看到用户刚刚主动打开的页面。
    // 未打开浏览器时保持既有消息形态，避免给每条插队消息重复注入无关环境块。
    const [skillSnapshot, runtimeRegistered] = await Promise.all([
      this.activeSkillRoutings.get(sessionId), this.activeRuntimeRegistrations.get(sessionId),
    ])
    if (!skillSnapshot || !runtimeRegistered || this.activeSessions.get(sessionId) !== queueRunId || this.stoppedBySessions.has(sessionId)) {
      uuids.delete(uuid)
      throw new Error('当前 Skill 能力快照未就绪或所属运行已结束，请在下一轮重试')
    }
    const activePolicy = this.activePresetPolicies.get(sessionId)
    if (this.activePromptModes.get(sessionId) === 'light'
      && selectAgentPromptMode({
        message: rawText ?? text, hasRuntimeSession: false,
        permissionMode: activePolicy?.permissionMode ?? 'auto',
        request: { mentionedSkills, mentionedMcpServers, mentionedSessionIds },
      }) === 'standard') {
      uuids.delete(uuid)
      throw new Error('当前简短对话即将结束；请在回复结束后发送任务，以加载完整的任务上下文。')
    }
    const userBrowserContext = browserController.getUserContext(sessionId)
    let enrichedText = userBrowserContext
      ? `${buildDynamicContext({ userBrowserContext, mcpServerNames: activePolicy?.loadedMcpServerNames ? [...activePolicy.loadedMcpServerNames] : undefined, disabledToolGroups: activePolicy ? [...activePolicy.disabledToolGroups] : undefined, disabledTools: activePolicy?.disabledTools })}\n\n${text}`
      : text
    const referencedSessionsBlock = buildReferencedSessionsPrompt(sessionId, mentionedSessionIds, workspaceId)
    if (referencedSessionsBlock) {
      enrichedText = `${referencedSessionsBlock}\n\n${enrichedText}`
    }
    const routedSkills = routeSkillsForTask(skillSnapshot, { userMessage: rawText ?? text, mentionedSkills })
    if (routedSkills.prompt) enrichedText = `${routedSkills.prompt}\n\n${enrichedText}`
    console.log('[Skill 路由 队列]', JSON.stringify({ sessionId, selected: routedSkills.selected, hints: routedSkills.hints, diagnostics: routedSkills.diagnostics }))
    const allowedMentionedMcpServers = mentionedMcpServers?.filter((name) =>
      activePolicy?.loadedMcpServerNames?.includes(name) === true,
    ) ?? []
    const toolLines: string[] = []
    for (const name of allowedMentionedMcpServers) {
      toolLines.push(`- MCP 服务器: ${name}（请使用此 MCP 服务器的工具来完成任务）`)
    }
    if (toolLines.length > 0) {
      enrichedText = `<mentioned_tools>\n用户在消息中明确引用了以下当前预设可用的工具，请在本次回复中主动调用：\n${toolLines.join('\n')}\n</mentioned_tools>\n\n${enrichedText}`
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
      // Claude 需要先软中断再注入；Pi 的 interrupt 路径必须由 adapter 自己先 reservation 再 abort，
      // 否则 prompt chain 会在 reservation 前结束，导致 IPC 永久等待。
      const runtime = normalizeAgentRuntime(this.sessionPort.getMeta(sessionId)?.agentRuntime)
      if (shouldPreInterruptQueuedMessage(runtime, opts?.interrupt) && this.adapter.interruptQuery) {
        try {
          await this.adapter.interruptQuery(sessionId)
        } catch (error) {
          console.warn(`[Agent 编排] 软中断失败（将继续追加消息）:`, error)
        }
      }

      await this.adapter.sendQueuedMessage(sessionId, sdkMessage, {
        interrupt: opts?.interrupt,
        // 已按冻结快照处理引用/推荐，禁止 adapter 再扫描 enrichedText 中的历史示例。
        skillMentions: [],
      })
      // 消息已注入 Agent 会话（Pi interrupt 路径 reservation 已消费）。
      // 即使 run 在 await 期间已停止/被替换，本条消息仍必须持久化到同一会话文件，
      // 否则出现“Agent 已收到但 JSONL 无记录”的上下文缺口；持久化失败时保留 uuid，
      // 防止重试幂等短路导致既不重注入也不落盘（子代理 P1#2 指出的永久丢失路径）。
      if (this.activeSessions.get(sessionId) !== queueRunId || this.stoppedBySessions.has(sessionId)) {
        console.warn(`[Agent 编排] 追加消息所属运行已结束，仍持久化已注入消息: sessionId=${sessionId}, uuid=${uuid}`)
      }
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
      try {
        this.sessionPort.appendMessages(sessionId, [persistMsg])
        // 追加消息同样要进事件流：手机端要靠它看到电脑端在运行中补发的指令。
        this.eventPort.emit(sessionId, { kind: 'sdk_message', message: persistMsg })
      } catch (persistError) {
        // 注入已成功，uuid 必须保留（幂等短路），否则重试会重复注入；JSONL 缺口由会话文件后续 append 兜底。
        console.error(`[Agent 编排] 已注入消息持久化失败 (uuid=${uuid}, sessionId=${sessionId}):`, persistError)
      }
      // 提示必须排在用户消息之后落盘，否则重载后会显示在它前面。
      this.persistSkillRoutingNotice(sessionId, routedSkills)
    } catch (error) {
      // 仅当注入本身失败（sendQueuedMessage reject，消息未被 Agent 接收）时释放 uuid 允许重试
      uuids.delete(uuid)
      throw error
    }

    return uuid
  }
}
