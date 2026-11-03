/**
 * plan-mode-tool-policy —— 计划模式只读工具面的**唯一规则来源**（GAP-5）。
 *
 * 背景：这三组规则原先只是 `agent-orchestrator.ts` 里 `canUseTool` 闭包内的局部量
 * （`isBashCommandReadOnly` / `PLAN_MODE_ALLOWED_TOOLS` / `DEFERRED_OR_PROACTIVE_TOOLS`），
 * 外部无法 import，于是新入口只能应用「共享 helper 能判定的部分」，其余工具交回宿主判定 ——
 * 结果是同一份计划模式下两套判定口径。
 *
 * 本模块把三组规则原样提取为可 import 的实现，并提供 `createPlanModeToolPolicy()`：
 * 新宿主把它作为 `planToolPolicy` 注入 `agent-runtime-plan-mode.ts` 的门禁，
 * 旧编排层把 `case 'plan'` 分支改为调用同一实现（替换清单见交付目录 integration-requests.md）。
 *
 * 位置论证（为什么不放 `packages/shared` / runtime 侧）：
 * 1. 规则的**消费者**只有两个，且都在 Electron 主进程：旧 `agent-orchestrator.ts` 与新
 *    `agent-runtime-plan-mode.ts` 门禁；runtime core 与 provider 永远不消费它们
 *    （计划只读面是宿主权限策略，不是 runtime 契约）。
 * 2. 同族 helper（`isPlanModeMcpTool` / `isPlanModeMarkdownPath` / `isPlanModeBrowserTool` /
 *    `resolvePlanModeBrowserPermission`）已在 `agent-orchestrator-p0-guards.ts`，本模块直接复用，
 *    不复制第二份判定。
 * 3. 放 `packages/shared` 需要新增子路径导出注册（本批由集成会话执行），会让本 lane 的
 *    「同一输入两侧判定一致」测试无法运行 —— 而该测试正是本次交付的核心证据。
 *
 * 语义边界（**不得放宽**）：
 * - 计划模式下未被明确允许的工具一律 deny，绝不静默放行；
 * - 只有三类工具交回宿主既有判定（`undefined`），因为它们在两侧都在本规则之前被处理：
 *   `AskUserQuestion`（宿主问答闭环）、`EnterPlanMode` / `ExitPlanMode`（宿主计划态与审批）。
 */

import {
  hasDangerousStructure,
  isReadOnlyGitBashCommand,
} from '@profer/shared'
import {
  isBrowserToolName,
  isPlanModeMarkdownPath,
  isPlanModeMcpTool,
  resolvePlanModeBrowserPermission,
} from './agent-orchestrator-p0-guards'

/**
 * Plan 模式下允许的只读工具（不含 Write/Edit/Bash 等写操作）。
 *
 * 逐条对齐旧 `agent-orchestrator.ts` 的同名集合，顺序与内容均不得改动。
 */
export const PLAN_MODE_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  'Read',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
  'Agent',
  'TodoRead',
  'TodoWrite',
  'TaskOutput',
  'TaskCreate',
  'TaskUpdate',
  'TaskList',
  'TaskGet',
  'ListMcpResourcesTool',
  'ReadMcpResourceTool',
])

/** 计划模式下必须拒绝的延迟 / 主动能力（后台、定时、通知、脚本执行）。 */
export const DEFERRED_OR_PROACTIVE_TOOLS: ReadonlySet<string> = new Set([
  'REPL',
  'Workflow',
  'ScheduleWakeup',
  'Monitor',
  'PushNotification',
  'CronCreate',
  'CronDelete',
  'RemoteTrigger',
])

/**
 * 判断 Bash 命令是否是只读的（计划模式下安全可执行）。
 *
 * 检测写操作特征：文件重定向、破坏性命令、包管理写操作、git 写操作等。
 * 逐条对齐旧实现：正则、判定顺序、返回语义完全一致；只读判定失败即视为写操作。
 */
