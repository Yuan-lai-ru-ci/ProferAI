import { appendFileSync, mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import {
  createEffectiveAgentPresetPolicy,
  type AgentPreset,
  type AgentPresetCreateInput,
  type AgentPresetScope,
  type AgentPresetUpdateInput,
  type EffectiveAgentPresetPolicy,
  type PresetReference,
} from '@profer/shared'
import {
  copyAgentPreset,
  copyPresetToWorkspace,
  createAgentPreset,
  getAgentPresetByReference,
  listAgentPresets,
  presetReferenceForId,
  rebindAgentSessionPreset,
  getDefaultPresetReference,
  restoreAgentPresetSnapshot,
  setDefaultPresetReference,
  updateAgentPreset,
} from './agent-preset-manager'
import { getConfigDir } from './config-paths'
import { getAgentSessionMeta } from './agent-session-manager'

export type AgentPresetOperationSource = 'user' | 'automation' | 'delegation' | 'goal'
export type AgentPresetMutationOperation = 'create' | 'copy' | 'switch' | 'propose_update' | 'propose_default' | 'commit_change'

export interface AgentPresetOperationContext {
  sessionId: string
  workspaceSlug?: string
  source: AgentPresetOperationSource
  allowedOperations: readonly AgentPresetMutationOperation[]
  /** 当前 query 开始时冻结的会话预设引用；切换必须以它为比较基准。 */
  currentPresetReference?: PresetReference
  /** 仅由 orchestrator 注入的当前用户原文；模型工具参数不能覆盖。 */
  userMessage?: string
  /** 当前会话待确认提案是否存在；只由 orchestrator 从主进程状态注入。 */
  pendingChange?: PendingPresetChange
}

export interface AgentPresetCreationResult {
  operation: 'create' | 'copy'
  preset: AgentPreset
  scope: 'workspace'
  currentSessionChanged: false
  defaultChanged: false
  nextStep: 'created_not_applied'
  message: string
}

export interface AccessListDiff {
  from: string[] | null
  to: string[] | null
  added: string[]
  removed: string[]
  expandedToAll: boolean
  restrictedFromAll: boolean
}

export interface AgentPresetCapabilityDiff {
  enabledToolGroups: string[]
  disabledToolGroups: string[]
  enabledTools: string[]
  disabledTools: string[]
  skills: AccessListDiff
  mcpServers: AccessListDiff
  permissionMode: {
    from: EffectiveAgentPresetPolicy['permissionMode']
    to: EffectiveAgentPresetPolicy['permissionMode']
    elevated: boolean
  }
  subagentsEnabled: boolean
  subagentsDisabled: boolean
  elevatesCapabilities: boolean
}

export type PresetChangeProposalKind = 'update' | 'default'

export interface PendingPresetChange {
  proposalId: string
  kind: PresetChangeProposalKind
  sessionId: string
  workspaceSlug: string
  target: PresetReference
  sourceUpdatedAt?: number
  currentDefault: PresetReference
  update?: AgentPresetUpdateInput
  proposalAuditEventId: string
  createdAt: number
}

export interface AgentPresetChangeProposalResult {
  operation: 'propose_update' | 'propose_default'
  proposalId: string
  kind: PresetChangeProposalKind
  target: ReturnType<typeof summarizeAgentPreset>
  update?: AgentPresetUpdateInput
  currentDefault: PresetReference
  auditEventId: string
  impact: {
    effectiveFrom: 'next_turn'
    affects: string[]
    requiresConfirmation: true
  }
  message: string
}

export interface AgentPresetChangeCommitResult {
  operation: 'commit_change'
  proposalId: string
  kind: PresetChangeProposalKind
  target: ReturnType<typeof summarizeAgentPreset>
  currentDefault: PresetReference
  affected: string[]
  effectiveFrom: 'next_turn'
  auditEventId: string
  message: string
}

export interface AgentPresetSwitchResult {
  operation: 'switch'
  previousPreset: ReturnType<typeof summarizeAgentPreset>
  preset: ReturnType<typeof summarizeAgentPreset>
  capabilityDiff: AgentPresetCapabilityDiff
  currentSessionChanged: boolean
  currentTurnChanged: false
  effectiveFrom: 'next_turn'
  authorization: 'explicit_user_intent'
  auditEventId: string
  message: string
}

interface PresetAuditEvent {
  version: 1
  eventId: string
  timestamp: number
  type: 'preset_change_requested' | 'preset_changed'
  operation: 'switch' | 'update' | 'default'
  sessionId: string
  workspaceSlug: string
  from: PresetReference
  to: PresetReference
  elevatesCapabilities: boolean
  authorization: 'explicit_user_intent' | 'explicit_user_confirmation'
  proposalId?: string
}

export interface SwitchOperationDependencies {
  getCurrentReference(sessionId: string, workspaceSlug: string): PresetReference
  rebind(sessionId: string, reference: PresetReference): void
  appendAudit(event: PresetAuditEvent): boolean
}

export interface PresetChangeOperationDependencies {
  getPreset(reference: PresetReference, workspaceSlug: string): AgentPreset
  getPresetSnapshot(workspaceSlug: string, presetId: string): AgentPreset
  getDefaultReference(workspaceSlug: string): PresetReference
  updatePreset(workspaceSlug: string, presetId: string, updates: AgentPresetUpdateInput): AgentPreset
  setDefault(workspaceSlug: string, reference: PresetReference): PresetReference
  appendAudit(event: PresetAuditEvent): boolean
  restorePreset(workspaceSlug: string, snapshot: AgentPreset): void
}

const DEFAULT_PRESET_CHANGE_DEPENDENCIES: PresetChangeOperationDependencies = {
  getPreset(reference, workspaceSlug) { return getAgentPresetByReference(reference, workspaceSlug) },
  getPresetSnapshot(workspaceSlug, presetId) {
    const raw = listAgentPresets(workspaceSlug).find((preset) => preset.scope === 'workspace' && preset.id === presetId)
    if (!raw) throw new Error(`预设不存在: ${presetId}`)
    return raw
  },
  getDefaultReference(workspaceSlug) {
    return getDefaultPresetReference(workspaceSlug)
  },
  updatePreset(workspaceSlug, presetId, updates) { return updateAgentPreset(workspaceSlug, presetId, updates) },
  setDefault(workspaceSlug, reference) { return setDefaultPresetReference(workspaceSlug, reference) },
  appendAudit: appendPresetAuditEvent,
  restorePreset(workspaceSlug, snapshot) { restoreAgentPresetSnapshot(workspaceSlug, snapshot) },
}

const PRESET_TERM = String.raw`(?:Agent\s*)?(?:预设|preset)`
const CREATE_COMMANDS = [
  new RegExp(String.raw`(?:请|帮我|给我|替我).{0,24}(?:创建|新建|建立|建个|建一个|固化|保存为|做成).{0,24}${PRESET_TERM}`, 'iu'),
  new RegExp(String.raw`(?:把|将).{1,48}(?:固化|保存|沉淀|做成).{0,16}${PRESET_TERM}`, 'iu'),
  new RegExp(String.raw`(?:创建|新建|建立|建个|建一个).{0,24}${PRESET_TERM}`, 'iu'),
  new RegExp(String.raw`\b(?:create|make|save)\b.{0,32}\b(?:agent\s+)?preset\b`, 'iu'),
]
const COPY_COMMANDS = [
  new RegExp(String.raw`(?:请|帮我|给我|替我).{0,24}(?:复制|拷贝|克隆).{0,24}${PRESET_TERM}`, 'iu'),
  new RegExp(String.raw`(?:复制|拷贝|克隆).{0,24}${PRESET_TERM}`, 'iu'),
  new RegExp(String.raw`(?:基于|从).{1,32}${PRESET_TERM}.{0,24}(?:创建|新建|派生|复制)`, 'iu'),
  new RegExp(String.raw`\b(?:copy|clone|duplicate)\b.{0,32}\b(?:agent\s+)?preset\b`, 'iu'),
]
const UPDATE_COMMANDS = [
  new RegExp(String.raw`(?:请|帮我|给我|替我|把|将).{0,32}(?:更新|修改|编辑|调整).{0,48}${PRESET_TERM}`, 'iu'),
  new RegExp(String.raw`\b(?:update|edit|modify|change)\b.{0,32}\b(?:agent\s+)?preset\b`, 'iu'),
]
const DEFAULT_COMMANDS = [
  new RegExp(String.raw`(?:请|帮我|给我|替我|把|将).{0,48}(?:设为默认|设置默认|改为默认|作为默认).{0,48}${PRESET_TERM}`, 'iu'),
  new RegExp(String.raw`(?:请|帮我|给我|替我|把|将).{0,48}${PRESET_TERM}.{0,48}(?:设为默认|设置默认|改为默认|作为默认)`, 'iu'),
  new RegExp(String.raw`\b(?:set|make)\b.{0,32}\b(?:agent\s+)?preset\b.{0,16}\bdefault\b`, 'iu'),
]
const CONFIRM_COMMANDS = [
  /^(?:确认|确定|同意|执行|提交|好|好的|可以|就这样|确认提交|yes|approve|confirm)\s*[。.!！]?(?:\s*执行)?$/iu,
]
const CANCEL_COMMANDS = [
  /^(?:取消|拒绝|不要|不执行|撤销|算了|no|cancel|reject)\s*[。.!！]?$/iu,
]
const SWITCH_COMMANDS = [
  new RegExp(String.raw`(?:请|帮我|给我|替我).{0,20}(?:切换|换成|改用).{0,32}(?:${PRESET_TERM}|模式)`, 'iu'),
  new RegExp(String.raw`(?:把|将).{0,16}(?:当前|这个)?会话.{0,20}(?:切换|换成|改用).{0,32}(?:${PRESET_TERM}|模式)`, 'iu'),
  new RegExp(String.raw`(?:切换|换成|改用).{0,32}${PRESET_TERM}`, 'iu'),
  new RegExp(String.raw`\b(?:switch|change|move)\b.{0,24}\b(?:this\s+)?session\b.{0,24}\b(?:agent\s+)?preset\b`, 'iu'),
  new RegExp(String.raw`\b(?:switch|change)\b.{0,24}\b(?:agent\s+)?preset\b`, 'iu'),
]
const NEGATED_MUTATION = new RegExp(
  String.raw`(?:不要|无需|不用|别|禁止).{0,16}(?:创建|新建|建立|复制|拷贝|克隆|固化|切换|换成|改用|更新|修改|编辑|调整|设为默认|设置默认|改为默认|作为默认).{0,32}(?:${PRESET_TERM}|模式)`,
  'iu',
)
const DISCUSSION_ONLY = new RegExp(
  String.raw`(?:为什么|为何|怎么(?:才能)?|如何|是否(?:可以|支持)?|能否(?:支持)?|能不能|可不可以(?:支持)?).{0,48}(?:创建|新建|建立|复制|拷贝|克隆|切换|换成|改用|更新|修改|编辑|调整|设为默认|设置默认|改为默认|作为默认).{0,32}(?:${PRESET_TERM}|模式)|${PRESET_TERM}.{0,20}(?:是什么|有什么|有哪些|需要什么|需要哪些|怎么实现|如何实现|安全吗|会不会)`,
  'iu',
)

/**
 * 保守识别当前用户消息是否明确要求创建、复制或切换预设。
 * 该结果由 orchestrator 注入工具上下文，不能由模型通过工具参数自行声明。
 */
export function evaluateAgentPresetOperationIntents(userMessage: string): readonly AgentPresetMutationOperation[] {
  const message = userMessage.trim()
  if (!message || NEGATED_MUTATION.test(message) || DISCUSSION_ONLY.test(message)) return Object.freeze([])
  const operations: AgentPresetMutationOperation[] = []
  if (COPY_COMMANDS.some((pattern) => pattern.test(message))) operations.push('copy')
  if (CREATE_COMMANDS.some((pattern) => pattern.test(message))) operations.push('create')
  if (SWITCH_COMMANDS.some((pattern) => pattern.test(message))) operations.push('switch')
  if (UPDATE_COMMANDS.some((pattern) => pattern.test(message))) operations.push('propose_update')
  if (DEFAULT_COMMANDS.some((pattern) => pattern.test(message))) operations.push('propose_default')
  return Object.freeze(operations)
}

export function isPresetChangeConfirmation(userMessage: string): boolean {
  return CONFIRM_COMMANDS.some((pattern) => pattern.test(userMessage.trim()))
}

export function isPresetChangeCancellation(userMessage: string): boolean {
  return CANCEL_COMMANDS.some((pattern) => pattern.test(userMessage.trim()))
}

const pendingPresetChanges = new Map<string, PendingPresetChange>()

export function getPendingPresetChange(sessionId: string): PendingPresetChange | undefined {
  return pendingPresetChanges.get(sessionId)
}

export function clearPendingPresetChange(sessionId: string): void {
  pendingPresetChanges.delete(sessionId)
}

function accessListDiff(from: readonly string[] | undefined, to: readonly string[] | undefined): AccessListDiff {
  const fromSet = new Set(from ?? [])
  const toSet = new Set(to ?? [])
  return {
    from: from === undefined ? null : [...fromSet],
    to: to === undefined ? null : [...toSet],
    added: to === undefined ? [] : [...toSet].filter((value) => !fromSet.has(value)),
    removed: from === undefined ? [] : [...fromSet].filter((value) => !toSet.has(value)),
    expandedToAll: from !== undefined && to === undefined,
    restrictedFromAll: from === undefined && to !== undefined,
  }
}

const PERMISSION_RANK: Record<EffectiveAgentPresetPolicy['permissionMode'], number> = {
  plan: 0,
  auto: 1,
  bypassPermissions: 2,
}

/** 比较两个已解析预设的有效能力，用于切换影响摘要与升权审计。 */
export function diffAgentPresetCapabilities(
  currentPreset: AgentPreset,
  currentReference: PresetReference,
  targetPreset: AgentPreset,
  targetReference: PresetReference,
): AgentPresetCapabilityDiff {
  const current = createEffectiveAgentPresetPolicy(currentPreset, currentReference)
  const target = createEffectiveAgentPresetPolicy(targetPreset, targetReference)
  const currentGroups = new Set(current.disabledToolGroups)
  const targetGroups = new Set(target.disabledToolGroups)
  const currentTools = new Set(current.disabledTools ?? [])
  const targetTools = new Set(target.disabledTools ?? [])
  const skills = accessListDiff(current.allowedSkillSlugs, target.allowedSkillSlugs)
  const mcpServers = accessListDiff(current.allowedMcpServerNames, target.allowedMcpServerNames)
  const permissionElevated = PERMISSION_RANK[target.permissionMode] > PERMISSION_RANK[current.permissionMode]
  const enabledToolGroups = [...currentGroups].filter((group) => !targetGroups.has(group))
  const disabledToolGroups = [...targetGroups].filter((group) => !currentGroups.has(group))
  const enabledTools = [...currentTools].filter((tool) => !targetTools.has(tool))
  const disabledTools = [...targetTools].filter((tool) => !currentTools.has(tool))
  const subagentsEnabled = !current.allowSubagents && target.allowSubagents
  const subagentsDisabled = current.allowSubagents && !target.allowSubagents
  const listExpanded = (diff: AccessListDiff): boolean => diff.expandedToAll || diff.added.length > 0
  return {
    enabledToolGroups,
    disabledToolGroups,
    enabledTools,
    disabledTools,
    skills,
    mcpServers,
    permissionMode: { from: current.permissionMode, to: target.permissionMode, elevated: permissionElevated },
    subagentsEnabled,
    subagentsDisabled,
    elevatesCapabilities: enabledToolGroups.length > 0
      || enabledTools.length > 0
      || subagentsEnabled
      || permissionElevated
      || listExpanded(skills)
      || listExpanded(mcpServers),
  }
}

export function summarizeAgentPreset(preset: AgentPreset, defaultPresetId: string): Record<string, unknown> {
  const presetScope: AgentPresetScope = preset.scope ?? (preset.isBuiltin ? 'builtin-meta' : 'workspace')
  const presetReference: PresetReference = {
    presetId: preset.id,
    presetScope,
    ...(presetScope === 'workspace' && preset.workspaceSlug ? { workspaceSlug: preset.workspaceSlug } : {}),
    ...(preset.version ? { presetVersion: preset.version } : {}),
  }
  return {
    id: preset.id,
    scope: presetScope,
    presetReference,
    name: preset.name,
    description: preset.description,
    isBuiltin: preset.isBuiltin,
    isDefault: preset.id === defaultPresetId,
    effort: preset.effort ?? null,
    permissionMode: preset.permissionMode ?? null,
    skillSlugs: preset.skillSlugs ?? null,
    mcpServerNames: preset.mcpServerNames ?? null,
    allowSubagents: preset.allowSubagents ?? null,
    basePresetId: preset.basePresetId ?? null,
    promptSections: preset.promptSections ?? null,
    suppressPromptSections: preset.suppressPromptSections ?? null,
    disabledToolGroups: preset.disabledToolGroups ?? null,
    disabledTools: preset.disabledTools ?? null,
  }
}

function operationLabel(operation: AgentPresetMutationOperation): string {
  if (operation === 'create') return '创建'
  if (operation === 'copy') return '复制'
  if (operation === 'switch') return '切换'
  if (operation === 'propose_update') return '更新'
  if (operation === 'propose_default') return '设置默认'
  return '提交预设变更'
}

function assertInteractiveWorkspace(
  ctx: AgentPresetOperationContext,
  operation: AgentPresetMutationOperation,
): string {
  if (ctx.source !== 'user') {
    throw new Error('只有用户发起的交互会话可以管理预设')
  }
  if (!ctx.allowedOperations.includes(operation)) {
    throw new Error(`当前用户消息没有明确请求${operationLabel(operation)}预设`)
  }
  if (!ctx.workspaceSlug) {
    throw new Error('当前会话没有工作区，无法管理工作区预设')
  }
  return ctx.workspaceSlug
}

function creationResult(
  operation: 'create' | 'copy',
  preset: AgentPreset,
  ctx: AgentPresetOperationContext,
): AgentPresetCreationResult {
  console.log(`[Agent 预设工具] operation=${operation} session=${ctx.sessionId} workspace=${ctx.workspaceSlug} preset=${preset.id}`)
  return {
    operation,
    preset,
    scope: 'workspace',
    currentSessionChanged: false,
    defaultChanged: false,
    nextStep: 'created_not_applied',
    message: '预设已创建，但未切换当前会话，也未更改工作区默认预设。',
  }
}

export function createWorkspacePresetFromAgent(
  ctx: AgentPresetOperationContext,
  input: AgentPresetCreateInput,
): AgentPresetCreationResult {
  return creationResult('create', createAgentPreset(assertInteractiveWorkspace(ctx, 'create'), input), ctx)
}

export function copyWorkspacePresetFromAgent(
  ctx: AgentPresetOperationContext,
  source: Pick<PresetReference, 'presetId' | 'presetScope'>,
  name?: string,
): AgentPresetCreationResult {
  const workspaceSlug = assertInteractiveWorkspace(ctx, 'copy')
  const visibleSource = listAgentPresets(workspaceSlug).find((preset) =>
    preset.id === source.presetId && preset.scope === source.presetScope,
  )
  if (!visibleSource) {
    throw new Error(`当前工作区不可用的源预设: ${source.presetScope}:${source.presetId}`)
  }
  const preset = source.presetScope === 'workspace'
    ? copyAgentPreset(workspaceSlug, source.presetId, name)
    : copyPresetToWorkspace(source, workspaceSlug, name)
  return creationResult('copy', preset, ctx)
}

function referenceEquals(left: PresetReference, right: PresetReference): boolean {
  return left.presetId === right.presetId
    && left.presetScope === right.presetScope
    && left.workspaceSlug === right.workspaceSlug
}

function appendPresetAuditEvent(event: PresetAuditEvent): boolean {
  const path = join(getConfigDir(), 'agent-preset-audit.jsonl')
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, `${JSON.stringify(event)}\n`, 'utf8')
  return true
}

