import { describe, expect, mock, test } from 'bun:test'

const workspaces = new Map<string, { id: string; type: 'personal' | 'team' }>([
  ['personal-1', { id: 'personal-1', type: 'personal' }],
  ['team-1', { id: 'team-1', type: 'team' }],
])
const sessions = [
  { id: 'session-1', workspaceId: 'personal-1', createdAt: 1, updatedAt: 2, archived: false },
  { id: 'session-2', workspaceId: 'personal-1', createdAt: 3, updatedAt: 4, archived: true },
  { id: 'session-3', workspaceId: 'other', createdAt: 5, updatedAt: 6, archived: false },
]
const heatmap = [{ date: '2026-08-21', tokens: 42 }]

mock.module('./agent-session-manager', () => ({
  listAgentSessions: () => sessions,
}))
mock.module('./agent-workspace-manager', () => ({
  getAgentWorkspace: (id: string) => workspaces.get(id),
}))
mock.module('./workspace-heatmap-service', () => ({
  getWorkspaceHeatmapDaily: (workspaceId: string, selectedSessions: unknown[]) => {
    expect(workspaceId).toBe('personal-1')
    expect(selectedSessions).toEqual([
      { id: 'session-1', createdAt: 1, updatedAt: 2, archived: false },
      { id: 'session-2', createdAt: 3, updatedAt: 4, archived: true },
    ])
    return heatmap
  },
}))

import { loadWorkspaceHeatmapDaily } from './workspace-heatmap-query'

describe('工作区热力图查询 facade', () => {
  test('普通工作区筛选会话后复用既有聚合服务', () => {
    expect(loadWorkspaceHeatmapDaily('personal-1')).toEqual(heatmap)
  })

  test('不存在或 team 工作区返回空数组', () => {
    expect(loadWorkspaceHeatmapDaily('missing')).toEqual([])
    expect(loadWorkspaceHeatmapDaily('team-1')).toEqual([])
  })
})
