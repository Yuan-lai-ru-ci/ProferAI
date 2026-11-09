/**
 * 新 runtime 链的**系统提示词装配**（与旧编排器同一份实现，不另立规则）。
 *
 * 为什么需要这个模块：
 * 新链此前没有系统提示词装配——`ResourcePort` 只返回工作区 profile 正文，
 * `promptFromPrepared` 在拿不到时甚至回落成「用户消息当系统提示词」。旧链则走
 * `assembleAgentSystemPrompt`（核心规则 / 工具指南 / 预设段 / 平台 overlay / 记忆 / 生图契约 /
 * 子 Agent 策略 / 工作区路径）。两条链的提示词因此不是「差一点」，而是两个东西。
 *
 * 本模块只做**输入收敛**：把新链手里已有的事实（策略快照 / 会话元数据 / 工作区 / 模型）
 * 映射成旧链同一份 builder 的入参，然后调用同一个 `assembleAgentSystemPrompt`。
 * 这里不复制任何提示词文本，也不重新解释预设策略——那些仍由 builder 与 shared 唯一持有。
 *
 * 边界：
 * - 拿不到策略快照时返回 `undefined`（调用方沿用既有回落），绝不按「猜一个默认预设」装配：
 *   猜出来的提示词会描述一个本轮并未生效的能力边界。
 * - 本轮动态上下文（工作区/MCP 名单/禁用工具组）、`@` 引用、任务 SOP 追加仍由 S1.2 负责，
 *   本模块只产出 system 段与 Pi 的 taskPrompt。
 */

import type { AgentRuntimeQuery } from '@profer/agent-runtime'
import { appendRunOriginPrompt } from '@profer/agent-runtime'
import { AGENT_PRESET_CAPABILITY_GROUPS } from '@profer/shared'
import type { AgentPresetToolGroup } from '@profer/shared'
import { assembleAgentSystemPrompt } from './agent-prompt-assembly'
import type { SystemPromptContext } from './agent-prompt-builder'
import {
  resolveAgentRuntimeSystemPrompt,
  resolveAgentSystemPromptPolicy,
  type AgentRuntimeSystemPrompt,
} from './agent-system-prompt-policy'
import { agentRuntimePolicyRuns } from './agent-runtime-policy-snapshot'
import { getAgentSessionMeta } from './agent-session-manager'
import { getAgentWorkspace } from './agent-workspace-manager'
import { resolveAgentModelRouting } from './agent-model-routing'
import { detectAttachedDirectoryProjects } from './attached-directory-project-detector'
import { getSettings } from './settings-service'
import { buildDynamicContext } from './agent-prompt-context'
import { buildReferencedSessionsPrompt, formatContextHistoryBlock } from './agent-prompt-utils'
import { getAgentSessionSDKMessages } from './agent-session-manager'

export interface RuntimeTurnPrompt {
  /** 交给 provider 的最终形态：Claude 是 `claude_code` preset + append，Pi 是纯文本。 */
  systemPrompt: AgentRuntimeSystemPrompt
  /** Pi 专用：随本轮新用户消息追加的任务 SOP（Claude 已包含在 system 里）。 */
  taskPrompt: string
}

export interface RuntimeTurnPromptOptions {
  /** 本轮已经解析过的 shell 路径（Pi 由 provider preparation 解析，避免重复起登录 shell）。 */
  shellPath?: string
  /**
   * 本轮实际注册的工具名。
   *
   * Pi 的工具在 adapter 内装配，宿主先不知道；缺省空数组表示「不描述未注册的工具」，
   * 由 `resolvePromptForTools` 在装配完成后重算（见 `pi-agent-adapter.ts`）。
   */
  toolNames?: readonly string[]
  /** Skill 目录（Pi 由资源端口构建；Claude 由 SDK 自己发现，不传）。 */
  skillCatalog?: string
}

/** 查询上已解析的工作区 slug（`buildRuntimeHeadlessRunContext` 写入装配 context）。 */
function workspaceSlugFromQuery(input: AgentRuntimeQuery, sessionWorkspaceId: string | undefined): string | undefined {
  const assembly = input.deferredToolAssemblyContext as { workspaceSlug?: unknown } | undefined
  if (typeof assembly?.workspaceSlug === 'string' && assembly.workspaceSlug) return assembly.workspaceSlug
  const workspaceId = input.workspaceId ?? sessionWorkspaceId
  return workspaceId ? getAgentWorkspace(workspaceId)?.slug : undefined
}

/**
 * 工作区归属：`input.workspaceId` 只是调用方显式传入的那一份。
 * headless / 调试入口常常只带 sessionId，权威事实在会话元数据里，两边都要看。
 */
