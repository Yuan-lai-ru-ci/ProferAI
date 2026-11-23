import { CoreAccountService } from './account-service'
import { resolveNativePiSessionFile } from './native-session-pi'
import { createPlanningAgentOperations, createPlanningStore, type PlanningStore, createSyncSessionIndexStore, createSyncSessionMessageStore, createSessionStorePaths, createFileRunLedgerPort } from '@profer/session-store'
import { registerOwnedSessionLayout, mirrorProjectSessionIndexes, restoreProjectSessionIndexes } from '@profer/session-store'
import { configuredSessionInput, type CoreConfiguredSessionInput } from './configured-session'
import { searchCoreFiles, readCoreFile, describeCoreFileRoots, listCoreFolderEntries, assertSessionPathAllowed } from './core-file-service'
import { copyEntry, moveEntry, readEntryPreview, renameEntry, trashEntry } from './core-fs-ops'
import { saveCoreAttachment, type CoreSavedAttachment } from './core-attachment-service'
import { createCoreNativeOperations, type CoreNativeOperations } from './native-operations'
import { resolveCoreProjectContext } from './project-context'
import { createCoreTaskGraphService } from './task-graph-service'
import { loadCorePiTaskGraphTools, createCoreClaudeTaskGraphMcpServer, CORE_TASK_GRAPH_REPLACED_TOOL_NAMES } from './task-graph-provider-tools'
import { loadCorePiMemoryTools, createCoreClaudeMemoryMcpServers } from './memory-tools'
import { createCoreHarnessRuntime } from './harness-runtime'
import { createCoreRewindRuntime } from './rewind-runtime'
import type { AgentRuntimeAdapter } from '@profer/agent-runtime'
import { CoreSessionTitleService } from './session-title-service'
import { CoreDesktopHostBridge } from './host-bridge'
import { CoreHostTools } from './host-tools'
import { loadCorePiHostTools, createCoreClaudeHostMcpServer } from './host-provider-tools'
import { CoreBrowserHost } from './browser-host'
import { CoreBrowserTools } from './browser-tools'
import { loadCorePiBrowserTools, createCoreClaudeBrowserMcpServer } from './browser-provider-tools'
import { loadPiCoreWebTools, injectClaudeCoreWebTools } from './web-tools'
import { loadCoreWebServiceConfig } from './web-service'
import { createCoreAutomationNotificationHost } from './automation-notification-host'
import { CoreProcessHost } from './process-host'
import { CoreBackgroundTaskHost } from './background-task-host'
import { createCoreToolResultPersist } from './tool-result-host'
import { CoreWorkspaceOperationStore } from './workspace-operation-store'
import { CoreSessionDeletionService } from './session-deletion-service'
import { existsSync, mkdirSync, statSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve, win32 } from 'node:path'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import type { AgentRuntime, AgentSessionMeta, AgentWorkspace, AgentEffort, SDKMessage, CodexOAuthCredentials, ProviderType, XaiOAuthCredentials } from '@profer/shared'
import type { AgentRuntimeQuery, AgentRuntimePorts, SessionPort, RuntimeHostPort, CredentialPort, RuntimeCredential } from '@profer/agent-runtime'
import { AgentRunLedger, AgentRuntimeCoordinator, AgentRuntimePreparationError, createAgentRunContext, createAgentRuntimeProviderAdapter, createAgentQueryPreparationPort } from '@profer/agent-runtime'
import { injectGoalMcpServer } from '@profer/agent-provider-claude/goal-tools'
import { injectClaudePlanningMcpServer, ClaudeAgentAdapter, applyAgentSdkAuthEnv } from '@profer/agent-provider-claude'
import { loadPiPlanningToolDefinitions, PiAgentAdapter, type PiAgentQueryOptions } from '@profer/agent-provider-pi'
import type { AgentRuntimeEnv } from '@profer/agent-provider-pi/pi/runtime-env'
import type { CoreChannelConfig, CoreConfig } from './config'
import { readCoreChannelStore, writeCoreChannelStore } from './channel-store'
import { resolveCorePiSessionDir } from './pi-session-location'
import { createCoreWorkspaceStore, type CoreWorkspaceStore } from './workspaces'
import { createMockAgentAdapter } from './mock-agent'
import { openCorePlanningDatabase } from './planning-database'
import type { CoreMessageOptions } from './message-input'
import { createPlanModeToolPolicy } from '@profer/agent-runtime/plan-mode-tool-policy'
import { AgentExitPlanService } from '@profer/agent-runtime/exit-plan-service'
import { executeCoreResourceOperation } from './resource-operations'
import type { CoreResourceOperationBody } from './resource-operations'
import { CoreGoalStore } from './goal-store'
import { CoreGoalService } from './goal-service'
import { AgentAskUserService } from '@profer/agent-runtime/ask-user-service'
import { createCoreChat, type CoreChat } from './chat'
import { loadCoreMcpServers } from './mcp-resources'
import { buildPiMcpTools, discoverExternalMcpTools, PiMcpClientManager, type PiMcpServers } from '@profer/agent-provider-pi/pi/mcp-tools'
import { withLoadedMcpServerNames } from '@profer/shared'
import { prepareCoreWorkspaceSkills } from './skill-resources'
import { resolveCorePreset } from './preset-resources'
import { getEffectiveDisabledToolNames, isEffectiveAgentPresetToolDisabled, resolveEffectivePermissionMode, canonicalAgentToolName } from '@profer/shared'
import { loadPiAutomationToolDefinitions } from '@profer/agent-provider-pi/automation-tools'
import { injectAutomationMcpServer } from '@profer/agent-provider-claude/automation-tools'
import type { AutomationToolOperations } from '@profer/agent-runtime/automation-tool-operations'
import { CoreAutomationService } from './automation-service'
import { CoreDelegationService } from './delegation-service'
import { CoreDelegationStore } from './delegation-store'
import { CorePermissionService } from './permission-service'
import { loadPiCollaborationTools } from '@profer/agent-provider-pi/delegation-tools'
import { injectClaudeDelegationTools } from '@profer/agent-provider-claude/delegation-tools'
import { buildAgentSessionUiUpdates, buildAgentSessionUiProjection, parseAgentSessionUiAction, shouldClearSessionUnreadOnRunStart, shouldMarkSessionUnreadOnCompletion, type AgentSessionUiAction, type AgentUnreadPolicyMode } from '@profer/shared'
import { canSelectAgentSessionRuntime, normalizeAgentRuntime, isAgentRuntime, AGENT_SESSION_RUNTIME_LOCKED_MESSAGE, normalizeAgentPresetReference, resolvePiThinkingLevel } from '@profer/shared'
import type { DelegationToolOperations, CollaborationToolContext } from '@profer/agent-runtime/delegation-tool-operations'
import { createCoreNativeSessionPorts } from './native-session-store'
import { CoreNativeSessionService } from './native-session-service'

function isSessionDescendant(sessions: readonly AgentSessionMeta[], candidateId: string, ancestorId: string): boolean {
  const byId = new Map(sessions.map(session => [session.id, session]))
  const seen = new Set<string>()
  let current = byId.get(candidateId)
  while (current?.parentSessionId && !seen.has(current.id)) {
    if (!current.sourceDelegationId || current.delegationRelation === 'independent') return false
    if (current.parentSessionId === ancestorId) return true
    seen.add(current.id)
    current = byId.get(current.parentSessionId)
  }
  return false
}

export interface CoreEvent {
  type: 'chat' | 'runtime' | 'message' | 'complete' | 'error' | 'planning' | 'automation' | 'workspace'
  sessionId: string
  payload: unknown
}

export interface CoreAgentRuntime {
  chat: CoreChat
  resourceOperation(body: CoreResourceOperationBody): Promise<unknown>
  deletions: CoreSessionDeletionService
  delegations: CoreDelegationService
  automations: CoreAutomationService
  goals: CoreGoalService
  exitPlan: AgentExitPlanService
  respondExitPlan(response: import('@profer/shared').ExitPlanModeResponse & { sessionId: string }): Promise<boolean>
  askUser: AgentAskUserService
  permissions: CorePermissionService
  respondToPermission(sessionId: string, requestId: string, behavior: 'allow' | 'deny', alwaysAllow?: boolean, runId?: string): boolean
  updateSessionMeta(sessionId: string, patch: Partial<Pick<AgentSessionMeta, 'channelId' | 'modelId' | 'presetId' | 'presetReference' | 'permissionMode' | 'agentRuntime' | 'codexFastMode' | 'openAIThinkingLevel' | 'agentEffort' | 'title'>>, expectedRevision?: number): Promise<AgentSessionMeta>
  applySessionUiAction(sessionId: string, action: AgentSessionUiAction, expectedRevision?: number): Promise<AgentSessionMeta>
  listPendingPermissions(sessionId: string): import('@profer/shared').PermissionRequest[]
  planning: PlanningStore
  sessions: CoreSessionStore
  workspaces: CoreWorkspaceStore
  channels: Array<Omit<CoreChannelConfig, 'apiKey' | 'codexOAuthCredentials' | 'xaiOAuthCredentials'>>
  accountAvailable: boolean
  accountOperation(operation: string, args?: unknown[]): Promise<unknown>
  syncDesktopChannels(channels: CoreChannelConfig[]): void
  listChannelConfigs(): CoreChannelConfig[]
  createChannel(input: Omit<CoreChannelConfig, 'id'> & { id?: string }): CoreChannelConfig
  updateChannel(id: string, patch: Partial<CoreChannelConfig>): CoreChannelConfig
  deleteChannel(id: string): void
  saveAttachment(sessionId: string, filename: string, base64: string): CoreSavedAttachment
  searchFiles(sessionId: string, query: string, limit?: number): import('@profer/shared').FileSearchResult
  readFile(sessionId: string, filePath: string): import('./core-file-service').CoreFileContent | null
  describeFileRoots(sessionId: string): import('@profer/shared').CoreSessionFileRoots
  listDirectoryEntries(sessionId: string, dirPath: string): import('@profer/shared').CoreFsEntry[]
  renameSessionEntry(sessionId: string, path: string, name: string): { path: string }
  moveSessionEntry(sessionId: string, path: string, toDir: string, overwrite?: boolean): { path: string }
  copySessionEntry(sessionId: string, path: string, toDir: string, overwrite?: boolean): { path: string }
  trashSessionEntry(sessionId: string, path: string): { path: string }
  previewSessionFile(sessionId: string, path: string): { path: string; base64: string; mime: string; size: number } | null
  renameSystemEntry(path: string, name: string): { path: string }
  moveSystemEntry(path: string, toDir: string, overwrite?: boolean): { path: string }
  copySystemEntry(path: string, toDir: string, overwrite?: boolean): { path: string }
  trashSystemEntry(path: string): { path: string }
  previewSystemFile(path: string): { path: string; base64: string; mime: string; size: number } | null
  coordinator: AgentRuntimeCoordinator
  ensureWorkspaceSession(input: { workspaceId: string; channelId?: string; modelId?: string }): AgentSessionMeta
  updateWorkspace(id: string, updates: { name?: string; archived?: boolean }): AgentWorkspace
  deleteWorkspace(id: string, options?: { projectOnly?: boolean; operationId?: string }): Promise<void>
  retryWorkspaceDelete(operationId: string): Promise<void>
  listWorkspaceDeleteOperations(): import('./workspace-operation-store').CoreWorkspaceOperation[]
  createConfiguredSession(input: CoreConfiguredSessionInput): AgentSessionMeta
  ensureProjectDraftSession(input: { workspaceId: string; channelId?: string; modelId?: string; useCoreDefaults?: boolean }): AgentSessionMeta
  titles: CoreSessionTitleService
  getTaskOutput(sessionId: string, taskId: string, options?: { block?: boolean; timeoutMs?: number }): Promise<import('@profer/shared').GetTaskOutputResult>
  stopTask(sessionId: string, taskId: string, expectedType?: 'agent' | 'shell'): Promise<void>
  queueMessage(sessionId: string, prompt: string, options?: { uuid?: string; rawUserMessage?: string; interrupt?: boolean }): Promise<import('@profer/agent-runtime').AgentRuntimeQueuedInputResult>
  createQuery(session: AgentSessionMeta, prompt: string, options?: CoreMessageOptions): AgentRuntimeQuery
  subscribe(listener: (event: CoreEvent) => void): () => void
  publish(event: CoreEvent): void
  beginShutdown(): void
  assertAcceptingRuns(): void
  shutdown(): Promise<void>
  dispose(): void
  listRuns(): import('@profer/agent-runtime').AgentRun[]
  stopDelegationsForParent(parentSessionId: string): Promise<number>
  nativeSessions: CoreNativeSessionService
  nativeOperations: CoreNativeOperations
  desktopHosts: CoreDesktopHostBridge
  bindDesktopHost(sessionId: string, connectionId: string): void
  unbindDesktopHost(connectionId: string): void
}

export function createCorePiRuntimeEnv(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  pathExists: (path: string) => boolean = existsSync,
): AgentRuntimeEnv {
  if (platform === 'win32') {
    const lookup = (name: string): string | undefined => env[name] || Object.entries(env).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1]
    const configuredShell = lookup('CLAUDE_CODE_SHELL')
    const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path')
    const pathEntries = pathKey ? (env[pathKey] ?? '').split(win32.delimiter).filter(Boolean) : []
    const candidates = [configuredShell, ...pathEntries.map(directory => win32.join(directory, 'bash.exe'))]
      .filter((path): path is string => Boolean(path && win32.isAbsolute(path)))
    const shellPath = candidates.find(pathExists)
    return {
      env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
      ...(shellPath ? { shellKind: 'git-bash' as const, shellPath } : {}),
    }
  }
  return { env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')), shellKind: 'posix', shellPath: '/bin/bash' }
}