const DEFAULT_SWITCH_DEPENDENCIES: SwitchOperationDependencies = {
  getCurrentReference(sessionId, workspaceSlug) {
    const session = getAgentSessionMeta(sessionId)
    if (!session) throw new Error(`Agent 会话不存在: ${sessionId}`)
    return session.presetReference ?? presetReferenceForId(workspaceSlug, session.presetId)
  },
  rebind(sessionId, reference) {
    rebindAgentSessionPreset(sessionId, reference)
  },
  appendAudit: appendPresetAuditEvent,
}

/**
 * 在用户明确要求的当前轮切换会话预设。当前 query 继续使用 orchestrator 已冻结策略，
 * 新引用只会在下一轮重新构建工具与 Prompt 时生效。
 */
function assertTargetMentioned(ctx: AgentPresetOperationContext, targetPreset: AgentPreset): void {
  const userMessage = ctx.userMessage?.trim()
  if (!userMessage || (!userMessage.includes(targetPreset.name) && !userMessage.includes(targetPreset.id))) {
    throw new Error(`当前用户消息没有明确指定目标预设“${targetPreset.name}”`)
  }
}

function previewPresetUpdate(preset: AgentPreset, updates: AgentPresetUpdateInput): AgentPreset {
  const preview = { ...preset }
  for (const [key, value] of Object.entries(updates) as Array<[keyof AgentPresetUpdateInput, unknown]>) {
    if (key === 'enabledInWorkspace' || value === undefined) continue
    ;(preview as Record<string, unknown>)[key] = value === null ? undefined : value
  }
  return preview
}

