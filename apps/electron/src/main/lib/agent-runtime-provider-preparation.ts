import type {
  AgentRuntimePreparedContext,
  AgentRuntimeProviderQueryPreparationPort,
  AgentRuntimeQuery,
} from '@profer/agent-runtime'
import { homedir } from 'node:os'
import { canonicalAgentToolName, type ProferPermissionMode } from '@profer/shared'
import { buildAgentSdkEnv } from './agent-sdk-env'
import { resolveHostAgentRuntimeEnv } from './agent-runtime-env-host'
import { resolveSDKCliPath } from './agent-sdk-cli-path'
import { getPiTranscriptDirForSession, getSdkConfigDir } from './config-paths'
import { collectPolicyDisallowedTools, readAgentRuntimePolicySnapshot, resolveProviderPermissionMode, stripAgentRuntimePolicyFromProviderInput } from './agent-runtime-policy-snapshot'
import { getAgentWorkspace, getWorkspaceAutoMemoryDir } from './agent-workspace-manager'
import { resolveAgentSessionWriteLayout } from './agent-session-manager'
import { resolveWorkspaceLocation } from './workspace-locator'
import { buildClaudeInlineSdkSettings } from './agent-claude-inline-sdk-settings'
import { buildRuntimeTurnPrompt, type RuntimeTurnPrompt } from './agent-runtime-turn-prompt'
import { fileWriteChips } from './agent-file-write-chips'
import { isPathInsideDirectory } from './agent-directory-utils'
import type { ShadowEvidenceLedger } from './workspace-shadow-write-evidence'

/** Claude 侧与旧链同源的 shell 事实（Pi 用 runtimeEnv 里的实测值）。 */
function claudeShellPath(): string | undefined {
  return process.env.SHELL
    ?? (process.platform === 'win32' ? undefined : process.platform === 'darwin' ? '/bin/zsh' : '/bin/sh')
}

/**
 * 本轮系统提示词的最终取值。
 *
 * 优先级刻意把**装配结果**放在 `prepared` 之前：`prepared.systemPrompt` 目前只承载工作区 profile
 * 正文（`createAgentQueryPreparationPort` 由 `projectInstructions` 拼成），那是装配输入的一部分，
 * 不是完整提示词。若让它优先，新链就永远拿不到核心规则 / 工具指南 / 预设段。
 */
function promptFromPrepared(
  input: AgentRuntimeQuery,
  prepared: AgentRuntimePreparedContext,
  assembled?: RuntimeTurnPrompt,
): string | { type: 'preset'; preset: 'claude_code'; append?: string } {
  return assembled?.systemPrompt
    ?? prepared.systemPrompt
    ?? prepared.resources?.systemPrompt
    ?? input.prompt
}

/**
 * 交给 provider 的权限模式。
 *
 * 只认两处来源：宿主挂载的有效策略快照（已收敛预设上限与合法覆盖），或调用方显式给出的
 * 合法覆盖。两者都没有时返回 undefined —— 这里刻意不再回落 `auto`：
 * 猜一个默认值会让「同一份策略」在不同入口下给出不同工具放行口径，属于 G4 的根因。
 * 策略快照的挂载责任在宿主入口（见 agent-runtime-policy-snapshot.ts 的接线说明）。
 */
function permissionModeFromInput(input: AgentRuntimeQuery): ProferPermissionMode | undefined {
  return resolveProviderPermissionMode(input.providerInput)
}

/** 工具装配 context 里宿主已解析的工作区 slug（`buildRuntimeHeadlessRunContext` 写入）。 */
function workspaceSlugFromQuery(input: AgentRuntimeQuery): string | undefined {
  const assembly = input.deferredToolAssemblyContext as { workspaceSlug?: unknown } | undefined
  if (typeof assembly?.workspaceSlug === 'string' && assembly.workspaceSlug) return assembly.workspaceSlug
  return input.workspaceId ? getAgentWorkspace(input.workspaceId)?.slug : undefined
}

/**
 * project 模式下要内联下发给 Claude SDK 的设置（P1-8 在 headless / 自动化 / 桌面新链上的补齐）。
 *
 * 与旧编排链（`AgentOrchestrator.sendMessage`）同一判据、同一 builder：
 * - 只有 `resolveWorkspaceLocation(slug).mode === 'project'` 才返回对象；managed 返回 `undefined`，
 *   让 SDK 继续读 cwd 下的 `.claude/settings.json`（旧行为逐字不变）；
 * - `plansDirectory` 与磁盘 settings 同值（相对项目根的合法相对路径），`autoMemoryDirectory` 取工作区记忆目录；
 * - 工作区根缺失 / 布局解析失败时返回 `undefined`（不猜路径、不写文件），与入口的保守止损一致。
 *
 * 为什么在这里解析而不是宿主入口：provider preparation 是 runtime 链（headless / remote / automation /
 * 桌面新链）通往 provider 的唯一必经点，查询上已带 `sessionId` + `workspaceId`（或装配 context 的
 * `workspaceSlug`），无需改 runtime 公共契约即可得到与会话写入布局一致的设置。
 */
