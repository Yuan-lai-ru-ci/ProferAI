/**
 * 单轮执行 Harness（运行时中立判定引擎）。
 *
 * 引擎本身无 SDK 绑定，同时服务 Pi 与 Claude 两个 runtime（B1-5 对齐后）：
 * - Pi 侧由 pi-agent-adapter 经工具包装器的 onToolCall 喂入工具事实；
 * - Claude 侧由 claude-harness 追踪器把 assistant 的 tool_use 块与 user 的 tool_result 块
 *   转成同一组工具事实喂入本引擎。
 *
 * 只记录本轮已经发生的、无 SDK 绑定的工具事实，用于在自然结束前补齐最小验证闭环：
 * - 本地写入（write/edit）后，若整轮没有观察到任何有意义的 shell 验证尝试（bash/powershell），
 *   且改动文件未被**写入之后**重新读取确认，则追加一次只做验证的 follow-up 续轮；
 * - 读回验证与系统提示词口径一致（"重新读取确认写入结果"也算最小验证），
 *   源码与文档一视同仁；文档类文件另有格式核验文案；
 * - 路径按平台规范化匹配（Windows 大小写不敏感、分隔符统一；相对路径按 cwd 解析），
 *   避免同一文件的相对/绝对写法差异导致误判为未验证；
 * - 验证命令判定：探测类命令（pwd/ls 等）与依赖安装类命令（npm/bun install 等）不算验证；
 *   未引用本轮写入路径的泛化命令（如全仓 build）也不算验证；只有引用写入路径的命令
 *   或 tsc/test/lint 等验证语义命令才视为「已尝试验证」；
 * - follow-up 文案列出未验证文件清单（诊断事件落盘只记路径，不记文案）。
 * 权限和风险控制仍完全归编排层负责。
 */

import { isAbsolute, resolve } from 'node:path'
import type { SDKMessage } from '@profer/shared'

export interface PiHarnessToolCall {
  name: string
  input: Record<string, unknown>
}

/** 带结果的工具调用记录（离线回放/评估用；运行时 onToolCall 无 outcome）。 */
export interface PiHarnessToolResult extends PiHarnessToolCall {
  outcome?: 'succeeded' | 'failed'
}

export type PiHarnessDecisionAction = 'none' | 'follow_up'

export type PiHarnessDecisionReason =
  | 'read_only'
  | 'source_changes_unverified'
  | 'documents_unverified'
  | 'validated'
  | 'blocked_or_failed'

export interface PiHarnessDecision {
  action: PiHarnessDecisionAction
  reason: PiHarnessDecisionReason
  /** follow-up 文案（诊断事件落盘时应脱敏，不写入）。 */
  prompt?: string
  /** 本轮成功写入且尚未闭环验证的本地文件路径（截断前的完整列表）。 */
  pendingPaths: string[]
  /** 是否观察到有意义的 shell 验证尝试（tsc/test 等，不区分成败）。 */
  validationAttempted: boolean
}

/**
 * harness follow-up 的 UI 系统消息（subtype: harness_follow_up）。
 * 主进程在注入 follow-up 续轮时同步推送该消息，UI 渲染为「系统验证兜底」提示，
 * 避免 Pi transcript 里自动注入的 user 消息被误认为用户自己发的消息。
 */
export function createPiHarnessFollowUpSystemMessage(
  sessionId: string,
  decision: PiHarnessDecision,
): SDKMessage {
  return {
    type: 'system',
    subtype: 'harness_follow_up',
    session_id: sessionId,
    summary: decision.prompt,
    pending_paths: decision.pendingPaths,
    _createdAt: Date.now(),
  } as unknown as SDKMessage
}

export interface PiHarness {
  recordToolCall(call: PiHarnessToolCall): void
  recordToolResult(result: PiHarnessToolResult): void
  markBlocked(): void
  markTerminalFailure(): void
  createFollowUpPrompt(): string | undefined
  createDecision(): PiHarnessDecision
}

