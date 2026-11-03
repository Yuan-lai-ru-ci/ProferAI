/**
 * 数据迁移服务
 *
 * 两种导出模式：
 * - personal (.profer-backup)：本机全量备份。除会话/Skills/MCP/渠道外，还包含
 *   会话外置原文（blobs）、规划与日程、自动化、预设、全局 Skills、插件/皮肤/资料库、
 *   附件、工作区文件与记忆；可选口令加密（AES-256-GCM，见 backup-crypto），
 *   不加密时渠道 API Key 以明文存于 zip 中。
 * - share (.profer-share)：团队分发，自由选择组件，凭据自动剥离。
 *
 * 打包/解包一律流式（zip-stream-writer / zip-stream-reader）：备份体量可达数 GB，
 * adm-zip 的全内存模式会顶到主进程内存上限。日志、缓存、回滚检查点、依赖目录不备份。
 *
 * 导出进度按「已写入字节 / 预估总量」上报，经 IPC 事件驱动设置页进度条。
 * 导入时自动检测跨平台差异并提示用户处理路径映射。
 */

import { createReadStream, existsSync, mkdirSync, cpSync, readFileSync, writeFileSync, readdirSync, rmSync, statSync, type Dirent } from 'node:fs'
import { promises as fsp } from 'node:fs'
import { join, resolve, relative, dirname, basename, isAbsolute, sep, win32, posix } from 'node:path'
import { homedir, platform, arch, tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import { safeStorage } from 'electron'
import {
  getConfigDir,
  getChannelsPath,
  getConversationsIndexPath,
  getConversationsDir,
  getConversationMessagesPath,
  getAgentSessionsIndexPath,
  getAgentSessionsDir,
  getAgentSessionMessagesPath,
  getAgentWorkspacePath,
  getAgentSessionWorkspacePath,
  getWorkspaceMcpPath,
  getWorkspaceSkillsDir,
  getInactiveSkillsDir,
  getWorkspaceSkillOverridesPath,
  getSettingsPath,
  getUserProfilePath,
  getChatToolsConfigPath,
  getSdkConfigDir,
  getAutomationsPath,
  getAgentPresetsPath,
  getSystemPromptsPath,
  getBrowserStartPagePath,
  getRecommendationsPath,
  getPluginsIndexPath,
  getPluginsDir,
  getScratchPadPath,
  getGlobalSkillsDir,
  getWorkspaceAgentPresetsPath,
  getWorkspaceFilesDir,
  resolveAgentSessionWorkspacePath,
  getPlanningDatabasePath,
  getWeChatConfigPath,
  getDingTalkConfigPath,
  getFeishuConfigPath,
} from './config-paths'
import { listAgentWorkspaces, getAgentWorkspace, getAllWorkspaceSkills, getWorkspaceMcpConfig } from './agent-workspace-manager'
import { listChannels, decryptApiKey } from './channel-manager'
import { readSessionBlobRefs } from '@profer/shared'
import type { AgentWorkspace } from '@profer/shared'
import { writeJsonFileAtomic } from './safe-file'
import { assertSafeSkillSegment } from './skill-path-security'
import { copySkillDirectorySafely } from './global-skill-manager'
import { blobPathFor, blobRootDir } from './blob-store'
import { ZipStreamWriter } from './zip-stream-writer'
import { isSessionDeletionPending } from './agent-session-deletion-queue'
import {
  EXPORTED_PI_STATE_ENTRY,
  mergePiStatesForImport,
  pickPiStatesForExport,
  readExportedPiState,
  splitInlinePiState,
} from './session-index-pi-state-export'
import { extractZipEntries, readZipEntries } from './zip-stream-reader'
import {
  assertPassphrase,
  decryptBackupFile,
  encryptBackupFile,
  isEncryptedBackup,
} from './backup-crypto'

// ─── 类型定义 ────────────────────────────────────────────────────────────────

export type MigrationMode = 'personal' | 'share'
export type MigrationComponent = 'sessions' | 'skills' | 'mcp' | 'channels' | 'chattools'

export interface ExportOptions {
  mode: MigrationMode
  workspaceId: string
  components: MigrationComponent[]
  /** 为空则导出全量会话 */
  sessionIds?: string[]
  outputPath: string
  /** 个人备份口令；设置后整个归档用 AES-256-GCM 加密 */
  passphrase?: string
  /** 仅主进程内使用，不经 IPC 传递 */
  onProgress?: (progress: ExportProgress) => void
}

export interface ExportProgress {
  phase: 'preparing' | 'packing' | 'finalizing' | 'encrypting'
  percent: number
  /** 已处理（读入）的源字节数，与 totalBytes 同一口径 */
  bytesWritten: number
  /** 预估源字节总量；0 表示无法预估（分享包） */
  totalBytes: number
}

export interface ExportResult {
  success: boolean
  filePath: string
  warnings?: string[]
  /** 归档体积（字节，加密前） */
  bytes?: number
  /** 归档条目数 */
  entries?: number
  /** 是否为口令加密备份 */
  encrypted?: boolean
  /** 默认全量导出时被自动排除的工作区（当前只有 project 模式） */
  excluded?: ExcludedWorkspace[]
}

/** 默认全量导出时被自动排除的工作区，附带面向用户的原因。 */
export interface ExcludedWorkspace {
  workspaceId: string
  workspaceName: string
  workspaceSlug: string
  /** 已本地化的排除原因 */
  reason: string
}

export interface ExportPreview {
  workspace: AgentWorkspace | null
  agentSessionCount: number
  chatConversationCount: number
  skillCount: number
  hasMcp: boolean
  estimatedComponents: MigrationComponent[]
}

export interface PathCheckResult {
  path: string
  exists: boolean
  suggested?: string
}

export interface PersonalImportPreview {
  available: boolean
  sections: string[]
  blobCount: number
  blobBytes: number
  missingBlobs: number
  /** 解包阶段发现的问题（校验和不符、条目解压失败等） */
  warnings: string[]
}

export interface ImportPreview {
  manifest: MigrationManifest
  agentSessionCount: number
  chatConversationCount: number
  skillNames: string[]
  hasMcp: boolean
  crossPlatform: boolean
  pathCheckResults: PathCheckResult[]
  tempDir: string
  personal?: PersonalImportPreview
}

export interface ConfirmImportOptions {
  tempDir: string
  manifest: MigrationManifest
  targetWorkspaceId?: string
  createNewWorkspace?: boolean
  newWorkspaceName?: string
  /** key: 原始路径, value: 新路径 (null = 移除) */
  pathMappings: Record<string, string | null>
  conflictResolution?: 'overwrite' | 'skip'
}

interface RuntimeArtifactRef {
  /** SDK 原生会话 ID。 */
  sessionId: string
  /** Profer 会话 ID，用于导入时重新绑定工作区。 */
  proferSessionId?: string
  path: string
  workspaceId?: string
  sourceProjectKey?: string
  runtime?: 'claude' | 'pi'
}

interface RuntimeArtifactsManifest {
  claudeProjects: RuntimeArtifactRef[]
  piSessions: RuntimeArtifactRef[]
}

/**
 * 个人备份（personal 模式）附带的「本机数据」摘要。
 *
 * 旧版本备份没有这个字段，导入时按「仅结构化数据」处理即可。
 */
export interface PersonalPayloadManifest {
  /** 已打包分区的人类可读名称，用于导入预览与结果展示 */
  sections: string[]
  /** 被会话引用并成功打包的 blob 数 */
  blobCount: number
  /** blob 原始字节数 */
  blobBytes: number
  /** 会话引用了但本机找不到的 blob 数（缺失原文） */
  missingBlobs: number
}

interface MigrationManifest {
  mode: MigrationMode
  version: string
  components: MigrationComponent[]
  exportedAt: number
  sourcePlatform: string
  sourceArch: string
  sourceHomeDir: string
  workspaceId: string
  workspaceName: string
  workspaceSlug: string
  /** Claude/Pi 原生会话文件；旧备份没有此字段，导入仍按旧格式兼容。 */
  runtimeArtifacts?: RuntimeArtifactsManifest
  /** personal 模式附带的会话原文与用户自建数据 */
  personal?: PersonalPayloadManifest
}

// ─── v2 多工作区类型 ─────────────────────────────────────────────────────────

export interface WorkspaceExportEntry {
  workspaceId: string
  workspaceName: string
  workspaceSlug: string
  skillSlugs: string[] | 'all'
  mcpServerNames: string[] | 'all'
}

interface MigrationManifestV2 {
  mode: MigrationMode
  version: '2.0' | '3.0'
  components: MigrationComponent[]
  exportedAt: number
  sourcePlatform: string
  sourceArch: string
  sourceHomeDir: string
  workspaces: WorkspaceExportEntry[]
  /** Claude/Pi 原生会话文件；旧备份没有此字段，导入仍按旧格式兼容。 */
  runtimeArtifacts?: RuntimeArtifactsManifest
  /** personal 模式附带的会话原文与用户自建数据 */
  personal?: PersonalPayloadManifest
}

export interface ExportOptionsV2 {
  mode: MigrationMode
  components: MigrationComponent[]
  outputPath: string
  sessionIds?: string[]
  workspaceSelections?: WorkspaceSelection[]
  /** 个人备份口令；设置后整个归档用 AES-256-GCM 加密 */
  passphrase?: string
  /** 仅主进程内使用，不经 IPC 传递 */
  onProgress?: (progress: ExportProgress) => void
}

export interface WorkspaceSelection {
  workspaceId: string
  skillSlugs?: string[]
  mcpServerNames?: string[]
}

export interface ShareExportPreview {
  workspaces: ShareExportWorkspacePreview[]
  agentSessionCount: number
  chatConversationCount: number
}

export interface ShareExportWorkspacePreview {
  workspace: AgentWorkspace
  skills: Array<{ slug: string; name: string; enabled: boolean }>
  mcpServers: Array<{ name: string; enabled: boolean; type: string }>
}

export interface WorkspaceImportPreview {
  workspaceSlug: string
  workspaceName: string
  skillNames: string[]
  mcpServerNames: string[]
  existsLocally: boolean
  localWorkspaceId?: string
  conflictingSkills: string[]
  conflictingMcpServers: string[]
}

export interface ImportPreviewV2 {
  manifest: MigrationManifestV2
  agentSessionCount: number
  chatConversationCount: number
  workspaces: WorkspaceImportPreview[]
  crossPlatform: boolean
  pathCheckResults: PathCheckResult[]
  tempDir: string
  personal: PersonalImportPreview
}

export interface WorkspaceImportMapping {
  sourceSlug: string
  action: 'merge' | 'create' | 'skip'
  targetWorkspaceId?: string
  newWorkspaceName?: string
}

export interface ConfirmImportOptionsV2 {
  tempDir: string
  manifest: MigrationManifestV2 | MigrationManifest
  pathMappings: Record<string, string | null>
  workspaceMappings?: WorkspaceImportMapping[]
  targetWorkspaceId?: string
  createNewWorkspace?: boolean
  newWorkspaceName?: string
  conflictResolution?: 'overwrite' | 'skip'
}

// ─── 导出 ────────────────────────────────────────────────────────────────────

/**
 * 项目工作区不参与迁移。
 *
 * project 工作区的配置与资产在用户项目目录（`<rootPath>/.profer`）里，与项目自身
 * 版本控制/分享边界重叠；直接纳入导出/导入会跨项目搬运数据，所以统一禁用。
 *
 * 行为分两种：
 * - 显式选中 project（单工作区导出、`workspaceSelections` 指名、导入目标）：硬错误；
 * - 默认全量导出（`exportDataV2` 未传 `workspaceSelections`）：自动跳过并在结果 `excluded` 里回报原因，
 *   避免「一键全量备份」在存在项目工作区时直接失败。
 * managed 工作区行为保持不变（`storageMode` 缺省一律视为 managed）。
 */
const PROJECT_WORKSPACE_MIGRATION_UNSUPPORTED = '项目工作区暂不支持导出/导入'

/**
 * 默认全量导出（未传 selections）时自动排除 project 工作区的原因。
 * 显式选中 project 仍然是硬错误（见 `assertMigrationWorkspacesSupported`）。
 */
const PROJECT_WORKSPACE_AUTO_EXCLUDED_REASON = '项目工作区暂不支持导出，已自动排除'

type MigrationGuardWorkspace = Pick<AgentWorkspace, 'name' | 'storageMode'>

/** 导出/导入公共入口的统一守卫：只要涉及的工作区里有 project 模式就拒绝。 */
function assertMigrationWorkspacesSupported(
  workspaces: Array<MigrationGuardWorkspace | null | undefined>,
): void {
  const project = workspaces.find((candidate) => candidate?.storageMode === 'project')
  if (!project) return
  throw new Error(`${PROJECT_WORKSPACE_MIGRATION_UNSUPPORTED}：「${project.name}」`)
}

export async function getExportPreview(workspaceId: string): Promise<ExportPreview> {
  const workspace = getAgentWorkspace(workspaceId) ?? null
  assertMigrationWorkspacesSupported([workspace])

  let agentSessionCount = 0
  let chatConversationCount = 0
  let skillCount = 0
  let hasMcp = false

  if (workspace) {
    // 统计 Agent 会话
    const sessionsIndex = readJsonSafe<{ sessions: Array<{ workspaceId: string }> }>(getAgentSessionsIndexPath())
    agentSessionCount = (sessionsIndex?.sessions ?? []).filter((s) => s.workspaceId === workspaceId).length

    // 统计 Chat 对话（全量，不按工作区过滤）
    const convIndex = readJsonSafe<{ conversations: unknown[] }>(getConversationsIndexPath())
    chatConversationCount = (convIndex?.conversations ?? []).length

    // 统计 Skills
    const skillsDir = getWorkspaceSkillsDir(workspace.slug)
    if (existsSync(skillsDir)) {
      skillCount = readdirSync(skillsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).length
    }

    // 检查 MCP
    const mcpPath = getWorkspaceMcpPath(workspace.slug)
    hasMcp = existsSync(mcpPath)
  }

  return {
    workspace,
    agentSessionCount,
    chatConversationCount,
    skillCount,
    hasMcp,
    estimatedComponents: ['sessions', 'skills', 'mcp', 'channels', 'chattools'],
  }
}

export async function getShareExportPreview(): Promise<ShareExportPreview> {
  const allWorkspaces = listAgentWorkspaces()

  const workspaces: ShareExportWorkspacePreview[] = allWorkspaces.map((ws) => {
    const skills = getAllWorkspaceSkills(ws.slug).map((s) => ({
      slug: s.slug,
      name: s.name,
      enabled: s.enabled,
    }))
    const mcpConfig = getWorkspaceMcpConfig(ws.slug)
    const mcpServers = Object.entries(mcpConfig.servers ?? {}).map(([name, entry]) => ({
      name,
      enabled: entry.enabled,
      type: entry.type,
    }))
    return { workspace: ws, skills, mcpServers }
  })

  const sessionsIndex = readJsonSafe<{ sessions: unknown[] }>(getAgentSessionsIndexPath())
  const agentSessionCount = (sessionsIndex?.sessions ?? []).length

  const convIndex = readJsonSafe<{ conversations: unknown[] }>(getConversationsIndexPath())
  const chatConversationCount = (convIndex?.conversations ?? []).length

  return { workspaces, agentSessionCount, chatConversationCount }
}

export async function exportData(options: ExportOptions): Promise<ExportResult> {
  const { mode, workspaceId, components, sessionIds, outputPath } = options
  const warnings: string[] = []

  const workspace = getAgentWorkspace(workspaceId)
  if (!workspace) throw new Error(`工作区不存在: ${workspaceId}`)
  assertMigrationWorkspacesSupported([workspace])

  const manifest: MigrationManifest = {
    mode,
    version: '3.0',
    components,
    exportedAt: Date.now(),
    sourcePlatform: platform(),
    sourceArch: arch(),
    sourceHomeDir: homedir(),
    workspaceId,
    workspaceName: workspace.name,
    workspaceSlug: workspace.slug,
  }

  const passphrase = _resolvePassphrase(mode, options.passphrase)
  const reporter = createExportReporter(options.onProgress)
  reporter.setPhase('preparing')
  reporter.setTotal(mode === 'personal' ? await estimatePersonalExportBytes([workspace], components) : 0)

  const stagingPath = passphrase ? join(tmpdir(), `profer-backup-staging-${randomUUID()}`) : outputPath
  const writer = new ZipStreamWriter(stagingPath, { onBytesWritten: (_archiveBytes, consumedBytes) => reporter.onBytes(consumedBytes) })
  const blobRefs = new Map<string, number>()

  try {
    reporter.setPhase('packing')
    if (components.includes('sessions')) {
      manifest.runtimeArtifacts = await _addRuntimeArtifacts(
        writer,
        _collectRuntimeArtifactCandidates([workspace], sessionIds),
        warnings,
      )
      await _addSessions(writer, workspace, sessionIds, warnings, blobRefs)
    }

    if (components.includes('skills')) await _addSkills(writer, workspace, warnings)
    if (components.includes('mcp')) await _addMcp(writer, workspace, mode)
    if (components.includes('channels')) await _addChannels(writer, mode)
    if (components.includes('chattools')) await _addChatTools(writer, mode)
    await _addWorkspaceConfig(writer, workspace)

    if (mode === 'personal') {
      await _addPersonalFiles(writer)
      manifest.personal = await _addPersonalPayload(writer, [workspace], blobRefs, warnings)
    }

    // manifest 最后写入：personal 摘要与缺失 blob 统计要等全部条目落盘后才确定。
    reporter.setPhase('finalizing')
    await writer.addBuffer(JSON.stringify(manifest, null, 2), 'manifest.json')
    return await _finishExport({ writer, stagingPath, outputPath, passphrase, warnings, reporter })
  } catch (error) {
    await writer.abort()
    if (passphrase) rmSync(stagingPath, { force: true })
    throw error
  }
}

export async function exportDataV2(options: ExportOptionsV2): Promise<ExportResult> {
  const { mode, components, sessionIds, outputPath, workspaceSelections } = options
  const warnings: string[] = []

  const allWorkspaces = listAgentWorkspaces()
  const wsMap = new Map(allWorkspaces.map((w) => [w.id, w]))

  /** 默认全量导出时被自动排除的 project 工作区（显式选中是硬错误，不进这里）。 */
  const excluded: ExcludedWorkspace[] = []
  const explicitSelection = Array.isArray(workspaceSelections) && workspaceSelections.length > 0

  let targetWorkspaces: Array<{ workspace: AgentWorkspace; skillSlugs?: string[]; mcpServerNames?: string[] }>

  if (explicitSelection) {
    targetWorkspaces = workspaceSelections!
      .map((sel) => {
        const ws = wsMap.get(sel.workspaceId)
        if (!ws) return null
        return { workspace: ws, skillSlugs: sel.skillSlugs, mcpServerNames: sel.mcpServerNames }
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
  } else {
    // 默认全量：project 工作区的配置在用户项目目录里，不能随备份跨项目搬运。
    // 这里自动跳过并回报 excluded，而不是让「一键全量备份」直接失败。
    targetWorkspaces = []
    for (const ws of allWorkspaces) {
      if (ws.storageMode === 'project') {
        excluded.push({
          workspaceId: ws.id,
          workspaceName: ws.name,
          workspaceSlug: ws.slug,
          reason: PROJECT_WORKSPACE_AUTO_EXCLUDED_REASON,
        })
        addExportWarning(warnings, `「${ws.name}」${PROJECT_WORKSPACE_AUTO_EXCLUDED_REASON}`)
        continue
      }
      targetWorkspaces.push({ workspace: ws })
    }
  }

  if (targetWorkspaces.length === 0) {
    throw new Error(excluded.length > 0
      ? `没有可导出的工作区：${excluded.length} 个项目工作区已自动排除，请至少保留一个托管工作区`
      : '没有可导出的工作区')
  }
  // 防御纵深：显式选中 project 会在这里抛错；默认全量分支已把 project 剔除。
  assertMigrationWorkspacesSupported(targetWorkspaces.map((entry) => entry.workspace))

  const workspaceEntries: WorkspaceExportEntry[] = targetWorkspaces.map(({ workspace, skillSlugs, mcpServerNames }) => ({
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    workspaceSlug: workspace.slug,
    skillSlugs: skillSlugs ?? 'all',
    mcpServerNames: mcpServerNames ?? 'all',
  }))

  const manifest: MigrationManifestV2 = {
    mode,
    version: '3.0',
    components,
    exportedAt: Date.now(),
    sourcePlatform: platform(),
    sourceArch: arch(),
    sourceHomeDir: homedir(),
    workspaces: workspaceEntries,
  }

  const passphrase = _resolvePassphrase(mode, options.passphrase)
  const reporter = createExportReporter(options.onProgress)
  reporter.setPhase('preparing')
  reporter.setTotal(mode === 'personal'
    ? await estimatePersonalExportBytes(targetWorkspaces.map((entry) => entry.workspace), components)
    : 0)

  const stagingPath = passphrase ? join(tmpdir(), `profer-backup-staging-${randomUUID()}`) : outputPath
  const writer = new ZipStreamWriter(stagingPath, { onBytesWritten: (_archiveBytes, consumedBytes) => reporter.onBytes(consumedBytes) })
  const blobRefs = new Map<string, number>()

  try {
    reporter.setPhase('packing')
    if (components.includes('sessions')) {
      manifest.runtimeArtifacts = await _addRuntimeArtifacts(
        writer,
        _collectRuntimeArtifactCandidates(targetWorkspaces.map((t) => t.workspace), sessionIds),
        warnings,
      )
      await _addSessionsMultiWorkspace(writer, targetWorkspaces.map((t) => t.workspace), sessionIds, warnings, blobRefs)
    }

    if (components.includes('skills')) {
      for (const { workspace, skillSlugs } of targetWorkspaces) {
        await _addSkillsV2(writer, workspace, skillSlugs, warnings)
      }
    }

    if (components.includes('mcp')) {
      for (const { workspace, mcpServerNames } of targetWorkspaces) {
        await _addMcpV2(writer, workspace, mode, mcpServerNames)
      }
    }

    for (const { workspace } of targetWorkspaces) {
      await _addWorkspaceConfigV2(writer, workspace)
    }

    if (components.includes('channels')) await _addChannels(writer, mode)
    if (components.includes('chattools')) await _addChatTools(writer, mode)

    if (mode === 'personal') {
      await _addPersonalFiles(writer)
      manifest.personal = await _addPersonalPayload(
        writer,
        targetWorkspaces.map((entry) => entry.workspace),
        blobRefs,
        warnings,
      )
    }

    reporter.setPhase('finalizing')
    await writer.addBuffer(JSON.stringify(manifest, null, 2), 'manifest.json')
    const result = await _finishExport({ writer, stagingPath, outputPath, passphrase, warnings, reporter })
    return excluded.length > 0 ? { ...result, excluded } : result
  } catch (error) {
    await writer.abort()
    if (passphrase) rmSync(stagingPath, { force: true })
    throw error
  }
}

interface RuntimeArtifactCandidate extends RuntimeArtifactRef {
  sourcePath: string
}

function _collectRuntimeArtifactCandidates(
  workspaces: AgentWorkspace[],
  filterIds: string[] | undefined,
): RuntimeArtifactCandidate[] {
  const workspaceIds = new Set(workspaces.map((w) => w.id))
  const sessionsIndex = readJsonSafe<{ sessions?: Array<{ id: string; workspaceId?: string; agentRuntime?: string; sdkSessionId?: string }> }>(
    getAgentSessionsIndexPath(),
  )
  const candidates: RuntimeArtifactCandidate[] = []
  for (const session of sessionsIndex?.sessions ?? []) {
    if (!workspaceIds.has(session.workspaceId ?? '') || (filterIds && !filterIds.includes(session.id)) || !session.sdkSessionId) continue
    if (session.agentRuntime === 'pi') {
      const piPath = _findPiSessionArtifact(session.sdkSessionId)
      if (piPath) {
        candidates.push({
          sessionId: session.sdkSessionId,
          proferSessionId: session.id,
          path: `runtime/pi/${session.sdkSessionId}.jsonl`,
          sourcePath: piPath,
          workspaceId: session.workspaceId,
          runtime: 'pi',
        })
      }
    } else {
      const claudePath = _findClaudeSessionArtifact(session.sdkSessionId)
      if (claudePath) {
        candidates.push({
          sessionId: session.sdkSessionId,
          proferSessionId: session.id,
          path: `runtime/claude/${session.sdkSessionId}.jsonl`,
          sourcePath: claudePath.filePath,
          sourceProjectKey: claudePath.projectKey,
          workspaceId: session.workspaceId,
          runtime: 'claude',
        })
      }
    }
  }
  return candidates
}

function _findPiSessionArtifact(sessionId: string): string | undefined {
  const root = join(getSdkConfigDir(), 'sessions', 'pi')
  if (!existsSync(root)) return undefined
  const scan = (dir: string): string | undefined => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const candidate = join(dir, entry.name)
      if (entry.isDirectory()) {
        const nested = scan(candidate)
        if (nested) return nested
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        try {
          const first = readFileSync(candidate, 'utf-8').split('\n', 1)[0]
          const header = first ? JSON.parse(first) as { type?: unknown; id?: unknown } : undefined
          if (header?.type === 'session' && header.id === sessionId) return candidate
        } catch { /* 忽略损坏或非 Pi 文件 */ }
      }
    }
    return undefined
  }
  return scan(root)
}

function _findClaudeSessionArtifact(sessionId: string): { filePath: string; projectKey: string } | undefined {
  const root = join(getSdkConfigDir(), 'projects')
  if (!existsSync(root)) return undefined
  for (const project of readdirSync(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue
    const filePath = join(root, project.name, `${sessionId}.jsonl`)
    if (existsSync(filePath)) return { filePath, projectKey: project.name }
  }
  return undefined
}

async function _addRuntimeArtifacts(
  writer: ZipStreamWriter,
  candidates: RuntimeArtifactCandidate[],
  warnings: string[],
): Promise<RuntimeArtifactsManifest> {
  const refs: RuntimeArtifactsManifest = { claudeProjects: [], piSessions: [] }
  for (const candidate of candidates) {
    if (candidate.runtime === 'pi' || candidate.path.startsWith('runtime/pi/')) {
      try {
        await writer.addFile(candidate.sourcePath, `runtime/pi/${candidate.sessionId}.jsonl`)
        refs.piSessions.push({ sessionId: candidate.sessionId, proferSessionId: candidate.proferSessionId, path: candidate.path, workspaceId: candidate.workspaceId, runtime: 'pi' })
      } catch (error) {
        addExportWarning(warnings, `已跳过 Pi 原生会话: ${candidate.sourcePath} (${formatErrorMessage(error)})`)
      }
      continue
    }

    try {
      await writer.addFile(candidate.sourcePath, `runtime/claude/${candidate.sessionId}.jsonl`)
      refs.claudeProjects.push({
        sessionId: candidate.sessionId,
        proferSessionId: candidate.proferSessionId,
        path: candidate.path,
        workspaceId: candidate.workspaceId,
        sourceProjectKey: candidate.sourceProjectKey,
        runtime: 'claude',
      })
    } catch (error) {
      addExportWarning(warnings, `已跳过 Claude 原生会话: ${candidate.sourcePath} (${formatErrorMessage(error)})`)
    }
  }
  return refs
}

/** 与 Claude Agent SDK 的项目目录键规则保持一致，包括超长路径的稳定短哈希。 */
export function __testSdkProjectKey(projectDir: string): string {
  return _sdkProjectKey(projectDir)
}

function _sdkProjectKey(projectDir: string): string {
  const sanitized = projectDir.replace(/[^a-zA-Z0-9]/g, '-')
  if (sanitized.length <= 200) return sanitized
  let hash = 0
  for (let i = 0; i < projectDir.length; i++) hash = (hash * 31 + projectDir.charCodeAt(i)) | 0
  return `${sanitized.slice(0, 200)}-${Math.abs(hash).toString(36)}`
}


/** 导入新版本运行时的 Claude/Pi 原生会话文件；旧备份没有该字段时安全空操作。 */
function _importRuntimeArtifacts(
  tempDir: string,
  artifacts: RuntimeArtifactsManifest | undefined,
  wsIdMap: Map<string, AgentWorkspace>,
): Map<string, string> {
  const piSessionFiles = new Map<string, string>()
  if (!artifacts) return piSessionFiles

  const findTarget = (ref: RuntimeArtifactRef): AgentWorkspace | undefined => {
    const mapped = ref.workspaceId ? wsIdMap.get(ref.workspaceId) : undefined
    return mapped ?? [...wsIdMap.values()][0]
  }

  for (const ref of [...artifacts.claudeProjects, ...artifacts.piSessions]) {
    if (!ref.proferSessionId) continue
    const target = findTarget(ref)
    if (!target) continue
    const isPi = ref.runtime === 'pi' || artifacts.piSessions.includes(ref)
    const sourcePath = join(tempDir, isPi ? 'runtime/pi' : 'runtime/claude', basename(ref.path))
    if (!existsSync(sourcePath)) continue

    if (isPi) {
      const sessionCwd = getAgentSessionWorkspacePath(target.slug, ref.proferSessionId)
      const destination = join(getSdkConfigDir(), 'sessions', 'pi', basename(ref.path))
      mkdirSync(dirname(destination), { recursive: true })
      if (!existsSync(destination)) {
        cpSync(sourcePath, destination)
        _rewriteRuntimeCwd(destination, sessionCwd)
      }
      piSessionFiles.set(ref.sessionId, destination)
    } else {
      const sessionCwd = getAgentSessionWorkspacePath(target.slug, ref.proferSessionId)
      const destination = join(getSdkConfigDir(), 'projects', _sdkProjectKey(sessionCwd), `${ref.sessionId}.jsonl`)
      mkdirSync(dirname(destination), { recursive: true })
      if (!existsSync(destination)) {
        cpSync(sourcePath, destination)
        // SDK 的历史文件可能记录旧 cwd；新 Profer 会话的 cwd 由工作区映射决定。
        // 仅替换 JSONL 中的 cwd 字段，避免恢复后继续读写源机器路径。
        _rewriteRuntimeCwd(destination, sessionCwd)
      }
    }
  }
  return piSessionFiles
}

export function __testRewriteRuntimeCwd(filePath: string, cwd: string): void {
  _rewriteRuntimeCwd(filePath, cwd)
}

function _rewriteRuntimeCwd(filePath: string, cwd: string): void {
  try {
    const lines = readFileSync(filePath, 'utf-8').split('\n')
    const rewritten = lines.map((line) => {
      try {
        const value = JSON.parse(line) as Record<string, unknown>
        if (value && typeof value === 'object' && 'cwd' in value) value.cwd = cwd
        return JSON.stringify(value)
      } catch {
        return line
      }
    }).join('\n')
    writeFileSync(filePath, rewritten, 'utf-8')
  } catch {
    // 原生 artifact 已经复制成功；cwd 修正失败不阻断整个备份导入。
  }
}

async function _addSessions(
  writer: ZipStreamWriter,
  workspace: AgentWorkspace,
  filterIds: string[] | undefined,
  warnings: string[],
  blobRefs: Map<string, number>,
) {
  const sessionsIndexPath = getAgentSessionsIndexPath()
  if (existsSync(sessionsIndexPath)) {
    const index = readJsonSafe<{ version: number; sessions: Array<{ id: string; workspaceId: string }> }>(sessionsIndexPath)
    // 待删除会话正处于中间态，文件可能已清一半，不导出。
    const sessions = (index?.sessions ?? []).filter((s) => s.workspaceId === workspace.id && !isSessionDeletionPending(s.id))
    const targets = filterIds ? sessions.filter((s) => filterIds.includes(s.id)) : sessions
    const exportedIds = new Set<string>()

    for (const session of targets) {
      const msgPath = getAgentSessionMessagesPath(session.id)
      if (existsSync(msgPath)) {
        if (await _addSessionMessages(writer, msgPath, warnings, blobRefs)) exportedIds.add(session.id)
      }
      const workDir = resolveAgentSessionWorkspacePath(workspace.slug, session.id)
      if (existsSync(workDir)) {
        await _addDirToZip(writer, workDir, `sessions/workspace-data/${session.id}`, warnings)
      }
    }

    if (index) {
      const filtered = { ...index, sessions: index.sessions.filter((s) => exportedIds.has(s.id)) }
      await writer.addBuffer(JSON.stringify(filtered, null, 2), 'sessions/agent-sessions-index.json')
      const piState = pickPiStatesForExport(sessionsIndexPath, exportedIds)
      if (piState) await writer.addBuffer(JSON.stringify(piState), EXPORTED_PI_STATE_ENTRY)
    }
  }

  const convIndexPath = getConversationsIndexPath()
  if (existsSync(convIndexPath)) {
    const index = readJsonSafe<{ version: number; conversations: Array<{ id: string }> }>(convIndexPath)
    const conversations = index?.conversations ?? []
    const targets = filterIds ? conversations.filter((c) => filterIds.includes(c.id)) : conversations

    for (const conv of targets) {
      const msgPath = getConversationMessagesPath(conv.id)
      if (existsSync(msgPath)) {
        try {
          await writer.addFile(msgPath, `sessions/chat/${basename(msgPath)}`)
        } catch (error) {
          addExportWarning(warnings, `已跳过 Chat 对话: ${msgPath} (${formatErrorMessage(error)})`)
        }
      }
    }
    await writer.addBuffer(
      JSON.stringify({ ...index, conversations: targets }, null, 2),
      'sessions/conversations-index.json',
    )
  }
}

async function _addSessionsMultiWorkspace(
  writer: ZipStreamWriter,
  workspaces: AgentWorkspace[],
  filterIds: string[] | undefined,
  warnings: string[],
  blobRefs: Map<string, number>,
) {
  const wsIds = new Set(workspaces.map((w) => w.id))

  const sessionsIndexPath = getAgentSessionsIndexPath()
  if (existsSync(sessionsIndexPath)) {
    const index = readJsonSafe<{ version: number; sessions: Array<{ id: string; workspaceId: string }> }>(sessionsIndexPath)
    const sessions = (index?.sessions ?? []).filter((s) => wsIds.has(s.workspaceId) && !isSessionDeletionPending(s.id))
    const targets = filterIds ? sessions.filter((s) => filterIds.includes(s.id)) : sessions
    const exportedIds = new Set<string>()

    for (const session of targets) {
      const msgPath = getAgentSessionMessagesPath(session.id)
      if (existsSync(msgPath)) {
        if (await _addSessionMessages(writer, msgPath, warnings, blobRefs)) exportedIds.add(session.id)
      }
      const ws = workspaces.find((w) => w.id === session.workspaceId)
      if (ws) {
        const workDir = resolveAgentSessionWorkspacePath(ws.slug, session.id)
        if (existsSync(workDir)) {
          await _addDirToZip(writer, workDir, `sessions/workspace-data/${session.id}`, warnings)
        }
      }
    }

    if (index) {
      const filtered = { ...index, sessions: index.sessions.filter((s) => exportedIds.has(s.id)) }
      await writer.addBuffer(JSON.stringify(filtered, null, 2), 'sessions/agent-sessions-index.json')
      const piState = pickPiStatesForExport(sessionsIndexPath, exportedIds)
      if (piState) await writer.addBuffer(JSON.stringify(piState), EXPORTED_PI_STATE_ENTRY)
    }
  }

  const convIndexPath = getConversationsIndexPath()
  if (existsSync(convIndexPath)) {
    const index = readJsonSafe<{ version: number; conversations: Array<{ id: string }> }>(convIndexPath)
    const conversations = index?.conversations ?? []
    const targets = filterIds ? conversations.filter((c) => filterIds.includes(c.id)) : conversations

    for (const conv of targets) {
      const msgPath = getConversationMessagesPath(conv.id)
      if (existsSync(msgPath)) {
        try {
          await writer.addFile(msgPath, `sessions/chat/${basename(msgPath)}`)
        } catch (error) {
          addExportWarning(warnings, `已跳过 Chat 对话: ${msgPath} (${formatErrorMessage(error)})`)
        }
      }
    }
    await writer.addBuffer(
      JSON.stringify({ ...index, conversations: targets }, null, 2),
      'sessions/conversations-index.json',
    )
  }
}

/** 写入会话 JSONL，并登记它引用的外置 blob（原文按内容寻址存放）。 */
async function _addSessionMessages(
  writer: ZipStreamWriter,
  msgPath: string,
  warnings: string[],
  blobRefs: Map<string, number>,
): Promise<boolean> {
  try {
    await writer.addFile(msgPath, `sessions/agent/${basename(msgPath)}`)
  } catch (error) {
    addExportWarning(warnings, `已跳过会话文件: ${msgPath} (${formatErrorMessage(error)})`)
    return false
  }
  await _collectSessionBlobRefs(msgPath, blobRefs, warnings)
  return true
}

/** 只解析带引用表的行，避免把整个会话文件读进内存。 */
async function _collectSessionBlobRefs(filePath: string, target: Map<string, number>, warnings: string[]): Promise<void> {
  try {
    const reader = createInterface({
      input: createReadStream(filePath, { encoding: 'utf-8' }),
      crlfDelay: Infinity,
    })
    for await (const line of reader) {
      if (!line.includes('_proferBlobs')) continue
      try {
        for (const ref of readSessionBlobRefs(JSON.parse(line))) {
          const bytes = typeof ref.bytes === 'number' ? ref.bytes : 0
          target.set(ref.hash, Math.max(target.get(ref.hash) ?? 0, bytes))
        }
      } catch {
        // 损坏行不影响其他会话的原文收集；导出侧不因单行解析失败而中断。
      }
    }
  } catch (error) {
    addExportWarning(warnings, `无法读取会话引用表: ${filePath} (${formatErrorMessage(error)})`)
  }
}

async function _addSkills(writer: ZipStreamWriter, workspace: AgentWorkspace, warnings: string[]) {
  const skillsDir = getWorkspaceSkillsDir(workspace.slug)
  if (existsSync(skillsDir)) await _addDirToZip(writer, skillsDir, 'skills/active', warnings)
  const inactiveDir = getInactiveSkillsDir(workspace.slug)
  if (existsSync(inactiveDir)) await _addDirToZip(writer, inactiveDir, 'skills/inactive', warnings)
  const overridesPath = getWorkspaceSkillOverridesPath(workspace.slug)
  if (existsSync(overridesPath)) await writer.addFile(overridesPath, 'skills/skill-overrides.json')
}

async function _addMcp(writer: ZipStreamWriter, workspace: AgentWorkspace, mode: MigrationMode) {
  const mcpPath = getWorkspaceMcpPath(workspace.slug)
  if (!existsSync(mcpPath)) return

  if (mode === 'share') {
    const config = readJsonSafe<Record<string, unknown>>(mcpPath)
    if (config) {
      await writer.addBuffer(JSON.stringify(_scrubMcpCredentials(config), null, 2), 'config/mcp.json')
    }
  } else {
    await writer.addFile(mcpPath, 'config/mcp.json')
  }
}

function _scrubMcpCredentials(config: Record<string, unknown>): Record<string, unknown> {
  const sensitiveKeys = /token|key|secret|password|auth|credential/i
  const scrub = (obj: unknown): unknown => {
    if (typeof obj !== 'object' || obj === null) return obj
    if (Array.isArray(obj)) return obj.map(scrub)
    const result: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (sensitiveKeys.test(k) && typeof v === 'string') {
        result[k] = ''
      } else {
        result[k] = scrub(v)
      }
    }
    return result
  }
  return scrub(config) as Record<string, unknown>
}

async function _addChannels(writer: ZipStreamWriter, mode: MigrationMode) {
  const channelsPath = getChannelsPath()
  if (!existsSync(channelsPath)) return

  if (mode === 'personal') {
    const channels = listChannels()
    const decrypted = channels.map((ch) => {
      try { return { ...ch, apiKey: decryptApiKey(ch.id) } }
      catch { return { ...ch, apiKey: '' } }
    })
    const config = readJsonSafe<{ version: number }>(channelsPath) ?? { version: 1 }
    await writer.addBuffer(JSON.stringify({ ...config, channels: decrypted }, null, 2), 'config/channels.json')
  } else {
    const channels = listChannels().map((ch) => ({ ...ch, apiKey: '' }))
    const config = readJsonSafe<{ version: number }>(channelsPath) ?? { version: 1 }
    await writer.addBuffer(JSON.stringify({ ...config, channels }, null, 2), 'config/channels.json')
  }
}

async function _addChatTools(writer: ZipStreamWriter, mode: MigrationMode) {
  const toolsPath = getChatToolsConfigPath()
  if (!existsSync(toolsPath)) return

  if (mode === 'share') {
    const config = readJsonSafe<{ toolStates?: unknown; toolCredentials?: unknown; customTools?: unknown }>(toolsPath)
    if (config) {
      await writer.addBuffer(JSON.stringify({ ...config, toolCredentials: {} }, null, 2), 'config/chat-tools.json')
    }
  } else {
    await writer.addFile(toolsPath, 'config/chat-tools.json')
  }
}

async function _addWorkspaceConfig(writer: ZipStreamWriter, workspace: AgentWorkspace) {
  const configPath = join(getAgentWorkspacePath(workspace.slug), 'config.json')
  if (existsSync(configPath)) {
    await writer.addFile(configPath, 'config/workspace-config.json')
  }
  await writer.addBuffer(JSON.stringify(workspace, null, 2), 'config/workspace-meta.json')
}

// ─── v2 导出辅助函数 ─────────────────────────────────────────────────────────

async function _addSkillsV2(
  writer: ZipStreamWriter,
  workspace: AgentWorkspace,
  selectedSlugs: string[] | undefined,
  warnings: string[],
) {
  const prefix = `workspaces/${workspace.slug}`
  const skillsDir = getWorkspaceSkillsDir(workspace.slug)
  if (existsSync(skillsDir)) {
    for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      assertSafeSkillSegment(entry.name, '导出 Skill slug')
      if (selectedSlugs && !selectedSlugs.includes(entry.name)) continue
      await _addDirToZip(writer, join(skillsDir, entry.name), `${prefix}/skills/active/${entry.name}`, warnings)
    }
  }
  const inactiveDir = getInactiveSkillsDir(workspace.slug)
  if (existsSync(inactiveDir)) {
    for (const entry of readdirSync(inactiveDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      assertSafeSkillSegment(entry.name, '导出 Skill slug')
      if (selectedSlugs && !selectedSlugs.includes(entry.name)) continue
      await _addDirToZip(writer, join(inactiveDir, entry.name), `${prefix}/skills/inactive/${entry.name}`, warnings)
    }
  }
  const overridesPath = getWorkspaceSkillOverridesPath(workspace.slug)
  if (existsSync(overridesPath)) await writer.addFile(overridesPath, `${prefix}/skills/skill-overrides.json`)
}

async function _addMcpV2(
  writer: ZipStreamWriter,
  workspace: AgentWorkspace,
  mode: MigrationMode,
  selectedNames?: string[],
) {
  const prefix = `workspaces/${workspace.slug}`
  const mcpPath = getWorkspaceMcpPath(workspace.slug)
  if (!existsSync(mcpPath)) return

  const raw = readJsonSafe<{ servers?: Record<string, unknown> }>(mcpPath)
  if (!raw?.servers) return

  let servers = raw.servers
  if (selectedNames) {
    const filtered: Record<string, unknown> = {}
    for (const name of selectedNames) {
      if (servers[name]) filtered[name] = servers[name]
    }
    servers = filtered
  }

  const config = { servers }
  const output = mode === 'share' ? _scrubMcpCredentials(config as Record<string, unknown>) : config
  await writer.addBuffer(JSON.stringify(output, null, 2), `${prefix}/config/mcp.json`)
}

async function _addWorkspaceConfigV2(writer: ZipStreamWriter, workspace: AgentWorkspace) {
  const prefix = `workspaces/${workspace.slug}`
  const configPath = join(getAgentWorkspacePath(workspace.slug), 'config.json')
  if (existsSync(configPath)) {
    await writer.addFile(configPath, `${prefix}/config/workspace-config.json`)
  }
  await writer.addBuffer(JSON.stringify(workspace, null, 2), `${prefix}/config/workspace-meta.json`)
}

async function _addPersonalFiles(writer: ZipStreamWriter) {
  const files: Array<[string, string]> = [
    [getSettingsPath(), 'auth/settings.json'],
    [getUserProfilePath(), 'auth/user-profile.json'],
    [join(getConfigDir(), 'cloud-auth.json'), 'auth/cloud-auth.json'],
  ]
  for (const [src, entryName] of files) {
    if (existsSync(src)) await writer.addFile(src, entryName)
  }
}

// ─── personal 模式：会话原文与用户自建数据 ───────────────────────────────────

/** 可重建、且体量巨大的目录不进备份，避免备份被依赖清单/版本库撑爆。 */
const BACKUP_EXCLUDED_DIRS = new Set([
  'node_modules', '.git', '__pycache__', '.venv', 'venv', '.cache',
  '.runtime', '.migration-backup', '.pytest_cache', '.mypy_cache',
])

const BACKUP_EXCLUDED_FILES = new Set(['.DS_Store'])

async function _addPersonalPayload(
  writer: ZipStreamWriter,
  workspaces: AgentWorkspace[],
  blobRefs: Map<string, number>,
  warnings: string[],
): Promise<PersonalPayloadManifest> {
  const sections: string[] = []

  const blobs = await _addReferencedBlobs(writer, blobRefs, warnings)
  if (blobs.blobCount > 0) sections.push('会话原文')

  sections.push(...await _addPersonalConfigFiles(writer, warnings))
  sections.push(...await _addPersonalDirectories(writer, warnings))

  for (const workspace of workspaces) {
    sections.push(...await _addWorkspacePayload(writer, workspace, warnings))
  }

  return { sections: [...new Set(sections)], ...blobs }
}

/** 只打包被导出会话引用到的 blob；未引用的属于孤儿，交给存储清理。 */
async function _addReferencedBlobs(
  writer: ZipStreamWriter,
  blobRefs: Map<string, number>,
  warnings: string[],
): Promise<{ blobCount: number; blobBytes: number; missingBlobs: number }> {
  let blobCount = 0
  let blobBytes = 0
  let missingBlobs = 0

  for (const [hash, declaredBytes] of blobRefs) {
    const hex = hash.startsWith('sha256:') ? hash.slice('sha256:'.length) : hash
    if (!/^[0-9a-f]{64}$/iu.test(hex)) {
      missingBlobs += 1
      continue
    }
    const sourcePath = blobPathFor(hash)
    if (!existsSync(sourcePath)) {
      missingBlobs += 1
      continue
    }
    try {
      await writer.addFile(sourcePath, `personal/blobs/${hex.slice(0, 2)}/${hex.slice(2, 4)}/${hex}`)
      blobCount += 1
      blobBytes += Math.max(statSync(sourcePath).size, declaredBytes)
    } catch (error) {
      missingBlobs += 1
      addExportWarning(warnings, `已跳过会话原文: ${hex} (${formatErrorMessage(error)})`)
    }
  }

  if (missingBlobs > 0) {
    addExportWarning(
      warnings,
      `有 ${missingBlobs} 段会话原文在本机已找不到，这部分内容在备份中无法恢复`,
    )
  }

  return { blobCount, blobBytes, missingBlobs }
}

/** 本机单文件状态：规划库、自动化、预设、插件清单、IM 接入等。 */
async function _addPersonalConfigFiles(writer: ZipStreamWriter, warnings: string[]): Promise<string[]> {
  const sections = new Set<string>()
  const planningDb = getPlanningDatabasePath()

  const files: Array<{ path: string; entry: string; section: string }> = [
    { path: planningDb, entry: 'personal/config/planning.db', section: '规划与日程' },
    { path: `${planningDb}-wal`, entry: 'personal/config/planning.db-wal', section: '规划与日程' },
    { path: `${planningDb}-shm`, entry: 'personal/config/planning.db-shm', section: '规划与日程' },
    { path: getAutomationsPath(), entry: 'personal/config/automations.json', section: '定时任务' },
    { path: getAgentPresetsPath(), entry: 'personal/config/agent-presets.json', section: '预设与提示词' },
    { path: getSystemPromptsPath(), entry: 'personal/config/system-prompts.json', section: '预设与提示词' },
    { path: getBrowserStartPagePath(), entry: 'personal/config/browser-start-page.json', section: '浏览器起始页' },
    { path: getRecommendationsPath(), entry: 'personal/config/recommendations.json', section: '主动建议' },
    { path: getPluginsIndexPath(), entry: 'personal/config/plugins.json', section: '插件' },
    { path: join(getConfigDir(), 'plugin-permissions.json'), entry: 'personal/config/plugin-permissions.json', section: '插件' },
    { path: getScratchPadPath(), entry: 'personal/config/scratch-pad.md', section: '随手记' },
    { path: getWeChatConfigPath(), entry: 'personal/config/wechat.json', section: 'IM 接入' },
    { path: getDingTalkConfigPath(), entry: 'personal/config/dingtalk.json', section: 'IM 接入' },
    { path: getFeishuConfigPath(), entry: 'personal/config/feishu.json', section: 'IM 接入' },
  ]

  // 飞书 Bot 绑定/元数据按 botId 拆文件，按前缀收集。
  try {
    for (const name of readdirSync(getConfigDir())) {
      if (!/^feishu-(?:bindings|metadata)-[\w-]+\.json$/u.test(name)) continue
      files.push({ path: join(getConfigDir(), name), entry: `personal/config/${name}`, section: 'IM 接入' })
    }
  } catch {
    // 配置目录读不到时其他分区照常备份
  }

  for (const file of files) {
    if (!existsSync(file.path)) continue
    try {
      await writer.addFile(file.path, file.entry)
      sections.add(file.section)
    } catch (error) {
      addExportWarning(warnings, `已跳过 ${file.entry}: ${formatErrorMessage(error)}`)
    }
  }

  return [...sections]
}

/** 本机目录状态：插件、皮肤、全局 Skills、资料库、聊天附件。 */
function _personalDirectorySources(): Array<{ name: string; path: string; section: string }> {
  return [
    { name: 'plugins', path: join(getConfigDir(), 'plugins'), section: '插件' },
    { name: 'plugin-data', path: join(getConfigDir(), 'plugin-data'), section: '插件数据' },
    { name: 'skins', path: join(getConfigDir(), 'skins'), section: '皮肤' },
    { name: 'global-skills', path: join(getConfigDir(), 'global-skills'), section: '全局 Skills' },
    { name: 'knowledge-base', path: join(getConfigDir(), 'knowledge-base'), section: '个人资料库' },
    { name: 'attachments', path: join(getConfigDir(), 'attachments'), section: '聊天附件' },
  ]
}

async function _addPersonalDirectories(writer: ZipStreamWriter, warnings: string[]): Promise<string[]> {
  const sections: string[] = []

  for (const dir of _personalDirectorySources()) {
    if (!existsSync(dir.path)) continue
    const before = writer.entryCount
    await _addDirToZip(writer, dir.path, `personal/config/${dir.name}`, warnings)
    if (writer.entryCount > before) sections.push(dir.section)
  }

  return sections
}

/** 工作区自己的资料：workspace-files、记忆、自定义预设。 */
async function _addWorkspacePayload(
  writer: ZipStreamWriter,
  workspace: AgentWorkspace,
  warnings: string[],
): Promise<string[]> {
  const sections: string[] = []
  const prefix = `workspaces/${workspace.slug}`
  const workspaceRoot = getAgentWorkspacePath(workspace.slug)

  const filesDir = join(workspaceRoot, 'workspace-files')
  if (existsSync(filesDir)) {
    const before = writer.entryCount
    await _addDirToZip(writer, filesDir, `${prefix}/workspace-files`, warnings)
    if (writer.entryCount > before) sections.push('工作区文件')
  }

  const memoryDir = join(workspaceRoot, '.profer', 'memory')
  if (existsSync(memoryDir)) {
    const before = writer.entryCount
    await _addDirToZip(writer, memoryDir, `${prefix}/memory`, warnings)
    if (writer.entryCount > before) sections.push('工作区记忆')
  }

  const presetsPath = getWorkspaceAgentPresetsPath(workspace.slug)
  if (existsSync(presetsPath)) {
    try {
      await writer.addFile(presetsPath, `${prefix}/config/agent-presets.json`)
      sections.push('工作区预设')
    } catch (error) {
      addExportWarning(warnings, `已跳过工作区预设: ${formatErrorMessage(error)}`)
    }
  }

  return sections
}

// ─── 导入（解析预览）────────────────────────────────────────────────────────

export async function inspectImportFile(filePath: string): Promise<{ encrypted: boolean; bytes: number }> {
  const encrypted = await isEncryptedBackup(filePath)
  let bytes = 0
  try {
    bytes = statSync(filePath).size
  } catch {
    // 文件不可读时交给后续 parse 报错
  }
  return { encrypted, bytes }
}

/**
 * 解析迁移文件（可带口令）。
 *
 * 加密备份先解密到临时文件再流式解包；解密文件在解包完成后立即删除，
 * 不随 tempDir 一起留给后续导入步骤。
 */
export async function parseImportFile(
  filePath: string,
  passphrase?: string,
): Promise<ImportPreview | ImportPreviewV2> {
  const tempDir = join(tmpdir(), `profer-import-${randomUUID()}`)
  mkdirSync(tempDir, { recursive: true })

  let sourcePath = filePath
  let decryptedPath: string | null = null
  try {
    if (await isEncryptedBackup(filePath)) {
      if (!passphrase) throw new Error('该备份已加密，请输入口令')
      decryptedPath = join(tmpdir(), `profer-decrypt-${randomUUID()}`)
      await decryptBackupFile(filePath, decryptedPath, passphrase)
      sourcePath = decryptedPath
    }
    return await _parseImportSource(sourcePath, tempDir)
  } catch (error) {
    // 解析失败时不把可能含用户数据的临时目录留在磁盘上。
    rmSync(tempDir, { recursive: true, force: true })
    throw error
  } finally {
    if (decryptedPath) rmSync(decryptedPath, { force: true })
  }
}

async function _parseImportSource(sourcePath: string, tempDir: string): Promise<ImportPreview | ImportPreviewV2> {
  // 流式解包：GB 级备份不能整包读进内存；条目名在解压前统一校验（Zip Slip / Windows 非法名）。
  const entries = await readZipEntries(sourcePath)
  assertSafeMigrationArchiveEntries(
    entries.map((entry) => ({ entryName: entry.name, isDirectory: entry.isDirectory })),
    tempDir,
  )
  const extraction = await extractZipEntries(sourcePath, entries, tempDir, {
    onWarning: (message) => console.warn(`[数据迁移] ${message}`),
  })
  const extractionWarnings = extraction.warnings

  const manifestPath = join(tempDir, 'manifest.json')
  if (!existsSync(manifestPath)) {
    rmSync(tempDir, { recursive: true, force: true })
    throw new Error('无效的迁移文件：缺少 manifest.json')
  }

  const rawManifest = readJsonSafe<MigrationManifest & { workspaces?: WorkspaceExportEntry[] }>(manifestPath)
  if (!rawManifest) {
    rmSync(tempDir, { recursive: true, force: true })
    throw new Error('无法解析 manifest.json')
  }

  let agentSessionCount = 0
  let chatConversationCount = 0
  const agentDir = join(tempDir, 'sessions/agent')
  const chatDir = join(tempDir, 'sessions/chat')
  if (existsSync(agentDir)) {
    agentSessionCount = readdirSync(agentDir).filter((f) => f.endsWith('.jsonl')).length
  }
  if (existsSync(chatDir)) {
    chatConversationCount = readdirSync(chatDir).filter((f) => f.endsWith('.jsonl')).length
  }

  const crossPlatform = rawManifest.sourcePlatform !== platform()

  if ((rawManifest.version === '2.0' || rawManifest.version === '3.0') && rawManifest.workspaces) {
    for (const entry of rawManifest.workspaces) {
      assertSafeSkillSegment(entry.workspaceSlug, '迁移 workspaceSlug')
      if (Array.isArray(entry.skillSlugs)) entry.skillSlugs.forEach((slug) => assertSafeSkillSegment(slug, '迁移 Skill slug'))
    }
    const manifest = rawManifest as unknown as MigrationManifestV2
    const localWorkspaces = listAgentWorkspaces()
    const localBySlug = new Map(localWorkspaces.map((w) => [w.slug, w]))

    const workspacesDir = join(tempDir, 'workspaces')
    const wsPreviewList: WorkspaceImportPreview[] = manifest.workspaces.map((entry) => {
      const wsDir = join(workspacesDir, entry.workspaceSlug)
      const skillsDir = join(wsDir, 'skills/active')
      const skillNames = existsSync(skillsDir)
        ? readdirSync(skillsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
        : []

      const mcpPath = join(wsDir, 'config/mcp.json')
      const mcpConfig = existsSync(mcpPath) ? readJsonSafe<{ servers?: Record<string, unknown> }>(mcpPath) : null
      const mcpServerNames = mcpConfig?.servers ? Object.keys(mcpConfig.servers) : []

      const localWs = localBySlug.get(entry.workspaceSlug)

      let conflictingSkills: string[] = []
      let conflictingMcpServers: string[] = []

      if (localWs) {
        const localSkillsDir = getWorkspaceSkillsDir(localWs.slug)
        if (existsSync(localSkillsDir)) {
          const localSkillSet = new Set(
            readdirSync(localSkillsDir, { withFileTypes: true })
              .filter((e) => e.isDirectory())
              .map((e) => e.name)
          )
          conflictingSkills = skillNames.filter((name) => localSkillSet.has(name))
        }

        const localMcpPath = getWorkspaceMcpPath(localWs.slug)
        if (existsSync(localMcpPath)) {
          const localMcp = readJsonSafe<{ servers?: Record<string, unknown> }>(localMcpPath)
          if (localMcp?.servers) {
            const localServerSet = new Set(Object.keys(localMcp.servers))
            conflictingMcpServers = mcpServerNames.filter((name) => localServerSet.has(name))
          }
        }
      }

      return {
        workspaceSlug: entry.workspaceSlug,
        workspaceName: entry.workspaceName,
        skillNames,
        mcpServerNames,
        existsLocally: !!localWs,
        localWorkspaceId: localWs?.id,
        conflictingSkills,
        conflictingMcpServers,
      }
    })

    const pathCheckResults = _checkAttachedDirectoriesV2(tempDir, manifest)
    const personal = await _readPersonalPreview(tempDir, manifest.personal, extractionWarnings)

    return {
      manifest,
      agentSessionCount,
      chatConversationCount,
      workspaces: wsPreviewList,
      crossPlatform,
      pathCheckResults,
      tempDir,
      personal,
    } satisfies ImportPreviewV2
  }

  // v1.0 原有逻辑
  assertSafeSkillSegment((rawManifest as MigrationManifest).workspaceSlug, '迁移 workspaceSlug')
  const manifest = rawManifest as MigrationManifest
  const skillsDir = join(tempDir, 'skills/active')
  const skillNames: string[] = existsSync(skillsDir)
    ? readdirSync(skillsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
    : []

  const hasMcp = existsSync(join(tempDir, 'config/mcp.json'))
  const pathCheckResults = _checkAttachedDirectories(tempDir, manifest)
  const personal = await _readPersonalPreview(tempDir, manifest.personal, extractionWarnings)

  return {
    manifest,
    agentSessionCount,
    chatConversationCount,
    skillNames,
    hasMcp,
    crossPlatform,
    pathCheckResults,
    tempDir,
    personal,
  }
}

/** 统计归档里的本机数据分区，供导入预览展示。 */
async function _readPersonalPreview(
  tempDir: string,
  manifestPersonal: PersonalPayloadManifest | undefined,
  warnings: string[],
): Promise<PersonalImportPreview> {
  const personalDir = join(tempDir, 'personal')
  if (!existsSync(personalDir)) {
    return { available: false, sections: [], blobCount: 0, blobBytes: 0, missingBlobs: 0, warnings }
  }

  let blobCount = 0
  let blobBytes = 0
  const blobsDir = join(personalDir, 'blobs')
  if (existsSync(blobsDir)) {
    for (const first of readdirSync(blobsDir, { withFileTypes: true })) {
      if (!first.isDirectory()) continue
      for (const second of readdirSync(join(blobsDir, first.name), { withFileTypes: true })) {
        if (!second.isDirectory()) continue
        for (const file of readdirSync(join(blobsDir, first.name, second.name), { withFileTypes: true })) {
          if (!file.isFile()) continue
          blobCount += 1
          try {
            blobBytes += statSync(join(blobsDir, first.name, second.name, file.name)).size
          } catch {
            // 单个 blob 读不到不影响预览
          }
        }
      }
    }
  }

  return {
    available: true,
    sections: manifestPersonal?.sections ?? [],
    blobCount,
    blobBytes,
    missingBlobs: manifestPersonal?.missingBlobs ?? 0,
    warnings,
  }
}

function _checkAttachedDirectories(tempDir: string, manifest: MigrationManifest): PathCheckResult[] {
  const configPath = join(tempDir, 'config/workspace-config.json')
  if (!existsSync(configPath)) return []

  const config = readJsonSafe<{ attachedDirectories?: string[]; attachedFiles?: string[] }>(configPath)
  const attachedPaths = [...(config?.attachedDirectories ?? []), ...(config?.attachedFiles ?? [])]
  if (attachedPaths.length === 0) return []

  const currentHome = homedir()

  return attachedPaths.map((p) => {
    let suggested: string | undefined
    if (manifest.sourceHomeDir && p.startsWith(manifest.sourceHomeDir)) {
      suggested = join(currentHome, p.slice(manifest.sourceHomeDir.length))
    }

    const checkPath = suggested ?? p
    return {
      path: p,
      exists: existsSync(checkPath),
      suggested,
    }
  })
}

function _checkAttachedDirectoriesV2(tempDir: string, manifest: MigrationManifestV2): PathCheckResult[] {
  const currentHome = homedir()
  const allResults: PathCheckResult[] = []
  const seen = new Set<string>()

  for (const wsEntry of manifest.workspaces) {
    const configPath = join(tempDir, `workspaces/${wsEntry.workspaceSlug}/config/workspace-config.json`)
    if (!existsSync(configPath)) continue

    const config = readJsonSafe<{ attachedDirectories?: string[]; attachedFiles?: string[] }>(configPath)
    const attachedPaths = [...(config?.attachedDirectories ?? []), ...(config?.attachedFiles ?? [])]
    if (attachedPaths.length === 0) continue

    for (const p of attachedPaths) {
      if (seen.has(p)) continue
      seen.add(p)

      let suggested: string | undefined
      if (manifest.sourceHomeDir && p.startsWith(manifest.sourceHomeDir)) {
        suggested = join(currentHome, p.slice(manifest.sourceHomeDir.length))
      }
      const checkPath = suggested ?? p
      allResults.push({ path: p, exists: existsSync(checkPath), suggested })
    }
  }

  return allResults
}

// ─── 导入（确认执行）────────────────────────────────────────────────────────

export interface ConfirmImportResult {
  success: boolean
  /** 未致命但需要用户知道的问题（缺 blob、校验和不符、部分文件未恢复等） */
  warnings?: string[]
  /** 实际恢复的本机数据分区 */
  restored?: string[]
}

export async function confirmImport(
  options: ConfirmImportOptions | ConfirmImportOptionsV2,
): Promise<ConfirmImportResult> {
  const { tempDir, manifest, pathMappings } = options

  try {
    if ((manifest.version === '2.0' || manifest.version === '3.0') && 'workspaces' in manifest) {
      return await _confirmImportV2(options as ConfirmImportOptionsV2)
    }

    // v1.0 原有逻辑
    const { targetWorkspaceId, createNewWorkspace, newWorkspaceName, conflictResolution } = options as ConfirmImportOptions
    const overwrite = conflictResolution === 'overwrite'
    let targetWorkspace: AgentWorkspace | undefined
    if (createNewWorkspace) {
      const { createAgentWorkspace } = await import('./agent-workspace-manager')
      targetWorkspace = createAgentWorkspace(newWorkspaceName ?? (manifest as MigrationManifest).workspaceName)
    } else if (targetWorkspaceId) {
      targetWorkspace = getAgentWorkspace(targetWorkspaceId)
    } else {
      const workspaces = listAgentWorkspaces()
      targetWorkspace = workspaces.find((w) => w.slug === (manifest as MigrationManifest).workspaceSlug) ?? workspaces[0]
    }

    if (!targetWorkspace) throw new Error('无法确定目标工作区')
    assertMigrationWorkspacesSupported([targetWorkspace])

    const warnings: string[] = []

    if (manifest.components.includes('sessions')) {
      const v1Manifest = manifest as MigrationManifest
      const runtimeSessionFiles = await _importRuntimeArtifacts(
        tempDir,
        v1Manifest.runtimeArtifacts,
        new Map([[v1Manifest.workspaceId, targetWorkspace]]),
      )
      await _importSessions(tempDir, targetWorkspace, runtimeSessionFiles)
    }
    if (manifest.components.includes('skills')) {
      _importSkills(tempDir, targetWorkspace, overwrite)
    }
    if (manifest.components.includes('mcp')) {
      _importMcp(tempDir, targetWorkspace, overwrite)
    }
    if (manifest.components.includes('channels')) {
      _importChannels(tempDir, manifest.mode)
    }
    if (manifest.components.includes('chattools')) {
      _importChatTools(tempDir)
    }
    _importWorkspaceConfig(tempDir, targetWorkspace, pathMappings)
    let restored: string[] = []
    if (manifest.mode === 'personal') {
      _importPersonalFiles(tempDir)
      restored = await _restorePersonalPayload(
        tempDir,
        [{ sourceSlug: (manifest as MigrationManifest).workspaceSlug, target: targetWorkspace }],
        overwrite,
        warnings,
      )
    }

    return {
      success: true,
      ...(warnings.length > 0 ? { warnings: [...new Set(warnings)] } : {}),
      ...(restored.length > 0 ? { restored } : {}),
    }
  } finally {
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // 忽略清理失败
    }
  }
}

async function _confirmImportV2(options: ConfirmImportOptionsV2): Promise<ConfirmImportResult> {
  const { tempDir, manifest, pathMappings, workspaceMappings, conflictResolution } = options
  const v2Manifest = manifest as MigrationManifestV2
  const overwrite = conflictResolution === 'overwrite'
  const warnings: string[] = []

  const { createAgentWorkspace } = await import('./agent-workspace-manager')

  const localWorkspaces = listAgentWorkspaces()
  const localBySlug = new Map(localWorkspaces.map((w) => [w.slug, w]))

  // 项目工作区不支持导入：先解析已有目标并校验，再按原顺序创建新工作区。
  // 顺序必须先校验后创建，避免“先建出一个空工作区再报错”的残留副作用。
  const plannedTargets: Array<{ sourceSlug: string; existing?: AgentWorkspace; createName?: string }> = []

  if (workspaceMappings && workspaceMappings.length > 0) {
    for (const mapping of workspaceMappings) {
      if (mapping.action === 'skip') continue
      if (mapping.action === 'merge') {
        const target = mapping.targetWorkspaceId
          ? getAgentWorkspace(mapping.targetWorkspaceId)
          : localBySlug.get(mapping.sourceSlug)
        if (!target) continue
        plannedTargets.push({ sourceSlug: mapping.sourceSlug, existing: target })
      } else if (mapping.action === 'create') {
        const wsEntry = v2Manifest.workspaces.find((w) => w.workspaceSlug === mapping.sourceSlug)
        const name = mapping.newWorkspaceName ?? wsEntry?.workspaceName ?? mapping.sourceSlug
        plannedTargets.push({ sourceSlug: mapping.sourceSlug, createName: name })
      }
    }
  } else {
    for (const wsEntry of v2Manifest.workspaces) {
      const local = localBySlug.get(wsEntry.workspaceSlug)
      plannedTargets.push(local
        ? { sourceSlug: wsEntry.workspaceSlug, existing: local }
        : { sourceSlug: wsEntry.workspaceSlug, createName: wsEntry.workspaceName })
    }
  }

  assertMigrationWorkspacesSupported(plannedTargets.map((plan) => plan.existing))

  const resolvedMappings: Array<{ sourceSlug: string; target: AgentWorkspace }> = []
  for (const plan of plannedTargets) {
    resolvedMappings.push({
      sourceSlug: plan.sourceSlug,
      target: plan.existing ?? createAgentWorkspace(plan.createName ?? plan.sourceSlug),
    })
  }

  for (const { sourceSlug, target } of resolvedMappings) {
    if (v2Manifest.components.includes('skills')) {
      _importSkillsV2(tempDir, sourceSlug, target, overwrite)
    }
    if (v2Manifest.components.includes('mcp')) {
      _importMcpV2(tempDir, sourceSlug, target, overwrite)
    }
    _importWorkspaceConfigV2(tempDir, sourceSlug, target, pathMappings)
  }

  if (v2Manifest.components.includes('sessions') && resolvedMappings.length > 0) {
    const wsIdMap = new Map<string, AgentWorkspace>()
    for (const wsEntry of v2Manifest.workspaces) {
      const resolved = resolvedMappings.find((r) => r.sourceSlug === wsEntry.workspaceSlug)
      if (resolved) wsIdMap.set(wsEntry.workspaceId, resolved.target)
    }
    const runtimeSessionFiles = await _importRuntimeArtifacts(tempDir, v2Manifest.runtimeArtifacts, wsIdMap)
    await _importSessionsV2(tempDir, wsIdMap, resolvedMappings[0]!.target, runtimeSessionFiles)
  }
  if (v2Manifest.components.includes('channels')) {
    _importChannels(tempDir, v2Manifest.mode)
  }
  if (v2Manifest.components.includes('chattools')) {
    _importChatTools(tempDir)
  }
  if (v2Manifest.mode === 'personal') {
    _importPersonalFiles(tempDir)
  }

  let restored: string[] = []
  if (v2Manifest.mode === 'personal') {
    restored = await _restorePersonalPayload(tempDir, resolvedMappings, overwrite, warnings)
  }

  return {
    success: true,
    ...(warnings.length > 0 ? { warnings: [...new Set(warnings)] } : {}),
    ...(restored.length > 0 ? { restored } : {}),
  }
}

async function _importSessions(
  tempDir: string,
  targetWorkspace: AgentWorkspace,
  runtimeSessionFiles: Map<string, string> = new Map(),
) {
  // Agent 会话
  const agentDir = join(tempDir, 'sessions/agent')
  const agentSessionsDir = getAgentSessionsDir()
  if (existsSync(agentDir)) {
    for (const file of readdirSync(agentDir)) {
      if (!file.endsWith('.jsonl')) continue
      const src = join(agentDir, file)
      const dest = join(agentSessionsDir, file)
      if (!existsSync(dest)) {
        cpSync(src, dest)
      }
    }
  }

  // Agent sessions index 合并
  const importedIndexPath = join(tempDir, 'sessions/agent-sessions-index.json')
  if (existsSync(importedIndexPath)) {
    const imported = readJsonSafe<{ sessions: Array<{ id: string; workspaceId: string; sdkSessionId?: string; agentRuntime?: string }> }>(importedIndexPath)
    const currentIndexPath = getAgentSessionsIndexPath()
    const current = readJsonSafe<{ version: number; sessions: Array<Record<string, unknown>> }>(currentIndexPath) ?? { version: 1, sessions: [] }
    const currentIds = new Set(current.sessions.map((s) => s['id']))

    const addedSessionIds = new Set<string>()
    const inlinePiStates = new Map<string, NonNullable<ReturnType<typeof splitInlinePiState>['inline']>>()
    for (const s of imported?.sessions ?? []) {
      if (!currentIds.has(s.id)) {
        // 旧备份把 Pi 大字段内联在索引里：拆出来单独合并，避免重新灌进轻索引。
        const { inline, rest } = splitInlinePiState(s as Record<string, unknown>)
        if (inline) inlinePiStates.set(s.id, inline)
        current.sessions.push({
          ...rest,
          workspaceId: targetWorkspace.id,
          ...(s.agentRuntime === 'pi' ? { piSessionFile: s.sdkSessionId ? runtimeSessionFiles.get(s.sdkSessionId) : undefined } : {}),
        })
        addedSessionIds.add(s.id)
      }
    }
    writeFileSync(currentIndexPath, JSON.stringify(current, null, 2), 'utf-8')
    mergePiStatesForImport(currentIndexPath, addedSessionIds, [
      inlinePiStates.size > 0 ? { version: 1, states: Object.fromEntries(inlinePiStates) } : null,
      readExportedPiState(tempDir),
    ])
  }

  // 会话工作目录
  const workspaceDataDir = join(tempDir, 'sessions/workspace-data')
  if (existsSync(workspaceDataDir)) {
    for (const sessionId of readdirSync(workspaceDataDir)) {
      const src = join(workspaceDataDir, sessionId)
      const dest = getAgentSessionWorkspacePath(targetWorkspace.slug, sessionId)
      if (!existsSync(dest)) {
        cpSync(src, dest, { recursive: true })
      }
    }
  }

  // Chat 对话
  const chatDir = join(tempDir, 'sessions/chat')
  const convDir = getConversationsDir()
  if (existsSync(chatDir)) {
    for (const file of readdirSync(chatDir)) {
      if (!file.endsWith('.jsonl')) continue
      const src = join(chatDir, file)
      const dest = join(convDir, file)
      if (!existsSync(dest)) {
        cpSync(src, dest)
      }
    }
  }

  // Chat 对话 index 合并
  const importedConvIndexPath = join(tempDir, 'sessions/conversations-index.json')
  if (existsSync(importedConvIndexPath)) {
    const imported = readJsonSafe<{ conversations: Array<{ id: string }> }>(importedConvIndexPath)
    const currentIndexPath = getConversationsIndexPath()
    const current = readJsonSafe<{ version: number; conversations: Array<{ id: string }> }>(currentIndexPath) ?? { version: 1, conversations: [] }
    const currentIds = new Set(current.conversations.map((c) => c.id))

    for (const c of imported?.conversations ?? []) {
      if (!currentIds.has(c.id)) {
        current.conversations.push(c)
      }
    }
    writeFileSync(currentIndexPath, JSON.stringify(current, null, 2), 'utf-8')
  }
}

function _importSkills(tempDir: string, targetWorkspace: AgentWorkspace, overwrite = false) {
  const activeDir = join(tempDir, 'skills/active')
  if (existsSync(activeDir)) {
    const targetSkillsDir = getWorkspaceSkillsDir(targetWorkspace.slug)
    for (const skillName of readdirSync(activeDir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.isSymbolicLink()).map((e) => e.name)) {
      assertSafeSkillSegment(skillName, '导入 Skill slug')
      const src = join(activeDir, skillName)
      const dest = join(targetSkillsDir, skillName)
      if (existsSync(dest)) {
        if (!overwrite) continue
        rmSync(dest, { recursive: true, force: true })
      }
      copySkillDirectorySafely(src, dest)
      ensureImportedWorkspaceSkillId(dest)
    }
  }
  const inactiveDir = join(tempDir, 'skills/inactive')
  if (existsSync(inactiveDir)) {
    const targetInactiveDir = getInactiveSkillsDir(targetWorkspace.slug)
    for (const skillName of readdirSync(inactiveDir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.isSymbolicLink()).map((e) => e.name)) {
      assertSafeSkillSegment(skillName, '导入 Skill slug')
      const src = join(inactiveDir, skillName)
      const dest = join(targetInactiveDir, skillName)
      if (existsSync(dest)) {
        if (!overwrite) continue
        rmSync(dest, { recursive: true, force: true })
      }
      copySkillDirectorySafely(src, dest)
      ensureImportedWorkspaceSkillId(dest)
    }
  }
  _importSkillOverrides(tempDir, targetWorkspace, overwrite)
}

function ensureImportedWorkspaceSkillId(skillDir: string): void {
  const sourcePath = join(skillDir, '.source.json')
  const current = existsSync(sourcePath) ? readJsonSafe<Record<string, unknown>>(sourcePath) : null
  if (typeof current?.workspaceSkillId === 'string' && current.workspaceSkillId.length > 0) return
  writeJsonFileAtomic(sourcePath, { ...(current ?? { scope: 'workspace' }), workspaceSkillId: randomUUID() })
}

function _importSkillOverrides(sourceRoot: string, targetWorkspace: AgentWorkspace, overwrite = false): void {
  const sourcePath = join(sourceRoot, 'skills/skill-overrides.json')
  if (!existsSync(sourcePath)) return
  const imported = readJsonSafe<{ schemaVersion?: number; globalSkills?: Record<string, unknown> }>(sourcePath)
  if (!imported?.globalSkills || imported.schemaVersion !== 1) return
  const targetPath = getWorkspaceSkillOverridesPath(targetWorkspace.slug)
  const current = existsSync(targetPath)
    ? readJsonSafe<{ schemaVersion?: number; globalSkills?: Record<string, unknown> }>(targetPath)
    : null
  const merged = {
    schemaVersion: 1,
    globalSkills: overwrite
      ? { ...(current?.globalSkills ?? {}), ...imported.globalSkills }
      : { ...imported.globalSkills, ...(current?.globalSkills ?? {}) },
  }
  mkdirSync(dirname(targetPath), { recursive: true })
  writeJsonFileAtomic(targetPath, merged)
}

function _importMcp(tempDir: string, targetWorkspace: AgentWorkspace, overwrite = false) {
  const srcMcp = join(tempDir, 'config/mcp.json')
  if (!existsSync(srcMcp)) return
  const destMcp = getWorkspaceMcpPath(targetWorkspace.slug)
  if (existsSync(destMcp)) {
    const existing = readJsonSafe<{ servers?: Record<string, unknown> }>(destMcp) ?? {}
    const imported = readJsonSafe<{ servers?: Record<string, unknown> }>(srcMcp) ?? {}
    const merged = overwrite
      ? { ...existing, servers: { ...existing.servers, ...imported.servers } }
      : { ...existing, servers: { ...imported.servers, ...existing.servers } }
    writeFileSync(destMcp, JSON.stringify(merged, null, 2), 'utf-8')
  } else {
    mkdirSync(getAgentWorkspacePath(targetWorkspace.slug), { recursive: true })
    cpSync(srcMcp, destMcp)
  }
}

function _importChannels(tempDir: string, mode: MigrationMode) {
  const srcChannels = join(tempDir, 'config/channels.json')
  if (!existsSync(srcChannels)) return

  const imported = readJsonSafe<{ version: number; channels: Array<Record<string, unknown>> }>(srcChannels)
  if (!imported) return

  const currentPath = getChannelsPath()
  const current = readJsonSafe<{ version: number; channels: Array<Record<string, unknown>> }>(currentPath) ?? { version: 1, channels: [] }
  const currentIds = new Set(current.channels.map((c) => c['id']))

  for (const ch of imported.channels) {
    if (currentIds.has(ch['id'])) continue
    if (mode === 'personal' && ch['apiKey']) {
      let encryptedKey = ''
      try {
        if (safeStorage.isEncryptionAvailable()) {
          encryptedKey = safeStorage.encryptString(ch['apiKey'] as string).toString('base64')
        } else {
          encryptedKey = ch['apiKey'] as string
        }
      } catch {
        encryptedKey = ''
      }
      current.channels.push({ ...ch, apiKey: encryptedKey })
    } else {
      current.channels.push({ ...ch, apiKey: '' })
    }
  }

  writeFileSync(currentPath, JSON.stringify(current, null, 2), 'utf-8')
}

function _importChatTools(tempDir: string) {
  const srcTools = join(tempDir, 'config/chat-tools.json')
  if (!existsSync(srcTools)) return

  const imported = readJsonSafe<{ toolStates?: Record<string, unknown>; toolCredentials?: Record<string, unknown>; customTools?: unknown[] }>(srcTools)
  if (!imported) return

  const currentPath = getChatToolsConfigPath()
  if (!existsSync(currentPath)) {
    cpSync(srcTools, currentPath)
    return
  }

  const current = readJsonSafe<{ toolStates?: Record<string, unknown>; toolCredentials?: Record<string, unknown>; customTools?: unknown[] }>(currentPath) ?? {}
  // 合并 toolStates（不覆盖已有）
  const merged = {
    ...current,
    toolStates: { ...imported.toolStates, ...current.toolStates },
    customTools: [...(current.customTools ?? []), ...(imported.customTools ?? [])],
  }
  writeFileSync(currentPath, JSON.stringify(merged, null, 2), 'utf-8')
}

function _importWorkspaceConfig(tempDir: string, targetWorkspace: AgentWorkspace, pathMappings: Record<string, string | null>) {
  const srcConfig = join(tempDir, 'config/workspace-config.json')
  if (!existsSync(srcConfig)) return

  const config = readJsonSafe<{ attachedDirectories?: string[]; attachedFiles?: string[] }>(srcConfig)
  if (!config?.attachedDirectories && !config?.attachedFiles) return

  // 应用路径映射
  const newDirs: string[] = []
  for (const dir of config.attachedDirectories ?? []) {
    const mapped = pathMappings[dir]
    if (mapped === null) continue // 用户选择移除
    if (mapped !== undefined) {
      newDirs.push(mapped) // 用户重新映射
    } else if (existsSync(dir)) {
      newDirs.push(dir) // 路径存在，直接保留
    }
    // 路径不存在且无映射：跳过（移除）
  }
  const newFiles: string[] = []
  for (const file of config.attachedFiles ?? []) {
    const mapped = pathMappings[file]
    if (mapped === null) continue
    if (mapped !== undefined) {
      newFiles.push(mapped)
    } else if (existsSync(file)) {
      newFiles.push(file)
    }
  }

  // 写入目标工作区 config
  const destConfigPath = join(getAgentWorkspacePath(targetWorkspace.slug), 'config.json')
  const existingConfig = existsSync(destConfigPath)
    ? readJsonSafe<{ attachedDirectories?: string[]; attachedFiles?: string[] }>(destConfigPath) ?? {}
    : {}
  const merged = {
    ...existingConfig,
    attachedDirectories: [...new Set([...(existingConfig.attachedDirectories ?? []), ...newDirs])],
    attachedFiles: [...new Set([...(existingConfig.attachedFiles ?? []), ...newFiles])],
  }
  writeFileSync(destConfigPath, JSON.stringify(merged, null, 2), 'utf-8')
}

function _importPersonalFiles(tempDir: string) {
  const files: Array<[string, string]> = [
    [join(tempDir, 'auth/settings.json'), getSettingsPath()],
    [join(tempDir, 'auth/user-profile.json'), getUserProfilePath()],
    [join(tempDir, 'auth/cloud-auth.json'), join(getConfigDir(), 'cloud-auth.json')],
  ]
  for (const [src, dest] of files) {
    if (existsSync(src)) {
      if (existsSync(dest)) {
        const backupPath = `${dest}.backup-${Date.now()}`
        cpSync(dest, backupPath)
      }
      cpSync(src, dest)
    }
  }
}

// ─── personal 模式：恢复会话原文与用户自建数据 ───────────────────────────────

interface WorkspacePayloadMapping {
  sourceSlug: string
  target: AgentWorkspace
}

/**
 * 恢复 personal 归档里的本机数据分区。
 *
 * 语义分层：
 * - 单文件状态（规划库、自动化、预设…）整体替换，旧文件先备份；
 * - 目录（工作区文件、附件、插件…）只补缺不覆盖，避免导入旧备份反向删掉现有资料。
 */
async function _restorePersonalPayload(
  tempDir: string,
  mappings: WorkspacePayloadMapping[],
  _overwrite: boolean,
  warnings: string[],
): Promise<string[]> {
  const personalDir = join(tempDir, 'personal')
  if (!existsSync(personalDir)) return []

  const restored = new Set<string>()
  const configDir = join(personalDir, 'config')

  if (_restoreBlobs(join(personalDir, 'blobs'), warnings) > 0) restored.add('会话原文')
  if (await _restorePlanningDatabase(configDir, warnings)) restored.add('规划与日程')

  const configFiles: Array<{ name: string; dest: string; section: string }> = [
    { name: 'automations.json', dest: getAutomationsPath(), section: '定时任务' },
    { name: 'agent-presets.json', dest: getAgentPresetsPath(), section: '预设与提示词' },
    { name: 'system-prompts.json', dest: getSystemPromptsPath(), section: '预设与提示词' },
    { name: 'browser-start-page.json', dest: getBrowserStartPagePath(), section: '浏览器起始页' },
    { name: 'recommendations.json', dest: getRecommendationsPath(), section: '主动建议' },
    { name: 'plugins.json', dest: getPluginsIndexPath(), section: '插件' },
    { name: 'plugin-permissions.json', dest: join(getConfigDir(), 'plugin-permissions.json'), section: '插件' },
    { name: 'scratch-pad.md', dest: getScratchPadPath(), section: '随手记' },
    { name: 'wechat.json', dest: getWeChatConfigPath(), section: 'IM 接入' },
    { name: 'dingtalk.json', dest: getDingTalkConfigPath(), section: 'IM 接入' },
    { name: 'feishu.json', dest: getFeishuConfigPath(), section: 'IM 接入' },
  ]

  if (existsSync(configDir)) {
    for (const name of readdirSync(configDir)) {
      if (!/^feishu-(?:bindings|metadata)-[\w-]+\.json$/u.test(name)) continue
      configFiles.push({ name, dest: join(getConfigDir(), name), section: 'IM 接入' })
    }
  }

  for (const file of configFiles) {
    const src = join(configDir, file.name)
    if (!existsSync(src)) continue
    if (_restoreFileWithBackup(src, file.dest, warnings, file.name)) restored.add(file.section)
  }

  const dirs: Array<{ name: string; dest: string; section: string }> = [
    { name: 'plugins', dest: join(getConfigDir(), 'plugins'), section: '插件' },
    { name: 'plugin-data', dest: join(getConfigDir(), 'plugin-data'), section: '插件数据' },
    { name: 'skins', dest: join(getConfigDir(), 'skins'), section: '皮肤' },
    { name: 'global-skills', dest: join(getConfigDir(), 'global-skills'), section: '全局 Skills' },
    { name: 'knowledge-base', dest: join(getConfigDir(), 'knowledge-base'), section: '个人资料库' },
    { name: 'attachments', dest: join(getConfigDir(), 'attachments'), section: '聊天附件' },
  ]

  for (const dir of dirs) {
    const src = join(configDir, dir.name)
    if (!existsSync(src)) continue
    if (_mergeDirectory(src, dir.dest, warnings) > 0) restored.add(dir.section)
  }

  for (const mapping of mappings) {
    const workspaceRoot = join(tempDir, 'workspaces', mapping.sourceSlug)
    if (!existsSync(workspaceRoot)) continue

    const filesDir = join(workspaceRoot, 'workspace-files')
    if (existsSync(filesDir) && _mergeDirectory(filesDir, getWorkspaceFilesDir(mapping.target.slug), warnings) > 0) {
      restored.add('工作区文件')
    }

    const memoryDir = join(workspaceRoot, 'memory')
    const memoryDest = join(getAgentWorkspacePath(mapping.target.slug), '.profer', 'memory')
    if (existsSync(memoryDir) && _mergeDirectory(memoryDir, memoryDest, warnings) > 0) {
      restored.add('工作区记忆')
    }

    const presetsSrc = join(workspaceRoot, 'config', 'agent-presets.json')
    if (existsSync(presetsSrc) && _restoreFileWithBackup(presetsSrc, getWorkspaceAgentPresetsPath(mapping.target.slug), warnings, '工作区预设')) {
      restored.add('工作区预设')
    }
  }

  return [...restored]
}

/** 会话原文按内容哈希回填；已有的同名 blob 说明内容一致，直接跳过。 */
function _restoreBlobs(blobsDir: string, warnings: string[]): number {
  if (!existsSync(blobsDir)) return 0
  let restored = 0

  for (const first of readdirSync(blobsDir, { withFileTypes: true })) {
    if (!first.isDirectory()) continue
    for (const second of readdirSync(join(blobsDir, first.name), { withFileTypes: true })) {
      if (!second.isDirectory()) continue
      for (const file of readdirSync(join(blobsDir, first.name, second.name), { withFileTypes: true })) {
        if (!file.isFile()) continue
        if (!/^[0-9a-f]{64}$/iu.test(file.name)) {
          warnings.push(`已跳过非法会话原文文件名: ${file.name}`)
          continue
        }
        const source = join(blobsDir, first.name, second.name, file.name)
        // 目标路径由哈希自身推导，不信任归档里的分片目录（防止借布局把文件写到别处）。
        const destination = blobPathFor(`sha256:${file.name.toLowerCase()}`)
        if (existsSync(destination)) continue
        try {
          mkdirSync(dirname(destination), { recursive: true })
          cpSync(source, destination)
          restored += 1
        } catch (error) {
          warnings.push(`未恢复会话原文 ${file.name}: ${formatErrorMessage(error)}`)
        }
      }
    }
  }

  return restored
}

/**
 * 替换规划数据库。
 * WAL 模式下只换 .db 不换 -wal 会让 SQLite 用旧日志回放新库，因此三者必须同进同退。
 */
async function _restorePlanningDatabase(configDir: string, warnings: string[]): Promise<boolean> {
  const sourceDb = join(configDir, 'planning.db')
  if (!existsSync(sourceDb)) return false

  const destinationDb = getPlanningDatabasePath()
  try {
    const { closePlanningDatabase, reloadPlanningDatabase } = await import('./planning-manager')
    closePlanningDatabase()
    try {
      if (existsSync(destinationDb)) _backupExistingFile(destinationDb)
      cpSync(sourceDb, destinationDb)

      for (const suffix of ['-wal', '-shm']) {
        const sourceSidecar = `${sourceDb}${suffix}`
        const destinationSidecar = `${destinationDb}${suffix}`
        if (existsSync(sourceSidecar)) {
          cpSync(sourceSidecar, destinationSidecar)
        } else {
          rmSync(destinationSidecar, { force: true })
        }
      }
    } finally {
      try {
        reloadPlanningDatabase()
      } catch (error) {
        // 重新打开失败不推翻已完成的数据替换；下次访问规划功能时会再次尝试。
        warnings.push(`规划数据库重新打开失败: ${formatErrorMessage(error)}`)
      }
    }
    return true
  } catch (error) {
    warnings.push(`未恢复规划与日程: ${formatErrorMessage(error)}`)
    return false
  }
}

function _restoreFileWithBackup(source: string, destination: string, warnings: string[], label: string): boolean {
  try {
    mkdirSync(dirname(destination), { recursive: true })
    if (existsSync(destination)) _backupExistingFile(destination)
    cpSync(source, destination)
    return true
  } catch (error) {
    warnings.push(`未恢复 ${label}: ${formatErrorMessage(error)}`)
    return false
  }
}

function _backupExistingFile(destination: string): void {
  const backupPath = `${destination}.backup-${Date.now()}-${randomUUID().slice(0, 6)}`
  try {
    cpSync(destination, backupPath)
  } catch {
    // 备份失败不阻断恢复：目标文件仍会被新内容替换，但至少不让整个导入失败。
  }
}

/** 目录合并：只补缺，不覆盖已有文件；返回新增文件数。 */
function _mergeDirectory(sourceDir: string, destinationDir: string, warnings: string[]): number {
  let copied = 0
  let entries: Dirent[]
  try {
    entries = readdirSync(sourceDir, { withFileTypes: true })
  } catch (error) {
    warnings.push(`无法读取待恢复目录 ${sourceDir}: ${formatErrorMessage(error)}`)
    return 0
  }

  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    const source = join(sourceDir, entry.name)
    const destination = join(destinationDir, entry.name)
    if (entry.isDirectory()) {
      copied += _mergeDirectory(source, destination, warnings)
      continue
    }
    if (!entry.isFile()) continue
    if (existsSync(destination)) continue
    try {
      mkdirSync(dirname(destination), { recursive: true })
      cpSync(source, destination)
      copied += 1
    } catch (error) {
      warnings.push(`未恢复 ${destination}: ${formatErrorMessage(error)}`)
    }
  }

  return copied
}

// ─── v2 导入辅助函数 ─────────────────────────────────────────────────────────

function _importSkillsV2(tempDir: string, sourceSlug: string, targetWorkspace: AgentWorkspace, overwrite = false) {
  const activeDir = join(tempDir, `workspaces/${sourceSlug}/skills/active`)
  if (existsSync(activeDir)) {
    const targetSkillsDir = getWorkspaceSkillsDir(targetWorkspace.slug)
    for (const entry of readdirSync(activeDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      assertSafeSkillSegment(entry.name, '导入 Skill slug')
      const dest = join(targetSkillsDir, entry.name)
      if (existsSync(dest)) {
        if (!overwrite) continue
        rmSync(dest, { recursive: true, force: true })
      }
      copySkillDirectorySafely(join(activeDir, entry.name), dest)
      ensureImportedWorkspaceSkillId(dest)
    }
  }

  const inactiveDir = join(tempDir, `workspaces/${sourceSlug}/skills/inactive`)
  if (existsSync(inactiveDir)) {
    const targetInactiveDir = getInactiveSkillsDir(targetWorkspace.slug)
    for (const entry of readdirSync(inactiveDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      assertSafeSkillSegment(entry.name, '导入 Skill slug')
      const dest = join(targetInactiveDir, entry.name)
      if (existsSync(dest)) {
        if (!overwrite) continue
        rmSync(dest, { recursive: true, force: true })
      }
      copySkillDirectorySafely(join(inactiveDir, entry.name), dest)
      ensureImportedWorkspaceSkillId(dest)
    }
  }
  _importSkillOverrides(join(tempDir, `workspaces/${sourceSlug}`), targetWorkspace, overwrite)
}

function _importMcpV2(tempDir: string, sourceSlug: string, targetWorkspace: AgentWorkspace, overwrite = false) {
  const srcMcp = join(tempDir, `workspaces/${sourceSlug}/config/mcp.json`)
  if (!existsSync(srcMcp)) return

  const destMcp = getWorkspaceMcpPath(targetWorkspace.slug)
  if (existsSync(destMcp)) {
    const existing = readJsonSafe<{ servers?: Record<string, unknown> }>(destMcp) ?? {}
    const imported = readJsonSafe<{ servers?: Record<string, unknown> }>(srcMcp) ?? {}
    const merged = overwrite
      ? { ...existing, servers: { ...existing.servers, ...imported.servers } }
      : { ...existing, servers: { ...imported.servers, ...existing.servers } }
    writeFileSync(destMcp, JSON.stringify(merged, null, 2), 'utf-8')
  } else {
    mkdirSync(getAgentWorkspacePath(targetWorkspace.slug), { recursive: true })
    cpSync(srcMcp, destMcp)
  }
}

function _importWorkspaceConfigV2(
  tempDir: string,
  sourceSlug: string,
  targetWorkspace: AgentWorkspace,
  pathMappings: Record<string, string | null>,
) {
  const srcConfig = join(tempDir, `workspaces/${sourceSlug}/config/workspace-config.json`)
  if (!existsSync(srcConfig)) return

  const config = readJsonSafe<{ attachedDirectories?: string[]; attachedFiles?: string[] }>(srcConfig)
  if (!config?.attachedDirectories && !config?.attachedFiles) return

  const newDirs: string[] = []
  for (const dir of config.attachedDirectories ?? []) {
    const mapped = pathMappings[dir]
    if (mapped === null) continue
    if (mapped !== undefined) {
      newDirs.push(mapped)
    } else if (existsSync(dir)) {
      newDirs.push(dir)
    }
  }
  const newFiles: string[] = []
  for (const file of config.attachedFiles ?? []) {
    const mapped = pathMappings[file]
    if (mapped === null) continue
    if (mapped !== undefined) {
      newFiles.push(mapped)
    } else if (existsSync(file)) {
      newFiles.push(file)
    }
  }

  const destConfigPath = join(getAgentWorkspacePath(targetWorkspace.slug), 'config.json')
  const existingConfig = existsSync(destConfigPath)
    ? readJsonSafe<{ attachedDirectories?: string[]; attachedFiles?: string[] }>(destConfigPath) ?? {}
    : {}
  const merged = {
    ...existingConfig,
    attachedDirectories: [...new Set([...(existingConfig.attachedDirectories ?? []), ...newDirs])],
    attachedFiles: [...new Set([...(existingConfig.attachedFiles ?? []), ...newFiles])],
  }
  writeFileSync(destConfigPath, JSON.stringify(merged, null, 2), 'utf-8')
}

async function _importSessionsV2(
  tempDir: string,
  wsIdMap: Map<string, AgentWorkspace>,
  fallbackWorkspace: AgentWorkspace,
  runtimeSessionFiles: Map<string, string> = new Map(),
) {
  const agentDir = join(tempDir, 'sessions/agent')
  const agentSessionsDir = getAgentSessionsDir()
  if (existsSync(agentDir)) {
    for (const file of readdirSync(agentDir)) {
      if (!file.endsWith('.jsonl')) continue
      const dest = join(agentSessionsDir, file)
      if (!existsSync(dest)) {
        cpSync(join(agentDir, file), dest)
      }
    }
  }

  const importedIndexPath = join(tempDir, 'sessions/agent-sessions-index.json')
  if (existsSync(importedIndexPath)) {
    const imported = readJsonSafe<{ sessions: Array<{ id: string; workspaceId: string; sdkSessionId?: string; agentRuntime?: string }> }>(importedIndexPath)
    const currentIndexPath = getAgentSessionsIndexPath()
    const current = readJsonSafe<{ version: number; sessions: Array<Record<string, unknown>> }>(currentIndexPath) ?? { version: 1, sessions: [] }
    const currentIds = new Set(current.sessions.map((s) => s['id']))

    const addedSessionIds = new Set<string>()
    const inlinePiStates = new Map<string, NonNullable<ReturnType<typeof splitInlinePiState>['inline']>>()
    for (const s of imported?.sessions ?? []) {
      if (currentIds.has(s.id)) continue
      const target = wsIdMap.get(s.workspaceId) ?? fallbackWorkspace
      const { inline, rest } = splitInlinePiState(s as Record<string, unknown>)
      if (inline) inlinePiStates.set(s.id, inline)
      current.sessions.push({
        ...rest,
        workspaceId: target.id,
        ...(s.agentRuntime === 'pi' ? { piSessionFile: s.sdkSessionId ? runtimeSessionFiles.get(s.sdkSessionId) : undefined } : {}),
      })
      addedSessionIds.add(s.id)
    }
    writeFileSync(currentIndexPath, JSON.stringify(current, null, 2), 'utf-8')
    mergePiStatesForImport(currentIndexPath, addedSessionIds, [
      inlinePiStates.size > 0 ? { version: 1, states: Object.fromEntries(inlinePiStates) } : null,
      readExportedPiState(tempDir),
    ])
  }

  const workspaceDataDir = join(tempDir, 'sessions/workspace-data')
  if (existsSync(workspaceDataDir)) {
    for (const sessionId of readdirSync(workspaceDataDir)) {
      const src = join(workspaceDataDir, sessionId)
      const dest = getAgentSessionWorkspacePath(fallbackWorkspace.slug, sessionId)
      if (!existsSync(dest)) {
        cpSync(src, dest, { recursive: true })
      }
    }
  }

  const chatDir = join(tempDir, 'sessions/chat')
  const convDir = getConversationsDir()
  if (existsSync(chatDir)) {
    for (const file of readdirSync(chatDir)) {
      if (!file.endsWith('.jsonl')) continue
      const dest = join(convDir, file)
      if (!existsSync(dest)) {
        cpSync(join(chatDir, file), dest)
      }
    }
  }

  const importedConvIndexPath = join(tempDir, 'sessions/conversations-index.json')
  if (existsSync(importedConvIndexPath)) {
    const imported = readJsonSafe<{ conversations: Array<{ id: string }> }>(importedConvIndexPath)
    const currentIndexPath = getConversationsIndexPath()
    const current = readJsonSafe<{ version: number; conversations: Array<{ id: string }> }>(currentIndexPath) ?? { version: 1, conversations: [] }
    const currentIds = new Set(current.conversations.map((c) => c.id))

    for (const c of imported?.conversations ?? []) {
      if (!currentIds.has(c.id)) {
        current.conversations.push(c)
      }
    }
    writeFileSync(currentIndexPath, JSON.stringify(current, null, 2), 'utf-8')
  }
}

// ─── 工具函数 ────────────────────────────────────────────────────────────────

function readJsonSafe<T>(filePath: string): T | null {
  if (!existsSync(filePath)) return null
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as T
  } catch {
    return null
  }
}

interface ExportReporter {
  setPhase(phase: ExportProgress['phase']): void
  setTotal(totalBytes: number): void
  onBytes(bytesWritten: number): void
  complete(): void
}

/** 进度上报：节流到 ~7 次/秒或每 1%，避免 GB 级导出把 IPC 淹没。 */
function createExportReporter(onProgress?: (progress: ExportProgress) => void): ExportReporter {
  let phase: ExportProgress['phase'] = 'preparing'
  let totalBytes = 0
  let bytesWritten = 0
  let lastEmitAt = 0
  let lastPercent = -1

  const emit = (force: boolean): void => {
    if (!onProgress) return
    const percent = totalBytes > 0 ? Math.min(99, Math.floor((bytesWritten / totalBytes) * 100)) : 0
    const now = Date.now()
    if (!force && now - lastEmitAt < 150 && percent === lastPercent) return
    lastEmitAt = now
    lastPercent = percent
    onProgress({ phase, percent, bytesWritten, totalBytes })
  }

  return {
    setPhase(next) {
      phase = next
      emit(true)
    },
    setTotal(next) {
      totalBytes = Math.max(0, next)
      emit(true)
    },
    onBytes(next) {
      bytesWritten = next
      emit(false)
    },
    complete() {
      phase = 'finalizing'
      onProgress?.({ phase, percent: 100, bytesWritten, totalBytes })
    },
  }
}

function _resolvePassphrase(mode: MigrationMode, passphrase: string | undefined): string | undefined {
  if (!passphrase) return undefined
  if (mode !== 'personal') throw new Error('只有个人备份支持口令加密')
  assertPassphrase(passphrase)
  return passphrase
}

/**
 * 导出总量估算：只走 stat，用于把「已写入字节」换成百分比。
 * 异步实现，避免几十万个文件的同步 stat 把主进程冻住。
 */
export async function estimatePersonalExportBytes(
  workspaces: AgentWorkspace[],
  components: MigrationComponent[] = ['sessions', 'skills', 'mcp', 'channels', 'chattools'],
): Promise<number> {
  let total = 0
  if (components.includes('sessions')) {
    total += await _sumBytes(getAgentSessionsDir()) + await _sumBytes(blobRootDir())
  }
  for (const workspace of workspaces) {
    total += await _sumBytes(getAgentWorkspacePath(workspace.slug))
  }
  for (const dir of _personalDirectorySources()) {
    total += await _sumBytes(dir.path)
  }
  return total
}

async function _sumBytes(target: string): Promise<number> {
  let isDirectory = false
  try {
    const stat = await fsp.stat(target)
    if (stat.isFile()) return stat.size
    isDirectory = stat.isDirectory()
  } catch {
    return 0
  }
  if (!isDirectory) return 0

  let entries: Dirent[]
  try {
    entries = await fsp.readdir(target, { withFileTypes: true })
  } catch {
    return 0
  }

  let total = 0
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) {
      if (BACKUP_EXCLUDED_DIRS.has(entry.name)) continue
      total += await _sumBytes(join(target, entry.name))
      continue
    }
    if (!entry.isFile() || BACKUP_EXCLUDED_FILES.has(entry.name) || entry.name.endsWith('.tmp')) continue
    try {
      total += (await fsp.stat(join(target, entry.name))).size
    } catch {
      // 边导出边变化的文件不计入估算
    }
  }
  return total
}

