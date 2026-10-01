/**
 * 「开启态」未读集合的派生（渲染层）。
 *
 * 开启态下未读的唯一事实源是会话元数据 `AgentSessionMeta.completedButUnconfirmed`
 * （主进程持久化 + 通过 `session_projection` 广播）。这里把它派生成
 * `unviewedCompletedSessionIdsAtom` 需要的 `Set<string>`。
 *
 * **为什么要缓存引用**：`tabIndicatorMapAtom`、`use-left-sidebar` 的排序/投影等下游会把
 * 这个 Set 放进 `useMemo` 依赖里或直接 `.has()` 比较。若每次读都 `new Set(...)`，下游会
 * 拿到永不相等的新引用，导致每帧重渲染甚至闪烁。因此按「id 签名」缓存：内容不变时返回
 * **同一个 Set 实例**（复用仓库既有 `getStableIndicatorMap` 的做法，见 `atoms/agent-atoms.ts`）。
 *
 * 与 `getStableIndicatorMap` 一样是模块级单例缓存：只用于「内容相同 ⇒ 引用相同」这一个目的，
 * 不做跨 store 隔离，也不需要（Set 内容等价即安全共享）。
 */

import type { AgentSessionMeta } from '@profer/shared'

let lastSignature: string | null = null
let lastIds: Set<string> = new Set<string>()

/**
 * 从会话列表派生未读 id 集合。
 *
 * 同一个签名（未读 id 排序后拼接）重复调用返回同一个 Set 实例。
 */
export function deriveUnreadIdsFromSessions(sessions: readonly AgentSessionMeta[]): Set<string> {
  const ids: string[] = []
  for (const session of sessions) {
    if (session.completedButUnconfirmed) ids.push(session.id)
  }
  // 签名不依赖列表顺序：列表重排但未读成员不变时引用保持稳定。
  ids.sort()
  const signature = ids.join('|')
  if (signature === lastSignature) return lastIds
  lastSignature = signature
  lastIds = new Set(ids)
  return lastIds
}

/** 清空签名缓存（测试用；避免用例之间互相影响引用稳定性断言）。 */
export function resetAgentUnreadDeriveCache(): void {
  lastSignature = null
  lastIds = new Set<string>()
}
