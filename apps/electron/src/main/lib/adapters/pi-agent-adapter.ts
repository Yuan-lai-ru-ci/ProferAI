/**
 * Pi Agent SDK 适配器
 *
 * Proma 内部继续使用 SDKMessage 兼容协议，避免渲染层、Jotai 状态、
 * JSONL 持久化和历史会话展示在 SDK 迁移时一起改名。
 */

import type { Dispatcher } from 'undici'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { execFile } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type {
  AgentThinkingLevel,
  AgentProviderAdapter,
  AgentQueryInput,
  CodexOAuthCredentials,
  ErrorCode,
  JsonSchemaOutputFormat,
  ProferPermissionMode,
  ProviderType,
  RecoveryAction,
  SendQueuedMessageOptions,
  SDKMessage,
  SDKUserMessageInput,
  TypedError,
  XaiOAuthCredentials,
} from '@profer/shared'
import { isCodexFastModeSupportedModel } from '@profer/shared'
import type { ProjectInstructionSource } from '../project-instruction-resolver'
import type { ProferProjectInstructionFile } from './pi-resource-loader-overrides'
import {
  THINKING_SIGNATURE_ERROR_MESSAGE,
  THINKING_SIGNATURE_ERROR_TITLE,
  isThinkingSignatureError as matchesThinkingSignatureError,
} from '@profer/shared'
import type { CanUseToolOptions, PermissionResult } from '../agent-permission-service'
import { TRANSIENT_NETWORK_PATTERN, isMalformedResponseError } from '../error-patterns'
import { normalizeDefaultSkillSlug, normalizeDefaultSkillSlugs, RENAMED_DEFAULT_SKILLS } from '../default-skill-slugs'

import type {
  AgentSession,
  AgentSessionEvent,
  ResourceLoader,
  Skill,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent'
import type { Transport as PiAgentTransport } from '@earendil-works/pi-ai'
import type { AgentToolResult, AgentToolUpdateCallback } from '@earendil-works/pi-agent-core'
import type { AssistantMessage } from '@earendil-works/pi-ai/compat'
import { Type, type TSchema } from 'typebox'
import {
  appendOutputFormatInstruction,
  createAgentRuntimeGuard,
  type AgentRuntimeGuard,
} from '../agent-runtime-guards'
import { createProferAgentsFilesOverride, createProferProjectInstructionFilesOverride, createProferManagedResourceLoaderOptions } from './pi-resource-loader-overrides'
import { ProjectInstructionScopeController } from './pi-project-instruction-scope'
import { createCodexFastModeExtension, withCodexFastModeServiceTier } from './pi-codex-fast-mode'
import { createCodexRequestSettingsExtension } from './pi-codex-request-settings'
import { createDeepSeekReasoningRequestExtension } from './pi-deepseek-reasoning-request-settings'
import { createOpenAIReasoningRequestExtension } from './pi-openai-reasoning-request-settings'
import { inferReasoningTransport, resolveReasoningProfile, calculatePiAutoCompactionReserveTokens } from '@profer/shared'
import { mergeRuntimeEnv, type AgentRuntimeEnv } from '../agent-runtime-env'
import {
  convertPiMessage,
  convertResultMessage,
  displayToolName,
  dropTrailingAbortedAssistant,
  hasToolResult,
  isAbortedAssistantMessage,
  isAssistantPiMessage,
  normalizePermissionInput,
  restorePiInput,
} from './pi-message-adapter'
import { DEFAULT_CONTEXT_WINDOW, buildModel } from './pi-model-registry'
import { createPartialMessageCoalescer, type PartialMessageCoalescer } from './pi-streaming-control'
import { runPiPromptChain, type PiInterruptReservation } from './pi-prompt-chain'
import { createPiRetryTerminalGate, mapPiNativeRetryEvent } from './pi-retry-control'
import { mapPiHarnessLifecycleEvent, type PiHarnessLifecycleObserver } from './pi-harness-lifecycle'
import { createWindowsPowerShellToolDefinition } from './pi-powershell-tool'
import {
  closePiRequestProxyDispatcher,
  createPiRequestProxyDispatcher,
  installPiRequestProxyFetch,
  runWithPiRequestProxy,
} from './pi-request-proxy'
import { registerPendingPiRuntimeProcess, registerPiRuntimeProcessShell } from '../runtime-process-registry'

type PiSdk = typeof import('@earendil-works/pi-coding-agent')
type BashOperations = import('@earendil-works/pi-coding-agent').BashOperations
type BashToolOptions = import('@earendil-works/pi-coding-agent').BashToolOptions
type SkillLoadResult = ReturnType<ResourceLoader['getSkills']>

const PI_NATIVE_MAX_RETRIES = 8
const PI_NATIVE_RETRY_BASE_DELAY_MS = 1_000

type PiRetrySettings = {
  enabled: boolean
  maxRetries?: number
  baseDelayMs?: number
}

/**
 * Pi SDK 原生重试按 provider 隔离。
 *
 * Ollama 的兼容层可能在一次工具结果续请求失败后再次提交同一份上下文；
 * 这类重试应交给 Profer 编排层统一判断，否则会绕过 Ollama 特判并在用户看来
 * "一发就开始重试"。GPT 等其他渠道继续保留 Pi 原生断流重试。
 */
export function buildPiRetrySettings(provider: ProviderType): PiRetrySettings {
  if (provider === 'ollama') return { enabled: false }
  return {
    enabled: true,
    maxRetries: PI_NATIVE_MAX_RETRIES,
    baseDelayMs: PI_NATIVE_RETRY_BASE_DELAY_MS,
  }
}

/** Pi SDK 查询选项（扩展通用 AgentQueryInput） */
export interface PiAgentQueryOptions extends AgentQueryInput {
  apiKey: string
  baseUrl?: string
  provider: ProviderType
  /** OAuth credential coordination key; equals the selected Profer channel id. */
  channelId?: string
  channelName?: string
  maxTurns?: number
  permissionMode: ProferPermissionMode
  canUseTool?: (
    toolName: string,
    input: Record<string, unknown>,
    options: CanUseToolOptions,
  ) => Promise<PermissionResult>
  systemPrompt: string
  /** Profer 已验证的项目根 instruction files；不触发 Pi 的磁盘自动发现。 */
  projectInstructionFiles?: ProferProjectInstructionFile[]
  /** 用于 typed 文件工具的会话级子目录指令激活；不会解析 Bash。 */
  projectInstructionScope?: {
    projectRoot: string
    initialSources: ProjectInstructionSource[]
  }
  resumeSessionId?: string
  piAgentDir: string
  piSessionDir: string
  customTools?: ToolDefinition[]
  onSessionId?: (sdkSessionId: string, sessionFile?: string) => void
  /** Profer assistant UI UUID → Pi 树状 session entry ID 的持久映射；分叉/回退依赖它定位 branch 点。 */
  onPiEntryBindings?: (bindings: Record<string, string>) => void
  onModelResolved?: (model: string) => void
  onContextWindow?: (contextWindow: number) => void
  onRetry?: (update: import('./pi-retry-control').PiRetryUpdate) => void
  /** Passive lifecycle feed for Pi Host Harness; observers cannot control Session or queue prompts. */
  onHarnessLifecycle?: PiHarnessLifecycleObserver
  thinkingLevel?: AgentThinkingLevel
  /**
   * DeepSeek V4 思考总开关（已废弃：思考强度与开关统一由 thinkingLevel 驱动，
   * 通过 createDeepSeekReasoningRequestExtension 注入 output_config.effort）。
   * 保留字段仅为兼容 orchestrator 旧传参，adapter 不再消费。
   */
  deepSeekV4ThinkingEnabled?: boolean
  maxBudgetUsd?: number
  outputFormat?: JsonSchemaOutputFormat
  /** Proma 聚合的附加目录；Pi 内置工具 factory 不接收多 root 参数，编排层会把它们注入 systemPrompt。 */
  additionalDirectories?: string[]
  additionalSkillPaths?: string[]
  /** 当前用户输入显式引用的 Skill name（兼容历史 slug 已在编排层归一化） */
  skillMentions?: string[]
  /** 预设声明的 Skill 白名单（skillSlugs）；undefined 表示不裁剪 */
  skillSlugs?: string[]
  proxyUrl?: string
  /** Pi 模型请求传输策略：auto / sse / websocket / websocket-cached */
  transport?: PiAgentTransport
  /** HTTP 头/响应体空闲超时，单位毫秒；0 表示交给 Pi SDK 禁用超时 */
  httpIdleTimeoutMs?: number
  /** WebSocket 建连超时，单位毫秒；0 表示交给 Pi SDK 禁用超时 */
  websocketConnectTimeoutMs?: number
  runtimeEnv?: AgentRuntimeEnv
  /** 手动压缩请求：走 pi 原生 session.compact()，而非把 /compact 当普通 prompt 发给模型 */
  compactRequest?: boolean
  /** ChatGPT Codex Fast Mode；仅 openai-codex 的受支持模型实际注入 priority service tier。 */
  codexFastMode?: boolean
  /** Pi 的 OAuth credential store 使用真实 expires 和 refresh，不读取 ~/.pi。 */
  codexOAuthCredentials?: CodexOAuthCredentials
  /** Pi 运行中刷新 OAuth 后，将新凭据回写到 Profer 渠道存储。 */
  onCodexOAuthCredentialsRefreshed?: (credentials: CodexOAuthCredentials) => void | Promise<void>
  /** xAI OAuth credential store 使用真实 expires 和 refresh，不读取 ~/.pi。 */
  xaiOAuthCredentials?: XaiOAuthCredentials
  /** Pi 运行中刷新 xAI OAuth 后，将新凭据回写到 Profer 渠道存储。 */
  onXaiOAuthCredentialsRefreshed?: (credentials: XaiOAuthCredentials) => void | Promise<void>
  /** 会话级 OpenAI（Codex OAuth / Responses API）思考深度。 */
  openAIThinkingLevel?: AgentThinkingLevel
}

interface ActivePiSession {
  session?: AgentSession
  resourceLoader?: ResourceLoader
  ready: Promise<AgentSession>
  resolveReady: (session: AgentSession) => void
  rejectReady: (error: unknown) => void
  abortRequested: boolean
  interrupting: boolean
  pendingInterruptPrompts: PendingInterruptPrompt[]
  interruptAbortPromise?: Promise<void>
  readySettled: boolean
  disposed: boolean
  runtimeGuard?: AgentRuntimeGuard
}

interface PendingInterruptPrompt extends PiInterruptReservation {
  /** Reservation is registered before async prompt preparation / abort. */
}

interface ProferTaskItem {
  id: string
  subject: string
  status: 'pending' | 'in_progress' | 'completed' | 'blocked' | 'cancelled' | 'error' | 'deleted'
  description?: string
  activeForm?: string
  blocks?: string[]
}

interface AssistantMessageState {
  uuid?: string
}

export interface PiRemoteConnectionSettings {
  httpProxy?: string
  transport?: PiAgentTransport
  httpIdleTimeoutMs?: number
  websocketConnectTimeoutMs?: number
}

interface AsyncQueue<T> {
  push: (value: T) => void
  fail: (error: unknown) => void
  close: () => void
  next: () => Promise<IteratorResult<T>>
}

/** Pi 原生每个 delta 都携带累计消息；20fps 足够流畅，同时避免 IPC/React 事件风暴。 */
const PI_PARTIAL_UPDATE_INTERVAL_MS = 50

function getCaseInsensitiveRuntimeEnvValue(env: Record<string, string> | undefined, key: string): string | undefined {
  if (!env) return undefined
  const exact = env[key]
  if (exact) return exact
  const foundKey = Object.keys(env).find((name) => name.toLowerCase() === key.toLowerCase())
  const value = foundKey ? env[foundKey] : undefined
  return value || undefined
}

function normalizeProxyUrl(proxyUrl: string | undefined): string | undefined {
  const trimmed = proxyUrl?.trim()
  return trimmed ? trimmed : undefined
}

function resolvePiHttpProxy(input: Pick<PiAgentQueryOptions, 'proxyUrl' | 'runtimeEnv'>): string | undefined {
  return normalizeProxyUrl(input.proxyUrl)
    ?? normalizeProxyUrl(getCaseInsensitiveRuntimeEnvValue(input.runtimeEnv?.env, 'HTTPS_PROXY'))
    ?? normalizeProxyUrl(getCaseInsensitiveRuntimeEnvValue(input.runtimeEnv?.env, 'HTTP_PROXY'))
    ?? normalizeProxyUrl(getCaseInsensitiveRuntimeEnvValue(input.runtimeEnv?.env, 'ALL_PROXY'))
}

const OLLAMA_REMOTE_HTTP_IDLE_TIMEOUT_MS = 10 * 60 * 1000
const OLLAMA_REMOTE_WEBSOCKET_CONNECT_TIMEOUT_MS = 30 * 1000

function isNonNegativeFiniteNumber(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value >= 0
}

function isLocalOllamaBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase()
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]'
  } catch {
    return false
  }
}