function workspaceFromQuery(input: AgentRuntimeQuery, sessionWorkspaceId: string | undefined) {
  const workspaceId = input.workspaceId ?? sessionWorkspaceId
  return workspaceId ? getAgentWorkspace(workspaceId) : undefined
}

/** 本轮提示词模式；缺省 standard（宁可多给上下文，不能少给）。 */
function promptModeFromQuery(input: AgentRuntimeQuery): 'light' | 'standard' {
  return input.metadata?.promptMode === 'light' ? 'light' : 'standard'
}

/**
 * 组装本轮系统提示词。
 *
 * 返回 `undefined` 表示「宿主没有可用事实」——调用方必须沿用原回落，不得当成空提示词。
 */
export function buildRuntimeTurnPrompt(
  input: AgentRuntimeQuery,
  options: RuntimeTurnPromptOptions = {},
): RuntimeTurnPrompt | undefined {
  const snapshot = agentRuntimePolicyRuns.getForRun(input.sessionId)
  if (!snapshot) return undefined
  const policy = snapshot.policy
  const meta = getAgentSessionMeta(input.sessionId)
  const workspaceSlug = workspaceSlugFromQuery(input, meta?.workspaceId)
  const workspace = workspaceFromQuery(input, meta?.workspaceId)
  const settings = getSettings()
  const modelId = input.modelId ?? meta?.modelId ?? ''
  const routing = resolveAgentModelRouting({ modelId, provider: undefined, context1m: undefined })
  const additionalDirectories = input.additionalDirectories ?? meta?.attachedDirectories ?? []
  // 组禁用只接受 shared 事实表里的合法值：脏数据不能凭空造出一个「未知能力组」段落。
  const disabledToolGroups = policy.disabledToolGroups.filter(
    (group): group is AgentPresetToolGroup => AGENT_PRESET_CAPABILITY_GROUPS.some(item => item.id === group),
  )
  const context: SystemPromptContext = {
    ...(workspace?.name ? { workspaceName: workspace.name } : {}),
    ...(workspaceSlug ? { workspaceSlug } : {}),
    sessionId: input.sessionId,
    permissionMode: policy.permissionMode,
    presetName: snapshot.presetName,
    // 预设操作门禁由用户消息意图 gate 决定；新链尚未下沉该 gate，先不给「可执行」指令，
    // 避免模型按提示词去改预设却拿不到授权（宁可少一段，不可给假授权）。
    allowedPresetOperations: [],
    suppressSections: [...policy.suppressPromptSections],
    claudeAvailable: modelId.toLowerCase().includes('claude'),
    deepSeekSubagentModel: routing.subagentModel,
    isPiRuntime: input.runtime === 'pi',
    disabledToolGroups,
    ...(policy.disabledTools ? { disabledTools: [...policy.disabledTools] } : {}),
    pptCapabilityActive: policy.pptCapabilityActive,
    platform: process.platform,
    ...(options.shellPath ? { shellPath: options.shellPath } : {}),
    ...(input.cwd ? { agentCwd: input.cwd } : {}),
    projectCandidates: detectAttachedDirectoryProjects([...additionalDirectories]),
  }
  const assembly = assembleAgentSystemPrompt({
    mode: promptModeFromQuery(input),
    runtime: input.runtime,
    policy: resolveAgentSystemPromptPolicy(settings),
    context,
    userMessage: input.prompt,
    // 工具名要等 provider 装配完成后才知道（Pi 的 custom tools 在 adapter 内构建），
    // 所以这里接受宿主传入的名单；没传时保持空数组，绝不描述未注册的工具。
    toolNames: [...(options.toolNames ?? [])],
    forceAutomation: input.initiator === 'automation',
    ...(policy.preset.promptSections ? { customSections: [...policy.preset.promptSections] } : {}),
    ...(options.skillCatalog ? { skillCatalog: options.skillCatalog } : {}),
  })
  return {
    systemPrompt: assembly.systemPrompt,
    taskPrompt: assembly.taskPrompt,
  }
}

/** 本模块产出是否可直接替代既有回落（供 provider preparation 判断）。 */
export function hasRuntimeTurnPrompt(value: RuntimeTurnPrompt | undefined): value is RuntimeTurnPrompt {
  if (!value) return false
  const prompt = value.systemPrompt
  return typeof prompt === 'string' ? prompt.trim().length > 0 : prompt.append.trim().length > 0
}

