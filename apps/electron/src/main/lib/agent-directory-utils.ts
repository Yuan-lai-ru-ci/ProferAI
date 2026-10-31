/**
 * Agent 附加目录工具函数
 *
 * 从 agent-orchestrator.ts 提取的纯函数，用于聚合 SDK 调用涉及的附加目录。
 */
import { dirname, isAbsolute, join, relative } from 'node:path'
import { statSync } from 'node:fs'
import type { AgentSessionMeta } from '@profer/shared'
import { getWorkspaceAttachedDirectories, getWorkspaceAttachedFiles } from './agent-workspace-manager'
import { getAgentWorkspacePath, getConfigDir, getWorkspaceFilesDir } from './config-paths'

/**
 * 路径是否位于指定目录内（含子目录）。
 *
 * 用于区分「会话草稿区」与「用户项目」：前者是 Agent 自己的临时产物，不应计入文件改动。
 */
export function isPathInsideDirectory(candidate: string, directory: string): boolean {
  if (!candidate || !directory) return false
  const relation = relative(directory, candidate)
  return relation !== '' && !relation.startsWith('..') && !isAbsolute(relation)
}

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
    // cwd 是会话子目录；显式加入 Profer 工作区根目录，使 workspace-profile.md 等
    // 工作区级资料可被 Agent 用其绝对路径读取，也与提示词中的路径声明保持一致。
    push(getAgentWorkspacePath(workspaceSlug))
    for (const d of getWorkspaceAttachedDirectories(workspaceSlug)) push(d)
    for (const f of getWorkspaceAttachedFiles(workspaceSlug)) push(dirname(f))
    push(getWorkspaceFilesDir(workspaceSlug))
  }

  return result
}

/**
 * Profer 产品自有产物目录：皮肤库、插件、Skill 源、附件暂存（仅返回真实存在的目录）。
 *
 * 这些目录由 Profer 自己创建、在设置页里可见，Agent 生成的皮肤壁纸/缩略图等产物就落在这里，
 * 所以 Agent 预览、图片输出与内置浏览器预览都应把它们当作可读根；
 * 不含配置与凭据文件（channels.json、auth-tokens.enc、sdk-config 等不在列表内）。
 *
 * 刻意**不**并入 collectAttachedDirectories：那份清单还会进提示词的附加目录与项目探测，
 * 把产品目录混进去会给每个会话增加噪声。
 */
export function collectProductArtifactDirectories(productArtifactConfigDir: string = getConfigDir()): string[] {
  const configDir = productArtifactConfigDir
  return ['skins', 'plugins', 'plugin-data', 'default-skills', 'global-skills', 'attachments']
    .map((name) => join(configDir, name))
    .filter((dir) => {
      try {
        // 调用方（如 createAuthorizedPreviewUrl / preview-inspection-service）对根目录做 realpath，
        // 不存在的根会让整次调用失败，所以这里先过滤掉。
        return statSync(dir).isDirectory()
      } catch {
        return false
      }
    })
}