export function buildPiRemoteConnectionSettings(
  input: Pick<
    PiAgentQueryOptions,
    'provider' | 'baseUrl' | 'proxyUrl' | 'runtimeEnv' | 'transport' | 'httpIdleTimeoutMs' | 'websocketConnectTimeoutMs'
  >,
): PiRemoteConnectionSettings {
  const httpProxy = resolvePiHttpProxy(input)
  const remoteOllama = input.provider === 'ollama' && !isLocalOllamaBaseUrl(input.baseUrl)
  // Node/Electron 的 WebSocket 不支持请求级 HTTP 代理注入；有代理的 Codex
  // 默认改走可由 undici dispatcher 承载的 SSE。远程 Ollama 固定 SSE，
  // 因为远程反代通常只稳定支持 HTTP 长连接，且推理首 token 可能较慢。
  const transport = input.transport ?? (
    remoteOllama || (httpProxy && input.provider === 'openai-codex')
      ? 'sse'
      : undefined
  )
  const httpIdleTimeoutMs = isNonNegativeFiniteNumber(input.httpIdleTimeoutMs)
    ? input.httpIdleTimeoutMs
    : remoteOllama
      ? OLLAMA_REMOTE_HTTP_IDLE_TIMEOUT_MS
      : undefined
  const websocketConnectTimeoutMs = isNonNegativeFiniteNumber(input.websocketConnectTimeoutMs)
    ? input.websocketConnectTimeoutMs
    : remoteOllama
      ? OLLAMA_REMOTE_WEBSOCKET_CONNECT_TIMEOUT_MS
      : undefined
  return {
    ...(httpProxy ? { httpProxy } : {}),
    ...(transport ? { transport } : {}),
    ...(httpIdleTimeoutMs !== undefined ? { httpIdleTimeoutMs } : {}),
    ...(websocketConnectTimeoutMs !== undefined ? { websocketConnectTimeoutMs } : {}),
  }
}

export function applyPiProxySettingsForQuery(
  sdk: unknown,
  input: Pick<PiAgentQueryOptions, 'proxyUrl' | 'runtimeEnv'>,
): () => void {
  const proxyUrl = resolvePiHttpProxy(input)
  if (!proxyUrl) return () => {}

  // Do not mutate process.env here: two concurrent sessions may have different team/proxy credentials.
  // SettingsManager receives this request-local proxy below; the SDK helper is optional global state, so avoid it.
  void sdk
  return () => {}
}

function createAsyncQueue<T>(): AsyncQueue<T> {
  const values: T[] = []
  const waiters: Array<(result: IteratorResult<T>) => void> = []
  let closed = false
  let failure: unknown

  const flush = (): void => {
    while (waiters.length > 0 && (values.length > 0 || closed || failure)) {
      const waiter = waiters.shift()!
      if (values.length > 0) {
        waiter({ value: values.shift()!, done: false })
      } else if (failure) {
        const err = failure
        failure = undefined
        Promise.resolve().then(() => { throw err }).catch(() => {})
        waiter(Promise.reject(err) as unknown as IteratorResult<T>)
      } else {
        waiter({ value: undefined, done: true })
      }
    }
  }

  return {
    push(value) {
      if (closed) return
      values.push(value)
      flush()
    },
    fail(error) {
      if (closed) return
      failure = error
      closed = true
      flush()
    },
    close() {
      closed = true
      flush()
    },
    next() {
      if (values.length > 0) {
        return Promise.resolve({ value: values.shift()!, done: false })
      }
      if (failure) {
        const err = failure
        failure = undefined
        return Promise.reject(err)
      }
      if (closed) {
        return Promise.resolve({ value: undefined, done: true })
      }
      return new Promise<IteratorResult<T>>((resolve) => waiters.push(resolve))
    },
  }
}

const FRIENDLY_ERROR_MESSAGES: Array<{ pattern: RegExp; message: string }> = [
  {
    pattern: /api key|unauthorized|invalid.*key|authentication/i,
    message: '请检查是否选择了正确的 Profer 供应渠道和模型',
  },
  {
    pattern: /validation|schema/i,
    message: 'API 请求格式校验失败，请重试或开启新会话',
  },
]

const MAX_ERROR_MESSAGE_LENGTH = 5000
const SESSION_READY_TIMEOUT_MS = 60_000
const PROMPT_TOO_LONG_PATTERNS = [
  'prompt is too long',
  'prompt_too_long',
  'input is too long',
  'context_length_exceeded',
  'maximum context length',
  'context length',
  'context window',
  'maximum context',
  'token limit',
  'too many tokens',
  'exceeds the model',
  'exceed the model',
] as const
const SKILL_COMMAND_PATTERN = /\/skill:([A-Za-z0-9][A-Za-z0-9._-]*)/g

function createActivePiSession(): ActivePiSession {
  let resolveReady!: (session: AgentSession) => void
  let rejectReady!: (error: unknown) => void
  const ready = new Promise<AgentSession>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  ready.catch(() => {})
  return {
    ready,
    resolveReady,
    rejectReady,
    abortRequested: false,
    interrupting: false,
    pendingInterruptPrompts: [],
    readySettled: false,
    disposed: false,
  }
}

function resolveActiveReady(active: ActivePiSession, session: AgentSession): void {
  if (active.readySettled) return
  active.readySettled = true
  active.resolveReady(session)
}

function rejectActiveReady(active: ActivePiSession, error: unknown): void {
  if (active.readySettled) return
  active.readySettled = true
  active.rejectReady(error)
}

function createAbortError(): Error {
  const error = new Error('Agent 执行已停止')
  error.name = 'AbortError'
  return error
}

function rejectPendingInterruptPrompts(active: ActivePiSession, error: unknown): void {
  const pending = active.pendingInterruptPrompts.splice(0)
  for (const prompt of pending) {
    prompt.rejectAccepted(error)
  }
}

async function waitForActiveSession(active: ActivePiSession): Promise<AgentSession> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      active.ready,
      new Promise<AgentSession>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Agent 会话初始化超时，请稍后重试')), SESSION_READY_TIMEOUT_MS)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export function friendlyErrorMessage(raw: string): string {
  const isLong = raw.length > MAX_ERROR_MESSAGE_LENGTH
  const sample = isLong ? raw.slice(0, MAX_ERROR_MESSAGE_LENGTH) : raw
  for (const { pattern, message } of FRIENDLY_ERROR_MESSAGES) {
    if (pattern.test(sample)) return message
  }
  return isLong
    ? sample + `\n\n[错误详情过长 (${(raw.length / 1024).toFixed(0)}KB)，已截断]`
    : raw
}

export function isPromptTooLongError(...messages: Array<string | undefined>): boolean {
  const text = messages
    .filter((message): message is string => typeof message === 'string')
    .join(' ')
    .toLowerCase()
  return PROMPT_TOO_LONG_PATTERNS.some((pattern) => text.includes(pattern))
}

export function isThinkingSignatureError(message: string, originalError?: string): boolean {
  return matchesThinkingSignatureError(message, originalError)
}

function stringifyErrorContent(content: unknown): string | undefined {
  if (typeof content === 'string' && content.trim()) return content
  if (Array.isArray(content)) {
    const text = content
      .map((block) => {
        if (!block || typeof block !== 'object') return ''
        const record = block as Record<string, unknown>
        if (typeof record.text === 'string') return record.text
        if (typeof record.message === 'string') return record.message
        return ''
      })
      .filter(Boolean)
      .join('\n')
      .trim()
    return text || undefined
  }
  if (content && typeof content === 'object') {
    const record = content as Record<string, unknown>
    if (typeof record.message === 'string') return record.message
    if (typeof record.error === 'string') return record.error
    return JSON.stringify(record)
  }
  return undefined
}

export function extractErrorDetails(error: {
  error?: string | { message?: string; errorType?: string }
  errorMessage?: string
  errors?: unknown[]
  message?: { content?: unknown }
  content?: unknown
}): {
  detailedMessage: string
  originalError: string
} {
  const direct = typeof error.error === 'string' ? error.error : error.error?.message ?? error.errorMessage
  if (direct) return { detailedMessage: direct, originalError: direct }
  const fromMessage = stringifyErrorContent(error.message?.content ?? error.content)
  if (fromMessage) return { detailedMessage: fromMessage, originalError: fromMessage }
  const fromErrors = Array.isArray(error.errors)
    ? error.errors.map((item) => stringifyErrorContent(item)).filter(Boolean).join('\n')
    : undefined
  if (fromErrors) return { detailedMessage: fromErrors, originalError: fromErrors }
  return { detailedMessage: 'Agent 执行失败', originalError: '' }
}

/** 各错误码对应的标题与是否可重试（用于构建差异化 TypedError） */
const ERROR_CODE_META: Partial<Record<ErrorCode, { title: string; canRetry: boolean }>> = {
  invalid_api_key: { title: '认证失败', canRetry: true },
  billing_error: { title: '账单错误', canRetry: false },
  rate_limited: { title: '请求频率限制', canRetry: true },
  prompt_too_long: { title: '上下文过长', canRetry: false },
  invalid_request: { title: '请求无效', canRetry: false },
  service_unavailable: { title: '服务暂时不可用', canRetry: true },
  service_error: { title: '服务错误', canRetry: true },
  provider_error: { title: '服务繁忙', canRetry: true },
  network_error: { title: '网络异常', canRetry: true },
  invalid_model: { title: '模型不可用', canRetry: false },
  agent_runtime_not_found: { title: 'Agent 核心未就绪', canRetry: false },
}

/**
 * 判断错误文本是否为 pi runtime 模块加载失败（打包遗漏依赖 / 安装损坏）。
 *
 * 只匹配明确的 Node 模块解析失败措辞，且要求同时提及 pi 运行时包名，
 * 避免上游错误正文里偶然出现包名字符串就被误判为「核心未就绪」（那会错误地丢失可重试性）。
 */
export function isRuntimeNotFoundError(text: string): boolean {
  const isModuleResolutionFailure = /cannot find module|module not found|err_module_not_found|failed to (?:load|resolve)/i.test(text)
  if (!isModuleResolutionFailure) return false
  return /pi-coding-agent|pi-agent-core|@earendil-works/i.test(text)
}

/** 从错误文本中兜底提取 HTTP 状态码（锚定在明确的状态码上下文，避免误匹配正文数字） */
function extractHttpStatusFromErrorText(...messages: Array<string | undefined>): number | null {
  const combined = messages.filter(Boolean).join('\n')
  const patterns = [
    /API Error:\s*(\d{3})/i,
    /API error[^:]*:\s+(\d{3})/i,
    /\b(?:HTTP|status|statusCode)\s*[:=]?\s*(\d{3})\b/i,
    /\b(\d{3})\s+\{[^}]*"error"/is,
  ]
  for (const pattern of patterns) {
    const match = combined.match(pattern)
    const statusCode = match?.[1] ? parseInt(match[1], 10) : NaN
    if (statusCode >= 400 && statusCode < 600) return statusCode
  }
  return null
}

