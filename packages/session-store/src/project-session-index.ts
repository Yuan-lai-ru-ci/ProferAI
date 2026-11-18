import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AgentSessionMeta, AgentWorkspace } from '@profer/shared'
import { isAgentRuntime } from '@profer/shared'
import type { AgentSessionsIndex } from './contracts'
import { assertProjectPathSafe, isProjectSessionsDirSafe, isValidProjectSessionId, projectSessionsDir, resolveProjectSessionDir } from './project-session-paths'

interface ProjectSessionIndex { version: 1; sessions: unknown[] }
const isMeta = (value: unknown): value is AgentSessionMeta => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const meta = value as Partial<AgentSessionMeta>
  return isValidProjectSessionId(meta.id) && typeof meta.title === 'string'
    && typeof meta.createdAt === 'number' && Number.isFinite(meta.createdAt) && meta.createdAt >= 0
    && typeof meta.updatedAt === 'number' && Number.isFinite(meta.updatedAt) && meta.updatedAt >= 0
    && (meta.revision === undefined || (Number.isSafeInteger(meta.revision) && meta.revision >= 0))
    && (meta.agentRuntime === undefined || isAgentRuntime(meta.agentRuntime))
}

/** 只读恢复候选；损坏或未知版本不能视为空列表再覆盖。 */
function readJson(root: string, path: string): unknown {
  let present = false
  for (const candidate of [path, `${path}.tmp`, `${path}.bak`]) {
    assertProjectPathSafe(root, candidate)
    if (!existsSync(candidate)) continue
    present = true
    try { return JSON.parse(readFileSync(candidate, 'utf8').replace(/^\uFEFF/, '')) as unknown } catch { /* 继续读取备份 */ }
  }
  if (present) throw new Error(`项目会话文件损坏，已保留原文件: ${path}`)
  return undefined
}
function readIndex(root: string): ProjectSessionIndex | undefined {
  const value = readJson(root, join(projectSessionsDir(root), 'index.json'))
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || !('sessions' in value) || !Array.isArray(value.sessions)
    || ('version' in value && value.version !== 1)) throw new Error('项目会话索引格式或版本不支持')
  return { version: 1, sessions: value.sessions }
}
function writeJson(root: string, path: string, value: object): void {
  for (const target of [path, `${path}.tmp`]) assertProjectPathSafe(root, target)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(`${path}.tmp`, JSON.stringify(value, null, 2), 'utf8')
  renameSync(`${path}.tmp`, path)
}
function usable(workspace: AgentWorkspace): workspace is AgentWorkspace & { rootPath: string } {
  return workspace.storageMode === 'project' && !!workspace.rootPath && existsSync(workspace.rootPath)
    && isProjectSessionsDirSafe(workspace.rootPath)
}
function entries(workspace: AgentWorkspace): AgentSessionMeta[] {
  if (!usable(workspace)) return []
  const result = new Map<string, AgentSessionMeta>()
  const root = workspace.rootPath
  for (const value of readIndex(root)?.sessions ?? []) {
    if (!isMeta(value)) continue
    resolveProjectSessionDir(root, value.id)
    result.set(value.id, value)
  }
  const directory = projectSessionsDir(root)
  if (!existsSync(directory)) return [...result.values()]
  for (const item of readdirSync(directory, { withFileTypes: true })) {
    if (!item.isDirectory() || !isValidProjectSessionId(item.name)) continue
    const path = join(resolveProjectSessionDir(root, item.name), 'session.json')
    const sidecar = readJson(root, path)
    if (sidecar === undefined && !result.has(item.name)) {
      const messagePath = join(resolveProjectSessionDir(root, item.name), 'messages.jsonl')
      assertProjectPathSafe(root, messagePath)
      if (existsSync(messagePath)) {
        const timestamp = statSync(messagePath).mtimeMs
        result.set(item.name, { id: item.name, title: '恢复的会话', createdAt: timestamp, updatedAt: timestamp,
          workspaceId: workspace.id, storageLayout: 'project', agentRuntimeLocked: true })
      }
      continue
    }
    if (!isMeta(sidecar) || sidecar.id !== item.name) continue
    const previous = result.get(item.name)
    if (!previous || (sidecar.revision ?? 0) > (previous.revision ?? 0)
      || ((sidecar.revision ?? 0) === (previous.revision ?? 0) && sidecar.updatedAt > previous.updatedAt)) result.set(item.name, sidecar)
  }
  return [...result.values()]
}