const AGENT_PRESET_UPDATE_KEYS = new Set<keyof AgentPresetUpdateInput>([
  'name', 'description', 'promptSections', 'suppressPromptSections', 'disabledToolGroups',
  'disabledTools', 'channelId', 'modelId', 'effort', 'permissionMode', 'skillSlugs', 'mcpServerNames', 'allowSubagents', 'basePresetId',
])

function assertAgentPresetUpdateInput(updates: AgentPresetUpdateInput): void {
  const invalid = Object.keys(updates).filter((key) => !AGENT_PRESET_UPDATE_KEYS.has(key as keyof AgentPresetUpdateInput))
  if (invalid.length > 0) throw new Error(`预设更新包含不允许的字段: ${invalid.join(', ')}`)
}

function updateImpact(updates: AgentPresetUpdateInput): string[] {
  return Object.keys(updates).filter((key) => key !== 'enabledInWorkspace').map((key) => `preset.${key}`)
}

export function proposeAgentPresetUpdateFromAgent(
  ctx: AgentPresetOperationContext,
  target: Pick<PresetReference, 'presetId' | 'presetScope'>,
  updates: AgentPresetUpdateInput,
  dependencies: PresetChangeOperationDependencies = DEFAULT_PRESET_CHANGE_DEPENDENCIES,
): AgentPresetChangeProposalResult {
  const workspaceSlug = assertInteractiveWorkspace(ctx, 'propose_update')
  if (target.presetScope !== 'workspace') throw new Error('Agent 只能提议更新当前工作区自定义预设')
  const targetReference: PresetReference = { presetId: target.presetId, presetScope: 'workspace', workspaceSlug }
  const targetPreset = getAgentPresetByReference(targetReference, workspaceSlug)
  assertTargetMentioned(ctx, targetPreset)
  assertAgentPresetUpdateInput(updates)
  const proposed = previewPresetUpdate(targetPreset, updates)
  const currentDefault = dependencies.getDefaultReference(workspaceSlug)
  if (!Object.keys(updates).length) throw new Error('预设更新提案至少需要一个字段')
  const proposalAudit: PresetAuditEvent = {
    version: 1, eventId: randomUUID(), timestamp: Date.now(), type: 'preset_change_requested', operation: 'update',
    sessionId: ctx.sessionId, workspaceSlug, from: targetReference, to: targetReference,
    elevatesCapabilities: diffAgentPresetCapabilities(targetPreset, targetReference, proposed, targetReference).elevatesCapabilities,
    authorization: 'explicit_user_intent',
  }
  if (!dependencies.appendAudit(proposalAudit)) throw new Error('无法记录预设更新提案审计')
  const proposal: PendingPresetChange = {
    proposalId: randomUUID(),
    kind: 'update',
    sessionId: ctx.sessionId,
    workspaceSlug,
    target: targetReference,
    sourceUpdatedAt: targetPreset.updatedAt,
    currentDefault,
    update: { ...updates },
    proposalAuditEventId: proposalAudit.eventId,
    createdAt: Date.now(),
  }
  pendingPresetChanges.set(ctx.sessionId, proposal)
  return {
    operation: 'propose_update',
    proposalId: proposal.proposalId,
    kind: 'update',
    target: summarizeAgentPreset(proposed, currentDefault.presetId),
    update: { ...updates },
    currentDefault,
    auditEventId: proposal.proposalAuditEventId,
    impact: { effectiveFrom: 'next_turn', affects: updateImpact(updates), requiresConfirmation: true },
    message: `已生成更新“${targetPreset.name}”的提案。影响：${updateImpact(updates).join('、') || '无'}。请明确回复“确认”后提交，或回复“取消”。`,
  }
}

