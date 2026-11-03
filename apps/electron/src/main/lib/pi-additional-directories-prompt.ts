import type { AttachedDirectoryProjectCandidate } from './attached-directory-project-detector'

function escapePromptXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** `buildPiAdditionalDirectoriesPrompt` 的可选上下文。 */
export interface PiAdditionalDirectoriesPromptOptions {
  /**
   * project 模式下的项目根（= 会话 cwd）。
   *
   * 给定时它是**唯一权威项目根**：用户说“repo / 仓库 / 项目 / 这里”时都指它，
   * 不再使用从附加目录反推的候选（附加目录只是额外授权范围，不是用户口中的项目）。
   * 不给（managed / 无工作区）时保持改造前行为。
   */
  projectRoot?: string
}

/** Pi 没有 Claude SDK 的 additionalDirectories 原生访问说明，需显式注入授权路径与识别出的项目候选。 */
export function buildPiAdditionalDirectoriesPrompt(
  directories: string[],
  projectCandidates: AttachedDirectoryProjectCandidate[] = [],
  options: PiAdditionalDirectoriesPromptOptions = {},
): string {
  if (directories.length === 0) return ''
  // project 模式下 cwd 就是项目根：以它为准，废弃从附加目录反推的候选。
  const projectRoot = options.projectRoot
  const effectiveCandidates = projectRoot ? [] : projectCandidates
  const directoryLines = directories
    .map((dir, index) => `  <directory index="${index + 1}">${escapePromptXml(dir)}</directory>`)
    .join('\n')
  const projectCandidatesBlock = effectiveCandidates.length === 0
    ? ''
    : `

<detected_project_candidates>
${effectiveCandidates.map((candidate) => {
      const head = `${escapePromptXml(candidate.name)}（${escapePromptXml(candidate.type)}）：${escapePromptXml(candidate.rootPath)}`
      const details = [
        candidate.packageName ? `package=${escapePromptXml(candidate.packageName)}` : '',
        candidate.repositoryRoot ? `repo=${escapePromptXml(candidate.repositoryRoot)}` : '',
        candidate.gitRemote ? `remote=${escapePromptXml(candidate.gitRemote)}` : '',
      ].filter(Boolean)
      return `  - ${[head, ...details].join('，')}`
    }).join('\n')}
</detected_project_candidates>

当用户提及“repo、仓库、项目、Vault、Obsidian、笔记库、这里”等上下文指代时，必须先检查上述项目候选：
1. 每行的 root 是实际应读取或操作的绝对路径；不能把附加目录、当前 cwd 或另一个候选路径当成替代路径。
2. 优先按项目名、package name、git remote、项目类型和 repo 根目录消歧。
3. 只有存在唯一语义匹配候选时才直接使用其 root；没有匹配或仍有多个候选时，才询问用户路径。不得因当前 cwd 未发现项目而忽略已授权附加目录中的候选。`

  const projectRootBlock = projectRoot
    ? `

<workspace_project_root>${escapePromptXml(projectRoot)}</workspace_project_root>
当前 cwd 就是本项目根（见上方 <workspace_project_root>）：用户提及“repo、仓库、项目、Vault、Obsidian、笔记库、这里”时一律指它，不要再从附加目录反推项目根，也不要把附加目录或 Profer 会话运行目录当成项目根。附加目录只是额外授权的读取/修改范围。`
    : ''

  return `

<attached_directories>
这些目录已由 Profer 授权给当前会话，和当前工作目录同属于用户允许访问的范围。
如需读取或修改这些目录中的内容，请直接使用绝对路径，不要先复制到当前工作目录。
${directoryLines}
</attached_directories>${projectCandidatesBlock}${projectRootBlock}`
}