export function mapSDKErrorToTypedError(errorCode: string, message: string, originalError?: string): TypedError {
  const diagnosticText = `${errorCode}\n${message}\n${originalError ?? ''}`

  // thinking-signature：中途切换模型导致思考标签不互认，需保留专属文案与「在新对话继续」动作
  if (isThinkingSignatureError(message, originalError)) {
    return {
      code: 'thinking_signature_invalid',
      title: THINKING_SIGNATURE_ERROR_TITLE,
      message: THINKING_SIGNATURE_ERROR_MESSAGE,
      actions: [
        { key: 'n', label: '在新对话继续', action: 'retry_in_new_session' },
        { key: 'r', label: '重试', action: 'retry' },
      ],
      canRetry: true,
      retryDelayMs: 1000,
      originalError,
    }
  }

  let code: ErrorCode = 'unknown_error'
  const httpStatus = extractHttpStatusFromErrorText(message, originalError, errorCode)
  if (isRuntimeNotFoundError(diagnosticText)) {
    // pi runtime 动态 import 失败（打包遗漏依赖 / 安装损坏），产出定向的「核心未就绪」错误码，
    // 让 UI 给出「请重新安装」引导，而非泛化的 unknown_error
    code = 'agent_runtime_not_found'
  } else if (/api.*key|unauthorized|authentication|invalid.*credential/i.test(diagnosticText)) {
    code = 'invalid_api_key'
  } else if (/billing|quota|insufficient_quota|credit|balance|payment|subscription/i.test(diagnosticText)) {
    code = 'billing_error'
  } else if (/rate.?limit/i.test(diagnosticText) || httpStatus === 429) {
    code = 'rate_limited'
  } else if (isPromptTooLongError(message, originalError, errorCode)) {
    code = 'prompt_too_long'
  } else if (isMalformedResponseError(message, originalError)) {
    // 上游返回无法解析的响应体（网关 HTML 错误页 / SSE 截断 / 脏数据），瞬时异常，可重试
    code = 'service_error'
  } else if (TRANSIENT_NETWORK_PATTERN.test(message) || TRANSIENT_NETWORK_PATTERN.test(originalError ?? '')) {
    code = 'network_error'
  } else if (/overloaded/i.test(diagnosticText) || httpStatus === 529) {
    code = 'provider_error'
  } else if (/service unavailable/i.test(diagnosticText) || httpStatus === 503) {
    code = 'service_unavailable'
  } else if (httpStatus === 500 || httpStatus === 502 || (httpStatus != null && httpStatus >= 500)) {
    // HTTP 5xx（含 500 内部错误 / 502 网关异常）通常为上游瞬时故障，可重试
    code = 'service_error'
  } else if (/invalid request|bad request|400|schema|validation/i.test(diagnosticText)) {
    code = 'invalid_request'
  } else if (/network|fetch|socket|terminated|ECONNRESET/i.test(diagnosticText)) {
    code = 'network_error'
  } else if (/model/i.test(diagnosticText)) {
    code = 'invalid_model'
  }

  const meta = ERROR_CODE_META[code] ?? { title: 'Agent 执行失败', canRetry: false }
  // 认证/渠道配置类错误友好化后文案固定，引导用户直接重新选择模型，而非跳转设置
  const isInvalidChannelOrModel = /请检查是否选择了正确的 Profer 供应渠道和模型/.test(message)

  const actions: RecoveryAction[] = [
    isInvalidChannelOrModel
      ? { key: 'm', label: '重新选择模型', action: 'select_model' }
      : { key: 's', label: '设置', action: 'settings' },
    ...(meta.canRetry ? [{ key: 'r', label: '重试', action: 'retry' }] : []),
    ...(code === 'prompt_too_long' ? [{ key: 'c', label: '压缩上下文', action: 'compact' }] : []),
  ]

  return {
    code,
    title: meta.title,
    message,
    actions,
    canRetry: meta.canRetry,
    retryDelayMs: meta.canRetry ? 1000 : undefined,
    originalError,
  }
}

/** 轻量 session-id → file-path 索引缓存，避免每次 resume 时递归扫描磁盘 */
const sessionFileIndex = new Map<string, string>()
let sessionDirIndexed: string | undefined
let sessionFileIndexedPaths: Set<string> | undefined
/** 递归扫描的最大目录深度，防止极端深层嵌套（异常数据 / 错误挂载）拖慢甚至爆栈。 */
const SESSION_SCAN_MAX_DEPTH = 24

function findSessionFile(sessionDir: string, sdkSessionId: string): string | undefined {
  if (!existsSync(sessionDir)) return undefined

  // 复用上次索引；如果 sessionDir 变了则重建
  if (sessionDirIndexed !== sessionDir) {
    sessionFileIndex.clear()
    sessionFileIndexedPaths = new Set<string>()
    sessionDirIndexed = sessionDir
  }

  if (sessionFileIndex.has(sdkSessionId)) {
    const cached = sessionFileIndex.get(sdkSessionId)!
    // 验证缓存文件还存在
    if (existsSync(cached)) return cached
    sessionFileIndex.delete(sdkSessionId)
  }

  // 缓存未命中：扫描磁盘（仅一次）
  const scanDirectory = (directory: string, depth = 0): void => {
    if (depth > SESSION_SCAN_MAX_DEPTH) return
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const candidate = join(directory, entry.name)
      if (entry.isDirectory()) {
        scanDirectory(candidate, depth + 1)
        continue
      }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
      // 已经在索引中的文件跳过（用 Set 避免每次 O(n) 遍历）
      if (sessionFileIndexedPaths?.has(candidate)) continue
      sessionFileIndexedPaths?.add(candidate)
      try {
        const headerLine = readFileSync(candidate, 'utf-8').split('\n', 1)[0]
        const header = headerLine ? JSON.parse(headerLine) as { type?: unknown; id?: unknown } : undefined
        if (header?.type === 'session' && typeof header.id === 'string' && header.id) {
          sessionFileIndex.set(header.id, candidate)
        }
      } catch {
        // 非 Pi JSONL 或损坏文件不能作为 resume 候选。
      }
    }
  }
  scanDirectory(sessionDir)
  // Pi 文件按 cwd 分子目录存储；不能对 session ID 做 includes 模糊匹配，重复 ID 也不能任选。
  return sessionFileIndex.get(sdkSessionId)
}

function isPathWithinRoot(path: string, root: string): boolean {
  if (path === root) return true
  const rel = relative(root, path)
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel)
}

function buildAllowedSkillRoots(additionalSkillPaths: string[] | undefined): string[] {
  return (additionalSkillPaths ?? [])
    .map((path) => resolveGuardedRealPath(path))
    .filter((path, index, arr) => arr.indexOf(path) === index)
}

function isPromaSkillPath(path: string | undefined, allowedRoots: string[]): boolean {
  if (!path || allowedRoots.length === 0) return false
  const guardedPath = resolveGuardedRealPath(path)
  return allowedRoots.some((root) => isPathWithinRoot(guardedPath, root))
}

/**
 * 按预设 skillSlugs 白名单过滤 skill。
 * 名字匹配规则与 skillCommandAliases 一致：SKILL.md name / 目录名 / 父目录名。
 * undefined = 不裁剪；空 Set（skillSlugs: []）= 0 个 skill，全部隐藏。
 */
function matchesSkillSlug(skill: Skill, slugs: Set<string> | undefined): boolean {
  if (slugs === undefined) return true
  return skillCommandAliases(skill).some((alias) => slugs.has(normalizeDefaultSkillSlug(alias)))
}

/** 若 Skill 是已改名默认 Skill 的任一版本，返回其当前规范 slug。 */
function canonicalRenamedDefaultSkillSlug(skill: Skill): string | undefined {
  const aliases = skillCommandAliases(skill)
  for (const [oldSlug, newSlug] of RENAMED_DEFAULT_SKILLS) {
    if (aliases.includes(oldSlug) || aliases.includes(newSlug)) return newSlug
  }
  return undefined
}

function isCanonicalDefaultSkillPath(skill: Skill, canonicalSlug: string): boolean {
  return skill.name === canonicalSlug || basename(skill.baseDir) === canonicalSlug
}

/**
 * 新旧默认 Skill 同时存在时，优先保留当前 slug 的副本，避免同一规则被重复注入。
 * 仅影响明确登记的历史默认 slug；其它同名用户 Skill 保留既有加载行为。
 */
function dedupeRenamedDefaultSkills(skills: Skill[]): Skill[] {
  const result: Skill[] = []
  const indexes = new Map<string, number>()
  for (const skill of skills) {
    const canonicalSlug = canonicalRenamedDefaultSkillSlug(skill)
    if (!canonicalSlug) {
      result.push(skill)
      continue
    }
    const existingIndex = indexes.get(canonicalSlug)
    if (existingIndex === undefined) {
      indexes.set(canonicalSlug, result.length)
      result.push(skill)
      continue
    }
    const existing = result[existingIndex]
    if (!existing) {
      indexes.set(canonicalSlug, result.length)
      result.push(skill)
      continue
    }
    if (isCanonicalDefaultSkillPath(skill, canonicalSlug) && !isCanonicalDefaultSkillPath(existing, canonicalSlug)) {
      result[existingIndex] = skill
    }
  }
  return result
}

export function createPromaSkillsOverride(additionalSkillPaths: string[] | undefined, skillSlugs?: string[]): (base: SkillLoadResult) => SkillLoadResult {
  const allowedRoots = buildAllowedSkillRoots(additionalSkillPaths)
  // 语义：undefined = 不裁剪（全量注入）；[] = 明确 0 个 skill（全部隐藏）；非空 = 白名单。
  // 不能用 `skillSlugs ?? []` 再转 Set，否则丢失 undefined 与空数组的区分（空数组是合法的"全禁"表达）。
  const normalizedSkillSlugs = normalizeDefaultSkillSlugs(skillSlugs)
  const slugSet = normalizedSkillSlugs === undefined ? undefined : new Set(normalizedSkillSlugs)
  return (base) => ({
    skills: dedupeRenamedDefaultSkills(base.skills.filter((skill) =>
      (isPromaSkillPath(skill.filePath, allowedRoots) || isPromaSkillPath(skill.baseDir, allowedRoots))
      && matchesSkillSlug(skill, slugSet))),
    diagnostics: base.diagnostics.filter((diagnostic) => isPromaSkillPath(diagnostic.path, allowedRoots)),
  })
}

function stripSkillFrontmatter(content: string): string {
  const normalized = content.replace(/^\uFEFF/, '')
  const frontmatter = normalized.match(/^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)\s*(?:\r?\n|$)/)
  return frontmatter ? normalized.slice(frontmatter[0].length) : content
}

function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function skillCommandAliases(skill: Skill): string[] {
  const aliases = [skill.name, basename(skill.baseDir), basename(dirname(skill.filePath))]
  return aliases.filter((alias, index, arr) => Boolean(alias) && arr.indexOf(alias) === index)
}

function extractSkillCommandNames(prompt: string): string[] {
  const names: string[] = []
  const seen = new Set<string>()
  for (const match of prompt.matchAll(SKILL_COMMAND_PATTERN)) {
    const name = match[1]?.trim()
    if (!name || seen.has(name)) continue
    seen.add(name)
    names.push(name)
  }
  return names
}

function buildSkillLookup(skills: Skill[]): Map<string, Skill> {
  const lookup = new Map<string, Skill>()
  for (const skill of skills) {
    for (const alias of skillCommandAliases(skill)) {
      if (!lookup.has(alias)) lookup.set(alias, skill)
      const normalizedAlias = normalizeDefaultSkillSlug(alias)
      if (!lookup.has(normalizedAlias)) lookup.set(normalizedAlias, skill)
    }
  }
  return lookup
}

function formatSkillForPrompt(skill: Skill): string | undefined {
  try {
    const body = stripSkillFrontmatter(readFileSync(skill.filePath, 'utf-8')).trim()
    return `<skill name="${escapeXmlAttribute(skill.name)}" location="${escapeXmlAttribute(skill.filePath)}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`
  } catch (error) {
    console.warn(`[Pi SDK] Skill 展开失败: ${skill.filePath}`, error)
    return undefined
  }
}

async function preparePromptWithPromaSkills(
  resourceLoader: ResourceLoader,
  prompt: string,
  explicitSkillNames?: string[],
): Promise<string> {
  await resourceLoader.reload()

  const requestedNames = (explicitSkillNames?.length ? explicitSkillNames : extractSkillCommandNames(prompt))
    .map(normalizeDefaultSkillSlug)
  if (requestedNames.length === 0) return prompt

  const skillLookup = buildSkillLookup(resourceLoader.getSkills().skills)
  const blocks: string[] = []
  const injectedSkillNames = new Set<string>()

  for (const requestedName of requestedNames) {
    const skill = skillLookup.get(requestedName)
    if (!skill || injectedSkillNames.has(skill.name)) continue
    const block = formatSkillForPrompt(skill)
    if (!block) continue
    injectedSkillNames.add(skill.name)
    blocks.push(block)
  }

  if (blocks.length === 0) return prompt
  return `${blocks.join('\n\n')}\n\n${prompt}`
}

function realpathIfExists(path: string): string | undefined {
  try {
    return realpathSync.native(path)
  } catch {
    return undefined
  }
}

