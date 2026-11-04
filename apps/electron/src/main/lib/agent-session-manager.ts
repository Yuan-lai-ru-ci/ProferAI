/**
 * Agent 会话管理器
 *
 * 负责 Agent 会话的 CRUD 操作和消息持久化。
 * - 会话索引：~/.profer/agent-sessions.json（轻量元数据）
 * - 消息存储：~/.profer/agent-sessions/{id}.jsonl（JSONL 格式，逐行追加）
 *
 * 照搬 conversation-manager.ts 的模式。
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, unlinkSync, rmSync, renameSync, readdirSync, cpSync, copyFileSync, createReadStream, createWriteStream, type WriteStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { rm as rmAsync } from 'node:fs/promises'
import { createAgentSessionIndexStore } from './agent-session-index'
import { createSyncSessionMessageStore, type AgentSessionsIndex } from '@profer/session-store'
import { createSnippet, extractTextFromPersistedMessage, matchAgentJsonlLine } from './agent-session-search'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { isAbsolute, join, relative, resolve, dirname, sep, basename } from 'node:path'
import {
  getAgentSessionsIndexPath,
  getAgentSessionsDir,
  getAgentSessionMessagesPath,
  getAgentSessionGraphPath,
  getPiHarnessEventsPath,
  getPiTranscriptDirForSession,
  getAgentSessionCwd,
  getAgentSessionWorkspacePath,
  resolveAgentSessionWorkspacePath,
  resolveProjectSessionFallbackDir,
  getAgentWorkspacePath,
  getPiCheckpointsDir,
  getSdkConfigDir,
  getAgentAttachmentBackupsRoot,
} from './config-paths'
import { getAgentWorkspace, listAgentWorkspaces } from './agent-workspace-manager'
import { resolveWorkspaceLocation, requireExistingWorkspaceRoot, type WorkspaceLocation } from './workspace-locator'
import { collectAttachedDirectories } from './agent-directory-utils'
import { assertEnabledModelForChannel } from './agent-model-selection'
import { copyForkWorkspaceFiles } from './agent-fork-workspace-copy'
import { copyForkFile, buildForkProjectKey, renameForkFile, removeForkPathAsync } from './fork-file-ops'
import { listAgentPresets, normalizeSessionPresetId, presetReferenceForId } from './agent-preset-manager'
import { copySettledPiHarnessEventsForFork } from './pi-harness/pi-harness-store'
import { forkPiSessionArtifact } from './pi-session-fork'
import { isRecoveredEphemeralTransportError } from './error-patterns'
import { adoptPiFileCheckpoints, loadPiFileCheckpoint, restorePiFileCheckpoint, prunePiFileCheckpoints, removePiFileCheckpointsAsync } from './pi-file-checkpoint'
import { getPiTranscriptIndex, invalidatePiTranscriptCache, resolvePiTranscriptPath } from './pi-session-files'
import { isSessionDeletionPending } from './agent-session-deletion-queue'
import { removeToolResultDirAsync } from './agent-tool-result-store'
import { assertNotProjectLifecyclePath } from './workspace-delete-guard'
import { readProjectSessionIndex, writeProjectSessionIndex } from './project-session-index'
import {
  defaultStorageLayoutForWorkspace,
  moveSessionDataFiles,
  projectSessionDataDir,
  registerSessionLayout,
  resolveSessionStorageLayout,
  syncSessionStorageLayouts,
  unregisterSessionLayout,
} from './session-data-layout'

// 在模块加载时一次性设置 SDK 配置目录，避免在 forkSession 等异步调用中临时修改/恢复
// process.env 导致的并发安全问题（异步操作的 await 间隙其他代码可能读到错误值）。
//
// ⚠️ 必须【无条件】强制覆盖，不能用 `if (!process.env.CLAUDE_CONFIG_DIR)` 守卫：
// getSdkConfigDir 的设计目标就是「与用户 Claude Code CLI 的配置隔离」。若用户装了
// Claude Code CLI（或 shell/CI 里）本就设了 CLAUDE_CONFIG_DIR，旧守卫会跳过覆盖 →
// 进程内的 sdk.forkSession（只读 process.env，不像 orchestrator query 子进程那样显式传参）
// 会去读用户/CLI 的配置目录，导致 dev/生产/CLI 三方 SDK 会话数据互相污染、fork 报
// "Session not found"。这里强制指向 Profer 隔离目录，检测到外部不同值时打 warn 以便排查。
{
  const proferSdkConfigDir = getSdkConfigDir()
  const ambientConfigDir = process.env.CLAUDE_CONFIG_DIR
  if (ambientConfigDir && ambientConfigDir !== proferSdkConfigDir) {
    console.warn(
      `[Agent 会话] 检测到外部 CLAUDE_CONFIG_DIR=${ambientConfigDir}（可能来自 Claude Code CLI / shell / CI），` +
      `已强制覆盖为 Profer 隔离目录: ${proferSdkConfigDir}（配置隔离，避免 SDK 会话数据串目录）`,
    )
  }
  process.env.CLAUDE_CONFIG_DIR = proferSdkConfigDir
}
import {
  normalizeAgentRuntime,
  canSelectAgentSessionRuntime,
  AGENT_SESSION_RUNTIME_LOCKED_MESSAGE,
  AgentSessionRuntimeMismatchError,
  type AgentSessionMeta,
  type AgentMessage,
  type SDKMessage,
  type SDKUserMessage,
  type ForkSessionInput,
  type AgentMessageSearchResult,
  type AgentSessionReferenceSearchInput,
  type AgentSessionReferenceSearchResult,
  type SessionHealth,
  type AgentRuntime,
  type RewindSessionResult,
} from '@profer/shared'
import { getConversationMessages } from './conversation-manager'
import { isUserInputMessage } from '@profer/session-core'

const activeForkSessionIds = new Set<string>()
let agentSessionActiveChecker: ((sessionId: string) => boolean) | undefined

/** 由 agent-service 注入运行时活跃状态，避免 manager 反向依赖 orchestrator。 */
export function setAgentSessionActiveChecker(checker: ((sessionId: string) => boolean) | undefined): void {
  agentSessionActiveChecker = checker
}

export function isAgentSessionForking(sessionId: string): boolean {
  return activeForkSessionIds.has(sessionId)
}

interface PersistedAssistantMessage {
  type?: string
  role?: string
  content?: string
  message?: { content?: Array<{ type?: string; text?: string }> }
  error?: { message?: string; errorType?: string }
  errorCode?: string
  _errorCode?: string
}

function getPersistedAssistantError(message: unknown): { errorCode?: string; errorText?: string } | null {
  if (!message || typeof message !== 'object') return null
  const assistant = message as PersistedAssistantMessage
  const isAssistantError = assistant.type === 'assistant' && (assistant.error || assistant._errorCode)
  const isLegacyStatusError = assistant.role === 'status' && assistant.errorCode
  if (!isAssistantError && !isLegacyStatusError) return null
  const errorText = assistant.error?.message ?? assistant.message?.content
    ?.filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text!)
    .join('\n') ?? assistant.content
  return { errorCode: assistant._errorCode ?? assistant.error?.errorType ?? assistant.errorCode, errorText }
}
import {
  buildGraphFromEvents,
  parseEventsFromJsonl,
  serializeEvent,
} from '@profer/project-core'
// GPT Image 生图工具仅在 Chat 模式可用，Agent 模式不需要清理逻辑

// 索引存储独立管理缓存与原子读写；manager 保留现有公开入口。
const sessionIndex = createAgentSessionIndexStore(getAgentSessionsIndexPath)
const readIndexRaw = sessionIndex.read
let lastLayoutSyncIndex: unknown = null

interface ProjectSessionMirror {
  id: string
  rootPath: string
}

function listProjectSessionMirrors(): ProjectSessionMirror[] {
  return listAgentWorkspaces()
    .filter((workspace) => workspace.storageMode === 'project' && typeof workspace.rootPath === 'string' && workspace.rootPath.length > 0)
    .map((workspace) => ({ id: workspace.id, rootPath: workspace.rootPath! }))
}

const mirroredProjectSignatures = new Map<string, string>()

/** 列表级签名：覆盖排序、标题、置顶/归档与 revision，避免每次写盘都重写未变化的项目。 */
function projectIndexSignature(sessions: readonly AgentSessionMeta[]): string {
  return sessions
    .map((session) => `${session.id}:${session.updatedAt ?? 0}:${session.revision ?? 0}:${session.title}:${session.pinned ? 1 : 0}:${session.archived ? 1 : 0}`)
    .join('|')
}

/**
 * 把全局索引里属于各 project 的会话镜像到 `<root>/.profer/sessions/index.json`。
 *
 * 失败只记日志：项目可能只读/离线，不能因此阻断全局索引写入。
 */
function mirrorProjectSessionIndexes(index: AgentSessionsIndex): void {
  const mirrors = listProjectSessionMirrors()
  if (mirrors.length === 0) return

  const byWorkspace = new Map<string, AgentSessionMeta[]>()
  for (const session of index.sessions) {
    if (!session.workspaceId) continue
    const list = byWorkspace.get(session.workspaceId) ?? []
    list.push(session)
    byWorkspace.set(session.workspaceId, list)
  }

  for (const mirror of mirrors) {
    const sessions = (byWorkspace.get(mirror.id) ?? [])
      .slice()
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    const signature = projectIndexSignature(sessions)
    const cacheKey = `${mirror.id}|${mirror.rootPath}`
    if (mirroredProjectSignatures.get(cacheKey) === signature) continue
    try {
      writeProjectSessionIndex(mirror.rootPath, sessions)
      mirroredProjectSignatures.set(cacheKey, signature)
    } catch (error) {
      console.warn(`[Agent 会话] 写入项目会话索引失败 (${mirror.rootPath}):`, error)
    }
  }
}

/**
 * 启动对账：把项目索引里比全局更新的会话合并回来。
 *
 * 典型场景：项目从另一台机器拷来，全局索引没有它的会话；或者上次退出前
 * 项目索引已写、全局索引尚未写。冲突时按 updatedAt 取新。
 */
function reconcileProjectSessionIndexes(index: AgentSessionsIndex, force = false): boolean {
  let changed = false
  const byId = new Map(index.sessions.map((session) => [session.id, session]))

  for (const mirror of listProjectSessionMirrors()) {
    if (!force && reconciledProjectRoots.has(mirror.rootPath)) continue
    reconciledProjectRoots.add(mirror.rootPath)
    const entries = readProjectSessionIndex(mirror.rootPath)
    if (!entries) continue
    for (const entry of entries) {
      const normalized: AgentSessionMeta = { ...entry, workspaceId: mirror.id }
      const existing = byId.get(normalized.id)
      if (!existing) {
        index.sessions.push(normalized)
        byId.set(normalized.id, normalized)
        changed = true
        continue
      }
      if ((normalized.updatedAt ?? 0) > (existing.updatedAt ?? 0)) {
        Object.assign(existing, normalized)
        changed = true
      }
    }
  }

  return changed
}

const reconciledProjectRoots = new Set<string>()

/** 供打开/重新定位项目后显式对账（同一进程内新出现的项目）。 */
export function reconcileProjectSessionIndexesNow(): void {
  const index = readIndexRaw()
  if (reconcileProjectSessionIndexes(index, true)) sessionIndex.write(index)
  mirrorProjectSessionIndexes(index)
}

/**
 * 读索引时顺带刷新会话布局注册表。
 *
 * 索引存储命中缓存时返回同一个对象，用身份比较避免每次热路径都重扫 1000+ 会话；
 * 新建/迁移/删除会显式注册或注销，不依赖下一次读盘。
 */
const readIndex = () => {
  const index = readIndexRaw()
  if (reconcileProjectSessionIndexes(index)) sessionIndex.write(index)
  if (index !== lastLayoutSyncIndex) {
    lastLayoutSyncIndex = index
    syncSessionStorageLayouts(index.sessions)
  }
  return index
}

const writeIndex = (index: AgentSessionsIndex) => {
  sessionIndex.write(index)
  mirrorProjectSessionIndexes(index)
}

const syncMessageStore = createSyncSessionMessageStore(
  () => ({ sessionsDir: getAgentSessionsDir() }),
  {
    parseMessage: (sessionId, line) => parseSDKMessageLine(line, sessionId) ?? undefined,
    serializeMessage: (sessionId, message) => serializeSDKMessageForStorage(message, undefined, undefined),
  },
)

/**
 * 本进程内已删除的会话。
 *
 * 强制删除时 run 可能还没真正退出，后续 append 会把刚删掉的 JSONL 重新创建出来。
 * 删除时先登记，写入侧直接丢弃，保证「删了就是删了」。
 */
const deletedSessionIds = new Set<string>()

/** 供运行收尾/写入路径判断会话是否已被删除。 */
export function isAgentSessionDeleted(id: string): boolean {
  return deletedSessionIds.has(id)
}

/** 删除被放弃（会话仍在索引里）时撤销墓碑，恢复它的消息写入。 */
export function clearAgentSessionDeletionTombstone(id: string): void {
  deletedSessionIds.delete(id)
}

/** UPDATE_SESSION_AGENT_RUNTIME 需要原子回滚的 runtime-owned 元数据快照。 */
export interface AgentRuntimeMetaSnapshot {
  agentRuntime: AgentRuntime
  agentRuntimeLocked?: boolean
  codexFastMode?: boolean
  sdkSessionId?: string
  piSessionFile?: string
  piEntryBindings?: Record<string, string>
  piFileCheckpoints?: Record<string, string>
  forkSourceDir?: string
  forkSourceSdkSessionId?: string
  resumeAtMessageUuid?: string
}

export function snapshotAgentRuntimeMeta(meta: AgentSessionMeta): AgentRuntimeMetaSnapshot {
  return {
    agentRuntime: normalizeAgentRuntime(meta.agentRuntime),
    agentRuntimeLocked: meta.agentRuntimeLocked,
    codexFastMode: meta.codexFastMode,
    sdkSessionId: meta.sdkSessionId,
    piSessionFile: meta.piSessionFile,
    piEntryBindings: meta.piEntryBindings,
    piFileCheckpoints: meta.piFileCheckpoints,
    forkSourceDir: meta.forkSourceDir,
    forkSourceSdkSessionId: meta.forkSourceSdkSessionId,
    resumeAtMessageUuid: meta.resumeAtMessageUuid,
  }
}

/**
 * 仅为空会话选择内核后设置写入失败提供回滚；会话已绑定或开始运行时禁止恢复旧选择。
 * 回滚也递增 revision，确保各端接收的是更新的快照。
 */
export function restoreAgentRuntimeMeta(id: string, snapshot: AgentRuntimeMetaSnapshot): AgentSessionMeta {
  const index = readIndex()
  const idx = index.sessions.findIndex((s) => s.id === id)
  if (idx === -1) throw new Error(`Agent 会话不存在: ${id}`)

  const existing = index.sessions[idx]!
  if (!canSelectAgentSessionRuntime(existing) || agentSessionActiveChecker?.(id)
    || getAgentSessionSDKMessages(id).some((message) => message.type === 'user')) {
    throw new Error('会话已绑定或正在运行，不能回滚内核选择')
  }
  const restored: AgentSessionMeta = {
    ...existing,
    agentRuntime: snapshot.agentRuntime,
    agentRuntimeLocked: snapshot.agentRuntimeLocked,
    codexFastMode: snapshot.codexFastMode,
    sdkSessionId: snapshot.sdkSessionId,
    piSessionFile: snapshot.piSessionFile,
    piEntryBindings: snapshot.piEntryBindings,
    piFileCheckpoints: snapshot.piFileCheckpoints,
    forkSourceDir: snapshot.forkSourceDir,
    forkSourceSdkSessionId: snapshot.forkSourceSdkSessionId,
    resumeAtMessageUuid: snapshot.resumeAtMessageUuid,
    revision: (existing.revision ?? 0) + 1,
    updatedAt: Date.now(),
  }
  index.sessions[idx] = restored
  writeIndex(index)
  return restored
}

/**
 * 为委派子会话创建 agent-sessions.json 索引条目。
 *
 * 协作 MCP 工具（由平台层提供）创建子 SDK 会话后，需调用此函数将元数据
 * 写入 Profer 的 agent-sessions.json，否则侧栏无法发现和显示该子会话。
 */
export function createDelegatedChildSessionMeta(params: {
  childSessionId: string
  parentSessionId: string
  sourceDelegationId: string
  title: string
  channelId?: string
  modelId?: string
  workspaceId?: string
  sourceSessionId?: string
  sourceRunId?: string
  delegationRelation?: 'subtask' | 'independent'
  delegationPlacement?: 'current' | 'child' | 'independent'
  delegationRole?: string
  delegationGoal?: string
  permissionMode?: import('@profer/shared').ProferPermissionMode
}): AgentSessionMeta {
  const index = readIndex()
  const now = Date.now()

  // 检查是否已存在（幂等）
  const existing = index.sessions.find((s) => s.id === params.childSessionId)
  if (existing) {
    return updateAgentSessionMeta(params.childSessionId, {
      parentSessionId: params.parentSessionId,
      sourceDelegationId: params.sourceDelegationId,
      sourceSessionId: params.sourceSessionId ?? params.parentSessionId,
      sourceRunId: params.sourceRunId,
      delegationRelation: params.delegationRelation ?? 'subtask',
      delegationPlacement: params.delegationPlacement ?? 'child',
      delegationStatus: 'running',
      delegationRole: params.delegationRole,
      delegationGoal: params.delegationGoal,
      permissionMode: params.permissionMode,
    })
  }

  const meta: AgentSessionMeta = {
    id: params.childSessionId,
    title: params.title || '委派子会话',
    channelId: params.channelId,
    modelId: params.modelId,
    workspaceId: params.workspaceId,
    parentSessionId: params.parentSessionId,
    sourceDelegationId: params.sourceDelegationId,
    sourceSessionId: params.sourceSessionId ?? params.parentSessionId,
    sourceRunId: params.sourceRunId,
    delegationRelation: params.delegationRelation ?? 'subtask',
    delegationPlacement: params.delegationPlacement ?? 'child',
    delegationStatus: 'running',
    delegationRole: params.delegationRole,
    delegationGoal: params.delegationGoal,
    permissionMode: params.permissionMode,
    createdAt: now,
    updatedAt: now,
  }

  index.sessions.push(meta)
  writeIndex(index)

  console.log(`[协作] 已创建委派子会话索引: ${meta.title} (${meta.id})`)
  return meta
}

/**
 * 获取会话列表（按 updatedAt 降序）
 *
 * @param includeArchived 是否包含已归档会话；默认 false（高频侧边栏刷新只拉活跃）
 */
/**
 * 为历史上没有记录 piSessionFile 的 Pi 会话补齐 transcript 路径。
 *
 * 删除与健康检查都优先用 `piSessionFile`，缺失时才回退到目录扫描（本机冷扫 2.9s）。
 * 启动后空闲时段跑一次批量补齐，把回退路径压到接近零。
 *
 * @returns 补齐的会话数
 */
export function backfillPiSessionFiles(): number {
  const index = readIndex()
  const candidates = index.sessions.filter((session) => normalizeAgentRuntime(session.agentRuntime) === 'pi'
    && session.sdkSessionId
    && !session.piSessionFile)
  if (candidates.length === 0) return 0

  // 按会话所在布局分组扫描，避免每个会话各扫一遍；project 与 managed 的 transcript 目录不同。
  const matches = new Map<string, string[]>()
  const roots = new Set(candidates.map((session) => getPiTranscriptDirForSession(session.id)))
  for (const rootDir of roots) {
    for (const [sdkId, paths] of getPiTranscriptIndex({ rootDir, force: true })) {
      const existing = matches.get(sdkId) ?? []
      matches.set(sdkId, [...existing, ...paths])
    }
  }
  let updated = 0
  for (const session of candidates) {
    const paths = matches.get(session.sdkSessionId!)
    if (!paths || paths.length !== 1) continue
    const idx = index.sessions.findIndex((item) => item.id === session.id)
    if (idx < 0) continue
    index.sessions[idx] = { ...index.sessions[idx]!, piSessionFile: paths[0] }
    updated += 1
  }
  if (updated > 0) {
    writeIndex(index)
    console.log(`[Agent 会话] 已补齐 ${updated} 个 Pi 会话的 transcript 路径`)
  }
  return updated
}

/**
 * 列表投影：侧栏 / 标签页 / 自动化选择器都不需要 Pi 状态。
 *
 * 索引拆分只解决磁盘写放大；合并后的完整对象仍会经 LIST_SESSIONS 传输（本机约 20MB）。
 * 在 IPC 边界裁掉两个大字段，载荷回到 ~1.5MB。类型仍是 AgentSessionMeta（字段可选），
 * 因此渲染层调用方不需要大规模改类型。
 */
export function toAgentSessionSummary(meta: AgentSessionMeta): AgentSessionMeta {
  if (meta.piFileCheckpoints === undefined && meta.piEntryBindings === undefined) return meta
  const { piFileCheckpoints: _fileCheckpoints, piEntryBindings: _entryBindings, ...rest } = meta
  return rest
}