export interface CoreSessionStore extends SessionPort {
  updateMeta(sessionId: string, patch: Partial<AgentSessionMeta>, options?: { touchUpdatedAt?: boolean }): undefined
  updateUiMeta(sessionId: string, patch: Partial<Pick<AgentSessionMeta, 'channelId' | 'modelId' | 'presetId' | 'presetReference' | 'permissionMode'>>): AgentSessionMeta
  list(includeDeleting?: boolean): AgentSessionMeta[]
  remove(sessionId: string): void
  reconcileProjects(): void
  create(input: { title: string; runtime?: AgentRuntime; modelId?: string; channelId?: string; cwd?: string; workspaceId?: string; presetId?: string; presetReference?: AgentSessionMeta['presetReference']; permissionMode?: AgentSessionMeta['permissionMode']; draft?: boolean }): AgentSessionMeta
  ensureWorkspaceSession(input: { workspaceId: string; channelId?: string; modelId?: string }): AgentSessionMeta
  readMessages(sessionId: string): readonly SDKMessage[]
}

function createCoreSessionStore(configDir: string, defaultRuntime: AgentRuntime, workspaces: CoreWorkspaceStore, deletions: CoreSessionDeletionService, isWorkspaceDeleting: (workspaceId: string) => boolean, onChanged: (meta: AgentSessionMeta) => void): CoreSessionStore {
  const paths = createSessionStorePaths(configDir)
  const index = createSyncSessionIndexStore(() => paths.sessionsIndex)
  const messages = createSyncSessionMessageStore(() => paths)
  const workspaceFor = (id: string) => workspaces.list().find(workspace => workspace.id === id)
  const restored = new Set<string>()
  const reconcileProjects = (): void => {
    const candidates = workspaces.list().filter(workspace => workspace.storageMode === 'project' && workspace.rootPath && existsSync(workspace.rootPath)
      && !restored.has(`${workspace.id}:${workspace.rootPath}`))
    if (!candidates.length) return
    const next = structuredClone(index.read())
    if (restoreProjectSessionIndexes(next, candidates, deletions.excludedIds())) index.write(next)
    mirrorProjectSessionIndexes(next, candidates, workspaceId => deletions.excludedIds(workspaceId))
    for (const workspace of candidates) restored.add(`${workspace.id}:${workspace.rootPath}`)
  }
  const readMeta = (sessionId: string): AgentSessionMeta | undefined => {
    if (deletions.isCompleted(sessionId)) return undefined
    reconcileProjects(); return index.get(sessionId)
  }
  const prepareMessages = (sessionId: string): void => {
    const meta = readMeta(sessionId)
    if (!meta) throw new Error(`session not found: ${sessionId}`)
    registerOwnedSessionLayout(meta, meta.workspaceId ? workspaceFor(meta.workspaceId) : undefined)
  }
  const writeIndex = (next: AgentSessionMeta[]): void => {
    next = next.filter(meta => !deletions.isCompleted(meta.id))
    index.write({ version: 1, sessions: next })
    // 权威写入成功不能因副本不可写伪报回滚；明确记录镜像错误供修复后重建。
    try { mirrorProjectSessionIndexes({ version: 1, sessions: next }, workspaces.list(), workspaceId => deletions.excludedIds(workspaceId)) }
    catch (error) { console.error('[Core] 项目会话镜像未保存：', error) }
  }
  const update = (sessionId: string, patch: Partial<AgentSessionMeta>, options?: { touchUpdatedAt?: boolean }): undefined => {
    if (deletions.isWriteBlocked(sessionId)) throw new Error('会话已进入删除清理，拒绝晚到元数据写入')
    const current = readMeta(sessionId)
    if (!current) throw new Error(`session not found: ${sessionId}`)
    const updated: AgentSessionMeta = { ...current, ...patch, revision: (current.revision ?? 0) + 1, updatedAt: options?.touchUpdatedAt === false ? current.updatedAt : Date.now() }
    writeIndex(index.list(true).map(item => item.id === sessionId ? updated : item))
    onChanged(updated)
    return undefined
  }
  const updateUi = (sessionId: string, patch: Partial<Pick<AgentSessionMeta, 'channelId' | 'modelId' | 'presetId' | 'presetReference' | 'permissionMode'>>): AgentSessionMeta => {
    update(sessionId, patch)
    return readMeta(sessionId)!
  }
  const createSession = (input: { title: string; runtime?: AgentRuntime; draft?: boolean; modelId?: string; channelId?: string; cwd?: string; workspaceId?: string; presetId?: string; presetReference?: AgentSessionMeta['presetReference']; permissionMode?: AgentSessionMeta['permissionMode'] }): AgentSessionMeta => {
    if (!input.workspaceId || !workspaceFor(input.workspaceId)) throw new Error('会话必须显式指定合法Core工作区')
    if (input.workspaceId && isWorkspaceDeleting(input.workspaceId)) throw new Error('工作区正在删除，不能创建会话')
    reconcileProjects()
    const now = Date.now()
    const meta: AgentSessionMeta = {
      id: crypto.randomUUID(),
      title: input.title,
      agentRuntime: input.runtime ?? defaultRuntime,
      agentRuntimeLocked: false,
      ...(input.draft ? { draft: true } : {}),
      ...(input.channelId ? { channelId: input.channelId } : {}),
      ...(input.modelId ? { modelId: input.modelId } : {}),
      ...(input.workspaceId ? { workspaceId: input.workspaceId, storageLayout: workspaceFor(input.workspaceId)?.storageMode === 'project' ? 'project' as const : 'managed' as const } : {}),
      ...(input.presetId ? { presetId: input.presetId } : {}),
      ...(input.presetReference ? { presetReference: input.presetReference } : {}),
      permissionMode: input.permissionMode ?? 'auto',
      createdAt: now,
      updatedAt: now,
    }
    writeIndex([...index.list(true), meta])
    onChanged(meta)
    return meta
  }
  const ensureWorkspaceSession = (input: { workspaceId: string; channelId?: string; modelId?: string }): AgentSessionMeta => {
    if (!input.workspaceId || !workspaceFor(input.workspaceId)) throw new Error('会话必须显式指定合法Core工作区')
    if (isWorkspaceDeleting(input.workspaceId)) throw new Error('工作区正在删除，不能创建会话')
    const existing = index.list(true).find(session => session.workspaceId === input.workspaceId && !session.archived && !deletions.isDeleting(session.id))
    if (existing) return existing
    return createSession({ title: 'New session', runtime: 'pi', ...input })
  }
  return {
    getMeta: readMeta,
    list: (includeDeleting = false) => { reconcileProjects(); return index.list(true).filter(meta => !deletions.isCompleted(meta.id) && (includeDeleting || !deletions.isDeleting(meta.id))) },
    reconcileProjects,
    remove: sessionId => { writeIndex(index.list(true).filter(meta => meta.id !== sessionId)) },
    create: createSession,
    ensureWorkspaceSession,
    updateMeta: update,
    updateUiMeta: updateUi,
    lockRuntime: (sessionId, runtime) => {
      if (deletions.isDeleting(sessionId)) throw new Error('会话正在删除，不能启动新运行')
      const current = readMeta(sessionId)
      if (!current) throw new Error(`session not found: ${sessionId}`)
      if (normalizeAgentRuntime(current.agentRuntime) !== runtime) throw new Error(`session runtime is locked to ${normalizeAgentRuntime(current.agentRuntime)}`)
      const updated = { ...current, agentRuntime: runtime, agentRuntimeLocked: true, updatedAt: Date.now(), revision: (current.revision ?? 0) + 1 }
      writeIndex(index.list(true).map(item => item.id === sessionId ? updated : item))
      onChanged(updated)
      return updated
    },
    appendMessages: (sessionId, entries) => {
      if (deletions.isWriteBlocked(sessionId)) throw new Error('会话已进入删除清理，拒绝晚到消息写入')
      prepareMessages(sessionId); messages.append(sessionId, entries)
    },
    getMessages: sessionId => { prepareMessages(sessionId); return messages.read(sessionId) },
    readMessages: sessionId => { prepareMessages(sessionId); return messages.read(sessionId) },
  }
}

function channelCredential(channel: CoreChannelConfig): RuntimeCredential {
  return {
    apiKey: channel.apiKey,
    baseUrl: channel.baseUrl,
    provider: channel.provider,
    forceBearerAuth: channel.forceBearerAuth === true || channel.provider === 'openai-codex' || channel.provider === 'openai-responses',
    ...(channel.codexOAuthCredentials ? { codexOAuthCredentials: channel.codexOAuthCredentials as unknown as CodexOAuthCredentials } : {}),
    ...(channel.xaiOAuthCredentials ? { xaiOAuthCredentials: channel.xaiOAuthCredentials as unknown as XaiOAuthCredentials } : {}),
    ...(channel.credentialMode ? { xaiCredentialMode: channel.credentialMode } : {}),
    ...(channel.apiProtocol ? { xaiApiProtocol: channel.apiProtocol } : {}),
  }
}

function createCredentialPort(channels: readonly CoreChannelConfig[], account?: CoreAccountService): CredentialPort {  return {
    async resolve(input) {
      await account?.ready
      if (account && (input.channelId ? channels.find(channel => channel.id === input.channelId)?.serverManaged : channels[0]?.serverManaged)) {
        if (!await account.operation('teamAuth')) throw new AgentRuntimePreparationError('官方账号未登录或已过期', 'api_key_missing', 'credentials')
      }
      if (input.channelId) {
        const selected = channels.find(item => item.id === input.channelId)
        if (!selected) throw new AgentRuntimePreparationError('所选渠道不存在或已删除，请重新选择渠道', 'channel_not_found', 'credentials')
        if (!selected.apiKey) throw new AgentRuntimePreparationError('当前渠道未配置 API Key', 'api_key_missing', 'credentials')
        return { ok: true, credentials: channelCredential(selected) }
      }
      const channel = channels[0]
      if (!channel || !channel.apiKey) throw new AgentRuntimePreparationError('Core 尚未配置渠道凭据', 'api_key_missing', 'credentials')
      return { ok: true, credentials: channelCredential(channel) }
    },
  }
}

function createMockCredentialPort(): CredentialPort {
  return {
    async resolve() {
      return { ok: true, credentials: { apiKey: 'profer-core-mock', provider: 'anthropic', baseUrl: 'https://mock.invalid', forceBearerAuth: false } }
    },
  }
}

