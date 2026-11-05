import type { AgentWorkspace } from '@profer/shared'

/** 判断工作区是否进入产品入口；团队工作区已不再是有效的产品类型。 */
export function isAgentWorkspaceVisible(
  workspace: Pick<AgentWorkspace, 'type'> & { archived?: boolean },
): boolean {
  return !workspace.archived
}

export function getVisibleAgentWorkspaces<
  T extends Pick<AgentWorkspace, 'type'> & { archived?: boolean },
>(workspaces: readonly T[]): T[] {
  return workspaces.filter((workspace) => isAgentWorkspaceVisible(workspace))
}

export function isAgentWorkspaceIdVisible(
  workspaceId: string | null | undefined,
  workspaces: readonly (Pick<AgentWorkspace, 'id' | 'type'> & { archived?: boolean })[],
): boolean {
  if (!workspaceId) return true
  const workspace = workspaces.find((item) => item.id === workspaceId)
  return !workspace || isAgentWorkspaceVisible(workspace)
}

/**
 * Goal 跨会话总览入口（规划中心 Goal 分区 + 侧栏 Goal 按钮）。
 *
 * 2026-11 暂不上线：入口藏在 rail 上会把多个会话的目标压成一列，
 * 而 Goal 本身在会话内已经完整可用（`/goal`、顶部状态栏、`/goal status`、通知）。
 * 总览的数据、组件与测试都保留，恢复只需把这个值改成 true。
 *
 * 不受影响：会话内 Goal 执行、状态栏、终态通知、空闲自检、模型提议卡片。
 */
export const GOAL_OVERVIEW_ENTRY_ENABLED = false