export function listAgentSessions(includeArchived = false): AgentSessionMeta[] {
  // 已接受删除但还没清理完的会话不再对外可见：入队即隐藏，避免刷新后复活。
  return readIndex().sessions
    .filter((session) => includeArchived || !session.archived)
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    .filter((session) => !isSessionDeletionPending(session.id))
}

/** 已归档 Agent 会话数量；不含隐藏草稿与待删除会话。 */
export function countArchivedAgentSessions(): number {
  return readIndex().sessions
    .filter((session) => session.archived && !session.draft && !isSessionDeletionPending(session.id))
    .length
}

/** 将会话 runtime 固定为当前值；历史会话缺省锁定，只有新建且尚未运行的会话可选。 */
export function lockAgentSessionRuntime(id: string, runtime: AgentRuntime): AgentSessionMeta {
  const existing = getAgentSessionMeta(id)
  if (!existing) throw new Error(`Agent 会话不存在: ${id}`)
  const currentRuntime = normalizeAgentRuntime(existing.agentRuntime)
  if (currentRuntime !== runtime) throw new AgentSessionRuntimeMismatchError(currentRuntime, runtime)
  if (existing.agentRuntimeLocked === true) return existing
  return updateAgentSessionMeta(id, { agentRuntimeLocked: true })
}

/** 获取单个会话的元数据。 */
export function getAgentSessionMeta(id: string): AgentSessionMeta | undefined {
  return readIndex().sessions.find((session) => session.id === id)
}

/**
 * 收集其他会话仍在引用的 Pi 文件检查点路径。
 *
 * 正常分叉会迁移基线到自己的目录；这里仍保护旧版/迁移失败时遗留的跨会话引用，
 * 防止源会话常规回收把分叉侧的回退点静默删掉。这些路径仍计入所在会话的体积/数量预算。
 *
 * @param excludeSessionId 正在做回收的会话；它自己的引用由调用方显式传入
 */
export function collectForeignCheckpointPaths(excludeSessionId: string): Set<string> {
  const referenced = new Set<string>()
  for (const session of readIndex().sessions) {
    if (session.id === excludeSessionId) continue
    for (const checkpointPath of Object.values(session.piFileCheckpoints ?? {})) referenced.add(checkpointPath)
  }
  return referenced
}

/** 归一化路径包含判定；仅用于历史脏路径兜底，热路径走前缀比较。 */
function isPathWithin(root: string, candidate: string): boolean {
  const relativePath = relative(resolve(root), resolve(candidate))
  return Boolean(relativePath)
    && relativePath !== '..'
    && !relativePath.startsWith('../')
    && !relativePath.startsWith('..\\')
    && !isAbsolute(relativePath)
}

/**
 * 获取删除指定会话时应一并处理的会话 ID，顺序为子会话到父会话。
 * 仅将带 sourceDelegationId 的协作委派子会话纳入级联删除，避免误删普通会话。
 */
export function getAgentSessionDeletionOrder(id: string): string[] {
  const sessions = readIndex().sessions
  const childrenByParentId = new Map<string, AgentSessionMeta[]>()
  for (const session of sessions) {
    if (!session.parentSessionId || !session.sourceDelegationId) continue
    const children = childrenByParentId.get(session.parentSessionId) ?? []
    children.push(session)
    childrenByParentId.set(session.parentSessionId, children)
  }

  const visited = new Set<string>()
  const order: string[] = []
  const visit = (sessionId: string): void => {
    if (visited.has(sessionId)) return
    visited.add(sessionId)
    for (const child of childrenByParentId.get(sessionId) ?? []) visit(child.id)
    order.push(sessionId)
  }
  visit(id)
  return order
}

/**
 * 会话私有写入布局
 *
 * 一份数据只有一套落点，全部在 `storageDir` 之内：
 * - managed：`storageDir` 就是 cwd（`<configDir>/<sessionId>`），与改造前逐字一致；
 * - project：`storageDir` 在项目内 `<root>/.profer/sessions/<sid>`（旧中央目录仍存在时沿用）。
 *
 * 为什么需要这张表：project 下 cwd = 项目根，任何 `join(cwd, '.context')` 都会把会话产物
 * 写进用户仓库。写入方（会话创建 / 计划模式 / 生图 / 诊断）必须从这里取路径，
 * 而不是各自拿 cwd 去拼。
 */
export interface AgentSessionWriteLayout {
  /** 会话私有数据根：managed = cwd；project = 中央 `~/.profer/agent-workspaces/<slug>/sessions/<id>` */
  storageDir: string
  /** `.context/`：会话级任务工作台 */
  contextDir: string
  /** `.context/plan/`：计划模式计划文件落点 */
  plansDir: string
  /** `.context/agent-output-images/`：生图输出落点 */
  imageOutputDir: string
  /** `.context/session-errors.log`：故障诊断落点 */
  errorsLogPath: string
  /** `.claude/settings.json`：SDK 项目设置 */
  claudeSettingsPath: string
  /**
   * 写入 `plansDirectory` 的值；
   *
   * SDK 将其解释为「相对项目根」（sdk.d.ts: `Custom directory for plan files, relative to project root`），
   * 所以 project 下不能填绝对路径：若 CLI 用 `join(projectRoot, value)` 解析，绝对路径会被拼进项目里。
   * 这里改用「从项目根指向中央计划目录的相对路径」，`join` 与 `resolve` 两种实现都能落到 storageDir。
   *
   * `undefined`：project 根与配置目录不在同一盘符（Windows），既无合法相对路径、
   * 绝对值又会被 join 拼进项目，这时不写该键，让 SDK 回退到自己的默认目录（项目之外）。
   */
  plansDirectory?: string
}

/**
 * 计算会话私有写入布局（纯计算，不 mkdir）
 *
 * @throws WorkspaceRootMissingError project 的 rootPath 不存在（不会自动创建）
 */
export function resolveAgentSessionWriteLayout(workspaceSlug: string, sessionId: string): AgentSessionWriteLayout {
  const location = resolveWorkspaceLocation(workspaceSlug)
  // project 的 rootPath 缺失时直接抛错（WorkspaceRootMissingError，不会自动创建）：
  // 绝不回退到「写 cwd」这种会污染项目的做法。
  requireExistingWorkspaceRoot(location)
  return buildAgentSessionWriteLayout(location, resolveAgentSessionWorkspacePath(workspaceSlug, sessionId))
}

/** 按给定 storageDir 计算布局（纯计算）；project 的 plansDirectory 必须是相对项目根的路径。 */
function buildAgentSessionWriteLayout(location: WorkspaceLocation, storageDir: string): AgentSessionWriteLayout {
  const contextDir = join(storageDir, '.context')
  const plansDir = join(contextDir, 'plan')

  let plansDirectory: string | undefined = '.context'
  if (location.mode === 'project') {
    const rel = relative(location.rootPath, contextDir)
    // 跨盘符时 relative 返回绝对路径：不写该键（SDK 回退到项目外的默认目录），
    // 因为绝对值在 join 语义下会拼进项目根。
    plansDirectory = rel.length > 0 && !isAbsolute(rel) ? rel : undefined
  }

  return {
    storageDir,
    contextDir,
    plansDir,
    imageOutputDir: join(contextDir, 'agent-output-images'),
    errorsLogPath: join(contextDir, 'session-errors.log'),
    claudeSettingsPath: join(storageDir, '.claude', 'settings.json'),
    plansDirectory,
  }
}

/**
 * 准备会话私有目录与 SDK 设置（唯一写入口，会话创建 / 首次使用都调它）
 *
 * 写入内容：
 * - `<storageDir>/.claude/settings.json`：`plansDirectory`（计划目录）与 `skipWebFetchPreflight`
 * - `<storageDir>/.context/`、`<storageDir>/.context/plan/`：Profer 不建隐式父目录，这里显式准备
 *
 * 与 SDK 读取位置的关系（如实记录）：Claude SDK 的项目设置取自 **cwd** 下的 `.claude/settings.json`，
 * 所以 project 模式下这份副本对 SDK 是惰性的——它只保证「会话私有配置不落项目」。
 * 要让 project 的计划目录真正生效，宿主必须把同一组设置通过 `queryOptions.settings`（内联对象）
 * 下发，而不是写文件（orchestrator 侧改动，不在本模块职责内）。
 *
 * **禁止**把这里的目标换成 cwd：project 下 cwd 是用户项目根，会直接改用户仓库。
 */
export function ensureAgentSessionWriteLayout(workspaceSlug: string, sessionId: string): AgentSessionWriteLayout {
  const location = resolveWorkspaceLocation(workspaceSlug)
  const layout = resolveAgentSessionWriteLayout(workspaceSlug, sessionId)
  // storageDir 带 mkdir 副作用；project 目录不可写时它会回退到中央 runtimeDir（见 getAgentSessionStorageDir）。
  const created = getAgentSessionWorkspacePath(workspaceSlug, sessionId)
  let effective = layout
  if (resolve(created) !== resolve(layout.storageDir)) {
    // 唯一允许的偏差：project 只读 → 会话数据回退中央。其它任何不一致都说明路径契约被改坏，
    // 继续写就可能落进项目根（I3），必须拒绝。
    const fallbackDir = resolve(resolveProjectSessionFallbackDir(workspaceSlug, sessionId))
    if (location.mode !== 'project' || resolve(created) !== fallbackDir) {
      throw new Error(`会话存储目录解析不一致，拒绝写入: ${created} ≠ ${layout.storageDir}`)
    }
    effective = buildAgentSessionWriteLayout(location, created)
  }
  assertNotProjectLifecyclePath(effective.storageDir)

  const claudeDir = dirname(effective.claudeSettingsPath)
  if (!existsSync(claudeDir)) mkdirSync(claudeDir, { recursive: true })
  let sdkSettings: Record<string, unknown> = {}
  try {
    sdkSettings = JSON.parse(readFileSync(effective.claudeSettingsPath, 'utf-8'))
  } catch { /* 文件不存在或解析失败 */ }
  let needsWrite = false
  if (effective.plansDirectory === undefined) {
    // 无合法相对路径时不写该键，让 SDK 用默认（项目之外）目录
    if ('plansDirectory' in sdkSettings) {
      delete sdkSettings.plansDirectory
      needsWrite = true
    }
  } else if (sdkSettings.plansDirectory !== effective.plansDirectory) {
    sdkSettings.plansDirectory = effective.plansDirectory
    needsWrite = true
  }
  if (sdkSettings.skipWebFetchPreflight !== true) {
    sdkSettings.skipWebFetchPreflight = true
    needsWrite = true
  }
  if (needsWrite) {
    writeFileSync(effective.claudeSettingsPath, JSON.stringify(sdkSettings, null, 2))
  }

  if (!existsSync(effective.contextDir)) mkdirSync(effective.contextDir, { recursive: true })
  if (!existsSync(effective.plansDir)) mkdirSync(effective.plansDir, { recursive: true })

  return effective
}

/**
 * 创建新会话
 */
export function createAgentSession(
  title?: string,
  channelId?: string,
  workspaceId?: string,
  modelId?: string,
  agentRuntime: AgentRuntime = 'claude',
  draft = false,
  presetId?: string,
): AgentSessionMeta {
  const index = readIndex()
  const now = Date.now()

  // 预设工作区化：按会话工作区解析（未指定/不存在时仅内置预设可用）
  const presetWorkspaceSlug = workspaceId ? getAgentWorkspace(workspaceId)?.slug : undefined

  // 先统一计算规范化后的 ID，再用同一个 ID 构建稳定引用。
  // 不能把原始 presetId 传给 presetReferenceForId：旧会话/快捷入口未传
  // presetId 时，前者会回退为 standard，而后者会得到空引用，发送校验就会
  // 错误地报 AGENT_PRESET_REQUIRED。
  const normalizedPresetId = normalizeSessionPresetId(presetWorkspaceSlug, presetId)
  // 未显式指定或默认值已被清除时，自动选择当前工作区首个仍启用的预设。
  // 只有工作区确实没有任何可用预设时才保留空值，让 UI 展示配置提示。
  const effectivePresetId = normalizedPresetId || listAgentPresets(presetWorkspaceSlug)
    .find((preset) => preset.enabledInWorkspace !== false)?.id || ''
  const meta: AgentSessionMeta = {
    id: randomUUID(),
    title: title || '新 Agent 会话',
    channelId,
    modelId,
    workspaceId,
    agentRuntime: normalizeAgentRuntime(agentRuntime),
    agentRuntimeLocked: false,
    storageLayout: defaultStorageLayoutForWorkspace(workspaceId),
    ...(effectivePresetId ? { presetId: effectivePresetId, presetReference: presetReferenceForId(presetWorkspaceSlug, effectivePresetId) } : {}),
    ...(draft ? { draft: true } : {}),
    createdAt: now,
    updatedAt: now,
  }

  // 先准备会话私有写入布局（.claude/settings.json + .context/ + .context/plan/），再写索引。
  // 全部落在 storageDir：project 下 cwd 是项目根，绝不能把会话产物写进用户仓库（I3）。
  //
  // 顺序不能反：project 根被移走 / 目录不可写时这里会抛 WorkspaceRootMissingError，
  // 若先写索引就会留下一条指向「从未真正创建成功」的孤儿会话（IM Bot 建会话失败时尤其明显）。
  if (workspaceId) {
    const ws = getAgentWorkspace(workspaceId)
    if (ws) ensureAgentSessionWriteLayout(ws.slug, meta.id)
  }

  index.sessions.push(meta)
  writeIndex(index)
  registerSessionLayout(meta)

  // 确保消息目录存在（project 在会话数据目录，managed 在全局目录）
  getAgentSessionsDir()

  console.log(`[Agent 会话] 已创建会话: ${meta.title} (${meta.id})`)
  return meta
}

/** 同一项目只保留一个未归档的隐藏草稿会话。函数没有异步间隙，可防止快速重复点击。 */
export function ensureProjectDraftAgentSession(
  workspaceId: string,
  channelId?: string,
  modelId?: string,
  agentRuntime: AgentRuntime = 'claude',
): AgentSessionMeta {
  const existing = listAgentSessions(true).find((session) =>
    session.workspaceId === workspaceId && session.draft && !session.archived,
  )
  if (!existing) {
    return createAgentSession(undefined, channelId, workspaceId, modelId, agentRuntime, true)
  }

  // SDK 的用户输入以 type: 'user' 持久化；Agent 错误为 assistant/system 消息，不能据此晋升草稿。
  if (getAgentSessionSDKMessages(existing.id).some((message) => message.type === 'user')) {
    return updateAgentSessionMeta(existing.id, { draft: false })
  }

  return existing
}

/**
 * 读取会话的所有消息
 */
export function getAgentSessionMessages(id: string): AgentMessage[] {
  const filePath = getAgentSessionMessagesPath(id)

  if (!existsSync(filePath)) {
    return []
  }

  try {
    const raw = readFileSync(filePath, 'utf-8')
    const lines = raw.split('\n').filter((line) => line.trim())
    const parsedMessages: AgentMessage[] = []
    for (const line of lines) {
      try {
        parsedMessages.push(JSON.parse(line) as AgentMessage)
      } catch {
        // 单行损坏不丢整文件：跳过坏行继续解析后续
        console.warn(`[Agent 会话] 跳过损坏的消息行 (${id})`)
      }
    }
    // 瞬时断流错误卡只在「之后已恢复」时才丢弃；会话尾部的失败必须保留可见。
    return parsedMessages.filter((message, index) => {
      const assistantError = getPersistedAssistantError(message)
      if (!assistantError) return true
      const recoveredLater = parsedMessages.slice(index + 1).some((later) => {
        if (later.role !== 'assistant') return false
        return getPersistedAssistantError(later) === null
      })
      return !isRecoveredEphemeralTransportError(
        recoveredLater,
        assistantError.errorCode,
        assistantError.errorText,
      )
    })
  } catch (error) {
    console.error(`[Agent 会话] 读取消息文件失败 (${id}):`, error)
    return []
  }
}

/**
 * 追加一条消息到会话的 JSONL 文件
 */
export function appendAgentMessage(id: string, message: AgentMessage): void {
  const filePath = getAgentSessionMessagesPath(id)
  if (message.role === 'user') {
    const session = getAgentSessionMeta(id)
    if (session) lockAgentSessionRuntime(id, normalizeAgentRuntime(session.agentRuntime))
  }

  try {
    // project 会话的消息落在会话数据目录；目录可能因项目重新定位/首次写入而不存在。
    mkdirSync(dirname(filePath), { recursive: true })
    const line = JSON.stringify(message) + '\n'
    appendFileSync(filePath, line, 'utf-8')

    // 追加消息时更新 updatedAt，若已归档则自动恢复活跃
    const index = readIndex()
    const idx = index.sessions.findIndex((s) => s.id === id)
    if (idx !== -1) {
      const session = index.sessions[idx]!
      session.updatedAt = Date.now()
      if (session.archived) session.archived = false
      writeIndex(index)
    }
  } catch (error) {
    console.error(`[Agent 会话] 追加消息失败 (${id}):`, error)
    throw new Error('追加 Agent 消息失败')
  }
}

/**
 * 把一条消息里的引用一次性还原为原文，返回原始形状。
 *
 * 这是对外**唯一**的还原入口：消费方不需要知道路径与哈希的存在。
 * blob 缺失或哈希不匹配时保留片段并记入 `_proferBlobsMissing`，绝不抛异常
 * ——任何「读历史数据可能崩」的设计都不该上线。
 */
export async function resolveMessageBlobs(message: SDKMessage): Promise<SDKMessage> {
  const rawRefs = (message as unknown as Record<string, unknown>)[BLOB_REFS_FIELD]
  if (!Array.isArray(rawRefs) || rawRefs.length === 0) return message

  const clone = JSON.parse(JSON.stringify(message)) as Record<string, unknown>
  const refs = clone[BLOB_REFS_FIELD] as StoredBlobRef[]
  delete clone[BLOB_REFS_FIELD]

  const missing: string[] = []
  for (const ref of refs) {
    const content = await readBlob(ref.hash)
    if (content === null) {
      missing.push(ref.path)
      continue
    }
    if (!setStringAtPath(clone, ref.path, content)) missing.push(ref.path)
  }

  if (missing.length > 0) clone[BLOB_REFS_MISSING_FIELD] = missing
  return clone as unknown as SDKMessage
}

import { readBlob } from './blob-store'
import {
  BLOB_REFS_FIELD,
  BLOB_REFS_MISSING_FIELD,
  MAX_SDK_MESSAGE_LENGTH,
  externalizeSerializedSessionLine,
  setStringAtPath,
  type StoredBlobRef,
} from './session-payload-externalize'
export {
  MAX_SDK_MESSAGE_LENGTH,
  externalizeSerializedSessionLine,
  readSerializedBlobRefs,
  sanitizeSerializedSessionLine,
} from './session-payload-externalize'

/**
 *
 * 每条 SDKMessage 单独一行 JSON。读取时通过 `type` 字段区分新旧格式。
 * 超过 256K chars 的消息会被自动截断以防止存储膨胀。
 */
export function appendSDKMessages(id: string, messages: SDKMessage[]): void {
  // 注意：这里不再丢弃「瞬时断流」错误卡。丢弃必须在读取时结合「之后是否已恢复」判断
  // （见 dropRecoveredEphemeralTransportErrors）——写入时就丢掉，会让一次最终失败的
  // 网络错误在历史里彻底消失，用户看到的是「Agent Running 一闪就什么都没有了」。
  const persistentMessages = messages
  if (persistentMessages.length === 0) return
  if (deletedSessionIds.has(id)) {
    console.warn(`[Agent 会话] 会话已删除，丢弃后续消息写入: ${id}`)
    return
  }
  // 导入/分叉也可能直接写 user 历史；写入前绑定，不能留下可切换的已用会话。
  if (persistentMessages.some((message) => message.type === 'user')) {
    const session = getAgentSessionMeta(id)
    if (session) lockAgentSessionRuntime(id, normalizeAgentRuntime(session.agentRuntime))
  }

  try {
    syncMessageStore.append(id, persistentMessages)
  } catch (error) {
    console.error(`[Agent 会话] 追加 SDKMessage 失败 (${id}):`, error)
    throw new Error('追加 SDKMessage 失败')
  }
}

/** 桌面端 Agent 会话懒加载单页消息数（首次只取尾部，触顶/按钮加载更早） */
export const DESKTOP_AGENT_PAGE_SIZE = 60

/** 解析单行 SDKMessage（兼容旧 AgentMessage 格式）；损坏行返回 null 不中断 */
function parseSDKMessageLine(line: string, id: string): SDKMessage | null {
  try {
    const parsed = JSON.parse(line)
    // 旧格式检测：AgentMessage 有 `role` 字段，SDKMessage 有 `type` 字段
    if ('role' in parsed && !('type' in parsed)) {
      return convertLegacyMessage(parsed as AgentMessage)
    }
    return parsed as SDKMessage
  } catch {
    // 单行损坏不丢整文件：跳过坏行继续解析后续
    console.warn(`[Agent 会话] 跳过损坏的 SDKMessage 行 (${id})`)
    return null
  }
}

