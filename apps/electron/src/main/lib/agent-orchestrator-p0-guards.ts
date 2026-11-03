import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { AgentRuntime, Channel, ProviderType, SDKMessage } from '@profer/shared'
import { isChannelEnabledForRuntime, canonicalAgentToolName } from '@profer/shared'
import { normalizeAnthropicBaseUrlForSdk } from '@profer/core'
import { applyAgentSdkAuthEnv } from './agent-sdk-auth-env'

/**
 * 本次发送未获得运行所有权；它不是 owner run 的流式错误或终态。
 *
 * 类型定义在 `@profer/shared`（与 `AgentSessionRuntimeMismatchError` 同处），因为新旧两条
 * 执行链都要抛它、宿主入口都要按 `instanceof` 识别它。这里只做转发，不再本地定义，
 * 避免出现两个同名类导致 runtime 抛出的错误无法被入口 `instanceof` 识别。
 */
export { AgentRunAlreadyActiveError } from '@profer/shared'

/** 在任意 await 前原子占用会话；false 表示已有同 session 运行。 */
export function tryAcquireActiveSession(activeSessions: Map<string, string>, sessionId: string, runToken: string): boolean {
  if (activeSessions.has(sessionId)) return false
  activeSessions.set(sessionId, runToken)
  return true
}

/** 仅持有当前 token 的运行可以释放会话，避免旧 finally 清掉新运行。 */
export function releaseActiveSession(activeSessions: Map<string, string>, sessionId: string, runToken: string): boolean {
  if (activeSessions.get(sessionId) !== runToken) return false
  activeSessions.delete(sessionId)
  return true
}

/**
 * 原子保留本次排队消息 UUID。false 表示相同 UUID 已被当前 run 接收，
 * 调用方不得再次注入 adapter 或持久化 JSONL。
 */
export function tryReserveQueuedMessage(uuids: Set<string>, uuid: string): boolean {
  if (uuids.has(uuid)) return false
  uuids.add(uuid)
  return true
}

/** Pi 的 sendQueuedMessage(interrupt) 自己先建立 reservation 再 abort；不能预先 interruptQuery。 */
export function shouldPreInterruptQueuedMessage(runtime: AgentRuntime, interrupt: boolean | undefined): boolean {
  return interrupt === true && runtime !== 'pi'
}

/**
 * xAI 渠道能否服务指定 Agent 内核 —— Agent 预检的唯一判据。
 *
 * 必须按「用户在渠道上勾选的 Agent 内核」判定，不能沿用 `isAgentEnabledForChannel`：
 * 后者已是 `@deprecated` 兼容别名，语义收敛为「是否勾选 Claude 内核」，而 xAI 按设计
 * （无 Anthropic 端点）永远不获得 claude 内核，于是任何 xAI 渠道都会被判为「未开启
 * 实验性 Agent」，即使开关真的开着 —— 这会让 xAI + Pi 的实验链路永久无法启动。
 *
 * 非 xAI 渠道不受本规则约束，由各自的 provider 门禁负责。
 */
export function isXaiChannelAvailableForRuntime(
  channel: Pick<Channel, 'provider' | 'enabled' | 'agentExperimentalEnabled' | 'agentRuntimes'>,
  agentRuntime: AgentRuntime,
): boolean {
  if (channel.provider !== 'xai') return true
  return agentRuntime === 'pi' && isChannelEnabledForRuntime(channel, 'pi')
}

/**
 * Plan 模式只允许写入当前会话计划目录内的 Markdown 文件。
 *
 * `planDir` 是计划目录的真相源，由宿主显式传入（`resolveAgentSessionWriteLayout().plansDir`）：
 * - managed：等于 `<agentCwd>/.context/plan`，与改造前逐字一致；
 * - project：在中央 storageDir 内，**不在项目根**，所以不能再按 cwd 推导。
 *
 * 缺省时回落到 `<agentCwd>/.context/plan`，保留旧调用方语义。
 * 相对 `filePath` 仍按 `agentCwd` 解析（SDK/Pi 的相对路径基准是 cwd）；project 下提示词给的是
 * storageDir 内的绝对路径，两种形式都能正确命中。
 */
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

