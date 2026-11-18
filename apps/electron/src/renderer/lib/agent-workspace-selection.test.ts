/**
 * agent-workspace-selection 单元测试
 *
 * 固化「新建 Agent 会话落到哪个工作区」的判定顺序。
 *
 * 背景回归：多个入口曾用 `workspaces[0]` 当默认值。索引里首项可能已被收纳
 * （archived），会话绑到收纳工作区后 `useOpenSession` 会按可见性拒绝打开，
 * 界面表现就是「Agent 没有工作区」——而会话其实创建成功了。
 */

import { describe, expect, test } from 'bun:test'
import { resolvePreferredAgentWorkspaceId } from './agent-workspace-selection'

const base = { createdAt: 0, updatedAt: 0 } as const

const ctfArchived = { ...base, id: 'ctf-id', slug: 'ctf', archived: true }
const proferProject = { ...base, id: 'profer-id', slug: 'profer' }
const defaultWorkspace = { ...base, id: 'default-id', slug: 'default' }

describe('resolvePreferredAgentWorkspaceId', () => {
  test('Given 首项已收纳 When 无当前工作区 Then 跳过它，取默认工作区', () => {
    const workspaces = [ctfArchived, proferProject, defaultWorkspace]
    expect(resolvePreferredAgentWorkspaceId(workspaces)).toBe('default-id')
  })

  test('Given 当前工作区可见 When 解析 Then 优先沿用当前工作区', () => {
    const workspaces = [ctfArchived, proferProject, defaultWorkspace]
    expect(resolvePreferredAgentWorkspaceId(workspaces, 'profer-id')).toBe('profer-id')
  })

  test('Given 当前工作区已收纳 When 解析 Then 忽略它并回落到默认工作区', () => {
    const workspaces = [ctfArchived, proferProject, defaultWorkspace]
    expect(resolvePreferredAgentWorkspaceId(workspaces, 'ctf-id')).toBe('default-id')
  })

  test('Given 没有默认工作区 When 解析 Then 取第一个可见工作区', () => {
    const workspaces = [ctfArchived, proferProject]
    expect(resolvePreferredAgentWorkspaceId(workspaces)).toBe('profer-id')
  })

  test('Given 全部已收纳 When 解析 Then 返回 undefined 而不是把收纳工作区交给调用方', () => {
    expect(resolvePreferredAgentWorkspaceId([ctfArchived])).toBeUndefined()
  })

  test('Given 空列表 When 解析 Then 返回 undefined', () => {
    expect(resolvePreferredAgentWorkspaceId([])).toBeUndefined()
  })
})
