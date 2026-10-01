/**
 * 「确认已读」按钮的可见性纯逻辑（核心实现，与插件系统无关）。
 *
 * 位置：该会话**最新一轮 assistant 回复**的操作栏，在「回退到此处」按钮**右侧**。
 * 点击后清掉同一套三处状态（持久化 `completedButUnconfirmed`、侧边栏绿标 / 标签页指示点、
 * 任务栏角标）。
 *
 * 三条硬条件同时成立才渲染：
 * 1. 开关开启（关闭态不渲染、不注册任何新入口）；
 * 2. 该 group 是会话里最后一个 assistant-turn；
 * 3. 该会话存在未读。
 *
 * 「是否最新一轮」不在这里算：它复用 `AgentMessages.tsx` 既有的
 * `allGroups.findLast((g) => g.type === 'assistant-turn')` 判据（与「已被用户中断」badge
 * 同一口径），由调用点算好后传入，避免两处判据漂移。
 */

export interface ConfirmReadButtonVisibilityInput {
  /** 设置里的「手动确认已读」开关（关闭态恒不可见） */
  manualReadConfirmEnabled: boolean
  /** 该 group 是否为会话中最后一个 assistant-turn */
  isLatestAssistantTurn: boolean
  /** 该会话是否存在未读（判据与侧边栏菜单同源：未读集合） */
  sessionUnread: boolean
}

/**
 * 是否渲染「确认已读」按钮。
 *
 * 全条件 fail-closed：任一条件不成立都不渲染。开关关闭时恒为 false —— 这是「关闭态不
 * 引入任何新入口」的硬约束，由单测锁定。
 */
export function shouldShowConfirmReadButton(input: ConfirmReadButtonVisibilityInput): boolean {
  return input.manualReadConfirmEnabled && input.isLatestAssistantTurn && input.sessionUnread
}