export function proposeAgentPresetDefaultFromAgent(
  ctx: AgentPresetOperationContext,
  target: Pick<PresetReference, 'presetId' | 'presetScope'>,
  dependencies: PresetChangeOperationDependencies = DEFAULT_PRESET_CHANGE_DEPENDENCIES,
): AgentPresetChangeProposalResult {
  const workspaceSlug = assertInteractiveWorkspace(ctx, 'propose_default')
  const targetReference: PresetReference = {
    presetId: target.presetId,
    presetScope: target.presetScope,
    ...(target.presetScope === 'workspace' ? { workspaceSlug } : {}),
  }
  const targetPreset = getAgentPresetByReference(targetReference, workspaceSlug)
  assertTargetMentioned(ctx, targetPreset)
  const currentDefault = dependencies.getDefaultReference(workspaceSlug)
  const proposalAudit: PresetAuditEvent = {
    version: 1, eventId: randomUUID(), timestamp: Date.now(), type: 'preset_change_requested', operation: 'default',
    sessionId: ctx.sessionId, workspaceSlug, from: currentDefault, to: targetReference,
    elevatesCapabilities: false, authorization: 'explicit_user_intent',
  }
  if (!dependencies.appendAudit(proposalAudit)) throw new Error('无法记录默认预设提案审计')
  const proposal: PendingPresetChange = {
    proposalId: randomUUID(),
    kind: 'default',
    sessionId: ctx.sessionId,
    workspaceSlug,
    target: targetReference,
    currentDefault,
    proposalAuditEventId: proposalAudit.eventId,
    createdAt: Date.now(),
  }
  pendingPresetChanges.set(ctx.sessionId, proposal)
  return {
    operation: 'propose_default',
    proposalId: proposal.proposalId,
    kind: 'default',
    target: summarizeAgentPreset(targetPreset, currentDefault.presetId),
    currentDefault,
    auditEventId: proposal.proposalAuditEventId,
    impact: { effectiveFrom: 'next_turn', affects: ['workspace.defaultPresetReference'], requiresConfirmation: true },
    message: `已生成将“${targetPreset.name}”设为工作区默认的提案。后续新会话和未显式指定预设的会话将受影响，请明确回复“确认”后提交，或回复“取消”。`,
  }
}