/** 该消息是否代表「本轮已恢复/继续产出」——用于判定瞬时断流是否真的已被恢复 */
function isRecoverySignal(message: SDKMessage): boolean {
  if (message.type === 'assistant') return getPersistedAssistantError(message) === null
  return message.type === 'result'
}

/**
 * 丢弃「已恢复」的瞬时断流错误卡。
 *
 * 会话尾部仍处于失败状态的错误卡必须保留：否则失败在界面上没有任何可见痕迹
 * （表现为「Agent Running 一闪就什么都没有了」）。只有该错误之后确实还有正常产出
 * （干净 assistant 消息 / result）时，才按原设计把它从历史里去掉。
 */
function dropRecoveredEphemeralTransportErrors(messages: SDKMessage[]): SDKMessage[] {
  if (messages.length === 0) return messages
  let dropped = false
  const kept: SDKMessage[] = []
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!
    const assistantError = message.type === 'assistant' ? getPersistedAssistantError(message) : null
    if (
      assistantError &&
      isRecoveredEphemeralTransportError(
        messages.slice(i + 1).some((later) => isRecoverySignal(later)),
        assistantError.errorCode,
        assistantError.errorText,
      )
    ) {
      dropped = true
      continue
    }
    kept.push(message)
  }
  return dropped ? kept : messages
}

/**
 * 读取会话的 SDKMessage（兼容旧 AgentMessage 格式）
 *
 * 旧格式（有 `role` 字段）会被转换为近似的 SDKMessage。
 * 新格式（有 `type` 字段）直接返回。
 *
 * 分页模式（传 opts.tail）：只解析尾部窗口内的行，避免全量 JSON.parse 的内存分配
 * 风暴（切大会话时主进程 GC 卡顿的根因之一），返回 SDKMessagePage；
 * 无 opts 时保持旧行为返回全量数组（重试/分叉/回退等需要完整历史的调用方）。
 */
export function getAgentSessionSDKMessages(id: string): SDKMessage[]
export function getAgentSessionSDKMessages(id: string, opts: { tail?: number; before?: number }): SDKMessagePage
export function getAgentSessionSDKMessages(
  id: string,
  opts?: { tail?: number; before?: number },
): SDKMessage[] | SDKMessagePage {
  const filePath = getAgentSessionMessagesPath(id)
  const emptyPage: SDKMessagePage = { messages: [], total: 0, startIndex: 0, endIndex: -1, hasMore: false }

  if (!existsSync(filePath)) {
    return opts ? emptyPage : []
  }

  try {
    const raw = readFileSync(filePath, 'utf-8')
    const lines = raw.split('\n').filter((line) => line.trim())

    // 分页模式：只解析窗口内的行
    if (opts && (opts.tail !== undefined || opts.before !== undefined)) {
      const total = lines.length
      const pageSize = opts.tail ?? DESKTOP_AGENT_PAGE_SIZE
      const before = opts.before !== undefined ? Math.max(0, Math.min(opts.before, total)) : total
      const startLine = Math.max(0, before - pageSize)
      const messages: SDKMessage[] = []
      for (let i = startLine; i < before; i++) {
        const parsed = parseSDKMessageLine(lines[i]!, id)
        if (parsed) messages.push(parsed)
      }
      return {
        messages: dropRecoveredEphemeralTransportErrors(messages),
        total,
        startIndex: startLine,
        endIndex: before - 1,
        hasMore: startLine > 0,
      }
    }

    // 全量模式（旧行为）
    const messages: SDKMessage[] = []
    for (const line of lines) {
      const parsed = parseSDKMessageLine(line, id)
      if (parsed) messages.push(parsed)
    }
    return dropRecoveredEphemeralTransportErrors(messages)
  } catch (error) {
    console.error(`[Agent 会话] 读取 SDKMessage 文件失败 (${id}):`, error)
    return opts ? emptyPage : []
  }
}

/**
 * 将旧的 AgentMessage 转换为近似的 SDKMessage（向后兼容）
 *
 * 不需要完美还原，只需在 UI 中可读即可。
 */
function convertLegacyMessage(legacy: AgentMessage): SDKMessage {
  if (legacy.role === 'user') {
    return {
      type: 'user',
      message: {
        content: [{ type: 'text', text: legacy.content }],
      },
      parent_tool_use_id: null,
      // 附加元数据供渲染器使用
      _legacy: true,
      _createdAt: legacy.createdAt,
    } as unknown as SDKMessage
  }

  if (legacy.role === 'assistant') {
    return {
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: legacy.content }],
        model: legacy.model,
      },
      parent_tool_use_id: null,
      _legacy: true,
      _createdAt: legacy.createdAt,
    } as unknown as SDKMessage
  }

  if (legacy.role === 'status') {
    // 错误消息转换为 assistant error 格式
    return {
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: legacy.content }],
      },
      parent_tool_use_id: null,
      error: { message: legacy.content, errorType: legacy.errorCode },
      _legacy: true,
      _createdAt: legacy.createdAt,
      _errorCode: legacy.errorCode,
      _errorTitle: legacy.errorTitle,
      _errorDetails: legacy.errorDetails,
      _errorCanRetry: legacy.errorCanRetry,
      _errorActions: legacy.errorActions,
    } as unknown as SDKMessage
  }

  // 其他类型，作为 system 消息返回
  return {
    type: 'system',
    subtype: 'init',
    _legacy: true,
    _createdAt: legacy.createdAt,
  } as unknown as SDKMessage
}

/**
 * 元数据写入选项
 */
export interface UpdateAgentSessionMetaOptions {
  /**
   * 本次写入是否算作「会话活跃」并刷新 `updatedAt`（默认 true）。
   *
   * 置顶这类纯展示状态切换传 false：它不产生新内容，不该改写「最后更新」时间，
   * 否则侧栏「最近」排序会因为这个动作把整个项目顶到最前面。
   */
  touchUpdatedAt?: boolean
}

/**
 * 更新会话元数据
 */
export function updateAgentSessionMeta(
  id: string,
  updates: Partial<Pick<AgentSessionMeta, 'title' | 'titleAutoGeneratedAt' | 'titleRefineAttempts' | 'titleLockedAt' | 'channelId' | 'modelId' | 'sdkSessionId' | 'piSessionFile' | 'piEntryBindings' | 'piFileCheckpoints' | 'agentRuntime' | 'agentRuntimeLocked' | 'codexFastMode' | 'openAIThinkingLevel' | 'agentEffort' | 'workspaceId' | 'storageLayout' | 'pinned' | 'archived' | 'draft' | 'attachedDirectories' | 'attachedFiles' | 'forkSourceDir' | 'explorationParentSessionId' | 'explorationSourceMessageId' | 'explorationSourceLabel' | 'explorationTitleInitializedAt' | 'forkSourceSdkSessionId' | 'resumeAtMessageUuid' | 'stoppedByUser' | 'autoQueueSendEnabled' | 'permissionMode' | 'completedButUnconfirmed' | 'sourceAutomationId' | 'sourceSessionId' | 'sourceRunId' | 'delegationRelation' | 'delegationPlacement' | 'automationGraduated' | 'parentSessionId' | 'rootSessionId' | 'sourceDelegationId' | 'delegationRole' | 'delegationStatus' | 'delegationDepth' | 'delegationGoal' | 'lastAnalyzedTurn' | 'presetId' | 'pptCapabilityActive' | 'lastInterruptReason' | 'lastInterruptLabel' | 'lastInterruptAt' | 'presetReference'>>,
  options: UpdateAgentSessionMetaOptions = {},
): AgentSessionMeta {
  const index = readIndex()
  const idx = index.sessions.findIndex((s) => s.id === id)

  if (idx === -1) {
    throw new Error(`Agent 会话不存在: ${id}`)
  }

  const existing = index.sessions[idx]!
  // 新引用是唯一跨作用域解析依据；旧调用传裸 presetId 时按会话工作区补齐兼容引用。
  if (updates.presetId !== undefined && updates.presetReference === undefined) {
    const workspaceSlug = existing.workspaceId ? getAgentWorkspace(existing.workspaceId)?.slug : undefined
    updates = { ...updates, presetReference: presetReferenceForId(workspaceSlug, updates.presetId) }
  }
  // 非手动归档操作时，若会话已归档则自动恢复为活跃（仅更新 stoppedByUser 不触发解归档）
  const isStoppedByUserOnly = Object.keys(updates).every((k) => k === 'stoppedByUser')
  const autoUnarchive = existing.archived && !('archived' in updates) && !isStoppedByUserOnly
  const previousRuntime = normalizeAgentRuntime(existing.agentRuntime)
  const nextRuntime = updates.agentRuntime === undefined
    ? previousRuntime
    : normalizeAgentRuntime(updates.agentRuntime)
  const runtimeChanged = updates.agentRuntime !== undefined && nextRuntime !== previousRuntime
  const runtimeLocked = !canSelectAgentSessionRuntime(existing)
  if (runtimeChanged && (runtimeLocked || agentSessionActiveChecker?.(id) || isAgentSessionForking(id)
    || getAgentSessionSDKMessages(id).some((message) => message.type === 'user'))) {
    throw new Error(AGENT_SESSION_RUNTIME_LOCKED_MESSAGE)
  }
  const updated: AgentSessionMeta = {
    ...existing,
    ...updates,
    revision: (existing.revision ?? 0) + 1,
    agentRuntime: nextRuntime,
    agentRuntimeLocked: runtimeLocked || updates.agentRuntimeLocked === true
      || !canSelectAgentSessionRuntime({ ...existing, ...updates, agentRuntimeLocked: false }),
    ...(autoUnarchive ? { archived: false } : {}),
    updatedAt: options.touchUpdatedAt === false ? existing.updatedAt : Date.now(),
  }

  index.sessions[idx] = updated
  writeIndex(index)
  registerSessionLayout(updated)

  console.log(`[Agent 会话] 已更新会话: ${updated.title} (${updated.id})`)
  return updated
}

export interface DeleteAgentSessionOptions {
  /** 索引条目已被移除时（崩溃重试），用它解析 session 目录继续清理。 */
  workspaceId?: string
}

/**
 * 索引条目已不存在时仍能执行的幂等清理。
 *
 * 场景：上次删除已把索引写盘、但进程在清理文件前退出。队列会重试，
 * 此时必须继续清掉检查点等大目录，否则它们永远没有引用可回收。
 */
export async function cleanupResidualSessionFiles(id: string, workspaceId?: string): Promise<void> {
  for (const [label, filePath] of [
    ['消息', getAgentSessionMessagesPath(id)],
    ['任务图', getAgentSessionGraphPath(id)],
    ['Pi Harness 账本', getPiHarnessEventsPath(id)],
  ] as const) {
    if (!existsSync(filePath)) continue
    try {
      await rmAsync(filePath, { force: true })
    } catch (error) {
      console.warn(`[Agent 会话] 删除${label}文件失败 (${id}):`, error)
    }
  }

  let sessionDir: string | undefined
  const workspace = workspaceId ? getAgentWorkspace(workspaceId) : undefined
  if (workspace) {
    try {
      const candidate = resolveAgentSessionWorkspacePath(workspace.slug, id)
      assertNotProjectLifecyclePath(candidate)
      sessionDir = candidate
    } catch (error) {
      console.warn(`[Agent 会话] 解析残留 session 目录失败 (${id}):`, error)
    }
  }

  await Promise.all([
    (async () => {
      if (!sessionDir || !existsSync(sessionDir)) return
      try { await removeForkPathAsync(sessionDir) } catch (error) {
        console.warn(`[Agent 会话] 清理残留 session 工作目录失败 (${id}):`, error)
      }
    })(),
    (async () => {
      try {
        const backupDir = join(getAgentAttachmentBackupsRoot(), id)
        if (existsSync(backupDir)) await rmAsync(backupDir, { recursive: true, force: true })
      } catch (error) {
        console.warn(`[Agent 会话] 清理残留附件备份失败 (${id}):`, error)
      }
    })(),
    removePiFileCheckpointsAsync(getPiCheckpointsDir(), id),
    removeToolResultDirAsync(id),
  ])
}

/**
 * 删除会话
 */
export async function deleteAgentSession(
  id: string,
  options: DeleteAgentSessionOptions = {},
): Promise<void> {
  const index = readIndex()
  const idx = index.sessions.findIndex((s) => s.id === id)

  if (idx === -1) {
    // 索引已无条目：可能是重复删除，也可能是上次崩溃留下的半成品，继续幂等清理。
    console.warn(`[Agent 会话] 会话不存在，继续清理残留文件: ${id}`)
    await cleanupResidualSessionFiles(id, options.workspaceId)
    return
  }

  const removed = index.sessions.splice(idx, 1)[0]!

  // 历史版本的 fork 可能仍直接引用源会话的 checkpoint。先迁移这些精确引用，
  // 迁移失败则摘除 mapping；索引落盘前绝不删除源 cwd，旧版 cwd 内 checkpoint 才有机会被搬走。
  const sourceCheckpointRoot = join(getPiCheckpointsDir(), id)
  // 只读解析：删除不能因为 project 的 rootPath 已失效而半途抛错，也不能顺手 mkdir。
  const removedWorkspace = removed.workspaceId ? getAgentWorkspace(removed.workspaceId) : undefined
  const legacySourceCheckpointRoot = removedWorkspace
    ? join(resolveAgentSessionWorkspacePath(removedWorkspace.slug, id), '.profer-pi-checkpoints')
    : undefined
  // 删除路径是热路径：预建 Set + 预归一化根路径，避免 96k 次 Object.values().includes()
  // 与 2×96k 次 path.resolve()（实测 470ms）。判定语义与 isPathWithin 保持一致：
  // 相等不算命中（检查点必须是根目录下的文件）。
  const removedCheckpoints = new Set(Object.values(removed.piFileCheckpoints ?? {}))
  const normalizedSourceCheckpointRoot = resolve(sourceCheckpointRoot)
  const normalizedLegacyCheckpointRoot = legacySourceCheckpointRoot ? resolve(legacySourceCheckpointRoot) : undefined
  const isUnderNormalizedRoot = (root: string, candidate: string): boolean => {
    if (candidate === root) return false
    if (candidate.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)) return true
    // 历史脏路径（含 `..` / 双斜杠）退回归一化判定，避免漏迁移导致分叉回退点被删。
    return (candidate.includes('/..') || candidate.includes('//')) && isPathWithin(root, candidate)
  }
  const isSourceCheckpoint = (checkpointPath: string): boolean =>
    removedCheckpoints.has(checkpointPath)
    || isUnderNormalizedRoot(normalizedSourceCheckpointRoot, checkpointPath)
    || (normalizedLegacyCheckpointRoot
      ? isUnderNormalizedRoot(normalizedLegacyCheckpointRoot, checkpointPath)
      : false)

  try {
    const bySession = new Map<string, Array<{ entryId: string; checkpointPath: string }>>()
    for (const session of index.sessions) {
      for (const [entryId, checkpointPath] of Object.entries(session.piFileCheckpoints ?? {})) {
        if (!isSourceCheckpoint(checkpointPath)) continue
        const entries = bySession.get(session.id) ?? []
        entries.push({ entryId, checkpointPath })
        bySession.set(session.id, entries)
      }
    }
    for (const [targetSessionId, entries] of bySession) {
      const adopted = adoptPiFileCheckpoints({
        rootDir: getPiCheckpointsDir(),
        targetSessionId,
        paths: entries.map((entry) => entry.checkpointPath),
      })
      const targetIndex = index.sessions.findIndex((session) => session.id === targetSessionId)
      if (targetIndex < 0) continue
      const target = index.sessions[targetIndex]!
      const checkpoints = { ...(target.piFileCheckpoints ?? {}) }
      for (const { entryId, checkpointPath } of entries) {
        const migrated = adopted.adopted[checkpointPath]
        if (migrated) checkpoints[entryId] = migrated
        else delete checkpoints[entryId]
      }
      index.sessions[targetIndex] = {
        ...target,
        ...(Object.keys(checkpoints).length > 0 ? { piFileCheckpoints: checkpoints } : { piFileCheckpoints: undefined }),
        updatedAt: Date.now(),
      }
    }
  } catch (error) {
    // 删除本身仍可继续，但绝不保留悬空映射：本次未能读取/迁移时摘掉所有已识别的源引用。
    console.warn(`[Agent 会话] 迁移源会话 Pi 文件检查点失败，将清除旧引用 (${id}):`, error)
    for (let sessionIndex = 0; sessionIndex < index.sessions.length; sessionIndex += 1) {
      const session = index.sessions[sessionIndex]!
      const checkpoints = Object.fromEntries(
        Object.entries(session.piFileCheckpoints ?? {}).filter(([, checkpointPath]) => !isSourceCheckpoint(checkpointPath)),
      )
      if (Object.keys(checkpoints).length === Object.keys(session.piFileCheckpoints ?? {}).length) continue
      index.sessions[sessionIndex] = {
        ...session,
        ...(Object.keys(checkpoints).length > 0 ? { piFileCheckpoints: checkpoints } : { piFileCheckpoints: undefined }),
        updatedAt: Date.now(),
      }
    }
  }
  // 索引落盘成功后才登记删除墓碑：写盘失败时队列会重试，不能提前吞掉后续消息。
  writeIndex(index)
  deletedSessionIds.add(id)
  unregisterSessionLayout(id)

  // 删除消息与任务图文件。任务图和会话消息均属于该 Profer session，删除必须同步清理。
  for (const [label, filePath] of [
    ['消息', getAgentSessionMessagesPath(id)],
    ['任务图', getAgentSessionGraphPath(id)],
    ['Pi Harness 账本', getPiHarnessEventsPath(id)],
  ] as const) {
    if (!existsSync(filePath)) continue
    try {
      unlinkSync(filePath)
    } catch (error) {
      console.warn(`[Agent 会话] 删除${label}文件失败 (${id}):`, error)
    }
  }

  // 清理 session 工作目录
  // 只读解析 storageDir：新布局在项目内 `.profer/sessions`，旧布局仍在中央 runtimeDir。
  // 用纯查询解析，避免「项目已被移走」的会话在索引与消息都删完之后抛错。
  let sessionDirToRemove: string | undefined
  if (removedWorkspace) {
    const sessionDir = resolveAgentSessionWorkspacePath(removedWorkspace.slug, id)
    // I2 硬护栏：会话目录只能落在 `.profer/sessions/<sid>` 或中央 runtimeDir；
    // 若路径契约被改坏、sessionDir 落进了项目根，仍要在递归删除前抛错。
    assertNotProjectLifecyclePath(sessionDir)
    sessionDirToRemove = sessionDir
  }

  // 大目录递归删除全部走异步：单个会话的检查点目录最大 2.4GB / 15 万文件，
  // 同步 rmSync 会把主进程事件循环按住数秒（实测 3 万文件 1.1s）。
  await Promise.all([
    (async () => {
      if (!sessionDirToRemove || !existsSync(sessionDirToRemove)) return
      try {
        await removeForkPathAsync(sessionDirToRemove)
        console.log(`[Agent 会话] 已清理 session 工作目录: ${sessionDirToRemove}`)
      } catch (error) {
        console.warn(`[Agent 会话] 清理 session 工作目录失败 (${id}):`, error)
      }
    })(),
    // 用户附件备份也按会话存放，随会话一起清理，避免残留占盘。
    (async () => {
      try {
        const backupDir = join(getAgentAttachmentBackupsRoot(), id)
        if (existsSync(backupDir)) await rmAsync(backupDir, { recursive: true, force: true })
      } catch (error) {
        console.warn(`[Agent 会话] 清理用户附件备份失败 (${id}):`, error)
      }
    })(),
    // 新版检查点位于配置目录，删除会话后必须显式清理；旧版 cwd 内快照已随工作区删除。
    (async () => {
      try {
        await removePiFileCheckpointsAsync(getPiCheckpointsDir(), id)
      } catch (error) {
        console.warn(`[Agent 会话] 清理 Pi 文件检查点失败 (${id}):`, error)
      }
    })(),
    // 历史工具结果落盘副本：独立目录，不随会话工作区/checkpoint 清理，必须显式删除。
    removeToolResultDirAsync(id),
  ])

  console.log(`[Agent 会话] 已删除会话: ${removed.title} (${removed.id})`)

  // 清理 SDK 关联数据（file-history 和 projects 下的 session JSONL）
  // ⚠️ 只清理本会话自己的 sdkSessionId，绝不能清理 forkSourceSdkSessionId：
  // 后者指向的是**源会话仍在使用**的 SDK session（fork 只是引用它做回退定位，
  // 并不拥有它的副本 — fork 自己的数据存在 forkResult.sessionId 即 sdkSessionId 下）。
  // 若一并删除，会在「删除某个 fork 会话」或「fork 中途失败触发回滚」时连带摧毁
  // 源会话的 SDK JSONL 和 file-history，使源会话变成无法 resume 的孤儿。
  // 源会话自身被删除时，它自己的 sdkSessionId 会走这里正常清理，不会泄漏。
  const sdkSessionIds = [removed.sdkSessionId].filter(Boolean) as string[]
  if (sdkSessionIds.length > 0) {
    const sdkConfigDir = getSdkConfigDir()

    const fileHistoryDir = join(sdkConfigDir, 'file-history')
    for (const sid of sdkSessionIds) {
      const histDir = join(fileHistoryDir, sid)
      if (existsSync(histDir)) {
        try {
          await rmAsync(histDir, { recursive: true, force: true })
          console.log(`[Agent 会话] 已清理 file-history: ${sid}`)
        } catch (e) {
          console.warn(`[Agent 会话] 清理 file-history 失败 (${sid}):`, e)
        }
      }
    }

    // Pi session 文件由 Pi SessionManager 写入独立目录；按 JSONL header 的精确 ID 删除，
    // 禁止按文件名片段匹配以避免误删另一会话。
    if (normalizeAgentRuntime(removed.agentRuntime) === 'pi') {
      for (const sid of sdkSessionIds) {
        // 索引已记录 piSessionFile 时直接校验使用，避免每次删除都全盘扫描 2.8GB transcript。
        // 有 piSessionFile 时保持 O(1)；只有缺路径的极少数历史会话才强制重建一次缓存
        // （启动 backfill 之后这类会话应接近于零）。
        const knownTranscript = sid === removed.sdkSessionId ? removed.piSessionFile : undefined
        const piSessionFile = resolvePiTranscriptPath(
          sid,
          knownTranscript,
          {
            rootDir: getPiTranscriptDirForSession(removed.id),
            ...(knownTranscript ? {} : { refreshOnFallback: true }),
          },
        )
        if (!piSessionFile) continue
        try {
          await rmAsync(piSessionFile, { force: true })
          console.log(`[Agent 会话] 已清理 Pi session 文件: ${piSessionFile}`)
        } catch (e) {
          console.warn('[Agent 会话] 清理 Pi session 文件失败:', e)
        }
      }
      // 已删除的文件可能仍在扫描缓存里，立即失效避免后续健康检查误判。
      invalidatePiTranscriptCache()
    }

    const projectsDir = join(sdkConfigDir, 'projects')
    if (existsSync(projectsDir)) {
      try {
        for (const hashDir of readdirSync(projectsDir)) {
          const projPath = join(projectsDir, hashDir)
          for (const sid of sdkSessionIds) {
            const sessionFile = join(projPath, `${sid}.jsonl`)
            if (existsSync(sessionFile)) {
              try {
                await rmAsync(sessionFile, { force: true })
                console.log(`[Agent 会话] 已清理 SDK session 文件: ${sessionFile}`)
              } catch (e) {
                console.warn('[Agent 会话] 清理 SDK session 文件失败:', e)
              }
            }
          }
          try {
            if (readdirSync(projPath).length === 0) await rmAsync(projPath, { recursive: true })
          } catch { /* ignore */ }
        }
      } catch { /* ignore */ }
    }
  }
}

