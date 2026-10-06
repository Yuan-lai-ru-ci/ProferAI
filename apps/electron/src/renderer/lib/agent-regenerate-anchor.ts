/**
 * 「重新生成」锚点解析
 *
 * Agent 会话没有「原地重新生成」原子能力，可复用的是回退：主进程 `rewindSession`
 * 会保留目标 assistant 消息、截断其后全部对话（并按快照恢复工作区文件），
 * 下一次发消息从该点继续（Claude 记录 `resumeAtMessageUuid`，Pi 截断自身 transcript）。
 *
 * 所以要重新生成最后一轮，锚点必须取最后一条用户消息**之前**的主线 assistant 消息：
 * 回退后最后一轮的一问一答被整体删除，再重发同一条用户消息即得到替换性的新回复。
 *
 * 首轮就失败时没有锚点（回退到哪里都保留不下东西），只能清空整段对话——
 * 主进程侧对应 `rewindSession` 省略 `assistantMessageUuid` 的分支。
 */

import type { SDKMessage } from '@profer/shared'
import { isGoalIterationMessage } from '@profer/shared'

interface SDKMessageRecord {
  type?: string
  parent_tool_use_id?: string | null
  isSynthetic?: boolean
  uuid?: string
  message?: {
    content?: unknown
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * 用户真实输入的文本。
 *
 * tool_result / 子代理消息 / 合成消息返回 null；Goal 自动迭代注入的控制消息
 * 也不算用户发言（与迷你地图、分隔条口径一致）。
 */
export function getUserTextFromSDKMessage(message: SDKMessage): string | null {
  const sdkMessage = message as unknown as SDKMessageRecord
  if (sdkMessage.type !== 'user' || sdkMessage.parent_tool_use_id || sdkMessage.isSynthetic) {
    return null
  }
  if (isGoalIterationMessage(message)) return null

  const content = sdkMessage.message?.content
  if (!Array.isArray(content)) return null
  if (content.some((block) => isRecord(block) && block.type === 'tool_result')) return null

  const texts = content
    .filter((block) => isRecord(block) && block.type === 'text' && typeof block.text === 'string')
    .map((block) => (block as { text: string }).text)

  return texts.length > 0 ? texts.join('\n') : null
}

export type RegenerateTarget =
  | { kind: 'rewind'; userMessage: string; rewindToAssistantUuid: string }
  | { kind: 'reset'; userMessage: string }

/**
 * 错误卡片的「重试」是否应改走重新生成（截断最后一轮再重发）。
 *
 * 必须同时满足：
 * - 该卡片属于**最新一轮**：锚点只按「最后一条用户消息」解析，历史错误卡片如果也走这条路，
 *   会用与该卡片无关的最新一轮做截断。
 * - 会话当前空闲：主进程回退要求会话未在运行（JSONL 并发写入会损坏文件）。
 *
 * 不满足时调用方回落追加式重发；无锚点的情况由调用方不传回调处理。
 */
export function shouldRegenerateFromRetry(params: {
  isLatestTurn: boolean
  sessionActive: boolean
}): boolean {
  return params.isLatestTurn && !params.sessionActive
}

/**
 * 解析「重新生成」的目标。
 *
 * - 最后一条用户消息之前还有主线 assistant 回复 → `rewind`（回退到该回复，截断最后一轮）
 * - 没有（首轮就失败）→ `reset`（清空整段对话，回到会话起点）
 *
 * 返回 undefined 仅当历史里没有任何用户输入消息（没有可重发的文本）。
 */
export function resolveRegenerateTarget(messages: readonly SDKMessage[]): RegenerateTarget | undefined {
  let lastUserIndex = -1
  let userMessage: string | null = null
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const text = getUserTextFromSDKMessage(messages[index]!)
    if (text !== null) {
      lastUserIndex = index
      userMessage = text
      break
    }
  }
  if (lastUserIndex < 0 || userMessage === null) return undefined

  for (let index = lastUserIndex - 1; index >= 0; index -= 1) {
    const record = messages[index] as unknown as SDKMessageRecord
    // 子代理（parent_tool_use_id 非空）消息没有独立回退点，只能落在主线 assistant 上。
    if (record.type !== 'assistant' || record.parent_tool_use_id) continue
    if (typeof record.uuid !== 'string' || record.uuid.length === 0) continue
    return { kind: 'rewind', userMessage, rewindToAssistantUuid: record.uuid }
  }

  // 首轮就失败：没有可保留的锚点，整段清空后重发
  return { kind: 'reset', userMessage }
}
