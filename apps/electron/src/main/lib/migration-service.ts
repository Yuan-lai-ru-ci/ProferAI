/**
 * 数据迁移服务
 *
 * 支持两种导出模式：
 * - personal (.proma-backup)：个人全量备份，含解密后的 API Key 明文
 * - share (.proma-share)：团队分发，自由选择组件，凭据自动剥离
 *
 * 导入时自动检测跨平台差异并提示用户处理路径映射。
 */

import { existsSync, mkdirSync, cpSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { homedir, platform, arch } from 'node:os'
import { tmpdir } from 'node:os'
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
  getAgentWorkspacesIndexPath,
  getAgentWorkspacePath,
  getAgentSessionWorkspacePath,
  getWorkspaceMcpPath,
  getWorkspaceSkillsDir,
  getInactiveSkillsDir,
  getSettingsPath,
  getUserProfilePath,
  getChatToolsConfigPath,
} from './config-paths'
import { listAgentWorkspaces, getAgentWorkspace } from './agent-workspace-manager'
import { listChannels, decryptApiKey } from './channel-manager'
import type { AgentWorkspace } from '@proma/shared'

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

export async function exportData(options: ExportOptions): Promise<{ success: boolean; filePath: string }> {
  const { mode, workspaceId, components, sessionIds, outputPath } = options

  const workspace = getAgentWorkspace(workspaceId)
  if (!workspace) throw new Error(`工作区不存在: ${workspaceId}`)

  const manifest: MigrationManifest = {
    mode,
    version: '1.0',
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

  zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf-8'))

  if (components.includes('sessions')) _addSessions(zip, workspace, sessionIds)
  if (components.includes('skills')) _addSkills(zip, workspace)
  if (components.includes('mcp')) _addMcp(zip, workspace, mode)
  if (components.includes('channels')) _addChannels(zip, mode)
  if (components.includes('chattools')) _addChatTools(zip, mode)
  _addWorkspaceConfig(zip, workspace)
  if (mode === 'personal') _addPersonalFiles(zip)

  zip.writeZip(outputPath)
  return { success: true, filePath: outputPath }
}

function _addSessions(zip: AdmZip, workspace: AgentWorkspace, filterIds?: string[]) {
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
        _addDirToZip(zip, workDir, `sessions/workspace-data/${session.id}`)
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

function _addSkills(zip: AdmZip, workspace: AgentWorkspace) {
  const skillsDir = getWorkspaceSkillsDir(workspace.slug)
  if (existsSync(skillsDir)) _addDirToZip(zip, skillsDir, 'skills/active')
  const inactiveDir = getInactiveSkillsDir(workspace.slug)
  if (existsSync(inactiveDir)) _addDirToZip(zip, inactiveDir, 'skills/inactive')
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

export async function parseImportFile(filePath: string): Promise<ImportPreview> {
  const tempDir = join(tmpdir(), `proma-import-${randomUUID()}`)
  mkdirSync(tempDir, { recursive: true })

  const zip = new AdmZip(filePath)
  _safeExtractAll(zip, tempDir)

  const manifestPath = join(tempDir, 'manifest.json')
  if (!existsSync(manifestPath)) {
    rmSync(tempDir, { recursive: true, force: true })
    throw new Error('无效的迁移文件：缺少 manifest.json')
  }

  const manifest = readJsonSafe<MigrationManifest>(manifestPath)
  if (!manifest) {
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

  const skillsDir = join(tempDir, 'skills/active')
  const skillNames: string[] = existsSync(skillsDir)
    ? readdirSync(skillsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
    : []

  const hasMcp = existsSync(join(tempDir, 'config/mcp.json'))
  const crossPlatform = manifest.sourcePlatform !== platform()
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

  const config = readJsonSafe<{ attachedDirectories?: string[] }>(configPath)
  if (!config?.attachedDirectories?.length) return []

  const currentHome = homedir()

  return config.attachedDirectories.map((p) => {
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

// ─── 导入（确认执行）────────────────────────────────────────────────────────

export async function confirmImport(options: ConfirmImportOptions): Promise<{ success: boolean }> {
  const { tempDir, manifest, targetWorkspaceId, createNewWorkspace, newWorkspaceName, pathMappings } = options

  try {
    // 确定目标工作区
    let targetWorkspace: AgentWorkspace | undefined
    if (createNewWorkspace) {
      const { createAgentWorkspace } = await import('./agent-workspace-manager')
      targetWorkspace = createAgentWorkspace(newWorkspaceName ?? manifest.workspaceName)
    } else if (targetWorkspaceId) {
      targetWorkspace = getAgentWorkspace(targetWorkspaceId)
    } else {
      const workspaces = listAgentWorkspaces()
      targetWorkspace = workspaces.find((w) => w.slug === manifest.workspaceSlug) ?? workspaces[0]
    }

    if (!targetWorkspace) throw new Error('无法确定目标工作区')

    // 导入 sessions
    if (manifest.components.includes('sessions')) {
      await _importSessions(tempDir, targetWorkspace)
    }

    // 导入 skills
    if (manifest.components.includes('skills')) {
      _importSkills(tempDir, targetWorkspace)
    }

    // 导入 mcp
    if (manifest.components.includes('mcp')) {
      _importMcp(tempDir, targetWorkspace)
    }

    // 导入 channels
    if (manifest.components.includes('channels')) {
      _importChannels(tempDir, manifest.mode)
    }

    // 导入 chattools
    if (manifest.components.includes('chattools')) {
      _importChatTools(tempDir)
    }

    // 导入 workspace config（处理路径映射）
    _importWorkspaceConfig(tempDir, targetWorkspace, pathMappings)

    // personal 模式：导入个人配置文件
    if (manifest.mode === 'personal') {
      _importPersonalFiles(tempDir)
    }

    return { success: true }
  } finally {
    // 清理临时目录
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // 忽略清理失败
    }
  }
}

async function _importSessions(tempDir: string, targetWorkspace: AgentWorkspace) {
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
    const imported = readJsonSafe<{ sessions: Array<{ id: string; workspaceId: string }> }>(importedIndexPath)
    const currentIndexPath = getAgentSessionsIndexPath()
    const current = readJsonSafe<{ version: number; sessions: Array<Record<string, unknown>> }>(currentIndexPath) ?? { version: 1, sessions: [] }
    const currentIds = new Set(current.sessions.map((s) => s['id']))

    for (const s of imported?.sessions ?? []) {
      if (!currentIds.has(s.id)) {
        current.sessions.push({ ...s, workspaceId: targetWorkspace.id })
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

function _importSkills(tempDir: string, targetWorkspace: AgentWorkspace) {
  const activeDir = join(tempDir, 'skills/active')
  if (existsSync(activeDir)) {
    const targetSkillsDir = getWorkspaceSkillsDir(targetWorkspace.slug)
    for (const skillName of readdirSync(activeDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)) {
      const src = join(activeDir, skillName)
      const dest = join(targetSkillsDir, skillName)
      if (!existsSync(dest)) {
        cpSync(src, dest, { recursive: true })
      }
    }
  }
}

function _importMcp(tempDir: string, targetWorkspace: AgentWorkspace) {
  const srcMcp = join(tempDir, 'config/mcp.json')
  if (!existsSync(srcMcp)) return
  const destMcp = getWorkspaceMcpPath(targetWorkspace.slug)
  // 合并已有 mcp.json 中没有的 server
  if (existsSync(destMcp)) {
    const existing = readJsonSafe<{ servers?: Record<string, unknown> }>(destMcp) ?? {}
    const imported = readJsonSafe<{ servers?: Record<string, unknown> }>(srcMcp) ?? {}
    const merged = { ...existing, servers: { ...imported.servers, ...existing.servers } }
    writeFileSync(destMcp, JSON.stringify(merged, null, 2), 'utf-8')
  } else {
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

  const config = readJsonSafe<{ attachedDirectories?: string[] }>(srcConfig)
  if (!config?.attachedDirectories) return

  // 应用路径映射
  const newDirs: string[] = []
  for (const dir of config.attachedDirectories) {
    const mapped = pathMappings[dir]
    if (mapped === null) continue // 用户选择移除
    if (mapped !== undefined) {
      newDirs.push(mapped) // 用户重新映射
    } else if (existsSync(dir)) {
      newDirs.push(dir) // 路径存在，直接保留
    }
    // 路径不存在且无映射：跳过（移除）
  }

  // 写入目标工作区 config
  const destConfigPath = join(getAgentWorkspacePath(targetWorkspace.slug), 'config.json')
  const existingConfig = existsSync(destConfigPath)
    ? readJsonSafe<{ attachedDirectories?: string[] }>(destConfigPath) ?? {}
    : {}
  const merged = { ...existingConfig, attachedDirectories: [...new Set([...(existingConfig.attachedDirectories ?? []), ...newDirs])] }
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

// ─── 工具函数 ────────────────────────────────────────────────────────────────

function readJsonSafe<T>(filePath: string): T | null {
  if (!existsSync(filePath)) return null
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as T
  } catch {
    return null
  }
}

/** 递归将本地目录的所有文件加入 zip 指定前缀路径 */
function _addDirToZip(zip: AdmZip, srcDir: string, zipPrefix: string): void {
  const entries = readdirSync(srcDir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = join(srcDir, entry.name)
    const entryZipPath = `${zipPrefix}/${entry.name}`
    if (entry.isDirectory()) {
      _addDirToZip(zip, fullPath, entryZipPath)
    } else {
      zip.addLocalFile(fullPath, zipPrefix)
    }
  }
}

/** Zip Slip 安全解压：校验每个条目的路径不会逃逸 targetDir */
function _safeExtractAll(zip: AdmZip, targetDir: string): void {
  const resolvedTarget = resolve(targetDir)
  for (const entry of zip.getEntries()) {
    const entryPath = resolve(targetDir, entry.entryName)
    if (!entryPath.startsWith(resolvedTarget + '/') && entryPath !== resolvedTarget) {
      throw new Error(`迁移文件包含非法路径，已拒绝解压: ${entry.entryName}`)
    }
  }
  zip.extractAllTo(targetDir, true)
}