function findNearestExistingPath(path: string): string | undefined {
  let current = path
  while (true) {
    try {
      lstatSync(current)
      return current
    } catch {
      const parent = dirname(current)
      if (parent === current) return undefined
      current = parent
    }
  }
}

function resolveGuardedRealPath(path: string): string {
  const resolved = resolve(path)
  const exact = realpathIfExists(resolved)
  if (exact) return exact

  const nearestExisting = findNearestExistingPath(resolved)
  if (!nearestExisting) return resolved

  const nearestReal = realpathIfExists(nearestExisting)
  if (!nearestReal) return resolved

  const tail = relative(nearestExisting, resolved)
  return tail ? resolve(nearestReal, tail) : nearestReal
}

interface ToolWrapOptions {
  canUseTool?: PiAgentQueryOptions['canUseTool']
}

function wrapToolWithPermission<TParams extends TSchema, TDetails, TState>(
  definition: ToolDefinition<TParams, TDetails, TState>,
  options: ToolWrapOptions,
): ToolDefinition<TParams, TDetails, TState> {
  const canUseTool = options.canUseTool
  const executionMode = 'sequential' as const
  if (!canUseTool) return { ...definition, executionMode }
  return {
    ...definition,
    executionMode,
    async execute(toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult<TDetails>> {
      const rawInput = params as Record<string, unknown>
      let updatedParams = rawInput
      if (canUseTool) {
        const permission = await canUseTool(displayToolName(definition.name, rawInput), normalizePermissionInput(definition.name, rawInput), {
          signal: signal ?? new AbortController().signal,
          toolUseID: toolCallId,
          displayName: definition.label,
          description: definition.description,
        })
        if (permission.behavior === 'deny') {
          throw new Error(permission.message)
        }
        updatedParams = restorePiInput(definition.name, rawInput, permission.updatedInput)
      }
      return definition.execute(
        toolCallId,
        updatedParams as typeof params,
        signal,
        onUpdate as AgentToolUpdateCallback<TDetails> | undefined,
        ctx,
      ) as Promise<AgentToolResult<TDetails>>
    },
  }
}

function createJsonToolResult(payload: unknown): AgentToolResult<unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    details: payload,
  } as AgentToolResult<unknown>
}

function createTextToolResult(text: string, details?: unknown): AgentToolResult<unknown> {
  return {
    content: [{ type: 'text', text }],
    details,
  } as AgentToolResult<unknown>
}

function isCompactionNoopError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /nothing to compact|already compacted/i.test(message)
}

/**
 * Pi 在 agent_end 之后才会决定一条失败消息是否触发 overflow 压缩。
 * 只有当上下文确已溢出时，才把这条错误类“挂起”，等匹配的压缩生命周期到终态
 * 再放行，避免外层编排器在 Pi 调用 agent.continue() 前就销毁 session。
 */
function isPiContextOverflow(message: AssistantMessage, contextWindow: number | undefined): boolean {
  if (message.stopReason === 'error' && isPromptTooLongError(message.errorMessage)) return true

  if (contextWindow && message.stopReason === 'length' && message.usage?.output === 0) {
    const inputTokens = (message.usage.input ?? 0) + (message.usage.cacheRead ?? 0)
    return inputTokens >= contextWindow * 0.99
  }

  return false
}

export function shouldDeferPiOverflowTerminalMessage(
  message: AssistantMessage,
  contextWindow: number | undefined,
): boolean {
  return message.stopReason !== 'stop' && isPiContextOverflow(message, contextWindow)
}

export function shouldDeferPiOverflowTerminalError(
  message: AssistantMessage | undefined,
  contextWindow: number | undefined,
  willRetry: boolean,
  abortRequested: boolean,
): boolean {
  return !willRetry && !abortRequested && !!message && shouldDeferPiOverflowTerminalMessage(message, contextWindow)
}

/** 模型主动请求压缩（CompactContext）后自动续跑的最大次数。 */
const MAX_AUTOMATIC_COMPACTION_CONTINUATIONS = 20

export const PI_COMPACTION_CONTINUATION_PROMPT = `<profer_compaction_continuation>
当前会话上下文已经安全压缩。请依据压缩摘要、保留的最近上下文和已持久化的交接状态，继续完成原始用户任务。

- 不要重复已经完成或已提交的操作；先核验当前状态。
- 若仍有工作，立即执行下一项具体行动。
- 只有原始需求全部完成时才给出最终答复；若确实受阻，明确说明阻塞原因。
</profer_compaction_continuation>`

export function planPiCompactionContinuation(options: {
  continuationCount: number
  abortRequested: boolean
  runtimeLimitReached: boolean
}):
  | { shouldContinue: true; prompt: string }
  | { shouldContinue: false; reason: 'aborted' | 'runtime_limit' | 'continuation_limit' } {
  if (options.abortRequested) return { shouldContinue: false, reason: 'aborted' }
  if (options.runtimeLimitReached) return { shouldContinue: false, reason: 'runtime_limit' }
  if (options.continuationCount >= MAX_AUTOMATIC_COMPACTION_CONTINUATIONS) {
    return { shouldContinue: false, reason: 'continuation_limit' }
  }
  return { shouldContinue: true, prompt: PI_COMPACTION_CONTINUATION_PROMPT }
}

export function canRunCurrentSessionCompaction(toolNames: string[]): boolean {
  return toolNames.length === 1 && toolNames[0] === 'CompactContext'
}

/** AskUserQuestion 必须暂停整个工具批次，不能与后续动作混合执行。 */
export function shouldBlockToolForAskUserQuestion(toolNames: string[], toolName: string): boolean {
  return toolName !== 'AskUserQuestion'
    && toolNames.includes('AskUserQuestion')
    && toolNames.length > 1
}

function createCompactionNoopMessage(sessionId: string, error: unknown): SDKMessage {
  const message = error instanceof Error ? error.message : String(error)
  return {
    type: 'system',
    subtype: 'compact_noop',
    session_id: sessionId,
    message: /already compacted/i.test(message)
      ? '当前上下文已经压缩过，无需重复压缩。'
      : '当前上下文较小，暂时无需压缩。',
  } as unknown as SDKMessage
}

function createCompactionContinuationLimitResult(sessionId: string): SDKMessage {
  return {
    type: 'result',
    subtype: 'error_during_execution',
    terminal_reason: 'compaction_continuation_limit',
    errors: [`自动压缩续跑已达上限（${MAX_AUTOMATIC_COMPACTION_CONTINUATIONS} 次），任务未确认完成。请检查当前状态后继续。`],
    session_id: sessionId,
  } as unknown as SDKMessage
}

function createTerminatingJsonToolResult(payload: unknown): AgentToolResult<unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    details: payload,
    terminate: true,
  } as AgentToolResult<unknown>
}

function installCurrentSessionCompactionHooks(session: AgentSession): void {
  const previousBeforeToolCall = session.agent.beforeToolCall
  session.agent.beforeToolCall = async (context, signal) => {
    const previousResult = await previousBeforeToolCall?.(context, signal)
    if (previousResult?.block) return previousResult

    const toolNames = context.assistantMessage.content
      .filter((block) => block.type === 'toolCall')
      .map((block) => block.name)
    if (shouldBlockToolForAskUserQuestion(toolNames, context.toolCall.name)) {
      return {
        block: true,
        reason: 'AskUserQuestion 会暂停 Agent，不能与其他工具在同一批次执行。请在收到用户回答后再调用后续工具。',
      }
    }

    if (context.toolCall.name !== 'CompactContext') return previousResult
    if (canRunCurrentSessionCompaction(toolNames)) return previousResult

    // Pi 只在整批工具都是终止型时才 honor terminate。拒绝混合批次可防止在压缩前
    // 继续更多工具工作或再来一轮模型 turn。
    return {
      block: true,
      reason: 'CompactContext 必须单独调用。请先完成当前工具批次，在下一回合仅调用 CompactContext。',
    }
  }
}

/**
 * Creates a session-scoped compaction control. The callback is closed over by one
 * query invocation, so a model cannot select or compact any other user session.
 */
export function buildCurrentSessionCompactionTool(
  sdk: PiSdk,
  requestCompaction: () => void,
  canUseTool: PiAgentQueryOptions['canUseTool'],
): ToolDefinition {
  const definition = sdk.defineTool({
    name: 'CompactContext',
    label: '压缩当前会话上下文',
    description: 'Compact only the current Pi Agent session after this turn finishes. Before calling, persist a durable handoff or checkpoint to the session workbench or project files as appropriate. Profer will compact the current session, then automatically continue the original task from the compacted context.',
    promptSnippet: 'CompactContext: after persisting a durable handoff/checkpoint, compact the current session context. Profer will automatically continue the original task after compaction.',
    parameters: Type.Object({}),
    async execute() {
      requestCompaction()
      return createTerminatingJsonToolResult({
        status: 'scheduled',
        message: '将在当前 Agent 回合安全结束后压缩当前会话上下文，并自动从已持久化的交接状态继续原始任务。',
      })
    },
  })

  return wrapToolWithPermission(
    definition as unknown as ToolDefinition<TSchema, unknown, unknown>,
    { canUseTool },
  ) as ToolDefinition
}

export async function compactCurrentSessionAfterTurn(
  session: Pick<AgentSession, 'compact' | 'sessionId'>,
  onNoop: (message: SDKMessage) => void,
): Promise<'compacted' | 'noop'> {
  try {
    await session.compact()
    return 'compacted'
  } catch (error) {
    if (!isCompactionNoopError(error)) throw error
    onNoop(createCompactionNoopMessage(session.sessionId, error))
    return 'noop'
  }
}

