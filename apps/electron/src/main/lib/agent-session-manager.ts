/**
 * Agent 会话管理器
 *
 * 负责 Agent 会话的 CRUD 操作和消息持久化。
 * - 会话索引：~/.proma/agent-sessions.json（轻量元数据）
 * - 消息存储：~/.proma/agent-sessions/{id}.jsonl（JSONL 格式，逐行追加）
 *
 * 照搬 conversation-manager.ts 的模式。
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, unlinkSync, rmSync, renameSync, readdirSync, cpSync, copyFileSync, createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { writeJsonFileAtomic, readJsonFileSafe } from './safe-file'
import { randomUUID } from 'node:crypto'
import { join, resolve, dirname } from 'node:path'
import {
  getAgentSessionsIndexPath,
  getAgentSessionsDir,
  getAgentSessionMessagesPath,
  getAgentSessionWorkspacePath,
  getAgentWorkspacePath,
  getSdkConfigDir,
} from './config-paths'
import { getAgentWorkspace, getWorkspaceAutoMemoryDir } from './agent-workspace-manager'

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
import type {
  AgentSessionMeta,
  AgentMessage,
  SDKMessage,
  ForkSessionInput,
  AgentMessageSearchResult,
  AgentSessionReferenceSearchInput,
  AgentSessionReferenceSearchResult,
  SessionHealth,
} from '@profer/shared'
import { getConversationMessages } from './conversation-manager'
import {
  parseEventsFromJsonl,
  serializeEvent,
} from '@profer/project-core'
// GPT Image 生图工具仅在 Chat 模式可用，Agent 模式不需要清理逻辑

/**
 * 会话索引文件格式
 */
interface AgentSessionsIndex {
  /** 配置版本号 */
  version: number
  /** 会话元数据列表 */
  sessions: AgentSessionMeta[]
}

/** 当前索引版本 */
const INDEX_VERSION = 1

/**
 * 读取会话索引文件
 */
function readIndex(): AgentSessionsIndex {
  const indexPath = getAgentSessionsIndexPath()
  const data = readJsonFileSafe<AgentSessionsIndex>(indexPath)
  if (data) return data
  return { version: INDEX_VERSION, sessions: [] }
}

/**
 * 写入会话索引文件
 */
