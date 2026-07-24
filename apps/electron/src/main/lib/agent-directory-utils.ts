/**
 * Agent 附加目录工具函数
 *
 * 从 agent-orchestrator.ts 提取的纯函数，用于聚合 SDK 调用涉及的附加目录。
 */
import { dirname } from 'node:path'
import type { AgentSessionMeta } from '@profer/shared'
import { getWorkspaceAttachedDirectories, getWorkspaceAttachedFiles } from './agent-workspace-manager'
import { getAgentWorkspacePath, getWorkspaceFilesDir } from './config-paths'

/**
 * 聚合一次 SDK 调用涉及的所有附加目录（去重，保持插入顺序）。
 *
 * 来源：extraDirs / 会话级 attachedDirectories+Files / 工作区根目录 / 工作区级 attachedDirectories+Files / workspace-files/
 */
export function collectAttachedDirectories(params: {
  sessionMeta?: AgentSessionMeta
  workspaceSlug?: string
  extraDirs?: string[]
}): string[] {
  const { sessionMeta, workspaceSlug, extraDirs } = params
  const result: string[] = []
  const push = (dir: string | undefined | null) => {
    if (!dir) return
    if (!result.includes(dir)) result.push(dir)
  }

  for (const d of extraDirs ?? []) push(d)
  for (const d of sessionMeta?.attachedDirectories ?? []) push(d)
  for (const file of sessionMeta?.attachedFiles ?? []) push(dirname(file))

  if (workspaceSlug) {
    // cwd 是会话子目录；显式加入工作区根目录，使 CLAUDE.md 等工作区级
    // 文件可被 Agent 用其绝对路径读取，也与提示词中的路径声明保持一致。
    push(getAgentWorkspacePath(workspaceSlug))
    for (const d of getWorkspaceAttachedDirectories(workspaceSlug)) push(d)
    for (const f of getWorkspaceAttachedFiles(workspaceSlug)) push(dirname(f))
    push(getWorkspaceFilesDir(workspaceSlug))
  }

  return result
}
