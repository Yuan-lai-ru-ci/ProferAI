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

import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AgentSessionMeta } from '@profer/shared'
import { readJsonFileSafe, writeJsonFileAtomic } from './safe-file'

export const PROJECT_SESSION_INDEX_VERSION = 1

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