function stringFromInput(input: Record<string, unknown>, keys: string[], fallback = ''): string {
  for (const key of keys) {
    const value = input[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number') return String(value)
  }
  return fallback
}

function normalizeTaskStatus(value: unknown, fallback: ProferTaskItem['status']): ProferTaskItem['status'] {
  if (
    value === 'pending' ||
    value === 'in_progress' ||
    value === 'completed' ||
    value === 'blocked' ||
    value === 'cancelled' ||
    value === 'error' ||
    value === 'deleted'
  ) {
    return value
  }
  return fallback
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const items = value.map((item) => String(item).trim()).filter(Boolean)
  return items.length > 0 ? items : undefined
}

export function buildPromaProductToolDefinitions(
  sdk: PiSdk,
  canUseTool: PiAgentQueryOptions['canUseTool'],
): ToolDefinition[] {
  const tasks = new Map<string, ProferTaskItem>()
  let nextTaskId = 1

  const definitions = [
    sdk.defineTool({
      name: 'EnterPlanMode',
      label: '进入计划模式',
      description: '进入 Profer 计划模式。进入后只能调研、整理计划，并等待用户批准后再执行写操作。',
      promptSnippet: '进入计划模式，先调研并输出计划，再等待用户确认。',
      parameters: Type.Object({
        reason: Type.Optional(Type.String({ description: '进入计划模式的原因。' })),
      }),
      async execute(_toolCallId, params) {
        return createTextToolResult('已进入计划模式。', { active: true, input: params })
      },
    }),
    sdk.defineTool({
      name: 'ExitPlanMode',
      label: '提交计划审批',
      description: '向用户提交计划并请求批准。用户批准后才能退出计划模式并继续执行。',
      promptSnippet: '提交计划审批，等待用户批准后继续执行。',
      parameters: Type.Object({
        plan: Type.Optional(Type.String({ description: '计划正文或摘要。' })),
        allowedPrompts: Type.Optional(Type.Array(Type.Object({
          tool: Type.String({ description: '批准后可执行的工具，通常为 Bash。' }),
          prompt: Type.String({ description: '批准后可执行的命令或操作描述。' }),
        }))),
      }),
      async execute(_toolCallId, params) {
        return createTextToolResult('计划已获批准，可以继续执行。', { approved: true, input: params })
      },
    }),
    sdk.defineTool({
      name: 'AskUserQuestion',
      label: '询问用户',
      description: '当需要用户选择、补充信息或确认偏好时调用，Profer 会展示可交互问答横幅。',
      promptSnippet: '向用户提出结构化问题并等待回答。',
      parameters: Type.Object({
        questions: Type.Array(Type.Object({
          question: Type.String({ description: '要询问用户的问题。' }),
          header: Type.Optional(Type.String({ description: '简短标题。' })),
          multiSelect: Type.Optional(Type.Boolean({ description: '是否允许多选。' })),
          options: Type.Optional(Type.Array(Type.Object({
            label: Type.String({ description: '选项标签。' }),
            description: Type.Optional(Type.String({ description: '选项说明。' })),
            preview: Type.Optional(Type.String({ description: '可选预览内容。' })),
          }))),
        })),
        answers: Type.Optional(Type.Record(Type.String(), Type.String())),
        // 受管的 Deck Brief 确认 metadata 只由主进程消费，不进入 renderer 展示。
        proferConfirmation: Type.Optional(Type.Object({
          kind: Type.Literal('deck-brief'),
          projectDir: Type.String(),
          confirmationToken: Type.String(),
        })),
      }),
      async execute(_toolCallId, params) {
        const input = params as Record<string, unknown>
        return createJsonToolResult({ answers: input.answers ?? {} })
      },
    }),
    sdk.defineTool({
      name: 'TaskCreate',
      label: '创建任务',
      description: '创建一个可见进度任务，用于多步骤或长耗时工作。',
      promptSnippet: '创建一个可见进度任务。',
      parameters: Type.Object({
        subject: Type.String({ description: '任务标题。' }),
        description: Type.Optional(Type.String({ description: '任务说明。' })),
        activeForm: Type.Optional(Type.String({ description: '当前活动形态或阶段。' })),
        blocks: Type.Optional(Type.Array(Type.String({ description: '关联区块 ID。' }))),
      }),
      async execute(_toolCallId, params) {
        const input = params as Record<string, unknown>
        const id = stringFromInput(input, ['id', 'taskId', 'task_id'], String(nextTaskId++))
        const task: ProferTaskItem = {
          id,
          subject: stringFromInput(input, ['subject', 'title', 'name'], `任务 #${id}`),
          status: 'pending',
          description: typeof input.description === 'string' ? input.description : undefined,
          activeForm: typeof input.activeForm === 'string' ? input.activeForm : undefined,
          blocks: normalizeStringArray(input.blocks),
        }
        tasks.set(id, task)
        return createJsonToolResult({ task })
      },
    }),
    sdk.defineTool({
      name: 'TaskUpdate',
      label: '更新任务',
      description: '更新已有可见进度任务的状态、标题或说明。',
      promptSnippet: '更新可见进度任务。',
      parameters: Type.Object({
        taskId: Type.String({ description: '任务 ID。' }),
        status: Type.Optional(Type.Union([
          Type.Literal('pending'),
          Type.Literal('in_progress'),
          Type.Literal('completed'),
          Type.Literal('blocked'),
          Type.Literal('cancelled'),
          Type.Literal('error'),
          Type.Literal('deleted'),
        ])),
        subject: Type.Optional(Type.String({ description: '新的任务标题。' })),
        description: Type.Optional(Type.String({ description: '新的任务说明。' })),
        activeForm: Type.Optional(Type.String({ description: '当前活动形态或阶段。' })),
        blocks: Type.Optional(Type.Array(Type.String({ description: '关联区块 ID。' }))),
      }),
      async execute(_toolCallId, params) {
        const input = params as Record<string, unknown>
        const id = stringFromInput(input, ['taskId', 'task_id', 'id'])
        if (!id) throw new Error('taskId 必填')
        const existing = tasks.get(id)
        const task: ProferTaskItem = {
          id,
          subject: stringFromInput(input, ['subject', 'title', 'name'], existing?.subject ?? `任务 #${id}`),
          status: normalizeTaskStatus(input.status, existing?.status ?? 'pending'),
          description: typeof input.description === 'string' ? input.description : existing?.description,
          activeForm: typeof input.activeForm === 'string' ? input.activeForm : existing?.activeForm,
          blocks: normalizeStringArray(input.blocks) ?? existing?.blocks,
        }
        tasks.set(id, task)
        return createJsonToolResult({ task })
      },
    }),
    sdk.defineTool({
      name: 'TaskGet',
      label: '查看任务',
      description: '读取某个可见进度任务的当前状态。',
      promptSnippet: '查看可见进度任务。',
      parameters: Type.Object({
        taskId: Type.String({ description: '任务 ID。' }),
      }),
      async execute(_toolCallId, params) {
        const input = params as Record<string, unknown>
        const id = stringFromInput(input, ['taskId', 'task_id', 'id'])
        if (!id) throw new Error('taskId 必填')
        const task = tasks.get(id)
        if (!task) throw new Error(`任务不存在: ${id}`)
        return createJsonToolResult({ task })
      },
    }),
    sdk.defineTool({
      name: 'TaskList',
      label: '任务列表',
      description: '列出当前 turn 中已创建的可见进度任务。',
      promptSnippet: '列出可见进度任务。',
      parameters: Type.Object({
        reason: Type.Optional(Type.String({ description: '读取任务列表的原因。' })),
      }),
      async execute() {
        return createJsonToolResult({ tasks: [...tasks.values()].filter((task) => task.status !== 'deleted') })
      },
    }),
    sdk.defineTool({
      name: 'TodoRead',
      label: '读取待办',
      description: '读取当前 turn 的任务列表。兼容 Claude SDK 的 TodoRead。',
      promptSnippet: '读取当前待办列表。',
      parameters: Type.Object({}),
      async execute() {
        return createJsonToolResult({ todos: [...tasks.values()].filter((task) => task.status !== 'deleted') })
      },
    }),
    sdk.defineTool({
      name: 'TodoWrite',
      label: '更新待办',
      description: '以 Claude SDK TodoWrite 兼容格式更新当前 turn 的任务列表。',
      promptSnippet: '更新当前待办列表。',
      parameters: Type.Object({
        todos: Type.Array(Type.Object({
          content: Type.Optional(Type.String()),
          subject: Type.Optional(Type.String()),
          status: Type.Union([
            Type.Literal('pending'),
            Type.Literal('in_progress'),
            Type.Literal('completed'),
            Type.Literal('blocked'),
            Type.Literal('cancelled'),
            Type.Literal('error'),
          ]),
          activeForm: Type.Optional(Type.String()),
        })),
      }),
      async execute(_toolCallId, params) {
        const input = params as { todos?: Array<Record<string, unknown>> }
        tasks.clear()
        for (const [index, todo] of (input.todos ?? []).entries()) {
          const id = String(index + 1)
          tasks.set(id, {
            id,
            subject: stringFromInput(todo, ['subject', 'content'], `待办 #${id}`),
            status: normalizeTaskStatus(todo.status, 'pending'),
            activeForm: typeof todo.activeForm === 'string' ? todo.activeForm : undefined,
          })
        }
        return createJsonToolResult({ todos: [...tasks.values()] })
      },
    }),
  ] as unknown as ToolDefinition[]

  return definitions.map((tool) =>
    wrapToolWithPermission(tool as unknown as ToolDefinition<TSchema, unknown, unknown>, { canUseTool }) as ToolDefinition)
}

const FORCE_KILL_WSL_GRACE_MS = 800

const WSL_EXPORT_ENV_KEYS = [
  'PROFER_CLI',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
  'PROFER_WINDOWS_SHELL',
  'PROFER_WSL_DISTRO',
] as const

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, String.raw`'\''`)}'`
}

export function windowsPathToWslPath(value: string): string {
  const driveMatch = value.match(/^([A-Za-z]):[\\/](.*)$/)
  if (!driveMatch) return value
  const drive = driveMatch[1]!.toLowerCase()
  const rest = driveMatch[2]!.replace(/\\/g, '/')
  return `/mnt/${drive}/${rest}`
}

function buildWslCommand(command: string, env: NodeJS.ProcessEnv | undefined): string {
  const exportLines: string[] = []
  for (const key of WSL_EXPORT_ENV_KEYS) {
    const rawValue = env?.[key]
    if (!rawValue) continue
    const value = key === 'PROFER_CLI' ? windowsPathToWslPath(rawValue) : rawValue
    exportLines.push(`export ${key}=${shellQuote(value)}`)
  }

  return exportLines.length > 0
    ? `${exportLines.join('\n')}\n${command}`
    : command
}

export function buildWslBashArgs(
  runtimeEnv: Pick<AgentRuntimeEnv, 'wslDistro'>,
  cwd: string,
  command: string,
  env: NodeJS.ProcessEnv | undefined,
): string[] {
  return [
    ...(runtimeEnv.wslDistro ? ['--distribution', runtimeEnv.wslDistro] : []),
    '--cd',
    windowsPathToWslPath(cwd),
    '--exec',
    'bash',
    '-lc',
    buildWslCommand(command, env),
  ]
}

function createWslBashOperations(runtimeEnv: AgentRuntimeEnv, sessionId: string): BashOperations {
  return {
    exec(command, cwd, options) {
      return new Promise((resolve, reject) => {
        const mergedEnv = mergeRuntimeEnv(process.env, options.env)
        const args = [
          ...(runtimeEnv.wslDistro ? ['--distribution', runtimeEnv.wslDistro] : []),
          '--cd',
          cwd,
          '--exec',
          'bash',
          '-lc',
          buildWslCommand(command, mergedEnv),
        ]
        const child = spawn(runtimeEnv.wslCommand ?? 'wsl.exe', args, {
          env: mergedEnv,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        })
        // This PID is the Profer-controlled Windows wsl.exe launcher. The
        // eventual Linux listener remains pending until a WSL-aware observer
        // exists, so it is never offered as an unsafe kill target.
        if (child.pid) registerPiRuntimeProcessShell(sessionId, command, cwd, child.pid)
        let settled = false
        let timedOut = false
        let timeoutHandle: NodeJS.Timeout | undefined
        let forceKillTimer: NodeJS.Timeout | undefined

        const cleanup = (): void => {
          if (timeoutHandle) clearTimeout(timeoutHandle)
          options.signal?.removeEventListener('abort', onAbort)
        }
        const settle = (fn: () => void): void => {
          if (settled) return
          settled = true
          cleanup()
          fn()
        }
        const clearForceKill = (): void => {
          if (forceKillTimer) {
            clearTimeout(forceKillTimer)
            forceKillTimer = undefined
          }
        }
        /**
         * 优先软终止，再兜底强杀：WSL 下 `wsl.exe --exec bash -lc` 的 SIGTERM
         * （TerminateProcess）只终止 wsl.exe 宿主，WSL 会话内前台命令可能残留。
         * 与 Claude 适配器一致，Windows 用 taskkill /F /T 级联杀 wsl.exe 进程树，
         * 其它平台用 SIGKILL。仅在 abort / timeout 需要强制终止时触发。
         */
        const forceKillChild = (): void => {
          forceKillTimer = undefined
          if (child.pid === undefined) return
          try {
            process.kill(child.pid, 0)
          } catch {
            // 已退出，无需强杀
            return
          }
          try {
            if (process.platform === 'win32') {
              execFile('taskkill', ['/F', '/T', '/PID', String(child.pid)], () => {})
            } else {
              process.kill(child.pid, 'SIGKILL')
            }
            console.warn(`[Pi 适配器] force-killed residual WSL bash pid=${child.pid}`)
          } catch (error) {
            console.warn(`[Pi 适配器] force-kill pid=${child.pid} 失败:`, error)
          }
        }
        const killChild = (): void => {
          if (child.killed && forceKillTimer) return
          if (!child.killed) child.kill('SIGTERM')
          // SIGTERM（对 wsl.exe 实为 TerminateProcess）可能不立即终止会话内命令，
          // 若子进程在窗口期内未自行退出，用 taskkill /T / SIGKILL 兜底强杀进程树。
          clearForceKill()
          forceKillTimer = setTimeout(forceKillChild, FORCE_KILL_WSL_GRACE_MS)
          forceKillTimer.unref?.()
        }
        const onAbort = (): void => {
          killChild()
        }

        if (options.signal?.aborted) {
          killChild()
          settle(() => reject(new Error('aborted')))
          return
        }

        child.stdout?.on('data', options.onData)
        child.stderr?.on('data', options.onData)
        child.on('error', (error) => {
          settle(() => reject(error))
        })
        child.on('close', (code) => {
          // 进程已真正退出，无需再强杀；清除尚未触发的兜底 timer（避免无谓的 taskkill）。
          clearForceKill()
          if (options.signal?.aborted) {
            settle(() => reject(new Error('aborted')))
          } else if (timedOut) {
            settle(() => reject(new Error(`timeout:${options.timeout}`)))
          } else {
            settle(() => resolve({ exitCode: code }))
          }
        })

        if (options.timeout !== undefined && options.timeout > 0) {
          timeoutHandle = setTimeout(() => {
            timedOut = true
            killChild()
          }, options.timeout * 1000)
        }
        options.signal?.addEventListener('abort', onAbort, { once: true })
      })
    },
  }
}

