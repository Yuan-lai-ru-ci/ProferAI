import { join } from 'node:path'
import type { SessionStorePaths } from './contracts'
import { getSessionStorageLayout, type SessionStorageLayout } from './session-layout'

export function createSessionStorePaths(configDir: string, overrides: Partial<SessionStorePaths> = {}): SessionStorePaths {
  const sessionsDir = overrides.sessionsDir ?? join(configDir, 'agent-sessions')
  return {
    configDir,
    sessionsIndex: overrides.sessionsIndex ?? join(configDir, 'agent-sessions.json'),
    sessionsDir,
    blobsDir: overrides.blobsDir ?? join(configDir, 'blobs'),
    graphDir: overrides.graphDir ?? sessionsDir,
    harnessDir: overrides.harnessDir ?? sessionsDir,
    checkpointsDir: overrides.checkpointsDir ?? join(configDir, 'agent-checkpoints'),
    ...(overrides.sdkConfigDir ? { sdkConfigDir: overrides.sdkConfigDir } : {}),
    ...(overrides.workspaceRoot ? { workspaceRoot: overrides.workspaceRoot } : {}),
  }
}

/**
 * 项目会话的私有数据目录；managed/未注册会话返回 undefined。
 *
 * 只返回已注册的布局，不做存在性探测：路径层必须保持纯函数，创建目录由上层负责。
 */
function projectDataDir(sessionId: string): string | undefined {
  const layout = getSessionStorageLayout(sessionId)
  return layout?.kind === 'project' ? layout.dataDir : undefined
}

/**
 * 会话消息文件路径。
 *
 * - project：`<dataDir>/messages.jsonl`（dataDir = `<root>/.profer/sessions/<sid>`）
 * - managed：`<sessionsDir>/<sid>.jsonl`
 */
export function sessionMessagesPath(paths: Pick<SessionStorePaths, 'sessionsDir'>, sessionId: string): string {
  return sessionMessagesPathForLayout(paths, sessionId, getSessionStorageLayout(sessionId))
}

/** 按显式布局解析消息路径（迁移时同时需要源/目标两个布局）。 */
export function sessionMessagesPathForLayout(
  paths: Pick<SessionStorePaths, 'sessionsDir'>,
  sessionId: string,
  layout: SessionStorageLayout | undefined,
): string {
  if (layout?.kind === 'project' && layout.dataDir) return join(layout.dataDir, 'messages.jsonl')
  return join(paths.sessionsDir, `${sessionId}.jsonl`)
}

/** 会话消息目录（用于 mkdir）：project 用 dataDir，managed 用 sessionsDir。 */
export function sessionMessagesDir(paths: Pick<SessionStorePaths, 'sessionsDir'>, sessionId: string): string {
  return projectDataDir(sessionId) ?? paths.sessionsDir
}

export function sessionGraphPath(paths: SessionStorePaths, sessionId: string): string {
  return sessionGraphPathForLayout(paths, sessionId, getSessionStorageLayout(sessionId))
}

/** 按显式布局解析任务图路径。 */
export function sessionGraphPathForLayout(
  paths: SessionStorePaths,
  sessionId: string,
  layout: SessionStorageLayout | undefined,
): string {
  const dir = layout?.kind === 'project' && layout.dataDir ? layout.dataDir : paths.graphDir
  return join(dir, `${sessionId}-graph.jsonl`)
}

export function sessionHarnessPath(paths: SessionStorePaths, sessionId: string): string {
  return sessionHarnessPathForLayout(paths, sessionId, getSessionStorageLayout(sessionId))
}

/** 按显式布局解析 Harness 账本路径。 */
export function sessionHarnessPathForLayout(
  paths: SessionStorePaths,
  sessionId: string,
  layout: SessionStorageLayout | undefined,
): string {
  const dir = layout?.kind === 'project' && layout.dataDir ? layout.dataDir : paths.harnessDir
  return join(dir, `${sessionId}-pi-harness.jsonl`)
}
