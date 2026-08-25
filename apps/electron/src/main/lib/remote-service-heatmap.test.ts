import { describe, expect, test } from 'bun:test'
import { validateWorkspaceHeatmapRequest } from './remote-service'

describe('get_workspace_heatmap_daily 请求校验', () => {
  test('仅接受非空字符串 workspaceId', () => {
    expect(validateWorkspaceHeatmapRequest('workspace-1')).toBeNull()
    expect(validateWorkspaceHeatmapRequest('  ')).toBe('缺少 workspaceId')
    expect(validateWorkspaceHeatmapRequest('')).toBe('缺少 workspaceId')
    expect(validateWorkspaceHeatmapRequest(undefined)).toBe('缺少 workspaceId')
    expect(validateWorkspaceHeatmapRequest(42)).toBe('缺少 workspaceId')
  })
})