function createControlledLocalBashOperations(
  sessionId: string,
  shellPath: string | undefined,
): BashOperations {
  return {
    exec(command, cwd, options) {
      return new Promise((resolve, reject) => {
        if (options.signal?.aborted) {
          reject(new Error('aborted'))
          return
        }
        // Pi's public API lets Profer replace BashOperations. Profer explicitly
        // selects the platform shell so GUI-launched sessions do not depend on
        // an accidental PATH entry (macOS normally uses the user's zsh).
        const child = spawn(shellPath ?? (process.platform === 'win32' ? 'bash' : '/bin/sh'), ['-c', command], {
          cwd,
          env: options.env ?? process.env,
          detached: process.platform !== 'win32',
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        })
        if (child.pid) registerPiRuntimeProcessShell(sessionId, command, cwd, child.pid)
        let timedOut = false
        let settled = false
        let timeoutHandle: NodeJS.Timeout | undefined
        const killTree = (): void => {
          if (!child.pid) return
          try {
            if (process.platform === 'win32') execFile('taskkill', ['/F', '/T', '/PID', String(child.pid)], () => {})
            else process.kill(-child.pid, 'SIGKILL')
          } catch {
            try { child.kill('SIGKILL') } catch { /* already exited */ }
          }
        }
        const finish = (fn: () => void): void => {
          if (settled) return
          settled = true
          if (timeoutHandle) clearTimeout(timeoutHandle)
          options.signal?.removeEventListener('abort', onAbort)
          fn()
        }
        const onAbort = (): void => killTree()
        child.stdout?.on('data', options.onData)
        child.stderr?.on('data', options.onData)
        child.once('error', (error) => finish(() => reject(error)))
        child.once('close', (code) => finish(() => {
          if (options.signal?.aborted) reject(new Error('aborted'))
          else if (timedOut) reject(new Error(`timeout:${options.timeout}`))
          else resolve({ exitCode: code })
        }))
        if (options.timeout !== undefined && options.timeout > 0) {
          timeoutHandle = setTimeout(() => { timedOut = true; killTree() }, options.timeout * 1_000)
        }
        options.signal?.addEventListener('abort', onAbort, { once: true })
      })
    },
  }
}

function createPromaBashToolOptions(
  sessionId: string,
  runtimeEnv: AgentRuntimeEnv | undefined,
): BashToolOptions | undefined {
  const spawnHook: NonNullable<BashToolOptions['spawnHook']> = ({ command, cwd, env }) => {
    // Pi exposes this public pre-spawn hook. Record ownership here, while the
    // command/cwd still describe the actual Agent launch rather than a later
    // renderer-side directory guess. PID is confirmed by the registry monitor.
    registerPendingPiRuntimeProcess(sessionId, command, cwd)
    return {
      command,
      cwd,
      env: runtimeEnv ? mergeRuntimeEnv(env, runtimeEnv.env) : env,
    }
  }

  if (runtimeEnv?.shellKind === 'wsl') {
    return {
      operations: createWslBashOperations(runtimeEnv, sessionId),
      spawnHook,
    }
  }

  return {
    operations: createControlledLocalBashOperations(sessionId, runtimeEnv?.shellPath),
    spawnHook,
  }
}

function buildBuiltinToolDefinitions(
  sdk: PiSdk,
  sessionId: string,
  cwd: string,
  canUseTool: PiAgentQueryOptions['canUseTool'],
  runtimeEnv: AgentRuntimeEnv | undefined,
): ToolDefinition[] {
  const powerShellTool = createWindowsPowerShellToolDefinition(sdk, cwd, runtimeEnv, {}, sessionId)
  const definitions = [
    sdk.createReadToolDefinition(cwd),
    sdk.createBashToolDefinition(cwd, createPromaBashToolOptions(sessionId, runtimeEnv)),
    ...(powerShellTool ? [powerShellTool] : []),
    sdk.createEditToolDefinition(cwd),
    sdk.createWriteToolDefinition(cwd),
    sdk.createGrepToolDefinition(cwd),
    sdk.createFindToolDefinition(cwd),
    sdk.createLsToolDefinition(cwd),
  ] as unknown as ToolDefinition[]

  return definitions.map((tool) =>
    wrapToolWithPermission(tool as unknown as ToolDefinition<TSchema, unknown, unknown>, { canUseTool }) as ToolDefinition)
}

function wrapCustomToolDefinitions(
  tools: ToolDefinition[] | undefined,
  canUseTool: PiAgentQueryOptions['canUseTool'],
): ToolDefinition[] {
  return (tools ?? []).map((tool) =>
    wrapToolWithPermission(tool as unknown as ToolDefinition<TSchema, unknown, unknown>, { canUseTool }) as ToolDefinition)
}

export function installRuntimeGuardHooks(session: AgentSession, guard: AgentRuntimeGuard): void {
  const previousAfterToolCall = session.agent.afterToolCall
  session.agent.afterToolCall = async (context, signal) => {
    const previousResult = await previousAfterToolCall?.(context, signal)
    const resultAfterPreviousHooks = {
      content: previousResult?.content ?? context.result.content,
      details: previousResult?.details ?? context.result.details,
      terminate: previousResult?.terminate ?? context.result.terminate,
    }
    const guardedResult = guard.applyToolResult(resultAfterPreviousHooks)

    if (!previousResult && guardedResult.terminate === context.result.terminate) {
      return undefined
    }

    return {
      ...previousResult,
      terminate: guardedResult.terminate,
    }
  }

  const previousPrepareNextTurnWithContext = session.agent.prepareNextTurnWithContext
  session.agent.prepareNextTurnWithContext = async (context, signal) => {
    const previousSnapshot = await previousPrepareNextTurnWithContext?.(context, signal)
    if (guard.shouldStopBeforeNextTurn()) {
      // Pi 的 steer/follow-up 队列在 turn 完成后才 drain；达到 Proma 上限时必须在这里清空，
      // 否则纯文本 turn 之后追加的队列消息会绕过 afterToolCall 继续进入下一轮。
      session.agent.clearAllQueues()
    }
    return previousSnapshot
  }
}

export class PiAgentAdapter implements AgentProviderAdapter {
  // Pi 的后台服务进程由 runtime registry 管理，但尚未提供 Claude SDK TaskOutput/TaskStop 等价物。
  getCapabilities() {
    return {
      supportsTaskOutput: false,
      supportsTaskStop: false,
      supportsRewind: true,
      supportsInterrupt: true,
      supportsQueuedMessage: true,
      supportsBackgroundWakeup: false,
      supportsNativeMcp: false,
      supportsSubAgents: true,
    }
  }
  private activeSessions = new Map<string, ActivePiSession>()

  /** Keep the orchestrator's existing structured error and retry pipeline runtime-neutral. */
  errorHelpers = {
    friendlyErrorMessage,
    isPromptTooLongError,
    isThinkingSignatureError,
    mapSDKErrorToTypedError,
    extractErrorDetails,
    shouldKeepChannelOpen: () => false,
  }