export function commitPendingAgentPresetChangeFromAgent(
  ctx: AgentPresetOperationContext,
  dependencies: PresetChangeOperationDependencies = DEFAULT_PRESET_CHANGE_DEPENDENCIES,
): AgentPresetChangeCommitResult {
  const workspaceSlug = assertInteractiveWorkspace(ctx, 'commit_change')
  const proposal = ctx.pendingChange ?? getPendingPresetChange(ctx.sessionId)
  if (!proposal || proposal.sessionId !== ctx.sessionId || proposal.workspaceSlug !== workspaceSlug) {
    throw new Error('当前会话没有可提交的预设变更提案')
  }
  if (!isPresetChangeConfirmation(ctx.userMessage ?? '')) throw new Error('提交预设变更需要用户明确确认')
  const currentDefault = dependencies.getDefaultReference(workspaceSlug)
  if (!referenceEquals(currentDefault, proposal.currentDefault)) {
    clearPendingPresetChange(ctx.sessionId)
    throw new Error('工作区默认预设已变化，请重新发起提案')
  }
  const currentTarget = dependencies.getPreset(proposal.target, workspaceSlug)
  const originalSnapshot = proposal.kind === 'update'
    ? dependencies.getPresetSnapshot(workspaceSlug, proposal.target.presetId)
    : undefined
  if (proposal.sourceUpdatedAt !== undefined && currentTarget.updatedAt !== proposal.sourceUpdatedAt) {
    clearPendingPresetChange(ctx.sessionId)
    throw new Error('目标预设已变化，请重新发起提案')
  }
  const from = proposal.kind === 'default' ? currentDefault : proposal.target
  let changed: AgentPreset
  try {
    if (proposal.kind === 'update') {
      changed = dependencies.updatePreset(workspaceSlug, proposal.target.presetId, proposal.update ?? {})
    } else {
      dependencies.setDefault(workspaceSlug, proposal.target)
      changed = currentTarget
    }
    const completed: PresetAuditEvent = {
      version: 1,
      eventId: randomUUID(),
      timestamp: Date.now(),
      type: 'preset_changed',
      operation: proposal.kind,
      sessionId: ctx.sessionId,
      workspaceSlug,
      from,
      to: proposal.target,
      elevatesCapabilities: false,
      authorization: 'explicit_user_confirmation',
      proposalId: proposal.proposalId,
    }
    if (!dependencies.appendAudit(completed)) throw new Error('无法记录预设变更审计')
    clearPendingPresetChange(ctx.sessionId)
    const target = proposal.kind === 'update' ? changed! : currentTarget
    return {
      operation: 'commit_change',
      proposalId: proposal.proposalId,
      kind: proposal.kind,
      target: summarizeAgentPreset(target, proposal.target.presetId),
      currentDefault: proposal.kind === 'default' ? proposal.target : currentDefault,
      affected: proposal.kind === 'update' ? updateImpact(proposal.update ?? {}) : ['workspace.defaultPresetReference'],
      effectiveFrom: 'next_turn',
      auditEventId: completed.eventId,
      message: proposal.kind === 'update'
        ? '预设更新已提交，从下一轮消息开始按新配置生效。'
        : '工作区默认预设已更新，从下一轮消息开始生效。',
    }
  } catch (error) {
    if (proposal.kind === 'update') {
      try { dependencies.restorePreset(workspaceSlug, originalSnapshot!) } catch { /* 保留原始错误，恢复失败由后续人工审计 */ }
    } else {
      try { dependencies.setDefault(workspaceSlug, currentDefault) } catch { /* 保留原始错误，默认引用恢复失败由后续人工审计 */ }
    }
    throw error
  }
}

