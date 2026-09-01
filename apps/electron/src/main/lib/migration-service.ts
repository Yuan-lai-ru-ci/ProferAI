/**
 * 数据迁移服务
 *
 * 支持两种导出模式：
 * - personal (.profer-backup)：个人全量备份，含解密后的 API Key 明文
 * - share (.profer-share)：团队分发，自由选择组件，凭据自动剥离
 *
 * 导入时自动检测跨平台差异并提示用户处理路径映射。
 */

import { existsSync, mkdirSync, cpSync, readFileSync, writeFileSync, readdirSync, rmSync, type Dirent } from 'node:fs'
import { join, resolve, relative, dirname, basename, isAbsolute, sep, win32, posix } from 'node:path'
import { homedir, platform, arch, tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import AdmZip from 'adm-zip'
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
} from './config-paths'
import { listAgentWorkspaces, getAgentWorkspace, getAllWorkspaceSkills, getWorkspaceMcpConfig } from './agent-workspace-manager'
import { listChannels, decryptApiKey } from './channel-manager'
import type { AgentWorkspace } from '@profer/shared'
import { writeJsonFileAtomic } from './safe-file'
import { assertSafeSkillSegment } from './skill-path-security'
import { copySkillDirectorySafely } from './global-skill-manager'

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
}