  async *query(input: PiAgentQueryOptions): AsyncIterable<SDKMessage> {
    const active = createActivePiSession()
    this.activeSessions.set(input.sessionId, active)
    const queue = createAsyncQueue<SDKMessage>()
    const runtimeGuard = createAgentRuntimeGuard(input)
    active.runtimeGuard = runtimeGuard
    let unsubscribe: (() => void) | undefined
    let requestProxyDispatcher: Dispatcher | undefined
    let partialAssistantCoalescer: PartialMessageCoalescer<{ message: AssistantMessage; uuid: string }> | undefined

    const cleanupActiveSession = (): void => {
      try {
        unsubscribe?.()
        unsubscribe = undefined
        partialAssistantCoalescer?.dispose()
        partialAssistantCoalescer = undefined
        if (!active.disposed) {
          active.disposed = true
          rejectPendingInterruptPrompts(active, createAbortError())
          active.session?.dispose()
        }
        if (this.activeSessions.get(input.sessionId) === active) {
          this.activeSessions.delete(input.sessionId)
        }
      } finally {
        void closePiRequestProxyDispatcher(requestProxyDispatcher)
        requestProxyDispatcher = undefined
      }
    }

    try {
      const sdk = await import('@earendil-works/pi-coding-agent')
      const piAi = input.codexFastMode && input.provider === 'openai-codex'
        ? await import('@earendil-works/pi-ai/compat')
        : undefined
      installPiRequestProxyFetch()
      const connectionSettings = buildPiRemoteConnectionSettings(input)
      requestProxyDispatcher = createPiRequestProxyDispatcher({
        proxyUrl: connectionSettings.httpProxy,
        noProxy: getCaseInsensitiveRuntimeEnvValue(input.runtimeEnv?.env, 'NO_PROXY'),
        httpIdleTimeoutMs: connectionSettings.httpIdleTimeoutMs,
      })
      if (active.abortRequested) throw createAbortError()

      if (!existsSync(input.piSessionDir)) mkdirSync(input.piSessionDir, { recursive: true })
      const cwd = input.cwd ?? process.cwd()
      const sessionFile = input.resumeSessionId ? findSessionFile(input.piSessionDir, input.resumeSessionId) : undefined
      if (input.resumeSessionId && !sessionFile) {
        throw new Error(`No conversation found with session ID ${input.resumeSessionId}`)
      }
      const sessionManager = sessionFile
        ? sdk.SessionManager.open(sessionFile, input.piSessionDir, cwd)
        : sdk.SessionManager.create(cwd, input.piSessionDir)
      const { modelRuntime, model } = await buildModel(sdk, input)
      const autoCompactionReserveTokens = calculatePiAutoCompactionReserveTokens(
        model.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      )
      let compactContextRequested = false
      let automaticCompactionContinuations = 0
      const customTools = [
        buildCurrentSessionCompactionTool(
          sdk,
          () => { compactContextRequested = true },
          input.canUseTool,
        ),
        ...buildBuiltinToolDefinitions(
          sdk,
          input.sessionId,
          cwd,
          input.canUseTool,
          input.runtimeEnv,
        ),
        ...buildPromaProductToolDefinitions(sdk, input.canUseTool),
        ...wrapCustomToolDefinitions(input.customTools, input.canUseTool),
      ]

      const settingsManager = sdk.SettingsManager.inMemory({
        // 使用 Pi SDK 原生压缩策略：
        // - 手动压缩由 session.compact() 触发；
        // - 自动压缩在上下文达到模型窗口的约 80% 时触发；Pi 以 reserveTokens 表示预留空间。
        compaction: { enabled: true, reserveTokens: autoCompactionReserveTokens },
        // Continue the same transcript after transient failures so completed tools are not replayed.
        // Ollama 由 buildPiRetrySettings 单独关闭 native retry，避免兼容层重复提交工具上下文。
        retry: buildPiRetrySettings(input.provider),
        ...connectionSettings,
      })
      const openAIReasoningProfile = (input.provider === 'openai-codex' || input.provider === 'xai' || input.provider === 'openai-responses')
        ? resolveReasoningProfile({
            modelId: input.model,
            transport: inferReasoningTransport(input.provider),
          })
        : undefined
      const deepSeekReasoningProfile = input.provider === 'deepseek'
        ? resolveReasoningProfile({
            modelId: input.model,
            transport: 'anthropic-messages',
          })
        : undefined
      const projectInstructionScope = input.projectInstructionScope
        ? new ProjectInstructionScopeController({
            projectRoot: input.projectInstructionScope.projectRoot,
            cwd,
            initialSources: input.projectInstructionScope.initialSources,
          })
        : undefined
      const extensionFactories = [
        ...(input.provider === 'openai-codex'
          ? [createCodexRequestSettingsExtension({
              thinkingLevel: input.thinkingLevel ?? 'off',
              fastMode: input.codexFastMode,
            })]
          : []),
        ...(projectInstructionScope ? [projectInstructionScope.createExtension()] : []),
        ...(openAIReasoningProfile
          ? [createOpenAIReasoningRequestExtension({
              profile: openAIReasoningProfile,
              thinkingLevel: input.openAIThinkingLevel ?? input.thinkingLevel,
            })]
          : []),
        ...(deepSeekReasoningProfile?.encodings['anthropic-messages']?.kind === 'deepseek-output-effort'
          ? [createDeepSeekReasoningRequestExtension({
              profile: deepSeekReasoningProfile,
              thinkingLevel: input.thinkingLevel,
            })]
          : []),
      ]
      const resourceLoader = new sdk.DefaultResourceLoader({
        cwd,
        agentDir: input.piAgentDir,
        settingsManager,
        additionalSkillPaths: input.additionalSkillPaths ?? [],
        skillsOverride: createPromaSkillsOverride(input.additionalSkillPaths, input.skillSlugs),
        ...createProferManagedResourceLoaderOptions(),
        agentsFilesOverride: input.projectInstructionFiles && input.projectInstructionFiles.length > 0
          ? createProferProjectInstructionFilesOverride(input.projectInstructionFiles)
          : createProferAgentsFilesOverride(),
        ...(extensionFactories.length > 0 && { extensionFactories }),
        systemPromptOverride: () => input.systemPrompt,
      })
      await resourceLoader.reload()
      active.resourceLoader = resourceLoader

      const skillDiagnostics = resourceLoader.getSkills().diagnostics
      for (const diagnostic of skillDiagnostics) {
        const level = diagnostic.type === 'error' ? 'error' : 'warn'
        console[level](`[Pi SDK] Skill 加载诊断: ${diagnostic.path ?? '(unknown)'} ${diagnostic.message}`)
      }

      const { session } = await sdk.createAgentSession({
        cwd,
        agentDir: input.piAgentDir,
        modelRuntime,
        settingsManager,
        resourceLoader,
        sessionManager,
        model,
        thinkingLevel: input.thinkingLevel ?? 'off',
        noTools: 'builtin',
        customTools,
      })
      session.agent.toolExecution = 'sequential'
      if (projectInstructionScope) {
        const previousPrepareNextTurnWithContext = session.agent.prepareNextTurnWithContext
        session.agent.prepareNextTurnWithContext = async (context, signal) => {
          const previousSnapshot = await previousPrepareNextTurnWithContext?.(context, signal)
          const nextContext = previousSnapshot?.context ?? context.context
          const systemPrompt = projectInstructionScope.appendPendingInstructions(nextContext.systemPrompt)
          if (systemPrompt === nextContext.systemPrompt) return previousSnapshot
          return {
            ...previousSnapshot,
            context: { ...nextContext, systemPrompt },
          }
        }
      }
      if (piAi && input.codexFastMode && input.provider === 'openai-codex' && isCodexFastModeSupportedModel(input.model)) {
        // Pi 的通用 streamSimple 会丢弃 provider 专属 serviceTier；这里直接走
        // provider stream，确保 request body 与 usage.cost 都使用 priority tier。
        session.agent.streamFunction = async (requestModel, context, options) => {
          const authResult = await modelRuntime.getAuth(requestModel)
          if (!authResult?.auth.apiKey) throw new Error('无法获取 ChatGPT (Codex) OAuth access token')
          const auth = authResult.auth

          const env = authResult.env || options?.env ? { ...(authResult.env ?? {}), ...(options?.env ?? {}) } : undefined
          const retrySettings = settingsManager.getProviderRetrySettings()
          const configuredTimeoutMs = settingsManager.getHttpIdleTimeoutMs()
          const timeoutMs = options?.timeoutMs ?? retrySettings.timeoutMs ?? (configuredTimeoutMs === 0 ? 2_147_483_647 : configuredTimeoutMs)
          const websocketConnectTimeoutMs = options?.websocketConnectTimeoutMs ?? settingsManager.getWebSocketConnectTimeoutMs()

          return piAi.stream(requestModel, context, withCodexFastModeServiceTier({
            ...options,
            apiKey: auth.apiKey,
            env,
            timeoutMs,
            websocketConnectTimeoutMs,
            maxRetries: options?.maxRetries ?? retrySettings.maxRetries,
            maxRetryDelayMs: options?.maxRetryDelayMs ?? retrySettings.maxRetryDelayMs,
            headers: { ...auth.headers, ...options?.headers },
          }))
        }
      }
      installRuntimeGuardHooks(session, runtimeGuard)
      installCurrentSessionCompactionHooks(session)
      active.session = session
      resolveActiveReady(active, session)

      // 代理作用域必须只覆盖模型 provider stream：在整个 session.prompt() 链上设
      // AsyncLocalStorage 会把 MCP/产品工具等同一 Agent loop 中的 fetch 也错误地送进 Codex 代理。
      const providerStreamFn = session.agent.streamFunction
      session.agent.streamFunction = (requestModel, context, options) => runWithPiRequestProxy(
        requestProxyDispatcher,
        () => providerStreamFn(requestModel, context, options),
      )

      if (active.abortRequested) {
        await session.abort().catch(() => {})
        throw createAbortError()
      }

      input.onSessionId?.(session.sessionId, session.sessionFile)
      input.onModelResolved?.(session.model?.id ?? input.model ?? 'default')
      input.onContextWindow?.(model.contextWindow ?? DEFAULT_CONTEXT_WINDOW)

      queue.push({
        type: 'system',
        subtype: 'init',
        session_id: session.sessionId,
        model: session.model?.id ?? input.model,
      } as unknown as SDKMessage)

      let activeAssistant: AssistantMessageState = {}
      let lastPartialAssistant: AssistantMessage | undefined
      // Pi emits the failed assistant before agent_end indicates whether it will retry.
      const retryTerminalGate = createPiRetryTerminalGate<{
        assistantMessage: AssistantMessage
        sdkMessage: SDKMessage
      }>()
      // Pi 在 agent_end 之后可能才触发 overflow 自动压缩：在这些情况下延迟上报终态，
      // 等 compaction 生命周期到终态（compaction_end / agent_settled）再 settle。
      let pendingNativeOverflowRecovery = false
      let pendingTerminalResult: SDKMessage | undefined

      // message_end 发生在 Pi 落盘前；保留对象身份，待 prompt 完成后从
      // SessionManager entries 精确取得 Pi entry ID，绝不按文本猜测。
      const finalAssistantUuids = new Map<AssistantMessage, string>()

      const persistPiEntryBindings = (): void => {
        const bindings: Record<string, string> = {}
        for (const entry of sessionManager.getEntries()) {
          if (entry.type !== 'message' || entry.message.role !== 'assistant') continue
          const uuid = finalAssistantUuids.get(entry.message as AssistantMessage)
          if (uuid) bindings[uuid] = entry.id
        }
        if (Object.keys(bindings).length > 0) input.onPiEntryBindings?.(bindings)
      }

      const assistantUuidFor = (): string => {
        if (!activeAssistant.uuid) {
          activeAssistant = { uuid: randomUUID() }
        }
        const uuid = activeAssistant.uuid
        if (!uuid) throw new Error('Pi assistant message uuid 初始化失败')
        return uuid
      }

      partialAssistantCoalescer = createPartialMessageCoalescer(({ message, uuid }) => {
        const converted = convertPiMessage(message, session.sessionId, input.model, {
          final: false,
          uuid,
        })
        if (converted?.type === 'assistant') queue.push(converted)
      }, PI_PARTIAL_UPDATE_INTERVAL_MS)

      unsubscribe = session.subscribe((event: AgentSessionEvent) => {
        try {
          for (const lifecycleEvent of mapPiHarnessLifecycleEvent(event)) {
            try {
              input.onHarnessLifecycle?.(lifecycleEvent)
            } catch (error) {
              // Harness is observability/control-plane sidecar only. It must never
              // break the Pi event stream or abort the current user Turn.
              console.warn('[Pi adapter] Harness lifecycle observer 失败，忽略:', error)
            }
          }
          switch (event.type) {
            case 'message_update': {
              if (!isAssistantPiMessage(event.message)) break
              lastPartialAssistant = event.message
              // Pi 的 partial 是累计全文。合并为最多 20fps 的最新帧，避免每 token 都在
              // main → IPC → renderer 路径重复复制整段消息；message_end 始终立即透传。
              partialAssistantCoalescer?.schedule({ message: event.message, uuid: assistantUuidFor() })
              break
            }
            case 'message_end': {
              partialAssistantCoalescer?.flush()
              if (active.interrupting && isAbortedAssistantMessage(event.message)) {
                if (lastPartialAssistant) {
                  const converted = convertPiMessage(lastPartialAssistant, session.sessionId, input.model, {
                    final: true,
                    uuid: assistantUuidFor(),
                  })
                  if (converted?.type === 'assistant') queue.push(converted)
                }
                lastPartialAssistant = undefined
                activeAssistant = {}
                break
              }
              const isAssistant = isAssistantPiMessage(event.message)
              const assistantUuid = isAssistant ? assistantUuidFor() : undefined
              const converted = convertPiMessage(event.message, session.sessionId, input.model, {
                final: true,
                ...(assistantUuid && { uuid: assistantUuid }),
              })
              const isRetryableAssistantError = isAssistant && (event.message as AssistantMessage).stopReason === 'error'
              if (isRetryableAssistantError && converted?.type === 'assistant' && assistantUuid) {
                // Native retry 会丢弃该失败 assistant；不应消耗 Proma 的 turn/budget 配额。
                // 关键：此处不能重置 UUID。retry 后的新 partial/final 必须原地替换此前
                // 已经展示的 partial，避免用户同时看到断流残片和恢复后的完整回答。
                retryTerminalGate.defer({
                  assistantMessage: event.message as AssistantMessage,
                  sdkMessage: converted,
                })
              } else {
                runtimeGuard.recordMessage(event.message)
                if (converted && (converted.type !== 'user' || hasToolResult(converted))) queue.push(converted)
                if (isAssistant && assistantUuid) {
                  finalAssistantUuids.set(event.message as AssistantMessage, assistantUuid)
                }
              }
              if (isAssistant) {
                activeAssistant = {}
                lastPartialAssistant = undefined
              }
              break
            }
            case 'agent_end': {
              if (active.abortRequested || (active.interrupting && active.pendingInterruptPrompts.length > 0)) {
                // 用户停止或插入新 prompt 时，当前 loop 的错误与 result 都不得泄漏到下一轮。
                retryTerminalGate.settle(true)
                pendingNativeOverflowRecovery = false
                pendingTerminalResult = undefined
                break
              }
              const deferredRetryError = retryTerminalGate.peek()
              // Pi 在 agent_end 之后才检测 overflow 并压缩。此时若先将错误交给 orchestrator，
              // 会触发外层恢复或清理，打断同 transcript 的 continue（压缩）。
              const waitsForNativeOverflowRecovery = shouldDeferPiOverflowTerminalError(
                deferredRetryError?.assistantMessage,
                model.contextWindow,
                event.willRetry,
                active.abortRequested,
              )
              const terminalRetryError = waitsForNativeOverflowRecovery
                ? undefined
                : retryTerminalGate.settle(event.willRetry)
              if (waitsForNativeOverflowRecovery) pendingNativeOverflowRecovery = true
              if (event.willRetry) {
                // native retry 会在同一 session 中调用 continue()，不要向上游发送终态。
                break
              }
              if (terminalRetryError) {
                runtimeGuard.recordMessage(terminalRetryError.assistantMessage)
                queue.push(terminalRetryError.sdkMessage)
              }
              // Pi can start auto-compaction after agent_end but before session.prompt()
              // resolves. Defer the terminal result until then, otherwise the orchestrator's
              // result-drain timeout may dispose the session and abort compaction.
              pendingTerminalResult = convertResultMessage(
                event.messages,
                session.sessionId,
                runtimeGuard.getResultOverride(event.messages),
                model.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
                model.id,
                input.model ?? session.model?.id,
              )
              break
            }
            case 'auto_retry_start':
            case 'auto_retry_attempt_start':
            case 'auto_retry_end':
              for (const retry of mapPiNativeRetryEvent(event)) input.onRetry?.(retry)
              break
            case 'tool_execution_update':
              queue.push({
                type: 'tool_progress',
                session_id: session.sessionId,
                tool_use_id: event.toolCallId,
                tool_name: displayToolName(event.toolName, event.args as Record<string, unknown> | undefined),
                parent_tool_use_id: null,
              } as unknown as SDKMessage)
              break
            case 'compaction_start':
              // 压缩开始（手动 /compact 或自动阈值/溢出触发）：发前端已识别的 compacting system 消息，
              // 展示「正在压缩上下文...」分隔符。此前迁移遗漏了该事件，导致自动压缩与手动压缩都无 UI。
              queue.push({
                type: 'system',
                subtype: 'compacting',
                session_id: session.sessionId,
              } as unknown as SDKMessage)
              break
            case 'compaction_end': {
              // overflow 恢复：agent_end 时挂起的溢出错误，此刻依据压缩结果放行。
              if (pendingNativeOverflowRecovery && event.reason === 'overflow') {
                pendingNativeOverflowRecovery = false
                const recovered = !event.aborted && event.result !== undefined && event.willRetry
                const terminalRetryError = retryTerminalGate.settle(
                  recovered || active.abortRequested || active.interrupting,
                )
                if (terminalRetryError) {
                  runtimeGuard.recordMessage(terminalRetryError.assistantMessage)
                  queue.push(terminalRetryError.sdkMessage)
                }
              }
              // 压缩结束：成功则发 compact_boundary 分界线（前端持久化显示「上下文已压缩」），
              // 失败/中止则发状态消息收起底部压缩进度追踪。
              if (!event.aborted && event.result) {
                queue.push({
                  type: 'system',
                  subtype: 'compact_boundary',
                  session_id: session.sessionId,
                  summary: event.result.summary,
                } as unknown as SDKMessage)
              } else if (event.aborted) {
                queue.push({
                  type: 'system',
                  subtype: 'status',
                  session_id: session.sessionId,
                  compact_result: 'failed',
                  compact_error: '上下文压缩已取消。',
                } as unknown as SDKMessage)
              } else if (event.errorMessage && !isCompactionNoopError(event.errorMessage)) {
                queue.push({
                  type: 'system',
                  subtype: 'status',
                  session_id: session.sessionId,
                  compact_result: 'failed',
                  compact_error: event.errorMessage,
                } as unknown as SDKMessage)
              }
              break
            }
            case 'agent_settled':
              // 防御上游缺少 compaction_end 的异常事件序列，不能无限吞掉已 deferred 的错误。
              if (pendingNativeOverflowRecovery) {
                pendingNativeOverflowRecovery = false
                const terminalRetryError = retryTerminalGate.settle(active.abortRequested || active.interrupting)
                if (terminalRetryError) {
                  runtimeGuard.recordMessage(terminalRetryError.assistantMessage)
                  queue.push(terminalRetryError.sdkMessage)
                }
              }
              break
          }
        } catch (error) {
          queue.fail(error)
        }
      })

      if (input.compactRequest) {
        // 手动压缩：走 pi 原生 session.compact()，而非把 /compact 当普通 prompt 发给模型。
        // compaction_start/end 事件已在上面的 subscribe 中转成 compacting/compact_boundary system 消息；
        // compact() 不发 agent_end，故这里补一个合成 result 消息收束本轮（供 orchestrator 结束消费循环）。
        session.compact()
          .then(() => {
            queue.push({
              type: 'result',
              subtype: 'success',
              usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
              terminal_reason: 'completed',
              session_id: session.sessionId,
            } as unknown as SDKMessage)
            queue.close()
          })
          .catch((error) => {
            // 「会话太小无需压缩」/「已压缩」是良性情况，不是执行错误：
            // pi 会抛 "Nothing to compact (session too small)" / "Already compacted"。
            // 这里不 fail 队列（否则前端弹通用「执行错误」），改为正常收尾并给出友好提示。
            const message = error instanceof Error ? error.message : String(error)
            if (/nothing to compact|already compacted/i.test(message)) {
              queue.push({
                type: 'system',
                subtype: 'compact_noop',
                session_id: session.sessionId,
                message: /already compacted/i.test(message)
                  ? '当前上下文已经压缩过，无需重复压缩。'
                  : '当前上下文较小，暂时无需压缩。',
              } as unknown as SDKMessage)
              queue.push({
                type: 'result',
                subtype: 'success',
                usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
                terminal_reason: 'completed',
                session_id: session.sessionId,
              } as unknown as SDKMessage)
              queue.close()
            } else {
              queue.fail(error)
            }
          })
          .finally(cleanupActiveSession)
      } else {
        const runCompactionAwareChain = async (): Promise<void> => {
          let continuationPrompt: string | undefined
          do {
            await runPiPromptChain(
              continuationPrompt ?? appendOutputFormatInstruction(input.prompt, input.outputFormat),
              active,
              {
                prompt: (prompt) => session.prompt(prompt, { source: 'rpc' }),
                prepareInitialPrompt: (prompt) => preparePromptWithPromaSkills(resourceLoader, prompt, input.skillMentions),
                shouldStopBeforeNextTurn: () => runtimeGuard.shouldStopBeforeNextTurn(),
                rejectPendingInterruptPrompts: (error) => rejectPendingInterruptPrompts(active, error),
                createAbortError,
                dropTrailingAbortedAssistant: () => {
                  session.agent.state.messages = dropTrailingAbortedAssistant(session.agent.state.messages)
                },
              },
            )
            if (!compactContextRequested) break
            try {
              // 模型主动请求压缩：本 turn 落定后执行 session.compact()，再按需续跑原任务。
              await compactCurrentSessionAfterTurn(session, (message) => queue.push(message))
            } catch (error) {
              // 用户在压缩期间停止时，Pi 会取消 summarization；这是正常中止而不是运行错误。
              if (active.abortRequested) return
              throw error
            }
            compactContextRequested = false
            const continuation = planPiCompactionContinuation({
              continuationCount: automaticCompactionContinuations,
              abortRequested: active.abortRequested,
              runtimeLimitReached: runtimeGuard.shouldStopBeforeNextTurn(),
            })
            if (continuation.shouldContinue) {
              automaticCompactionContinuations += 1
              continuationPrompt = appendOutputFormatInstruction(continuation.prompt, input.outputFormat)
              // 当前终态仅表示为执行压缩而结束的内部 loop，不应让上层把原任务视为完成。
              pendingTerminalResult = undefined
            } else {
              continuationPrompt = undefined
              if (continuation.reason === 'continuation_limit') {
                pendingTerminalResult = createCompactionContinuationLimitResult(session.sessionId)
              }
            }
          } while (continuationPrompt !== undefined && !active.abortRequested)
        }

        runCompactionAwareChain()
          .then(() => {
            // 若 agent_end 已把终态 result 存入 pendingTerminalResult（等待 overflow 压缩），
            // 在 prompt 链最终落定后必须 flush 出来，否则上层会因本轮无 result 而误判。
            if (pendingTerminalResult) {
              queue.push(pendingTerminalResult)
              pendingTerminalResult = undefined
            }
            // prompt 链结束后 Pi 已落盘；此时从 SessionManager entries 精确取得 entry ID 映射，
            // 供分叉/回退定位 branch 点使用。
            persistPiEntryBindings()
            queue.close()
          })
          .catch((error) => queue.fail(error))
          .finally(cleanupActiveSession)
      }
    } catch (error) {
      rejectActiveReady(active, error)
      queue.fail(error)
    }

    try {
      while (true) {
        const next = await queue.next()
        if (next.done) break
        yield next.value
      }
    } finally {
      cleanupActiveSession()
    }
  }

