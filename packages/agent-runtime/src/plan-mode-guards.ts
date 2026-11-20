import { isAbsolute, relative, resolve } from 'node:path'
import { canonicalAgentToolName } from '@profer/shared'

export function isPlanModeMarkdownPath(agentCwd: string, filePath: string, planDir?: string): boolean {
  const resolvedPlanDir = planDir && planDir.trim() ? resolve(planDir) : resolve(agentCwd, '.context', 'plan')
  const targetPath = resolve(agentCwd, filePath)
  const relativePath = relative(resolvedPlanDir, targetPath)
  const isWithinPlanDir = relativePath !== ''
    && !isAbsolute(relativePath)
    && relativePath !== '..'
    && !relativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
  return filePath.toLowerCase().endsWith('.md') && isWithinPlanDir
}

/** MCP 名称在 Plan 模式下无法可靠判定只读性，必须拒绝。 */
export function isPlanModeMcpTool(toolName: string): boolean {
  return toolName.startsWith('mcp__')
}

/** MCP 与 Pi 两条 Runtime 共用同一套 Browser 工具逻辑名。 */
export function isBrowserToolName(toolName: string): boolean {
  return canonicalAgentToolName(toolName).startsWith('Browser')
}

/**
 * 计划模式下允许的只读浏览器工具。
 *
 * 这份白名单是唯一事实源：编排层 canUseTool 与单测共用它，避免两处规则漂移。
 * 其余 Browser* 操作（导航、点击、填表、新建/关闭标签、执行脚本等）在计划模式下必须拒绝。
 */
export const PLAN_MODE_READ_ONLY_BROWSER_TOOLS: ReadonlySet<string> = new Set([
  'BrowserObserve',
  'BrowserExtract',
  'BrowserScreenshot',
  'BrowserListTabs',
  'BrowserPreviewOpen',
])

/** 浏览器工具权限决策（与 SDK PermissionResult 的 allow/deny 语义一致）。 */
export interface BrowserToolPermissionDecision {
  behavior: 'allow' | 'deny'
  message?: string
}

/**
 * 计划模式下的受管浏览器权限判定。
 *
 * 调用点必须在通用权限 switch **之前**：该 switch 的每个分支都会 return，
 * 放在其后会变成不可达代码（这正是本次修复的缺陷）。
 * 非 plan 模式由通用分派继续处理，保持 auto / bypassPermissions 既有行为不变。
 */
export function resolvePlanModeBrowserPermission(toolName: string): BrowserToolPermissionDecision {
  if (PLAN_MODE_READ_ONLY_BROWSER_TOOLS.has(canonicalAgentToolName(toolName))) return { behavior: 'allow' }
  return {
    behavior: 'deny',
    message: '计划模式下只能观察受管浏览器，请在计划获批后再进行网页交互。',
  }
}