/**
 * 删除指定工作区（项目）下的全部会话（索引条目 + 消息/任务图文件 + session 工作目录 + SDK 关联数据）。
 *
 * 供删除工作区时级联清理使用：正常流程由 ipc DELETE_WORKSPACE handler 先行处理
 * （含停止运行中 Agent、清理权限/提问状态等运行时资源），此函数作为 manager 层防御性兜底，
 * 防止其他调用路径删除工作区后残留孤儿会话 —— 孤儿会话会让移动端把 workspaceId
 * 归纳成“幽灵项目”显示（electronapi-stub 的 list_workspaces 回退路径）。
 *
 * @returns 删除的会话数量
 */
export async function deleteAgentSessionsByWorkspace(workspaceId: string): Promise<number> {
  const index = readIndex()
  const affected = index.sessions.filter((s) => s.workspaceId === workspaceId)
  if (affected.length === 0) return 0
  for (const session of affected) {
    await deleteAgentSession(session.id)
  }
  console.log(`[Agent 会话] 已级联删除工作区 ${workspaceId} 的 ${affected.length} 个会话`)
  return affected.length
}

/**
 * 扫描所有会话，检测孤儿记录和文件系统不一致。
 *
 * 检测项：
 * - agent-sessions/<id>.jsonl 缺失 → UI 无法展示历史消息
 * - SDK JSONL 缺失 → 无法 resume，每次打开都触发 session-not-found 恢复
 * - 工作区目录缺失 → Agent 无 cwd，首次运行会重建但丢失上下文文件
 *
 * @returns 所有会话的健康状态列表，按严重程度排序（孤儿在前）
 */
export function findOrphanSessions(): SessionHealth[] {
  // 已入队待删除的会话不参与健康检查：它们正处于「索引还在、文件已在清」的中间态。
  const index = { ...readIndex() }
  index.sessions = index.sessions.filter((session) => !isSessionDeletionPending(session.id))
  // 只有缺少 piSessionFile 的历史会话才需要扫描 transcript 目录；
  // 大多数会话都能直接用索引里的路径，避免健康检查阻塞主线程。
  const needsTranscriptScan = index.sessions.some((session) => session.sdkSessionId
    && normalizeAgentRuntime(session.agentRuntime) === 'pi'
    && !session.piSessionFile)
  if (needsTranscriptScan) invalidatePiTranscriptCache()
  const results: SessionHealth[] = []

  for (const session of index.sessions) {
    const health: SessionHealth = {
      sessionId: session.id,
      title: session.title,
      hasProferJsonl: false,
      hasPiHarnessJsonl: false,
      hasSdkJsonl: false,
      hasWorkspaceDir: false,
      isOrphan: false,
    }

    // 检查 Profer JSONL。Harness sidecar 缺失仅表示历史会话可从空 snapshot 降级，不是孤儿条件。
    health.hasProferJsonl = existsSync(getAgentSessionMessagesPath(session.id))
    health.hasPiHarnessJsonl = existsSync(getPiHarnessEventsPath(session.id))

    // 检查 runtime 对应的原生 session JSONL。Claude 与 Pi 的持久化目录和文件名规则不同。
    if (session.sdkSessionId) {
      health.hasSdkJsonl = normalizeAgentRuntime(session.agentRuntime) === 'pi'
        ? resolvePiTranscriptPath(session.sdkSessionId, session.piSessionFile, { rootDir: getPiTranscriptDirForSession(session.id) }) !== undefined
        : findSdkSessionJsonl(session.sdkSessionId) !== undefined
    }

    // 检查工作区目录：只读解析，project 的 rootPath 失效时不能让整个健康检查 IPC 抛错。
    if (session.workspaceId) {
      const ws = getAgentWorkspace(session.workspaceId)
      if (ws) {
        const dir = resolveAgentSessionWorkspacePath(ws.slug, session.id)
        health.hasWorkspaceDir = existsSync(dir)
      }
    }

    // 判定孤儿
    const reasons: string[] = []
    if (!health.hasProferJsonl && !health.hasSdkJsonl) {
      reasons.push('Profer 和 SDK JSONL 均缺失')
    } else if (session.sdkSessionId && !health.hasSdkJsonl) {
      reasons.push('SDK JSONL 缺失（无法 resume，每次打开都会触发 session-not-found 恢复）')
    }
    if (!health.hasWorkspaceDir && session.workspaceId) {
      reasons.push('工作区目录缺失')
    }

    if (reasons.length > 0) {
      health.isOrphan = true
      health.orphanReason = reasons.join('；')
    }

    results.push(health)
  }

  // 孤儿排在前面
  results.sort((a, b) => {
    if (a.isOrphan !== b.isOrphan) return a.isOrphan ? -1 : 1
    return a.title.localeCompare(b.title)
  })

  return results
}

/**
 * 工作区是否使用 project 存储模式（读索引字段，不做路径解析、不 mkdir）。
 */
function isProjectStoredWorkspace(workspace: { storageMode?: string } | undefined): boolean {
  return workspace?.storageMode === 'project'
}

/**
 * project 模式是否跳过 Pi 文件检查点（建快照与恢复文件都跳过）。
 *
 * project 的 cwd 就是用户项目根：以它为快照根会每轮全量快照整个仓库（体积/耗时失控），
 * 回退时还会删改同项目其它会话的文件。项目文件回退交给 git；managed 保持每轮检查点不变。
 */
export function shouldSkipPiFileCheckpoint(workspace: { storageMode?: string } | undefined): boolean {
  return isProjectStoredWorkspace(workspace)
}

/**
 * 解析会话 cwd —— 两条宿主链路（`AgentOrchestrator.sendMessage` 与
 * `runAgentRuntimeHeadless`）的唯一来源，禁止任何一侧再自行拼路径。
 *
 * - managed：`<configDir>/<sessionId>`（与改造前逐字一致）
 * - project：工作区 rootPath（同项目多会话共享，设计 §7.3）
 * - 无工作区：用户主目录（不用 `process.cwd()`：桌面应用启动目录不稳定）
 *
 * cwd 只能作为运行时相对路径基准（`queryOptions.cwd`、`SessionManager.open` 的目录参数、
 * 提示词 `<working_directory>`）。删除 / 复制 / 落盘一律用 `getAgentSessionWorkspacePath()`
 * 返回的 storageDir，project 下二者不相等。
 */
export function resolveAgentSessionCwd(workspaceSlug: string | undefined, sessionId: string): string {
  return workspaceSlug ? getAgentSessionCwd(workspaceSlug, sessionId) : homedir()
}

/**
 * 解析会话在 UI 侧（`@` 文件引用 / 侧栏文件面板 / 预览相对路径）的工作根。
 *
 * 与 cwd / storageDir 的区别：
 * - managed：用户看到的工作目录就是会话目录，两者相等；
 * - project：会话私有数据全在中央 storageDir（用户不该看到），UI 必须指向项目根
 *   rootPath，否则 `@` 引用与文件面板里看不到任何项目文件。
 *
 * 纯查询，不创建目录，project 的 rootPath 缺失时也不抛错（UI 侧不应因项目失效而报错）。
 *
 * @returns 工作区不存在时返回 undefined
 */
export function resolveAgentSessionUiRootPath(workspaceId: string, sessionId: string): string | undefined {
  const workspace = getAgentWorkspace(workspaceId)
  if (!workspace) return undefined
  const location = resolveWorkspaceLocation(workspace.slug)
  if (location.mode === 'project') return location.rootPath
  return getAgentSessionWorkspacePath(workspace.slug, sessionId)
}

/**
 * 解析会话草稿区（storageDir）路径 —— 只读、不 mkdir、不要求 rootPath 存在。
 *
 * 渲染层用它判定「这条文件改动是不是 Agent 自己的草稿」（截图、临时产物、`.context` 草稿）：
 * - managed：等于会话目录（与改造前用 `sessionPath` 判定等价）；
 * - project：中央 runtimeDir 下的 `sessions/<sid>`，与用户可见的项目根毫无关系。
 *
 * 不能用 UI 根（project 下是项目根）做这个判定，否则项目内改动会被当成草稿隐藏（chip 变空）。
 *
 * @returns 工作区不存在时返回 undefined
 */
export function resolveAgentSessionStoragePath(workspaceId: string, sessionId: string): string | undefined {
  const workspace = getAgentWorkspace(workspaceId)
  if (!workspace) return undefined
  // `resolveAgentSessionWorkspacePath` 是纯计算：项目根失效时仍能给出中央目录，且不会建目录。
  return resolveAgentSessionWorkspacePath(workspace.slug, sessionId)
}

/**
 * 收集某个会话的全部委派后代（按 parentSessionId 递归）。
 * 只认真正的委派子会话（带 sourceDelegationId），不把 fork 源误当子会话。
 */
function collectDelegatedDescendantIds(sessions: AgentSessionMeta[], rootId: string): string[] {
  const childrenByParentId = new Map<string, string[]>()
  for (const session of sessions) {
    if (!session.parentSessionId || !session.sourceDelegationId) continue
    const list = childrenByParentId.get(session.parentSessionId) ?? []
    list.push(session.id)
    childrenByParentId.set(session.parentSessionId, list)
  }
  const result: string[] = []
  const seen = new Set<string>([rootId])
  const queue = [rootId]
  while (queue.length > 0) {
    const current = queue.shift()!
    for (const childId of childrenByParentId.get(current) ?? []) {
      if (seen.has(childId)) continue
      seen.add(childId)
      result.push(childId)
      queue.push(childId)
    }
  }
  return result
}

/**
 * 迁移 Agent 会话到另一个工作区
 * 操作步骤：
 * 1. 验证会话和目标工作区存在
 * 2. 源 == 目标 → no-op
 * 3. 先递归迁移委派子会话，再迁移当前会话的运行时目录
 * 4. 更新元数据（workspaceId + storageLayout + 清空 sdkSessionId）
 * 5. 消息/任务图/Harness/transcript 跟随布局搬迁（managed ↔ project）
 */
export function moveSessionToWorkspace(sessionId: string, targetWorkspaceId: string): AgentSessionMeta {
  let index = readIndex()
  let idx = index.sessions.findIndex((s) => s.id === sessionId)
  if (idx === -1) {
    throw new Error(`Agent 会话不存在: ${sessionId}`)
  }

  let session = index.sessions[idx]!

  // 源 == 目标 → 直接返回
  if (session.workspaceId === targetWorkspaceId) return session

  const targetWs = getAgentWorkspace(targetWorkspaceId)
  if (!targetWs) {
    throw new Error(`目标工作区不存在: ${targetWorkspaceId}`)
  }

  // 委派子会话必须跟随父会话：session-tree 要求父子同工作区才归并，
  // 否则子会话会降级成独立根节点；父会话离开旧项目后子会话还会变成孤儿。
  for (const childId of collectDelegatedDescendantIds(index.sessions, sessionId)) {
    moveSessionToWorkspace(childId, targetWorkspaceId)
  }
  // 子会话迁移会各自写盘；重新读索引，避免用旧快照覆盖它们的 workspaceId 更新。
  index = readIndex()
  idx = index.sessions.findIndex((s) => s.id === sessionId)
  if (idx === -1) {
    throw new Error(`Agent 会话在迁移子会话后消失: ${sessionId}`)
  }
  session = index.sessions[idx]!
  // 记录迁移前的落盘布局：消息/任务图/Harness 需要跟着会话归属一起搬。
  const previousLayout = resolveSessionStorageLayout(session)

  // 记录迁移前的 Pi transcript 目录：会话目录搬迁会把 transcript 一起带走，
  // 旧路径删除必须在新位置执行。
  const oldPiDir = getPiTranscriptDirForSession(sessionId)

  // 移动会话运行时目录（源工作区存在时）。
  // 新布局下 project 的会话数据在项目内 `.profer/sessions/<sid>`，managed 在中央
  // `<config>/agent-workspaces/<slug>/<sid>`，两者都必须跟随会话归属迁移；
  // 旧中央布局由 resolveAgentSessionWorkspacePath 自动回退，搬到新布局即可。
  if (session.workspaceId) {
    const sourceWs = getAgentWorkspace(session.workspaceId)
    if (sourceWs) {
      const srcDir = resolveAgentSessionWorkspacePath(sourceWs.slug, sessionId)
      const destDir = resolveAgentSessionWorkspacePath(targetWs.slug, sessionId)
      if (resolve(srcDir) !== resolve(destDir) && existsSync(srcDir)) {
        assertNotProjectLifecyclePath(srcDir)
        assertNotProjectLifecyclePath(destDir)
        // rename 的目标父目录必须已存在；destDir 本身不能提前创建。
        mkdirSync(dirname(destDir), { recursive: true })
        // 清理已存在的目标目录，防止 renameSync 抛出 ENOTEMPTY/EEXIST
        if (existsSync(destDir)) {
          try {
            const contents = readdirSync(destDir)
            if (contents.length === 0) {
              rmSync(destDir, { recursive: true })
              console.log(`[Agent 会话] 已清理空目标目录: ${destDir}`)
            } else {
              // 目标目录非空，合并：先移除目标，再移动源
              rmSync(destDir, { recursive: true })
              console.log(`[Agent 会话] 已清理非空目标目录（以源目录为准）: ${destDir}`)
            }
          } catch (cleanupError) {
            console.warn(`[Agent 会话] 清理目标目录失败，跳过目录迁移:`, cleanupError)
          }
        }
        try {
          renameSync(srcDir, destDir)
        } catch (renameErr) {
          // 跨文件系统（EXDEV）时 renameSync 会失败，回退到 copy + delete
          if ((renameErr as NodeJS.ErrnoException).code === 'EXDEV') {
            console.log(`[Agent 会话] 跨设备移动，使用复制+删除: ${srcDir} → ${destDir}`)
            cpSync(srcDir, destDir, { recursive: true })
            rmSync(srcDir, { recursive: true, force: true })
          } else {
            throw renameErr
          }
        }
        console.log(`[Agent 会话] 已移动会话目录: ${srcDir} → ${destDir}`)
      }
    }
  }

  // 确保目标工作区下有 session 目录
  getAgentSessionWorkspacePath(targetWs.slug, sessionId)

  // 消息/任务图/Harness 跟随布局变化迁移（managed ↔ project）。
  const targetDataDir = projectSessionDataDir(targetWorkspaceId, sessionId)
  const nextLayout = targetDataDir
    ? { kind: 'project' as const, dataDir: targetDataDir }
    : { kind: 'managed' as const }
  moveSessionDataFiles(sessionId, previousLayout, nextLayout)

  // 更新元数据
  const updated: AgentSessionMeta = {
    ...session,
    workspaceId: targetWorkspaceId,
    storageLayout: nextLayout.kind,
    sdkSessionId: undefined, // SDK 上下文与工作区 cwd 绑定，必须清空
    ...(normalizeAgentRuntime(session.agentRuntime) === 'pi'
      ? { piSessionFile: undefined, piEntryBindings: undefined, piFileCheckpoints: undefined }
      : {}),
    updatedAt: Date.now(),
  }
  if (normalizeAgentRuntime(session.agentRuntime) === 'pi') {
    // Pi transcript 与文件检查点包含旧 cwd 的状态；迁移后重建 runtime，避免在新工作区恢复旧目录快照。
    const oldPiSessionFile = session.sdkSessionId
      ? resolvePiTranscriptPath(session.sdkSessionId, session.piSessionFile, { rootDir: oldPiDir, refreshOnFallback: true })
      : undefined
    // 会话目录已整体搬迁：旧 transcript 现在位于新布局的 pi/ 下。
    const nextPiDir = nextLayout.kind === 'project' && nextLayout.dataDir
      ? join(nextLayout.dataDir, 'pi')
      : join(getSdkConfigDir(), 'sessions', 'pi')
    const movedPiSessionFile = oldPiSessionFile ? join(nextPiDir, basename(oldPiSessionFile)) : undefined
    for (const candidate of [oldPiSessionFile, movedPiSessionFile]) {
      if (!candidate || !existsSync(candidate)) continue
      try {
        unlinkSync(candidate)
      } catch (error) {
        console.warn(`[Agent 会话] 迁移工作区时清理旧 Pi transcript 失败: ${candidate}`, error)
      }
    }
    try {
      const keepPaths = collectForeignCheckpointPaths(sessionId)
      prunePiFileCheckpoints(getPiCheckpointsDir(), sessionId, { keepPaths })
    } catch (error) {
      console.warn(`[Agent 会话] 迁移工作区时清理旧 Pi 检查点失败: sessionId=${sessionId}`, error)
    }
  }
  index.sessions[idx] = updated
  writeIndex(index)
  registerSessionLayout(updated)

  console.log(`[Agent 会话] 已迁移会话到工作区: ${updated.title} → ${targetWs.name}`)
  return updated
}

/**
 * 迁移 Chat 对话记录到 Agent 会话
 *
 * 读取 Chat 对话的消息，转换为 AgentMessage 格式，
 * 追加到目标 Agent 会话的 JSONL 文件中。
 *
 * 仅迁移 user 和 assistant 角色的消息文本内容，
 * 工具活动、推理、附件等 Chat 特有字段不迁移。
 */
export function migrateChatToAgentSession(conversationId: string, agentSessionId: string): void {
  const chatMessages = getConversationMessages(conversationId)

  if (chatMessages.length === 0) {
    console.log(`[Agent 会话] Chat 对话无消息，跳过迁移 (${conversationId})`)
    return
  }

  let count = 0
  for (const cm of chatMessages) {
    // 仅迁移 user 和 assistant 消息
    if (cm.role !== 'user' && cm.role !== 'assistant') continue
    if (!cm.content.trim()) continue

    const agentMsg: AgentMessage = {
      id: randomUUID(),
      role: cm.role,
      content: cm.content,
      createdAt: cm.createdAt,
      model: cm.role === 'assistant' ? cm.model : undefined,
    }

    appendAgentMessage(agentSessionId, agentMsg)
    count++
  }

  console.log(`[Agent 会话] 已迁移 ${count} 条消息到 Agent 会话 (${conversationId} → ${agentSessionId})`)
}

/**
 * 分叉 Pi Agent 会话。
 *
 * Pi 的 session 是 append-only tree。分叉必须由 SessionManager 导出目标 branch，
 * 不能只复制 Profer 的展示 JSONL，否则下一轮 resume 仍会看到被截断的上下文。
 */
