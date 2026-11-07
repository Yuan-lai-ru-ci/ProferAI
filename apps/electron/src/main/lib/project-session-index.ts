/**
 * 项目会话索引（`<root>/.profer/sessions/index.json`）
 *
 * 这是项目文件夹内的会话列表副本，用于：
 * - 项目整体拷走/备份后，在新机器上重新绑定即可恢复会话列表；
 * - 全局索引损坏时作为恢复来源。
 *
 * 运行期的实时权威仍是全局 `~/.profer/agent-sessions.json`（单写者、原子写），
 * 项目索引由会话管理器在每次索引落盘后镜像；启动时做一次对账，项目里更新
 * 的条目（例如从另一台机器拷来的项目）会合并回全局索引。
 *
 * 项目内的元数据来自「可能被拷贝/手工编辑过的文件夹」，因此这里的每条 ID
 * 都按不可信输入处理：非法 ID 直接拒绝并留下诊断，不修正、不改写。
 */

import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AgentSessionMeta } from '@profer/shared'
import { readJsonFileSafe, writeJsonFileAtomic } from './safe-file'
import {
  PROJECT_SESSION_META_FILE_NAME,
  assertValidProjectSessionId,
  isValidProjectSessionId,
  isProjectSessionsDirSafe,
  assertProjectPathSafe,
  projectSessionsDir,
  resolveProjectSessionDir,
} from './project-session-paths'

export const PROJECT_SESSION_INDEX_VERSION = 1
/** 每个会话目录内的自描述元数据；不依赖 index.json 也能恢复会话。 */
export const PROJECT_SESSION_META_FILE = PROJECT_SESSION_META_FILE_NAME

interface ProjectSessionIndexFile {
  version?: number
  sessions?: unknown
}

/** 被拒绝的项目会话条目（供调用方记录/诊断，不参与导入）。 */
export interface RejectedProjectSessionEntry {
  /** 原始 ID 值（可能不是字符串，保留原样便于定位问题数据）。 */
  id: unknown
  reason: string
}

export interface ProjectSessionIndexReadResult {
  sessions: AgentSessionMeta[]
  rejected: RejectedProjectSessionEntry[]
}

export function projectSessionIndexPath(rootPath: string): string {
  return join(rootPath, '.profer', 'sessions', 'index.json')
}

function isSessionMeta(value: unknown): value is AgentSessionMeta {
  if (!value || typeof value !== 'object') return false
  const meta = value as Partial<AgentSessionMeta>
  return isValidProjectSessionId(meta.id) && typeof meta.title === 'string'
}

function warnRejected(scope: string, rejected: readonly RejectedProjectSessionEntry[]): void {
  if (rejected.length === 0) return
  const detail = rejected
    .slice(0, 5)
    .map((entry) => `${JSON.stringify(entry.id)} (${entry.reason})`)
    .join(', ')
  console.warn(`[Agent 会话] 已拒绝 ${rejected.length} 条非法的项目会话条目 (${scope}): ${detail}`)
}

/**
 * 读取项目索引并区分「合法条目」与「被拒绝条目」。
 *
 * 会话根越界（`.profer/sessions` 指向项目外）时整个文件都不读，避免顺着
 * 符号链接读到项目外的数据。
 */
export function readProjectSessionIndexWithDiagnostics(rootPath: string): ProjectSessionIndexReadResult {
  if (!isProjectSessionsDirSafe(rootPath)) {
    return {
      sessions: [],
      rejected: [{ id: projectSessionsDir(rootPath), reason: '会话根目录指向项目外' }],
    }
  }
  const indexPath = projectSessionIndexPath(rootPath)
  for (const candidate of [indexPath, `${indexPath}.tmp`, `${indexPath}.bak`]) {
    try {
      assertProjectPathSafe(rootPath, candidate)
    } catch (error) {
      console.warn(`[Agent 会话] 项目索引路径不安全，跳过读取: ${candidate}`, error)
      return { sessions: [], rejected: [{ id: candidate, reason: '索引文件路径指向项目外' }] }
    }
  }
  const data = readJsonFileSafe<ProjectSessionIndexFile>(indexPath)
  if (!data || !Array.isArray(data.sessions)) return { sessions: [], rejected: [] }

  const sessions: AgentSessionMeta[] = []
  const rejected: RejectedProjectSessionEntry[] = []
  for (const entry of data.sessions) {
    if (!entry || typeof entry !== 'object') {
      rejected.push({ id: entry, reason: '条目不是对象' })
      continue
    }
    const rawId = (entry as { id?: unknown }).id
    if (!isValidProjectSessionId(rawId)) {
      rejected.push({ id: rawId, reason: '会话 ID 非法（含路径片段/分隔符/非法字符）' })
      continue
    }
    if (!isSessionMeta(entry)) {
      rejected.push({ id: rawId, reason: '缺少标题' })
      continue
    }
    sessions.push(entry)
  }
  warnRejected(projectSessionIndexPath(rootPath), rejected)
  return { sessions, rejected }
}

export function readProjectSessionIndex(rootPath: string): AgentSessionMeta[] | null {
  if (!existsSync(projectSessionIndexPath(rootPath))) return null
  return readProjectSessionIndexWithDiagnostics(rootPath).sessions
}