async function _finishExport(params: {
  writer: ZipStreamWriter
  stagingPath: string
  outputPath: string
  passphrase?: string
  warnings: string[]
  reporter: ExportReporter
}): Promise<ExportResult> {
  const { bytes, entries } = await params.writer.finalize()

  if (params.passphrase) {
    params.reporter.setPhase('encrypting')
    await encryptBackupFile(params.stagingPath, params.outputPath, params.passphrase)
    rmSync(params.stagingPath, { force: true })
  }

  params.reporter.complete()
  const uniqueWarnings = [...new Set(params.warnings)]
  return {
    success: true,
    filePath: params.outputPath,
    bytes,
    entries,
    encrypted: params.passphrase !== undefined,
    ...(uniqueWarnings.length > 0 ? { warnings: uniqueWarnings } : {}),
  }
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function addExportWarning(warnings: string[], message: string): void {
  warnings.push(message)
  console.warn(`[数据迁移] ${message}`)
}

/** 递归将本地目录的文件流式写入归档；跳过依赖/版本库等可重建目录。 */
async function _addDirToZip(
  writer: ZipStreamWriter,
  srcDir: string,
  zipPrefix: string,
  warnings: string[],
): Promise<void> {
  let entries: Dirent[]
  try {
    entries = readdirSync(srcDir, { withFileTypes: true })
  } catch (error) {
    addExportWarning(warnings, `已跳过无法读取的目录: ${srcDir} (${formatErrorMessage(error)})`)
    return
  }

  for (const entry of entries) {
    // 符号链接既不跟随也不打包：跟随可能形成环，也可能把备份带到工作区之外。
    if (entry.isSymbolicLink()) continue
    const fullPath = join(srcDir, entry.name)
    const entryZipPath = `${zipPrefix}/${entry.name}`
    if (entry.isDirectory()) {
      if (BACKUP_EXCLUDED_DIRS.has(entry.name)) continue
      await _addDirToZip(writer, fullPath, entryZipPath, warnings)
      continue
    }
    if (!entry.isFile() || BACKUP_EXCLUDED_FILES.has(entry.name) || entry.name.endsWith('.tmp')) continue
    try {
      await writer.addFile(fullPath, entryZipPath)
    } catch (error) {
      addExportWarning(warnings, `已跳过无法读取的备份项目: ${fullPath} (${formatErrorMessage(error)})`)
    }
  }
}

const WINDOWS_INVALID_ARCHIVE_SEGMENT = /[<>:"|?*\u0000-\u001f\u007f]/u
const WINDOWS_RESERVED_ARCHIVE_DEVICE = /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])$/iu