async function forkPiAgentSession(sourceMeta: AgentSessionMeta, input: ForkSessionInput): Promise<AgentSessionMeta> {
  const targetUuid = input.upToMessageUuid
  if (!targetUuid) throw new Error('Pi 分叉需要指定一条已完成的 assistant 消息')
  const forkPoint = resolvePiForkPoint(sourceMeta, targetUuid)
  if (!forkPoint) throw new Error('该 Pi 历史消息尚无可用的 entry ID 映射，无法安全分叉；请在当前版本中继续一次 Pi 对话后再试')
  if (!sourceMeta.piSessionFile || !existsSync(sourceMeta.piSessionFile)) {
    throw new Error('未找到 Pi session artifact，无法安全分叉')
  }

  // 未显式换模型时继承源会话模型；即使源渠道后来被删除/停用，也允许复制
  // 已存在的 Pi artifact。只有用户主动选择新模型时才需要重新校验渠道能力。
  const forkModelId = input.modelId !== undefined
    ? assertEnabledModelForChannel({
        channelId: sourceMeta.channelId,
        modelId: input.modelId,
        runtime: 'pi',
        purpose: '分叉 Pi Agent 会话',
      })
    : sourceMeta.modelId
  const workspace = sourceMeta.workspaceId ? getAgentWorkspace(sourceMeta.workspaceId) : undefined
  // cwd（Pi session 的目录元数据）与 storageDir（本会话私有文件）是两种语义：
  // project 下 cwd 是项目根，存储目录在中央，绝不能混用（I2/I3）。
  const sourceCwd = workspace ? resolveAgentSessionCwd(workspace.slug, sourceMeta.id) : undefined
  const sourceStorageDir = workspace ? getAgentSessionWorkspacePath(workspace.slug, sourceMeta.id) : undefined
  const newMeta = createAgentSession(
    `${sourceMeta.title} (fork)`,
    sourceMeta.channelId,
    sourceMeta.workspaceId,
    forkModelId,
    'pi',
  )
  const destCwd = workspace ? resolveAgentSessionCwd(workspace.slug, newMeta.id) : undefined
  const destStorageDir = workspace ? getAgentSessionWorkspacePath(workspace.slug, newMeta.id) : undefined

  try {
    const sessionDir = getPiTranscriptDirForSession(newMeta.id)
    const forkedManager = await forkPiSessionArtifact({
      sourceSessionFile: sourceMeta.piSessionFile,
      sessionDir,
      sourceDir: sourceCwd,
      destinationDir: destCwd,
      entryId: forkPoint.entryId,
    })
    const piSessionFile = forkedManager.getSessionFile()
    if (!piSessionFile || !existsSync(piSessionFile)) throw new Error('Pi 分叉 artifact 校验失败')
    if (forkPoint.interruptedText) {
      // 被中断的 assistant 消息没有可恢复的 Pi message entry，不能将其伪装为分叉点。
      // 以最近的完整 entry 建 branch，并把已展示文字作为隐藏上下文追加到新 session。
      forkedManager.appendCustomMessageEntry(
        'profer-interrupted-assistant-context',
        `上一轮助手回复被用户手动暂停。以下是暂停前已展示的内容；请将其视为已有上下文，不要重复输出，除非用户要求：\n\n${forkPoint.interruptedText}`,
        false,
        { sourceAssistantUuid: targetUuid },
      )
    }
    // 新 branch 只包含分叉点之前的 entry；不能把源树后续 turn 的映射带入 metadata。
    const branchBindings = Object.fromEntries(
      Object.entries(sourceMeta.piEntryBindings ?? {})
        .filter(([, mappedEntryId]) => Boolean(forkedManager.getEntry(mappedEntryId))),
    )
    // 检查点以 Pi entry id 为键（而 bindings 是 uuid → entry id），
    // 只继承新 branch 中实际存在的 entry，再迁移到分叉会话自己的检查点目录。
    const keptEntryIds = new Set(Object.values(branchBindings))
    const inheritedCheckpoints = Object.fromEntries(
      Object.entries(sourceMeta.piFileCheckpoints ?? {})
        .filter(([entryId]) => keptEntryIds.has(entryId)),
    )
    const branchCheckpoints = adoptInheritedCheckpoints(sourceMeta.id, newMeta.id, inheritedCheckpoints)

    const explorationMeta = input.explorationSourceLabel ? {
      explorationParentSessionId: sourceMeta.id,
      explorationSourceMessageId: targetUuid,
      explorationSourceLabel: input.explorationSourceLabel,
    } : {}
    updateAgentSessionMeta(newMeta.id, {
      sdkSessionId: forkedManager.getSessionId(),
      piSessionFile,
      piEntryBindings: branchBindings,
      ...(Object.keys(branchCheckpoints).length > 0 && { piFileCheckpoints: branchCheckpoints }),
      forkSourceDir: sourceCwd,
      ...explorationMeta,
    })
    newMeta.sdkSessionId = forkedManager.getSessionId()
    newMeta.piSessionFile = piSessionFile
    newMeta.piEntryBindings = branchBindings
    if (Object.keys(branchCheckpoints).length > 0) newMeta.piFileCheckpoints = branchCheckpoints
    Object.assign(newMeta, explorationMeta)

    // 复制的是会话私有数据（附件 / .context 等）：project 下 cwd 相同，复制 cwd 会变成
    // cpSync(项目根, 项目根)；storageDir 才是正确源与目标。
    if (sourceStorageDir && destStorageDir) {
      const copyResult = copyForkWorkspaceFiles(sourceStorageDir, destStorageDir)
      if (copyResult.failedCount > 0) {
        console.warn(`[Agent 会话] Pi fork 工作区有 ${copyResult.failedCount} 个条目未复制:`, copyResult.failedPaths)
      }
    }
    await copyForkStoredSDKMessages({
      sourceSessionId: sourceMeta.id,
      destSessionId: newMeta.id,
      upToMessageUuid: targetUuid,
      sourceDir: sourceCwd,
      destDir: destCwd,
    })
    copySettledPiHarnessEventsForFork(sourceMeta.id, newMeta.id, resolveForkTimestamp(targetUuid, getAgentSessionSDKMessages(sourceMeta.id)))
    return newMeta
  } catch (error) {
    // 尚未对外返回的新 session 可安全清理，避免留下会被侧栏打开的半成品。
    try { await deleteAgentSession(newMeta.id) } catch { /* 保留原始错误 */ }
    throw error
  }
}

interface PiForkPoint {
  entryId: string
  interruptedText?: string
}

/**
 * 把分叉会话继承到的基线搬到它自己的检查点目录，并返回重写后的 entry → 路径映射。
 *
 * 直接跨会话引用源会话目录里的基线是危险的：源会话下一轮的常规回收（它只认自己的映射）
 * 或删除源会话都会把分叉侧的回退点打掉。迁移后每个会话只引用自己的基线，
 * 回收/删除语义完全局部化；个别条目迁移失败时暂存原引用，删除源会话时会再次迁移或明确摘除。
 */
function adoptInheritedCheckpoints(
  sourceSessionId: string,
  targetSessionId: string,
  inherited: Record<string, string>,
): Record<string, string> {
  const paths = Object.values(inherited)
  if (paths.length === 0) return {}
  try {
    const { adopted, failed } = adoptPiFileCheckpoints({
      rootDir: getPiCheckpointsDir(),
      targetSessionId,
      paths,
    })
    if (failed.length > 0) {
      console.warn(`[Agent 会话] 分叉会话 ${targetSessionId} 有 ${failed.length} 份基线未迁移，仍引用源会话 ${sourceSessionId}`)
    }
    return Object.fromEntries(
      Object.entries(inherited).map(([entryId, checkpointPath]) => [entryId, adopted[checkpointPath] ?? checkpointPath]),
    )
  } catch (error) {
    console.warn('[Agent 会话] 迁移分叉会话基线失败，保留源会话引用:', error)
    return inherited
  }
}

/**
 * 已完成 assistant 消息可直接作为 Pi tree branch leaf。手动暂停的 partial 消息
 * 没有 entry binding 时，退回到它之前最近的完整 assistant entry，并在新分支写入
 * 可供模型读取的隐藏文本上下文，避免把 aborted Pi message 当成可 resume 的节点。
 */
function resolvePiForkPoint(sourceMeta: AgentSessionMeta, targetUuid: string): PiForkPoint | undefined {
  const bindings = sourceMeta.piEntryBindings ?? {}
  const directEntryId = bindings[targetUuid]
  if (directEntryId) return { entryId: directEntryId }

  const messages = getAgentSessionSDKMessages(sourceMeta.id)
  const targetIndex = messages.findIndex((message) => getStoredMessageUuid(message) === targetUuid)
  if (targetIndex < 0) return undefined

  const target = messages[targetIndex]
  if (target?.type !== 'assistant') return undefined
  const interruptedText = extractTextFromSDKMessage(target)
  if (!interruptedText) return undefined

  for (let index = targetIndex - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!message) continue
    const entryId = bindings[getStoredMessageUuid(message) ?? '']
    if (entryId) return { entryId, interruptedText }
  }
  return undefined
}

function extractTextFromSDKMessage(message: SDKMessage): string {
  const content = (message as { message?: { content?: Array<{ type?: string; text?: string }> } }).message?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text!)
    .join('\n')
    .trim()
}

/**
 * 回退 Pi Agent 会话（同一会话内截断到指定 assistant 消息）。
 *
 * Pi 的 session 是 append-only tree，但 Profer 每次 sendMessage 都会重新
 * `SessionManager.open()` 会话文件，leaf 指针 = 文件中最后一个 entry。因此
 * 不能只改内存 leaf，必须**物理截断 JSONL**：保留 header + root→目标 entry
 * 的主路径（getBranch），丢弃其余 entry（含未激活分支与目标之后的 turn）。
 * 截断后下一次 resume 用同一个 piSessionFile/sdkSessionId，SDK 从目标处继续。
 *
 * Pi 没有 Claude SDK 的 file-history-snapshot，无法恢复文件，返回 canRewind=false。
 */
export async function rewindPiSession(
  sessionId: string,
  assistantMessageUuid: string,
  sessionMeta: AgentSessionMeta,
): Promise<RewindSessionResult> {
  const piSessionFile = sessionMeta.piSessionFile
  if (!piSessionFile || !existsSync(piSessionFile)) {
    throw new Error('未找到 Pi session artifact，无法回退')
  }

  const bindings = sessionMeta.piEntryBindings ?? {}

  // 1. 定位目标 entry：优先直接命中；未命中（子代理执行过程/已被清理/未完成消息）时
  //    向前找最近一条有 Pi entry 映射的 assistant 消息作为截断点，与分叉逻辑保持一致。
  let cutMessageUuid = assistantMessageUuid
  let entryId = bindings[assistantMessageUuid]
  if (!entryId) {
    const messages = getAgentSessionSDKMessages(sessionId)
    const targetIndex = messages.findIndex((message) => getStoredMessageUuid(message) === assistantMessageUuid)
    if (targetIndex < 0) {
      throw new Error('回退失败：未找到目标消息')
    }
    for (let index = targetIndex; index >= 0; index -= 1) {
      const message = messages[index]
      const uuid = message ? getStoredMessageUuid(message) : undefined
      const mappedEntryId = uuid ? bindings[uuid] : undefined
      if (mappedEntryId) {
        entryId = mappedEntryId
        cutMessageUuid = uuid!
        break
      }
    }
  }
  if (!entryId) {
    throw new Error('该 Pi 历史消息尚无可用的 entry ID 映射，无法安全回退；请在当前版本中继续一次 Pi 对话后再试')
  }

  // 2. 先验证目标 Pi entry，并生成准备原子替换的 transcript 内容。
  // 文件恢复必须等到这里成功之后再开始，避免 transcript 已损坏时只改了工作区。
  let fileRewind: RewindSessionResult['fileRewind']
  const checkpointPath = sessionMeta.piFileCheckpoints?.[entryId]

  // 3. 物理截断 Pi session 文件：header + root→目标 entry 的主路径
  const sdk = await import('@earendil-works/pi-coding-agent')
  const sessionDir = getPiTranscriptDirForSession(sessionMeta.id)
  const workspace = sessionMeta.workspaceId ? getAgentWorkspace(sessionMeta.workspaceId) : undefined
  // Pi session 的目录参数是 cwd（project = 项目根），不是会话存储目录。
  const sourceDir = workspace ? resolveAgentSessionCwd(workspace.slug, sessionMeta.id) : undefined
  const manager = sdk.SessionManager.open(piSessionFile, sessionDir, sourceDir)
  if (!manager.getEntry(entryId)) {
    throw new Error('Pi session 中找不到该 entry，无法回退')
  }
  const header = manager.getHeader()
  const keptEntries = manager.getBranch(entryId)
  const newContent =
    [header, ...keptEntries]
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
      .map((entry) => JSON.stringify(entry))
      .join('\n') + '\n'

  // 先恢复文件。旧会话没有 checkpoint 时仍允许对话回退并给出明确降级；
  // 只有当前状态/tree 无法安全比较时才必须取消整个 rewind，避免对话已截断而文件未知。
  if (shouldSkipPiFileCheckpoint(workspace)) {
    // project 模式不创建文件检查点（快照根会是整个项目），这里也绝不用 rootPath 做恢复根：
    // 同项目其他会话的文件会被回退/删除。项目文件回退交给 git 完成。
    console.log(`[Agent 会话] 项目模式跳过 Pi 文件恢复，仅回退对话 (sessionId=${sessionId})`)
    fileRewind = { canRewind: false, error: '项目模式下文件回退由 git 负责，本次仅回退对话' }
  } else if (!checkpointPath) {
    fileRewind = { canRewind: false, error: '该 Pi turn 没有文件检查点（旧会话或检查点创建失败）' }
  } else {
    let restored: ReturnType<typeof restorePiFileCheckpoint> | undefined
    try {
      const cwd = workspace ? resolveAgentSessionCwd(workspace.slug, sessionId) : process.cwd()
      restored = restorePiFileCheckpoint(loadPiFileCheckpoint(checkpointPath), cwd)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[Agent 会话] Pi 文件恢复不可用，将只回退对话: ${message}`)
      fileRewind = { canRewind: false, error: message }
    }
    if (restored) {
      if (restored.failed) {
        const message = restored.skipped.map((item) => `${item.path}: ${item.reason}`).join('；') || '无法安全恢复文件检查点'
        console.warn(`[Agent 会话] Pi 文件恢复不安全，已保留对话历史: ${message}`)
        throw new Error(`文件恢复不可用，已取消对话回退: ${message}`)
      }
      fileRewind = {
        canRewind: true,
        filesChanged: restored.changed,
        ...(restored.skipped.length > 0 && { skippedFiles: restored.skipped.map((item) => item.path) }),
        ...(restored.incomplete && { incomplete: true }),
      }
    }
  }

  // 先写临时文件再原子替换，避免回退过程中进程退出留下半截 Pi transcript。
  const tempSessionFile = `${piSessionFile}.rewind-${process.pid}-${Date.now()}.tmp`
  try {
    writeFileSync(tempSessionFile, newContent, 'utf-8')
    renameSync(tempSessionFile, piSessionFile)
  } finally {
    if (existsSync(tempSessionFile)) unlinkSync(tempSessionFile)
  }
  console.log(`[Agent 会话] Pi session 已截断: sessionId=${sessionId}, 保留 ${keptEntries.length} 条 entry (entry=${entryId})`)

  // 4. 截断 Profer 展示 JSONL（与 Pi 文件保持一致）
  const kept = truncateSDKMessages(sessionId, cutMessageUuid)

  // 4. 清理 piEntryBindings：删除已截断 entry 的映射，避免残留脏映射；
  //    Pi 不消费 resumeAtMessageUuid，清掉历史遗留以防切回 Claude 时误分支。
  const keptEntryIds = new Set(keptEntries.map((entry) => entry.id))
  const keptBindings = Object.fromEntries(
    Object.entries(bindings).filter(([, mappedEntryId]) => keptEntryIds.has(mappedEntryId)),
  )
  const keptCheckpoints = Object.fromEntries(
    Object.entries(sessionMeta.piFileCheckpoints ?? {}).filter(([mappedEntryId]) => keptEntryIds.has(mappedEntryId)),
  )
  // 被截断 turn 的检查点已无人引用，立即回收（每轮一份基线，不回收会持续占盘）。
  // 分叉会话可能仍在引用本会话的检查点，必须把它们视为“已绑定”，否则分叉侧的回退点会失效。
  try {
    const keepPaths = new Set(Object.values(keptCheckpoints))
    for (const foreign of collectForeignCheckpointPaths(sessionId)) keepPaths.add(foreign)
    prunePiFileCheckpoints(getPiCheckpointsDir(), sessionId, { keepPaths })
  } catch (error) {
    console.warn('[Agent 会话] 回收 Pi 文件检查点失败:', error)
  }
  updateAgentSessionMeta(sessionId, {
    piEntryBindings: keptBindings,
    piFileCheckpoints: keptCheckpoints,
    resumeAtMessageUuid: undefined,
  })

  return {
    remainingMessages: kept.length,
    fileRewind,
  }
}

/**
 * 从主路径里挑出「第一轮」的文件检查点路径。
 *
 * Pi 在每轮开始前保存工作区基线，并把基线绑定到该轮的 assistant entry，
 * 所以主路径（root→leaf）上**最早**一个有绑定的 entry 对应的基线就是「第一轮开始前」。
 *
 * 该 entry 没有可用检查点时不向后找：后面轮次的基线对应的是中间状态，
 * 拿来当会话起点会静默恢复出错误的文件状态，宁可返回 undefined 让调用方明确降级。
 */
export function resolveFirstTurnCheckpoint(params: {
  /** 主路径上的 entry id，按 root→leaf 顺序 */
  branchEntryIds: readonly string[]
  /** assistant uuid → entry id */
  bindings: Record<string, string>
  /** entry id → 检查点路径 */
  checkpoints: Record<string, string>
}): string | undefined {
  const boundEntryIds = new Set(Object.values(params.bindings))
  for (const entryId of params.branchEntryIds) {
    if (boundEntryIds.has(entryId)) return params.checkpoints[entryId]
  }
  return undefined
}

/**
 * 清空 Pi 会话（置回会话起点）。
 *
 * 与 `rewindPiSession` 的区别：这里没有可保留的锚点（首轮就失败），目标是
 * transcript 只剩 header。文件按**第一轮**的 pre-turn 基线恢复：Pi 每轮开始时
 * 保存工作区基线并绑定到该轮的 assistant entry，因此最早一个有绑定的 entry
 * 对应的检查点就是「第一轮开始前」的状态。
 *
 * 没有可用基线时降级为「只清对话、不动文件」并明确告知，而不是静默假装已回退。
 */
export async function resetPiSession(
  sessionId: string,
  sessionMeta: AgentSessionMeta,
): Promise<RewindSessionResult> {
  const piSessionFile = sessionMeta.piSessionFile
  // 没有 Pi artifact（会话在第一轮建会话之前就失败了）时无 transcript 可截断。
  // 清 Profer JSONL 本身就足够且完整（下一轮会建一个全新的 Pi 会话），
  // 不能因为“没东西可截断”把整个清空卡住。
  const hasPiArtifact = Boolean(piSessionFile) && existsSync(piSessionFile!)

  /**
   * 收尾：清空展示 JSONL + 回收 entry 绑定与文件检查点。
   * 有/无 Pi artifact 两条路径都必须走，避免其中一条漏掉清理。
   */
  const finish = (fileRewind: RewindSessionResult['fileRewind'], clearPiSessionFile: boolean): RewindSessionResult => {
    clearSDKMessages(sessionId)
    try {
      const keepPaths = new Set(collectForeignCheckpointPaths(sessionId))
      prunePiFileCheckpoints(getPiCheckpointsDir(), sessionId, { keepPaths })
    } catch (error) {
      console.warn('[Agent 会话] 回收 Pi 文件检查点失败:', error)
    }
    updateAgentSessionMeta(sessionId, {
      ...(clearPiSessionFile ? { piSessionFile: undefined } : {}),
      piEntryBindings: undefined,
      piFileCheckpoints: undefined,
      resumeAtMessageUuid: undefined,
    })
    return { remainingMessages: 0, fileRewind }
  }

  if (!hasPiArtifact) {
    console.warn(`[Agent 会话] Pi 清空对话：没有可用的 Pi artifact，仅清空对话记录 (sessionId=${sessionId})`)
    return finish(
      { canRewind: false, error: '该会话还没有 Pi session artifact，工作区文件未被改动' },
      true,
    )
  }

  const bindings = sessionMeta.piEntryBindings ?? {}
  const sdk = await import('@earendil-works/pi-coding-agent')
  const sessionDir = getPiTranscriptDirForSession(sessionMeta.id)
  const workspace = sessionMeta.workspaceId ? getAgentWorkspace(sessionMeta.workspaceId) : undefined
  // Pi session 的目录参数是 cwd（project = 项目根），不是会话存储目录。
  const sourceDir = workspace ? resolveAgentSessionCwd(workspace.slug, sessionMeta.id) : undefined
  const manager = sdk.SessionManager.open(piSessionFile!, sessionDir, sourceDir)
  const header = manager.getHeader()
  if (!header) {
    throw new Error('Pi session artifact 缺少 header，无法清空对话')
  }

  // 1. 文件恢复：主路径上最早一个有 entry 绑定的轮次即第一轮，其基线是「第一轮开始前」。
  //    必须在截断 transcript 之前完成：文件恢复不安全时要整体取消，避免对话已清而文件未知。
  const checkpointPath = resolveFirstTurnCheckpoint({
    branchEntryIds: manager.getBranch().map((entry) => entry.id),
    bindings,
    checkpoints: sessionMeta.piFileCheckpoints ?? {},
  })

  let fileRewind: RewindSessionResult['fileRewind']
  if (shouldSkipPiFileCheckpoint(workspace)) {
    // 同 rewind：project 模式没有文件检查点，且绝不以 rootPath 为恢复根。
    console.log(`[Agent 会话] 项目模式跳过 Pi 文件恢复，仅清空对话 (sessionId=${sessionId})`)
    fileRewind = { canRewind: false, error: '项目模式下文件回退由 git 负责，本次仅清空对话' }
  } else if (!checkpointPath) {
    console.warn(`[Agent 会话] Pi 清空对话：首轮无文件检查点，跳过文件恢复 (sessionId=${sessionId})`)
    fileRewind = { canRewind: false, error: '首轮没有文件检查点（旧会话或检查点创建失败），工作区文件未被改动' }
  } else {
    let restored: ReturnType<typeof restorePiFileCheckpoint> | undefined
    try {
      const cwd = workspace ? resolveAgentSessionCwd(workspace.slug, sessionId) : process.cwd()
      restored = restorePiFileCheckpoint(loadPiFileCheckpoint(checkpointPath), cwd)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[Agent 会话] Pi 文件恢复不可用，将只清空对话: ${message}`)
      fileRewind = { canRewind: false, error: message }
    }
    if (restored) {
      if (restored.failed) {
        const message = restored.skipped.map((item) => `${item.path}: ${item.reason}`).join('；') || '无法安全恢复文件检查点'
        console.warn(`[Agent 会话] Pi 文件恢复不安全，已取消清空对话: ${message}`)
        throw new Error(`文件恢复不可用，已取消清空对话: ${message}`)
      }
      fileRewind = {
        canRewind: true,
        filesChanged: restored.changed,
        ...(restored.skipped.length > 0 && { skippedFiles: restored.skipped.map((item) => item.path) }),
        ...(restored.incomplete && { incomplete: true }),
      }
    }
  }

  // 2. 物理截断 Pi session 文件：只保留 header（先写临时文件再原子替换）
  const tempSessionFile = `${piSessionFile}.reset-${process.pid}-${Date.now()}.tmp`
  try {
    writeFileSync(tempSessionFile, `${JSON.stringify(header)}\n`, 'utf-8')
    renameSync(tempSessionFile, piSessionFile!)
  } finally {
    if (existsSync(tempSessionFile)) unlinkSync(tempSessionFile)
  }
  console.log(`[Agent 会话] Pi session 已清空: sessionId=${sessionId}`)

  return finish(fileRewind, false)
}

