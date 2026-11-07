/**
 * 会话存储布局注册（Electron 侧）
 *
 * 把「会话属于哪个工作区、该工作区是不是 project 模式」翻译成 session-store 的
 * 纯路径注册表。session-store 不读索引、不认识工作区；所有判断集中在这里。
 *
 * 兼容策略：
 * - 显式 `meta.storageLayout` 优先（新建/迁移时写入）；
 * - 历史会话没有标记时，只有项目内 `messages.jsonl` 已存在才切到 project，
 *   否则继续读中央文件，避免升级后历史会话突然“消失”。
 */

import { existsSync, cpSync, mkdirSync, readdirSync, renameSync, unlinkSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { AgentSessionMeta } from '@profer/shared'
import {
  createSessionStorePaths,
  registerSessionStorageLayout,
  sessionGraphPathForLayout,
  sessionHarnessPathForLayout,
  sessionMessagesPathForLayout,
  unregisterSessionStorageLayout,
  type SessionStorageLayout,
} from '@profer/session-store'
import { listProjectWorkspaceRoots, resolveWorkspaceLocation } from './workspace-locator'
import { getConfigDir } from './config-paths'
import {
  isValidProjectSessionId,
  isProjectSessionsDirSafe,
  projectSessionsDir,
} from './project-session-paths'

function getWorkspace(id: string) {
  // 延迟 require：agent-workspace-manager 反向依赖 agent-session-manager，顶层 import 会成环。
  const { getAgentWorkspace } = require('./agent-workspace-manager') as typeof import('./agent-workspace-manager')
  return getAgentWorkspace(id)
}

/** 新建会话时的工作区默认布局（不看文件是否存在）。 */
export function defaultStorageLayoutForWorkspace(workspaceId: string | undefined): 'project' | 'managed' {
  if (!workspaceId) return 'managed'
  const workspace = getWorkspace(workspaceId)
  if (!workspace) return 'managed'
  return resolveWorkspaceLocation(workspace.slug).mode === 'project' ? 'project' : 'managed'
}

/**
 * 项目会话的数据目录；工作区不是 project 或索引损坏时返回 undefined。
 *
 * 这里是布局注册表的热路径（索引加载时按会话批量调用），只做纯字符串的
 * ID 校验 + 越界检查，不做文件 IO；符号链接与真实路径检查在导入/写入入口
 * （`project-session-index` / 迁移）完成。
 */
export function projectSessionDataDir(workspaceId: string | undefined, sessionId: string): string | undefined {
  if (!workspaceId) return undefined
  if (!isValidProjectSessionId(sessionId)) return undefined
  const workspace = getWorkspace(workspaceId)
  if (!workspace) return undefined
  const location = resolveWorkspaceLocation(workspace.slug)
  if (location.mode !== 'project') return undefined
  const sessionsDir = join(location.configDir, 'sessions')
  const dataDir = resolve(sessionsDir, sessionId)
  const rel = relative(resolve(sessionsDir), dataDir)
  if (!rel || rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) return undefined
  return dataDir
}

/**
 * 解析会话实际使用的布局。
 *
 * 不写盘、不 mkdir：只读探测，供注册与迁移判定共用。
 */
export function resolveSessionStorageLayout(
  meta: Pick<AgentSessionMeta, 'id' | 'workspaceId' | 'storageLayout'>,
): SessionStorageLayout {
  const dataDir = projectSessionDataDir(meta.workspaceId, meta.id)
  if (!dataDir) return { kind: 'managed' }
  if (meta.storageLayout === 'project') return { kind: 'project', dataDir }
  if (meta.storageLayout === 'managed') return { kind: 'managed' }
  // 历史会话：项目内已有消息文件才认为已经迁过。
  if (existsSync(join(dataDir, 'messages.jsonl'))) return { kind: 'project', dataDir }
  return { kind: 'managed' }
}

export function registerSessionLayout(meta: Pick<AgentSessionMeta, 'id' | 'workspaceId' | 'storageLayout'>): void {
  registerSessionStorageLayout(meta.id, resolveSessionStorageLayout(meta))
}

export function unregisterSessionLayout(sessionId: string): void {
  unregisterSessionStorageLayout(sessionId)
}

/** 索引加载后批量注册；未列出的会话保持原有注册（草稿可能尚未写索引）。 */
export function syncSessionStorageLayouts(sessions: readonly AgentSessionMeta[]): void {
  for (const session of sessions) registerSessionLayout(session)
}

/** 布局的持久化标记值。 */
export function storageLayoutKind(layout: SessionStorageLayout): 'project' | 'managed' {
  return layout.kind
}

/**
 * 在两种布局之间搬会话的消息/任务图/Harness 文件。
 *
 * 只在布局真正变化时执行；跨卷 rename 失败时回退 copy + delete。
 * 调用方负责在文件搬完后更新索引与注册表。
 */
export function moveSessionDataFiles(
  sessionId: string,
  from: SessionStorageLayout,
  to: SessionStorageLayout,
): void {
  if (from.kind === to.kind && from.dataDir === to.dataDir) return
  const paths = createSessionStorePaths(getConfigDir())
  const pairs: Array<[string, string]> = [
    [sessionMessagesPathForLayout(paths, sessionId, from), sessionMessagesPathForLayout(paths, sessionId, to)],
    [sessionGraphPathForLayout(paths, sessionId, from), sessionGraphPathForLayout(paths, sessionId, to)],
    [sessionHarnessPathForLayout(paths, sessionId, from), sessionHarnessPathForLayout(paths, sessionId, to)],
  ]
  for (const [source, destination] of pairs) {
    if (source === destination || !existsSync(source)) continue
    mkdirSync(dirname(destination), { recursive: true })
    try {
      renameSync(source, destination)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
      cpSync(source, destination)
      unlinkSync(source)
    }
  }
}

export interface SessionDataFile {
  sessionId: string
  path: string
  kind: 'managed' | 'project'
  /** 目录内文件名（managed 为 `<sid>.jsonl`，project 为 `messages.jsonl` / `pi/xxx.jsonl`）。 */
  fileName: string
  /** managed 文件名能否解析出会话 ID；project 恒为 true。 */
  parseable: boolean
}

/**
 * 列出全部会话消息文件（managed 全局目录 + 各项目 sessions/<sid>/messages.jsonl）。
 *
 * 供整理、存储统计、blob 孤儿判定使用：这些场景必须同时看到两种布局，
 * 否则项目会话引用的 blob 会被误判为孤儿而删除。
 */
export function listAllSessionMessageFiles(): SessionDataFile[] {
  return listSessionDataFiles((sessionId, fileName) => fileName === `${sessionId}.jsonl` || fileName === 'messages.jsonl')
}

/** 列出全部会话 JSONL（消息 + 任务图 + Harness + Pi transcript），用于存储统计与清理。 */
export function listAllSessionJsonlFiles(): SessionDataFile[] {
  return listSessionDataFiles(() => true)
}

function listSessionDataFiles(include: (sessionId: string, fileName: string) => boolean): SessionDataFile[] {
  const result: SessionDataFile[] = []
  const seen = new Set<string>()
  const push = (
    sessionId: string,
    filePath: string,
    kind: 'managed' | 'project',
    fileName: string,
    parseable: boolean,
  ) => {
    if (seen.has(filePath)) return
    seen.add(filePath)
    result.push({ sessionId, path: filePath, kind, fileName, parseable })
  }

  const globalDir = join(getConfigDir(), 'agent-sessions')
  if (existsSync(globalDir)) {
    for (const entry of readdirSync(globalDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
      const sessionId = entry.name.slice(0, -'.jsonl'.length)
      // 解析不出会话 ID 的文件仍计入总量（不能凭空消失），但不参与孤儿判定/删除。
      const parseable = sessionId.length > 0
      if (!include(sessionId, entry.name)) continue
      push(sessionId, join(globalDir, entry.name), 'managed', entry.name, parseable)
    }
  }

  for (const root of listProjectWorkspaceRoots()) {
    if (!isProjectSessionsDirSafe(root.rootPath)) continue
    const sessionsDir = projectSessionsDir(root.rootPath)
    if (!existsSync(sessionsDir)) continue
    for (const entry of readdirSync(sessionsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      // 目录名是不可信输入：非法 ID 不参与统计/孤儿判定，避免误删项目外文件。
      if (!isValidProjectSessionId(entry.name)) continue
      const dataDir = join(sessionsDir, entry.name)
      if (!existsSync(dataDir)) continue
      for (const file of readdirSync(dataDir, { withFileTypes: true })) {
        if (file.isFile() && file.name.endsWith('.jsonl')) {
          if (include(entry.name, file.name)) push(entry.name, join(dataDir, file.name), 'project', file.name, true)
          continue
        }
        // Pi 原生 transcript 在 <dataDir>/pi/ 下，同属该会话数据，孤儿清理与统计都要覆盖。
        if (file.isDirectory() && file.name === 'pi') {
          const piDir = join(dataDir, 'pi')
          for (const piFile of readdirSync(piDir, { withFileTypes: true })) {
            if (!piFile.isFile() || !piFile.name.endsWith('.jsonl')) continue
            const relativeName = `pi/${piFile.name}`
            if (!include(entry.name, relativeName)) continue
            push(entry.name, join(piDir, piFile.name), 'project', relativeName, true)
          }
        }
      }
    }
  }

  return result
}
