import type { QuotedSelection } from '@/atoms/preview-atoms'
import { buildQuotedSelectionsPrefix } from '@/lib/quoted-selection'

/**
 * 发送前的文本拼装：正文 + 待发送引用列表 → 最终交给主进程的文本。
 *
 * 引用以 `[n]` 胶囊内联在正文里（编辑器节点），发送时按编号取出；
 * 这里只负责按 ref 顺序把引用块前缀拼到正文前面，不持有任何引用状态。
 */

/**
 * 剥离 Electron `ipcRenderer.invoke` 给主进程错误加上的包装前缀：
 * `Error invoking remote method '<channel>': Error: <主进程文案>`。
 *
 * 主进程抛出的文案本身不带前缀，所以对 `error.message` 做锚定匹配会在真实 IPC 上永远失配
 * （同一前缀的剥离写法已存在于 FileBrowser.stripIpcErrorPrefix）。
 */
function stripIpcErrorPrefix(message: string): string {
  return message
    .replace(/^Error invoking remote method '[^']+':\s*/i, '')
    .replace(/^Error:\s*/i, '')
    .trim()
}

/** Main 已结束旧 run、renderer 尚未收到 complete 时，可安全降级为新 run。 */
export function isQueueTargetNoLongerActiveError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return /^\[Agent 编排\] 会话未运行，无法追加消息: /.test(stripIpcErrorPrefix(error.message))
}

/** Main 确认本次请求未启动、同 session 的 owner run 仍在执行。 */
export function isAgentRunAlreadyActiveError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return /^AGENT_RUN_ALREADY_ACTIVE: /.test(stripIpcErrorPrefix(error.message))
}

const REF_PATTERN = /\/skill:(?<skill>\S+)|#mcp:(?<mcp>\S+)|&session:(?<session>[A-Za-z0-9-]+)(?:(?:~|::)\S+)?/g

export interface ParsedMessageMentions {
  cleanedText: string
  mentionedSkills: string[]
  mentionedMcpServers: string[]
  mentionedSessionIds: string[]
}

export function parseMessageMentions(text: string): ParsedMessageMentions {
  const mentionedSkills: string[] = []
  const mentionedMcpServers: string[] = []
  const mentionedSessionIds: string[] = []

  for (const match of text.matchAll(REF_PATTERN)) {
    const { skill, mcp, session } = match.groups ?? {}
    if (skill) mentionedSkills.push(skill)
    else if (mcp) mentionedMcpServers.push(mcp)
    else if (session) mentionedSessionIds.push(session)
  }

  return {
    cleanedText: text.replace(REF_PATTERN, '').trim(),
    mentionedSkills,
    mentionedMcpServers,
    mentionedSessionIds,
  }
}

export interface AgentMessageSendPayload {
  rawText: string
  sdkText: string
  mentions: ParsedMessageMentions
}

/**
 * 拼装最终发送文本：顺序固定为「引用块们 → 正文（含 `[n]` 标记）」。
 *
 * - 引用块按 `ref` 升序展开，块上带同一个 `ref`，模型据此把正文里的 `[2]` 对上具体哪段。
 * - 正文里的 `[n]` **必须保留**：用户就是靠它指代引用的（「按 [2] 改」），删掉等于毁掉语义。
 * - `rawText` 保留 mention 原文（用于持久化气泡展示），`sdkText` 剥掉 mention 标记
 *   （模型只需要结构化字段，不需要 `/skill:` 这类前缀）。
 */
export function buildAgentMessagePayload(
  text: string,
  quotedSelections: readonly QuotedSelection[] = [],
): AgentMessageSendPayload {
  const trimmed = text.trim()
  const mentions = parseMessageMentions(trimmed)
  const ordered = [...quotedSelections].sort((a, b) => (a.ref ?? 0) - (b.ref ?? 0))
  const prefix = buildQuotedSelectionsPrefix(ordered)

  return {
    rawText: `${prefix}${trimmed}`.trim(),
    sdkText: `${prefix}${mentions.cleanedText}`.trim(),
    mentions,
  }
}