interface CopyForkStoredSDKMessagesInput {
  sourceSessionId: string
  destSessionId: string
  upToMessageUuid?: string
  sourceDir?: string
  destDir?: string
}

/** 流式复制源会话展示 JSONL 到分叉会话，按目标 UUID 截断并改写路径。 */
async function copyForkStoredSDKMessages({
  sourceSessionId,
  destSessionId,
  upToMessageUuid,
  sourceDir,
  destDir,
}: CopyForkStoredSDKMessagesInput): Promise<number> {
  const sourcePath = getAgentSessionMessagesPath(sourceSessionId)
  if (!existsSync(sourcePath)) return 0

  const destPath = getAgentSessionMessagesPath(destSessionId)
  const out = createWriteStream(destPath, { flags: 'a', encoding: 'utf-8' })
  let copiedCount = 0

  try {
    for await (const msg of readStoredSDKMessages(sourcePath)) {
      await writeJsonlLine(out, serializeSDKMessageForStorage(msg, sourceDir, destDir))
      copiedCount += 1

      if (upToMessageUuid && getStoredMessageUuid(msg) === upToMessageUuid) {
        break
      }
    }
    await endWriteStream(out)
  } catch (err) {
    out.destroy()
    throw err
  }

  return copiedCount
}

async function* readStoredSDKMessages(filePath: string): AsyncGenerator<SDKMessage> {
  const rl = createInterface({
    input: createReadStream(filePath),
    crlfDelay: Infinity,
  })

  for await (const line of rl) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line)
      if ('role' in parsed && !('type' in parsed)) {
        yield convertLegacyMessage(parsed as AgentMessage)
      } else {
        yield parsed as SDKMessage
      }
    } catch (err) {
      console.warn(`[Agent 会话] 跳过无法解析的 SDKMessage 行 (${filePath}):`, err)
    }
  }
}

function getStoredMessageUuid(msg: SDKMessage): string | undefined {
  return 'uuid' in msg ? (msg as { uuid?: string }).uuid : undefined
}

function serializeSDKMessageForStorage(
  msg: SDKMessage,
  sourceDir?: string,
  destDir?: string,
): string {
  let serialized = JSON.stringify(msg)
  if (sourceDir && destDir) {
    serialized = rewriteSourceToDest(serialized, sourceDir, destDir)
  }
  if (serialized.length <= MAX_SDK_MESSAGE_LENGTH) return serialized

  let externalized = externalizeSerializedSessionLine(serialized)
  if (sourceDir && destDir) {
    externalized = rewriteSourceToDest(externalized, sourceDir, destDir)
  }
  return externalized
}

async function writeJsonlLine(stream: WriteStream, line: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    stream.write(line + '\n', (err) => {
      if (err) reject(err)
      else resolve()
    })
  })
}

async function endWriteStream(stream: WriteStream): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    stream.once('error', reject)
    stream.end(resolve)
  })
}

/**
 * 分叉 Agent 会话（SDK 原生 fork）
 *
 * 直接调用 SDK 的 forkSession() 独立函数完成 JSONL 复制和 UUID 重映射，
 * 新会话立即获得 sdkSessionId，无需延迟到首次发消息。
 *
 * forkSourceDir 记录源会话的工作目录，仅作为元数据参考保留。
 * SDK session JSONL 已在 fork 创建时复制到新会话的 project-hash 目录下，
 * orchestrator 无需在运行时切换 cwd。
 *
 * process.env.CLAUDE_CONFIG_DIR 已在模块加载时设置，无需在此处临时修改。
 *
 * @returns 新创建的会话元数据
 */
export async function forkAgentSession(input: ForkSessionInput): Promise<AgentSessionMeta> {
  const { sessionId } = input
  const sourceMeta = getAgentSessionMeta(sessionId)
  if (!sourceMeta) {
    throw new Error(`源 Agent 会话不存在: ${sessionId}`)
  }
  if (agentSessionActiveChecker?.(sessionId)) {
    throw new Error('Agent 正在运行，完成后再分叉')
  }
  if (activeForkSessionIds.has(sessionId)) {
    throw new Error('该会话正在创建分叉，请稍候再试')
  }

  activeForkSessionIds.add(sessionId)
  try {
    return await forkAgentSessionUnlocked(sourceMeta, input)
  } finally {
    activeForkSessionIds.delete(sessionId)
  }
}

async function forkAgentSessionUnlocked(sourceMeta: AgentSessionMeta, input: ForkSessionInput): Promise<AgentSessionMeta> {
  const { sessionId, upToMessageUuid } = input

  // Pi 会话走 Pi 原生分叉（SessionManager branch + forkFrom）；Claude 会话走下方 Claude SDK fork。
  if (normalizeAgentRuntime(sourceMeta.agentRuntime) === 'pi') {
    return forkPiAgentSession(sourceMeta, input)
  }

  if (input.explorationSourceLabel) {
    throw new Error('探索分支目前仅支持 Pi Agent 会话')
  }
  if (!sourceMeta.sdkSessionId) {
    throw new Error('该会话没有 SDK session，无法分叉')
  }

  // 2. 确定源会话的 cwd（SDK 需要从此目录的项目空间读取 session 文件；project = 项目根）
  let sourceDir: string | undefined
  let sourceStorageDir: string | undefined
  if (sourceMeta.workspaceId) {
    const ws = getAgentWorkspace(sourceMeta.workspaceId)
    if (ws) {
      sourceDir = resolveAgentSessionCwd(ws.slug, sessionId)
      sourceStorageDir = getAgentSessionWorkspacePath(ws.slug, sessionId)
    }
  }

  // 2.5 校验目标消息并确定其所属的 SDK session ID
  // - 当会话经历过 "session not found" 恢复后，sdkSessionId 会被替换为新的，
  //   但旧消息仍保留在 Profer JSONL 中，其 session_id 指向旧的 SDK session。
  // - 若目标消息是 sub-agent 输出（parent_tool_use_id 非空），SDK forkSession
  //   会过滤掉 sidechain 后再查 upToMessageId，必然报 "not found"，
  //   这里自动回溯到最近的主线 assistant uuid。
  let forkSourceSdkSessionId = sourceMeta.sdkSessionId
  let effectiveUpToMessageUuid = upToMessageUuid
  if (upToMessageUuid) {
    const allMessages = getAgentSessionSDKMessages(sessionId)
    const targetIdx = allMessages.findLastIndex(
      (m) => 'uuid' in m && (m as { uuid?: string }).uuid === upToMessageUuid,
    )

    if (targetIdx < 0) {
      throw new Error('未在会话历史中找到指定的消息，可能消息已被清理或截断')
    }

    const targetMsg = allMessages[targetIdx]!
    const isSidechain =
      targetMsg.type === 'assistant' &&
      Boolean((targetMsg as { parent_tool_use_id?: string | null }).parent_tool_use_id)

    if (isSidechain) {
      // 向前回溯，寻找最近的主线 assistant 消息（parent_tool_use_id 为空）
      let fallbackUuid: string | undefined
      for (let i = targetIdx - 1; i >= 0; i--) {
        const m = allMessages[i]!
        if (m.type !== 'assistant') continue
        if ((m as { parent_tool_use_id?: string | null }).parent_tool_use_id) continue
        const u = (m as { uuid?: string }).uuid
        if (u) {
          fallbackUuid = u
          break
        }
      }
      if (!fallbackUuid) {
        throw new Error('选中的是子代理执行过程中的消息，且向前找不到可分叉的主对话消息')
      }
      console.log(
        `[Agent 会话] fork 目标消息 ${upToMessageUuid} 属于 sub-agent，自动回溯到主线消息 ${fallbackUuid}`,
      )
      effectiveUpToMessageUuid = fallbackUuid
    }

    // 重新定位 effectiveUpToMessageUuid 所在消息，取其 session_id
    // 与上面的 findLastIndex 保持一致语义（重复 uuid 时取最后一条）
    const effectiveMsg =
      effectiveUpToMessageUuid === upToMessageUuid
        ? targetMsg
        : allMessages.findLast(
            (m) => 'uuid' in m && (m as { uuid?: string }).uuid === effectiveUpToMessageUuid,
          )
    const msgSessionId = (effectiveMsg as { session_id?: string } | undefined)?.session_id
    if (msgSessionId && msgSessionId !== sourceMeta.sdkSessionId) {
      console.log(
        `[Agent 会话] fork 目标消息属于旧 SDK session ${msgSessionId}（当前为 ${sourceMeta.sdkSessionId}），使用消息所属 session 进行 fork`,
      )
      forkSourceSdkSessionId = msgSessionId
    }
  }

  // 3. 调用 SDK 原生 forkSession
  // process.env.CLAUDE_CONFIG_DIR 已在模块加载时设置，SDK 会自动读取
  const sdk = await import('@anthropic-ai/claude-agent-sdk')
  let forkResult: Awaited<ReturnType<typeof sdk.forkSession>>
  try {
    forkResult = await sdk.forkSession(forkSourceSdkSessionId, {
      upToMessageId: effectiveUpToMessageUuid,
      dir: sourceDir,
    })
  } catch (err) {
    // 指定 dir 失败时，让 SDK 自动搜索所有项目目录
    if (sourceDir) {
      console.warn(`[Agent 会话] forkSession 指定 dir 失败，改用全局搜索:`, err)
      forkResult = await sdk.forkSession(forkSourceSdkSessionId, {
        upToMessageId: effectiveUpToMessageUuid,
      })
    } else {
      throw err
    }
  }

  // 3.5 校验 SDK forkSession 是否真的产生了 JSONL 文件
  // SDK forkSession 在某些边缘场景（如源会话为 collaboration 子会话、project-hash
  // 不匹配等）可能返回 sessionId 但实际未落盘 JSONL。若不校验，后续步骤会创建
  // Profer 会话元数据但 SDK 侧无对应文件，导致 "No conversation found" 错误。
  const forkJsonlPath = findSdkSessionJsonl(forkResult.sessionId)
  if (!forkJsonlPath) {
    throw new Error(
      `SDK forkSession 返回了 sessionId (${forkResult.sessionId}) 但未找到对应的 JSONL 文件。` +
      `源会话: ${sessionId}, 源 SDK session: ${forkSourceSdkSessionId}。` +
      `这通常是 SDK 在非标准会话（如协作子会话）上 fork 时的已知问题，建议在原会话中继续工作或新建会话。`,
    )
  }
  console.log(`[Agent 会话] SDK forkSession JSONL 已确认: ${forkJsonlPath}`)

  // 4. 创建 Profer 新会话，立即设置 sdkSessionId
  const forkTitle = `${sourceMeta.title} (fork)`
  const newMeta = createAgentSession(
    forkTitle,
    sourceMeta.channelId,
    sourceMeta.workspaceId,
    undefined,
    'claude',
  )

  updateAgentSessionMeta(newMeta.id, {
    sdkSessionId: forkResult.sessionId,
    forkSourceDir: sourceDir,
    forkSourceSdkSessionId: forkSourceSdkSessionId,
  })
  // 同步返回值（updateAgentSessionMeta 已写入磁盘，这里让调用方拿到最新值）
  newMeta.sdkSessionId = forkResult.sessionId
  newMeta.forkSourceDir = sourceDir
  newMeta.forkSourceSdkSessionId = forkSourceSdkSessionId

  // 4.4-7 包装在 try-catch 中，关键步骤失败时回滚已创建的 Profer 会话记录，
  // 避免产生孤儿条目（agent-sessions.json 有记录但无有效 SDK session 数据）。
  try {
    // 4.4 计算 fork 目标会话的 cwd（project = 与源会话相同的项目根），后续多个步骤需要用到
    let destDir: string | undefined
    let destStorageDir: string | undefined
    if (sourceDir && sourceMeta.workspaceId) {
      const ws = getAgentWorkspace(sourceMeta.workspaceId)
      if (ws) {
        destDir = resolveAgentSessionCwd(ws.slug, newMeta.id)
        destStorageDir = getAgentSessionWorkspacePath(ws.slug, newMeta.id)
      }
    }

    // 4.5 将 SDK session JSONL 复制到 fork 自己的 project-hash 目录
    // SDK forkSession() 在源 cwd 的 project-hash 下创建 JSONL（如 projects/<hash-of-sourceDir>/<newId>.jsonl），
    // 但 fork 会话的 cwd 是新的 session 目录（不同 project-hash），resume 时 SDK 会找不到。
    // 这里直接将 JSONL 复制到 fork 目标 cwd 的 project-hash 下，让后续每轮 resume 都能直接命中。
    // 同时把 JSONL 内容中所有源目录路径改写为目标目录路径，避免历史中的绝对路径误导 Claude
    // 继续在源目录下读写文件。
    if (sourceDir && destDir) {
      // 复用 step 3.5 已确认的 JSONL 路径，避免重复扫描
      const destProjectHash = buildForkProjectKey(destDir)
      const sdkProjectsDir = join(getSdkConfigDir(), 'projects', destProjectHash)
      if (!existsSync(sdkProjectsDir)) mkdirSync(sdkProjectsDir, { recursive: true })
      const destJsonl = join(sdkProjectsDir, `${forkResult.sessionId}.jsonl`)
      copyForkFile(forkJsonlPath, destJsonl)
      rewritePathsInJsonlFile(destJsonl, sourceDir, destDir)
      console.log(`[Agent 会话] 已将 SDK session JSONL 复制到 fork 目标目录并改写路径: ${destJsonl}`)
    }

    // 5. 复制源会话工作区文件到新会话目录
    // 仅排除 .claude/（settings.json 启动时会重建）、.DS_Store、.git。
    // .context/ 必须保留 — Profer 约定 .context/note.md、todo.md、plan/ 等是会话上下文，
    // 如果不复制，fork 后这些参考资料会丢失或被 Claude 误回源目录读取。
    // 源/目标必须是 storageDir：project 下两个 cwd 相同，复制 cwd 等于 cpSync(项目根, 项目根)。
    if (sourceStorageDir && destStorageDir) {
      const copyResult = copyForkWorkspaceFiles(sourceStorageDir, destStorageDir)
      if (copyResult.failedCount > 0) {
        console.warn(`[Agent 会话] Claude fork 工作区有 ${copyResult.failedCount} 个条目未复制:`, copyResult.failedPaths)
      }
    }

    // 6. 复制截断后的 SDKMessages 到新会话的 JSONL（用于 UI 展示历史）
    // 同时改写消息中所有源目录绝对路径为目标目录路径 — 否则 Claude 在历史里看到的所有
    // Read/Edit/Bash 工具调用都指向源会话目录，会继续在源目录而非新 cwd 下操作文件。
    //
    // 注意：UI 截断点用原始 upToMessageUuid，保留用户实际看到的所有内容（包括 sub-agent
    // 过程消息），与 SDK forkSession 用 effectiveUpToMessageUuid（主线 uuid）解耦。
    const sourceMessages = getAgentSessionSDKMessages(sessionId)
    let messagesToCopy: SDKMessage[]

    if (upToMessageUuid) {
      const cutIndex = sourceMessages.findIndex(
        (m) => 'uuid' in m && (m as { uuid?: string }).uuid === upToMessageUuid,
      )
      messagesToCopy = cutIndex >= 0 ? sourceMessages.slice(0, cutIndex + 1) : sourceMessages
    } else {
      messagesToCopy = sourceMessages
    }

    if (sourceDir && destDir && messagesToCopy.length > 0) {
      messagesToCopy = messagesToCopy.map((m) => rewritePathsInSDKMessage(m, sourceDir, destDir!))
    }

    if (messagesToCopy.length > 0) {
      appendSDKMessages(newMeta.id, messagesToCopy)
    }

    // 7. 复制截断后的 Graph JSONL 到新会话
    // Graph 事件存储为 {sessionId}-graph.jsonl，fork 创建新 sessionId，
    // 不复制则新会话看不到 fork 点之前的任务图（表现：任务图空白/不跟随）。
    copyTruncatedGraphJsonl(sessionId, newMeta.id, upToMessageUuid, sourceMessages)
    copySettledPiHarnessEventsForFork(sessionId, newMeta.id, resolveForkTimestamp(upToMessageUuid, sourceMessages))

    console.log(`[Agent 会话] 分叉会话已创建（SDK 原生 fork）: ${sourceMeta.title} → ${forkTitle} (${messagesToCopy.length} 条消息, sdkSessionId=${forkResult.sessionId})`)
    return newMeta
  } catch (err) {
    // 回滚：删除已创建的 Profer 会话记录，避免孤儿条目
    console.error(`[Agent 会话] fork 关键步骤失败，回滚会话记录 (${newMeta.id}):`, err)
    try {
      await deleteAgentSession(newMeta.id)
    } catch (rollbackErr) {
      console.error(`[Agent 会话] fork 回滚失败:`, rollbackErr)
    }
    throw err
  }
}

/**
 * 将一段字符串中所有出现的 sourceDir 替换为 destDir。
 *
 * 用于 fork 会话时把历史中嵌入的源会话绝对路径迁移到新会话目录。
 * 处理 JSON 字符串中可能出现的两种编码形式：
 * 1. 原始路径（如 /Users/a/b）
 * 2. JSON 字符串编码后的形式（路径中的 `/` JSON 标准下不会转义，所以通常与 1 一致；
 *    但保留对反斜杠的处理以兼容 Windows 路径）
 *
 * sourceDir 和 destDir 都会规范化去除末尾斜杠，避免不同形式导致漏替换。
 */
function rewriteSourceToDest(content: string, sourceDir: string, destDir: string): string {
  const normalizedSource = sourceDir.replace(/[\\/]+$/, '')
  const normalizedDest = destDir.replace(/[\\/]+$/, '')
  if (!normalizedSource || normalizedSource === normalizedDest) return content
  let rewritten = content.split(normalizedSource).join(normalizedDest)
  // Windows 路径在 JSON 中会被转义为双反斜杠，单独处理一次
  if (normalizedSource.includes('\\')) {
    const sourceEscaped = normalizedSource.replace(/\\/g, '\\\\')
    const destEscaped = normalizedDest.replace(/\\/g, '\\\\')
    rewritten = rewritten.split(sourceEscaped).join(destEscaped)
  }
  return rewritten
}

