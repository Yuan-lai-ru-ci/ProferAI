/**
 * Agent Prompt 构建工具函数
 *
 * 从 agent-orchestrator.ts 提取的纯函数，用于构建上下文注入和恢复 prompt。
 */
import { getAgentSessionSDKMessages, getAgentSessionMeta } from './agent-session-manager'
import { getBundledCliPath, getConfigDirName } from './config-paths'
import type { SDKMessage, AgentSessionMeta } from '@profer/shared'
import { readMessageProvenance } from '@profer/shared'

/** 最大回填消息条数 */
export const MAX_CONTEXT_MESSAGES = 20

/** 单条工具摘要最大字符数 */
const MAX_TOOL_SUMMARY_LENGTH = 200

/** 默认会话标题 */
export const DEFAULT_SESSION_TITLE = '新 Agent 会话'

/** 默认模型 ID */
export const DEFAULT_MODEL_ID = 'claude-sonnet-4-6'

/**
 * 从 SDKMessage assistant 消息的 content 中提取工具活动摘要
 */
export function extractSDKToolSummary(content: Array<{ type: string; name?: string; input?: Record<string, unknown> }>): string {
  const summaries: string[] = []
  for (const block of content) {
    if (block.type === 'tool_use' && block.name) {
      const input = block.input ?? {}
      const keyParam = input.file_path ?? input.command ?? input.path ?? input.query ?? ''
      const paramStr = keyParam ? `: ${String(keyParam).slice(0, 100)}` : ''
      summaries.push(`[tool: ${block.name}${paramStr}]`)
    }
  }
  if (summaries.length === 0) return ''
  const joined = summaries.join(' ')
  return joined.length > MAX_TOOL_SUMMARY_LENGTH
    ? joined.slice(0, MAX_TOOL_SUMMARY_LENGTH) + '...'
    : joined
}

/**
 * 构建带历史上下文的 prompt
 */
export function buildContextPrompt(sessionId: string, currentUserMessage: string, sessionHint?: { agentCwd: string }): string {
  const allMessages = getAgentSessionSDKMessages(sessionId)
  if (allMessages.length === 0) return currentUserMessage

  // 旧链调用时当前用户消息已经落盘：去掉最后一条才是「历史」。
  const history = allMessages.slice(0, -1)
  if (history.length === 0) return currentUserMessage

  const { block, injected } = formatContextHistoryBlock(
    history,
    sessionHint ? { sessionId, agentCwd: sessionHint.agentCwd } : undefined,
  )
  if (!block) return currentUserMessage

  console.log(`[Agent 编排] buildContextPrompt: 读取 ${allMessages.length} 条消息，注入 ${injected} 条历史${sessionHint ? '（含 session 元信息）' : ''}`)
  return `${block}\n\n${currentUserMessage}`
}

/**
 * 把历史消息格式化成 `<conversation_history>` 块（不含当前用户消息）。
 *
 * 抽出来是为了让新链复用同一份格式：新链在本轮消息落盘**之前**拼 prompt，
 * 手里已经是「纯历史」，不需要旧链那个 `slice(0, -1)` 的位移语义。
 */
export function formatContextHistoryBlock(
  history: readonly SDKMessage[],
  sessionHint?: { sessionId: string; agentCwd: string },
): { block: string; injected: number } {
  if (history.length === 0) return { block: '', injected: 0 }
  const recent = history.slice(-MAX_CONTEXT_MESSAGES)
  const lines = recent
    .filter((m) => (m.type === 'user' || m.type === 'assistant'))
    .map((m) => {
      const content = (m as { message?: { content?: Array<{ type: string; text?: string; name?: string; input?: Record<string, unknown> }> } }).message?.content
      if (!Array.isArray(content)) return null

      const textParts = content
        .filter((b) => b.type === 'text' && b.text)
        .map((b) => b.text!)
      const text = textParts.join('\n')
      if (!text) return null

      const provenance = readMessageProvenance(m._provenance)
      const author = provenance?.author
      const source = provenance?.source
      const identity = author ? `${author.type}${author.id ? `:${author.id}` : ''}` : 'unknown'
      let line = `[${m.type}; author=${identity}${source ? `; source=${source.type}:${source.id}` : ''}${provenance ? `; run=${provenance.runId}` : ''}]: ${text}`
      if (m.type === 'assistant') {
        const toolSummary = extractSDKToolSummary(content)
        if (toolSummary) {
          line += `\n  工具活动: ${toolSummary}`
        }
      }
      return line
    })
    .filter(Boolean)

  if (lines.length === 0) return { block: '', injected: 0 }

  const sessionInfoBlock = sessionHint
    ? `\n<session_info>\nSession ID: ${sessionHint.sessionId}\nSession CWD: ${sessionHint.agentCwd}\nNote: 上方为近期对话摘要。如需更多上下文，可读取 ~/${getConfigDirName()}/agent-sessions/${sessionHint.sessionId}.jsonl 获取完整历史。\n</session_info>\n`
    : ''

  return {
    block: `<conversation_history>${sessionInfoBlock}\n${lines.join('\n')}\n</conversation_history>`,
    injected: lines.length,
  }
}