export interface PiHarnessOptions {
  userPrompt: string
  /** 本轮 Agent 工作目录：用于把工具参数中的相对路径解析为绝对路径后再匹配读回 */
  cwd?: string
}

// ============================================================================
// 运行时中立别名（B1-5）：判定引擎现同时服务 Pi 与 Claude 两侧。
// 新接入方（如 Claude 侧追踪器）统一使用这些中立名称，避免「Pi」前缀误导。
// ============================================================================

/** 一次工具调用的事实记录（运行时中立） */
export type AgentHarnessToolCall = PiHarnessToolCall
/** 带结果的工具调用记录（运行时中立） */
export type AgentHarnessToolResult = PiHarnessToolResult
/** 本轮决策（运行时中立） */
export type AgentHarnessDecision = PiHarnessDecision
/** 决策动作（运行时中立） */
export type AgentHarnessDecisionAction = PiHarnessDecisionAction
/** 决策原因（运行时中立） */
export type AgentHarnessDecisionReason = PiHarnessDecisionReason
/** harness 实例接口（运行时中立） */
export type AgentHarness = PiHarness
/** harness 创建参数（运行时中立） */
export type AgentHarnessOptions = PiHarnessOptions
/** 创建 harness 实例（运行时中立别名，与 createPiHarness 同一实现） */
export const createAgentHarness = createPiHarness

const LOCAL_WRITE_TOOLS = new Set(['write', 'edit'])
const VALIDATION_TOOLS = new Set(['bash', 'powershell'])
const READ_TOOLS = new Set(['read'])
const DOCUMENT_PATH_PATTERN = /\.(?:md|mdx|txt|rst)$/i

/** 路径字段枚举：Pi/Claude 工具参数历史上出现过这些写法；上游改名时按枚举兜底并留哨兵日志。 */
const PATH_FIELDS = ['path', 'file_path', 'filePath', 'filepath'] as const

/** 明显无验证意义的 shell 命令前缀（pwd/ls/echo 等探测类，不算验证尝试）。 */
const NON_VALIDATION_COMMAND_PREFIX =
  /^\s*(?:pwd|ls|echo|cd|whoami|date|clear|history|alias|export|set|env|dir|type|where)\b/i

/** 依赖安装/更新类命令前缀：安装依赖不验证本轮写入，误判为「已验证」会漏掉兜底。 */
const INSTALL_COMMAND_PREFIX =
  /^\s*(?:npm|pnpm|yarn|bun)\s+(?:i|install|ci|add|update|up|upgrade|remove|rm|uninstall)\b/i

/** 有明确验证语义的命令关键词（tsc/test/lint 等；全仓 build/start/dev 等泛化命令不在此列）。 */
const VALIDATION_KEYWORD_PATTERN =
  /\b(?:tsc|typecheck|type-check|lint|eslint|biome|vitest|jest|pytest|test)\b/i

/** follow-up 文案最多列出的文件数，超出折叠为「共 N 个文件」 */
const MAX_FOLLOW_UP_PATHS = 5
/** 原任务摘录长度上限（只作定位参考，不重复任务要求） */
const MAX_TASK_EXCERPT_LENGTH = 60

/** 本次写入的跟踪记录（path 保留原始写法供文案/诊断展示） */
interface TrackedWrite {
  path: string
  document: boolean
  /** 写入事件序号：读回验证必须发生在其之后 */
  writtenAt: number
}