/**
 * 改写 SDK JSONL 文件中所有出现的源目录路径为目标目录路径。
 *
 * 使用原子写入（临时文件 + rename）避免进程崩溃时截断 JSONL。
 * 文件不存在或读写失败时抛出异常，由调用方（forkAgentSession）统一回滚。
 */
function rewritePathsInJsonlFile(filePath: string, sourceDir: string, destDir: string): void {
  const content = readFileSync(filePath, 'utf-8')
  const rewritten = rewriteSourceToDest(content, sourceDir, destDir)
  if (rewritten !== content) {
    const tmpPath = filePath + '.tmp.' + Date.now()
    writeFileSync(tmpPath, rewritten, 'utf-8')
    renameForkFile(tmpPath, filePath)
  }
}

/**
 * 复制并截断 Graph JSONL 到 fork 会话。
 *
 * Graph 事件存储为 {sessionId}-graph.jsonl，fork 后新会话有新的 sessionId，
 * 如果不显式复制，新会话的 loadGraph() 找不到文件，任务图始终为空。
 *
 * 截断逻辑：以 fork 目标消息的 _createdAt 为截止时间戳，
 * 只复制该时间点之前的图事件，保证 fork 会话只看到 fork 点的任务状态。
 */
/** Resolve a branch boundary from the persisted display message timestamp. */
function resolveForkTimestamp(upToMessageUuid: string | undefined, sourceMessages: SDKMessage[]): number {
  if (!upToMessageUuid) return Date.now()
  const target = sourceMessages.find((message) => 'uuid' in message && (message as { uuid?: string }).uuid === upToMessageUuid) as (SDKMessage & { _createdAt?: unknown }) | undefined
  return typeof target?._createdAt === 'number' ? target._createdAt : Date.now()
}

function copyTruncatedGraphJsonl(
  sourceSessionId: string,
  destSessionId: string,
  upToMessageUuid: string | undefined,
  sourceMessages: SDKMessage[],
): void {
  try {
    const sourcePath = join(getAgentSessionsDir(), `${sourceSessionId}-graph.jsonl`)
    if (!existsSync(sourcePath)) return

    const graphContent = readFileSync(sourcePath, 'utf-8')
    const allEvents = parseEventsFromJsonl(graphContent)
    if (allEvents.length === 0) return

    // 确定 fork 截止时间戳：取 fork 目标消息的 _createdAt
    let forkTimestamp = Date.now()
    if (upToMessageUuid) {
      const targetMsg = sourceMessages.find(
        (m) => 'uuid' in m && (m as { uuid?: string }).uuid === upToMessageUuid,
      )
      if (targetMsg && typeof (targetMsg as Record<string, unknown>)._createdAt === 'number') {
        forkTimestamp = (targetMsg as Record<string, unknown>)._createdAt as number
      }
    }

    // 只保留 fork 点之前创建的图事件
    const truncatedEvents = allEvents.filter((e) => e.timestamp <= forkTimestamp)
    if (truncatedEvents.length === 0) return

    const destPath = join(getAgentSessionsDir(), `${destSessionId}-graph.jsonl`)
    const dir = dirname(destPath)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    const lines = truncatedEvents.map((e) => serializeEvent(e)).join('\n') + '\n'
    writeFileSync(destPath, lines, 'utf-8')
    console.log(
      `[Agent 会话] 已复制 Graph JSONL 到 fork 会话 ` +
      `(${truncatedEvents.length}/${allEvents.length} 个事件, 截止时间戳=${forkTimestamp})`,
    )
  } catch (err) {
    console.warn(`[Agent 会话] 复制 Graph JSONL 到 fork 会话失败:`, err)
  }
}

/**
 * 改写 SDKMessage 中所有嵌入的源目录路径为目标目录路径。
 *
 * 通过 JSON 序列化 → 字符串替换 → 反序列化实现深度替换，
 * 覆盖 user/assistant/tool_use/tool_result 等任意嵌套结构中的绝对路径字段。
 * 失败时返回原消息，保证 fork 整体不被打断。
 */
function rewritePathsInSDKMessage(msg: SDKMessage, sourceDir: string, destDir: string): SDKMessage {
  try {
    const json = JSON.stringify(msg)
    const rewritten = rewriteSourceToDest(json, sourceDir, destDir)
    if (rewritten === json) return msg
    return JSON.parse(rewritten) as SDKMessage
  } catch (err) {
    console.warn(`[Agent 会话] 改写 SDKMessage 路径失败，使用原消息:`, err)
    return msg
  }
}

/**
 * 截断 Agent 会话的 SDK 消息到指定 UUID（inclusive）
 *
 * 保留 uuid 匹配消息及之前的所有消息，删除之后的消息。
 * 通过 writeFileSync 全量重写 JSONL 文件。
 *
 * @returns 截断后保留的消息列表
 */
export function truncateSDKMessages(id: string, upToUuidInclusive: string): SDKMessage[] {
  const messages = getAgentSessionSDKMessages(id)
  const cutIndex = messages.findIndex(
    (m) => 'uuid' in m && (m as { uuid?: string }).uuid === upToUuidInclusive,
  )
  if (cutIndex < 0) {
    throw new Error(`[Agent 会话] 截断失败: 未找到 uuid=${upToUuidInclusive}, sessionId=${id}`)
  }
  const kept = messages.slice(0, cutIndex + 1)

  const filePath = getAgentSessionMessagesPath(id)
  const content = kept.map((m) => JSON.stringify(m)).join('\n') + (kept.length > 0 ? '\n' : '')
  writeFileSync(filePath, content, 'utf-8')

  console.log(`[Agent 会话] 消息已截断: sessionId=${id}, 保留 ${kept.length}/${messages.length} 条`)
  return kept
}

/** SDK session JSONL 中的「真实用户消息」：有 uuid 且不是 tool_result。 */
function isRealUserMessageInSdkJsonl(m: Record<string, unknown>): boolean {
  if (m.type !== 'user' || !m.uuid) return false
  const content = (m.message as { content?: Array<{ type: string }> } | undefined)?.content
  const hasToolResult = Array.isArray(content) && content.some((b) => b.type === 'tool_result')
  return !hasToolResult
}

/**
 * 清空会话的全部展示消息（保留会话本身、标题与元数据）。
 *
 * 与 `truncateSDKMessages` 的区别：这里没有可保留的锚点（首轮就失败），
 * 目标是空历史。写成空文件而不是删文件，保持“会话消息文件始终存在”的隐含约定。
 */
export function clearSDKMessages(id: string): SDKMessage[] {
  const filePath = getAgentSessionMessagesPath(id)
  const previousCount = getAgentSessionSDKMessages(id).length
  writeFileSync(filePath, '', 'utf-8')
  console.log(`[Agent 会话] 消息已清空: sessionId=${id}, 原有 ${previousCount} 条`)
  return []
}

/**
 * 从 SDK session JSONL 中查找指定 assistant message 之后最近的 user message UUID
 *
 * SDK session JSONL（~/.profer/sdk-config/projects/...）中的消息都带有 uuid，
 * 但 Profer 自己构造的 user message 没有 uuid。此函数直接读取 SDK 的 JSONL
 * 来解析 rewindFiles 所需的 user message UUID。
 *
 * 对于 fork 会话：Profer JSONL 中的 UUID 来自**源会话**（fork 时直接复制），
 * 而 forked SDK JSONL 中的 UUID 已被重映射。因此 fork 会话需要搜索**源**
 * SDK JSONL 来匹配 assistant UUID。通过 forkSourceSdkSessionId 参数指定。
 *
 * @param sdkSessionId SDK session UUID
 * @param assistantMessageUuid 要回退到的 assistant message UUID
 * @param projectDir SDK 项目目录路径（session 运行时的 cwd）
 * @param forkSourceSdkSessionId 源会话 SDK session ID（fork 会话时传入）
 * @returns user message UUID，找不到时返回 undefined
 */
export function resolveUserUuidFromSDK(
  sdkSessionId: string,
  assistantMessageUuid: string,
  projectDir?: string,
  forkSourceSdkSessionId?: string,
): string | undefined {
  // 优先搜索当前 session JSONL
  let sessionFilePath = findSdkSessionJsonl(sdkSessionId, projectDir)

  // 当前 session JSONL 中未找到 assistant UUID（作为消息 .uuid 字段）时，尝试源会话（fork 场景）
  let usingSourceSession = false
  if (sessionFilePath && forkSourceSdkSessionId) {
    try {
      const lines = readFileSync(sessionFilePath, 'utf-8').split('\n').filter(Boolean)
      const hasUuidAsField = lines.some((line) => {
        try {
          const m = JSON.parse(line)
          return m.uuid === assistantMessageUuid
        } catch { return false }
      })
      if (!hasUuidAsField) {
        // Profer JSONL 中的 UUID 来自源会话，forked JSONL 中已重映射
        const sourceFilePath = findSdkSessionJsonl(forkSourceSdkSessionId, projectDir)
        if (sourceFilePath) {
          console.log(`[Agent 会话] resolveUserUuid: fork 会话 UUID 不匹配（非 .uuid 字段），切换到源会话 ${forkSourceSdkSessionId}`)
          sessionFilePath = sourceFilePath
          usingSourceSession = true
        }
      }
    } catch { /* fall through to main logic */ }
  } else if (!sessionFilePath && forkSourceSdkSessionId) {
    // 当前 session JSONL 完全找不到，直接尝试源会话
    sessionFilePath = findSdkSessionJsonl(forkSourceSdkSessionId, projectDir)
    if (sessionFilePath) {
      usingSourceSession = true
      console.log(`[Agent 会话] resolveUserUuid: 当前 JSONL 未找到，使用源会话 ${forkSourceSdkSessionId}`)
    }
  }

  if (!sessionFilePath) {
    console.warn(`[Agent 会话] 未找到 SDK session JSONL: sdkSessionId=${sdkSessionId}`)
    return undefined
  }

  // 读取并解析 SDK JSONL
  try {
    const lines = readFileSync(sessionFilePath, 'utf-8').split('\n').filter(Boolean)
    const messages = lines.map((l) => JSON.parse(l) as Record<string, unknown>)

    // 找到 assistant message 的位置
    const assistantIdx = messages.findIndex((m) => m.uuid === assistantMessageUuid)
    if (assistantIdx < 0) {
      console.warn(`[Agent 会话] SDK JSONL 中未找到 assistant uuid=${assistantMessageUuid}${usingSourceSession ? ' (源会话)' : ''}`)
      return undefined
    }

    // rewindFiles(userMessageId) 恢复文件到该 user message 发送时的快照状态。
    // 回退到某个 assistant turn = 恢复到"该 turn 完成后"的文件状态
    // = 下一轮用户消息发送时的快照（因为快照记录的是 user 消息发出时的文件状态，
    //   而 assistant turn 完成后到下一条 user 消息之间没有其他文件变化）。
    //
    // 策略：向后找第一条非 tool_result 的 user message。
    // 如果找不到（最后一个 turn），返回 '__LAST_TURN__' 特殊标记 —— 因为当前文件系统
    // 已经是最后一个 turn 完成后的状态，不需要文件回退。

    const isRealUserMessage = isRealUserMessageInSdkJsonl

    // 向后找下一条真实 user message
    for (let i = assistantIdx + 1; i < messages.length; i++) {
      const m = messages[i]!
      if (isRealUserMessage(m)) {
        console.log(`[Agent 会话] 解析到下一轮 user uuid=${m.uuid} (assistant uuid=${assistantMessageUuid}${usingSourceSession ? ', 源会话' : ''})`)
        return m.uuid as string
      }
    }

    // 最后一个 turn — 当前文件系统已是该 turn 完成后的状态，无需文件回退
    console.log(`[Agent 会话] 最后一个 turn，无需文件回退 (assistant uuid=${assistantMessageUuid})`)
    return '__LAST_TURN__'
  } catch (err) {
    console.warn(`[Agent 会话] 读取 SDK session JSONL 失败:`, err)
    return undefined
  }
}

/**
 * 从 SDK session JSONL 中查找**第一条**真实用户消息的 UUID。
 *
 * 用于「清空对话」时的文件恢复：快照记录的是 user 消息发出时的文件状态，
 * 恢复到第一条用户消息的快照 = 回到会话起点（第一个 turn 执行前）的状态。
 *
 * 与 `resolveUserUuidFromSDK` 一样兼顾 fork：fork 会话自己的 JSONL 已复制了前缀，
 * 因此先查本会话，再回退到源会话。找不到时返回 undefined（调用方明确降级提示）。
 */
export function resolveFirstUserUuidFromSDK(
  sdkSessionId: string,
  projectDir?: string,
  forkSourceSdkSessionId?: string,
): string | undefined {
  const candidates = [sdkSessionId, forkSourceSdkSessionId]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
  for (const candidate of candidates) {
    const sessionFilePath = findSdkSessionJsonl(candidate, projectDir)
    if (!sessionFilePath) continue
    try {
      const lines = readFileSync(sessionFilePath, 'utf-8').split('\n').filter(Boolean)
      for (const line of lines) {
        let message: Record<string, unknown>
        try {
          message = JSON.parse(line) as Record<string, unknown>
        } catch {
          continue
        }
        if (isRealUserMessageInSdkJsonl(message)) {
          console.log(`[Agent 会话] 解析到首条 user uuid=${String(message.uuid)} (sdkSessionId=${candidate})`)
          return message.uuid as string
        }
      }
    } catch (err) {
      console.warn('[Agent 会话] 读取 SDK session JSONL 失败:', err)
    }
  }
  console.warn(`[Agent 会话] 未找到首条 user message UUID: sdkSessionId=${sdkSessionId}`)
  return undefined
}

/**
 * 清空整段对话（Claude 路径）：首轮就失败、没有可保留锚点时使用。
 *
 * 1. 文件恢复到**第一条用户消息**的快照 = 会话起点（第一个 turn 执行前）
 * 2. 清空 Profer 展示 JSONL
 * 3. 同时清掉 `sdkSessionId`：否则下一轮仍会 resume 出已被清空的那段对话；
 *    没有 sdkSessionId 时编排层会走「上下文回填」路径，而历史已空，即真正从头开始。
 *
 * 文件恢复失败时仍然清空对话（优雅降级，结果里带上原因），
 * 不能让快照问题把用户卡在“既清不掉也重来不了”的状态。
 */
