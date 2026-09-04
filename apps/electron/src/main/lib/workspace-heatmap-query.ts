import { listAgentSessions } from './agent-session-manager'
import { getAgentWorkspace } from './agent-workspace-manager'
import { getWorkspaceHeatmapDaily, type HeatmapDailyEntry } from './workspace-heatmap-service'

/**
 * 查询普通工作区的每日 Token 消耗。
 * 统一承载 IPC 与远程 WS 的工作区校验、会话筛选和 DTO 映射口径。
 */
export function loadWorkspaceHeatmapDaily(workspaceId: string): HeatmapDailyEntry[] {
  const workspace = getAgentWorkspace(workspaceId)
  if (!workspace || workspace.type === 'team') return []

  const sessions = listAgentSessions(true)
    .filter((session) => session.workspaceId === workspaceId)
    .map((session) => ({
      id: session.id,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      archived: session.archived,
    }))

  return getWorkspaceHeatmapDaily(workspaceId, sessions)
}
