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
}

function escapePromptText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function projectRootsBlock(candidates: AgentPlatformProjectCandidate[]): string {
  if (candidates.length === 0) {
    return '- 当前没有由 Profer 探测到的项目候选；先检查实际目录树，再决定要操作的 root。'
  }
  return `- Profer 已探测到以下项目候选。使用项目名、目录名、package name、Git remote 或类型消歧；只有唯一匹配时才直接使用对应的绝对 root：\n${candidates.map((candidate) => `  - ${candidate.name}（${candidate.type}）：${escapePromptText(candidate.rootPath)}${candidate.packageName ? `，package=${escapePromptText(candidate.packageName)}` : ''}${candidate.gitRemote ? `，remote=${escapePromptText(candidate.gitRemote)}` : ''}`).join('\n')}`
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
  const shellPath = options.shellPath ?? (options.platform === 'win32' ? 'PowerShell（由运行时检测）' : options.platform === 'darwin' ? '/bin/zsh' : '/bin/sh')
  const candidateBlock = projectRootsBlock(options.projectCandidates ?? [])

  if (options.platform === 'win32') {
    return `## 当前平台与项目路径（Windows）

- 当前平台：Windows（win32）。当前 Agent shell：${escapePromptText(shellPath)}。
- 只使用运行时实际提供的 Windows shell 和路径格式；若运行时提供了路径转换，严格遵循其返回值，不自行混用路径语法。
- 当前 Agent cwd：${escapePromptText(options.agentCwd ?? '未提供')}。cwd 不是项目 root；不要因为 cwd 存在就猜测 \`src\` 或测试文件位置。
${candidateBlock}
- 当前 shell 的命令语法和路径规则必须以运行时实际提供的 shell 为准，不要把另一种 shell 的命令复制过来。
${commonToolingRules(options.isPiRuntime)}`
  }

  if (options.platform === 'darwin') {
    return `## 当前平台与项目路径（macOS）

- 当前平台：macOS（darwin）。当前 Agent shell：${escapePromptText(shellPath)}；POSIX 命令通过该 shell 的非交互 \`-c\` 执行。
- 当前执行环境是 POSIX shell；只使用该 shell 实际支持的命令和路径格式，不要把其他操作系统的命令、路径或环境变量当作当前事实。
- 当前 Agent cwd：${escapePromptText(options.agentCwd ?? '未提供')}。cwd 不是项目 root；不要默认仓库根目录存在 \`src\`，先检查实际目录树。
${candidateBlock}
- macOS GUI 进程的 PATH 可能比终端短；优先使用 Profer 提供的绝对路径、\`git -C <root> ...\`，以及从当前 shell 实际探测到的 bun/node/git，不要凭环境猜测。
${commonToolingRules(options.isPiRuntime)}`
  }

  return `## 当前平台与项目路径（POSIX）

- 当前平台：${escapePromptText(options.platform)}。当前 Agent shell：${escapePromptText(shellPath)}。
- 当前 Agent cwd：${escapePromptText(options.agentCwd ?? '未提供')}；先确认实际项目 root，不要默认存在根级 \`src\`。
${candidateBlock}
${commonToolingRules(options.isPiRuntime)}`
}