function resolveClaudeCliPath(): string {
  const packageName = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`
  const sdkEntry = createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk')
  const sdkRequire = createRequire(sdkEntry)
  return join(dirname(sdkRequire.resolve(`${packageName}/package.json`)), process.platform === 'win32' ? 'claude.exe' : 'claude')
}

function channelFor(channels: readonly CoreChannelConfig[], channelId: string | undefined): CoreChannelConfig | undefined {
  return (channelId ? channels.find(channel => channel.id === channelId) : undefined) ?? channels[0]
}

export function createCoreAgentRuntime(config: CoreConfig, dependencies: { independent?: boolean; claude?: ConstructorParameters<typeof ClaudeAgentAdapter>[0] } = {}): CoreAgentRuntime {
  const ownedChannels = readCoreChannelStore(config.configDir, config.channels ?? [])
  const listeners = new Set<(event: CoreEvent) => void>()
  const publish = (event: CoreEvent): void => { for (const listener of listeners) listener(event) }
  const channels = dependencies.independent ? [...ownedChannels] : ownedChannels
  let desktopChannels: CoreChannelConfig[] = []
  let account: CoreAccountService | undefined
  const refreshChannels = () => {
    if (!dependencies.independent) return
    const ownedIds = new Set(ownedChannels.map(channel => channel.id))
    channels.splice(0, channels.length, ...ownedChannels, ...desktopChannels.filter(channel => !ownedIds.has(channel.id)), ...(account?.channels ?? []).filter(channel => !ownedIds.has(channel.id)))
    publish({ type: 'workspace', sessionId: '', payload: { type: 'changed' } })
  }
  if (dependencies.independent) {
    account = new CoreAccountService(config.configDir, config.accountServerUrl, refreshChannels, () => new Set([...ownedChannels, ...desktopChannels].map(channel => channel.id)))
    refreshChannels()
  }
  const persistChannels = () => {
    writeCoreChannelStore(config.configDir, ownedChannels)
    refreshChannels()
  }
  mkdirSync(config.workspaceRoot, { recursive: true })
  const defaultRuntime: AgentRuntime = config.mockAgent || channels.length > 0 ? 'pi' : 'claude'
  let sessions: CoreSessionStore
  const workspaces = createCoreWorkspaceStore(config.configDir, config.workspaceRoot, config.desktopWorkspaceIndexPath, () => sessions?.list(true) ?? [],
    () => publish({ type: 'workspace', sessionId: '', payload: { type: 'changed' } }), workspace => {
      const owned = sessions.list(true).filter(session => session.workspaceId === workspace.id)
      if (owned.some(session => coordinator.ownership.getOwner(session.id)
        || goals.list(session.id).some(goal => goal.status === 'active' || goal.status === 'stopping'))) throw new Error('工作区仍有活跃运行或Goal，不能重新定位')
      if (deletions.snapshot().some(record => record.status !== 'completed' && record.sessions.some(session => session.workspaceId === workspace.id))) throw new Error('工作区仍有未完成会话删除，不能重新定位')
    }, config.desktopWorkspaceIndexWritable)
  workspaces.ensureDesktopDefault()
  const deletions = new CoreSessionDeletionService(config)
  const workspaceOperations = new CoreWorkspaceOperationStore(join(config.configDir, 'core-workspace-operations.json'))
  sessions = createCoreSessionStore(config.configDir, defaultRuntime, workspaces, deletions,
    workspaceId => !!workspaceOperations.active(workspaceId),
    meta => {
      if (deletions.isDeleting(meta.id)) return
      publish({ type: 'runtime', sessionId: meta.id, payload: { kind: 'session_projection', operation: 'upsert', session: buildAgentSessionUiProjection({ ...meta, permissionMode: meta.permissionMode ?? 'auto' }) } })
    })
  let nativeRecovering = true
  const nativeTokens = new Map<string, symbol>()
  const nativePorts = createCoreNativeSessionPorts({ config, sessions, workspaces,
    busy: sessionId => {
      const owner = coordinator.ownership.getOwner(sessionId)
      return (!!owner && owner.token !== nativeTokens.get(sessionId)) || (!nativeRecovering && (
        goals.list(sessionId).some(goal => goal.status === 'active' || goal.status === 'stopping')
        || deletions.isWriteBlocked(sessionId)
        || delegations.snapshot().some(record => record.parentSessionId === sessionId && record.status === 'running')))
    },
    onChanged: meta => publish({ type: 'runtime', sessionId: meta.id, payload: { kind: 'session_projection', operation: 'upsert', session: buildAgentSessionUiProjection(meta) } }),
  })
  const nativeSessions = new CoreNativeSessionService({ ...nativePorts,
    acquireOperation: sessionId => {
      const meta = sessions.getMeta(sessionId)
      if (!meta) throw new Error('会话不存在')
      const token = Symbol(`native:${sessionId}`)
      const claimed = coordinator.ownership.claim({ sessionId, runtime: meta.agentRuntime ?? 'claude', token })
      if (!claimed.ok) throw new Error('会话已有执行者')
      nativeTokens.set(sessionId, token)
      return () => { coordinator.ownership.release(sessionId, token); if (nativeTokens.get(sessionId) === token) nativeTokens.delete(sessionId) }
    },
  })
  const workspaceDeleteRuns = new Map<string, { operationId: string; promise: Promise<void> }>()
  const processWorkspaceDelete = (workspaceId: string, operationId: string): Promise<void> => {
    const running = workspaceDeleteRuns.get(workspaceId)
    if (running) {
      if (running.operationId !== operationId) return Promise.reject(new Error(`工作区删除正在执行，请等待原事务: ${running.operationId}`))
      return running.promise
    }
    const promise = Promise.resolve().then(() => processWorkspaceDeleteInternal(workspaceId, operationId)).catch(error => {
      const operation = workspaceOperations.get(operationId)
      if (operation?.status === 'pending') workspaceOperations.fail(operationId, error)
      throw error
    })
    workspaceDeleteRuns.set(workspaceId, { operationId, promise })
    void promise.finally(() => { if (workspaceDeleteRuns.get(workspaceId)?.promise === promise) workspaceDeleteRuns.delete(workspaceId) }).catch(() => {})
    return promise
  }
  const processWorkspaceDeleteInternal = async (workspaceId: string, operationId: string): Promise<void> => {
    const prior = workspaceOperations.get(operationId) ?? workspaceOperations.active(workspaceId)
    if (prior && prior.operationId !== operationId) throw new Error(`工作区已有删除事务，请通过其operationId重试: ${prior.operationId}`)
    if (prior && prior.workspace.id !== workspaceId) throw new Error('工作区删除operationId归属冲突')
    if (prior?.status === 'completed') return
    if (prior?.status === 'failed') workspaceOperations.retry(prior.operationId)
    const workspace = workspaces.list().find(item => item.id === workspaceId)
    if (!workspace && prior) {
      const sessionsRemaining = sessions.list(true).filter(session => session.workspaceId === workspaceId || prior.sessionIds.includes(session.id))
      const automationsRemaining = automations.list().filter(item => item.workspaceId === workspaceId || prior.automationIds.includes(item.id))
      const deletionRecords = deletions.snapshot()
      const completedIds = new Set(prior.sessionDeletionRequests.flatMap(request => {
        const record = deletionRecords.find(item => item.id === request.requestId)
        if (!record || record.status !== 'completed' || record.sessionId !== request.rootSessionId
          || JSON.stringify(record.sessions.map(item => item.id)) !== JSON.stringify(request.sessionIds)
          || record.sessions.some(item => item.workspaceId !== workspaceId)) return []
        return request.sessionIds
      }))
      const directory = join(config.workspaceRoot, prior.workspace.slug)
      if (prior.sessionIds.some(id => !completedIds.has(id)) || sessionsRemaining.length || automationsRemaining.length || existsSync(directory)) throw new Error('工作区索引已移除，但删除事务尚未满足完成条件；保留事务待人工检查')
      workspaceOperations.finish(prior.operationId)
      return
    }
    if (!workspace) throw new Error(`Agent 工作区不存在: ${workspaceId}`)
    workspaces.assertManagedDeleteTarget(workspaceId)
    if (workspaceOperations.active(workspaceId)) automations.blockWorkspace(workspaceId)
    const currentSessions = sessions.list(true).filter(session => session.workspaceId === workspaceId)
    const currentAutomations = automations.list().filter(item => item.workspaceId === workspaceId)
    const sessionsSnapshot = prior?.sessionSnapshots ?? currentSessions
    const ownedAutomations = prior?.automationSnapshots ?? currentAutomations
    const metas = sessions.list(true)
    if (prior && (prior.workspace.id !== workspace.id || prior.workspace.slug !== workspace.slug)) throw new Error('工作区身份与删除事务不匹配')
    if (!prior && JSON.stringify(sessionsSnapshot.map(item => item.id)) !== JSON.stringify(currentSessions.map(item => item.id))) throw new Error('会话集合变化，请重新检查工作区删除范围')
    if (!prior && JSON.stringify(ownedAutomations.map(item => item.id)) !== JSON.stringify(currentAutomations.map(item => item.id))) throw new Error('Automation集合变化，请重新检查工作区删除范围')
    if (prior && (currentSessions.some(meta => !prior.sessionIds.includes(meta.id))
      || metas.some(meta => prior.sessionIds.includes(meta.id) && meta.workspaceId !== workspaceId))) throw new Error('会话当前归属或集合与工作区删除快照不一致')
    if (prior && automations.list().some(item => prior.automationIds.includes(item.id) && item.workspaceId !== workspaceId)) throw new Error('Automation已迁出原工作区，拒绝按旧快照删除')
    for (const meta of sessionsSnapshot) {
      if (coordinator.ownership.getOwner(meta.id) || goals.list(meta.id).some(goal => goal.status === 'active' || goal.status === 'stopping')) throw new Error('工作区仍有活跃运行或Goal，请先停止后删除')
      if (meta.parentSessionId) {
        const parent = metas.find(item => item.id === meta.parentSessionId)
        if (parent && parent.workspaceId !== workspaceId) throw new Error('会话删除范围跨越工作区，拒绝级联')
      }
    }
    for (const meta of metas) {
      if (meta.workspaceId !== workspaceId && meta.parentSessionId && sessionsSnapshot.some(item => item.id === meta.parentSessionId)
        && meta.sourceDelegationId && meta.delegationRelation !== 'independent') throw new Error('工作区外仍有从属子会话，拒绝扩大删除范围')
    }
    const scopedAutomations = prior?.automationSnapshots ?? currentAutomations
    const triggers = prior?.triggerSnapshots ?? automations.listTriggers().filter(item => scopedAutomations.some(automation => automation.id === item.automationId))
    if (!prior && triggers.some(item => item.status === 'running' || item.runId && item.status === 'interrupted')) throw new Error('Automation存在运行中或结果未确认的trigger，请先确认终态后重试')
    const operation = prior ?? workspaceOperations.begin(workspace, sessionsSnapshot, scopedAutomations, triggers, Date.now(), operationId)
    try {
      automations.blockWorkspace(workspaceId)
      const visited = new Set<string>(), visiting = new Set<string>(), orderedIds: string[] = []
      const visit = (id: string): void => {
        if (visiting.has(id)) throw new Error('工作区会话父子关系存在循环，拒绝删除')
        if (visited.has(id)) return
        visiting.add(id)
        for (const child of sessionsSnapshot.filter(meta => meta.parentSessionId === id && meta.sourceDelegationId && meta.delegationRelation !== 'independent')) visit(child.id)
        visiting.delete(id); visited.add(id); orderedIds.push(id)
      }
      for (const meta of sessionsSnapshot) visit(meta.id)
      automations.removeWorkspaceSnapshot(workspaceId, operation.automationIds)
      const selectedIds = new Set(operation.sessionIds)
      const roots = operation.sessionIds.filter(sessionId => {
        const meta = operation.sessionSnapshots.find(item => item.id === sessionId)!
        return !meta.parentSessionId || !selectedIds.has(meta.parentSessionId) || !isSessionDescendant(operation.sessionSnapshots, sessionId, meta.parentSessionId)
      })
      const covered = new Set<string>()
      let deletionRequests = operation.sessionDeletionRequests
      for (const rootId of roots) {
        const recorded = deletionRequests.find(item => item.rootSessionId === rootId)
        const deletion = recorded
          ? deletions.requestSnapshot(rootId, recorded.sessionIds, recorded.requestId)
          : (() => {
            const exactIds = orderedIds.filter(id => id === rootId || isSessionDescendant(operation.sessionSnapshots, id, rootId))
            const intent = { rootSessionId: rootId, requestId: randomUUID(), sessionIds: exactIds }
            deletionRequests = [...deletionRequests, intent]
            workspaceOperations.setSessionDeletionRequests(operation.operationId, deletionRequests)
            return deletions.requestSnapshot(rootId, exactIds, intent.requestId)
          })()
        for (const sessionId of deletion.sessionIds) {
          if (!operation.sessionIds.includes(sessionId)) throw new Error('会话删除器计算范围超出工作区事务快照')
          covered.add(sessionId)
        }
        const state = deletions.snapshot().find(item => item.id === deletion.requestId)
        if (state?.status !== 'completed') {
          if (state?.status === 'failed') deletions.retry(deletion.requestId)
          await deletions.drain()
        }
        const settled = deletions.snapshot().find(item => item.id === deletion.requestId)
        if (!settled || settled.status !== 'completed') throw new Error(`会话删除未完成: ${settled?.error ?? rootId}`)
      }
      if (covered.size !== operation.sessionIds.length) throw new Error('会话快照存在无法安全级联的孤立或循环关系')
      const remaining = sessions.list(true).filter(item => item.workspaceId === workspaceId)
      if (remaining.length) throw new Error(`工作区删除后仍有会话: ${remaining.map(item => item.id).join(', ')}`)
      const remainingAutomations = automations.list().filter(item => item.workspaceId === workspaceId)
      if (remainingAutomations.some(item => !operation.automationIds.includes(item.id))) throw new Error('工作区存在事务快照外的Automation，保留工作区')
      const directory = join(config.workspaceRoot, operation.workspace.slug)
      const current = workspaces.assertManagedDeleteTarget(workspaceId)
      if (current.slug !== operation.workspace.slug) throw new Error('工作区身份在删除期间发生变化')
      if (existsSync(directory)) {
        const stats = statSync(directory)
        if (!stats.isDirectory()) throw new Error('工作区路径不再是目录')
        // 会话资产已由归属删除器精确清理；没有文件级所有权证据的剩余内容必须保留。
        // 不递归删除目录（包括空子目录）：它可能是用户产物或异常软链。
        const { readdir, rmdir } = await import('node:fs/promises')
        if ((await readdir(directory)).length) throw new Error('工作区存在未纳管文件或目录，请显式移走后重试')
        workspaces.assertManagedDeleteTarget(workspaceId)
        // rmdir 原子拒绝并发新增的内容；失败保留事务和索引，允许同 operationId 重试。
        await rmdir(directory)
      }
      workspaces.removeManagedAfterCascade(workspaceId)
      workspaceOperations.finish(operation.operationId)
    } catch (error) {
      workspaceOperations.fail(operation.operationId, error)
      throw error
    }
  }

  const workspaceCwd = (session: AgentSessionMeta): { cwd: string; createIfMissing: boolean } => {
    const workspace = session.workspaceId ? workspaces.list().find(item => item.id === session.workspaceId) : undefined
    if (session.workspaceId && !workspace) throw new Error(`Core 工作区不存在：${session.workspaceId}`)
    if (workspace?.storageMode === 'project') {
      if (!workspace.rootPath || !isAbsolute(workspace.rootPath)) throw new Error(`Core 项目工作区根目录无效：${workspace.name}`)
      let stats
      try { stats = statSync(workspace.rootPath) } catch {
        throw new Error(`Core 项目工作区根目录不存在：${workspace.rootPath}`)
      }
      if (!stats.isDirectory()) throw new Error(`Core 项目工作区根路径不是目录：${workspace.rootPath}`)
      return { cwd: resolve(workspace.rootPath), createIfMissing: false }
    }
    return {
      cwd: join(config.workspaceRoot, workspace?.slug ?? 'default'),
      createIfMissing: true,
    }
  }
  const mcpManager = new PiMcpClientManager()
  const mcpRuns = new Map<string, { servers: PiMcpServers; tools?: Promise<Awaited<ReturnType<typeof buildPiMcpTools>>> }>()
  const skillRuns = new Map<string, Promise<Awaited<ReturnType<typeof prepareCoreWorkspaceSkills>>>>()
  const presetRuns = new Map<string, { runId: string; resources: ReturnType<typeof resolveCorePreset> }>()
  const resolveResources = (session: AgentSessionMeta, workspace: ReturnType<CoreWorkspaceStore['list']>[number] | undefined) => {
    const resolved = resolveCorePreset(config, session, workspace)
    if (!session.sourceDelegationId) return resolved
    const inherited = new CoreDelegationStore(join(config.configDir, 'core-delegations.json')).read().records
      .find(record => record.delegationId === session.sourceDelegationId && record.childSessionId === session.id)?.parentPolicy
    if (!inherited) throw new Error('委派缺少持久化父级能力上限')
    const intersect = (selected: readonly string[] | undefined, parent: readonly string[] | undefined) => parent === undefined ? selected : selected === undefined ? parent : selected.filter(value => parent.includes(value))
    const permissionMode = resolveEffectivePermissionMode(inherited.permissionMode, resolved.policy.permissionMode)
    const policy = { ...resolved.policy, permissionMode,
      disabledToolGroups: [...new Set([...inherited.disabledToolGroups, ...resolved.policy.disabledToolGroups])],
      disabledTools: [...new Set([...(inherited.disabledTools ?? []), ...(resolved.policy.disabledTools ?? [])])],
      allowedSkillSlugs: intersect(resolved.policy.allowedSkillSlugs, inherited.allowedSkillSlugs),
      allowedMcpServerNames: intersect(resolved.policy.allowedMcpServerNames, inherited.allowedMcpServerNames),
      allowSubagents: false, sessionCanUseSubagents: false,
    }
    return { ...resolved, policy, preset: { ...resolved.preset, permissionMode } }
  }
  const effectiveMode = (sessionId: string) => {
    const session = sessions.getMeta(sessionId)
    if (!session) return 'plan' as const
    const preset = presetRuns.get(sessionId)?.resources.preset
      ?? resolveResources(session, workspaces.list().find(workspace => workspace.id === session.workspaceId)).preset
    return resolveEffectivePermissionMode(preset.permissionMode, session.permissionMode ?? 'auto')
  }
  const toolDisabled = (sessionId: string, toolName: string) => {
    const policy = presetRuns.get(sessionId)?.resources.policy
    return !!policy && (isEffectiveAgentPresetToolDisabled(policy, toolName) || isEffectiveAgentPresetToolDisabled(policy, canonicalAgentToolName(toolName)))
  }
  const permissions = new CorePermissionService(
    (sessionId, payload) => publish({ type: 'runtime', sessionId, payload }),
    effectiveMode,
    sessionId => createPlanModeToolPolicy(sessions.getMeta(sessionId) ? workspaceCwd(sessions.getMeta(sessionId)!).cwd : undefined,
      join(config.configDir, 'session-workspaces', sessionId, '.context', 'plan')),
    toolDisabled,
  )
  const unreadMode = (): AgentUnreadPolicyMode => {
    const path = join(config.configDir, 'settings.json')
    if (!existsSync(path)) return 'auto'
    const settings = JSON.parse(readFileSync(path, 'utf8')) as { manualReadConfirmEnabled?: boolean }
    return settings.manualReadConfirmEnabled === true ? 'manual' : 'auto'
  }
  const runEvidence = new Map<string, Awaited<ReturnType<ReturnType<typeof createCoreRewindRuntime>['prepareRun']>>>()
  const harness = createCoreHarnessRuntime({ configDir: config.configDir,
    assertSession: id => {
      const meta = sessions.getMeta(id)
      if (!meta) throw new Error('Harness会话不存在')
      registerOwnedSessionLayout(meta, workspaces.list().find(item => item.id === meta.workspaceId))
    },
    onChanged: id => publish({ type: 'runtime', sessionId: id, payload: { kind: 'profer_event', event: { type: 'task_graph_changed', sessionId: id } } }),
  })
  const harnessToolCalls = new Map<string, Map<string, { name: string; input: Record<string, unknown> }>>()
  const startedRuns = new Set<string>()
  const host: RuntimeHostPort = {
    emit: event => {
      if (!('sessionId' in event)) return
      if (event.type === 'runtime_started') {
        if (event.runId) startedRuns.add(event.runId)
        const current = sessions.getMeta(event.sessionId)
        if (current) {
          const clear = shouldClearSessionUnreadOnRunStart(event.initiator ?? 'external', unreadMode())
          sessions.updateMeta(event.sessionId, { ...(current.draft ? { draft: false } : {}), ...(clear ? { completedButUnconfirmed: false } : {}) })
        }
      }
      if (event.type === 'message') {
        const message = event.message as unknown as { type?: string; message?: { content?: unknown } }
        const scope = harness.getActiveScope(event.sessionId)
        if (scope && message.type === 'result') scope.observeResult(event.message)
        const content = message.message?.content
        if (scope && Array.isArray(content)) {
          let calls = harnessToolCalls.get(event.sessionId)
          if (!calls) harnessToolCalls.set(event.sessionId, calls = new Map())
          for (const item of content as Array<{ type?: string; id?: string; name?: string; input?: Record<string, unknown>; tool_use_id?: string; content?: unknown; is_error?: boolean }>) {
            if (item.type === 'tool_use' && item.id && item.name) calls.set(item.id, { name: item.name, input: item.input ?? {} })
            if (item.type === 'tool_result' && item.tool_use_id) {
              const call = calls.get(item.tool_use_id)
              if (call) { scope.observeToolResult({ toolUseId: item.tool_use_id, toolName: call.name, input: call.input, result: item.content, isError: item.is_error }); calls.delete(item.tool_use_id) }
            }
          }
        }
      }
      if (event.type === 'runtime_finished') {
        if (event.outcome.status === 'stopped') harness.pauseActivePiHarnessRun(event.sessionId, event.outcome.stopReason ?? 'user_stop')
        harness.settlePiHarnessRun(event.sessionId, event.outcome.status === 'completed' ? 'completed' : 'failed')
        harnessToolCalls.delete(event.sessionId)
        const started = event.runId ? startedRuns.delete(event.runId) : false
        const current = sessions.getMeta(event.sessionId)
        try {
          if (current && shouldMarkSessionUnreadOnCompletion({ initiator: event.initiator ?? 'external', delegationDepth: current.delegationDepth, started }, unreadMode())) {
            sessions.updateMeta(event.sessionId, { completedButUnconfirmed: true })
          }
        } catch (error) {
          // 未读投影失败不能吞掉真实运行终态，Core依旧广播结束。
          console.error('[Core] 终态未读状态保存失败：', error)
        }
      }
      publish({ type: event.type === 'message' ? 'message' : 'runtime', sessionId: event.sessionId, payload: event })
    },
  }
  const credentials = config.mockAgent ? createMockCredentialPort() : createCredentialPort(channels, account)
  const planning = createPlanningStore({ databasePath: () => join(config.configDir, 'planning.db'), openDatabase: openCorePlanningDatabase })
  const createPlanningOperations = (approve?: (toolName: string, input: Record<string, unknown>) => Promise<void>, providerGatesWrites = false) => createPlanningAgentOperations(planning, {
    beforeWrite: async (ctx, toolName, input) => {
      const session = sessions.getMeta(ctx.sessionId)
      if (!session || session.workspaceId !== ctx.workspaceId) throw new Error('Planning session/workspace binding is invalid')
      const mode = effectiveMode(ctx.sessionId)
      if (toolDisabled(ctx.sessionId, toolName)) throw new Error('当前预设已禁用此工具')
      if (mode === 'plan') throw new Error('计划模式禁止写入任务/日程')
      if (approve) await approve(toolName, input)
      else if (mode === 'auto' && !providerGatesWrites) throw new Error('Planning 写入缺少本轮权限门禁')
      if (effectiveMode(ctx.sessionId) === 'plan') throw new Error('计划模式禁止写入任务/日程')
    },
    broadcastPlanningChanged: resources => publish({ type: 'planning', sessionId: '', payload: { type: 'changed', resources } }),
    broadcastPlanningAgentOperation: operation => publish({ type: 'planning', sessionId: operation.sessionId, payload: { type: 'agent_operation', operation } }),
  })
  const exitPlan = new AgentExitPlanService()
  const goalStore = new CoreGoalStore(join(config.configDir, 'core-goals.json'))
  const goals = new CoreGoalService(goalStore)
  const desktopBindings = new Map<string, string>()
  const desktopHosts = new CoreDesktopHostBridge(config.coreId ?? 'test-core', {
    isRunActive: identity => identity.coreId === (config.coreId ?? 'test-core')
      && runLedger.get(identity.runId)?.sessionRef === identity.sessionId
      && ['running', 'waiting'].includes(runLedger.get(identity.runId)?.status ?? '')
      && !deletions.isWriteBlocked(identity.sessionId),
    // 工具工厂先走统一权限；桥接处再次校验当前能力与计划模式，避免等待期间权限改变。
    authorize: async request => {
      const name = request.operation === 'clipboard.write' ? 'clipboard_write_text'
        : request.operation === 'preview.open' ? 'open_file_preview' : 'inspect_file_preview'
      return !toolDisabled(request.sessionId, name)
        && (request.operation !== 'clipboard.write' || effectiveMode(request.sessionId) !== 'plan')
    },
  })
  const authorizedHostFiles = (session: AgentSessionMeta) => ({
    readAuthorizedFile: async (path: string, maxBytes: number, signal: AbortSignal) => {
      signal.throwIfAborted()
      const workspace = workspaces.list().find(item => item.id === session.workspaceId)
      if (!workspace) throw new Error('会话工作区不存在')
      const file = readCoreFile(config.configDir, config.workspaceRoot, workspace, session, path)
      if (!file) throw new Error('预览文件不存在或未授权')
      const bytes = Buffer.from(file.base64, 'base64')
      if (bytes.length > maxBytes) throw new Error('预览文件超过大小限制')
      return { name: file.resolvedPath, bytes }
    },
  })
  const browserSessions = new Map<string, CoreBrowserTools>()
  const hostToolsFor = (session: AgentSessionMeta) => new CoreHostTools(desktopHosts, authorizedHostFiles(session))
  const browserFor = (session: AgentSessionMeta) => {
    let tools = browserSessions.get(session.id)
    if (!tools) {
      tools = new CoreBrowserTools(new CoreBrowserHost({ executablePath: config.browser?.executablePath,
        readAuthorizedFile: (path, maxBytes, signal) => authorizedHostFiles(sessions.getMeta(session.id) ?? session).readAuthorizedFile(path, maxBytes, signal ?? new AbortController().signal),
        openFilePreview: async (path, signal) => {
          const run = runLedger.list().find(item => item.sessionRef === session.id && ['running', 'waiting'].includes(item.status))
          const connectionId = desktopBindings.get(session.id)
          if (!run || !connectionId) throw new Error('正式预览需要当前运行绑定桌面宿主')
          return hostToolsFor(session).preview({ connectionId, sessionId: session.id, runId: run.id, signal: signal ?? new AbortController().signal }, { path })
        },
      }))
      browserSessions.set(session.id, tools)
    }
    return tools
  }
  const webConfig = loadCoreWebServiceConfig(config.configDir, config.webSearch)
  const askUser = new AgentAskUserService()
  const queryPreparation = createAgentQueryPreparationPort({
    credentials,
    permissions: {
      createCanUseTool: input => {
        const gate = permissions.createCanUseTool(input)
        // Claude Planning MCP 在操作层调用同一 gate；SDK 外层不重复展示审批。
        return async (toolName, toolInput, options) => {
          const signal = input.signal ? AbortSignal.any([input.signal, options.signal]) : options.signal
          if (signal.aborted) return { behavior: 'deny', message: '操作已中止' }
          if (toolDisabled(input.sessionId, toolName)) return { behavior: 'deny', message: '当前预设已禁用此工具' }
          if ((toolName === 'update_goal' || toolName === 'mcp__goal__update_goal') && input.runId) return { behavior: 'allow', updatedInput: toolInput }
          if (toolName === 'EnterPlanMode' || toolName === 'ExitPlanMode') {
            const currentMode = effectiveMode(input.sessionId)
            if (currentMode === 'bypassPermissions') {
              publish({ type: 'runtime', sessionId: input.sessionId, payload: { kind: 'profer_event', event: { type: 'plan_mode_changed', sessionId: input.sessionId, active: toolName === 'EnterPlanMode', source: 'tool' } } })
              return { behavior: 'allow', updatedInput: toolInput }
            }
          }
          if (toolName === 'EnterPlanMode') {
            try {
              await updateSessionMeta(input.sessionId, { permissionMode: 'plan' }, undefined,
                () => !signal.aborted && runLedger.get(input.runId ?? '')?.status === 'running')
              return { behavior: 'allow', updatedInput: toolInput }
            } catch (error) { return { behavior: 'deny', message: String(error) } }
          }
          if (toolName === 'ExitPlanMode') return exitPlan.handleExitPlanMode(input.sessionId, toolInput, signal,
            request => publish({ type: 'runtime', sessionId: input.sessionId, payload: { kind: 'profer_event', event: { type: 'exit_plan_mode_request', request } } }),
            { runId: input.runId, lifecycle: input.runLifecycle })
          if (toolName === 'AskUserQuestion') return askUser.handleAskUserQuestion(input.sessionId, toolInput,
            signal,
            request => publish({ type: 'runtime', sessionId: input.sessionId, payload: { kind: 'profer_event', event: { type: 'ask_user_request', request } } }),
            { runId: input.runId, lifecycle: input.runLifecycle })
          return sessions.getMeta(input.sessionId)?.agentRuntime === 'claude' && (toolName.startsWith('mcp__planning__') || toolName.startsWith('mcp__automation__') || toolName.startsWith('mcp__collaboration__') || toolName.startsWith('mcp__host__') || toolName.startsWith('mcp__browser__') || toolName.startsWith('mcp__web__') || toolName.startsWith('mcp__task-graph__') || toolName.startsWith('mcp__global-memory__') || toolName.startsWith('mcp__memory-archive__'))
            ? Promise.resolve({ behavior: 'allow', updatedInput: toolInput })
            : gate(toolName, toolInput, options)
        }
      },
    },
    events: { emit: (sessionId, payload) => publish({ type: 'runtime', sessionId, payload }) },
  })
  const providerQueryPreparation: NonNullable<AgentRuntimePorts['providerQueryPreparation']> = {
    async prepare(input, prepared, signal) {
      const session = sessions.getMeta(input.sessionId)
      if (!session || deletions.isDeleting(input.sessionId)) throw new Error('会话不存在或正在删除')
      const resources = presetRuns.get(input.sessionId)?.resources
      if (!resources) throw new Error('Core运行缺少冻结预设策略')
      const disabledTools = [...getEffectiveDisabledToolNames(resources.policy), ...CORE_TASK_GRAPH_REPLACED_TOOL_NAMES]
      // 只读所属 Core 的默认设置，不使用桌面或另一 Core 的全局配置。
      const settingsPath = join(config.configDir, 'settings.json')
      const settings: { agentThinking?: { type?: string }; agentEffort?: AgentEffort } = existsSync(settingsPath)
        ? JSON.parse(readFileSync(settingsPath, 'utf8')) : {}
      const effort = session.agentEffort ?? resources.policy.effort ?? settings.agentEffort
      const mcp = input.runId ? mcpRuns.get(input.runId) : undefined
      if (!mcp) throw new Error('Core运行缺少冻结MCP配置')
      const { cwd, createIfMissing } = workspaceCwd(session)
      if (createIfMissing) mkdirSync(cwd, { recursive: true })
      const planDir = join(config.configDir, 'session-workspaces', session.id, '.context', 'plan')
      mkdirSync(planDir, { recursive: true })
      const projectContext = resolveCoreProjectContext({ config, workspaces, session, cwd })
      const corePrompt = [`You are Profer Core. Plan files belong only in ${planDir}. Project files are not a plan directory.`, ...projectContext.promptSections, ...(resources.preset.promptSections ?? [])].join('\n\n')
      const loadSkills = (toolNames: string[]) => {
        if (!input.runId) throw new Error('Core Skill装配缺少真实Run身份')
        let loading = skillRuns.get(input.runId)
        if (!loading) {
          loading = prepareCoreWorkspaceSkills({ config, workspaceConfigDir: resources.configDir, sessionId: session.id, runId: input.runId, policy: withLoadedMcpServerNames(resources.policy, Object.keys(mcp.servers)), toolNames, prompt: input.prompt })
          skillRuns.set(input.runId, loading)
        }
        return loading
      }
      const automationContext = { sessionId: session.id, workspaceId: session.workspaceId, channelId: input.channelId ?? session.channelId ?? '', modelId: input.modelId ?? session.modelId, agentRuntime: input.runtime, triggeredBy: input.initiator === 'automation' ? 'automation' as const : undefined }
      const automationOperations: AutomationToolOperations = {
        listAutomations: () => automations.list().filter(task => task.workspaceId === session.workspaceId),
        getAutomation: id => automations.list().find(task => task.id === id && task.workspaceId === session.workspaceId),
        getAgentSessionMeta: id => { const meta = sessions.getMeta(id); return meta?.workspaceId === session.workspaceId ? meta : undefined },
        createAutomation: value => { assertAutomationWrite('create_automation'); if (value.workspaceId !== session.workspaceId) throw new Error('Automation工作区不属于当前会话'); return automations.create(value) },
        updateAutomation: value => { assertAutomationWrite('update_automation', value.id); return automations.update(value) },
        deleteAutomation: id => { assertAutomationWrite('delete_automation', id); return automations.delete(id) },
        runAutomationNow: async id => { assertAutomationWrite('run_automation_now', id); return automations.runNow(id) },
        broadcastAutomationsChanged: () => {},
      }
      function assertAutomationWrite(name: string, id?: string): void {
        signal.throwIfAborted()
        if (effectiveMode(session!.id) === 'plan') throw new Error('计划模式禁止发布Automation操作')
        if (toolDisabled(session!.id, `mcp__automation__${name}`)) throw new Error('当前预设已禁用此Automation工具')
        if (id && !automationOperations.getAutomation(id)) throw new Error('Automation不存在或不属于当前工作区')
      }
      const delegationContext: CollaborationToolContext = { sessionId: session.id, sourceRunId: input.runId, channelId: input.channelId ?? session.channelId ?? '', modelId: input.modelId ?? session.modelId, workspaceId: session.workspaceId, agentRuntime: input.runtime, permissionMode: effectiveMode(session.id), signal }
      const toolContext = { sessionId: session.id, runId: input.runId!, signal, disabledTools }
      const hostContext = { ...toolContext, get connectionId() {
        return desktopBindings.get(session.id) ?? (session.parentSessionId ? desktopBindings.get(session.parentSessionId) : undefined) ?? ''
      } }
      const webContext = { disabledTools, signal,
        authorize: async (name: string, args: Record<string, unknown>, toolSignal?: AbortSignal) => {
          const active = toolSignal ?? signal
          active.throwIfAborted()
          if (input.runtime === 'pi') { if (toolDisabled(session.id, name)) throw new Error('工具已禁用'); return }
          const decision = await permissions.createCanUseTool({ sessionId: session.id, runId: input.runId, signal, runLifecycle: input.runLifecycle,
            sendPermissionRequest: request => publish({ type: 'runtime', sessionId: session.id, payload: { kind: 'profer_event', event: { type: 'permission_request', request } } }) })(name, args, { signal: active })
          if (decision.behavior !== 'allow') throw new Error(decision.message)
        },
      }
      const memoryContext = { configDir: config.configDir, workspaceConfigDir: resources.configDir,
        workspaceStorageMode: workspaces.list().find(item => item.id === session.workspaceId)?.storageMode,
        disabledTools, disabledToolGroups: [...resources.policy.disabledToolGroups], getPermissionMode: () => effectiveMode(session.id), signal }
      const graphTools = createCoreTaskGraphService(config, runtime)
      const evidence = await createCoreRewindRuntime(config, runtime).prepareRun(session, input, cwd)
      if (!input.runId) throw new Error('回退证据缺少Run身份')
      runEvidence.set(input.runId, evidence)
      const credential = prepared.credentials
      if (!credential) throw new Error('Agent channel credential is missing')
      if (input.runtime === 'pi') {
        mcp.tools ??= buildPiMcpTools(mcp.servers, resources.policy, { strict: true, manager: mcpManager, workspaceSlug: `${config.configDir}:${session.workspaceId ?? 'none'}` })
        const mcpTools = await mcp.tools
        // Pi 的工具包装已执行同一个 prepared.canUseTool；写入前仍校验 plan，避免双重审批。
        const planningOperations = createPlanningOperations(undefined, true)
        const planningTools = await loadPiPlanningToolDefinitions({ sessionId: session.id, workspaceId: session.workspaceId }, planningOperations)
        const automationTools = await loadPiAutomationToolDefinitions(automationContext, automationOperations)
        const collaborationTools = await loadPiCollaborationTools(delegationContext, delegations, disabledTools)
        const hostTools = await loadCorePiHostTools(hostToolsFor(session), hostContext)
        const browserTools = await loadCorePiBrowserTools(browserFor(session), { disabledTools, signal })
        const webTools = await loadPiCoreWebTools(webConfig, webContext)
        const memoryTools = await loadCorePiMemoryTools(memoryContext)
        const taskGraphTools = await loadCorePiTaskGraphTools(graphTools, toolContext)
        const scope = harness.shouldStartPiHarness(input.runtime) ? harness.startPiHarnessRun({ sessionId: session.id, userMessage: input.prompt, prompt: input.prompt, permissionMode: effectiveMode(session.id) }) : undefined
        const piOptions: PiAgentQueryOptions = {
          ...evidence.pi,
          onHarnessLifecycle: event => scope?.observeLifecycle(event),
          projectInstructionFiles: projectContext.projectInstructionFiles,
          sessionId: input.sessionId,
          prompt: input.prompt,
          model: input.modelId,
          agentRuntime: 'pi',
          runtimeEnv: createCorePiRuntimeEnv(),
          cwd,
          apiKey: credential.apiKey,
          baseUrl: credential.baseUrl,
          provider: credential.provider,
          channelId: input.channelId,
          channelName: channelFor(channels, input.channelId)?.name,
          permissionMode: effectiveMode(input.sessionId),
          thinkingLevel: resolvePiThinkingLevel(session.openAIThinkingLevel, { agentThinking: settings.agentThinking?.type !== 'disabled', agentEffort: effort ?? undefined }, credential.provider),
          ...(session.openAIThinkingLevel != null ? { openAIThinkingLevel: session.openAIThinkingLevel } : {}),
          codexFastMode: session.codexFastMode ?? false,
          goalReport: input.goalRunId ? { iteration: input.goalIteration ?? 0, report: result => input.onGoalResult?.(result) } : undefined,
          onGoalResult: input.onGoalResult,
          getPermissionMode: () => effectiveMode(input.sessionId),
          disallowedTools: disabledTools,
          skillSlugs: [],
          preparePromptForTools: async toolNames => {
            const skills = await loadSkills(toolNames)
            return { systemPrompt: [corePrompt, skills.system].filter(Boolean).join('\n\n'), taskPrompt: skills.task || undefined,
              prompt: [skills.task, scope?.prompt ?? input.prompt].filter(Boolean).join('\n\n') }
          },
          systemPrompt: typeof prepared.systemPrompt === 'string' ? prepared.systemPrompt : corePrompt,
          piAgentDir: join(config.configDir, 'pi'),
          piSessionDir: resolveCorePiSessionDir(config.configDir, session.sdkSessionId),
          ...(session.sdkSessionId ? { resumeSessionId: session.sdkSessionId, resumeSessionFile: resolveNativePiSessionFile(config.configDir, session.sdkSessionId) } : {}),
          ...(credential.codexOAuthCredentials ? { codexOAuthCredentials: credential.codexOAuthCredentials } : {}),
          ...(credential.xaiOAuthCredentials ? { xaiOAuthCredentials: credential.xaiOAuthCredentials } : {}),
          ...(credential.xaiCredentialMode ? { xaiCredentialMode: credential.xaiCredentialMode } : {}),
          ...(credential.xaiApiProtocol ? { xaiApiProtocol: credential.xaiApiProtocol } : {}),
          customTools: [...planningTools, ...automationTools, ...collaborationTools, ...hostTools, ...browserTools, ...webTools, ...memoryTools, ...taskGraphTools, ...mcpTools],
          prepared,
          onPiEntryBindings: bindings => { sessions.updateMeta(input.sessionId, { piEntryBindings: bindings }) },
          onSessionId: (sdkSessionId, sessionFile) => {
            sessions.updateMeta(input.sessionId, { sdkSessionId, ...(sessionFile ? { piSessionFile: sessionFile } : {}) })
          },
        }
        return piOptions as unknown as Record<string, unknown>
      }
      const planningGate = permissions.createCanUseTool({ sessionId: input.sessionId, runId: input.runId, signal, runLifecycle: input.runLifecycle,
        sendPermissionRequest: request => publish({ type: 'runtime', sessionId: input.sessionId, payload: { kind: 'profer_event', event: { type: 'permission_request', request } } }),
      })
      const planningOperations = createPlanningOperations(async (toolName, toolInput) => {
        const decision = await planningGate(toolName, toolInput, { signal })
        if (decision.behavior !== 'allow') throw new Error(decision.message ?? 'Planning 写入被拒绝')
        signal.throwIfAborted()
      })
      const externalTools = await discoverExternalMcpTools(mcp.servers, { strict: true, manager: mcpManager, workspaceSlug: `${config.configDir}:${session.workspaceId ?? 'none'}` })
      const mcpServers: Record<string, Record<string, unknown>> = { ...mcp.servers }
      const sdk = await import('@anthropic-ai/claude-agent-sdk')
      const registered: string[] = []
      const inventorySdk = { ...sdk, createSdkMcpServer: (options: Parameters<typeof sdk.createSdkMcpServer>[0]) => {
        registered.push(...(options.tools ?? []).map(tool => `mcp__${options.name}__${tool.name}`))
        return sdk.createSdkMcpServer(options)
      } }
      await injectClaudePlanningMcpServer(inventorySdk, mcpServers, { sessionId: session.id, workspaceId: session.workspaceId }, planningOperations)
      const automationSdk: Pick<typeof sdk, 'tool' | 'createSdkMcpServer'> = {
        createSdkMcpServer: inventorySdk.createSdkMcpServer,
        tool: (name, description, schema, handler, extra) => sdk.tool(name, description, schema, async (args, context) => {
          if (!['list_automations', 'get_automation'].includes(name)) {
            const decision = await planningGate(`mcp__automation__${name}`, args, { signal })
            if (decision.behavior !== 'allow') throw new Error(decision.message ?? 'Automation操作被拒绝')
            signal.throwIfAborted()
          }
          return handler(args, context)
        }, extra),
      }
      await injectAutomationMcpServer(automationSdk, mcpServers, automationContext, disabledTools, automationOperations)
      const collaborationSdk: Pick<typeof sdk, 'tool' | 'createSdkMcpServer'> = {
        createSdkMcpServer: inventorySdk.createSdkMcpServer,
        tool: (name, description, schema, handler, extra) => sdk.tool(name, description, schema, async (args, context) => {
          if (!['list_available_agent_models', 'list_delegations', 'get_delegation_results', 'wait_for_delegations'].includes(name)) {
            const decision = await planningGate(`mcp__collaboration__${name}`, args, { signal })
            if (decision.behavior !== 'allow') throw new Error(decision.message ?? '委派操作被拒绝')
          }
          signal.throwIfAborted()
          return handler(args, context)
        }, extra),
      }
      await injectClaudeDelegationTools(collaborationSdk, mcpServers, delegationContext, delegations, disabledTools)
      const gate = planningGate
      mcpServers['task-graph'] = createCoreClaudeTaskGraphMcpServer(inventorySdk, graphTools, { ...toolContext, canUseTool: gate }) as unknown as Record<string, unknown>
      Object.assign(mcpServers, await createCoreClaudeMemoryMcpServers(inventorySdk, { ...memoryContext, canUseTool: gate }))
      mcpServers.host = await createCoreClaudeHostMcpServer(inventorySdk, hostToolsFor(session), { ...hostContext, get connectionId() { return hostContext.connectionId }, canUseTool: gate }) as unknown as Record<string, unknown>
      mcpServers.browser = await createCoreClaudeBrowserMcpServer(inventorySdk, browserFor(session), { disabledTools, signal, canUseTool: gate }) as unknown as Record<string, unknown>
      await injectClaudeCoreWebTools(inventorySdk, mcpServers, webConfig, webContext)
      if (input.goalRunId && input.onGoalResult) await injectGoalMcpServer(inventorySdk, mcpServers, { iteration: input.goalIteration ?? 0, report: input.onGoalResult })
      const toolNames = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode', ...registered, ...externalTools.map(item => `mcp__${item.serverName}__${item.tool.name}`)]
        .filter(tool => !toolDisabled(session.id, tool))
      const skills = await loadSkills(toolNames)
      prepared.systemPrompt = [corePrompt, skills.system].filter(Boolean).join('\n\n')
      if (skills.task) prepared.prompt = `${skills.task}\n\n${input.prompt}`
      const env: Record<string, string | undefined> = { ...process.env, CLAUDE_CONFIG_DIR: join(config.configDir, 'sdk-config') }
      for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_CUSTOM_HEADERS']) env[key] = ''
      applyAgentSdkAuthEnv(env, credential.provider, credential.apiKey, credential.forceBearerAuth, '0.1.1')
      const claudeBaseUrl = channelFor(channels, input.channelId)?.agentBaseUrl ?? credential.baseUrl
      if (claudeBaseUrl && claudeBaseUrl !== 'https://api.anthropic.com') env.ANTHROPIC_BASE_URL = claudeBaseUrl.replace(/\/+$/, '')
      return {
        ...evidence.claude,
        ...(session.sdkSessionId ? { resumeSessionId: session.sdkSessionId } : {}),
        ...(session.resumeAtMessageUuid ? { resumeSessionAt: session.resumeAtMessageUuid } : {}),
        onSessionId: (sdkSessionId: string) => { sessions.updateMeta(session.id, { sdkSessionId }) },
        additionalDirectories: projectContext.additionalDirectories,
        sdkCliPath: resolveClaudeCliPath(), env, cwd, processLifecycle: claudeProcessLifecycle,
        effort: effort ?? 'high',
        sdkPermissionMode: effectiveMode(input.sessionId), allowDangerouslySkipPermissions: true,
        systemPrompt: typeof prepared.systemPrompt === 'string' ? prepared.systemPrompt : corePrompt,
        settings: { sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: true, filesystem: { allowWrite: projectContext.additionalDirectories, denyRead: [] } }, persistSession: true },
        skills: [], plugins: [],
        mcpServers,
        // 写工具不得通过 allowedTools 绕过 auto 的 canUseTool 审批。
        allowedTools: ['Read', 'Glob', 'Grep'],
        disallowedTools: [...disabledTools, 'WebFetch', 'WebSearch'],
      }
    },
  }
  const titles = new CoreSessionTitleService({
    getChannel: id => channels.find(channel => channel.id === id),
    getMeta: id => deletions.isDeleting(id) ? undefined : sessions.getMeta(id),
    updateMeta: (id, patch) => { if (!deletions.isDeleting(id)) sessions.updateMeta(id, patch) },
    readMessages: id => [...sessions.readMessages(id)],
    onTitleUpdated: (sessionId, title) => publish({ type: 'runtime', sessionId, payload: { kind: 'profer_event', event: { type: 'title_updated', sessionId, title } } }),
    onCodexCredentialsRefreshed: (source, credentials) => {
      const channel = channels.find(item => item.id === source.id)
      if (!channel || (dependencies.independent && channel !== source)) throw new Error('标题渠道已移除或变更')
      const previous = channel.codexOAuthCredentials
      channel.codexOAuthCredentials = { ...credentials }
      if (ownedChannels.includes(channel)) {
        try { persistChannels() } catch (error) { channel.codexOAuthCredentials = previous; throw error }
      }
    },
  })
  const processes = new CoreProcessHost(join(config.configDir, 'core-runtime'))
  const backgroundTasks = new CoreBackgroundTaskHost(join(config.configDir, 'core-runtime'), processes)
  const claudeProcessLifecycle = backgroundTasks.createClaudeLifecycle()
  const claude = new ClaudeAgentAdapter({ ...dependencies.claude, processLifecycle: claudeProcessLifecycle })
  const pi = new PiAgentAdapter({ processRegistration: processes, backgroundTasks, toolResultPersist: createCoreToolResultPersist(join(config.configDir, 'core-runtime')) })
  const ports: AgentRuntimePorts = {
    sessions, credentials, host, queryPreparation,
    providerQueryPreparation: {
      prepare: async (input, prepared, signal) => {
        try { return await providerQueryPreparation.prepare(input, prepared, signal) }
        catch (error) {
          if (input.runId) {
            const evidence = runEvidence.get(input.runId)
            runEvidence.delete(input.runId)
            await evidence?.finalize({ failed: true })
          }
          throw error
        }
      },
    },
    permissions,
    events: { emit: (sessionId, payload) => publish({ type: 'runtime', sessionId, payload }) },
  }
  // Electron 仍有自己的执行链；单独保存 Core 台账，避免两个进程并发覆写/对账同一文件。
  const runLedger = new AgentRunLedger(createFileRunLedgerPort(join(config.configDir, 'core-agent-runs.json')))
  runLedger.reconcileInterrupted()
  const evidenceDrains = new Map<string, Promise<void>>()
  const withEvidenceFinalizer = (adapter: AgentRuntimeAdapter): AgentRuntimeAdapter => ({
    ...adapter,
    stream(input, callbacks) {
      // 必须同步调用底层stream，先登记provider资源，再让coordinator捕获drain。
      if (!adapter.stream) throw new Error('Provider缺少流入口')
      const source = adapter.stream(input, callbacks)
      let finish!: () => void
      const drained = new Promise<void>(resolve => { finish = resolve })
      evidenceDrains.set(input.sessionId, drained)
      return (async function* () {
        let failed = true
        try {
          yield* source
          failed = input.abortSignal?.aborted === true
        } finally {
          try {
            if (input.runId) {
              const evidence = runEvidence.get(input.runId)
              runEvidence.delete(input.runId)
              await evidence?.finalize({ failed })
            }
          } finally {
            finish()
            if (evidenceDrains.get(input.sessionId) === drained) evidenceDrains.delete(input.sessionId)
          }
        }
      })()
    },
    waitForDrain: async sessionId => { await Promise.all([adapter.waitForDrain?.(sessionId), evidenceDrains.get(sessionId)]) },
  })
  const coordinator = new AgentRuntimeCoordinator({
    runLedger,
    adapters: {
      claude: withEvidenceFinalizer(createAgentRuntimeProviderAdapter('claude', claude)),
      pi: config.mockAgent
        ? createMockAgentAdapter()
        : withEvidenceFinalizer(createAgentRuntimeProviderAdapter('pi', pi, {
            mapInput: (_input, base) => ({
              ...base,
              prepared: { ...base.prepared, tools: [...(base.prepared?.tools ?? []), ...((base as unknown as PiAgentQueryOptions).customTools ?? [])] },
            }) as unknown as PiAgentQueryOptions,
          })),
    },
    ports,
  })
  const checkPlanningReminders = (): void => {
    try {
      const reminders = planning.claimDuePlanningReminders()
      if (reminders.length) publish({ type: 'planning', sessionId: '', payload: { type: 'reminders_due', reminders } })
    } catch (error) { console.error('[Core Planning] reminder check failed', error) }
  }
  // Core 是提醒业务唯一领取者，包含 Electron 组合模式；桌面仅消费通知事件。
  const planningTimer = setInterval(checkPlanningReminders, 30_000)
  planningTimer?.unref()
  const sessionUpdates = new Map<string, Promise<unknown>>()
  const updateSessionMeta = (sessionId: string, patch: Parameters<CoreAgentRuntime['updateSessionMeta']>[1], expectedRevision?: number, isCurrent: () => boolean = () => true): Promise<AgentSessionMeta> => {
    // 捕获请求，排队期间调用方不可改变待校验的目标。
    patch = structuredClone(patch)
    const previous = sessionUpdates.get(sessionId) ?? Promise.resolve()
    const update = previous.catch(() => {}).then(async () => {
      if (!isCurrent()) throw new Error('请求所属Run已失效')
      if (deletions.isDeleting(sessionId)) throw new Error('会话正在删除，不能修改')
      const current = sessions.getMeta(sessionId)
      if (!current) throw new Error('Agent 会话不存在')
      if (expectedRevision !== undefined && (!Number.isInteger(expectedRevision) || expectedRevision < 0)) throw new Error('invalid expected revision')
      if (expectedRevision !== undefined && (current.revision ?? 0) !== expectedRevision) throw new Error('REVISION_CONFLICT: 会话状态已更新，请刷新后重试')
      const validOpenAiThinkingLevels = [null, 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
      const validAgentEfforts = [null, 'low', 'medium', 'high', 'max']
      if (patch.codexFastMode !== undefined && typeof patch.codexFastMode !== 'boolean') throw new Error('无效的 Codex Fast Mode 状态')
      if (patch.openAIThinkingLevel !== undefined && !validOpenAiThinkingLevels.includes(patch.openAIThinkingLevel)) throw new Error('无效的推理档位')
      if (patch.agentEffort !== undefined && !validAgentEfforts.includes(patch.agentEffort)) throw new Error('无效的推理强度')
      const runtime = patch.agentRuntime ?? current.agentRuntime ?? 'claude'
      if (patch.channelId !== undefined) {
        const channel = channels.find(item => item.id === patch.channelId)
        if (!channel || channel.enabled === false) throw new Error('渠道不可用或不存在')
        if (channel.agentRuntimes && !channel.agentRuntimes.includes(runtime)) throw new Error(`当前会话内核不支持该渠道: ${runtime}`)
        if (patch.modelId !== undefined && channel.models && !channel.models.some(model => model.id === patch.modelId && model.enabled)) throw new Error('模型不属于当前渠道或未启用')
      } else if (patch.modelId !== undefined) throw new Error('模型必须绑定到有效渠道')
      if (patch.title !== undefined) {
        if (typeof patch.title !== 'string' || !patch.title.trim() || patch.title.length > 200) throw new Error('无效的会话标题')
        patch.title = patch.title.trim()
      }
      if (patch.agentRuntime !== undefined && !isAgentRuntime(patch.agentRuntime)) throw new Error('无效的 Agent runtime')
      // 已选引擎的幂等重选不触碰恢复资产、不制造新revision。
      if (Object.keys(patch).length === 1 && patch.agentRuntime === normalizeAgentRuntime(current.agentRuntime)) return current
      const changesExecution = Object.keys(patch).some(key => key !== 'permissionMode' && key !== 'title')
      if (coordinator.ownership.getOwner(sessionId) && changesExecution) {
        throw new Error('Agent 正在运行，完成后再修改模型或预设')
      }
      if (patch.agentRuntime !== undefined && patch.agentRuntime !== normalizeAgentRuntime(current.agentRuntime)) {
        if (!canSelectAgentSessionRuntime(current) || sessions.readMessages(sessionId).some(message => message.type === 'user')) {
          throw new Error(AGENT_SESSION_RUNTIME_LOCKED_MESSAGE)
        }
      }
      const workspace = workspaces.list().find(item => item.id === current.workspaceId)
      if ('presetId' in patch || 'presetReference' in patch) {
        if ('presetId' in patch && (typeof patch.presetId !== 'string' || !patch.presetId.trim())) throw new Error('预设ID不能为空')
        if ('presetReference' in patch) {
          if (!patch.presetReference) throw new Error('预设引用不能为空')
          // 明确指定另一工作区不能被规范化悄悄改成当前工作区。
          if (patch.presetReference.presetScope === 'workspace' && patch.presetReference.workspaceSlug !== undefined
            && patch.presetReference.workspaceSlug !== workspace?.slug) throw new Error('预设引用不属于当前Core工作区')
          patch.presetReference = normalizeAgentPresetReference(patch.presetReference, workspace?.slug)
          if (patch.presetId !== undefined && patch.presetId !== patch.presetReference.presetId) throw new Error('预设ID与引用不一致')
        }
        const candidate = { ...current, ...patch, presetReference: patch.presetReference,
          presetId: patch.presetReference?.presetId ?? patch.presetId }
        // 按所属Core读取预设、版本、禁用与作用域，未知ID绝不回退默认岗位。
        const resources = resolveResources(candidate, workspace)
        patch.presetId = resources.preset.id
        patch.presetReference = normalizeAgentPresetReference(resources.reference, workspace?.slug)
        patch.permissionMode = resolveEffectivePermissionMode(resources.policy.permissionMode, patch.permissionMode ?? current.permissionMode ?? 'auto')
      }
      const mode = patch.permissionMode
      if (mode !== undefined) {
        const resources = presetRuns.get(sessionId)?.resources ?? resolveResources({ ...current, ...patch }, workspace)
        if (resolveEffectivePermissionMode(resources.preset.permissionMode, mode) !== mode) throw new Error('预设权限上限不允许此模式；不会放宽实际执行权限')
      }
      const ownerToken = coordinator.ownership.getOwner(sessionId)?.token
      const stopOriginalOwner = async () => {
        if (ownerToken !== undefined && coordinator.ownership.getOwner(sessionId)?.token === ownerToken) await coordinator.stopAndWait(sessionId)
      }
      const needsSdkSync = mode !== undefined && (current.agentRuntime ?? 'claude') === 'claude' && coordinator.isRunning(sessionId)
      if (needsSdkSync) {
        try { await claude.setPermissionMode(sessionId, mode, true) }
        catch (error) {
          // 无法证实权限收紧已生效时不继续运行，也不提交误导性 metadata。
          await stopOriginalOwner()
          throw error
        }
      }
      try {
        // SDK 异步同步期间其他宿主回写不能被旧 revision 覆盖。
        if (!isCurrent()) throw new Error('请求所属Run已失效')
        if (changesExecution && coordinator.ownership.getOwner(sessionId)) throw new Error('Agent 已开始运行，不能修改本轮执行前提')
        if (needsSdkSync && coordinator.ownership.getOwner(sessionId)?.token !== ownerToken) throw new Error('权限同步的运行已结束或被替换')
        if (needsSdkSync && (sessions.getMeta(sessionId)?.revision ?? 0) !== (current.revision ?? 0)) throw new Error('REVISION_CONFLICT: 权限同步期间会话已变化')
        sessions.updateMeta(sessionId, { ...patch, ...(patch.title !== undefined ? { titleLockedAt: Date.now() } : {}) })
      } catch (error) {
        if (needsSdkSync) await stopOriginalOwner()
        throw error
      }
      const updated = sessions.getMeta(sessionId)!
      if (mode === 'plan') permissions.invalidatePending(sessionId)
      if (mode !== undefined) publish({ type: 'runtime', sessionId, payload: { kind: 'profer_event', event: { type: 'permission_mode_changed', mode } } })
      if (mode !== undefined) goals.nudge(sessionId)
      return updated
    })
    sessionUpdates.set(sessionId, update)
    void update.finally(() => { if (sessionUpdates.get(sessionId) === update) sessionUpdates.delete(sessionId) }).catch(() => {})
    return update
  }
  const respondingPlans = new Set<string>()
  const respondExitPlan: CoreAgentRuntime['respondExitPlan'] = async response => {
    if (!['approve_auto', 'approve_edit', 'deny', 'feedback'].includes(response.action) || respondingPlans.has(response.requestId)) return false
    const request = exitPlan.getPendingRequests().find(item => item.requestId === response.requestId)
    if (!request || request.sessionId !== response.sessionId || request.runId !== response.runId) return false
    const owner = coordinator.ownership.getOwner(response.sessionId)?.token
    const isCurrent = () => owner !== undefined && coordinator.ownership.getOwner(response.sessionId)?.token === owner
      && exitPlan.getPendingRequests().some(item => item.requestId === response.requestId && item.runId === response.runId)
    if (!isCurrent()) return false
    respondingPlans.add(response.requestId)
    try {
      const target = response.action === 'approve_auto' ? 'bypassPermissions' : response.action === 'approve_edit' ? 'auto' : undefined
      if (target) await updateSessionMeta(response.sessionId, { permissionMode: target }, sessions.getMeta(response.sessionId)?.revision ?? 0, isCurrent)
      if (!isCurrent()) return false
      const result = exitPlan.respondToExitPlanMode(response)
      if (target && result && !result.targetMode) {
        // 模式提交后恢复账本失败：同步收紧并停止原owner，不继续使用放宽模式。
        const sameOwner = () => coordinator.ownership.getOwner(response.sessionId)?.token === owner
        if (sameOwner()) {
          // 同步收紧metadata并发起停止，早于被拒工具Promise的下一次续跑。
          try { sessions.updateMeta(response.sessionId, { permissionMode: 'plan' }) }
          finally { if (sameOwner()) await coordinator.stopAndWait(response.sessionId) }
        }
        throw new Error('计划审批恢复失败，运行已停止且权限已收紧')
      }
      if (result) publish({ type: 'runtime', sessionId: response.sessionId, payload: { kind: 'profer_event', event: { type: 'exit_plan_mode_resolved', requestId: response.requestId } } })
      return !!result
    } finally { respondingPlans.delete(response.requestId) }
  }
  const automations = new CoreAutomationService(config, runLedger)
  for (const operation of workspaceOperations.list()) if (operation.status !== 'completed') automations.blockWorkspace(operation.workspace.id)
  const delegations = new CoreDelegationService(config, new CoreDelegationStore(join(config.configDir, 'core-delegations.json')), runLedger)
  let nativeOperations: CoreNativeOperations | undefined
  /** 会话级文件操作的统一入口：会话存在、未在删除、工作区可解析。 */
  const sessionScope = (sessionId: string): { session: AgentSessionMeta; workspace: AgentWorkspace } => {
    if (deletions.isDeleting(sessionId)) throw new Error('会话正在删除')
    const session = sessions.getMeta(sessionId)
    if (!session?.workspaceId) throw new Error('会话不存在或未绑定工作区')
    const workspace = workspaces.list().find(item => item.id === session.workspaceId)
    if (!workspace) throw new Error('会话工作区不存在')
    return { session, workspace }
  }
  const chat = createCoreChat({ account, defaultSelection: () => ({ channelId: account?.defaultChannelId, modelId: account?.defaultModelId }), configDir: config.configDir, listChannels: () => channels, emit: (sessionId, channel, payload) => publish({ type: 'chat', sessionId, payload: { channel, payload } }) })
  let closing = false
  let shutdownPromise: Promise<void> | undefined
  const assertAcceptingRuns = (): void => {
    if (closing) throw new Error('Core 正在关闭，不再接受新运行')
  }
  const runtime: CoreAgentRuntime = {
    chat,
    deletions,
    delegations,
    automations,
    goals,
    exitPlan,
    respondExitPlan,
    askUser,
    permissions,
    updateSessionMeta,
    applySessionUiAction: (sessionId, input, expectedRevision) => {
      const action = parseAgentSessionUiAction(input)
      const previous = sessionUpdates.get(sessionId) ?? Promise.resolve()
      const applying = previous.catch(() => {}).then(() => {
        if (deletions.isDeleting(sessionId)) throw new Error('会话正在删除，不能修改')
        const current = sessions.getMeta(sessionId)
        if (!current) throw new Error('Agent 会话不存在')
        if (expectedRevision !== undefined && (current.revision ?? 0) !== expectedRevision) throw new Error('REVISION_CONFLICT: 会话状态已更新，请刷新后重试')
        const updates = buildAgentSessionUiUpdates(current, action, unreadMode())
        if (updates) sessions.updateMeta(sessionId, updates.patch, { touchUpdatedAt: updates.touchUpdatedAt })
        return sessions.getMeta(sessionId)!
      })
      sessionUpdates.set(sessionId, applying)
      void applying.finally(() => { if (sessionUpdates.get(sessionId) === applying) sessionUpdates.delete(sessionId) }).catch(() => {})
      return applying
    },
    respondToPermission: (sessionId, requestId, behavior, alwaysAllow, runId) => permissions.respond(sessionId, requestId, behavior, alwaysAllow, runId),
    listPendingPermissions: sessionId => permissions.listPending(sessionId),
    planning,
    sessions,
    workspaces,
    resourceOperation: body => executeCoreResourceOperation({ config, workspaces, sessions, automations }, body),
    accountAvailable: Boolean(account),
    accountOperation: async (operation, args) => {
      if (!account) throw new Error('当前宿主不提供独立账号操作')
      await account.ready
      return account.operation(operation, args)
    },
    syncDesktopChannels: next => {
      if (!config.desktopWorkspaceIndexPath) throw new Error('仅桌面拥有的本地Core接受内存渠道快照')
      if (next.some(channel => !channel.id || !channel.provider || typeof channel.apiKey !== 'string')) throw new Error('渠道快照无效')
      if (dependencies.independent) {
        desktopChannels = structuredClone(next).filter(channel => !ownedChannels.some(owned => owned.id === channel.id))
        refreshChannels()
      } else channels.splice(0, channels.length, ...structuredClone(next))
    },
    listChannelConfigs: () => channels.map(channel => structuredClone(channel)),
    createChannel: input => {
      if (input.serverManaged) throw new Error('官方渠道不可通过自配渠道接口创建')
      const id = input.id?.trim() || randomUUID()
      if (channels.some(channel => channel.id === id)) throw new Error(`渠道 ID 已存在: ${id}`)
      const channel = { ...input, id }
      ownedChannels.push(channel)
      try { persistChannels() } catch (error) { ownedChannels.pop(); throw error }
      return structuredClone(channel)
    },
    updateChannel: (id, patch) => {
      if ((!ownedChannels.some(channel => channel.id === id) && account?.channels.some(channel => channel.id === id)) || patch.serverManaged) throw new Error('官方渠道不可修改')
      const index = ownedChannels.findIndex(channel => channel.id === id)
      if (index < 0) throw new Error(`渠道不存在: ${id}`)
      const previous = ownedChannels[index]!
      const updated = { ...previous, ...patch, id }
      ownedChannels[index] = updated
      try { persistChannels() } catch (error) { ownedChannels[index] = previous; throw error }
      return structuredClone(updated)
    },
    deleteChannel: id => {
      if (!ownedChannels.some(channel => channel.id === id) && account?.channels.some(channel => channel.id === id)) throw new Error('官方渠道不可删除')
      const index = ownedChannels.findIndex(channel => channel.id === id)
      if (index < 0) throw new Error(`渠道不存在: ${id}`)
      const [removed] = ownedChannels.splice(index, 1)
      try { persistChannels() } catch (error) { ownedChannels.splice(index, 0, removed!); throw error }
    },
    ensureWorkspaceSession: input => sessions.ensureWorkspaceSession(input),
    updateWorkspace: (id, updates) => workspaces.update(id, updates),
    deleteWorkspace: async (id, options = {}) => {
      const workspace = workspaces.list().find(item => item.id === id)
      if (!workspace) throw new Error(`Agent 工作区不存在: ${id}`)
      const project = workspace.storageMode === 'project' || (typeof workspace.rootPath === 'string' && isAbsolute(workspace.rootPath))
      if (options.projectOnly && !project) {
        workspaces.assertRemovable(id)
        throw new Error('不是项目模式工作区，不能按项目移除')
      }
      if (project) {
        workspaces.assertRemovable(id)
        const owned = sessions.list(true).filter(session => session.workspaceId === id)
        if (owned.some(session => coordinator.ownership.getOwner(session.id)
          || goals.list(session.id).some(goal => goal.status === 'active' || goal.status === 'stopping'))) throw new Error('工作区仍有活跃运行或Goal，请先停止后移除绑定')
        const tasks = automations.list().filter(item => item.workspaceId === id)
        for (const task of tasks) if (task.active) automations.update({ id: task.id, active: false })
        workspaces.remove(id)
        return
      }
      await processWorkspaceDelete(id, options.operationId ?? randomUUID())
    },
    retryWorkspaceDelete: async operationId => {
      const operation = workspaceOperations.get(operationId)
      if (!operation) throw new Error('工作区删除事务不存在')
      await processWorkspaceDelete(operation.workspace.id, operationId)
    },
    listWorkspaceDeleteOperations: () => workspaceOperations.list(),
    createConfiguredSession: input => {
      const resolved = configuredSessionInput(config, runtime, input, account ? { agentChannelId: account.defaultChannelId, agentModelId: account.defaultModelId } : undefined)
      workspaceCwd({ workspaceId: resolved.workspaceId } as AgentSessionMeta)
      return sessions.create(resolved)
    },
    ensureProjectDraftSession: input => {
      const workspace = workspaces.list().find(item => item.id === input.workspaceId)
      if (!workspace) throw new Error('Core 工作区不存在')
      // 同步检查与创建，无异步间隙；不得复用普通会话、归档或正在删除的草稿。
      const existing = sessions.list().find(item => item.workspaceId === workspace.id && item.draft && !item.archived)
      if (existing) {
        workspaceCwd(existing)
        if (sessions.readMessages(existing.id).some(message => message.type === 'user')) sessions.updateMeta(existing.id, { draft: false })
        return sessions.getMeta(existing.id)!
      }
      if (input.useCoreDefaults) {
        const resolved = configuredSessionInput(config, runtime, { workspaceId: input.workspaceId, channelId: input.channelId, modelId: input.modelId }, account ? { agentChannelId: account.defaultChannelId, agentModelId: account.defaultModelId } : undefined)
        workspaceCwd({ workspaceId: resolved.workspaceId } as AgentSessionMeta)
        return sessions.create({ ...resolved, draft: true })
      }
      const path = join(config.configDir, 'settings.json')
      const settings = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as { agentRuntime?: unknown } : {}
      const candidate: AgentSessionMeta = { id: '', title: '新 Agent 会话', workspaceId: workspace.id,
        agentRuntime: isAgentRuntime(settings.agentRuntime) ? settings.agentRuntime : defaultRuntime, createdAt: 0, updatedAt: 0 }
      workspaceCwd(candidate)
      const resources = resolveResources(candidate, workspace)
      return sessions.create({ ...input, title: candidate.title, runtime: candidate.agentRuntime, draft: true,
        presetId: resources.preset.id, presetReference: normalizeAgentPresetReference(resources.reference, workspace.slug),
        permissionMode: resources.policy.permissionMode })
    },
    saveAttachment: (sessionId, filename, base64) => {
      if (deletions.isDeleting(sessionId)) throw new Error('会话正在删除，不能写入附件')
      if (!sessions.getMeta(sessionId)) throw new Error('Agent会话不存在')
      return saveCoreAttachment(config.configDir, sessionId, filename, base64)
    },
    searchFiles: (sessionId, query, limit) => {
      if (deletions.isDeleting(sessionId)) throw new Error('会话正在删除')
      const session = sessions.getMeta(sessionId); if (!session?.workspaceId) throw new Error('会话不存在或未绑定工作区')
      const workspace = workspaces.list().find(item => item.id === session.workspaceId); if (!workspace) throw new Error('会话工作区不存在')
      return searchCoreFiles(config.configDir, config.workspaceRoot, workspace, session, query, limit)
    },
    readFile: (sessionId, filePath) => {
      if (deletions.isDeleting(sessionId)) throw new Error('会话正在删除')
      const session = sessions.getMeta(sessionId); if (!session?.workspaceId) throw new Error('会话不存在或未绑定工作区')
      const workspace = workspaces.list().find(item => item.id === session.workspaceId); if (!workspace) throw new Error('会话工作区不存在')
      return readCoreFile(config.configDir, config.workspaceRoot, workspace, session, filePath)
    },
    describeFileRoots: sessionId => {
      if (deletions.isDeleting(sessionId)) throw new Error('会话正在删除')
      const session = sessions.getMeta(sessionId); if (!session?.workspaceId) throw new Error('会话不存在或未绑定工作区')
      const workspace = workspaces.list().find(item => item.id === session.workspaceId); if (!workspace) throw new Error('会话工作区不存在')
      return describeCoreFileRoots(config.configDir, config.workspaceRoot, workspace, session)
    },
    listDirectoryEntries: (sessionId, dirPath) => {
      if (deletions.isDeleting(sessionId)) throw new Error('会话正在删除')
      const session = sessions.getMeta(sessionId); if (!session?.workspaceId) throw new Error('会话不存在或未绑定工作区')
      const workspace = workspaces.list().find(item => item.id === session.workspaceId); if (!workspace) throw new Error('会话工作区不存在')
      return listCoreFolderEntries(config.configDir, config.workspaceRoot, workspace, session, dirPath)
    },
    renameSessionEntry: (sessionId, path, name) => {
      const { session, workspace } = sessionScope(sessionId)
      return renameEntry(assertSessionPathAllowed(config.configDir, config.workspaceRoot, workspace, session, path), name, config.configDir)
    },
    moveSessionEntry: (sessionId, path, toDir, overwrite) => {
      const { session, workspace } = sessionScope(sessionId)
      const source = assertSessionPathAllowed(config.configDir, config.workspaceRoot, workspace, session, path)
      const target = assertSessionPathAllowed(config.configDir, config.workspaceRoot, workspace, session, toDir)
      return moveEntry(source, target, config.configDir, overwrite === true)
    },
    copySessionEntry: (sessionId, path, toDir, overwrite) => {
      const { session, workspace } = sessionScope(sessionId)
      const source = assertSessionPathAllowed(config.configDir, config.workspaceRoot, workspace, session, path)
      const target = assertSessionPathAllowed(config.configDir, config.workspaceRoot, workspace, session, toDir)
      return copyEntry(source, target, config.configDir, overwrite === true)
    },
    trashSessionEntry: (sessionId, path) => {
      const { session, workspace } = sessionScope(sessionId)
      return trashEntry(assertSessionPathAllowed(config.configDir, config.workspaceRoot, workspace, session, path), config.configDir)
    },
    previewSessionFile: (sessionId, path) => {
      const { session, workspace } = sessionScope(sessionId)
      return readEntryPreview(assertSessionPathAllowed(config.configDir, config.workspaceRoot, workspace, session, path), config.configDir)
    },
    renameSystemEntry: (path, name) => renameEntry(path, name, config.configDir),
    moveSystemEntry: (path, toDir, overwrite) => moveEntry(path, toDir, config.configDir, overwrite === true),
    copySystemEntry: (path, toDir, overwrite) => copyEntry(path, toDir, config.configDir, overwrite === true),
    trashSystemEntry: path => trashEntry(path, config.configDir),
    previewSystemFile: path => readEntryPreview(path, config.configDir),
    coordinator,
    get channels() { return channels.map(({ apiKey: _apiKey, codexOAuthCredentials: _codex, xaiOAuthCredentials: _xai, ...channel }) => channel) },
    titles,
    getTaskOutput: async (sessionId, taskId, options) => {
      const session = sessions.getMeta(sessionId)
      if (!session || deletions.isDeleting(sessionId)) throw new Error('Agent会话不存在或正在删除')
      if (!taskId || taskId.length > 200) throw new Error('后台任务标识无效')
      if (options?.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0 || options.timeoutMs > 30_000)) throw new Error('后台任务等待时限无效')
      return (session.agentRuntime === 'claude' ? claude : pi).getTaskOutput(sessionId, taskId, options)
    },
    stopTask: async (sessionId, taskId, expectedType) => {
      const session = sessions.getMeta(sessionId)
      if (!session || deletions.isDeleting(sessionId)) throw new Error('Agent会话不存在或正在删除')
      if (!taskId || taskId.length > 200) throw new Error('后台任务标识无效')
      await (session.agentRuntime === 'claude' ? claude : pi).stopTask(sessionId, taskId, expectedType)
    },
    queueMessage: (sessionId, prompt, options = {}) => {
      assertAcceptingRuns()
      const session = sessions.getMeta(sessionId)
      if (!session) throw new Error('Agent会话不存在')
      const uuid = options.uuid ?? randomUUID()
      const context = createAgentRunContext({ sessionId, uuid, initiator: 'user' }, randomUUID)
      const message = { type: 'user', uuid, session_id: sessionId, parent_tool_use_id: null,
        message: { role: 'user', content: [{ type: 'text', text: options.rawUserMessage ?? prompt }] }, _createdAt: Date.now() } as SDKMessage
      return coordinator.queueMessage({ sessionId, context, message, receive: async queued => {
        const provider = session.agentRuntime === 'claude' ? claude : pi
        if (options.interrupt && session.agentRuntime === 'claude') await provider.interruptQuery(sessionId)
        assertAcceptingRuns()
        if (!queued.isCurrent()) throw new Error('原运行已经结束，不能追加到新运行')
        await provider.sendQueuedMessage(sessionId, { type: 'user', uuid, session_id: sessionId, parent_tool_use_id: null,
          message: { role: 'user', content: prompt }, priority: 'next' }, { interrupt: options.interrupt, isCurrent: queued.isCurrent })
      } })
    },
    createQuery: (session, prompt, options) => {
      assertAcceptingRuns()
      return ({
      ...createRuntimeQuery(session, prompt, { ...config, channels }, { ...options, modelId: options?.modelId ?? session.modelId ?? channelFor(channels, options?.channelId ?? session.channelId)?.models?.find(model => model.enabled)?.id }),
      cwd: workspaceCwd(session).cwd,
      onBeforeOwnerRelease: async admitted => {
        const evidence = runEvidence.get(admitted.runId ?? '')
        if (evidence) {
          await evidence.finalize({ failed: runLedger.get(admitted.runId ?? '')?.status !== 'completed' })
          runEvidence.delete(admitted.runId ?? '')
        }
      },
      onRunAdmitted: query => {
        assertAcceptingRuns()
        const current = sessions.getMeta(session.id)!
        const workspace = workspaces.list().find(workspace => workspace.id === current.workspaceId)
        const resources = resolveResources(current, workspace)
        const servers = loadCoreMcpServers(resources.configDir, workspace?.storageMode === 'project', resources.policy)
        mcpRuns.set(query.runId, { servers })
        presetRuns.set(session.id, { runId: query.runId, resources })
        sessions.updateMeta(session.id, { channelId: query.channelId, modelId: query.modelId,
          presetId: resources.preset.id, presetReference: normalizeAgentPresetReference(resources.reference, workspace?.slug),
          ...(query.initiator === 'user' || query.initiator === 'external' ? { stoppedByUser: false } : {}) })
        // 终态后只撤销原 Run 的请求，不误清随后启动的新 Run。
        const unsubscribe = () => listeners.delete(onEvent)
        const onEvent = (event: CoreEvent) => {
          const payload = event.payload as { type?: string }
          const run = runLedger.get(query.runId)
          if (event.sessionId === session.id && payload.type === 'runtime_finished' && run && ['completed', 'failed', 'stopped'].includes(run.status)) {
            unsubscribe()
            desktopHosts.invalidateRun(session.id, query.runId)
            permissions.invalidatePending(session.id, query.runId)
            askUser.clearSessionPending(session.id, query.runId)
            exitPlan.clearSessionPending(session.id, query.runId)
            mcpRuns.delete(query.runId)
            skillRuns.delete(query.runId)
            if (presetRuns.get(session.id)?.runId === query.runId) presetRuns.delete(session.id)
            const outcome = (event.payload as { outcome?: { status?: string } }).outcome
            if (outcome?.status === 'completed') {
              if (query.initiator === 'user') void titles.afterCompletedTurn(session.id, options?.rawUserMessage ?? prompt).catch(error => console.warn('[Core 标题] 自动命名失败：', error))
              void goals.onRunFinished(session.id, query.initiator).catch(error => console.error('[Core Goal] 用户轮次续跑失败：', error))
            }
          }
        }
        listeners.add(onEvent)
      },
    }) },
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    publish,
    listRuns: () => runLedger.list(),
    stopDelegationsForParent: parentSessionId => delegations.stopParent(parentSessionId),
    nativeSessions,
    nativeOperations: {
      snapshot: (id, since) => {
        nativeOperations ??= createCoreNativeOperations(config, runtime)
        return nativeOperations.snapshot(id, since)
      },
      operation: (id, operation, input) => {
        nativeOperations ??= createCoreNativeOperations(config, runtime)
        return nativeOperations.operation(id, operation, input)
      },
    },
    desktopHosts,
    bindDesktopHost: (sessionId, connectionId) => {
      if (!sessions.getMeta(sessionId) || !desktopHosts.isConnected(connectionId)) throw new Error('桌面宿主绑定无效')
      const previous = desktopBindings.get(sessionId)
      if (previous && previous !== connectionId && coordinator.ownership.getOwner(sessionId)) throw new Error('会话正在运行，不能改派桌面宿主')
      desktopBindings.set(sessionId, connectionId)
    },
    unbindDesktopHost: connectionId => { for (const [id, connection] of desktopBindings) if (connection === connectionId) desktopBindings.delete(id) },
    beginShutdown: () => { closing = true },
    assertAcceptingRuns,
    shutdown: () => {
      closing = true
      shutdownPromise ??= (async () => { account?.dispose(); await chat.shutdown(); await deletions.shutdown(); await automations.shutdown(); await delegations.shutdown(); await goals.shutdown(); await coordinator.stopAll('core_shutdown'); await Promise.all([...browserSessions.values()].map(tools => tools.host.dispose())); await mcpManager.dispose(); runtime.dispose() })()
      return shutdownPromise
    },
    dispose: () => { account?.dispose(); closing = true; desktopHosts.dispose(); deletions.dispose(); delegations.dispose(); automations.dispose(); goals.dispose(); for (const session of sessions.list()) { askUser.clearSessionPending(session.id); exitPlan.clearSessionPending(session.id) }; clearInterval(planningTimer); planning.closePlanningDatabase(); claude.dispose(); pi.dispose() },
  }
  // 恢复必须在所有busy依赖初始化后、任何调度器绑定前进行。
  nativePorts.recover()
  for (const meta of sessions.list()) {
    if (meta.agentRuntime !== 'pi' || !meta.sdkSessionId) continue
    // 工作区被删除后残留的原生会话无法恢复，也不能因此让整个 Core 启动失败；
    // 其他恢复错误仍然抛出，避免带着损坏的回退事务继续运行。
    if (meta.workspaceId && !workspaces.list().some(workspace => workspace.id === meta.workspaceId)) {
      console.warn(`[Core] 会话 ${meta.id} 所属工作区已不存在，跳过原生回退恢复`)
      continue
    }
    nativeSessions.recoverPi(meta.id, config.configDir)
  }
  nativeRecovering = false
  goals.bindRuntime(runtime)
  delegations.bindRuntime(runtime)
  automations.setNotificationPort(createCoreAutomationNotificationHost({ configDir: config.configDir, readMessages: id => sessions.readMessages(id) }))
  automations.bindRuntime(runtime)
  deletions.bindRuntime(runtime)
  return runtime
}

export function createRuntimeQuery(session: AgentSessionMeta, prompt: string, config?: CoreConfig, options: CoreMessageOptions = {}): AgentRuntimeQuery {
  const runtime = session.agentRuntime ?? ((config?.channels ?? []).length ? 'pi' : 'claude')
  const uuid = options.uuid || crypto.randomUUID()
  const context = options.context ?? createAgentRunContext({ sessionId: session.id, uuid, initiator: 'external' }, () => crypto.randomUUID())
  const actor = context.trigger.actor.type
  const initiator = actor === 'user' ? 'user' : actor === 'automation' ? 'automation' : actor === 'agent' ? 'delegation' : 'external'
  return {
    sessionId: session.id,
    initiator,
    prompt,
    runtime,
    modelId: options.modelId ?? session.modelId,
    channelId: options.channelId ?? session.channelId ?? config?.channels?.[0]?.id ?? 'core-environment',
    cwd: join(config?.workspaceRoot ?? process.cwd(), session.workspaceId ?? session.id),
    ...(options.startedAt !== undefined ? { metadata: { startedAt: options.startedAt } } : {}),
    context,
    ...(options.credentials ? { prepared: { credentials: options.credentials } } : {}),
    persistedUserMessage: { type: 'user', message: { role: 'user', content: [{ type: 'text', text: options.rawUserMessage ?? prompt }] }, parent_tool_use_id: null, session_id: session.id, uuid, _createdAt: Date.now() },
  }
}

export type { AgentRuntimeRunHandle } from '@profer/agent-runtime'
