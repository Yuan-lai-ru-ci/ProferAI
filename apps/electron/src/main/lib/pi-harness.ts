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

export interface PiHarness {
  recordToolCall(call: PiHarnessToolCall): void
  markBlocked(): void
  markTerminalFailure(): void
  createFollowUpPrompt(): string | undefined
}

export interface PiHarnessOptions {
  userPrompt: string
}

const LOCAL_WRITE_TOOLS = new Set(['write', 'edit'])
const VALIDATION_TOOLS = new Set(['bash', 'powershell'])
const DOCUMENT_PATH_PATTERN = /\.(?:md|mdx|txt|rst)$/i

export function createPiHarness(options: PiHarnessOptions): PiHarness {
  let wroteLocalFiles = false
  let observedValidationAttempt = false
  let followUpIssued = false
  let blockedOrFailed = false
  let wroteOnlyDocuments = true

  return {
    recordToolCall({ name, input }) {
      const normalizedName = name.trim().toLowerCase()
      if (LOCAL_WRITE_TOOLS.has(normalizedName)) {
        wroteLocalFiles = true
        if (!isDocumentPath(input)) wroteOnlyDocuments = false
        return
      }
      if (VALIDATION_TOOLS.has(normalizedName) && wroteLocalFiles) {
        observedValidationAttempt = true
      }
    },

    markBlocked() {
      blockedOrFailed = true
    },

    markTerminalFailure() {
      blockedOrFailed = true
    },

    createFollowUpPrompt() {
      if (!wroteLocalFiles || observedValidationAttempt || followUpIssued || blockedOrFailed) return undefined
      followUpIssued = true
      return wroteOnlyDocuments
        ? '你刚刚修改了文档，但尚未验证结果。请只执行一次最小闭环：重新读取已改动片段并检查内容/格式是否符合目标。不要重复原任务或扩大改动；如果无法验证，最终答复必须如实说明原因。'
        : '你刚刚修改了本地文件，但尚未进行验证。请只执行一次与本次改动相称的最小验证（例如查看改动、运行最相关的检查或测试）。不要重复原任务或扩大改动；如果验证失败或无法执行，最终答复必须如实说明结果和原因。'
    },
  }
}

function isDocumentPath(input: Record<string, unknown>): boolean {
  const path = input.path ?? input.file_path
  return typeof path === 'string' && DOCUMENT_PATH_PATTERN.test(path)
}
