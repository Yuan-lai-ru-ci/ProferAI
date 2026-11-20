import { existsSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { AgentSessionMeta, AgentWorkspace } from '@profer/shared'
import { registerSessionStorageLayout, type SessionStorageLayout } from './session-layout'
import { resolveProjectSessionDir, assertProjectPathSafe } from './project-session-paths'

/** 只读判定既有布局，不搬文件、不补写metadata；缺失的显式项目路径不回落中央目录。 */
export function resolveOwnedSessionLayout(meta: Pick<AgentSessionMeta, 'id' | 'workspaceId' | 'storageLayout'>, workspace: AgentWorkspace | undefined): SessionStorageLayout {
  if (meta.workspaceId && !workspace) throw new Error('会话工作区不存在，不能读取替代目录')
  if (workspace?.storageMode !== 'project') {
    if (meta.storageLayout === 'project') throw new Error('项目会话缺少项目工作区')
    return { kind: 'managed' }
  }
  if (!workspace.rootPath || !isAbsolute(workspace.rootPath) || !existsSync(workspace.rootPath) || !statSync(workspace.rootPath).isDirectory()) throw new Error('项目会话根目录不可用')
  const dataDir = resolveProjectSessionDir(workspace.rootPath, meta.id)
  const messagePath = join(dataDir, 'messages.jsonl')
  assertProjectPathSafe(workspace.rootPath, messagePath)
  if (meta.storageLayout === 'managed') return { kind: 'managed' }
  return meta.storageLayout === 'project' || existsSync(messagePath) ? { kind: 'project', dataDir } : { kind: 'managed' }
}
export function registerOwnedSessionLayout(meta: Pick<AgentSessionMeta, 'id' | 'workspaceId' | 'storageLayout'>, workspace: AgentWorkspace | undefined): void {
  registerSessionStorageLayout(meta.id, resolveOwnedSessionLayout(meta, workspace))
}
