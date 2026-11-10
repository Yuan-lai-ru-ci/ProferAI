/**
 * 工具分类规则 — Agent 权限系统
 *
 * 定义安全工具白名单、安全 Bash 命令模式和危险命令列表。
 * 用于智能模式下的自动允许/询问判断。
 */

/** 返回跨 Runtime 共用的逻辑工具短名；兼容 Claude MCP 命名空间和 Pi 原生工具名。 */
export function canonicalAgentToolName(toolName: string): string {
  const trimmed = toolName.trim()
  const short = trimmed.split('__').at(-1) ?? trimmed
  const aliases: Record<string, string> = { bash: 'Bash', read: 'Read', write: 'Write', edit: 'Edit', grep: 'Grep', find: 'Glob', glob: 'Glob', ls: 'Ls' }
  return aliases[short.toLowerCase()] ?? short
}

/** 工具名是否匹配指定逻辑工具；避免把 Claude MCP namespace 当成能力名。 */
export function isCanonicalAgentTool(toolName: string, canonicalName: string): boolean {
  return canonicalAgentToolName(toolName) === canonicalName
}

/** 始终安全的工具（免询问） */
export const SAFE_TOOLS: readonly string[] = [
  'Read',            // 文件读取
  'Glob',            // 文件名搜索
  'Grep',            // 内容搜索
  'WebSearch',       // 网络搜索
  'WebFetch',        // 网页获取
  // Pi 受管浏览器：网页隔离、私网/下载/弹窗/权限已在主进程策略层拦截。
  'BrowserObserve',
  'BrowserNavigate',
  'BrowserGoBack',
  'BrowserGoForward',
  'BrowserReload',
  'BrowserScroll',
  'BrowserExtract',
  'BrowserClick',
  'BrowserFill',
  'BrowserPress',
  'BrowserScreenshot',
  'BrowserListTabs',
  'BrowserNewTab',
  'BrowserSelectTab',
  'BrowserPreviewOpen',
  'TodoRead',        // Todo 列表读取
  'TodoWrite',       // Todo 列表写入（无安全风险）
  'TaskOutput',      // 后台任务输出
  // 注意：AskUserQuestion 不在此列表 — 由 canUseTool 拦截并展示交互式 UI
]

/** 安全的 Bash 命令模式（只读操作） */
export const SAFE_BASH_PATTERNS: readonly RegExp[] = [
  /^git\s+(status|log|diff|show|branch|remote|tag)\b/,
  /^ls\b/,
  /^head\b/,
  /^tail\b/,
  /^grep\b/,
  /^rg\b/,
  /^which\b/,
  /^pwd$/,
  /^env$/,
  /^whoami$/,
  /^uname\b/,
  /^tree\b/,
  /^wc\b/,
  /^file\b/,
  /^stat\b/,
  /^du\b/,
  /^df\b/,
  /^node\s+--version$/,
  /^bun\s+--version$/,
  /^npm\s+(list|ls|view|info|outdated)\b/,
  /^bun\s+(pm\s+ls)\b/,
  // 注意：cat/echo/find 不在此列表中
  // - cat 可读取敏感文件（~/.ssh/id_rsa 等）
  // - echo 可通过重定向写入文件
  // - find 的 -exec/-delete 可执行任意命令/删除文件
]

/** 危险命令前缀（需特别标记⚠️） */
export const DANGEROUS_COMMANDS: readonly string[] = [
  'rm', 'rmdir',
  'sudo', 'su',
  'chmod', 'chown',
  'mv',
  'dd',
  'kill', 'killall', 'pkill',
  'git push', 'git reset', 'git rebase', 'git checkout',
  'git clean', 'git branch -D', 'git branch -d',
  'npm publish',
  'curl', 'wget',
  'ssh', 'scp',
]

/**
 * 检测 Bash 命令是否包含危险结构
 *
 * 这些结构会让「命令名白名单」失去意义，必须在任何参数级判定之前拦掉：
 * 管道、重定向、命令拼接、子 shell、后台执行、换行。
 *
 * 按原始字符串判断，引号内的同类字符也会被判为危险——宁可多问一次，
 * 也不把带引号的 `$(...)`、反引号或换行放过去。
 */