function claudeInlineSdkSettingsFromQuery(input: AgentRuntimeQuery): Record<string, unknown> | undefined {
  const slug = workspaceSlugFromQuery(input)
  if (!slug) return undefined
  if (resolveWorkspaceLocation(slug).mode !== 'project') return undefined
  try {
    const layout = resolveAgentSessionWriteLayout(slug, input.sessionId)
    return buildClaudeInlineSdkSettings({
      projectMode: true,
      plansDirectory: layout.plansDirectory,
      autoMemoryDirectory: getWorkspaceAutoMemoryDir(slug),
    })
  } catch {
    // 工作区根不存在 / 布局不可解析：让 SDK 回退默认目录，绝不把项目根当写入口。
    return undefined
  }
}

/**
 * 新链 provider preparation 的宿主环境解析依赖。
 *
 * `resolveRuntimeEnv` 可注入：测试用 fixture 直接验证「新链把 runtimeEnv 传给 Pi provider」
 * 而不真的去启动登录 shell 采快照；生产不传时用同一条宿主实现。
 */
export interface ElectronProviderQueryPreparationOptions {
  resolveRuntimeEnv?: typeof resolveHostAgentRuntimeEnv
}

/** Electron 组合根的最小 provider-specific query builder；预设策略经 providerInput 传入，本函数不重新解释。 */
export function createElectronProviderQueryPreparation(
  options: ElectronProviderQueryPreparationOptions = {},
): AgentRuntimeProviderQueryPreparationPort {
  const resolveRuntimeEnv = options.resolveRuntimeEnv ?? resolveHostAgentRuntimeEnv
  return {
    async prepare(input, prepared, signal) {
      signal.throwIfAborted()
      const credentials = prepared.credentials
      if (!credentials) throw new Error('Provider query preparation requires resolved credentials')
      const permissionMode = permissionModeFromInput(input)
      // 装配结果优先于 `prepared.systemPrompt`（后者只是工作区 profile 正文）。
      const claudeTurnPrompt = buildRuntimeTurnPrompt(input, { shellPath: claudeShellPath() })
      const systemPrompt = promptFromPrepared(input, prepared, claudeTurnPrompt)
      // 快照不进 provider options：provider 只应看到 permissionMode 这类自己能理解的字段。
      const providerInput = stripAgentRuntimePolicyFromProviderInput(input.providerInput)
      const snapshot = readAgentRuntimePolicySnapshot(input.providerInput)
      const disallowedTools = [...new Set([
        ...((providerInput.disallowedTools as readonly string[] | undefined) ?? []),
        ...(prepared.disallowedTools ?? []),
        ...(snapshot ? collectPolicyDisallowedTools(snapshot) : []),
      ].map(canonicalAgentToolName))]
      if (input.runtime === 'claude') {
        // project 下 cwd 是用户项目根：storageDir 那份 `.claude/settings.json` 对 SDK 是惰性的，
        // 必须把同一组设置内联成 flag settings 层（与旧链 P1-8 同一 builder、同一值）。
        const inlineSdkSettings = claudeInlineSdkSettingsFromQuery(input)
        // 与旧链同源：完整 SDK env（PATH / 代理 / CLAUDE_CONFIG_DIR / 随包 CLI /
        // Windows Git Bash|WSL / CLAUDE_BASH_NO_LOGIN / ANTHROPIC_* 回流加固），
        // 不再只生成认证变量。凭证只进入本次 query 的 env 副本。
        const env = await buildAgentSdkEnv(credentials)
        return {
          ...providerInput,
          sdkCliPath: resolveSDKCliPath(),
          env,
          ...(permissionMode
            ? {
                sdkPermissionMode: permissionMode,
                allowDangerouslySkipPermissions: permissionMode === 'bypassPermissions',
              }
            : {}),
          systemPrompt,
          cwd: input.cwd,
          ...(inlineSdkSettings ? { settings: inlineSdkSettings } : {}),
          ...(prepared.tools !== undefined ? { tools: [...prepared.tools] } : {}),
          ...(prepared.mcpServers !== undefined ? { mcpServers: prepared.mcpServers } : {}),

          ...(prepared.plugins !== undefined ? { plugins: [...prepared.plugins] } : {}),
          ...(prepared.skills !== undefined ? { skills: [...prepared.skills] } : {}),
          ...(prepared.allowedTools !== undefined ? { allowedTools: [...prepared.allowedTools] } : {}),
          disallowedTools,
          ...(prepared.canUseTool ? { canUseTool: prepared.canUseTool } : {}),
          ...(input.runtimeSessionId ? { resumeSessionId: input.runtimeSessionId } : {}),
          ...(input.providerInput?.resumeSessionAt ? { resumeSessionAt: input.providerInput.resumeSessionAt } : {}),
          ...(input.additionalDirectories ? { additionalDirectories: [...input.additionalDirectories] } : {}),
        }
      }

      // Pi runtimeEnv 与旧链同源（宿主状态 / 登录 shell 快照 / 平台判定只有一份实现）：
      // 缺它时 Windows 丢失 Git Bash|WSL 选择、macOS/Linux 丢失经过存在性校验的 Bash 绝对路径。
      const runtimeEnv = await resolveRuntimeEnv({
        sessionId: input.sessionId,
        // 无 cwd 时与旧链一样用用户主目录（绝不用 process.cwd()：桌面启动目录不可预测）。
        cwd: input.cwd ?? homedir(),
      })
      // Pi 的工具在 adapter 内装配，但 shell 路径本轮已实测：用同一份事实装配提示词。
      const piTurnPrompt = buildRuntimeTurnPrompt(input, {
        ...(runtimeEnv?.shellPath ? { shellPath: runtimeEnv.shellPath } : {}),
        ...(prepared.resources?.skillCatalog ? { skillCatalog: prepared.resources.skillCatalog } : {}),
      })
      const piSystemPrompt = promptFromPrepared(input, prepared, piTurnPrompt)
      // Shadow Git 的受控写入回调：Bash 提升的写入不会出现在 tool_use 里，只能靠这条补。
      // 草稿区（会话私有存储）不算用户改动，与旧链同一判据。
      const piShadowLedger = input.metadata?.shadowLedger as ShadowEvidenceLedger | undefined
      const piShadowSlug = workspaceSlugFromQuery(input)
      const piShadowStorageDir = piShadowSlug
        ? resolveAgentSessionWriteLayout(piShadowSlug, input.sessionId)?.storageDir
        : undefined
      return {
        ...providerInput,
        apiKey: credentials.apiKey,
        baseUrl: credentials.baseUrl,
        provider: credentials.provider,
        codexOAuthCredentials: credentials.codexOAuthCredentials,
        xaiOAuthCredentials: credentials.xaiOAuthCredentials,
        xaiCredentialMode: credentials.xaiCredentialMode,
        xaiApiProtocol: credentials.xaiApiProtocol,
        ...(permissionMode ? { permissionMode } : {}),
        systemPrompt: typeof piSystemPrompt === 'string' ? piSystemPrompt : piSystemPrompt.append ?? input.prompt,
        ...(piTurnPrompt?.taskPrompt ? { taskPrompt: piTurnPrompt.taskPrompt } : {}),
        // Pi 的工具在本 adapter 内才装配：工具名确定后用同一份 builder 重算提示词，
        // 避免提示词里描述一个本轮没有注册的工具。
        resolvePromptForTools: (toolNames: string[]) => {
          const resolved = buildRuntimeTurnPrompt(input, {
            ...(runtimeEnv?.shellPath ? { shellPath: runtimeEnv.shellPath } : {}),
            ...(prepared.resources?.skillCatalog ? { skillCatalog: prepared.resources.skillCatalog } : {}),
            toolNames,
          })
          const systemPrompt = resolved
            ? typeof resolved.systemPrompt === 'string' ? resolved.systemPrompt : resolved.systemPrompt.append ?? input.prompt
            : typeof piSystemPrompt === 'string' ? piSystemPrompt : piSystemPrompt.append ?? input.prompt
          return { systemPrompt, ...(resolved?.taskPrompt ? { taskPrompt: resolved.taskPrompt } : {}) }
        },
        ...(prepared.tools !== undefined ? { customTools: [...prepared.tools] } : {}),
        ...(prepared.mcpServers !== undefined ? { mcpServers: prepared.mcpServers } : {}),

        ...(prepared.plugins !== undefined ? { plugins: [...prepared.plugins] } : {}),
        ...(prepared.skills !== undefined ? { skills: [...prepared.skills] } : {}),
        ...(prepared.allowedTools !== undefined ? { allowedTools: [...prepared.allowedTools] } : {}),
        disallowedTools,
        ...(prepared.canUseTool ? { canUseTool: prepared.canUseTool } : {}),
        piAgentDir: getSdkConfigDir(),
        piSessionDir: getPiTranscriptDirForSession(input.sessionId),
        runtimeEnv,
        cwd: input.cwd,
        ...(input.runtimeSessionId ? { resumeSessionId: input.runtimeSessionId } : {}),
        ...(input.providerInput?.resumeSessionAt ? { resumeSessionAt: input.providerInput.resumeSessionAt } : {}),
        ...(input.additionalDirectories ? { additionalDirectories: [...input.additionalDirectories] } : {}),
        // 受控写入回调始终注册：消息气泡里的文件改动 chip 依赖它（旧链同一份事实）。
        // 草稿区（会话私有存储）不是用户要 review 的改动，chip 与归属都不该看到。
        onFileWrite: (toolCallId: string, fact: { path: string; source: string }) => {
          if (piShadowStorageDir && isPathInsideDirectory(fact.path, piShadowStorageDir)) return
          fileWriteChips.record(input.sessionId, toolCallId, { path: fact.path, source: fact.source })
          piShadowLedger?.push({
            toolUseId: toolCallId,
            path: fact.path,
            source: fact.source === 'bash' ? 'bash' : fact.source === 'edit' ? 'edit' : 'write',
          })
        },
      }
    },
  }
}
