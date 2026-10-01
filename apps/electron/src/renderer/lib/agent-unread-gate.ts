/**
 * 「会话未读」门控纯函数（渲染层）。
 *
 * 需求口径：关闭态（`auto`）下打开/切换/关闭标签页等路径照旧自动清未读；开启态（`manual`）下
 * 这些自动路径一律失效，「已读」只能由用户显式确认。本模块只回答两个问题，全部是纯函数：
 *
 * 1. `shouldAutoClearUnreadOnView(mode)`：这次「自动清除」还要不要执行（决定要不要调 IPC）；
 * 2. `planModeTransition(...)` / `planUnreadSeedOnInit(...)`：开关切换时怎么迁移未读，保证两向都不丢；
 *    开 → 关额外做一次**双向收敛**：会话列表里已明确为已读的 id 从内存集合剔除（否则开启态里
 *    确认过的已读会在关闭态复活），列表里不存在的未知 id 一律保留。
 *
 * 内存集合本身的门控不在这里：它在 `atoms/agent-atoms.ts` 的模式感知 atom 里统一失效
 * （一处门控覆盖全部 10 个内存写入点），让 R1–R10 的调用点代码零删除。
 *
 * 模式名沿用主进程 `main/lib/agent-unread-policy.ts` 的 `AgentUnreadPolicyMode` 语义：
 * `auto` = 关闭态（既有行为），`manual` = 开启态（手动确认）。
 */

/** 与主进程策略模块同义的渲染层模式类型（渲染层不 import 主进程模块）。 */
export type AgentUnreadMode = 'auto' | 'manual'

/**
 * 「打开/查看会话」类自动清除路径是否仍然生效。
 *
 * 只有两处调用点会先把自动清除落到持久化字段上：`useOpenSession`（打开会话）与
 * `useCloseTab`（关闭标签页）。关闭态保持原样；开启态不调用，避免「看一眼就吃掉未读」。
 * 其余内存侧自动清除点不需要改代码（由模式感知 atom 统一门控）。
 */
export function shouldAutoClearUnreadOnView(mode: AgentUnreadMode): boolean {
  return mode === 'auto'
}

/** 开关切换的迁移计划。 */
export interface AgentUnreadTransitionPlan {
  /** 需要补写为持久化未读的 id（关 → 开：避免开启瞬间内存未读「瞬间消失」）。 */
  persistUnreadIds: string[]
  /** 需要回填进渲染层内存集合的 id（开 → 关：让关闭态的显示权威重新拿到未读）。 */
  seedMemoryUnreadIds: string[]
  /**
   * 需要从渲染层内存集合剔除的 id（开 → 关：这些会话在开启态已被确认已读，不得在关闭态复活）。
   * 只包含「会话列表里明确为已读」的已知 id；列表里不存在的未知 id 一律保留（不追溯清理）。
   */
  clearMemoryUnreadIds: string[]
}

/** 空计划（同态切换 / 无副作用）。 */
const EMPTY_TRANSITION_PLAN: AgentUnreadTransitionPlan = {
  persistUnreadIds: [],
  seedMemoryUnreadIds: [],
  clearMemoryUnreadIds: [],
}

/** 求 `source` 中不在 `existing` 里的 id（去重、保序）。 */
function missingIds(source: readonly string[], existing: readonly string[]): string[] {
  const existingSet = new Set(existing)
  const result: string[] = []
  for (const id of source) {
    if (existingSet.has(id)) continue
    existingSet.add(id)
    result.push(id)
  }
  return result
}

/** 去重并保留原顺序。 */
function uniqueIds(source: readonly string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const id of source) {
    if (seen.has(id)) continue
    seen.add(id)
    result.push(id)
  }
  return result
}

/**
 * 开关切换时的未读迁移（对应 `requirements.md` §6 的 U-1）。
 *
 * - **关 → 开**（`auto` → `manual`）：关闭态期间产生的未读只在渲染层内存集合里，
 *   而开启态的事实源是持久化字段。若不补写，用户一开启开关这些未读就凭空消失。
 *   因此把内存集合里尚未持久化的 id 列进 `persistUnreadIds`。
 * - **开 → 关**（`manual` → `auto`）：关闭态的显示权威是内存集合，而内存集合在开启态
 *   期间是空转的。把持久化未读里内存集合还没有的 id 列进 `seedMemoryUnreadIds`；
 *   同时把「开启态期间已被用户确认已读」的旧内存 id 列进 `clearMemoryUnreadIds`
 *   ——开启态下内存集合不跟随清除，不剔除就会在切回关闭态时绿标复活。
 * - 同态切换：三项都为空（幂等）。
 *
 * 两个方向都不丢未读：关 → 开只补写不删；开 → 关只回填 + 剔除「已确认已读」（不清理任何
 * 仍为未读的 id，也不追溯清理会话列表里不存在的 id）。
 */
export function planModeTransition(input: {
  from: AgentUnreadMode
  to: AgentUnreadMode
  memoryUnreadIds: readonly string[]
  persistedUnreadIds: readonly string[]
  /**
   * 会话列表中**明确为已读**的会话 id（存在且 `completedButUnconfirmed` 不为真）。
   * 仅用于开 → 关方向：这些 id 在开启态期间已被确认/清过，内存集合里的陈旧副本必须剔除。
   */
  confirmedReadIds?: readonly string[]
}): AgentUnreadTransitionPlan {
  if (input.from === input.to) return { ...EMPTY_TRANSITION_PLAN }
  if (input.to === 'manual') {
    return {
      persistUnreadIds: missingIds(input.memoryUnreadIds, input.persistedUnreadIds),
      seedMemoryUnreadIds: [],
      clearMemoryUnreadIds: [],
    }
  }
  const confirmedRead = new Set(input.confirmedReadIds ?? [])
  return {
    persistUnreadIds: [],
    // 已确认已读的 id 不参与回填（防御性：正常构造下两者互斥）。
    seedMemoryUnreadIds: missingIds(input.persistedUnreadIds, input.memoryUnreadIds)
      .filter((id) => !confirmedRead.has(id)),
    clearMemoryUnreadIds: uniqueIds(input.memoryUnreadIds.filter((id) => confirmedRead.has(id))),
  }
}

/**
 * 初始化时的安全回填：关闭态下把持久化未读补进内存集合。
 *
 * 与 `use-left-sidebar.ts` 启动恢复（拉列表后按 `completedButUnconfirmed` 回填内存集合）
 * 是同一件事，这里在初始化阶段补一次，保证「设置还没加载完 / 列表还没拉回来」的窗口内
 * 内存集合也不会漏掉持久化未读。幂等。
 */
export function planUnreadSeedOnInit(input: {
  memoryUnreadIds: readonly string[]
  persistedUnreadIds: readonly string[]
}): string[] {
  return missingIds(input.persistedUnreadIds, input.memoryUnreadIds)
}
