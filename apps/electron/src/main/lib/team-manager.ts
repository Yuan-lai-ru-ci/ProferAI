/**
 * 团队管理器
 *
 * 负责团队工作区的远程 CRUD、邀请管理、成员管理和 ownership 转让。
 * 操作通过远程 API 执行，本地维护镜像。
 */

import { randomUUID } from 'node:crypto'
import { fetch as undiciFetch } from 'undici'
import { getTeamAuth, refreshAuthToken } from './auth-service'
import { readIndex, writeIndex, ensurePluginManifest } from './agent-workspace-manager'
import { getAgentWorkspacePath } from './config-paths'
import { enqueueChange } from './sync-manager'
import type { AgentWorkspace, WorkspaceRole } from '@proma/shared'

/** 带认证的 fetch 封装（token 过期自动刷新重试） */
async function authedFetch(
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  let auth = getTeamAuth()
  // token 过期时先尝试刷新
  if (!auth) {
    await refreshAuthToken().catch(() => {})
    auth = getTeamAuth()
  }
  if (!auth) throw new Error('未登录')

  const doFetch = (t: typeof auth) =>
    (undiciFetch as unknown as typeof fetch)(`${t.baseUrl}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${t.token}`,
        ...(options.headers as Record<string, string>),
      },
    })

  const res = await doFetch(auth)
  if (res.status !== 401) return res

  // 401 → 尝试刷新令牌后重试一次
  const refreshed = await refreshAuthToken()
  if (refreshed) {
    const auth2 = getTeamAuth()
    if (auth2 && auth2.token !== auth.token) {
      return doFetch(auth2)
    }
  }

  return res
}

// ===== 团队工作区 CRUD =====

/** 列出当前用户的团队工作区（远程） */
export async function listTeamWorkspaces(): Promise<AgentWorkspace[]> {
  try {
    const res = await authedFetch('/v1/workspaces')
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return (await res.json()) as AgentWorkspace[]
  } catch (err) {
    console.error('[团队] 列出团队工作区失败:', err)
    return []
  }
}

/** 创建团队工作区 */
export async function createTeamWorkspace(name: string): Promise<AgentWorkspace> {
  // 1. 远程创建
  const res = await authedFetch('/v1/workspaces', {
    method: 'POST',
    body: JSON.stringify({ name }),
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`创建失败: ${body}`)
  }

  const remote = (await res.json()) as AgentWorkspace

  // 2. 本地创建镜像
  const slug = remote.slug || `team-${remote.id.slice(0, 8)}`

  // 直接写入索引（复用 workspace-manager 的底层）
  const index = readIndex()
  const workspace: AgentWorkspace = {
    ...remote,
    slug,
    type: 'team',
  }
  index.workspaces.unshift(workspace)
  writeIndex(index)

  // 创建工作区目录
  getAgentWorkspacePath(slug)

  // 3. 入队同步
  enqueueChange(workspace.id, 'workspace', workspace.id, 'create', workspace)

  console.log(`[团队] 已创建团队工作区: ${name}`)
  return workspace
}

/** 删除团队工作区 */
export async function deleteTeamWorkspace(workspaceId: string): Promise<void> {
  // 1. 远程删除
  await authedFetch(`/v1/workspaces/${workspaceId}`, { method: 'DELETE' })

  // 2. 本地标记删除
  const index = readIndex()
  const idx = index.workspaces.findIndex((w) => w.id === workspaceId)
  if (idx !== -1) {
    index.workspaces[idx] = { ...index.workspaces[idx]!, isDeleted: true }
    writeIndex(index)
  }

  enqueueChange(workspaceId, 'workspace', workspaceId, 'delete', {})
  console.log(`[团队] 已删除团队工作区: ${workspaceId}`)
}

// ===== 成员管理 =====

/** 获取工作区成员列表 */
export async function getMembers(workspaceId: string): Promise<unknown[]> {
  try {
    const res = await authedFetch(`/v1/workspaces/${workspaceId}/members`)
    if (!res.ok) return []
    return (await res.json()) as unknown[]
  } catch {
    return []
  }
}

/** 邀请成员 */
export async function createInvitation(input: {
  workspaceId: string
  email?: string
  role: string
}): Promise<unknown> {
  const res = await authedFetch(
    `/v1/workspaces/${input.workspaceId}/members`,
    {
      method: 'POST',
      body: JSON.stringify({
        email: input.email,
        role: input.role,
      }),
    },
  )

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`邀请失败: ${body}`)
  }

  return res.json()
}

/** 更新成员角色 */
export async function updateMemberRole(
  workspaceId: string,
  userId: string,
  role: string,
): Promise<void> {
  await authedFetch(
    `/v1/workspaces/${workspaceId}/members/${userId}`,
    {
      method: 'PATCH',
      body: JSON.stringify({ role }),
    },
  )
}

