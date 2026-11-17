/**
 * 「发布会话」选择器的纯计算层：过滤、搜索、按项目分组与排序。
 *
 * 设置页只负责把结果画出来。把这些规则放在这里，才能在 bun:test 里直接断言
 * 「已发布/归档/草稿不出现」「项目按最近活跃排序」「搜索能命中标题」，
 * 而不是靠一张截图去猜。
 */
import type { AgentSessionMeta, AgentWorkspace } from '@profer/shared'

export interface PublishableSessionGroup {
  /** 分组键：工作区 ID；未归属会话用 UNGROUPED_KEY */
  key: string
  label: string
  /** 组内按最近活跃倒序 */
  sessions: AgentSessionMeta[]
}

export const UNGROUPED_KEY = '__ungrouped__'

export interface PublishableSessionGroupsInput {
  sessions: readonly AgentSessionMeta[]
  workspaces: readonly AgentWorkspace[]
  publishedIds: readonly string[]
  query: string
}

/**
 * 生成「可以发布」的会话分组。
 *
 * 排序规则：
 * - 组内：最近活跃（updatedAt）优先；
 * - 组间：取组内最新的一条比较，让刚用过的项目排在最前面；
 * - 并列时按项目名排序，保证列表稳定，不会因为 Map 顺序而抖动。
 */
export function buildPublishableSessionGroups({
  sessions,
  workspaces,
  publishedIds,
  query,
}: PublishableSessionGroupsInput): PublishableSessionGroup[] {
  const published = new Set(publishedIds)
  const workspaceNames = new Map(workspaces.map((workspace) => [workspace.id, workspace.name]))
  const keyword = query.trim().toLowerCase()
  const groups = new Map<string, PublishableSessionGroup>()

  for (const session of sessions) {
    if (published.has(session.id) || session.archived || session.draft) continue
    const workspaceId = session.workspaceId ?? ''
    const workspaceName = workspaceId ? workspaceNames.get(workspaceId) ?? '' : ''
    const title = session.title || session.id
    if (
      keyword
      && !title.toLowerCase().includes(keyword)
      && !workspaceName.toLowerCase().includes(keyword)
    ) continue

    const key = workspaceId || UNGROUPED_KEY
    const label = workspaceId ? workspaceName || '未知项目' : '未归属项目'
    let group = groups.get(key)
    if (!group) {
      group = { key, label, sessions: [] }
      groups.set(key, group)
    }
    group.sessions.push(session)
  }

  const result = [...groups.values()]
  for (const group of result) {
    group.sessions.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
  }
  result.sort((a, b) => {
    const newestA = a.sessions[0]?.updatedAt ?? 0
    const newestB = b.sessions[0]?.updatedAt ?? 0
    return newestB - newestA || a.label.localeCompare(b.label, 'zh-Hans-CN')
  })
  return result
}
