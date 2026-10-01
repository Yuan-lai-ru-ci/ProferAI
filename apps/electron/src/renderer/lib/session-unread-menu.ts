/**
 * session-unread-menu.ts — 侧边栏会话菜单「未读状态切换」纯逻辑。
 *
 * 需求口径（`requirements.md` §3.4）：由固定的「标记未读」改为**按状态切换**——
 * 未读 → 「标记已读」+ 打开的信封（`MailOpen`）；已读 → 「标记未读」+ 信封（`Mail`）。
 *
 * 抽取成纯函数的唯一目的是让「文案 / 图标 / 目标状态」与「方向 → 宿主入口」可被单测锁死。
 *
 * 判据是**用户能看到的未读状态**（`isSessionVisiblyUnread`）：持久化字段
 * `AgentSessionMeta.completedButUnconfirmed` **∪** 渲染层未读集合里的同名 id。
 * 开启态下两者同源（集合就是持久化字段的派生）；关闭态下绿标/角标看的是内存集合，
 * 只看持久化字段会出现「绿标亮着、菜单却写「标记未读」且点不掉」。
 * 本模块刻意**不接收**侧边栏投影 `indicatorStatus`：该投影优先级为
 * blocked > running > completed（`agent-atoms.ts` 的 `agentSessionIndicatorMapAtom`），
 * 「运行中 / 等待权限且未读」的会话会被显示为 running / blocked，用它当判据会漏掉
 * 需求要求覆盖的区间。
 *
 * 本菜单项**不受「手动确认已读」开关控制**，始终生效（纯 UI 与操作改进）。
 */

/** 菜单文案：未读 → 「标记已读」，已读 → 「标记未读」。 */
export type SessionUnreadMenuLabel = '标记已读' | '标记未读'

/** 图标 token（与文案同判据）。渲染层映射到 lucide 组件：mail→`Mail`，mail-open→`MailOpen`。 */
export type SessionUnreadMenuIcon = 'mail' | 'mail-open'

export interface SessionUnreadMenuInput {
  /** 未读事实源：`AgentSessionMeta.completedButUnconfirmed`。 */
  completedButUnconfirmed?: boolean
  /**
   * 该会话是否在渲染层未读集合（`unviewedCompletedSessionIdsAtom`）里。
   * 关闭态下它就是绿标/角标的判据；开启态下＝持久化字段派生（与上者同源）。
   */
  memoryUnread?: boolean
  /** 渲染层是否拿到切换回调；这是菜单项**唯一**的显示条件（不再受 `canMove` 约束）。 */
  hasToggleHandler: boolean
}

/**
 * 用户能看到的未读状态：持久化字段 ∪ 渲染层未读集合。
 *
 * 菜单文案/图标/目标状态只能用它当判据（绿标在关闭态看内存集合、开启态看持久化派生），
 * 否则会出现「绿标亮但菜单显示「标记未读」」的不同源现象（验收缺陷 F-2）。
 */
export function isSessionVisiblyUnread(
  input: Pick<SessionUnreadMenuInput, 'completedButUnconfirmed' | 'memoryUnread'>,
): boolean {
  return input.completedButUnconfirmed === true || input.memoryUnread === true
}

export interface SessionUnreadMenuItem {
  /** 是否渲染该菜单项。 */
  show: boolean
  /** 文案（与 icon 同判据，不会出现「文案切了但图标没切」）。 */
  label: SessionUnreadMenuLabel
  /** 图标 token（与 label 同判据）。 */
  icon: SessionUnreadMenuIcon
  /** 点击后要写入的目标未读状态；由调用点取反后传给渲染层 handler。 */
  nextUnread: boolean
}

/**
 * 解析侧边栏会话菜单里未读切换项的文案 / 图标 / 目标状态。
 *
 * `show` 只由 `hasToggleHandler` 决定：菜单项在所有状态的会话上都可用
 * （运行中 / 等待权限 / 已归档行同样可切换），只做单条切换、不做批量。
 * 文案、图标、目标状态只由「用户能看到的未读状态」（持久化字段 ∪ 内存集合）决定。
 */
export function resolveSessionUnreadMenuItem(input: SessionUnreadMenuInput): SessionUnreadMenuItem {
  const unread = isSessionVisiblyUnread(input)
  return {
    show: input.hasToggleHandler,
    label: unread ? '标记已读' : '标记未读',
    icon: unread ? 'mail-open' : 'mail',
    nextUnread: !unread,
  }
}

/**
 * 两个方向的宿主入口：都已收敛到未读的唯一写入口
 * `setAgentSessionUnread`（`main/lib/agent-session-ui-projection-publisher.ts`），
 * 复用既有 IPC，**不新增任何 IPC**。
 *
 * - 标记未读 → `SET_COMPLETION_STATE`（`setAgentSessionUnread(id, true)`）
 * - 标记已读 → `CLEAR_COMPLETION_STATE`（`setAgentSessionUnread(id, false, …)`）
 */
export type SessionCompletionStateEntry = 'setAgentCompletionState' | 'clearAgentCompletionState'

/** 目标未读状态 → preload 入口名。 */
export function getSessionCompletionStateEntry(nextUnread: boolean): SessionCompletionStateEntry {
  return nextUnread ? 'setAgentCompletionState' : 'clearAgentCompletionState'
}

/**
 * 把一次单条切换应用到渲染层的内存未读集合（关闭态的显示权威）。
 *
 * 本包与旧插件分支的**唯一差异**：旧分支已删掉内存集合，菜单 handler 不需要写内存；
 * 本包关闭态下内存集合仍是显示权威，因此两个方向都要维护——未读加 id、已读删 id。
 * 两个方向都写、且主进程持久化字段同步写，才能保证菜单文案（持久化字段 ∪ 内存集合）
 * 与被点的那个方向一致，点「标记已读」不会再留下点不掉的绿标（验收缺陷 F-2）。
 * 开启态下这两处写入会被模式感知 atom 的守卫静默丢弃（刻意设计），不破坏
 * 「开启态渲染层不写事实源」的约束。
 *
 * 集合没有实际变化时返回**原引用**，避免无意义的重渲染。
 */
export function applySessionUnreadToMemoryIds(
  previous: ReadonlySet<string>,
  sessionId: string,
  nextUnread: boolean,
): Set<string> {
  if (previous.has(sessionId) === nextUnread) return previous as Set<string>
  const next = new Set(previous)
  if (nextUnread) next.add(sessionId)
  else next.delete(sessionId)
  return next
}