export interface RuntimeTurnUserPromptOptions {
  /** 本轮**实际加载**的 MCP 服务器名（不是配置快照：预设裁剪与注入成败都在名单里）。 */
  mcpServerNames?: readonly string[]
  /** 本轮是否带原生会话 resume；有 resume 时不回填历史（provider 自己就有）。 */
  hasResume: boolean
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const items = value.filter((item): item is string => typeof item === 'string' && item.length > 0)
  return items.length > 0 ? items : undefined
}

/**
 * 组装本轮**用户消息侧**的 prompt（动态上下文 / `@` 引用 / 运行来源 / 历史回填）。
 *
 * 块顺序与旧编排器逐项对齐（`agent-orchestrator.ts:2094-2140`）：
 * `[动态上下文] [@工具] [@会话] [运行来源] [回退 notice] [用户消息]`，历史回填在最外层。
 *
 * 为什么在准备阶段拼：动态上下文要用**实际加载**的 MCP 名单，历史回填要知道「本轮消息尚未落盘」。
 * 两者都只在 `prepare()` 里成立，query 构造时拿不到。
 */
export function buildRuntimeTurnUserPrompt(
  input: AgentRuntimeQuery,
  options: RuntimeTurnUserPromptOptions,
): string {
  // `/compact` 是给 provider 的压缩指令，不是给模型的问题：
  // 包上动态上下文或历史回填会让它变成普通文本（旧链同一判据）。
  if (input.prompt.trim() === '/compact') return '/compact'
  // light：无上下文的新会话短问候——不拼动态上下文 / 引用 / 历史（旧链同一判据）。
  if (promptModeFromQuery(input) === 'light') return input.prompt
  const snapshot = agentRuntimePolicyRuns.getForRun(input.sessionId)
  const policy = snapshot?.policy
  const meta = getAgentSessionMeta(input.sessionId)
  const workspaceSlug = workspaceSlugFromQuery(input, meta?.workspaceId)
  const workspace = workspaceFromQuery(input, meta?.workspaceId)
  const providerInput = (input.providerInput ?? {}) as Record<string, unknown>
  const mentionedSessions = stringArray(providerInput.mentionedSessionIds)
  const mentionedMcpServers = stringArray(providerInput.mentionedMcpServers)

  // 运行来源（谁发起的这一轮）—— 与旧链同一函数，`/compact` 内部会自行跳过。
  let enriched = input.context ? appendRunOriginPrompt(input.prompt, input.context) : input.prompt

  const referencedSessions = buildReferencedSessionsPrompt(
    input.sessionId,
    mentionedSessions,
    input.workspaceId,
  )
  if (referencedSessions) enriched = `${referencedSessions}\n\n${enriched}`

  // `@` 工具引用只保留本轮真实可用的 MCP：旧链同样以实际加载名单过滤，
  // 否则提示词会把模型推向一个本预设已禁用的服务器。
  const availableMcp = [...(options.mcpServerNames ?? [])]
  const allowedMentions = mentionedMcpServers
    ? mentionedMcpServers.filter(name => availableMcp.length === 0 || availableMcp.includes(name))
    : []
  if (allowedMentions.length > 0) {
    const toolLines = allowedMentions.map(name => `- MCP 服务器: ${name}（请使用此 MCP 服务器的工具来完成任务）`)
    enriched = `<mentioned_tools>\n用户在消息中明确引用了以下当前预设可用的工具，请在本次回复中主动调用：\n${toolLines.join('\n')}\n</mentioned_tools>\n\n${enriched}`
  }

  const dynamicCtx = buildDynamicContext({
    ...(workspace?.name ? { workspaceName: workspace.name } : {}),
    ...(workspaceSlug ? { workspaceSlug } : {}),
    ...(input.cwd ? { agentCwd: input.cwd } : {}),
    ...(availableMcp.length > 0 ? { mcpServerNames: availableMcp } : {}),
    ...(policy?.disabledToolGroups ? { disabledToolGroups: policy.disabledToolGroups } : {}),
    ...(policy?.disabledTools ? { disabledTools: policy.disabledTools } : {}),
  })

  let prompt = [dynamicCtx, enriched].filter(Boolean).join('\n\n')

  // 历史回填：只在**没有**原生 resume 时做。有 resume 时 provider 自己持有历史，
  // 再拼一份会让模型看到两份互相矛盾的时间线（旧链同一判据）。
  if (!options.hasResume) {
    const history = getAgentSessionSDKMessages(input.sessionId)
    const { block } = formatContextHistoryBlock(
      history,
      input.cwd ? { sessionId: input.sessionId, agentCwd: input.cwd } : undefined,
    )
    if (block) prompt = `${block}\n\n${prompt}`
  }

  return prompt
}
