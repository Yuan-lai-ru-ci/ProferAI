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
 */

import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AgentSessionMeta } from '@profer/shared'
import { readJsonFileSafe, writeJsonFileAtomic } from './safe-file'

export const PROJECT_SESSION_INDEX_VERSION = 1
/** 每个会话目录内的自描述元数据；不依赖 index.json 也能恢复会话。 */
export const PROJECT_SESSION_META_FILE = 'session.json'

interface ProjectSessionIndexFile {
  version?: number
  sessions?: unknown
}

export function projectSessionIndexPath(rootPath: string): string {
  return join(rootPath, '.profer', 'sessions', 'index.json')
}

function isSessionMeta(value: unknown): value is AgentSessionMeta {
  if (!value || typeof value !== 'object') return false
  const meta = value as Partial<AgentSessionMeta>
  return typeof meta.id === 'string' && meta.id.length > 0 && typeof meta.title === 'string'
}

export function readProjectSessionIndex(rootPath: string): AgentSessionMeta[] | null {
  const data = readJsonFileSafe<ProjectSessionIndexFile>(projectSessionIndexPath(rootPath))
  if (!data || !Array.isArray(data.sessions)) return null
  return data.sessions.filter(isSessionMeta)
}

export function writeProjectSessionIndex(rootPath: string, sessions: readonly AgentSessionMeta[]): void {
  const indexPath = projectSessionIndexPath(rootPath)
  mkdirSync(dirname(indexPath), { recursive: true })
  writeJsonFileAtomic(indexPath, {
    version: PROJECT_SESSION_INDEX_VERSION,
    sessions: [...sessions],
  })
}

/** 会话目录内的元数据文件：项目被单独拷走时，列表不依赖 index.json。 */
export function projectSessionMetaPath(rootPath: string, sessionId: string): string {
  return join(rootPath, '.profer', 'sessions', sessionId, PROJECT_SESSION_META_FILE)
}

export function readProjectSessionMeta(rootPath: string, sessionId: string): AgentSessionMeta | null {
  const data = readJsonFileSafe<unknown>(projectSessionMetaPath(rootPath, sessionId))
  return isSessionMeta(data) ? data : null
}

export function writeProjectSessionMeta(rootPath: string, sessionId: string, meta: AgentSessionMeta): void {
  const filePath = projectSessionMetaPath(rootPath, sessionId)
  mkdirSync(dirname(filePath), { recursive: true })
  writeJsonFileAtomic(filePath, meta)
}

/**
 * 扫描项目内所有会话目录的 `session.json`。
 *
 * 没有元数据但已有 `messages.jsonl` 的目录（旧版本项目）合成一条最小会话，
 * 至少让历史消息可见；标题等细节由后续全局索引对账补齐。
 */
export function listProjectSessionMetas(rootPath: string): AgentSessionMeta[] {
  const sessionsDir = join(rootPath, '.profer', 'sessions')
  if (!existsSync(sessionsDir)) return []
  const result: AgentSessionMeta[] = []
  for (const entry of readdirSync(sessionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const sessionId = entry.name
    const meta = readProjectSessionMeta(rootPath, sessionId)
    if (meta) {
      result.push(meta)
      continue
    }
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