export function switchSessionPresetFromAgent(
  ctx: AgentPresetOperationContext,
  target: Pick<PresetReference, 'presetId' | 'presetScope'>,
  dependencies: SwitchOperationDependencies = DEFAULT_SWITCH_DEPENDENCIES,
): AgentPresetSwitchResult {
  const workspaceSlug = assertInteractiveWorkspace(ctx, 'switch')
  if (!ctx.currentPresetReference) throw new Error('缺少当前轮预设快照，拒绝切换')
  const targetReference: PresetReference = {
    presetId: target.presetId,
    presetScope: target.presetScope,
    ...(target.presetScope === 'workspace' ? { workspaceSlug } : {}),
  }
  const currentReference = dependencies.getCurrentReference(ctx.sessionId, workspaceSlug)
  if (!referenceEquals(currentReference, ctx.currentPresetReference)) {
    throw new Error('会话预设已在当前轮期间变化，请基于最新状态重新发起切换')
  }
  const currentPreset = getAgentPresetByReference(currentReference, workspaceSlug)
  const targetPreset = getAgentPresetByReference(targetReference, workspaceSlug)
  const userMessage = ctx.userMessage?.trim()
  if (!userMessage || (!userMessage.includes(targetPreset.name) && !userMessage.includes(targetPreset.id))) {
    throw new Error(`当前用户消息没有明确指定目标预设“${targetPreset.name}”`)
  }
  const capabilityDiff = diffAgentPresetCapabilities(currentPreset, currentReference, targetPreset, targetReference)
  const requested: PresetAuditEvent = {
    version: 1,
    eventId: randomUUID(),
    timestamp: Date.now(),
    type: 'preset_change_requested',
    operation: 'switch',
    sessionId: ctx.sessionId,
    workspaceSlug,
    from: currentReference,
    to: targetReference,
    elevatesCapabilities: capabilityDiff.elevatesCapabilities,
    authorization: 'explicit_user_intent',
  }
  if (!dependencies.appendAudit(requested)) throw new Error('无法记录预设切换审计，操作未执行')

  const changed = !referenceEquals(currentReference, targetReference)
  if (changed) dependencies.rebind(ctx.sessionId, targetReference)
  const completed: PresetAuditEvent = {
    ...requested,
    eventId: randomUUID(),
    timestamp: Date.now(),
    type: 'preset_changed',
  }
  try {
    if (!dependencies.appendAudit(completed)) throw new Error('无法记录预设切换审计')
  } catch (error) {
    if (changed) dependencies.rebind(ctx.sessionId, currentReference)
    throw error
  }

  console.log(`[Agent 预设工具] operation=switch session=${ctx.sessionId} workspace=${workspaceSlug} from=${currentReference.presetScope}:${currentReference.presetId} to=${targetReference.presetScope}:${targetReference.presetId} elevated=${capabilityDiff.elevatesCapabilities}`)
  return {
    operation: 'switch',
    previousPreset: summarizeAgentPreset(currentPreset, ''),
    preset: summarizeAgentPreset(targetPreset, ''),
    capabilityDiff,
    currentSessionChanged: changed,
    currentTurnChanged: false,
    effectiveFrom: 'next_turn',
    authorization: 'explicit_user_intent',
    auditEventId: completed.eventId,
    message: changed
      ? `当前会话已切换到“${targetPreset.name}”；当前轮能力快照不变，从下一轮消息开始生效。`
      : `当前会话已经使用“${targetPreset.name}”；未改变当前轮能力快照。`,
  }
}