function writeIndex(index: AgentSessionsIndex): void {
  const indexPath = getAgentSessionsIndexPath()

  try {
    writeJsonFileAtomic(indexPath, index)
  } catch (error) {
    console.error('[Agent 会话] 写入索引文件失败:', error)
    throw new Error('写入 Agent 会话索引失败')
  }
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
 * 获取所有会话（按 updatedAt 降序）
 */
export function listAgentSessions(): AgentSessionMeta[] {
  const index = readIndex()
  return index.sessions.sort((a, b) => b.updatedAt - a.updatedAt)
}

/**
 * 获取单个会话的元数据
 */
export function getAgentSessionMeta(id: string): AgentSessionMeta | undefined {
  const index = readIndex()
  return index.sessions.find((s) => s.id === id)
}

/**
 * 创建新会话
 */
export function createAgentSession(
  title?: string,
  channelId?: string,
  workspaceId?: string,
  modelId?: string,
): AgentSessionMeta {
  const index = readIndex()
  const now = Date.now()

  const meta: AgentSessionMeta = {
    id: randomUUID(),
    title: title || '新 Agent 会话',
    channelId,
    modelId,
    workspaceId,
    createdAt: now,
    updatedAt: now,
  }

  index.sessions.push(meta)
  writeIndex(index)

  // 确保消息目录存在
  getAgentSessionsDir()

  // 若有工作区，创建 session 级别子文件夹并初始化 .claude / .context
  if (workspaceId) {
    const ws = getAgentWorkspace(workspaceId)
    if (ws) {
      const sessionDir = getAgentSessionWorkspacePath(ws.slug, meta.id)

      // 初始化 .claude/settings.json（plansDirectory → .context）
      const claudeDir = join(sessionDir, '.claude')
      if (!existsSync(claudeDir)) mkdirSync(claudeDir, { recursive: true })
      const settingsPath = join(claudeDir, 'settings.json')
      let sdkSettings: Record<string, unknown> = {}
      try {
        sdkSettings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
      } catch { /* 文件不存在或解析失败 */ }
      let needsWrite = false
      if (sdkSettings.plansDirectory !== '.context') {
        sdkSettings.plansDirectory = '.context'
        needsWrite = true
      }
      if (sdkSettings.skipWebFetchPreflight !== true) {
        sdkSettings.skipWebFetchPreflight = true
        needsWrite = true
      }
      const autoMemoryDirectory = getWorkspaceAutoMemoryDir(ws.slug)
      if (sdkSettings.autoMemoryDirectory !== autoMemoryDirectory) {
        sdkSettings.autoMemoryDirectory = autoMemoryDirectory
        needsWrite = true
      }
      if (needsWrite) {
        writeFileSync(settingsPath, JSON.stringify(sdkSettings, null, 2))
      }

      // 初始化 .context/ 目录
      const contextDir = join(sessionDir, '.context')
      if (!existsSync(contextDir)) mkdirSync(contextDir, { recursive: true })
    }
  }

  console.log(`[Agent 会话] 已创建会话: ${meta.title} (${meta.id})`)
  return meta
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
    const messages: AgentMessage[] = []
    for (const line of lines) {
      try {
        messages.push(JSON.parse(line) as AgentMessage)
      } catch {
        // 单行损坏不丢整文件：跳过坏行继续解析后续
        console.warn(`[Agent 会话] 跳过损坏的消息行 (${id})`)
      }
    }
    return messages
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

  try {
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

/** 单条 SDKMessage 序列化后最大长度（UTF-16 code units，超出则截断内容） */
const MAX_SDK_MESSAGE_LENGTH = 256 * 1024 // ~256K chars
/** 截断后保留的预览文本长度 */
const TRUNCATED_PREVIEW_LENGTH = 2000

/**
 * 追加 SDKMessage 到会话的 JSONL 文件（Phase 4 新持久化格式）
 *
 * 每条 SDKMessage 单独一行 JSON。读取时通过 `type` 字段区分新旧格式。
 * 超过 256K chars 的消息会被自动截断以防止存储膨胀。
 */
export function appendSDKMessages(id: string, messages: SDKMessage[]): void {
  if (messages.length === 0) return

  const filePath = getAgentSessionMessagesPath(id)

  try {
    const lines = messages.map((m) => {
      const serialized = JSON.stringify(m)
      if (serialized.length <= MAX_SDK_MESSAGE_LENGTH) return serialized
      const sanitized = JSON.stringify(sanitizeOversizedMessage(m, serialized.length))
      if (sanitized.length > MAX_SDK_MESSAGE_LENGTH) {
        console.warn(`[Agent 会话] 消息截断后仍超限 (${(sanitized.length / 1024).toFixed(0)}K chars), session=${id}`)
      }
      return sanitized
    }).join('\n') + '\n'
    appendFileSync(filePath, lines, 'utf-8')
  } catch (error) {
    console.error(`[Agent 会话] 追加 SDKMessage 失败 (${id}):`, error)
    throw new Error('追加 SDKMessage 失败')
  }
}

/**
 * 截断超大 SDKMessage 的内容，保留元数据结构。
 * 处理三类膨胀源：超长 text block、超大 tool_result、内嵌 base64 图片。
 */
function sanitizeOversizedMessage(msg: SDKMessage, originalLength: number): SDKMessage {
  const truncationNote = `\n[内容已截断: 原始 ${(originalLength / 1024).toFixed(0)}K chars 超出存储限制]`
  const truncationThreshold = MAX_SDK_MESSAGE_LENGTH / 2

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const clone: any = JSON.parse(JSON.stringify(msg))
  const content = clone.message?.content
  if (Array.isArray(content)) {
    for (let i = 0; i < content.length; i++) {
      const block = content[i]
      if (!block || typeof block !== 'object') continue

      // 截断超长 text block
      if (block.type === 'text' && typeof block.text === 'string' && block.text.length > truncationThreshold) {
        block.text = block.text.slice(0, TRUNCATED_PREVIEW_LENGTH) + truncationNote
      }

      // 截断超大 tool_result
      if (block.type === 'tool_result') {
        if (typeof block.content === 'string' && block.content.length > truncationThreshold) {
          block.content = block.content.slice(0, TRUNCATED_PREVIEW_LENGTH) + truncationNote
        }
        // 剥离 base64 图片数据
        if (Array.isArray(block.content)) {
          block.content = block.content.map((item: Record<string, unknown>) => {
            if (item?.type === 'image' && (item.source as Record<string, unknown>)?.data) {
              const dataLen = String((item.source as Record<string, unknown>).data).length
              return { type: 'image', _truncated: true, _originalLength: dataLen }
            }
            return item
          })
        }
      }
    }
  }

  // 截断 error.message
  if (clone.error && typeof clone.error === 'object' && typeof clone.error.message === 'string' && clone.error.message.length > truncationThreshold) {
    clone.error.message = clone.error.message.slice(0, TRUNCATED_PREVIEW_LENGTH) + truncationNote
  }

  return clone as SDKMessage
}

/**
 * 读取会话的所有 SDKMessage（兼容旧 AgentMessage 格式）
 *
 * 旧格式（有 `role` 字段）会被转换为近似的 SDKMessage。
 * 新格式（有 `type` 字段）直接返回。
 */
export function getAgentSessionSDKMessages(id: string): SDKMessage[] {
  const filePath = getAgentSessionMessagesPath(id)

  if (!existsSync(filePath)) {
    return []
  }

  try {
    const raw = readFileSync(filePath, 'utf-8')
    const lines = raw.split('\n').filter((line) => line.trim())
    const messages: SDKMessage[] = []
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line)
        // 旧格式检测：AgentMessage 有 `role` 字段，SDKMessage 有 `type` 字段
        if ('role' in parsed && !('type' in parsed)) {
          messages.push(convertLegacyMessage(parsed as AgentMessage))
        } else {
          messages.push(parsed as SDKMessage)
        }
      } catch {
        // 单行损坏不丢整文件：跳过坏行继续解析后续
        console.warn(`[Agent 会话] 跳过损坏的 SDKMessage 行 (${id})`)
      }
    }
    return messages
  } catch (error) {
    console.error(`[Agent 会话] 读取 SDKMessage 文件失败 (${id}):`, error)
    return []
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
 * 更新会话元数据
 */
export function updateAgentSessionMeta(
  id: string,
  updates: Partial<Pick<AgentSessionMeta, 'title' | 'channelId' | 'modelId' | 'sdkSessionId' | 'workspaceId' | 'pinned' | 'archived' | 'attachedDirectories' | 'attachedFiles' | 'forkSourceDir' | 'forkSourceSdkSessionId' | 'resumeAtMessageUuid' | 'stoppedByUser' | 'permissionMode' | 'completedButUnconfirmed' | 'sourceAutomationId' | 'automationGraduated' | 'parentSessionId' | 'rootSessionId' | 'sourceDelegationId' | 'delegationRole' | 'delegationStatus' | 'delegationDepth' | 'delegationGoal' | 'lastAnalyzedTurn'>>,
): AgentSessionMeta {
  const index = readIndex()
  const idx = index.sessions.findIndex((s) => s.id === id)

  if (idx === -1) {
    throw new Error(`Agent 会话不存在: ${id}`)
  }

  const existing = index.sessions[idx]!
  // 非手动归档操作时，若会话已归档则自动恢复为活跃（仅更新 stoppedByUser 不触发解归档）
  const isStoppedByUserOnly = Object.keys(updates).every((k) => k === 'stoppedByUser')
  const autoUnarchive = existing.archived && !('archived' in updates) && !isStoppedByUserOnly
  const updated: AgentSessionMeta = {
    ...existing,
    ...updates,
    ...(autoUnarchive ? { archived: false } : {}),
    updatedAt: Date.now(),
  }

  index.sessions[idx] = updated
  writeIndex(index)

  console.log(`[Agent 会话] 已更新会话: ${updated.title} (${updated.id})`)
  return updated
}

/**
 * 删除会话
 */
export function deleteAgentSession(id: string): void {
  const index = readIndex()
  const idx = index.sessions.findIndex((s) => s.id === id)

  if (idx === -1) {
    console.warn(`[Agent 会话] 会话不存在，跳过删除: ${id}`)
    return
  }

  const removed = index.sessions.splice(idx, 1)[0]!
  writeIndex(index)

  // 删除消息文件
  const filePath = getAgentSessionMessagesPath(id)
  if (existsSync(filePath)) {
    try {
      unlinkSync(filePath)
    } catch (error) {
      console.warn(`[Agent 会话] 删除消息文件失败 (${id}):`, error)
    }
  }

  // 清理 session 工作目录
  if (removed.workspaceId) {
    const ws = getAgentWorkspace(removed.workspaceId)
    if (ws) {
      try {
        const sessionDir = getAgentSessionWorkspacePath(ws.slug, id)
        if (existsSync(sessionDir)) {
          rmSync(sessionDir, { recursive: true, force: true })
          console.log(`[Agent 会话] 已清理 session 工作目录: ${sessionDir}`)
        }
      } catch (error) {
        console.warn(`[Agent 会话] 清理 session 工作目录失败 (${id}):`, error)
      }
    }
  }

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
          rmSync(histDir, { recursive: true, force: true })
          console.log(`[Agent 会话] 已清理 file-history: ${sid}`)
        } catch (e) {
          console.warn(`[Agent 会话] 清理 file-history 失败 (${sid}):`, e)
        }
      }
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
                unlinkSync(sessionFile)
                console.log(`[Agent 会话] 已清理 SDK session 文件: ${sessionFile}`)
              } catch (e) {
                console.warn('[Agent 会话] 清理 SDK session 文件失败:', e)
              }
            }
          }
          try {
            if (readdirSync(projPath).length === 0) rmSync(projPath, { recursive: true })
          } catch { /* ignore */ }
        }
      } catch { /* ignore */ }
    }
  }
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
  const index = readIndex()
  const results: SessionHealth[] = []

  for (const session of index.sessions) {
    const health: SessionHealth = {
      sessionId: session.id,
      title: session.title,
      hasProferJsonl: false,
      hasSdkJsonl: false,
      hasWorkspaceDir: false,
      isOrphan: false,
    }

    // 检查 Profer JSONL
    health.hasProferJsonl = existsSync(getAgentSessionMessagesPath(session.id))

    // 检查 SDK JSONL
    if (session.sdkSessionId) {
      health.hasSdkJsonl = findSdkSessionJsonl(session.sdkSessionId) !== undefined
    }

    // 检查工作区目录
    if (session.workspaceId) {
      const ws = getAgentWorkspace(session.workspaceId)
      if (ws) {
        const dir = getAgentSessionWorkspacePath(ws.slug, session.id)
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
 * 迁移 Agent 会话到另一个工作区
 * 操作步骤：
 * 1. 验证会话和目标工作区存在
 * 2. 源 == 目标 → no-op
 * 3. 移动会话工作目录到目标工作区
 * 4. 更新元数据（workspaceId + 清空 sdkSessionId）
 * 5. JSONL 消息文件保持原位（全局目录）
 */
export function moveSessionToWorkspace(sessionId: string, targetWorkspaceId: string): AgentSessionMeta {
  const index = readIndex()
  const idx = index.sessions.findIndex((s) => s.id === sessionId)
  if (idx === -1) {
    throw new Error(`Agent 会话不存在: ${sessionId}`)
  }

  const session = index.sessions[idx]!

  // 源 == 目标 → 直接返回
  if (session.workspaceId === targetWorkspaceId) return session

  const targetWs = getAgentWorkspace(targetWorkspaceId)
  if (!targetWs) {
    throw new Error(`目标工作区不存在: ${targetWorkspaceId}`)
  }

  // 移动工作目录（如果源工作区存在）
  if (session.workspaceId) {
    const sourceWs = getAgentWorkspace(session.workspaceId)
    if (sourceWs) {
      const srcDir = join(getAgentWorkspacePath(sourceWs.slug), sessionId)
      if (existsSync(srcDir)) {
        const destDir = join(getAgentWorkspacePath(targetWs.slug), sessionId)
        // 清理已存在的空目标目录，防止 renameSync 抛出 ENOTEMPTY/EEXIST
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
        console.log(`[Agent 会话] 已移动工作目录: ${srcDir} → ${destDir}`)
      }
    }
  }

  // 确保目标工作区下有 session 目录
  getAgentSessionWorkspacePath(targetWs.slug, sessionId)

  // 更新元数据
  const updated: AgentSessionMeta = {
    ...session,
    workspaceId: targetWorkspaceId,
    sdkSessionId: undefined, // SDK 上下文与工作区 cwd 绑定，必须清空
    updatedAt: Date.now(),
  }
  index.sessions[idx] = updated
  writeIndex(index)

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
  const { sessionId, upToMessageUuid } = input

  // 1. 获取源会话元数据
  const sourceMeta = getAgentSessionMeta(sessionId)
  if (!sourceMeta) {
    throw new Error(`源 Agent 会话不存在: ${sessionId}`)
  }

  if (!sourceMeta.sdkSessionId) {
    throw new Error('该会话没有 SDK session，无法分叉')
  }

  // 2. 确定源会话的工作目录（SDK 需要从此目录的项目空间读取 session 文件）
  let sourceDir: string | undefined
  if (sourceMeta.workspaceId) {
    const ws = getAgentWorkspace(sourceMeta.workspaceId)
    if (ws) {
      sourceDir = getAgentSessionWorkspacePath(ws.slug, sessionId)
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
    // 4.4 计算 fork 目标会话的 cwd（新会话目录），后续多个步骤需要用到
    let destDir: string | undefined
    if (sourceDir && sourceMeta.workspaceId) {
      const ws = getAgentWorkspace(sourceMeta.workspaceId)
      if (ws) {
        destDir = getAgentSessionWorkspacePath(ws.slug, newMeta.id)
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
      const destProjectHash = destDir.replace(/[^a-zA-Z0-9]/g, '-')
      const sdkProjectsDir = join(getSdkConfigDir(), 'projects', destProjectHash)
      if (!existsSync(sdkProjectsDir)) mkdirSync(sdkProjectsDir, { recursive: true })
      const destJsonl = join(sdkProjectsDir, `${forkResult.sessionId}.jsonl`)
      copyFileSync(forkJsonlPath, destJsonl)
      rewritePathsInJsonlFile(destJsonl, sourceDir, destDir)
      console.log(`[Agent 会话] 已将 SDK session JSONL 复制到 fork 目标目录并改写路径: ${destJsonl}`)
    }

    // 5. 复制源会话工作区文件到新会话目录
    // 仅排除 .claude/（settings.json 启动时会重建）、.DS_Store、.git。
    // .context/ 必须保留 — Profer 约定 .context/note.md、todo.md、plan/ 等是会话上下文，
    // 如果不复制，fork 后这些参考资料会丢失或被 Claude 误回源目录读取。
    if (sourceDir && destDir) {
      if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true })
      try {
        const entries = readdirSync(sourceDir)
        const skip = (entry: string) => entry === '.claude' || entry === '.DS_Store' || entry === '.git'
        let copiedCount = 0
        for (const entry of entries) {
          if (skip(entry)) continue
          const srcPath = join(sourceDir, entry)
          const destPath = join(destDir, entry)
          cpSync(srcPath, destPath, { recursive: true })
          copiedCount += 1
        }
        console.log(`[Agent 会话] 已复制工作区文件: ${sourceDir} → ${destDir} (${copiedCount} 个条目)`)
      } catch (err) {
        // 工作区文件复制失败不触发回滚——fork 会话功能完整，仅缺上下文文件
        console.warn(`[Agent 会话] 复制工作区文件失败，fork 会话缺少源会话的上下文文件:`, err)
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

    console.log(`[Agent 会话] 分叉会话已创建（SDK 原生 fork）: ${sourceMeta.title} → ${forkTitle} (${messagesToCopy.length} 条消息, sdkSessionId=${forkResult.sessionId})`)
    return newMeta
  } catch (err) {
    // 回滚：删除已创建的 Profer 会话记录，避免孤儿条目
    console.error(`[Agent 会话] fork 关键步骤失败，回滚会话记录 (${newMeta.id}):`, err)
    try {
      deleteAgentSession(newMeta.id)
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
    renameSync(tmpPath, filePath)
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

/**
 * 从 SDK session JSONL 中查找指定 assistant message 之后最近的 user message UUID
 *
 * SDK session JSONL（~/.proma/sdk-config/projects/...）中的消息都带有 uuid，
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

    const isRealUserMessage = (m: Record<string, unknown>): boolean => {
      if (m.type !== 'user' || !m.uuid) return false
      const content = (m.message as { content?: Array<{ type: string }> } | undefined)?.content
      const hasToolResult = Array.isArray(content) && content.some((b) => b.type === 'tool_result')
      return !hasToolResult
    }

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
 * 在 SDK 项目目录中查找指定 session 的 JSONL 文件。
 *
 * @param sdkSessionId SDK session ID
 * @param projectDir 项目目录（可选，优先在此目录的哈希下查找）
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
 * 自动归档超过指定天数未更新的 Agent 会话
 *
 * 置顶会话不会被归档。
 *
 * @param daysThreshold 天数阈值
 * @returns 本次归档的会话数量
 */
export function autoArchiveAgentSessions(daysThreshold: number): number {
  const index = readIndex()
  const threshold = Date.now() - daysThreshold * 86_400_000
  let count = 0

  for (const session of index.sessions) {
    if (!session.pinned && !session.archived && session.updatedAt < threshold) {
      session.archived = true
      count++
    }
  }

  if (count > 0) {
    writeIndex(index)
    console.log(`[Agent 会话] 自动归档 ${count} 个会话（阈值: ${daysThreshold} 天）`)
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

  for (const session of index.sessions) {
    let changed = false

    if (session.attachedDirectories?.length) {
      const valid = session.attachedDirectories.filter((d) => existsSync(d))
      if (valid.length < session.attachedDirectories.length) {
        count += session.attachedDirectories.length - valid.length
        session.attachedDirectories = valid.length > 0 ? valid : undefined
        changed = true
      }
    }

    if (session.attachedFiles?.length) {
      const valid = session.attachedFiles.filter((f) => existsSync(f))
      if (valid.length < session.attachedFiles.length) {
        count += session.attachedFiles.length - valid.length
        session.attachedFiles = valid.length > 0 ? valid : undefined
        changed = true
      }
    }

    if (changed) {
      session.updatedAt = Date.now()
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

    const filePath = getAgentSessionMessagesPath(session.id)
    if (!existsSync(filePath)) continue

    const hit = await findFirstMatchInAgentJsonl(filePath, queryLower, query.length)
    if (hit) {
      results.push({
        sessionId: session.id,
        sessionTitle: session.title,
        messageId: hit.messageId,
        role: hit.role,
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
): Promise<{ messageId: string; role: AgentMessageSearchResult['role']; snippet: string; matchStart: number } | null> {
  const stream = createReadStream(filePath, { encoding: 'utf-8' })
  const rl = createInterface({ input: stream, crlfDelay: Infinity })

  try {
    for await (const line of rl) {
      if (!line.trim()) continue
      let parsed: {
        role?: string
        id?: string
        uuid?: string
        content?: unknown
        message?: { role?: string; id?: string; content?: Array<{ type: string; text?: string }> }
      }
      try {
        parsed = JSON.parse(line)
      } catch {
        continue
      }

      const rawRole = parsed.role ?? parsed.message?.role ?? 'assistant'
      // 收窄到 AgentMessageSearchResult.role 允许的联合类型；不在白名单的退化为 assistant
      const role: AgentMessageSearchResult['role'] =
        rawRole === 'user' || rawRole === 'assistant' || rawRole === 'tool' || rawRole === 'status'
          ? rawRole
          : 'assistant'
      const messageId = parsed.id ?? parsed.uuid ?? parsed.message?.id ?? ''

      let textContent = ''
      if (typeof parsed.content === 'string') {
        textContent = parsed.content
      } else if (Array.isArray(parsed.message?.content)) {
        textContent = parsed.message.content
          .filter((b) => b.type === 'text' && b.text)
          .map((b) => b.text!)
          .join('\n')
      }
      if (!textContent) continue

      const contentLower = textContent.toLowerCase()
      const matchIndex = contentLower.indexOf(queryLower)
      if (matchIndex === -1) continue

      const snippetStart = Math.max(0, matchIndex - 40)
      const snippetEnd = Math.min(textContent.length, matchIndex + queryLength + 40)
      const snippet = (snippetStart > 0 ? '...' : '') +
        textContent.slice(snippetStart, snippetEnd) +
        (snippetEnd < textContent.length ? '...' : '')
      const matchStart = matchIndex - snippetStart + (snippetStart > 0 ? 3 : 0)

      return { messageId, role, snippet, matchStart }
    }
    return null
  } finally {
    rl.close()
    stream.destroy()
  }
}

function extractTextFromPersistedMessage(parsed: unknown): string {
  if (!parsed || typeof parsed !== 'object') return ''
  const record = parsed as {
    content?: unknown
    message?: { content?: Array<{ type: string; text?: string }> }
  }

  if (typeof record.content === 'string') {
    return record.content
  }

  if (Array.isArray(record.message?.content)) {
    return record.message.content
      .filter((b) => b.type === 'text' && b.text)
      .map((b) => b.text!)
      .join('\n')
  }

  return ''
}

function createSnippet(text: string, matchIndex: number, matchLength: number): string {
  const snippetStart = Math.max(0, matchIndex - 48)
  const snippetEnd = Math.min(text.length, matchIndex + matchLength + 48)
  return (snippetStart > 0 ? '...' : '') +
    text.slice(snippetStart, snippetEnd) +
    (snippetEnd < text.length ? '...' : '')
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
