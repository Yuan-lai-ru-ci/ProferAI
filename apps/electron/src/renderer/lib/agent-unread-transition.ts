/**
 * 开关切换时的未读迁移（effectful 部分）。
 *
 * 纯逻辑在 `agent-unread-gate.ts` 的 `planModeTransition`；这里只负责把计划落到两处副作用上：
 * 渲染层内存集合（`memoryUnviewedCompletedSessionIdsAtom`）与主进程持久化未读
 * （`setAgentCompletionState`，即 `completedButUnconfirmed` 的唯一写入口）。
 *
 * 口径（`requirements.md` §6 U-1）：
 * - 关 → 开：把关闭态期间只在内存里的未读补写成持久化未读，否则开启瞬间未读会凭空消失；
 * - 开 → 关：把持久化未读回填进内存集合，并把「开启态期间已被确认已读」的陈旧内存 id 剔除
 *   （双向收敛，避免切回关闭态后绿标复活）；
 * - 两向都不丢任何仍为未读的会话（关→开不删；开→关只剔除已确认已读）。
 *
 * 复验残余项 R-1 / B-2 的两条防护也在本文件（口径：任何切换顺序结束后，绿标、持久化字段、
 * 菜单判据三者一致）：
 *
 * 1. **迁移串行化（R-1）**：任何时刻最多一次迁移在跑，后续切换排队等它结束再执行。
 *    修复前的交错是：第一次「关 → 开」的补写仍在途，第二次「开 → 关」就已按**不含该补写**的
 *    列表快照做判据 ⇒ 该 id 被当作「已确认已读」从内存剔除，随后补写才把持久化字段写成未读
 *    ⇒ 终态「关闭态绿标不亮、菜单却显示『标记已读』」。排队后，后一次迁移的判据快照必然包含
 *    前一次的全部落盘结果（含乐观刷新），两侧收敛到同一状态。
 * 2. **未确认补写保护（B-2）**：补写失败（IPC/写盘异常）时保留「未确认」标记，后续「开 → 关」
 *    不得把该 id 当作「已确认已读」剔除（否则未读静默丢失）；补写成功、或用户在渲染层显式
 *    确认已读（`noteExplicitUnreadRead`）后撤销该标记。
 */

import type { Getter, Setter } from 'jotai/vanilla'
import { agentSessionsAtom, memoryUnviewedCompletedSessionIdsAtom } from '@/atoms/agent-atoms'
import { planModeTransition, type AgentUnreadMode, type AgentUnreadTransitionPlan } from '@/lib/agent-unread-gate'
import { upsertAgentSession } from '@/lib/agent-session-list'

/**
 * 迁移串行化的队列尾（R-1）。
 *
 * 只需保证「同一次渲染进程内不并发执行迁移」：每次调用被链到上一次之后，等待期间不会有任何
 * 判据读取或写入，因此后一次一定读到前一次已落盘的完整状态。队列尾吞掉异常，避免一次失败
 * 污染后续迁移。
 */
let transitionChain: Promise<void> = Promise.resolve()

/**
 * 「补写持久化未读」尚未确认成功的 id（B-2）。
 *
 * 只有补写失败或仍在途的 id 会留在这里；补写成功（持久化字段已是未读）或用户显式确认已读后撤销。
 * 它唯一的用途是收紧「开 → 关」剔除陈旧内存未读的判据：不得把这些 id 当作「已确认已读」删除。
 */
const unconfirmedUnreadPersistIds = new Set<string>()

/**
 * 记录「用户已显式确认该会话已读」。
 *
 * 调用点只有两个显式确认入口：会话最新一轮的「确认已读」按钮（`ConfirmReadButton.tsx`）与
 * 侧边栏会话菜单的「标记已读」（`use-left-sidebar.ts` 的 `handleToggleSessionUnread`）。
 * 显式确认后该 id 的持久化状态已由用户意图确定，不再受「未确认补写」保护——若此时内存集合
 * 里仍有陈旧副本，「开 → 关」方向应当按用户意图把它剔除（否则绿标会在关闭态复活）。
 */
export function noteExplicitUnreadRead(sessionId: string): void {
  unconfirmedUnreadPersistIds.delete(sessionId)
}

/**
 * 执行一次开关切换的未读迁移（对外入口，已串行化）。
 *
 * 调用时机：开关的 `onCheckedChange` 已经把 `manualReadConfirmEnabledAtom` 写成新值之后
 * （即 `from` 是旧值、`to` 是新值）。因此这里对公共默认 atom 的任何写入都会被开启态的
 * 守卫丢掉 —— 这是刻意的：内存集合与持久化字段都必须直写各自的事实源。
 *
 * 若上一次迁移仍在途，本次调用会排在其后执行（R-1），返回的 Promise 在本轮真正执行完成后 resolve。
 */
export function applyUnreadModeTransition(input: {
  from: AgentUnreadMode
  to: AgentUnreadMode
  get: Getter
  set: Setter
}): Promise<AgentUnreadTransitionPlan> {
  const run = transitionChain.then(() => runModeTransition(input))
  transitionChain = run.then(() => undefined, () => undefined)
  return run
}

/** 单次迁移的实际执行体：读取**当前**状态 → 算计划 → 落副作用。 */
async function runModeTransition(input: {
  from: AgentUnreadMode
  to: AgentUnreadMode
  get: Getter
  set: Setter
}): Promise<AgentUnreadTransitionPlan> {
  const sessions = input.get(agentSessionsAtom)
  const plan = planModeTransition({
    from: input.from,
    to: input.to,
    memoryUnreadIds: [...input.get(memoryUnviewedCompletedSessionIdsAtom)],
    persistedUnreadIds: sessions
      .filter((session) => session.completedButUnconfirmed)
      .map((session) => session.id),
    // 已知已读 id（会话存在且持久化字段不为真），仅「开 → 关」方向用于剔除陈旧内存未读。
    // 判据收紧（R-1 / B-2）：本渲染层还有未确认补写的 id 不算「已确认已读」——列表里的
    // `false` 可能只是补写还没落地，而不是用户在开启态里确认过。
    confirmedReadIds: sessions
      .filter((session) => !session.completedButUnconfirmed)
      .map((session) => session.id)
      .filter((id) => !unconfirmedUnreadPersistIds.has(id)),
  })

  if (plan.seedMemoryUnreadIds.length > 0 || plan.clearMemoryUnreadIds.length > 0) {
    input.set(memoryUnviewedCompletedSessionIdsAtom, (prev: Set<string>) => {
      const next = new Set(prev)
      for (const id of plan.seedMemoryUnreadIds) next.add(id)
      for (const id of plan.clearMemoryUnreadIds) next.delete(id)
      return next
    })
  }

  for (const id of plan.persistUnreadIds) {
    // 先登记「未确认」，补写成功后再撤销（B-2）。
    unconfirmedUnreadPersistIds.add(id)
    try {
      const meta = await window.electronAPI.setAgentCompletionState(id)
      unconfirmedUnreadPersistIds.delete(id)
      // 乐观刷新列表：开启态的未读读的是会话元数据，刷新后才能立刻看到绿标。
      input.set(agentSessionsAtom, (prev) => upsertAgentSession(prev, meta))
    } catch (error) {
      // 保留「未确认」标记：后续「开 → 关」不得把该 id 当作已确认已读剔除；
      // 下次「关 → 开」会因「内存有、持久化没有」再次补写（天然重试）。
      console.error(`[未读设置] 补写持久化未读失败: sessionId=${id}`, error)
    }
  }

  return plan
}
