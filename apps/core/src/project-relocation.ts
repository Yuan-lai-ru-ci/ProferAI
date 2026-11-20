import { existsSync, readFileSync, statSync, readdirSync, lstatSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { AgentSessionMeta, AgentWorkspace } from '@profer/shared'
import { assertProjectPathSafe, resolveProjectSessionDir } from '@profer/session-store/project-session-paths'

/** 旧根仍存在时逐文件比对，只读验证附件、任务图、Harness与rewind资产已一起移动。 */
function assertMatchingTree(oldRoot: string, newRoot: string, oldPath: string, newPath: string): void {
  assertProjectPathSafe(oldRoot, oldPath)
  assertProjectPathSafe(newRoot, newPath)
  const source = lstatSync(oldPath)
  if (source.isSymbolicLink()) throw new Error('旧会话资产含符号链接，需先完成原生会话迁移')
  if (!existsSync(newPath) || lstatSync(newPath).isSymbolicLink()) throw new Error('目标项目缺少或含不安全会话资产')
  if (source.isDirectory()) {
    if (!statSync(newPath).isDirectory()) throw new Error('目标会话资产类型冲突')
    for (const item of readdirSync(oldPath)) {
      // sidecar由Core元数据负责；其余资产逐字节验证，不以消息存在替代完整性。
      if (item === 'session.json') continue
      assertMatchingTree(oldRoot, newRoot, join(oldPath, item), join(newPath, item))
    }
  } else if (!source.isFile() || !statSync(newPath).isFile() || !readFileSync(oldPath).equals(readFileSync(newPath))) {
    throw new Error('新旧会话历史冲突或会话资产不完整，保留原绑定')
  }
}

/** 重新定位只换绑定：先证明消息已随目录移动，不能创建空历史或覆写冲突副本。 */
export function assertProjectRelocationHistory(workspace: AgentWorkspace, root: string, sessions: readonly AgentSessionMeta[]): void {
  const owned = new Map(sessions.filter(item => item.workspaceId === workspace.id).map(item => [item.id, item]))
  const assertIdentity = (value: unknown, expectedId?: string) => {
    if (!value || typeof value !== 'object' || !('id' in value) || typeof value.id !== 'string'
      || (expectedId !== undefined && value.id !== expectedId)) throw new Error('目标项目会话身份无效')
    const meta = owned.get(value.id)
    if (!meta) {
      if (sessions.some(session => session.id === value.id)) throw new Error('目标项目会话ID已属于另一工作区')
      return
    }
    const candidate = value as Partial<AgentSessionMeta>
    if ((candidate.workspaceId !== undefined && candidate.workspaceId !== workspace.id)
      || (candidate.agentRuntime !== undefined && candidate.agentRuntime !== meta.agentRuntime)
      || (candidate.sdkSessionId !== undefined && candidate.sdkSessionId !== meta.sdkSessionId)
      || (candidate.revision ?? 0) > (meta.revision ?? 0)) throw new Error(`目标会话身份冲突：${meta.id}`)
  }
  const indexPath = join(root, '.profer', 'sessions', 'index.json')
  assertProjectPathSafe(root, indexPath)
  for (const path of [indexPath, `${indexPath}.tmp`, `${indexPath}.bak`]) {
    assertProjectPathSafe(root, path)
    if (!existsSync(path)) continue
    const value: unknown = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''))
    if (!value || typeof value !== 'object' || !('sessions' in value) || !Array.isArray(value.sessions)
      || ('version' in value && value.version !== 1)) throw new Error('目标项目会话索引无效，保留原绑定')
    for (const entry of value.sessions) assertIdentity(entry)
  }
  const sameRoot = workspace.rootPath && resolve(workspace.rootPath) === resolve(root)
  for (const meta of sessions.filter(item => item.workspaceId === workspace.id)) {
    if (meta.storageLayout === 'managed') continue
    const target = resolveProjectSessionDir(root, meta.id)
    const old = workspace.rootPath ? resolveProjectSessionDir(workspace.rootPath, meta.id) : undefined
    const targetMessages = join(target, 'messages.jsonl')
    const oldMessages = old ? join(old, 'messages.jsonl') : undefined
    assertProjectPathSafe(root, targetMessages)
    const sidecar = join(target, 'session.json')
    assertProjectPathSafe(root, sidecar)
    if (existsSync(sidecar)) {
      const value: unknown = JSON.parse(readFileSync(sidecar, 'utf8').replace(/^\uFEFF/, ''))
      assertIdentity(value, meta.id)
    }
    if (sameRoot) continue
    // 显式 project 布局，或旧目录已有历史时，必须在新根找到相同会话的历史。
    const needsHistory = meta.storageLayout === 'project' || Boolean(oldMessages && existsSync(oldMessages))
    if (needsHistory && (!existsSync(targetMessages) || !statSync(targetMessages).isFile())) {
      // 未发过消息的草稿可无messages文件，但必须有同身份的sidecar证明数据目录已移动。
      if (!meta.draft || !existsSync(sidecar) || (oldMessages && existsSync(oldMessages))) throw new Error(`目标项目缺少会话历史：${meta.id}；请先完整移动项目数据`)
    }
    if (old && existsSync(old)) assertMatchingTree(workspace.rootPath!, root, old, target)
    if (workspace.rootPath) {
      const oldRewind = join(workspace.rootPath, '.profer', 'rewind', meta.id)
      if (existsSync(oldRewind)) assertMatchingTree(workspace.rootPath, root, oldRewind, join(root, '.profer', 'rewind', meta.id))
    }
    if ((meta.sdkSessionId || meta.forkSourceSdkSessionId) && (meta.agentRuntime ?? 'claude') === 'claude') throw new Error(`Claude会话需要原生恢复迁移后才能重新定位：${meta.id}`)
    // 不改写原生身份或猜测旧绝对路径。迁移原生资产是独立流程。
    for (const path of [meta.piSessionFile, meta.forkSourceDir, ...Object.values(meta.piFileCheckpoints ?? {})]) {
      if (path && !existsSync(path)) throw new Error(`会话原生恢复资产不可用：${meta.id}；需先完成原生会话迁移`)
    }
  }
}