/** 移除成员 */
export async function removeMember(
  workspaceId: string,
  userId: string,
): Promise<void> {
  await authedFetch(
    `/v1/workspaces/${workspaceId}/members/${userId}`,
    { method: 'DELETE' },
  )
}

/** 退出工作区 */
export async function leaveWorkspace(workspaceId: string): Promise<void> {
  // 远程移除自己
  await authedFetch(`/v1/workspaces/${workspaceId}/leave`, {
    method: 'POST',
  })

  // 本地清理
  const index = readIndex()
  const idx = index.workspaces.findIndex((w) => w.id === workspaceId)
  if (idx !== -1) {
    index.workspaces[idx] = { ...index.workspaces[idx]!, isDeleted: true }
    writeIndex(index)
  }

  console.log(`[团队] 已退出工作区: ${workspaceId}`)
}

/** 转让 ownership */
export async function transferOwnership(
  workspaceId: string,
  targetUserId: string,
): Promise<void> {
  await authedFetch(`/v1/workspaces/${workspaceId}/transfer-ownership`, {
    method: 'POST',
    body: JSON.stringify({ targetUserId }),
  })

  // 更新本地角色
  const index = readIndex()
  const idx = index.workspaces.findIndex((w) => w.id === workspaceId)
  if (idx !== -1) {
    index.workspaces[idx] = {
      ...index.workspaces[idx]!,
      role: 'admin' as WorkspaceRole,
    }
    writeIndex(index)
  }

  console.log(`[团队] 已将 ${workspaceId} 的 ownership 转让给 ${targetUserId}`)
}

// ===== 邀请操作 =====

/** 验证邀请 token */
export async function verifyInvitation(token: string): Promise<{
  workspaceName: string; inviterName: string; role: string; valid: boolean
}> {
  const auth = getTeamAuth()
  const baseUrl = auth?.baseUrl ?? ''
  const res = await (undiciFetch as unknown as typeof fetch)(`${baseUrl}/v1/invitations/${token}`)
  if (!res.ok) throw new Error('邀请链接无效或已过期')
  return res.json() as any
}

/** 接受邀请 */
export async function acceptInvitation(token: string): Promise<AgentWorkspace> {
  const auth = getTeamAuth()
  if (!auth) throw new Error('请先登录')

  const res = await (undiciFetch as unknown as typeof fetch)(
    `${auth.baseUrl}/v1/invitations/${token}/accept`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${auth.token}`,
      },
    },
  )

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`加入失败: ${body}`)
  }

  const remote = (await res.json()) as any
  const now = Date.now()
  const workspace: AgentWorkspace = {
    id: remote.id,
    name: remote.name,
    slug: remote.slug || `team-${remote.id.slice(0, 8)}`,
    type: 'team',
    role: remote.role,
    createdAt: remote.createdAt ?? now,
    updatedAt: remote.updatedAt ?? now,
  }

  // 本地镜像
  const index = readIndex()
  index.workspaces.unshift(workspace)
  writeIndex(index)
  getAgentWorkspacePath(workspace.slug)

  return workspace
}

/** 拒绝邀请 */
export async function declineInvitation(token: string): Promise<void> {
  const auth = getTeamAuth()
  const baseUrl = auth?.baseUrl ?? ''
  const res = await (undiciFetch as unknown as typeof fetch)(`${baseUrl}/v1/invitations/${token}/decline`, { method: 'POST' })
  if (!res.ok) throw new Error('操作失败')
}

/** 取消邀请 */
export async function cancelInvitation(workspaceId: string, invitationId: string): Promise<void> {
  const res = await authedFetch(
    `/v1/workspaces/${workspaceId}/invitations/${invitationId}`,
    { method: 'DELETE' },
  )
  if (!res.ok) {
    const body = await res.text()
    throw new Error(body ? JSON.parse(body).error : '取消邀请失败')
  }
}

/** 列出工作区的所有邀请 */
export async function listInvitations(workspaceId: string): Promise<Array<{
  id: string
  workspaceId: string
  inviterId: string
  inviterName: string
  inviteeEmail: string
  role: string
  token: string
  status: string
  createdAt: number
  expiresAt: number
}>> {
  try {
    const res = await authedFetch(`/v1/workspaces/${workspaceId}/invitations`)
    if (!res.ok) return []
    return (await res.json()) as any[]
  } catch {
    return []
  }
}

/** 获取工作区使用统计 */
export async function getWorkspaceStats(workspaceId: string): Promise<{
  totalSize: number; fileCount: number; dirCount: number; memberCount: number; onlineCount: number; pendingInvites: number
} | null> {
  try {
    const res = await authedFetch(`/v1/workspaces/${workspaceId}/stats`)
    if (!res.ok) return null
    return (await res.json()) as any
  } catch {
    return null
  }
}