export function createPiHarness(options: PiHarnessOptions): PiHarness {
  const wrotePaths: TrackedWrite[] = []
  /** 归一化路径 → 最近一次 read 事件序号（用于「读回必须发生在写入之后」判定） */
  const readBackAt = new Map<string, number>()
  let eventIndex = 0
  let observedValidationAttempt = false
  let followUpIssued = false
  let blockedOrFailed = false

  /** 路径归一化：相对路径按 cwd 解析、分隔符统一、Windows 大小写不敏感 */
  const normalizePath = (path: string): string => {
    let normalized = path
    if (options.cwd && !isAbsolute(normalized)) {
      normalized = resolve(options.cwd, normalized)
    }
    normalized = normalized.replace(/\\/g, '/')
    if (process.platform === 'win32') normalized = normalized.toLowerCase()
    return normalized
  }

  function handleToolCall(call: PiHarnessToolResult): void {
    const { name, input, outcome } = call
    const normalizedName = name.trim().toLowerCase()
    eventIndex += 1

    if (LOCAL_WRITE_TOOLS.has(normalizedName)) {
      // 失败的写入不算变更（recordToolCall 无 outcome，视为成功）
      if (outcome === 'failed') return
      const path = readTrackedPath(input, name)
      if (path !== undefined) {
        wrotePaths.push({ path, document: isDocumentPath(input), writtenAt: eventIndex })
      }
      return
    }

    if (READ_TOOLS.has(normalizedName)) {
      const path = readTrackedPath(input, name)
      if (path !== undefined) {
        readBackAt.set(normalizePath(path), eventIndex)
      }
      return
    }

    if (VALIDATION_TOOLS.has(normalizedName) && wrotePaths.length > 0 && isMeaningfulValidationCommand(input, wrotePaths)) {
      // 命令成败均视为"已尝试验证"（失败同样证明观察过结果）
      observedValidationAttempt = true
    }
  }

  /** 写入后未被读回确认的文件（读回事件序号必须大于写入事件序号） */
  const unverifiedWrites = (): TrackedWrite[] =>
    wrotePaths.filter((entry) => (readBackAt.get(normalizePath(entry.path)) ?? -1) <= entry.writtenAt)

  function resolveDecision(): PiHarnessDecision {
    if (blockedOrFailed) {
      return { action: 'none', reason: 'blocked_or_failed', pendingPaths: [], validationAttempted: false }
    }

    if (wrotePaths.length === 0) {
      return { action: 'none', reason: 'read_only', pendingPaths: [], validationAttempted: false }
    }

    if (observedValidationAttempt) {
      // 有意义的 shell 验证尝试覆盖整轮全部写入
      return { action: 'none', reason: 'validated', pendingPaths: [], validationAttempted: true }
    }

    const pending = unverifiedWrites()
    if (pending.length === 0) {
      // 全部写入都被写入之后的读回确认
      return { action: 'none', reason: 'validated', pendingPaths: [], validationAttempted: false }
    }

    const pendingPaths = pending.map((entry) => entry.path)
    const allDocuments = pending.every((entry) => entry.document)
    return {
      action: 'follow_up',
      reason: allDocuments ? 'documents_unverified' : 'source_changes_unverified',
      prompt: allDocuments
        ? buildDocumentFollowUpPrompt(pendingPaths)
        : buildSourceFollowUpPrompt(pendingPaths, options.userPrompt),
      pendingPaths,
      validationAttempted: false,
    }
  }

  return {
    recordToolCall(call) {
      handleToolCall(call)
    },

    recordToolResult(result) {
      handleToolCall(result)
    },

    markBlocked() {
      blockedOrFailed = true
    },

    markTerminalFailure() {
      blockedOrFailed = true
    },

    createFollowUpPrompt() {
      if (followUpIssued || blockedOrFailed) return undefined
      // 与离线评估同一套决策逻辑：validated/read_only/blocked 不发 follow-up。
      const decision = resolveDecision()
      if (decision.action === 'none') return undefined
      followUpIssued = true
      return decision.prompt
    },

    createDecision() {
      return resolveDecision()
    },
  }
}