/** Core运行期索引为权威。仅新绑定项目或启动时恢复；不接管其他项目的同ID会话。 */
export function restoreProjectSessionIndexes(index: AgentSessionsIndex, workspaces: readonly AgentWorkspace[], excluded: ReadonlySet<string> = new Set()): boolean {
  let changed = false
  const byId = new Map(index.sessions.map(session => [session.id, session]))
  for (const workspace of workspaces) for (const value of entries(workspace)) {
    if (excluded.has(value.id)) continue
    const existing = byId.get(value.id)
    if (existing && existing.workspaceId !== workspace.id) {
      console.warn(`[Core] 项目会话ID冲突，保留双方数据: ${value.id}`)
      continue
    }
    // 已有同Core会话不让项目的旧/外部副本改写运行身份。
    if (existing) continue
    const imported: AgentSessionMeta = { ...value, workspaceId: workspace.id, storageLayout: 'project' }
    if (imported.presetReference?.presetScope === 'workspace') imported.presetReference = { ...imported.presetReference, workspaceSlug: workspace.slug }
    // 原机器绝对路径不是授权资源。保留消息但不带着旧机器原生ID盲目resume。
    imported.sdkSessionId = undefined
    imported.piSessionFile = undefined
    imported.piEntryBindings = undefined
    imported.piFileCheckpoints = undefined
    imported.forkSourceDir = undefined
    imported.forkSourceSdkSessionId = undefined
    imported.resumeAtMessageUuid = undefined
    imported.attachedDirectories = undefined
    imported.attachedFiles = undefined
    index.sessions.push(imported)
    byId.set(imported.id, imported)
    changed = true
  }
  return changed
}

/** 保存副本失败必须由调用方报告；不能把项目损坏静默当作空索引覆盖。 */
export function mirrorProjectSessionIndexes(index: AgentSessionsIndex, workspaces: readonly AgentWorkspace[], excludedForWorkspace: (workspaceId: string) => ReadonlySet<string> = () => new Set()): void {
  for (const workspace of workspaces) {
    const excluded = excludedForWorkspace(workspace.id)
    if (!usable(workspace)) continue
    const root = workspace.rootPath
    const prior = readIndex(root)
    const owned = index.sessions.filter(meta => meta.workspaceId === workspace.id && meta.storageLayout === 'project' && !excluded.has(meta.id))
    const ids = new Set(owned.map(meta => meta.id))
    // 保留未导入/冲突/非法条目，供诊断；不以镜像动作抹除用户证据。
    const preserved = (prior?.sessions ?? []).filter(value => !isMeta(value) || (!ids.has(value.id) && !excluded.has(value.id)))
    for (const meta of owned) {
      const path = join(resolveProjectSessionDir(root, meta.id), 'session.json')
      const previous = readJson(root, path)
      if (previous !== undefined && (!isMeta(previous) || previous.id !== meta.id)) throw new Error(`项目会话sidecar身份无效: ${meta.id}`)
      // 只在运行meta尚未取得新原生身份时保留迁入证据。
      // 一旦Core已创建不同原生会话，旧映射/检查点不能混入新身份。
      const preserveNative = previous && isMeta(previous) && meta.sdkSessionId === undefined && previous.sdkSessionId !== undefined
      const portable = preserveNative ? { ...meta,
        sdkSessionId: previous.sdkSessionId,
        piSessionFile: previous.piSessionFile,
        piEntryBindings: previous.piEntryBindings,
        piFileCheckpoints: previous.piFileCheckpoints,
      } : meta
      if (JSON.stringify(previous) !== JSON.stringify(portable)) writeJson(root, path, portable)
    }
    const next = { version: 1, sessions: [...owned, ...preserved] }
    if (JSON.stringify(prior) !== JSON.stringify(next)) writeJson(root, join(projectSessionsDir(root), 'index.json'), next)
  }
}