/** `ensureAgentSessionSdkSettings` 的输入：全部取自会话写入布局，调用方不得自己拼 cwd。 */
export interface AgentSessionSdkSettingsInput {
  /** 会话私有存储根：managed = cwd；project = 中央 storageDir（**永不**是项目根）。 */
  storageDir: string
  /** 写入 `plansDirectory` 的值；`undefined` 表示删除该键（跨盘符时无合法相对路径）。 */
  plansDirectory?: string
  /** 工作区自动记忆目录；无工作区时保持 undefined。 */
  autoMemoryDirectory?: string
}

/**
 * 准备 SDK 项目设置（`<storageDir>/.claude/settings.json`）。
 *
 * 为什么目标不是 cwd：project 下 cwd 是用户项目根，写 `<root>/.claude/settings.json` 会覆盖
 * 用户自己的 Claude 配置、并在仓库里留下 `.claude/`（违反 I3）。managed 下 storageDir === cwd，
 * 文件路径与内容与改造前逐字一致。
 *
 * 如实记录：SDK 的项目设置只从 **cwd** 读取，且 Claude provider 没有透传
 * `queryOptions.settings` 内联对象，所以 project 下这份副本对 SDK 是惰性的。计划落点由
 * 提示词（storageDir 绝对路径）+ `isPlanModeMarkdownPath(agentCwd, path, plansDir)` 保证。
 */
export function ensureAgentSessionSdkSettings(input: AgentSessionSdkSettingsInput): { settingsPath: string; wrote: boolean } {
  const settingsPath = join(input.storageDir, '.claude', 'settings.json')
  const claudeDir = dirname(settingsPath)
  if (!existsSync(claudeDir)) mkdirSync(claudeDir, { recursive: true })

  let sdkSettings: Record<string, unknown> = {}
  try {
    sdkSettings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
  } catch {
    /* 文件不存在或解析失败：按空设置重建 */
  }

  let needsWrite = false
  if (input.plansDirectory === undefined) {
    if ('plansDirectory' in sdkSettings) {
      delete sdkSettings.plansDirectory
      needsWrite = true
    }
  } else if (sdkSettings.plansDirectory !== input.plansDirectory) {
    sdkSettings.plansDirectory = input.plansDirectory
    needsWrite = true
  }
  if (sdkSettings.skipWebFetchPreflight !== true) {
    sdkSettings.skipWebFetchPreflight = true
    needsWrite = true
  }
  if (sdkSettings.autoMemoryDirectory !== input.autoMemoryDirectory) {
    sdkSettings.autoMemoryDirectory = input.autoMemoryDirectory
    needsWrite = true
  }
  if (!needsWrite) return { settingsPath, wrote: false }

  writeFileSync(settingsPath, JSON.stringify(sdkSettings, null, 2))
  return { settingsPath, wrote: true }
}

/**
 * 仅向本轮 query env 写入凭证，绝不改动 process.env。
 * 调用方负责先准备好从 process.env 过滤过的基础环境。
 */
export function applySdkCredentials(
  sdkEnv: Record<string, string | undefined>,
  apiKey: string,
  baseUrl: string | undefined,
  provider: ProviderType,
  forceBearerAuth = false,
): void {
  applyAgentSdkAuthEnv(sdkEnv, provider, apiKey, forceBearerAuth)
  if (baseUrl && baseUrl !== 'https://api.anthropic.com') {
    sdkEnv.ANTHROPIC_BASE_URL = normalizeAnthropicBaseUrlForSdk(baseUrl)
  }
}

/** Pi 流式预览仅用于实时 UI，绝不能进入会话历史。 */
export function isPartialSDKMessage(message: SDKMessage): boolean {
  return (message as Record<string, unknown>)._partial === true
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

/**
 * 把已按预设 policy 过滤过的 skill mentions 转成 Pi query / queue 选项片段。
 *
 * Pi adapter 已支持 `skillMentions` 正文内联展开；编排层此前没有透传，
 * 导致显式 `/skill:xxx` 只能依赖 catalog 描述。空数组不产生字段，
 * 未显式引用 Skill 时保持既有 query 形态不变。
 */
export function buildPiSkillMentionOptions(allowedSkillSlugs: readonly string[]): { skillMentions?: string[] } {
  return allowedSkillSlugs.length > 0 ? { skillMentions: [...allowedSkillSlugs] } : {}
}