export interface ExportResult {
  success: boolean
  filePath: string
  warnings?: string[]
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

export interface ImportPreview {
  manifest: MigrationManifest
  agentSessionCount: number
  chatConversationCount: number
  skillNames: string[]
  hasMcp: boolean
  crossPlatform: boolean
  pathCheckResults: PathCheckResult[]
  tempDir: string
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
}

export interface ExportOptionsV2 {
  mode: MigrationMode
  components: MigrationComponent[]
  outputPath: string
  sessionIds?: string[]
  workspaceSelections?: WorkspaceSelection[]
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

export async function getExportPreview(workspaceId: string): Promise<ExportPreview> {
  const workspace = getAgentWorkspace(workspaceId) ?? null

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

  const zip = new AdmZip()

  if (components.includes('sessions')) {
    manifest.runtimeArtifacts = _addRuntimeArtifacts(
      zip,
      _collectRuntimeArtifactCandidates([workspace], sessionIds),
      warnings,
    )
    _addSessions(zip, workspace, sessionIds, warnings)
  }

  zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf-8'))
  if (components.includes('skills')) _addSkills(zip, workspace, warnings)
  if (components.includes('mcp')) _addMcp(zip, workspace, mode)
  if (components.includes('channels')) _addChannels(zip, mode)
  if (components.includes('chattools')) _addChatTools(zip, mode)
  _addWorkspaceConfig(zip, workspace)
  if (mode === 'personal') _addPersonalFiles(zip)

  zip.writeZip(outputPath)
  return buildExportResult(outputPath, warnings)
}

export async function exportDataV2(options: ExportOptionsV2): Promise<ExportResult> {
  const { mode, components, sessionIds, outputPath, workspaceSelections } = options
  const warnings: string[] = []

  const allWorkspaces = listAgentWorkspaces()
  const wsMap = new Map(allWorkspaces.map((w) => [w.id, w]))

  let targetWorkspaces: Array<{ workspace: AgentWorkspace; skillSlugs?: string[]; mcpServerNames?: string[] }>

  if (workspaceSelections && workspaceSelections.length > 0) {
    targetWorkspaces = workspaceSelections
      .map((sel) => {
        const ws = wsMap.get(sel.workspaceId)
        if (!ws) return null
        return { workspace: ws, skillSlugs: sel.skillSlugs, mcpServerNames: sel.mcpServerNames }
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
  } else {
    targetWorkspaces = allWorkspaces.map((ws) => ({ workspace: ws }))
  }

  if (targetWorkspaces.length === 0) throw new Error('没有可导出的工作区')

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

  const zip = new AdmZip()

  if (components.includes('sessions')) {
    manifest.runtimeArtifacts = _addRuntimeArtifacts(
      zip,
      _collectRuntimeArtifactCandidates(targetWorkspaces.map((t) => t.workspace), sessionIds),
      warnings,
    )
    _addSessionsMultiWorkspace(zip, targetWorkspaces.map((t) => t.workspace), sessionIds, warnings)
  }

  zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf-8'))

  if (components.includes('skills')) {
    for (const { workspace, skillSlugs } of targetWorkspaces) {
      _addSkillsV2(zip, workspace, skillSlugs, warnings)
    }
  }

  if (components.includes('mcp')) {
    for (const { workspace, mcpServerNames } of targetWorkspaces) {
      _addMcpV2(zip, workspace, mode, mcpServerNames)
    }
  }

  for (const { workspace } of targetWorkspaces) {
    _addWorkspaceConfigV2(zip, workspace)
  }

  if (components.includes('channels')) _addChannels(zip, mode)
  if (components.includes('chattools')) _addChatTools(zip, mode)
  if (mode === 'personal') _addPersonalFiles(zip)

  zip.writeZip(outputPath)
  return buildExportResult(outputPath, warnings)
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

function _addRuntimeArtifacts(
  zip: AdmZip,
  candidates: RuntimeArtifactCandidate[],
  warnings: string[],
): RuntimeArtifactsManifest {
  const refs: RuntimeArtifactsManifest = { claudeProjects: [], piSessions: [] }
  for (const candidate of candidates) {
    if (candidate.runtime === 'pi' || candidate.path.startsWith('runtime/pi/')) {
      try {
        zip.addLocalFile(candidate.sourcePath, 'runtime/pi', `${candidate.sessionId}.jsonl`)
        refs.piSessions.push({ sessionId: candidate.sessionId, proferSessionId: candidate.proferSessionId, path: candidate.path, workspaceId: candidate.workspaceId, runtime: 'pi' })
      } catch (error) {
        addExportWarning(warnings, `已跳过 Pi 原生会话: ${candidate.sourcePath} (${formatErrorMessage(error)})`)
      }
      continue
    }

    try {
      zip.addLocalFile(candidate.sourcePath, 'runtime/claude', `${candidate.sessionId}.jsonl`)
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

function _addSessions(zip: AdmZip, workspace: AgentWorkspace, filterIds: string[] | undefined, warnings: string[]) {
  const sessionsIndexPath = getAgentSessionsIndexPath()
  if (existsSync(sessionsIndexPath)) {
    const index = readJsonSafe<{ version: number; sessions: Array<{ id: string; workspaceId: string }> }>(sessionsIndexPath)
    const sessions = (index?.sessions ?? []).filter((s) => s.workspaceId === workspace.id)
    const targets = filterIds ? sessions.filter((s) => filterIds.includes(s.id)) : sessions
    const exportedIds = new Set<string>()

    for (const session of targets) {
      const msgPath = getAgentSessionMessagesPath(session.id)
      if (existsSync(msgPath)) {
        zip.addLocalFile(msgPath, 'sessions/agent')
        exportedIds.add(session.id)
      }
      const workDir = join(getAgentWorkspacePath(workspace.slug), session.id)
      if (existsSync(workDir)) {
        _addDirToZip(zip, workDir, `sessions/workspace-data/${session.id}`, warnings)
      }
    }

    if (index) {
      const filtered = { ...index, sessions: index.sessions.filter((s) => exportedIds.has(s.id)) }
      zip.addFile('sessions/agent-sessions-index.json', Buffer.from(JSON.stringify(filtered, null, 2), 'utf-8'))
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
        zip.addLocalFile(msgPath, 'sessions/chat')
      }
    }
    zip.addFile('sessions/conversations-index.json', Buffer.from(JSON.stringify({ ...index, conversations: targets }, null, 2), 'utf-8'))
  }
}

function _addSessionsMultiWorkspace(zip: AdmZip, workspaces: AgentWorkspace[], filterIds: string[] | undefined, warnings: string[]) {
  const wsIds = new Set(workspaces.map((w) => w.id))

  const sessionsIndexPath = getAgentSessionsIndexPath()
  if (existsSync(sessionsIndexPath)) {
    const index = readJsonSafe<{ version: number; sessions: Array<{ id: string; workspaceId: string }> }>(sessionsIndexPath)
    const sessions = (index?.sessions ?? []).filter((s) => wsIds.has(s.workspaceId))
    const targets = filterIds ? sessions.filter((s) => filterIds.includes(s.id)) : sessions
    const exportedIds = new Set<string>()

    for (const session of targets) {
      const msgPath = getAgentSessionMessagesPath(session.id)
      if (existsSync(msgPath)) {
        zip.addLocalFile(msgPath, 'sessions/agent')
        exportedIds.add(session.id)
      }
      const ws = workspaces.find((w) => w.id === session.workspaceId)
      if (ws) {
        const workDir = join(getAgentWorkspacePath(ws.slug), session.id)
        if (existsSync(workDir)) {
          _addDirToZip(zip, workDir, `sessions/workspace-data/${session.id}`, warnings)
        }
      }
    }

    if (index) {
      const filtered = { ...index, sessions: index.sessions.filter((s) => exportedIds.has(s.id)) }
      zip.addFile('sessions/agent-sessions-index.json', Buffer.from(JSON.stringify(filtered, null, 2), 'utf-8'))
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
        zip.addLocalFile(msgPath, 'sessions/chat')
      }
    }
    zip.addFile('sessions/conversations-index.json', Buffer.from(JSON.stringify({ ...index, conversations: targets }, null, 2), 'utf-8'))
  }
}

function _addSkills(zip: AdmZip, workspace: AgentWorkspace, warnings: string[]) {
  const skillsDir = getWorkspaceSkillsDir(workspace.slug)
  if (existsSync(skillsDir)) _addDirToZip(zip, skillsDir, 'skills/active', warnings)
  const inactiveDir = getInactiveSkillsDir(workspace.slug)
  if (existsSync(inactiveDir)) _addDirToZip(zip, inactiveDir, 'skills/inactive', warnings)
  const overridesPath = getWorkspaceSkillOverridesPath(workspace.slug)
  if (existsSync(overridesPath)) zip.addLocalFile(overridesPath, 'skills', 'skill-overrides.json')
}

function _addMcp(zip: AdmZip, workspace: AgentWorkspace, mode: MigrationMode) {
  const mcpPath = getWorkspaceMcpPath(workspace.slug)
  if (!existsSync(mcpPath)) return

  if (mode === 'share') {
    const config = readJsonSafe<Record<string, unknown>>(mcpPath)
    if (config) {
      zip.addFile('config/mcp.json', Buffer.from(JSON.stringify(_scrubMcpCredentials(config), null, 2), 'utf-8'))
    }
  } else {
    zip.addLocalFile(mcpPath, 'config')
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

function _addChannels(zip: AdmZip, mode: MigrationMode) {
  const channelsPath = getChannelsPath()
  if (!existsSync(channelsPath)) return

  if (mode === 'personal') {
    const channels = listChannels()
    const decrypted = channels.map((ch) => {
      try { return { ...ch, apiKey: decryptApiKey(ch.id) } }
      catch { return { ...ch, apiKey: '' } }
    })
    const config = readJsonSafe<{ version: number }>(channelsPath) ?? { version: 1 }
    zip.addFile('config/channels.json', Buffer.from(JSON.stringify({ ...config, channels: decrypted }, null, 2), 'utf-8'))
  } else {
    const channels = listChannels().map((ch) => ({ ...ch, apiKey: '' }))
    const config = readJsonSafe<{ version: number }>(channelsPath) ?? { version: 1 }
    zip.addFile('config/channels.json', Buffer.from(JSON.stringify({ ...config, channels }, null, 2), 'utf-8'))
  }
}

function _addChatTools(zip: AdmZip, mode: MigrationMode) {
  const toolsPath = getChatToolsConfigPath()
  if (!existsSync(toolsPath)) return

  if (mode === 'share') {
    const config = readJsonSafe<{ toolStates?: unknown; toolCredentials?: unknown; customTools?: unknown }>(toolsPath)
    if (config) {
      zip.addFile('config/chat-tools.json', Buffer.from(JSON.stringify({ ...config, toolCredentials: {} }, null, 2), 'utf-8'))
    }
  } else {
    zip.addLocalFile(toolsPath, 'config')
  }
}

function _addWorkspaceConfig(zip: AdmZip, workspace: AgentWorkspace) {
  const configPath = join(getAgentWorkspacePath(workspace.slug), 'config.json')
  if (existsSync(configPath)) {
    zip.addLocalFile(configPath, 'config', 'workspace-config.json')
  }
  zip.addFile('config/workspace-meta.json', Buffer.from(JSON.stringify(workspace, null, 2), 'utf-8'))
}

// ─── v2 导出辅助函数 ─────────────────────────────────────────────────────────

function _addSkillsV2(zip: AdmZip, workspace: AgentWorkspace, selectedSlugs: string[] | undefined, warnings: string[]) {
  const prefix = `workspaces/${workspace.slug}`
  const skillsDir = getWorkspaceSkillsDir(workspace.slug)
  if (existsSync(skillsDir)) {
    for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      assertSafeSkillSegment(entry.name, '导出 Skill slug')
      if (selectedSlugs && !selectedSlugs.includes(entry.name)) continue
      _addDirToZip(zip, join(skillsDir, entry.name), `${prefix}/skills/active/${entry.name}`, warnings)
    }
  }
  const inactiveDir = getInactiveSkillsDir(workspace.slug)
  if (existsSync(inactiveDir)) {
    for (const entry of readdirSync(inactiveDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      assertSafeSkillSegment(entry.name, '导出 Skill slug')
      if (selectedSlugs && !selectedSlugs.includes(entry.name)) continue
      _addDirToZip(zip, join(inactiveDir, entry.name), `${prefix}/skills/inactive/${entry.name}`, warnings)
    }
  }
  const overridesPath = getWorkspaceSkillOverridesPath(workspace.slug)
  if (existsSync(overridesPath)) zip.addLocalFile(overridesPath, `${prefix}/skills`, 'skill-overrides.json')
}

function _addMcpV2(zip: AdmZip, workspace: AgentWorkspace, mode: MigrationMode, selectedNames?: string[]) {
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
  zip.addFile(`${prefix}/config/mcp.json`, Buffer.from(JSON.stringify(output, null, 2), 'utf-8'))
}

function _addWorkspaceConfigV2(zip: AdmZip, workspace: AgentWorkspace) {
  const prefix = `workspaces/${workspace.slug}`
  const configPath = join(getAgentWorkspacePath(workspace.slug), 'config.json')
  if (existsSync(configPath)) {
    const content = readFileSync(configPath, 'utf-8')
    zip.addFile(`${prefix}/config/workspace-config.json`, Buffer.from(content, 'utf-8'))
  }
  zip.addFile(`${prefix}/config/workspace-meta.json`, Buffer.from(JSON.stringify(workspace, null, 2), 'utf-8'))
}

function _addPersonalFiles(zip: AdmZip) {
  const files: Array<[string, string, string]> = [
    [getSettingsPath(), 'auth', 'settings.json'],
    [getUserProfilePath(), 'auth', 'user-profile.json'],
    [join(getConfigDir(), 'cloud-auth.json'), 'auth', 'cloud-auth.json'],
  ]
  for (const [src, zipDir, zipName] of files) {
    if (existsSync(src)) zip.addLocalFile(src, zipDir, zipName)
  }
}

// ─── 导入（解析预览）────────────────────────────────────────────────────────

export async function parseImportFile(filePath: string): Promise<ImportPreview | ImportPreviewV2> {
  const tempDir = join(tmpdir(), `profer-import-${randomUUID()}`)
  mkdirSync(tempDir, { recursive: true })

  const zip = new AdmZip(filePath)
  _safeExtractAll(zip, tempDir)

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

    return {
      manifest,
      agentSessionCount,
      chatConversationCount,
      workspaces: wsPreviewList,
      crossPlatform,
      pathCheckResults,
      tempDir,
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

  return {
    manifest,
    agentSessionCount,
    chatConversationCount,
    skillNames,
    hasMcp,
    crossPlatform,
    pathCheckResults,
    tempDir,
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

export async function confirmImport(options: ConfirmImportOptions | ConfirmImportOptionsV2): Promise<{ success: boolean }> {
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
    if (manifest.mode === 'personal') {
      _importPersonalFiles(tempDir)
    }

    return { success: true }
  } finally {
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // 忽略清理失败
    }
  }
}

async function _confirmImportV2(options: ConfirmImportOptionsV2): Promise<{ success: boolean }> {
  const { tempDir, manifest, pathMappings, workspaceMappings, conflictResolution } = options
  const v2Manifest = manifest as MigrationManifestV2
  const overwrite = conflictResolution === 'overwrite'

  const { createAgentWorkspace } = await import('./agent-workspace-manager')

  const localWorkspaces = listAgentWorkspaces()
  const localBySlug = new Map(localWorkspaces.map((w) => [w.slug, w]))

  const resolvedMappings: Array<{ sourceSlug: string; target: AgentWorkspace }> = []

  if (workspaceMappings && workspaceMappings.length > 0) {
    for (const mapping of workspaceMappings) {
      if (mapping.action === 'skip') continue
      if (mapping.action === 'merge') {
        const target = mapping.targetWorkspaceId
          ? getAgentWorkspace(mapping.targetWorkspaceId)
          : localBySlug.get(mapping.sourceSlug)
        if (!target) continue
        resolvedMappings.push({ sourceSlug: mapping.sourceSlug, target })
      } else if (mapping.action === 'create') {
        const wsEntry = v2Manifest.workspaces.find((w) => w.workspaceSlug === mapping.sourceSlug)
        const name = mapping.newWorkspaceName ?? wsEntry?.workspaceName ?? mapping.sourceSlug
        const target = createAgentWorkspace(name)
        resolvedMappings.push({ sourceSlug: mapping.sourceSlug, target })
      }
    }
  } else {
    for (const wsEntry of v2Manifest.workspaces) {
      const local = localBySlug.get(wsEntry.workspaceSlug)
      if (local) {
        resolvedMappings.push({ sourceSlug: wsEntry.workspaceSlug, target: local })
      } else {
        const target = createAgentWorkspace(wsEntry.workspaceName)
        resolvedMappings.push({ sourceSlug: wsEntry.workspaceSlug, target })
      }
    }
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

  return { success: true }
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

    for (const s of imported?.sessions ?? []) {
      if (!currentIds.has(s.id)) {
        current.sessions.push({
          ...s,
          workspaceId: targetWorkspace.id,
          ...(s.agentRuntime === 'pi' ? { piSessionFile: s.sdkSessionId ? runtimeSessionFiles.get(s.sdkSessionId) : undefined } : {}),
        })
      }
    }
    writeFileSync(currentIndexPath, JSON.stringify(current, null, 2), 'utf-8')
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

    for (const s of imported?.sessions ?? []) {
      if (currentIds.has(s.id)) continue
      const target = wsIdMap.get(s.workspaceId) ?? fallbackWorkspace
      current.sessions.push({
        ...s,
        workspaceId: target.id,
        ...(s.agentRuntime === 'pi' ? { piSessionFile: s.sdkSessionId ? runtimeSessionFiles.get(s.sdkSessionId) : undefined } : {}),
      })
    }
    writeFileSync(currentIndexPath, JSON.stringify(current, null, 2), 'utf-8')
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

function buildExportResult(filePath: string, warnings: string[]): ExportResult {
  if (warnings.length === 0) return { success: true, filePath }
  return { success: true, filePath, warnings }
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function addExportWarning(warnings: string[], message: string): void {
  warnings.push(message)
  console.warn(`[数据迁移] ${message}`)
}

/** 递归将本地目录的所有文件加入 zip 指定前缀路径 */
function _addDirToZip(zip: AdmZip, srcDir: string, zipPrefix: string, warnings: string[]): void {
  let entries: Dirent[]
  try {
    entries = readdirSync(srcDir, { withFileTypes: true })
  } catch (error) {
    addExportWarning(warnings, `已跳过无法读取的目录: ${srcDir} (${formatErrorMessage(error)})`)
    return
  }

  for (const entry of entries) {
    const fullPath = join(srcDir, entry.name)
    const entryZipPath = `${zipPrefix}/${entry.name}`
    if (entry.isDirectory()) {
      _addDirToZip(zip, fullPath, entryZipPath, warnings)
    } else {
      try {
        zip.addLocalFile(fullPath, zipPrefix)
      } catch (error) {
        addExportWarning(warnings, `已跳过无法读取的备份项目: ${fullPath} (${formatErrorMessage(error)})`)
      }
    }
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
}

/** Zip Slip 安全解压：在委托 ZIP 库前逐条校验路径不会逃逸 targetDir。 */
function _safeExtractAll(zip: AdmZip, targetDir: string): void {
  for (const entry of zip.getEntries()) assertSafeMigrationArchiveEntry(entry.entryName, targetDir)
  zip.extractAllTo(targetDir, true)
}