export function isBashCommandReadOnly(command: string): boolean {
  const trimmed = command.trim()
  if (!trimmed) return false
  // 先共用结构检查：换行、管道、重定向、命令拼接、子 shell、后台执行。
  // 这些结构会让下面的 deny-list 失效（例如 `git log\nrm -rf /`）。
  if (hasDangerousStructure(trimmed)) return false
  // git 的写操作与带副作用的参数交给共享判定，避免 auto / plan 两套规则各漏一半。
  if (/^git(\s|$)/.test(trimmed)) return isReadOnlyGitBashCommand(trimmed)
  // 输出重定向：匹配未被数字或 & 前置的 > 符号（排除 2>/dev/null、&> 等 fd 重定向）
  if (/(?<![0-9&])>/.test(trimmed)) return false
  // 破坏性文件操作
  if (/\b(rm|rmdir)\s/.test(trimmed)) return false
  if (/\bsed\s+[^|&;]*-i/.test(trimmed)) return false  // sed -i 原地编辑
  if (/\b(chmod|chown|chattr|truncate)\s/.test(trimmed)) return false
  if (/\b(mv|cp)\s/.test(trimmed)) return false
  if (/\b(mkdir|touch|mktemp)\s/.test(trimmed)) return false
  // 包管理器写操作
  if (/\b(npm|pnpm|yarn|bun)\s+(install|i\b|add|remove|uninstall|update|upgrade|link|unlink)\b/.test(trimmed)) return false
  if (/\bpip[23]?\s+(install|uninstall|upgrade)\b/.test(trimmed)) return false
  if (/\b(apt|apt-get|brew|yum|dnf)\s+(install|remove|purge|uninstall|upgrade)\b/.test(trimmed)) return false
  // Git 写操作
  if (/\bgit\s+(commit|push|checkout\s+-[bB]|branch\s+-[mMdD]|merge\b|rebase\b|reset\b|stash\s+(drop|pop)\b|add\b|apply\b|cherry-pick\b)/.test(trimmed))
    return false
  // 进程控制
  if (/\b(kill|killall|pkill)\s/.test(trimmed)) return false
  // 脚本执行（具有潜在副作用，如 node script.js / python main.py）
  if (/\b(node|python[23]?|ruby|perl|php)\s+[^-]/.test(trimmed)) return false
  // 解释器内联执行：python -c / node -e / perl -e / php -r / ruby -e
  if (/\b(node|python[23]?|ruby|perl|php)\s+(-e|--eval|-c|-r)\b/.test(trimmed)) return false
  // shell 内联执行与环境变量注入（env VAR=x cmd 会执行 cmd）
  if (/^(sh|bash|zsh|fish)\s+(-c|--command)\b/.test(trimmed)) return false
  if (/^(eval|exec|source|\.)\s/.test(trimmed)) return false
  if (/^env\s+\S/.test(trimmed)) return false
  // 外部程序执行 / 写文件原语（管道已被结构检查拦截，这里只需看命令位置）
  if (/^(xargs|tee|dd|install|ln|open|osascript|launchctl)\b/.test(trimmed)) return false
  if (/^defaults\s+write\b/.test(trimmed)) return false
  if (/^(npm|pnpm|yarn|bun)\s+(exec|x)\b/.test(trimmed)) return false
  // 搜索/文件工具的副作用参数
  if (/^rg\b[^|&;]*\s--pre(=|\s)/.test(trimmed)) return false
  if (/^file\b[^|&;]*\s(-C|--compile)(\s|=|$)/.test(trimmed)) return false
  if (/^tree\b[^|&;]*\s(-o|--output)(\s|=|$)/.test(trimmed)) return false
  if (/^find\b[^|&;]*\s-(fprint|fprintf|fls)\b/.test(trimmed)) return false
  // awk 的 system() 可执行任意命令
  if (/\bsystem\s*\(/.test(trimmed)) return false
  return true
}

/** 计划模式下单条工具的判定结果；`undefined` 表示本策略不负责该工具。 */
export interface PlanModeToolPolicyDecision {
  behavior: 'allow' | 'deny'
  message?: string
}

export interface PlanModeToolPolicyInput {
  toolName: string
  toolInput: Record<string, unknown>
}

export type PlanModeToolPolicy = (input: PlanModeToolPolicyInput) => PlanModeToolPolicyDecision | undefined

/** 计划模式下由宿主在本策略之前处理的工具（本策略返回 undefined，交回宿主既有判定）。 */
export const HOST_OWNED_PLAN_TOOLS: ReadonlySet<string> = new Set([
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
])

/** 拒绝文案：与旧 `canUseTool` 的 `case 'plan'` 分支逐字一致。 */
export const PLAN_MODE_DENY_MESSAGES = {
  write: '计划模式下仅允许写入当前会话 .context/plan/ 目录内的 Markdown 计划文件',
  bash: '计划模式下不允许执行写操作，请在计划审批通过后再执行',
  mcp: '计划模式下不允许调用 MCP 工具；请在计划审批通过后执行可能具有副作用的外部操作',
  deferred: '计划模式下不允许启动后台、定时、通知或脚本执行能力，请在计划审批通过后再执行',
  fallback: '计划模式下不允许执行写操作，请在计划审批通过后再执行',
} as const

/**
 * 构造计划模式只读工具策略。
 *
 * 判定顺序与旧 `canUseTool` 一致：
 * 1. 宿主自有工具（问答 / 计划进出）→ `undefined`（交回宿主既有判定）；
 * 2. 受管浏览器：只读白名单放行，其余拒绝；
 * 3. `PLAN_MODE_ALLOWED_TOOLS` 放行；
 * 4. `Write` / `Edit`：仅允许写当前会话 `.context/plan/` 下的 Markdown；
 * 5. `Bash`：仅允许只读命令；
 * 6. MCP（`mcp__*`）拒绝；
 * 7. `DEFERRED_OR_PROACTIVE_TOOLS` 拒绝；
 * 8. 其余一律拒绝（**不静默放行**）。
 *
 * `agentCwd` 缺失时计划目录白名单不可判定，Write/Edit 一律拒绝。
 *
 * `planDir` 是计划目录的真相源（宿主传 `resolveAgentSessionWriteLayout().plansDir`）：
 * project 下它不在 cwd 之内，不能由 `agentCwd/.context/plan` 推导；managed 下两者相等。
 */
export function createPlanModeToolPolicy(agentCwd: string | undefined, planDir?: string): PlanModeToolPolicy {
  return ({ toolName, toolInput }) => {
    // 1. 宿主自有工具：本策略不表态，由宿主既有判定（问答闭环 / 计划审批）处理。
    if (HOST_OWNED_PLAN_TOOLS.has(toolName)) return undefined

    // 2. 受管浏览器：计划模式下只允许观察。
    if (isBrowserToolName(toolName)) {
      const decision = resolvePlanModeBrowserPermission(toolName)
      return decision.behavior === 'allow'
        ? { behavior: 'allow' }
        : { behavior: 'deny', message: decision.message }
    }

    // 3. 只读工具白名单。
    if (PLAN_MODE_ALLOWED_TOOLS.has(toolName)) return { behavior: 'allow' }

    // 4. Write / Edit：仅计划目录内的 Markdown（旧实现只认 file_path）。
    if (toolName === 'Write' || toolName === 'Edit') {
      const filePath = typeof toolInput.file_path === 'string' ? toolInput.file_path : ''
      if (agentCwd && filePath && isPlanModeMarkdownPath(agentCwd, filePath, planDir)) return { behavior: 'allow' }
      return { behavior: 'deny', message: PLAN_MODE_DENY_MESSAGES.write }
    }

    // 5. Bash：只读命令放行，写操作拒绝。
    if (toolName === 'Bash') {
      const command = typeof toolInput.command === 'string' ? toolInput.command : ''
      if (isBashCommandReadOnly(command)) return { behavior: 'allow' }
      return { behavior: 'deny', message: PLAN_MODE_DENY_MESSAGES.bash }
    }

    // 6. MCP：名称无法可靠表达只读性，计划模式一律拒绝。
    if (isPlanModeMcpTool(toolName)) {
      return { behavior: 'deny', message: PLAN_MODE_DENY_MESSAGES.mcp }
    }

    // 7. 延迟 / 主动能力。
    if (DEFERRED_OR_PROACTIVE_TOOLS.has(toolName)) {
      return { behavior: 'deny', message: PLAN_MODE_DENY_MESSAGES.deferred }
    }

    // 8. 其余工具拒绝（默认拒绝，不是默认放行）。
    return { behavior: 'deny', message: PLAN_MODE_DENY_MESSAGES.fallback }
  }
}
