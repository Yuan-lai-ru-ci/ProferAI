import type { AttachedDirectoryProjectCandidate } from './attached-directory-project-detector'

function escapePromptXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** Pi 没有 Claude SDK 的 additionalDirectories 原生访问说明，需显式注入授权路径与识别出的项目候选。 */
export function buildPiAdditionalDirectoriesPrompt(
  directories: string[],
  projectCandidates: AttachedDirectoryProjectCandidate[] = [],
): string {
  if (directories.length === 0) return ''
  const directoryLines = directories
    .map((dir, index) => `  <directory index="${index + 1}">${escapePromptXml(dir)}</directory>`)
    .join('\n')
  const projectCandidatesBlock = projectCandidates.length === 0
    ? ''
    : `

<detected_project_candidates>
${projectCandidates.map((candidate) => `  <project>
    <root>${escapePromptXml(candidate.rootPath)}</root>
    <type>${escapePromptXml(candidate.type)}</type>
    <evidence>${escapePromptXml(candidate.evidence.join(', '))}</evidence>
    <source_attached_directory>${escapePromptXml(candidate.sourceDirectory)}</source_attached_directory>
  </project>`).join('\n')}
</detected_project_candidates>

当用户提及“repo、仓库、项目、Vault、Obsidian、笔记库、这里”等上下文指代时，必须先检查上述项目候选：若存在唯一语义匹配候选，直接以其 root 为目标路径读取或操作；仅在没有匹配候选，或多个候选无法根据用户表述消歧时，才询问用户路径。不得因当前 cwd 未发现项目而忽略已授权附加目录中的候选。`

  return `

<attached_directories>
这些目录已由 Profer 授权给当前会话，和当前工作目录同属于用户允许访问的范围。
如需读取或修改这些目录中的内容，请直接使用绝对路径，不要先复制到当前工作目录。
${directoryLines}
</attached_directories>${projectCandidatesBlock}`
}