export function hasDangerousStructure(command: string): boolean {
  // 换行/回车可当作命令分隔符
  if (/[\r\n]/.test(command)) return true
  // 管道操作
  if (/[|]/.test(command)) return true
  // 输出重定向（含 &>、2> 等）
  if (/>/.test(command)) return true
  // find -exec / -delete（可执行任意命令/删除文件）
  if (/\b-exec\b/.test(command) || /\b-delete\b/.test(command)) return true
  // 命令链接操作符：&&、|| 和命令上下文中的独立分号
  if (/&&/.test(command) || /\|\|/.test(command) || /;\s*(?=\S)/.test(command)) return true
  // 子 shell / 命令替换 / 变量展开（$(...)、反引号、${...}）
  if (/\$\(/.test(command) || /`/.test(command) || /\$\{/.test(command)) return true
  // 进程替换：<(cmd) / >(cmd)
  if (/[<>]\(/.test(command)) return true
  // 后台执行：& 前不能是 >/<（排除 2>&1 这类 fd 重定向）
  if (/(^|[^>&])&/.test(command)) return true
  return false
}

/**
 * 把 Bash 命令拆成参数 token，支持单/双引号与反斜杠转义。
 *
 * 无法可靠解析（引号未闭合、末尾孤立反斜杠）时返回 null，调用方一律按不安全处理。
 */
function tokenizeBashCommand(command: string): string[] | null {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let started = false

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!
    if (quote) {
      if (ch === quote) {
        quote = null
        continue
      }
      if (quote === '"' && ch === '\\' && i + 1 < command.length) {
        current += command[++i]!
        continue
      }
      current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      started = true
      continue
    }
    if (ch === '\\') {
      if (i + 1 >= command.length) return null
      current += command[++i]!
      started = true
      continue
    }
    if (ch === ' ' || ch === '\t') {
      if (started) {
        tokens.push(current)
        current = ''
        started = false
      }
      continue
    }
    current += ch
    started = true
  }

  if (quote) return null
  if (started) tokens.push(current)
  return tokens
}

/** 取 flag 名，忽略 `--flag=value` 形式的取值部分。 */
function flagName(token: string): string {
  const eq = token.indexOf('=')
  return eq === -1 ? token : token.slice(0, eq)
}

/** git 只读子命令。 */
const GIT_READ_SUBCOMMANDS = new Set(['status', 'log', 'diff', 'show', 'branch', 'remote', 'tag'])

/** 会写文件、执行外部程序或改变仓库状态的 git 选项。 */
const GIT_FORBIDDEN_FLAGS = new Set([
  '--output',
  '--ext-diff',
  '--textconv',
  '--exec-path',
  '--upload-pack',
  '--open-files-in-pager',
  '--edit-description',
  '--set-upstream-to',
  '--unset-upstream',
  '--delete',
  '--move',
  '--force',
  '--create-reflog',
  '--recurse-submodules',
  '--rebase',
  '--interactive',
])

/** `git branch` 的只读选项；未列出的选项一律按写操作处理。 */
const GIT_BRANCH_READ_FLAGS = new Set([
  '-a', '-r', '-v', '-vv', '--all', '--remotes', '--verbose', '--list', '--show-current',
  '--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '--format',
  '--sort', '--column', '--no-column', '--abbrev', '--no-abbrev', '--omit-empty',
  '--color', '--no-color', '--ignore-case',
])

/** `git tag` 的只读选项；`-a/-s/-m/-F/-d` 等创建/删除选项不在其中。 */
const GIT_TAG_READ_FLAGS = new Set([
  '-l', '-n', '--list', '--contains', '--no-contains', '--merged', '--no-merged',
  '--points-at', '--sort', '--format', '--column', '--no-column', '--omit-empty',
  '--color', '--no-color', '--ignore-case',
])

/** 允许带位置参数（分支名/模式）的只读选择器。 */
const GIT_POSITIONAL_SELECTORS = new Set([
  '-l', '--list', '--contains', '--no-contains', '--merged', '--no-merged', '--points-at',
])

/**
 * 判断 git 子命令是否只读。
 *
 * `git branch` / `git tag` 用「选项白名单 + 位置参数需搭配选择器」判定：
 * `git branch -a`、`git branch --list 'feat*'` 放行；`git branch new-branch`、
 * `git tag v1.0.0` 这类创建操作不放行。
 */
function isReadOnlyGitArgs(args: string[]): boolean {
  const [subcommand, ...rest] = args
  if (!subcommand || !GIT_READ_SUBCOMMANDS.has(subcommand)) return false
  if (rest.some((arg) => GIT_FORBIDDEN_FLAGS.has(flagName(arg)))) return false

  if (subcommand === 'branch' || subcommand === 'tag') {
    const allowedFlags = subcommand === 'branch' ? GIT_BRANCH_READ_FLAGS : GIT_TAG_READ_FLAGS
    for (const arg of rest) {
      if (arg.startsWith('-') && !allowedFlags.has(flagName(arg))) return false
    }
    const hasPositional = rest.some((arg) => !arg.startsWith('-'))
    if (hasPositional && !rest.some((arg) => GIT_POSITIONAL_SELECTORS.has(flagName(arg)))) return false
    return true
  }

  if (subcommand === 'remote') {
    if (rest.length === 0) return true
    const [action, ...names] = rest
    if (action === '-v' || action === '--verbose') return names.length === 0
    if (action === 'show') return names.every((name) => !name.startsWith('-') || name === '-n')
    if (action === 'get-url') return names.every((name) => !name.startsWith('-') || name === '--all' || name === '--push')
    return false
  }

  return true
}

/**
 * 判断整条 git 命令是否只读；供 auto 与 plan 两套判定共用。
 */
export function isReadOnlyGitBashCommand(command: string): boolean {
  const tokens = tokenizeBashCommand(command.trim())
  if (!tokens || tokens[0] !== 'git') return false
  return isReadOnlyGitArgs(tokens.slice(1))
}

/** 非 git 命令的参数级只读校验。 */
function isReadOnlyNonGitArgs(tokens: string[]): boolean {
  const [command, ...args] = tokens
  switch (command) {
    case 'ls':
    case 'head':
    case 'tail':
    case 'grep':
    case 'wc':
    case 'stat':
    case 'du':
    case 'df':
    case 'which':
    case 'uname':
      // 这些命令本身不写文件、不执行子进程；重定向/管道已由结构检查拦截。
      return true
    case 'whoami':
    case 'pwd':
    case 'env':
      return args.length === 0
    case 'rg':
      // --pre/--pre-glob 会以 `COMMAND <path>` 执行外部程序。
      return !args.some((arg) => ['--pre', '--pre-glob'].includes(flagName(arg)))
    case 'file':
      // -C/--compile 会编译 magic 文件并写盘。
      return !args.some((arg) => ['-C', '--compile'].includes(flagName(arg)))
    case 'tree':
      // -o/--output 会写文件。
      return !args.some((arg) => ['-o', '--output'].includes(flagName(arg)))
    case 'node':
      return args.length === 1 && args[0] === '--version'
    case 'bun':
      return (args.length === 1 && args[0] === '--version')
        || (args.length === 2 && args[0] === 'pm' && args[1] === 'ls')
    case 'npm':
      return ['list', 'ls', 'view', 'info', 'outdated'].includes(args[0] ?? '')
    default:
      return false
  }
}

/**
 * 判断 Bash 命令是否可自动放行（只读）。
 *
 * 三层：结构检查 → 命令族白名单 → 参数级校验。第三层是必需的：
 * 只匹配命令名会让 `git diff --output=...`、`rg --pre ...`、`file -C` 这类
 * 「命令本身只读、参数带副作用」的调用全部漏过。
 */
export function isSafeBashCommand(command: string): boolean {
  const trimmed = command.trim()
  if (!trimmed || hasDangerousStructure(trimmed)) return false
  if (!SAFE_BASH_PATTERNS.some((pattern) => pattern.test(trimmed))) return false

  const tokens = tokenizeBashCommand(trimmed)
  if (!tokens || tokens.length === 0) return false
  if (tokens[0] === 'git') return isReadOnlyGitArgs(tokens.slice(1))
  return isReadOnlyNonGitArgs(tokens)
}

/** Windows PowerShell 的自动允许必须独立于 Bash：仅覆盖不读取内容、不写入、不启动进程的简单查询。 */
export const SAFE_POWERSHELL_PATTERNS: readonly RegExp[] = [
  /^(Get-Location|pwd)$/i,
  /^Get-Date$/i,
  /^Get-ChildItem$/i,
  /^Get-Process(?:\s+-Name\s+[A-Za-z0-9_.-]+)?$/i,
  /^Get-Command\s+[A-Za-z0-9_.-]+$/i,
  /^Get-Item\s+[^|><;&`$()]+$/i,
  /^Test-Path\s+[^|><;&`$()]+$/i,
]

/** PowerShell 命令拼接、管道、重定向、脚本块和子表达式一律不自动允许。 */
export function hasDangerousPowerShellStructure(command: string): boolean {
  return /[|><;&`{}]|\$\(|\$[A-Za-z_]/.test(command)
}

export function isSafePowerShellCommand(command: string): boolean {
  const trimmed = command.trim()
  if (hasDangerousPowerShellStructure(trimmed)) return false
  return SAFE_POWERSHELL_PATTERNS.some((pattern) => pattern.test(trimmed))
}

/**
 * 判断命令是否为危险命令
 */
export function isDangerousCommand(command: string): boolean {
  const trimmed = command.trim().toLowerCase()
  return DANGEROUS_COMMANDS.some((dc) => trimmed.startsWith(dc.toLowerCase()))
}
