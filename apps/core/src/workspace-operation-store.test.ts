import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CoreWorkspaceOperationStore } from './workspace-operation-store'

test('工作区删除账本拒绝重复/错归属快照和路径身份，损坏文件不覆盖', () => {
  const root = mkdtempSync(join(tmpdir(), 'profer-workspace-operation-schema-'))
  const path = join(root, 'operations.json')
  try {
    const store = new CoreWorkspaceOperationStore(path)
    const workspace = { id: 'workspace', name: 'Fixture', slug: 'fixture', storageMode: 'managed' as const, createdAt: 1, updatedAt: 1 }
    const sessions = [{ id: 'one', title: 'One', workspaceId: workspace.id, createdAt: 1, updatedAt: 1 }, { id: 'two', title: 'Two', workspaceId: workspace.id, createdAt: 1, updatedAt: 1 }]
    const operation = store.begin(workspace, sessions, [], [], 1, 'operation')
    const variants = [
      { ...operation, workspace: { ...workspace, slug: '../escape' } },
      { ...operation, sessionSnapshots: [sessions[0], sessions[0]] },
      { ...operation, sessionSnapshots: [{ ...sessions[0], workspaceId: 'another' }, sessions[1]] },
      { ...operation, sessionDeletionRequests: [{ rootSessionId: 'one', requestId: 'delete', sessionIds: ['one', 'one'] }] },
      { ...operation, sessionDeletionRequests: [{ rootSessionId: 'one', requestId: 'delete', sessionIds: ['two'] }] },
      { ...operation, sessionDeletionRequests: [{ rootSessionId: 'one', requestId: 'delete', sessionIds: ['one'] }, { rootSessionId: 'two', requestId: 'delete', sessionIds: ['two'] }] },
    ]
    for (const variant of variants) {
      const raw = JSON.stringify({ version: 1, operations: [variant] })
      writeFileSync(path, raw)
      expect(() => new CoreWorkspaceOperationStore(path)).toThrow('无效')
      expect(readFileSync(path, 'utf8')).toBe(raw)
    }
    expect(() => store.begin({ ...workspace, id: 'different', slug: '../escape' }, [], [], [])).toThrow('无效')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
