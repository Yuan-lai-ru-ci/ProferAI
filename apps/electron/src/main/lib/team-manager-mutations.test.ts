test('团队读取 HTTP 失败不能伪装成空数据', async () => {
  status = 500
  for (const action of [() => getMembers('fixture'), () => listInvitations('fixture'), () => getWorkspaceStats('fixture')]) {
    await expect(action()).rejects.toThrow('HTTP 500')
  }
})

test('团队读取接受合法空列表，拒绝错误结构', async () => {
  expect(await getMembers('fixture')).toEqual([])
  expect(await listInvitations('fixture')).toEqual([])
  payload = { error: 'fixture-error' }
  await expect(getMembers('fixture')).rejects.toThrow('格式无效')
  await expect(listInvitations('fixture')).rejects.toThrow('格式无效')
  await expect(getWorkspaceStats('fixture')).rejects.toThrow('格式无效')
  const stats = { totalSize: 0, fileCount: 0, dirCount: 0, memberCount: 0, onlineCount: 0, pendingInvites: 0 }
  payload = stats
  expect(await getWorkspaceStats('fixture')).toEqual(stats)
})
import { beforeEach, expect, mock, test } from 'bun:test'
import type { AgentWorkspace } from '@profer/shared'

let status = 200
let writes = 0
let enqueues = 0
let workspaces: AgentWorkspace[] = []
let payload: unknown = []
mock.module('undici', () => ({ fetch: async () => new Response(JSON.stringify(payload), { status }) }))
mock.module('./auth-service', () => ({
  getTeamAuth: () => ({ baseUrl: 'https://fixture.invalid', token: 'fixture-token' }),
  refreshAuthToken: async () => false,
}))
mock.module('./agent-workspace-manager', () => ({
  readIndex: () => ({ workspaces: workspaces.map((value) => ({ ...value })) }),
  writeIndex: (index: { workspaces: AgentWorkspace[] }) => { writes++; workspaces = index.workspaces },
  ensurePluginManifest() {},
}))
mock.module('./config-paths', () => ({ getAgentWorkspacePath: () => '/fixture' }))
mock.module('./sync-manager', () => ({ enqueueChange: () => { enqueues++ } }))
const { deleteTeamWorkspace, leaveWorkspace, transferOwnership, removeMember, updateMemberRole, getMembers, listInvitations, getWorkspaceStats } = await import('./team-manager')

beforeEach(() => {
  payload = []
  status = 200
  writes = 0
  enqueues = 0
  workspaces = [{ id: 'fixture-workspace', name: 'Fixture', slug: 'fixture', type: 'team', role: 'owner', createdAt: 1, updatedAt: 1 }]
})

test('团队 mutation 的 HTTP 失败不更新镜像或同步队列', async () => {
  for (const code of [400, 401, 403, 404, 500]) {
    status = code
    for (const action of [
      () => deleteTeamWorkspace('fixture-workspace'),
      () => leaveWorkspace('fixture-workspace'),
      () => transferOwnership('fixture-workspace', 'fixture-user'),
      () => removeMember('fixture-workspace', 'fixture-user'),
      () => updateMemberRole('fixture-workspace', 'fixture-user', 'member'),
    ]) {
      await expect(action()).rejects.toThrow(`HTTP ${code}`)
      expect(writes).toBe(0)
      expect(enqueues).toBe(0)
      expect(workspaces[0]!.isDeleted).not.toBe(true)
      expect(workspaces[0]!.role).toBe('owner')
    }
  }
})

test('成功删除才提交本地标记与同步记录', async () => {
  await deleteTeamWorkspace('fixture-workspace')
  expect(writes).toBe(1)
  expect(enqueues).toBe(1)
  expect(workspaces[0]!.isDeleted).toBe(true)
})

test('成功转让才更新本地角色', async () => {
  await transferOwnership('fixture-workspace', 'fixture-user')
  expect(workspaces[0]!.role).toBe('admin')
  expect(writes).toBe(1)
})