/**
 * 构建 Session 恢复 prompt
 */
export function buildRecoveryPrompt(
  sessionId: string,
  currentUserMessage: string,
  sessionHint: { agentCwd: string },
): string {
  const meta = getAgentSessionMeta(sessionId)
  const title = meta ? escapeContextAttr(meta.title) : sessionId
  const historyPath = `~/${getConfigDirName()}/agent-sessions/${sessionId}.jsonl`

  const recoveryBlock =
    `<session_recovery>\n` +
    `你正在接续一个已有的 Agent 会话（因模型切换等原因需要重新建立连接）。\n` +
    `当前会话的完整历史记录在下方路径中，请先读取它以恢复上下文，然后继续处理用户的最新请求。\n` +
    `<session id="${sessionId}" title="${title}" cwd="${sessionHint.agentCwd}">\n` +
    `History path: ${historyPath}\n` +
    `</session>\n` +
    `</session_recovery>`

  console.log(`[Agent 编排] buildRecoveryPrompt: 注入 session 自引用 → ${historyPath}`)
  return `${recoveryBlock}\n\n${currentUserMessage}`
}

/**
 * 空输出重试 prompt。
 *
 * 模型上一轮只产出了思考（reasoning_content），正文为空。原样重发大概率得到同样的空输出，
 * 而长上下文下重发一次就是几十万 token，所以这里改成定向催答：只要正文，不要继续思考。
 */
export function buildEmptyOutputRetryPrompt(currentUserMessage: string): string {
  const nudge =
    `<empty_output_retry>\n` +
    `上一轮你只输出了思考过程，正文为空，用户什么也没看到。\n` +
    `请直接输出最终的答复正文：不要复述思考过程，不要以「继续思考」开头，也不要用工具探测。\n` +
    `如果你已经想清楚了，就把结论、证据和下一步写成完整的回复。\n` +
    `</empty_output_retry>`
  return `${nudge}\n\n${currentUserMessage}`
}

export function escapeContextAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function getSessionCliCommandPrefix(): string {
  return getBundledCliPath() ? '"$PROFER_CLI"' : 'profer'
}

export function buildReferencedSessionsPrompt(
  currentSessionId: string,
  mentionedSessionIds?: string[],
  workspaceId?: string,
): string {
  const uniqueIds = [...new Set((mentionedSessionIds ?? []).filter(Boolean))]
  if (uniqueIds.length === 0) return ''

  const currentWorkspaceId = workspaceId ?? getAgentSessionMeta(currentSessionId)?.workspaceId
  const sessionBlocks: string[] = []

  for (const referencedSessionId of uniqueIds) {
    if (referencedSessionId === currentSessionId) continue

    const meta = getAgentSessionMeta(referencedSessionId)
    if (!meta || meta.archived) continue
    if (currentWorkspaceId && meta.workspaceId !== currentWorkspaceId) continue

    const title = escapeContextAttr(meta.title)
    const historyPath = `~/${getConfigDirName()}/agent-sessions/${referencedSessionId}.jsonl`
    const explorationBoundary = meta.explorationParentSessionId && meta.explorationSourceMessageId
      ? `\n<exploration_delta parentSessionId="${escapeContextAttr(meta.explorationParentSessionId)}" sourceMessageId="${escapeContextAttr(meta.explorationSourceMessageId)}">\n` +
        '此会话是从主线分叉的探索分支；用户引用的仅是 sourceMessageId 之后新增的探索内容。\n' +
        '分叉前复制的主线历史不是本次引用内容：不要读取、总结或重复处理它。\n' +
        `请先用 ${getSessionCliCommandPrefix()} session export ${referencedSessionId} --after-message ${meta.explorationSourceMessageId} 精确读取分叉后的内容。\n` +
        '仅当必须核验分支内更早的新增内容时，才在该边界之后渐进读取；不要导出完整 fork 历史。\n' +
        '</exploration_delta>'
      : ''
    sessionBlocks.push(
      `<session id="${referencedSessionId}" title="${title}" updatedAt="${meta.updatedAt}">\n` +
      `History path: ${historyPath}\n` +
      `</session>${explorationBoundary}`,
    )
  }

  if (sessionBlocks.length === 0) return ''

  return `<referenced_sessions>\n用户在消息中明确引用了以下同工作区 Agent 会话。不要假设这些会话的内容；需要上下文时，请先读取对应的 History path，再基于读取结果继续完成任务。\n\n重要提示：会话历史文件（.jsonl）可能包含大量消息和 tool results，文件较大。请优先使用 Grep 搜索关键词定位相关消息片段，再局部读取。避免一次性 Read 整个大文件。\n${sessionBlocks.join('\n\n')}\n</referenced_sessions>`
}