export function writeProjectSessionIndex(rootPath: string, sessions: readonly AgentSessionMeta[]): void {
  const indexPath = projectSessionIndexPath(rootPath)
  for (const candidate of [indexPath, `${indexPath}.tmp`, `${indexPath}.bak`]) {
    assertProjectPathSafe(rootPath, candidate)
  }
  mkdirSync(dirname(indexPath), { recursive: true })
  writeJsonFileAtomic(indexPath, {
    version: PROJECT_SESSION_INDEX_VERSION,
    sessions: [...sessions],
  })
}

/**
 * 会话目录内的元数据文件：项目被单独拷走时，列表不依赖 index.json。
 *
 * 会话 ID 非法或路径逃逸时抛 `ProjectSessionPathError`，调用方负责拒绝写入。
 */
export function projectSessionMetaPath(rootPath: string, sessionId: string): string {
  return join(resolveProjectSessionDir(rootPath, sessionId), PROJECT_SESSION_META_FILE)
}

/**
 * 读取会话目录内的 `session.json`。
 *
 * sidecar 的 ID 必须与其所在目录名一致：目录名才是路径的真相，
 * 内容里的 ID 不一致说明文件被拷错/改错，按不可信数据拒绝。
 */
export function readProjectSessionMeta(rootPath: string, sessionId: string): AgentSessionMeta | null {
  let filePath: string
  try {
    filePath = projectSessionMetaPath(rootPath, sessionId)
  } catch (error) {
    console.warn(`[Agent 会话] 跳过不可用的项目会话目录 (${sessionId}):`, error instanceof Error ? error.message : error)
    return null
  }
  for (const candidate of [filePath, `${filePath}.tmp`, `${filePath}.bak`]) {
    try {
      assertProjectPathSafe(rootPath, candidate)
    } catch (error) {
      console.warn(`[Agent 会话] 项目会话元数据路径不安全，跳过读取: ${candidate}`, error)
      return null
    }
  }
  const data = readJsonFileSafe<unknown>(filePath)
  if (!isSessionMeta(data)) {
    if (data !== null && data !== undefined) {
      console.warn(`[Agent 会话] 已拒绝非法的会话元数据: ${filePath}`)
    }
    return null
  }
  if (data.id !== sessionId) {
    console.warn(`[Agent 会话] 会话元数据 ID 与目录名不一致，已拒绝: ${filePath} (${data.id} ≠ ${sessionId})`)
    return null
  }
  return data
}

export function writeProjectSessionMeta(rootPath: string, sessionId: string, meta: AgentSessionMeta): void {
  assertValidProjectSessionId(sessionId)
  if (meta.id !== sessionId) {
    throw new Error(`会话元数据 ID 与目标目录不一致: ${meta.id} ≠ ${sessionId}`)
  }
  const filePath = projectSessionMetaPath(rootPath, sessionId)
  for (const candidate of [filePath, `${filePath}.tmp`, `${filePath}.bak`]) {
    assertProjectPathSafe(rootPath, candidate)
  }
  mkdirSync(dirname(filePath), { recursive: true })
  writeJsonFileAtomic(filePath, meta)
}

/**
 * 扫描项目内所有会话目录的 `session.json`。
 *
 * 没有元数据但已有 `messages.jsonl` 的目录（旧版本项目）合成一条最小会话，
 * 至少让历史消息可见；标题等细节由后续全局索引对账补齐。
 *
 * 目录名本身就是不可信输入（项目可能被手工改过），非法名称整条跳过。
 */
export function listProjectSessionMetas(rootPath: string): AgentSessionMeta[] {
  if (!isProjectSessionsDirSafe(rootPath)) {
    console.warn(`[Agent 会话] 项目会话根目录指向项目外，已跳过扫描: ${projectSessionsDir(rootPath)}`)
    return []
  }
  const sessionsDir = projectSessionsDir(rootPath)
  if (!existsSync(sessionsDir)) return []
  const result: AgentSessionMeta[] = []
  for (const entry of readdirSync(sessionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const sessionId = entry.name
    if (!isValidProjectSessionId(sessionId)) {
      console.warn(`[Agent 会话] 已拒绝非法的项目会话目录名: ${join(sessionsDir, sessionId)}`)
      continue
    }
    const meta = readProjectSessionMeta(rootPath, sessionId)
    if (meta) {
      result.push(meta)
      continue
    }
    // sidecar 存在但非法（ID 与目录名不一致等）：按不可信数据处理，不再用 messages.jsonl
    // 反向合成会话，避免把“被改坏的元数据”悄悄恢复成另一条会话。
    if (existsSync(join(sessionsDir, sessionId, PROJECT_SESSION_META_FILE))) continue
    const messagesPath = join(sessionsDir, sessionId, 'messages.jsonl')
    if (!existsSync(messagesPath)) continue
    let updatedAt = Date.now()
    try { updatedAt = statSync(messagesPath).mtimeMs } catch { /* 保持当前时间 */ }
    result.push({
      id: sessionId,
      title: '恢复的会话',
      workspaceId: '',
      storageLayout: 'project',
      createdAt: updatedAt,
      updatedAt,
    })
  }
  return result
}
