import { basename } from 'node:path'

interface AgentsFilesResult {
  agentsFiles: Array<{ path: string; content: string }>
}

const LEGACY_AGENT_CONTEXT_FILE_NAMES = new Set(['CLAUDE.md', 'CLAUDE.MD'])

/** Profer 已验证的项目指令文件（显式路径 + 内容，禁止 Pi 磁盘自动发现）。 */
export interface ProferProjectInstructionFile {
  path: string
  content: string
}

/** Profer-managed Pi 模式显式关闭 Pi 的 ambient 本地资源加载。 */
export function createProferManagedResourceLoaderOptions() {
  return {
    noContextFiles: true,
    noExtensions: true,
    noSkills: true,
    // An explicit empty source prevents Pi from discovering APPEND_SYSTEM.md.
    appendSystemPrompt: [],
  }
}

/**
 * Pi 仍负责最终的 <project_context> 格式化；Profer 仅在验证显式工作区路径与
 * 用户授权项目路径后提供此 override，不重新启用 ambient 上下文文件发现。
 */
export function createProferProjectInstructionFilesOverride(files: ProferProjectInstructionFile[]) {
  const agentsFiles = files.map(({ path, content }) => ({ path, content }))
  return () => ({ agentsFiles })
}

/** 保持受管工作区规则排在用户项目规则之前。 */
export function combineProferInstructionFiles(
  workspaceFile: ProferProjectInstructionFile | undefined,
  projectFiles: ProferProjectInstructionFile[],
): ProferProjectInstructionFile[] {
  return workspaceFile ? [workspaceFile, ...projectFiles] : projectFiles
}

export function createProferAgentsFilesOverride(): (base: AgentsFilesResult) => AgentsFilesResult {
  return (base) => ({
    agentsFiles: base.agentsFiles.filter((file) => !LEGACY_AGENT_CONTEXT_FILE_NAMES.has(basename(file.path))),
  })
}
