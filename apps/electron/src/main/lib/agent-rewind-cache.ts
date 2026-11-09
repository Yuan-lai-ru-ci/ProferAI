/**
 * 回退后的「派生缓存重建」。
 *
 * 回退改变的是当前会话的历史边界，目标点之后生成的所有派生物都不能继续复用。这里不重建内容，
 * 只做两件必要的事：**让内存索引失效**、**把与轮次数量绑定的水位拉回真实值**。
 *
 * 为什么不是「全部重建」：Profer 的多数派生数据是每次现读的（导航索引按文件版本缓存、
 * 上下文拼装直接读 JSONL），重建 = 下一次读取时自然重算；真正会残留的是**内存缓存**和
 * **单调推进的水位**。
 *
 * 明确不动的：
 * - 标题：自动命名在首轮即定稿，回退不应该静默改掉用户认得的会话名（用户仍可手动重新生成）。
 * - Shadow Git 对象、其他会话的缓存：不属于本次回退范围。
 * - Pi harness 账本：只追加的遥测流水，不参与模型上下文，裁剪它反而会丢掉历史证据。
 */

import { groupIntoTurns } from '@profer/session-core'
import type { SDKMessage } from '@profer/shared'
import { invalidateAgentSessionNavigationIndex } from './agent-navigation-index'
import { getAgentSessionMeta, getAgentSessionSDKMessages, updateAgentSessionMeta } from './agent-session-manager'

/** 与 `retrospective-service` 的 `renderTurns` 同口径：每轮计一条 user 与一条 assistant-turn。 */
function countAnalyzedEntries(messages: readonly SDKMessage[]): number {
  if (messages.length === 0) return 0
  return groupIntoTurns([...messages]).filter((group) => group.type === 'user' || group.type === 'assistant-turn').length
}

export interface RewindCacheRepairResult {
  /** 回退后剩余的「可分析条目」数（user + assistant-turn 分组）。 */
  analyzedEntries: number
  /** 被拉回的水位（原值大于真实条目数时给出）。 */
  clampedAnalyzedTurn?: number
}

/**
 * 回退提交后调用（此时对话文件已经是截断后的内容）。
 *
 * 幂等：重复调用只会重复失效索引；水位只会被拉低，不会被抬高。
 * 会话在回退期间被删除时静默跳过——不需要为一个已消失的会话重建缓存。
 */
export function repairAgentSessionCachesAfterRewind(sessionId: string): RewindCacheRepairResult {
  // 导航索引按 (size, mtimeMs) 缓存；截断后极端情况下 size 与 mtime 都可能没变，
  // 显式失效比依赖文件版本更可靠。
  invalidateAgentSessionNavigationIndex(sessionId)

  const meta = getAgentSessionMeta(sessionId)
  if (!meta) return { analyzedEntries: 0 }

  const analyzedEntries = countAnalyzedEntries(getAgentSessionSDKMessages(sessionId))
  const lastAnalyzed = meta.lastAnalyzedTurn ?? 0
  if (lastAnalyzed <= analyzedEntries) return { analyzedEntries }

  // 回溯抽取的水位是「已分析到第 N 轮」的单调计数。回退删掉了尾部轮次后，水位必须跟着退，
  // 否则下一轮新增永远追不上旧水位（`turns.length <= lastAnalyzed` 会一直被跳过）。
  updateAgentSessionMeta(sessionId, { lastAnalyzedTurn: analyzedEntries }, { touchUpdatedAt: false })
  return { analyzedEntries, clampedAnalyzedTurn: analyzedEntries }
}
