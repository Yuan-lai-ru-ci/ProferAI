/**
 * 会话未读的宿主策略（纯函数，无 Electron / 无 IO，便于单测）。
 *
 * 两种模式共用同一条代码路径，由 `mode` 入参分支（`main/lib/agent-unread-mode.ts` 提供当前值）：
 *
 * - `'auto'`＝**关闭态**，即既有行为（现在 `main` 的行为），逐点保真：
 *   - 任意桌面 run 启动即清未读（＝原 `runAgent()` 开头的无条件写 `false`）；
 *   - 主进程**不产生**未读（完成类未读由渲染层按「完成时用户是否在该会话」判定后写内存集合）；
 *   - 归档**不碰**未读（归档与已读无关）。
 * - `'manual'`＝**开启态**（`requirements.md` §3.2）：已读需用户显式确认。
 *   - 只有**用户自己发起**的运行在启动时清未读（用户开了新一轮，旧未读自然失效）；
 *   - 队列续跑 / 定时自动化 / 外部 IM / Goal 循环完成时照常产生未读，但**不清**既有未读；
 *   - 委派子会话完成**不产生**未读——子会话是父会话一次工具调用的产物；
 *   - 运行中 / 失败结束仍需手动确认（失败不自动已读）；
 *   - 后台任务续轮（`backgroundTasksPending`）不算「一轮完成」，不产生未读（保留既有口径）；
 *   - 归档视作已读，未读与角标一并清空。
 *
 * **为什么用模式入参而不是「老代码 / 新代码」双分支**：双分支会让关闭态变成一条无人测试的
 * 路径。用模式入参后两种模式共用同一实现，关闭态分支由单测第 1 组锁定，开启态由第 2 组锁定。
 *
 * 「委派子会话」的判据是会话元数据的 `delegationDepth > 0`（子会话创建时写死为父深度 +1），
 * 而不是 `initiator === 'delegation'`：父会话的自动续跑同样以 headless `source: 'delegation'`
 * 启动（`agent-collaboration-tools.ts` 的 `scheduleParentAutoContinuation`），但它产生的是
 * 父会话自己的一轮，按开启态口径必须产生未读。用结构字段判定才能同时满足两条口径。
 */

import type { AgentRunInitiator, AgentSessionMeta } from '@profer/shared'

/** 未读策略模式：`auto`＝关闭态（既有行为），`manual`＝开启态（手动确认）。 */
export type AgentUnreadPolicyMode = 'auto' | 'manual'

export interface AgentCompletionUnreadInput {
  /** 规范化发起者（`AgentSendInput.initiator` 或 `resolveRunInitiator` 的结果） */
  initiator: AgentRunInitiator
  /** 会话元数据的委派深度；委派子会话 > 0 */
  delegationDepth?: number | null
  /** 本轮主体结束但仍有后台任务在飞行（续轮，不算完整一轮） */
  backgroundTasksPending?: boolean
  /** run 是否真的启动过；`false` 表示请求被拒或启动前失败，从未成为一轮 */
  started?: boolean
}

/**
 * run 真正进入运行（`onRunStarted`）时是否清除未读。
 *
 * - 关闭态：**恒 true**，等价于既有实现「任意 run 启动即写 `completedButUnconfirmed = false`」。
 * - 开启态：**只有用户自己发起的运行**才清。
 */
export function shouldClearSessionUnreadOnRunStart(
  initiator: AgentRunInitiator,
  mode: AgentUnreadPolicyMode,
): boolean {
  if (mode === 'auto') return true
  return initiator === 'user'
}

/**
 * 一轮 run 到达终态（完成 / 失败 / 用户停止）时是否写入未读。
 *
 * - 关闭态：**恒 false**。完成类未读在关闭态由渲染层按「完成时用户不在该会话」写入内存集合
 *   （`renderer/lib/agent-completion-presence.ts` + `useGlobalAgentListeners`），主进程不参与。
 * - 开启态：任何一轮完成都写，除非：从未启动 / 后台任务续轮 / 委派子会话。
 */
export function shouldMarkSessionUnreadOnCompletion(
  input: AgentCompletionUnreadInput,
  mode: AgentUnreadPolicyMode,
): boolean {
  if (mode === 'auto') return false
  if (input.started === false) return false
  if (input.backgroundTasksPending === true) return false
  if ((input.delegationDepth ?? 0) > 0) return false
  return true
}

/** 归档切换时要一并写入的字段。 */
export type ArchiveToggleUpdates = Partial<
  Pick<AgentSessionMeta, 'archived' | 'pinned' | 'completedButUnconfirmed'>
>

/**
 * 归档切换（桌面 `TOGGLE_ARCHIVE` 与移动通道 `toggle_session_archive` 共用）。
 *
 * - 关闭态：只切 `archived`（并沿用既有「归档自动取消置顶」），**不碰未读**（保真 M6）。
 * - 开启态：归档视作已读，未读与角标一并清空。
 *
 * 解归档两个模式都不反向置未读：用户主动把会话拉回列表，不需要额外待办。
 */
export function buildArchiveToggleUpdates(
  input: { archived: boolean; pinned: boolean; completedButUnconfirmed: boolean },
  mode: AgentUnreadPolicyMode,
): ArchiveToggleUpdates {
  const nextArchived = !input.archived
  const updates: ArchiveToggleUpdates = { archived: nextArchived }
  // 归档时自动取消置顶（既有行为，两个模式一致）
  if (nextArchived && input.pinned) updates.pinned = false
  // 归档视作已读：未读与任务栏角标一并清空（仅开启态）
  if (mode === 'manual' && nextArchived && input.completedButUnconfirmed) {
    updates.completedButUnconfirmed = false
  }
  return updates
}
