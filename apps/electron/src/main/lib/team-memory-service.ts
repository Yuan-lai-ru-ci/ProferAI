import { fetch as undiciFetch } from 'undici'
import { getTeamAuth, refreshAuthToken } from './auth-service'
import type { TeamMemoryApiResult, TeamMemoryDocument, TeamMemoryRevision } from '@profer/shared'

async function teamMemoryFetch(path: string, options: RequestInit = {}): Promise<Response | null> {
  let auth = getTeamAuth()
  if (!auth) { await refreshAuthToken().catch(() => {}); auth = getTeamAuth() }
  if (!auth) return null
  const request = (current: typeof auth) => (undiciFetch as unknown as typeof fetch)(`${current.baseUrl}${path}`, { ...options, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${current.token}`, ...(options.headers as Record<string, string>) } })
  let response = await request(auth)
  if (response.status !== 401) return response
  if (await refreshAuthToken()) { const refreshed = getTeamAuth(); if (refreshed) response = await request(refreshed) }
  return response
}
async function request<T>(path: string, options?: RequestInit): Promise<TeamMemoryApiResult<T>> {
  try {
    const response = await teamMemoryFetch(path, options)
    if (!response) return { ok: false, error: '未登录' }
    const data = await response.json().catch(() => ({})) as T & { error?: string; code?: string; current?: TeamMemoryDocument }
    if (response.ok) return { ok: true, status: response.status, data }
    return data.code === 'TEAM_MEMORY_VERSION_CONFLICT' && data.current
      ? { ok: false, status: response.status, error: data.error || '团队记忆已被修改', conflict: { code: 'TEAM_MEMORY_VERSION_CONFLICT', current: data.current } }
      : { ok: false, status: response.status, error: data.error || '请求失败' }
  } catch { return { ok: false, error: '网络请求失败' } }
}
export const listTeamMemories = (workspaceId: string, includeArchived = false) => request<Omit<TeamMemoryDocument, 'content'>[]>(`/v1/workspaces/${workspaceId}/memories?includeArchived=${includeArchived}`)
export const readTeamMemory = (workspaceId: string, memoryId: string) => request<TeamMemoryDocument>(`/v1/workspaces/${workspaceId}/memories/${memoryId}`)
export const createTeamMemory = (workspaceId: string, input: { path: string; title: string; content: string; changeSummary?: string }) => request<TeamMemoryDocument>(`/v1/workspaces/${workspaceId}/memories`, { method: 'POST', body: JSON.stringify(input) })
export const updateTeamMemory = (workspaceId: string, memoryId: string, input: { expectedVersion: number; path?: string; title?: string; content?: string; changeSummary?: string }) => request<TeamMemoryDocument>(`/v1/workspaces/${workspaceId}/memories/${memoryId}`, { method: 'PATCH', body: JSON.stringify(input) })
export const listTeamMemoryRevisions = (workspaceId: string, memoryId: string) => request<TeamMemoryRevision[]>(`/v1/workspaces/${workspaceId}/memories/${memoryId}/revisions`)
export const archiveTeamMemory = (workspaceId: string, memoryId: string, archived: boolean) => request<TeamMemoryDocument>(`/v1/workspaces/${workspaceId}/memories/${memoryId}/${archived ? 'archive' : 'unarchive'}`, { method: 'POST' })
