/**
 * agent-workspace-selection — 「新建 Agent 会话该落到哪个工作区」的唯一判定。
 *
 * 背景：多个入口（欢迎对话切 Agent、Chat 内推荐横幅、新建会话）都曾用
 * `workspaces[0]` 当默认值。索引里的第一个工作区可能已被收纳（archived），
 * 一旦会话绑到收纳工作区，`useOpenSession` 会按可见性拒绝打开，界面表现为
 * 「Agent 没有工作区」——会话其实创建成功，只是永远打不开。
 *
 * 判定顺序（依次取第一个可用项）：
 *  1. 当前工作区（用户此刻就在用，最符合预期）
 *  2. slug === 'default' 的默认工作区（ensureDefaultWorkspace 保证它存在）
 *  3. 列表里第一个可见工作区
 */

import type { AgentWorkspace } from '@profer/shared'
import { isAgentWorkspaceVisible } from './product-feature-flags'

type WorkspaceLike = Pick<AgentWorkspace, 'id' | 'slug' | 'type'> & { archived?: boolean }

export function resolvePreferredAgentWorkspaceId(
  workspaces: readonly WorkspaceLike[],
  currentWorkspaceId?: string | null,
): string | undefined {
  if (currentWorkspaceId) {
    const current = workspaces.find((workspace) => workspace.id === currentWorkspaceId)
    if (current && isAgentWorkspaceVisible(current)) return current.id
  }

  const fallback = workspaces.find((workspace) => workspace.slug === 'default' && isAgentWorkspaceVisible(workspace))
    ?? workspaces.find((workspace) => isAgentWorkspaceVisible(workspace))

  return fallback?.id
}
