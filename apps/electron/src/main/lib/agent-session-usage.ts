/**
 * 读取一个 Agent session 当前的上下文占用率。
 *
 * 用途：automation 调度器在 daily 模式下决定是否要切到新会话——
 * 同一自然日内即便上次运行成功，如果上下文已经接近窗口上限，
 * 继续往里塞会导致本次运行刚开始就触发 SDK 自动压缩，得不偿失。
 *
 * 数据来源：~/.proma/agent-sessions/{id}.jsonl 里最后一条带 usage 的消息。
 * 优先级：
 * 1. SDK result 消息（subtype=success/error_*）：usage.input_tokens + modelUsage[?].contextWindow
 * 2. SDK assistant 消息：message.usage.input_tokens + 按 message.model 推断 contextWindow
 * 3. 都拿不到：返回 undefined（占用率未知），调度器按"保守复用"处理
 */

import { calculateContextUsageRatio, inferContextWindow } from '@proma/shared'
import type { SDKAssistantMessage, SDKResultMessage } from '@proma/shared'
import { getAgentSessionSDKMessages } from './agent-session-manager'

export function getSessionContextUsageRatio(sessionId: string): number | undefined {
  const messages = getAgentSessionSDKMessages(sessionId)
  if (messages.length === 0) return undefined

  // 倒序找最后一条带 usage 的消息（result 优先，因为它带 modelUsage.contextWindow）
  // SDKMessage union 含有兜底广义成员，需显式 cast 到具体子类型才能访问 message/usage
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (!msg) continue

    if (msg.type === 'result') {
      const result = msg as SDKResultMessage
      if (!result.usage) continue
      const usedTokens = result.usage.input_tokens
      const contextWindow = pickResultContextWindow(result)
      return calculateContextUsageRatio(usedTokens, contextWindow)
    }

    if (msg.type === 'assistant') {
      const asst = msg as SDKAssistantMessage
      const usage = asst.message?.usage
      if (!usage) continue
      const usedTokens = usage.input_tokens
      const contextWindow = inferContextWindow(asst.message?.model)
      return calculateContextUsageRatio(usedTokens, contextWindow)
    }
  }

  return undefined
}

/**
 * 从 SDK result.modelUsage 多 entry 中选择代表性的 contextWindow。
 *
 * SDK 0.3.142+ Task 工具默认启用后，单次 result 可能包含多个模型（主对话 + 子 agent），
 * modelUsage 会有多个 entry。result.usage.input_tokens 是聚合值，其中大头通常属于主模型，
 * 所以用**最大** contextWindow 作为分母最接近"主模型视角的占用率"——这样：
 *   - 单 entry（常态）：行为与从前一致
 *   - 多 entry：避免被子 agent 的小窗口拉低、过早误触发 daily 切换阈值
 *
 * 每个 entry 优先用 SDK 实测的 contextWindow，缺失时按 modelId 推断。
 */
function pickResultContextWindow(result: SDKResultMessage): number | undefined {
  if (!result.modelUsage) return undefined
  let best: number | undefined
  for (const [modelId, info] of Object.entries(result.modelUsage)) {
    const win = info?.contextWindow ?? inferContextWindow(modelId)
    if (win === undefined) continue
    if (best === undefined || win > best) best = win
  }
  return best
}
