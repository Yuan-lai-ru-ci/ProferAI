import type { WorkspaceStorageMode } from '@profer/shared'

export interface AgentPlatformProjectCandidate {
  rootPath: string
  name: string
  type: string
  packageName?: string
  gitRemote?: string
}

export interface AgentPlatformPromptOptions {
  platform: NodeJS.Platform
  shellPath?: string
  agentCwd?: string
  projectCandidates?: AgentPlatformProjectCandidate[]
  isPiRuntime?: boolean
  /**
   * 工作区存储模式。缺省视为 managed：cwd 是 Profer 会话目录，不是项目 root。
   * `project` 下 cwd 就是项目根，必须反转「cwd 不是项目 root」这类表述，
   * 否则模型会主动绕开真正的项目目录去另找 root。
   */
  workspaceMode?: WorkspaceStorageMode
}

function escapePromptText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function candidateList(candidates: AgentPlatformProjectCandidate[]): string {
  return candidates.map((candidate) => `  - ${candidate.name}（${candidate.type}）：${escapePromptText(candidate.rootPath)}${candidate.packageName ? `，package=${escapePromptText(candidate.packageName)}` : ''}${candidate.gitRemote ? `，remote=${escapePromptText(candidate.gitRemote)}` : ''}`).join('\n')
}

function projectRootsBlock(candidates: AgentPlatformProjectCandidate[], isProjectWorkspace: boolean): string {
  if (isProjectWorkspace) {
    if (candidates.length === 0) {
      return '- 当前 cwd 就是项目根，不需要再探测其他项目候选；遇到子仓库时按实际目录树判断。'
    }
    // project 模式下 cwd 自己也会出现在候选里（附加目录包含 rootPath），必须说明不能「另找 root」。
    return `- 下列项目候选来自附加目录或当前项目本身；与当前 cwd 相同的那条就是本项目，直接以 cwd 为 root，不要再切换：\n${candidateList(candidates)}`
  }
  if (candidates.length === 0) {
    return '- 当前没有由 Profer 探测到的项目候选；先检查实际目录树，再决定要操作的 root。'
  }
  return `- Profer 已探测到以下项目候选。使用项目名、目录名、package name、Git remote 或类型消歧；只有唯一匹配时才直接使用对应的绝对 root：\n${candidateList(candidates)}`
}

function commonToolingRules(isPiRuntime: boolean | undefined): string {
  const editShape = isPiRuntime
    ? '`path + edits[].oldText/newText`'
    : '`file_path + old_string/new_string`'
  return `- Edit 是精确文本替换：如果提示找不到 oldText/old_string，立即重新 Read 当前文件相关区域，检查空格、缩进和换行后再提交；不要复用失败调用中的旧快照。\n- 使用 ${editShape} 的实际工具参数，不要把另一运行时的参数名混入当前调用。\n- 独立执行目录检查、git diff --check、typecheck 和测试；不要把多个检查拼成含 \`;\` 的复合命令，以免掩盖真实失败步骤。`
}

/**
 * 构造平台运行时 overlay。核心安全规则和工作区规则仍由 agent-prompt-builder 单一注入，
 * 本模块只描述当前 OS、shell 和路径事实，避免复制两套完整系统提示词。
 */
export function buildAgentPlatformPrompt(options: AgentPlatformPromptOptions): string {
  const shellPath = options.shellPath
    ?? (options.isPiRuntime
      ? 'Bash 不可用（shell_not_found）'
      : options.platform === 'win32'
        ? 'PowerShell（由运行时检测）'
        : options.platform === 'darwin'
          ? '/bin/zsh'
          : '/bin/sh')
  const shellExecutionDescription = options.isPiRuntime && !options.shellPath
    ? 'Bash 工具当前不可执行；不要改用 zsh/sh 猜测执行，先向用户报告 shell_not_found。'
    : 'POSIX 命令通过该 shell 的非交互 `-c` 执行。'
  const isProjectWorkspace = options.workspaceMode === 'project'
  const candidateBlock = projectRootsBlock(options.projectCandidates ?? [], isProjectWorkspace)
  const cwd = escapePromptText(options.agentCwd ?? '未提供')

  if (options.platform === 'win32') {
    const cwdLine = isProjectWorkspace
      ? `- 当前 Agent cwd：${cwd}；**这就是项目根**，相对路径直接落在项目里。不要另建项目目录，也不要因为 cwd 存在就猜测 \`src\` 或测试文件位置，先检查实际目录树。`
      : `- 当前 Agent cwd：${cwd}。cwd 不是项目 root；不要因为 cwd 存在就猜测 \`src\` 或测试文件位置。`
    return `## 当前平台与项目路径（Windows）

- 当前平台：Windows（win32）。当前 Agent shell：${escapePromptText(shellPath)}。
- 只使用运行时实际提供的 Windows shell 和路径格式；若运行时提供了路径转换，严格遵循其返回值，不自行混用路径语法。
${cwdLine}
${candidateBlock}
- 当前 shell 的命令语法和路径规则必须以运行时实际提供的 shell 为准，不要把另一种 shell 的命令复制过来。
${commonToolingRules(options.isPiRuntime)}`
  }

  if (options.platform === 'darwin') {
    const cwdLine = isProjectWorkspace
      ? `- 当前 Agent cwd：${cwd}；**这就是项目根**，相对路径直接落在项目里，不要另建项目目录，也不要假设根级存在 \`src\`，先检查实际目录树。`
      : `- 当前 Agent cwd：${cwd}。cwd 不是项目 root；不要默认仓库根目录存在 \`src\`，先检查实际目录树。`
    return `## 当前平台与项目路径（macOS）

- 当前平台：macOS（darwin）。当前 Agent shell：${escapePromptText(shellPath)}；${shellExecutionDescription}
- 当前执行环境是 POSIX shell；只使用该 shell 实际支持的命令和路径格式，不要把其他操作系统的命令、路径或环境变量当作当前事实。
${cwdLine}
${candidateBlock}
- macOS GUI 进程的 PATH 可能比终端短；优先使用 Profer 提供的绝对路径、\`git -C <root> ...\`，以及从当前 shell 实际探测到的 bun/node/git，不要凭环境猜测。
${commonToolingRules(options.isPiRuntime)}`
  }

  const cwdLine = isProjectWorkspace
    ? `- 当前 Agent cwd：${cwd}；**这就是项目根**，相对路径直接落在项目里，先检查实际目录树，不要再找别的 root。`
    : `- 当前 Agent cwd：${cwd}；先确认实际项目 root，不要默认存在根级 \`src\`。`
  return `## 当前平台与项目路径（POSIX）

- 当前平台：${escapePromptText(options.platform)}。当前 Agent shell：${escapePromptText(shellPath)}。
${cwdLine}
${candidateBlock}
${commonToolingRules(options.isPiRuntime)}`
}
