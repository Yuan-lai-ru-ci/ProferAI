import { describe, expect, test } from 'bun:test'
import type { AgentSessionMeta, AgentWorkspace } from '@profer/shared'
import { buildPublishableSessionGroups, UNGROUPED_KEY } from './webui-session-picker'

function session(input: Partial<AgentSessionMeta> & Pick<AgentSessionMeta, 'id' | 'title' | 'updatedAt'>): AgentSessionMeta {
  return { createdAt: input.updatedAt, ...input }
}

function workspace(id: string, name: string): AgentWorkspace {
  return { id, name, slug: id, createdAt: 1, updatedAt: 1 }
}

describe('WebUI 发布会话选择器', () => {
  test('Given 已发布、已归档与草稿会话 When 生成候选 Then 只保留可发布的普通会话', () => {
    const groups = buildPublishableSessionGroups({
      sessions: [
        session({ id: 'keep', title: '保留', updatedAt: 1 }),
        session({ id: 'published', title: '已发布', updatedAt: 2 }),
        session({ id: 'archived', title: '已归档', updatedAt: 3, archived: true }),
        session({ id: 'draft', title: '草稿', updatedAt: 4, draft: true }),
      ],
      workspaces: [],
      publishedIds: ['published'],
      query: '',
    })

    expect(groups.flatMap((group) => group.sessions.map((item) => item.id))).toEqual(['keep'])
  })

  test('Given 两个项目 When 生成候选 Then 最近活跃的项目与组内会话都排在前面', () => {
    const groups = buildPublishableSessionGroups({
      sessions: [
        session({ id: 'old', title: '旧会话', updatedAt: 10, workspaceId: 'alpha' }),
        session({ id: 'new', title: '新会话', updatedAt: 30, workspaceId: 'alpha' }),
        session({ id: 'beta', title: 'B 项目会话', updatedAt: 20, workspaceId: 'beta' }),
      ],
      workspaces: [workspace('alpha', 'Alpha 项目'), workspace('beta', 'Beta 项目')],
      publishedIds: [],
      query: '',
    })

    expect(groups.map((group) => group.label)).toEqual(['Alpha 项目', 'Beta 项目'])
    expect(groups[0]?.sessions.map((item) => item.id)).toEqual(['new', 'old'])
  })

  test('Given 搜索关键词 When 命中标题或项目名 Then 只返回匹配分组，且大小写不敏感', () => {
    const sessions = [
      session({ id: 'a', title: '修复登录入口', updatedAt: 1, workspaceId: 'alpha' }),
      session({ id: 'b', title: '无关内容', updatedAt: 2, workspaceId: 'beta' }),
    ]
    const workspaces = [workspace('alpha', 'Alpha 项目'), workspace('beta', 'Beta 项目')]

    expect(buildPublishableSessionGroups({ sessions, workspaces, publishedIds: [], query: '登录' })[0]?.key).toBe('alpha')
    expect(buildPublishableSessionGroups({ sessions, workspaces, publishedIds: [], query: 'beta' })[0]?.key).toBe('beta')
    expect(buildPublishableSessionGroups({ sessions, workspaces, publishedIds: [], query: '不存在' })).toEqual([])
  })

  test('Given 会话没有工作区或工作区已不存在 When 分组 Then 分别落到「未归属项目」与「未知项目」', () => {
    const groups = buildPublishableSessionGroups({
      sessions: [
        session({ id: 'orphan', title: '无项目', updatedAt: 2 }),
        session({ id: 'lost', title: '项目已删', updatedAt: 1, workspaceId: 'gone' }),
      ],
      workspaces: [],
      publishedIds: [],
      query: '',
    })

    expect(groups.map((group) => [group.key, group.label])).toEqual([
      [UNGROUPED_KEY, '未归属项目'],
      ['gone', '未知项目'],
    ])
  })
})