/** 未验证文件清单（超出上限折叠），follow-up 文案专用 */
function formatPendingPaths(paths: string[]): string {
  const shown = paths.slice(0, MAX_FOLLOW_UP_PATHS)
  const lines = shown.map((path) => `- \`${path}\``)
  if (paths.length > shown.length) {
    lines.push(`- …（共 ${paths.length} 个文件，此处仅列出前 ${MAX_FOLLOW_UP_PATHS} 个）`)
  }
  return lines.join('\n')
}

function buildDocumentFollowUpPrompt(paths: string[]): string {
  return `你刚刚修改了文档，但尚未验证结果。未验证的文件：\n${formatPendingPaths(paths)}\n请只执行一次最小闭环：重新读取这些文件已改动的片段并检查内容/格式是否符合目标。不要重复原任务或扩大改动；如果无法验证，最终答复必须如实说明原因。`
}

function buildSourceFollowUpPrompt(paths: string[], userPrompt: string): string {
  const compact = userPrompt.replace(/\s+/g, ' ').trim()
  const excerpt = compact.slice(0, MAX_TASK_EXCERPT_LENGTH)
  const taskLine = excerpt ? `原任务：${excerpt}${compact.length > MAX_TASK_EXCERPT_LENGTH ? '…' : ''}\n` : ''
  return `${taskLine}你刚刚修改了本地文件，但尚未进行验证。未验证的文件：\n${formatPendingPaths(paths)}\n请只执行一次与本次改动相称的最小验证：重新读取这些文件已改动的片段确认写入结果，或运行最相关的检查或测试。不要重复原任务或扩大改动；如果验证失败或无法执行，最终答复必须如实说明结果和原因。`
}

function readPath(input: Record<string, unknown>): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  for (const field of PATH_FIELDS) {
    const value = input[field]
    if (typeof value === 'string' && value.trim()) return value
  }
  return undefined
}

/** 跟踪路径读取：字段枚举全部缺失时留哨兵日志（上游 SDK 改名/形状变化会静默失效）。 */
function readTrackedPath(input: Record<string, unknown>, toolName: string): string | undefined {
  const path = readPath(input)
  if (path === undefined) {
    console.warn(`[Pi Harness] ${toolName} 工具调用缺少已知路径字段（${PATH_FIELDS.join('/')}），本轮路径跟踪失效`, input)
  }
  return path
}

function isDocumentPath(input: Record<string, unknown>): boolean {
  const path = readPath(input)
  return typeof path === 'string' && DOCUMENT_PATH_PATTERN.test(path)
}

function isMeaningfulValidationCommand(input: Record<string, unknown>, wrotePaths: TrackedWrite[]): boolean {
  const command = input.command ?? input.script ?? input.program
  if (typeof command !== 'string') return false
  const trimmed = command.trim()
  if (!trimmed) return false
  // 探测类与依赖安装类命令永远不算验证尝试。
  if (NON_VALIDATION_COMMAND_PREFIX.test(trimmed)) return false
  if (INSTALL_COMMAND_PREFIX.test(trimmed)) return false
  // 引用了本轮写入文件路径的命令（如 `node scripts/check.mjs src/a.ts`）视为定向验证。
  if (referencesWrittenPath(trimmed, wrotePaths)) return true
  // tsc/test/lint 等验证语义命令视为已尝试验证（覆盖全仓 typecheck/test 的常见形态）。
  return VALIDATION_KEYWORD_PATTERN.test(trimmed)
}

/** 命令文本是否引用本轮写入的任一文件路径（全路径或带扩展名的 basename）。 */
function referencesWrittenPath(command: string, wrotePaths: TrackedWrite[]): boolean {
  const haystack = command.replace(/\\/g, '/').toLowerCase()
  return wrotePaths.some((entry) => {
    const normalized = entry.path.replace(/\\/g, '/').toLowerCase()
    if (haystack.includes(normalized)) return true
    const basename = normalized.split('/').pop() ?? ''
    // 只认带扩展名的 basename，避免「README」这类短词在无关命令里误命中。
    return basename.includes('.') && haystack.includes(basename)
  })
}
