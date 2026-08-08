/**
 * Pi runtime 单轮执行 Harness。
 *
 * 只记录本轮已经发生的、无 SDK 绑定的工具事实：本地修改后若未见验证尝试，
 * 在自然结束前至多要求 Agent 补一次最小验证。权限和风险控制仍完全归编排层负责。
 */

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
  /** 本轮成功写入的本地文件路径（截断前的完整列表）。 */
  pendingPaths: string[]
  /** 是否观察到有意义的 shell 验证尝试（tsc/test 等，不区分成败）。 */
  validationAttempted: boolean
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
}

const LOCAL_WRITE_TOOLS = new Set(['write', 'edit'])
const VALIDATION_TOOLS = new Set(['bash', 'powershell'])
const READ_TOOLS = new Set(['read'])
const DOCUMENT_PATH_PATTERN = /\.(?:md|mdx|txt|rst)$/i

/** 明显无验证意义的 shell 命令前缀（pwd/ls/echo 等探测类，不算验证尝试）。 */
const NON_VALIDATION_COMMAND_PREFIX =
  /^\s*(?:pwd|ls|echo|cd|whoami|date|clear|history|alias|export|set|env|dir|type|where)\b/i

export function createPiHarness(options: PiHarnessOptions): PiHarness {
  /** 本轮成功写入的本地文件（path + 是否文档）。 */
  const wrotePaths: { path: string; document: boolean }[] = []
  let observedValidationAttempt = false
  /** 被 read 工具读回验证过的文档路径。 */
  const verifiedDocumentPaths = new Set<string>()
  let followUpIssued = false
  let blockedOrFailed = false

  const isWritesVerified = (): boolean =>
    wrotePaths.length > 0 && wrotePaths.every((entry) => !entry.document || verifiedDocumentPaths.has(entry.path))

  function handleToolCall(call: PiHarnessToolResult): void {
    const { name, input, outcome } = call
    const normalizedName = name.trim().toLowerCase()

    if (LOCAL_WRITE_TOOLS.has(normalizedName)) {
      // 失败的写入不算变更（recordToolCall 无 outcome，视为成功）
      if (outcome === 'failed') return
      const path = readPath(input)
      if (path !== undefined) {
        wrotePaths.push({ path, document: isDocumentPath(input) })
      }
      return
    }

    if (READ_TOOLS.has(normalizedName)) {
      const path = readPath(input)
      if (path !== undefined) verifiedDocumentPaths.add(path)
      return
    }

    if (VALIDATION_TOOLS.has(normalizedName) && wrotePaths.length > 0 && isMeaningfulValidationCommand(input)) {
      // 命令成败均视为"已尝试验证"（失败同样证明观察过结果）
      observedValidationAttempt = true
    }
  }

  function resolveDecision(): PiHarnessDecision {
    const pendingPaths = wrotePaths.map((entry) => entry.path)

    if (blockedOrFailed) {
      return { action: 'none', reason: 'blocked_or_failed', pendingPaths: [], validationAttempted: false }
    }

    if (wrotePaths.length === 0) {
      return { action: 'none', reason: 'read_only', pendingPaths: [], validationAttempted: false }
    }

    if (observedValidationAttempt) {
      return { action: 'none', reason: 'validated', pendingPaths, validationAttempted: true }
    }

    if (wrotePaths.every((entry) => entry.document)) {
      if (isWritesVerified()) {
        return { action: 'none', reason: 'validated', pendingPaths, validationAttempted: false }
      }
      return {
        action: 'follow_up',
        reason: 'documents_unverified',
        prompt: DOCUMENT_FOLLOW_UP_PROMPT,
        pendingPaths,
        validationAttempted: false,
      }
    }

    return {
      action: 'follow_up',
      reason: 'source_changes_unverified',
      prompt: SOURCE_FOLLOW_UP_PROMPT,
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

const DOCUMENT_FOLLOW_UP_PROMPT =
  '你刚刚修改了文档，但尚未验证结果。请只执行一次最小闭环：重新读取已改动片段并检查内容/格式是否符合目标。不要重复原任务或扩大改动；如果无法验证，最终答复必须如实说明原因。'

const SOURCE_FOLLOW_UP_PROMPT =
  '你刚刚修改了本地文件，但尚未进行验证。请只执行一次与本次改动相称的最小验证（例如查看改动、运行最相关的检查或测试）。不要重复原任务或扩大改动；如果验证失败或无法执行，最终答复必须如实说明结果和原因。'

function readPath(input: Record<string, unknown>): string | undefined {
  const path = input.path ?? input.file_path
  return typeof path === 'string' ? path : undefined
}

function isDocumentPath(input: Record<string, unknown>): boolean {
  const path = readPath(input)
  return typeof path === 'string' && DOCUMENT_PATH_PATTERN.test(path)
}

function isMeaningfulValidationCommand(input: Record<string, unknown>): boolean {
  const command = input.command ?? input.script ?? input.program
  return typeof command === 'string' && !NON_VALIDATION_COMMAND_PREFIX.test(command.trim())
}