export function resetClaudeSession(sessionId: string, sessionMeta: AgentSessionMeta): RewindSessionResult {
  // 两种路径语义不能混用（P1-1）：storageDir 用于定位会话私有数据；
  // cwd 是快照相对路径的基准 + 允许写入根，project 下必须是项目根。
  let storageDir: string | undefined
  let rewindCwd: string | undefined
  let workspaceSlug: string | undefined
  if (sessionMeta.workspaceId) {
    const ws = getAgentWorkspace(sessionMeta.workspaceId)
    if (ws) {
      workspaceSlug = ws.slug
      storageDir = getAgentSessionWorkspacePath(ws.slug, sessionMeta.id)
      try {
        rewindCwd = resolveAgentSessionCwd(ws.slug, sessionMeta.id)
      } catch (error) {
        // 项目目录已不可用：只降级文件恢复，绝不回落到用户主目录写入。
        console.warn(`[Agent 会话] 清空对话: 无法解析会话 cwd，将跳过文件恢复: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  let fileRewind: RewindSessionResult['fileRewind']
  const firstUserUuid = sessionMeta.sdkSessionId
    ? resolveFirstUserUuidFromSDK(sessionMeta.sdkSessionId, storageDir, sessionMeta.forkSourceSdkSessionId)
    : undefined
  if (!sessionMeta.sdkSessionId) {
    console.log(`[Agent 会话] 清空对话: 会话还没有 SDK session，跳过文件恢复 (sessionId=${sessionId})`)
    fileRewind = { canRewind: false, error: '会话还没有 SDK session，文件未回退' }
  } else if (!firstUserUuid) {
    fileRewind = { canRewind: false, error: '无法从 SDK session 中解析首条 user message UUID' }
  } else {
    try {
      // 快照相对路径基准：project 下是项目根，managed 下是会话目录。
      // 会话有 workspaceId 但 cwd 解析不到时明确降级，绝不以用户主目录为 cwd。
      const cwd = rewindCwd ?? (sessionMeta.workspaceId ? undefined : homedir())
      if (!cwd) throw new Error('项目目录不可用，文件未回退')
      const rewindAttachedDirs = collectAttachedDirectories({ sessionMeta, workspaceSlug })
      console.log(`[Agent 会话] 清空对话: 从首条 user 快照恢复文件 (cwd=${cwd}, attachedDirs=${rewindAttachedDirs.length})`)
      fileRewind = rewindFilesFromSnapshot(
        sessionMeta.sdkSessionId,
        firstUserUuid,
        cwd,
        storageDir,
        sessionMeta.forkSourceSdkSessionId,
        rewindAttachedDirs,
      )
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      console.warn('[Agent 会话] 文件恢复失败，继续清空对话:', errMsg)
      fileRewind = { canRewind: false, error: errMsg }
    }
  }

  const kept = clearSDKMessages(sessionId)
  updateAgentSessionMeta(sessionId, {
    resumeAtMessageUuid: undefined,
    sdkSessionId: undefined,
  })

  console.log(`[Agent 会话] 对话已清空: sessionId=${sessionId}, 文件恢复=${fileRewind?.canRewind ?? '跳过'}`)

  return {
    remainingMessages: kept.length,
    fileRewind,
  }
}

/**
 * 在 SDK 项目目录中查找指定 session 的 JSONL 文件。
 *
 * @param sdkSessionId SDK session ID
 * @param _projectDir 历史参数：SDK 的目录命名规则与 Profer 不一致，这里改为遍历全部项目目录，
 *   因此**忽略**该参数（保留签名只为兼容调用方；不要再把它当 cwd 使用）
 * @returns JSONL 文件路径，找不到返回 undefined
 */
function findSdkSessionJsonl(sdkSessionId: string, _projectDir?: string): string | undefined {
  const sdkConfigDir = getSdkConfigDir()

  // 遍历所有项目目录查找匹配的 session JSONL
  // （SDK 的目录命名规则与 Profer 不完全一致，直接遍历最可靠）
  const projectsDir = join(sdkConfigDir, 'projects')
  if (existsSync(projectsDir)) {
    for (const dir of readdirSync(projectsDir)) {
      const candidate = join(projectsDir, dir, `${sdkSessionId}.jsonl`)
      if (existsSync(candidate)) return candidate
    }
  }

  return undefined
}

/**
 * 直接从 SDK JSONL 的 file-history-snapshot 恢复文件到指定 user message 时的状态。
 *
 * 绕过 SDK 的 rewindFiles API（避免分支加载问题），直接：
 * 1. 读取 SDK JSONL 中的所有 file-history-snapshot
 * 2. 构建目标 user message 时的文件状态表
 * 3. 从 file-history 备份目录恢复文件
 *
 * 对于 fork 出的会话：resolveUserUuidFromSDK 已从源 SDK JSONL 解析出源空间的 user UUID，
 * 因此 userMessageUuid 可能在源 JSONL 中而非 forked JSONL 中。当在当前 JSONL 中找不到
 * 目标 UUID 时，自动 fallback 到源会话的 JSONL 和 file-history 备份。
 *
 * @param sdkSessionId  SDK session ID
 * @param userMessageUuid  目标 user message UUID（恢复到此时的文件状态）
 * @param cwd  会话工作目录（文件的基准路径）
 * @param projectDir  项目目录（可选，用于定位 SDK JSONL）
 * @param forkSourceSdkSessionId  源会话 SDK session ID（可选，fork 会话回退时使用）
 * @param attachedDirectories  附加的外部目录列表（绝对路径，SDK 会将这些目录下的文件以绝对路径记录在 snapshot 中）
 */
export function rewindFilesFromSnapshot(
  sdkSessionId: string,
  userMessageUuid: string,
  cwd: string,
  projectDir?: string,
  forkSourceSdkSessionId?: string,
  attachedDirectories?: string[],
): { canRewind: boolean; error?: string; filesChanged?: string[]; insertions?: number; deletions?: number } {
  const sdkConfigDir = getSdkConfigDir()

  // 1. 查找 SDK session JSONL（优先当前 session，找不到目标 UUID 时 fallback 到源会话）
  let sessionFilePath = findSdkSessionJsonl(sdkSessionId, projectDir)
  let effectiveSdkSessionId = sdkSessionId
  let isForkFallback = false

  // 2. 读取所有消息，构建到目标 user message 为止的文件状态
  try {
    let messages: Record<string, unknown>[] = []
    if (sessionFilePath) {
      const lines = readFileSync(sessionFilePath, 'utf-8').split('\n').filter(Boolean)
      messages = lines.map((l) => JSON.parse(l) as Record<string, unknown>)
    }

    // 找到目标 user message 的位置
    let targetIdx = messages.findIndex((m) => m.uuid === userMessageUuid)

    // Fork 场景：userMessageUuid 来自源会话（resolveUserUuidFromSDK 已做过 fallback），
    // 在 forked JSONL 中找不到 → 直接切换到源会话 JSONL
    if (targetIdx < 0 && forkSourceSdkSessionId) {
      console.log(`[Agent 会话] rewindFilesFromSnapshot: 目标 UUID 在当前 JSONL 中未找到，切换到源会话 ${forkSourceSdkSessionId}`)
      const sourceFilePath = findSdkSessionJsonl(forkSourceSdkSessionId, projectDir)
      if (!sourceFilePath) {
        return { canRewind: false, error: '未找到源会话 SDK session JSONL（fork 回退需要源会话数据）' }
      }
      const sourceLines = readFileSync(sourceFilePath, 'utf-8').split('\n').filter(Boolean)
      messages = sourceLines.map((l) => JSON.parse(l) as Record<string, unknown>)
      targetIdx = messages.findIndex((m) => m.uuid === userMessageUuid)
      effectiveSdkSessionId = forkSourceSdkSessionId
      isForkFallback = true

      if (targetIdx < 0) {
        return { canRewind: false, error: `源会话 SDK JSONL 中也未找到 user message uuid=${userMessageUuid}` }
      }
      console.log(`[Agent 会话] rewindFilesFromSnapshot: 在源会话中找到目标 UUID (idx=${targetIdx})`)
    } else if (targetIdx < 0) {
      return { canRewind: false, error: `SDK JSONL 中未找到 user message uuid=${userMessageUuid}` }
    }

    // 查找目标 user message 对应的 snapshot（isSnapshotUpdate: false 且 messageId 匹配）
    // SDK 的 file-history-snapshot 有两种：
    // - isSnapshotUpdate: false — user message 发出时的完整文件追踪状态
    // - isSnapshotUpdate: true — assistant 工具修改文件前的增量备份
    // 只使用 user message snapshot 来构建目标时刻的文件状态。
    const fileState = new Map<string, string | null>()
    let targetSnapshotFound = false

    for (const m of messages) {
      if (m.type !== 'file-history-snapshot') continue
      if (m.isSnapshotUpdate) continue
      const snapshot = m.snapshot as {
        messageId?: string
        trackedFileBackups?: Record<string, { backupFileName: string | null }>
      } | undefined
      if (snapshot?.messageId === userMessageUuid && snapshot.trackedFileBackups) {
        for (const [filePath, info] of Object.entries(snapshot.trackedFileBackups)) {
          fileState.set(filePath, info.backupFileName)
        }
        targetSnapshotFound = true
      }
    }

    // 同时收集 target snapshot 对应的增量更新（isSnapshotUpdate: true 且 snapshot.messageId 匹配）
    // 这些记录了 target user message 那轮 assistant 操作前的文件备份
    if (targetSnapshotFound) {
      for (const m of messages) {
        if (m.type !== 'file-history-snapshot' || !m.isSnapshotUpdate) continue
        const snapshot = m.snapshot as {
          messageId?: string
          trackedFileBackups?: Record<string, { backupFileName: string | null }>
        } | undefined
        if (snapshot?.messageId === userMessageUuid && snapshot.trackedFileBackups) {
          // 增量更新可能记录了更多被追踪的文件，但不覆盖已有状态
          for (const [filePath, info] of Object.entries(snapshot.trackedFileBackups)) {
            if (!fileState.has(filePath)) {
              fileState.set(filePath, info.backupFileName)
            }
          }
        }
      }
    }

    // 处理 target 之后新创建的文件（它们在 target 时不存在，需要删除）
    for (let i = targetIdx + 1; i < messages.length; i++) {
      const m = messages[i]!
      if (m.type !== 'file-history-snapshot') continue

      const snapshot = m.snapshot as {
        trackedFileBackups?: Record<string, { backupFileName: string | null }>
      } | undefined
      if (!snapshot?.trackedFileBackups) continue

      for (const [filePath, info] of Object.entries(snapshot.trackedFileBackups)) {
        // 如果这个文件在 target 时不存在（没被追踪），且 backupFileName 为 null（新创建的），标记删除
        if (!fileState.has(filePath) && info.backupFileName === null) {
          fileState.set(filePath, null) // null = 文件应该不存在
        }
      }
    }

    if (fileState.size === 0) {
      if (!targetSnapshotFound) {
        console.log(`[Agent 会话] rewindFilesFromSnapshot: 目标消息无文件快照记录`)
        return { canRewind: false, error: '目标消息无文件快照记录（会话可能在启用文件检查点前创建）' }
      }
      console.log(`[Agent 会话] rewindFilesFromSnapshot: 快照存在但无文件变化`)
      return { canRewind: true, filesChanged: [] }
    }

    // 3. 恢复文件（fork 会话使用源会话的 file-history 备份）
    const fileHistoryDir = join(sdkConfigDir, 'file-history', effectiveSdkSessionId)
    const filesChanged: string[] = []

    const resolvedCwd = resolve(cwd)
    // 预计算允许写入的目录列表（cwd + attachedDirectories）
    const allowedDirs = [resolvedCwd, ...(attachedDirectories || []).map((d) => resolve(d))]

    for (const [filePath, backupFileName] of fileState) {
      // SDK 对 cwd 内文件使用相对路径，对 additionalDirectories 内文件使用绝对路径
      const isAbsolute = filePath.startsWith('/')
      const fullPath = isAbsolute ? resolve(filePath) : resolve(cwd, filePath)

      // 路径安全检查：文件必须位于 cwd 或 attachedDirectories 之内
      const isInAllowedDir = allowedDirs.some((dir) => fullPath.startsWith(dir + '/') || fullPath === dir)
      if (!isInAllowedDir) {
        console.warn(`[Agent 会话] rewindFiles: 拒绝路径越界 ${filePath}`)
        continue
      }

      if (backupFileName === null) {
        // 文件在 target 时不存在 → 删除
        if (existsSync(fullPath)) {
          try {
            unlinkSync(fullPath)
            filesChanged.push(filePath)
            console.log(`[Agent 会话] rewindFiles: 删除 ${filePath}`)
          } catch (err) {
            console.warn(`[Agent 会话] rewindFiles: 删除失败 ${filePath}:`, err)
          }
        }
      } else {
        // 文件在 target 时存在 → 用备份恢复
        const backupPath = resolve(fileHistoryDir, backupFileName)
        // backupPath 越界检查
        if (!backupPath.startsWith(resolve(fileHistoryDir) + '/') && backupPath !== resolve(fileHistoryDir)) {
          console.warn(`[Agent 会话] rewindFiles: 拒绝备份路径越界 ${backupFileName}`)
          continue
        }
        if (!existsSync(backupPath)) {
          console.warn(`[Agent 会话] rewindFiles: 备份文件不存在 ${backupPath}`)
          continue
        }
        try {
          const backupContent = readFileSync(backupPath)
          // 确保目录存在
          const dir = dirname(fullPath)
          if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
          writeFileSync(fullPath, backupContent)
          filesChanged.push(filePath)
          console.log(`[Agent 会话] rewindFiles: 恢复 ${filePath} ← ${backupFileName}${isForkFallback ? ' (from source session)' : ''}`)
        } catch (err) {
          console.warn(`[Agent 会话] rewindFiles: 恢复失败 ${filePath}:`, err)
        }
      }
    }

    console.log(`[Agent 会话] rewindFilesFromSnapshot 完成: ${filesChanged.length} 个文件已恢复${isForkFallback ? ' (fork fallback)' : ''}`)
    return { canRewind: true, filesChanged }
  } catch (err) {
    return { canRewind: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * 每个工作区默认保留的最近会话数。
 *
 * 这些会话是「保留名额」，不参与超时归档；用 0 可关闭名额（回到纯时间阈值）。
 */
export const DEFAULT_ARCHIVE_KEEP_PER_WORKSPACE = 3

/** 任务图中仍视为「未完成」的节点状态。 */
const UNFINISHED_TASK_STATUSES = new Set<string>(['pending', 'in_progress'])

/**
 * 会话是否存在未完成的任务图节点。
 *
 * 读不到/解析失败时按「有未完成」处理：宁可少归档一个，也不要把仍在推进的
 * 会话从侧栏里送走。损坏的任务图留给用户手动归档兜底。
 */
function hasUnfinishedTaskGraph(sessionId: string): boolean {
  const graphPath = getAgentSessionGraphPath(sessionId)
  if (!existsSync(graphPath)) return false
  try {
    const graph = buildGraphFromEvents(parseEventsFromJsonl(readFileSync(graphPath, 'utf-8')))
    return Object.values(graph.nodes).some((node) => UNFINISHED_TASK_STATUSES.has(node.status))
  } catch (error) {
    console.warn(`[Agent 会话] 读取任务图失败，跳过归档 (${sessionId}):`, error)
    return true
  }
}

/**
 * 是否计入「工作区保留名额」。
 *
 * 只统计用户亲手开的顶层会话。定时任务会话、委派子会话和探索分支是系统产物，
 * 数量由运行策略决定；让它们挤占名额会把用户真正在用的会话顶出保护位。
 * 这些会话仍按时间阈值归档，行为与旧版一致。
 */
function isQuotaAccountedSession(session: AgentSessionMeta): boolean {
  return !session.draft
    && !session.parentSessionId
    && !session.rootSessionId
    && !session.sourceAutomationId
    && !session.sourceDelegationId
    && !session.explorationParentSessionId
}

/**
 * 自动归档超过指定天数未更新的 Agent 会话
 *
 * 两级保护：
 * 1. 保留名额：每个工作区按最后活跃时间保留最近 `keepRecentPerWorkspace` 个会话，
 *    这些会话不参与超时归档（0 表示关闭名额保护）。
 * 2. 逐条豁免：置顶、草稿、运行中/分叉中、任务图仍有未完成节点（pending / in_progress）。
 *
 * 保留名额只覆盖「仅超出天数」这一种淘汰；会话必须同时满足「超出天数 + 无豁免」
 * 才归档，不会因为新建了第 N+1 个会话就把当天还在用的旧会话送走。
 *
 * @param daysThreshold 天数阈值
 * @param keepRecentPerWorkspace 每个工作区保留的最近会话数，0 = 不保留
 * @returns 本次归档的会话数量
 */
export function autoArchiveAgentSessions(
  daysThreshold: number,
  keepRecentPerWorkspace = 0,
): number {
  const index = readIndex()
  // 兜底：非正数阈值意味着「立刻全部归档」，调用方误传时直接不做事。
  if (!Number.isFinite(daysThreshold) || daysThreshold <= 0) return 0
  const threshold = Date.now() - daysThreshold * 86_400_000
  const keepCount = Number.isFinite(keepRecentPerWorkspace)
    ? Math.max(0, Math.floor(keepRecentPerWorkspace))
    : 0

  // 先算出各工作区的保留名单，再统一扫描：保留判定与归档判定分开，
  // 避免扫描顺序影响结果（同一工作区里被后处理的会话不应改变前者的名额）。
  const retainedSessionIds = new Set<string>()
  if (keepCount > 0) {
    const byWorkspace = new Map<string, AgentSessionMeta[]>()
    for (const session of index.sessions) {
      if (session.archived || !isQuotaAccountedSession(session)) continue
      const key = session.workspaceId ?? ''
      const bucket = byWorkspace.get(key)
      if (bucket) bucket.push(session)
      else byWorkspace.set(key, [session])
    }
    for (const bucket of byWorkspace.values()) {
      bucket.sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt)
      for (const session of bucket.slice(0, keepCount)) retainedSessionIds.add(session.id)
    }
  }

  let count = 0
  for (const session of index.sessions) {
    // 置顶豁免只对可置顶的根会话生效：子会话（委派 / 探索分支）不参与置顶，
    // 历史残留的 pinned 字段不能让它们永久逃过自动归档。
    const pinnedExempt = !!session.pinned && !session.parentSessionId && !session.explorationParentSessionId
    if (session.archived || pinnedExempt || session.draft) continue
    if (retainedSessionIds.has(session.id)) continue
    // 时间阈值放在前面：只有真正超时的会话才会触发昂贵的任务图读取。
    if (session.updatedAt >= threshold) continue
    if (agentSessionActiveChecker?.(session.id) || isAgentSessionForking(session.id)) continue
    if (hasUnfinishedTaskGraph(session.id)) continue
    session.archived = true
    count++
  }

  if (count > 0) {
    writeIndex(index)
    console.log(
      `[Agent 会话] 自动归档 ${count} 个会话（阈值: ${daysThreshold} 天，每工作区保留: ${keepCount}）`,
    )
  }

  return count
}

/**
 * 清理所有会话中不存在的附加目录和附加文件
 * @returns 清理的条目总数
 */
export function cleanupStaleAttachedPaths(): number {
  const index = readIndex()
  let count = 0

  // 附加路径清理属于启动维护，不是用户对会话内容的更新。
  // 保留 updatedAt，避免旧会话被批量顶到侧栏最前并显示成“刚刚”。
  for (const session of index.sessions) {
    if (session.attachedDirectories?.length) {
      const valid = session.attachedDirectories.filter((d) => existsSync(d))
      if (valid.length < session.attachedDirectories.length) {
        count += session.attachedDirectories.length - valid.length
        session.attachedDirectories = valid.length > 0 ? valid : undefined
      }
    }

    if (session.attachedFiles?.length) {
      const valid = session.attachedFiles.filter((f) => existsSync(f))
      if (valid.length < session.attachedFiles.length) {
        count += session.attachedFiles.length - valid.length
        session.attachedFiles = valid.length > 0 ? valid : undefined
      }
    }
  }

  if (count > 0) {
    writeIndex(index)
    console.log(`[Agent 会话] 清理了 ${count} 个不存在的附加路径`)
  }

  return count
}

/**
 *
 * 按行流式读取每个会话的 JSONL 文件，命中即早退。兼容旧 AgentMessage 和新 SDKMessage 格式。
 * 每个会话最多返回 1 条匹配，总计达到 maxResults 即停止扫描后续会话。
 *
 * @param query 搜索关键词
 * @returns 匹配结果列表
 */
export async function searchAgentSessionMessages(query: string): Promise<AgentMessageSearchResult[]> {
  if (!query || query.length < 2) return []

  const index = readIndex()
  const results: AgentMessageSearchResult[] = []
  const queryLower = query.toLowerCase()
  const maxResults = 30

  for (const session of index.sessions) {
    if (results.length >= maxResults) break
    if (session.draft) continue

    const filePath = getAgentSessionMessagesPath(session.id)
    if (!existsSync(filePath)) continue

    const hit = await findFirstMatchInAgentJsonl(filePath, queryLower, query.length)
    if (hit) {
      results.push({
        sessionId: session.id,
        sessionTitle: session.title,
        messageId: hit.messageId,
        role: hit.role,
        ...(hit.author ? { author: hit.author } : {}),
        ...(hit.provenance ? { provenance: hit.provenance } : {}),
        snippet: hit.snippet,
        matchStart: hit.matchStart,
        matchLength: query.length,
        archived: session.archived,
      })
    }
  }

  return results
}

/**
 * 在单个 Agent 会话 JSONL 中按行流式查找第一条匹配。
 *
 * Agent 消息存在两种历史格式（旧 AgentMessage 与新 SDKMessage），都要兼容。
 */
async function findFirstMatchInAgentJsonl(
  filePath: string,
  queryLower: string,
  queryLength: number
): Promise<import('./agent-session-search').AgentJsonlMatch | null> {
  const stream = createReadStream(filePath, { encoding: 'utf-8' })
  const rl = createInterface({ input: stream, crlfDelay: Infinity })

  try {
    for await (const line of rl) {
      const hit = matchAgentJsonlLine(line, queryLower, queryLength)
      if (hit) return hit
    }
    return null
  } finally {
    rl.close()
    stream.destroy()
  }
}

function findSessionMessageSnippet(sessionId: string, query: string): string | undefined {
  if (!query || query.length < 2) return undefined

  const filePath = getAgentSessionMessagesPath(sessionId)
  if (!existsSync(filePath)) return undefined

  const queryLower = query.toLowerCase()
  try {
    const raw = readFileSync(filePath, 'utf-8')
    const lines = raw.split('\n').filter((line) => line.trim())

    for (const line of lines) {
      const textContent = extractTextFromPersistedMessage(JSON.parse(line))
      if (!textContent) continue

      const matchIndex = textContent.toLowerCase().indexOf(queryLower)
      if (matchIndex === -1) continue

      return createSnippet(textContent, matchIndex, query.length)
    }
  } catch {
    return undefined
  }

  return undefined
}

/**
 * 搜索当前工作区可引用的 Agent 会话。
 *
 * 仅返回当前工作区、未归档、非当前会话的结果；无关键词时返回最近更新的会话。
 */
export function searchAgentSessionReferences(input: AgentSessionReferenceSearchInput): AgentSessionReferenceSearchResult[] {
  const workspaceId = input?.workspaceId?.trim()
  if (!workspaceId) return []

  const query = (input?.query ?? '').trim()
  const queryLower = query.toLowerCase()
  const requestedLimit = Number.isFinite(input?.limit) ? input.limit! : 20
  const limit = Math.min(Math.max(requestedLimit, 1), 50)

  const candidates = listAgentSessions()
    .filter((session) => session.workspaceId === workspaceId)
    .filter((session) => !session.archived)
    .filter((session) => !session.draft)
    .filter((session) => session.id !== input?.excludeSessionId)

  const results: AgentSessionReferenceSearchResult[] = []

  for (const session of candidates) {
    if (results.length >= limit) break

    if (!queryLower) {
      results.push({
        sessionId: session.id,
        title: session.title,
        updatedAt: session.updatedAt,
        matchSource: 'recent',
      })
      continue
    }

    if (session.title.toLowerCase().includes(queryLower)) {
      results.push({
        sessionId: session.id,
        title: session.title,
        updatedAt: session.updatedAt,
        matchSource: 'title',
      })
      continue
    }

    const snippet = findSessionMessageSnippet(session.id, query)
    if (snippet) {
      results.push({
        sessionId: session.id,
        title: session.title,
        updatedAt: session.updatedAt,
        snippet,
        matchSource: 'message',
      })
    }
  }

  return results
}

/**
 * 按完整 turn 边界对会话消息做惰性分页（供移动端传输层懒加载）。
 *
 * 为什么按 turn 而非严格条数：渲染层 groupIntoTurns 依赖完整消息序列判定组边界
 * （assistant + user(tool_result) 会跨多条合成一个 turn）。若在中途硬切，客户端分组
 * 会断层/重复。因此：先按目标条数切出近似窗口，再将窗口起点向前扩展到所属用户输入
 * 边界，保证每页都是若干完整的用户输入起始的 turn。
 *
 * 首帧与续页统一算法：
 *   tailExclusive = before ?? total
 *   startRaw       = max(0, tailExclusive - targetMessages)
 *   start          = startRaw 向前扩展到所属 turn 的 user-input 边界
 *   page           = messages[start, tailExclusive)
 *   hasMore        = start > 0
 *
 * @param messages 完整有序 SDKMessage 数组（getAgentSessionSDKMessages 结果）
 * @param opts.before 游标：只取索引 < before 的更早消息。缺省 = 取最新窗口（会话尾部）。
 *                    移动端拿到某页 startIndex 后，补更早时传 before = 该 startIndex。
 * @param opts.targetMessages 近似条数（缺省 10）。切出约这么多条后向前补到完整 turn 边界。
 */
export interface SDKMessagePage {
  messages: SDKMessage[]
  total: number
  startIndex: number
  endIndex: number
  hasMore: boolean
}

export interface PaginateSDKMessagesOptions {
  before?: number
  targetMessages?: number
}

export function paginateSDKMessages(
  messages: SDKMessage[],
  opts: PaginateSDKMessagesOptions = {},
): SDKMessagePage {
  const { before, targetMessages = 10 } = opts
  const total = messages.length
  if (total === 0) {
    return { messages: [], total: 0, startIndex: 0, endIndex: -1, hasMore: false }
  }

  // 尾部上界（exclusive）
  const tailExclusive =
    before !== undefined && before >= 0 && before <= total ? before : total

  // 统一切窗口起点的原始位置（首帧取最新 N 条；续页取 before 前 N 条）
  let startIndex = Math.max(0, tailExclusive - targetMessages)
  // 向前扩展到本页所属 turn 的 user-input 边界。原先向后跳到下一条用户输入会
  // 永久丢弃 startRaw 与该输入之间的 assistant/tool 事件，且会使上划历史的页间出现缺口。
  // 若该页开头属于会话最早的无 user 前缀，保持从 0 开始，保证所有持久化事件可达。
  for (let i = startIndex; i > 0; i--) {
    const msg = messages[i]
    if (msg && msg.type === 'user' && isUserInputMessage(msg as SDKUserMessage)) {
      startIndex = i
      break
    }
    if (i === 1) startIndex = 0
  }

  return {
    messages: messages.slice(startIndex, tailExclusive),
    total,
    startIndex,
    endIndex: tailExclusive - 1,
    hasMore: startIndex > 0,
  }
}