function assertWindowsSafeArchiveSegment(segment: string, entryName: string): void {
  if (WINDOWS_INVALID_ARCHIVE_SEGMENT.test(segment)) {
    throw new Error(`迁移文件包含 Windows 非法路径字符，已拒绝解压: ${entryName}`)
  }
  if (/[. ]$/u.test(segment)) {
    throw new Error(`迁移文件包含 Windows 尾随点或空格，已拒绝解压: ${entryName}`)
  }

  // Windows 的设备名即使带扩展名仍然保留；点前的尾随点/空格也会被 Win32 规范化掉。
  const deviceBase = segment.split('.', 1)[0]!.replace(/[. ]+$/u, '')
  if (WINDOWS_RESERVED_ARCHIVE_DEVICE.test(deviceBase)) {
    throw new Error(`迁移文件包含 Windows 保留设备名，已拒绝解压: ${entryName}`)
  }
}

/** 校验单个迁移压缩包条目，兼容 POSIX 与 Windows 路径语义。 */
export function assertSafeMigrationArchiveEntry(entryName: string, targetDir: string): void {
  if (typeof entryName !== 'string' || entryName.length === 0) {
    throw new Error('迁移文件包含空路径条目，已拒绝解压')
  }
  const resolvedTarget = resolve(targetDir)
  const entryPath = resolve(targetDir, entryName)
  const relativeEntryPath = relative(resolvedTarget, entryPath)
  const winEntryPath = win32.resolve(resolvedTarget, entryName)
  const winRelative = win32.relative(win32.resolve(resolvedTarget), winEntryPath)
  const entrySegments = entryName.replaceAll('\\', '/').split('/').filter(Boolean)
  const malformed = entrySegments.some((segment) => segment === '.' || segment === '..')
  const escaped = relativeEntryPath === '..' || relativeEntryPath.startsWith(`..${sep}`) || isAbsolute(relativeEntryPath)
    || winRelative === '..' || winRelative.startsWith(`..${win32.sep}`) || win32.isAbsolute(winRelative)
    || posix.isAbsolute(entryName) || win32.isAbsolute(entryName) || entryName.includes('\0') || malformed
  if (escaped) throw new Error(`迁移文件包含非法路径，已拒绝解压: ${entryName}`)
  for (const segment of entrySegments) assertWindowsSafeArchiveSegment(segment, entryName)
}

function windowsArchiveDestinationKey(entryName: string, targetDir: string): string {
  const windowsEntryName = entryName.replaceAll('/', '\\')
  // resolve 同时折叠重复分隔符；小写键模拟默认 Windows 卷的大小写不敏感语义。
  return win32.resolve(win32.resolve(targetDir), windowsEntryName).toLowerCase()
}

/** 解压前一次性验证所有条目，避免大小写或分隔符归一化后覆盖同一 Windows 路径。 */
export function assertSafeMigrationArchiveEntries(
  entries: readonly { entryName: string; isDirectory?: boolean }[],
  targetDir: string,
): void {
  const destinations = new Map<string, string>()
  for (const entry of entries) {
    assertSafeMigrationArchiveEntry(entry.entryName, targetDir)
    const destinationKey = windowsArchiveDestinationKey(entry.entryName, targetDir)
    const previous = destinations.get(destinationKey)
    if (previous !== undefined) {
      throw new Error(`迁移文件包含 Windows 路径冲突，已拒绝解压: ${previous} / ${entry.entryName}`)
    }
    destinations.set(destinationKey, entry.entryName)
  }
}