  abort(sessionId: string): void {
    const active = this.activeSessions.get(sessionId)
    if (!active) return
    active.abortRequested = true
    rejectPendingInterruptPrompts(active, createAbortError())
    if (!active.session) rejectActiveReady(active, createAbortError())
    active.session?.abort().catch(err => console.error('[Pi adapter] session.abort() 失败:', err))
  }

  /**
   * 软中断当前 turn，但保留活跃 session 以便继续注入下一条用户消息。
   *
   * 与 abort() 的区别：不杀 session，允许立即续跑新消息。
   * 调用 session.abort() 让 Pi SDK 底层终止当前 prompt 流；prompt chain 会等待它实际 settle。
   */
  async interruptQuery(sessionId: string): Promise<void> {
    const active = this.activeSessions.get(sessionId)
    if (!active) return
    active.abortRequested = true
    rejectPendingInterruptPrompts(active, createAbortError())
    if (!active.session) rejectActiveReady(active, createAbortError())
    try {
      await active.session?.abort()
      console.log(`[Pi adapter] 已软中断当前 turn: sessionId=${sessionId}`)
    } catch (err) {
      console.warn(`[Pi adapter] 软中断 session.abort() 失败:`, err)
    }
  }

  async sendQueuedMessage(
    sessionId: string,
    message: SDKUserMessageInput,
    options?: SendQueuedMessageOptions,
  ): Promise<void> {
    const active = this.activeSessions.get(sessionId)
    if (!active) throw new Error('当前会话没有正在运行的 Agent')
    const session = await waitForActiveSession(active)
    // abortRequested 检查：interrupt 路径豁免（interruptQuery 已在此前设置该标志），
    // 普通队列消息在会话已中止时应拒绝。
    if (!options?.interrupt && active.abortRequested) throw createAbortError()
    if (active.runtimeGuard?.shouldStopBeforeNextTurn()) {
      session.agent.clearAllQueues()
      const stopOverride = active.runtimeGuard.getLimitResultOverride()
      throw new Error(stopOverride?.errors[0] ?? 'Agent 已达到运行限制，无法继续追加消息')
    }
    if (options?.interrupt) {
      // Must reserve before any async skill preparation or abort. Otherwise the prompt chain may finish
      // between the abort and reservation, making the first "send now" click disappear.
      const contentReady = active.resourceLoader
        ? preparePromptWithPromaSkills(active.resourceLoader, message.message.content, options?.skillMentions)
        : Promise.resolve(message.message.content)
      const accepted = new Promise<void>((resolve, reject) => {
        active.pendingInterruptPrompts.push({
          contentReady,
          resolveAccepted: resolve,
          rejectAccepted: reject,
        })
      })
      accepted.catch(() => {})
      // Always abort after reservation. isStreaming can transiently be false while the prompt chain still owns the turn.
      active.abortRequested = true
      active.interrupting = true
      active.interruptAbortPromise ??= session.abort()
        .finally(() => {
          active.interruptAbortPromise = undefined
        })
      try {
        await active.interruptAbortPromise
        await accepted
      } catch (error) {
        // If preparation/abort failed before the chain consumed this reservation, remove and reject it.
        const index = active.pendingInterruptPrompts.findIndex((prompt) => prompt.contentReady === contentReady)
        if (index >= 0) active.pendingInterruptPrompts.splice(index, 1)
        throw error
      }
      options.onAccepted?.()
      return
    }
    const content = active.resourceLoader
      ? await preparePromptWithPromaSkills(active.resourceLoader, message.message.content, options?.skillMentions)
      : message.message.content
    if (active.runtimeGuard?.shouldStopBeforeNextTurn()) {
      session.agent.clearAllQueues()
      const stopOverride = active.runtimeGuard.getLimitResultOverride()
      throw new Error(stopOverride?.errors[0] ?? 'Agent 已达到运行限制，无法继续追加消息')
    }
    if (message.priority === 'now') {
      await session.steer(content)
    } else {
      await session.followUp(content)
    }
    options?.onAccepted?.()
  }

  async cancelQueuedMessage(_sessionId: string, _messageUuid: string): Promise<void> {
    // Pi 的公开 SDK 当前只暴露 clearQueue，不支持按消息 UUID 删除。
  }

  async setPermissionMode(_sessionId: string, _mode: string): Promise<void> {
    // Proma 权限由工具包装层实时读取 sessionPermissionModes，自身无需同步给 Pi。
  }

  dispose(): void {
    for (const active of this.activeSessions.values()) {
      if (!active.disposed) {
        active.disposed = true
        rejectPendingInterruptPrompts(active, createAbortError())
        active.session?.dispose()
      }
      rejectActiveReady(active, createAbortError())
    }
    this.activeSessions.clear()
  }
}

export function cleanupPiRuntimeResources(): void {
  // Pi 是 in-process runtime，旧 Claude SDK 时代那个持久化的 native `claude` CLI 子进程已不存在，
  // 因此不再需要旧的 before-quit 孤儿扫描（它当年只按命令行匹配 'claude-agent-sdk'）。
  //
  // Pi 的 bash 工具确实会 spawn 子进程，但它以 detached 独立进程组启动，abort()/timeout 时由
  // pi 内部 killProcessTree（SIGTERM + 5s SIGKILL）级联杀整个进程组；adapter.dispose()/abort()
  // 会传播 session.abort()/dispose()。故正常路径无需额外兜底。
  //
  // 残留风险（低）：某个 exec 长命令或 stdio MCP 子进程若在 dispose/abort 未覆盖时退出，可能残留。
  // pi 未从公开入口（exports 仅 '.' 与 './rpc-entry'）导出 killTrackedDetachedChildren，
  // 无法在不深依赖其内部实现的前提下调用，故此处保持空实现；如需兜底应由 pi 侧补公开 API。
}
