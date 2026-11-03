/**
 * 通用 Bridge 命令处理器
 *
 * 为微信、钉钉等平台提供统一的斜杠命令和 Agent 消息路由。
 * 各平台通过 BridgePlatformAdapter 接入，只需实现发送文本的方法。
 *
 * 飞书 Bridge 使用独立的卡片消息格式，暂不接入此模块。
 */

import { BrowserWindow } from 'electron'
import type { AgentExternalRunSource, AgentRuntime, AgentStreamPayload } from '@profer/shared'
import {
  AGENT_IPC_CHANNELS,
  isChannelEnabledForRuntime,
  isVisibleAgentSession,
  normalizeAgentRuntime,
  resolveAgentAttachmentPrompt,
} from '@profer/shared'
import { createAgentSession, listAgentSessions, getAgentSessionMeta } from './agent-session-manager'
import {
  listAgentWorkspacesByUpdatedAt,
  getAgentWorkspace,
  getWorkspaceCapabilities,
} from './agent-workspace-manager'
import { runAgentHeadless, agentEventBus, stopAgent, isAgentSessionActive } from './agent-service'
import { getSettings } from './settings-service'
import { resolveWorkspaceFilesDir } from './config-paths'
import { buildAttachedFilesBlock, buildSessionFileTree, buildFileTree } from './bridge-attachment-utils'
import {
  listSwitchableChannels,
  getEnabledModels,
  resolveChannelByIndex,
  resolveModelByIndex,
  describeBindingModel,
  describeAgentRuntime,
  resolveChannelIdForRuntime,
  resolveModelIdForChannel,
  type RuntimeChannelSelection,
} from './bridge-model-utils'

// ===== 接口定义 =====

/** 平台适配器 — 各 Bridge 只需实现此接口 */
export interface BridgePlatformAdapter {
  /** 发送纯文本回复。meta 是平台专属的上下文数据（如微信的 contextToken） */
  sendText(chatId: string, text: string, meta?: unknown): Promise<void>
  /**
   * 发送富文本卡片（可选）。
   *
   * 只有同时提供本方法与 `BridgeCommandHandlerConfig.renderers` 的平台才会走卡片路径；
   * 其余平台保持纯文本，行为不变。
   */
  sendCard?(chatId: string, card: BridgeCard, meta?: unknown): Promise<void>
}

/** 平台私有卡片结构。公共层不解释其内容，只负责传递。 */
export type BridgeCard = unknown

/** /list 中的单条会话 */
export interface BridgeSessionItem {
  /** 完整会话 ID */
  id: string
  /** 全局序号（与 /switch 的序号一致） */
  index: number
  title: string
  /** 会话 ID 前 8 位 */
  idPrefix: string
  /** 是否为当前绑定的会话 */
  active: boolean
}

/** /list 中的工作区分组（含“未分配工作区”伪分组） */
export interface BridgeSessionGroup {
  /** 工作区 ID；伪分组为空串 */
  id: string
  name: string
  sessions: BridgeSessionItem[]
}

/** /workspace 列表项 */
export interface BridgeWorkspaceItem {
  index: number
  name: string
  isCurrent: boolean
}

/** /model 渠道列表项 */
export interface BridgeChannelItem {
  index: number
  name: string
  modelCount: number
  isCurrent: boolean
}

/** /model 模型列表项 */
export interface BridgeModelItem {
  index: number
  name: string
  isCurrent: boolean
}

/** /now 的结构化快照 */
export interface BridgeNowSnapshot {
  session?: { title: string; idPrefix: string }
  model?: { channelName: string; modelName: string; valid: boolean }
  runtimeLabel?: string
  workspace?: { name: string; slug: string }
  mcpServers: Array<{ name: string; enabled: boolean }>
  skills: Array<{ name: string; enabled: boolean }>
  workspaceFiles: string[]
  sessionFiles: string[]
}

/**
 * 可选渲染钩子。
 *
 * 钩子返回 `null`/`undefined` 时回退到纯文本；只有同时提供 `adapter.sendCard` 时生效。
 * 平台可按需实现其中任意几个，未实现的命令继续走文本。
 */
export interface BridgeCommandRenderers {
  help?(): BridgeCard | null
  sessionList?(input: { groups: BridgeSessionGroup[]; currentWorkspaceId?: string }): BridgeCard | null
  workspaceList?(input: { items: BridgeWorkspaceItem[]; currentWorkspaceId?: string }): BridgeCard | null
  workspaceSwitched?(input: { workspaceName: string; recentSessions: BridgeSessionItem[] }): BridgeCard | null
  now?(snapshot: BridgeNowSnapshot): BridgeCard | null
  channelList?(input: { runtimeLabel: string; items: BridgeChannelItem[] }): BridgeCard | null
  modelList?(input: { channelName: string; channelIndex: number; items: BridgeModelItem[] }): BridgeCard | null
  modelSwitched?(input: { channelName: string; modelName: string }): BridgeCard | null
}

/** 已保存到磁盘的附件引用，由各 Bridge 预处理后传入 handler */
export interface BridgeAttachment {
  /** 附件绝对路径 */
  absolutePath: string
  /** 在 <attached_files> 中显示的标签 */
  label: string
  /** 附件类型，用于未来扩展路由（当前仅信息） */
  kind: 'image' | 'file'
}

/** 命令处理器配置 */
export interface BridgeCommandHandlerConfig {
  /** 平台名称，用于日志（如 '微信', '钉钉'） */
  platformName: string
  /**
   * 该平台对应的 headless run 来源。
   *
   * **必填**：它是「未读产生 / 不清未读」口径的来源信号（`resolveRunInitiator` 把
   * `feishu | dingtalk | wechat | bridge` 一律解析为 `'external'`）。旧实现的 `?? 'bridge'`
   * 兜底会把所有平台记成 "bridge"，让下游无法区分来源，也无法把未读口径建立在它上面。
   */
  source: AgentExternalRunSource
  /** 平台适配器 */
  adapter: BridgePlatformAdapter
  /** 获取默认工作区 ID */
  getDefaultWorkspaceId?: () => string | undefined
  /** 工作区切换后的回调 */
  onWorkspaceSwitched?: (workspaceId: string) => void
  /** 可选渲染钩子：实现后该命令改发卡片，否则保持纯文本 */
  renderers?: BridgeCommandRenderers
  /**
   * 绑定写入前的补充钩子。
   *
   * 飞书用它补 `botId/userId/chatType/groupName/source` 等平台字段；`contextData` 是调用方透传的平台上下文。
   */
  enrichBinding?: (binding: BridgeChatBinding, contextData?: unknown) => void
  /** 绑定新增 / 删除 / 字段变更后触发（飞书用它落盘并推送状态） */
  afterBindingChanged?: () => void
  /** 停止 Agent 之后触发（飞书用它标记流式卡片中断） */
  afterStop?: (sessionId: string) => void
  /** 平台级默认渠道（飞书 Bot 的 defaultChannelId）；缺省用全局 agentChannelId */
  getPreferredChannelId?: () => string | undefined
  /** 平台级默认模型（飞书 Bot 的 defaultModelId）；缺省用全局 agentModelId */
  getPreferredModelId?: () => string | undefined
  /** `/now` 文件树的图标（飞书传空串，保持卡片内无 emoji） */
  fileTreeOptions?: { dirIcon?: string; fileIcon?: string }
  /**
   * 全局默认工作区也为空时的最后兜底（飞书用它回退到 default 或最近工作区）。
   * 不提供时保持原有行为：建无工作区会话。
   */
  fallbackWorkspaceId?: () => string | undefined
  /**
   * 自定义新会话标题。不提供时为 `title || '新会话'`；
   * 飞书传 `(title) => title`，保持“首轮后自动生成标题”的原有行为。
   */
  sessionTitle?: (title?: string) => string | undefined
  /**
   * 可注入的绑定存储。
   *
   * 平台已经有自己的绑定 Map（如飞书的 `chatBindings`）时传进来，保证命令处理与
   * 消息路由读写的是同一份数据；不传则内部新建。
   */
  bindings?: Map<string, BridgeChatBinding>
  /** 可注入的反向索引（sessionId → chatId），与 `bindings` 配套使用 */
  sessionToChat?: Map<string, string>
}

/** 通用聊天绑定 */
export interface BridgeChatBinding {
  chatId: string
  sessionId: string
  workspaceId: string
  channelId: string
  modelId?: string
  /**
   * 会话使用的 Agent 内核。
   *
   * 可选：旧持久化数据里没有该字段，读取时按
   * `binding.agentRuntime ?? getAgentSessionMeta(sessionId)?.agentRuntime ?? 全局设置` 回退，
   * 避免把老会话误判成 Claude 内核。
   */
  agentRuntime?: AgentRuntime
}

/** Agent 回复缓冲 */
interface SessionBuffer {
  text: string
  chatId: string
  contextData: unknown
  startedAt: number
}

/**
 * 建 Agent 会话失败（工作区根被移走、目录不可写等）。
 *
 * 与「未配置渠道」不同：这是可解释的配置/环境错误，调用方必须把原因回给用户，
 * 不能静默丢弃（IM 里表现为「已读不回」，只能翻控制台才看得到）。
 */
export class BridgeSessionCreationError extends Error {
  constructor(readonly detail: string, options?: { cause?: unknown }) {
    super(detail, options)
    this.name = 'BridgeSessionCreationError'
  }
}

/** 把任意建会话异常归一成 BridgeSessionCreationError（保留原始信息）。 */
export function toBridgeSessionCreationError(error: unknown): BridgeSessionCreationError {
  if (error instanceof BridgeSessionCreationError) return error
  return new BridgeSessionCreationError(
    error instanceof Error ? error.message : String(error),
    { cause: error },
  )
}

/** Agent SDK 消息中的内容块 */
interface ContentBlock {
  type: string
  text?: string
}

/** Agent SDK assistant 消息结构 */
interface AssistantMessagePayload {
  message?: {
    content?: ContentBlock[]
  }
}

// ===== 命令处理器实现 =====

export class BridgeCommandHandler {
  private readonly config: BridgeCommandHandlerConfig
  private readonly log: (msg: string) => void

  /** chatId → 聊天绑定（可由平台注入，与平台共享同一份数据） */
  private chatBindings: Map<string, BridgeChatBinding>
  /** sessionId → chatId（反向索引，可由平台注入） */
  private sessionToChat: Map<string, string>
  /** sessionId → 回复缓冲 */
  private sessionBuffers = new Map<string, SessionBuffer>()
  /** EventBus 取消订阅 */
  private eventBusUnsubscribe: (() => void) | null = null

  constructor(config: BridgeCommandHandlerConfig) {
    this.config = config
    this.chatBindings = config.bindings ?? new Map<string, BridgeChatBinding>()
    this.sessionToChat = config.sessionToChat ?? new Map<string, string>()
    this.log = (msg: string) => console.log(`[${config.platformName} Bridge] ${msg}`)
  }

  // ===== 公开 API =====

  /** 处理收到的消息（自动区分命令 vs 普通消息） */
  async handleIncomingMessage(
    chatId: string,
    text: string,
    contextData?: unknown,
    attachments?: BridgeAttachment[],
  ): Promise<void> {
    try {
      if (text.trimStart().startsWith('/')) {
        // 命令消息不携带附件（附件由 Bridge 缓冲，等普通消息触发）
        await this.handleCommand(chatId, text, contextData)
      } else {
        await this.handleUserMessage(chatId, text, contextData, attachments)
      }
    } catch (error) {
      // 建会话失败必须回一条可见原因；其它异常保持原有抛给平台层的行为。
      if (await this.reportSessionCreationError(chatId, error, contextData)) return
      throw error
    }
  }

  /**
   * 建会话失败时给用户一条可见原因。
   *
   * @returns 已处理（已发出提示）返回 true；不是建会话错误返回 false，由调用方继续抛出。
   */
  async reportSessionCreationError(
    chatId: string,
    error: unknown,
    contextData?: unknown,
  ): Promise<boolean> {
    if (!(error instanceof BridgeSessionCreationError)) return false
    await this.send(
      chatId,
      `⚠️ 无法创建 Agent 会话：${error.detail}\n\n`
      + '请检查当前工作区目录是否存在（项目工作区被移动/删除后需要重新定位），'
      + '或用 /workspace 切换到其它工作区。',
      contextData,
    )
    return true
  }

  /**
   * 获取或自动创建 chatId 对应的 binding
   * 用于 Bridge 在保存图片/文件前预先拿到 sessionId 和 workspaceId
   * 如果未配置 Agent 渠道，返回 null
   */
  ensureBinding(chatId: string, contextData?: unknown): BridgeChatBinding | null {
    const existing = this.chatBindings.get(chatId)
    if (existing) return existing

    const settings = getSettings()
    const preferredChannelId = this.config.getPreferredChannelId?.() ?? settings.agentChannelId
    if (!preferredChannelId) return null

    const agentRuntime = normalizeAgentRuntime(settings.agentRuntime)
    const picked = resolveChannelIdForRuntime(preferredChannelId, agentRuntime)
    if (!picked) return null
    const channelId = picked.channelId
    const modelId = resolveModelIdForChannel(
      channelId,
      picked.fellBack ? undefined : this.config.getPreferredModelId?.() ?? settings.agentModelId,
    )

    const workspaceId = this.config.getDefaultWorkspaceId?.() ?? settings.agentWorkspaceId ?? this.config.fallbackWorkspaceId?.() ?? ''

    const sessionTitle = this.config.sessionTitle
      ? this.config.sessionTitle()
      : `${this.config.platformName}会话`
    let session
    try {
      session = createAgentSession(
        sessionTitle,
        channelId,
        workspaceId || undefined,
        modelId,
        agentRuntime,
      )
    } catch (error) {
      // 建会话失败（典型：project 工作区目录被移走）不能静默：交给调用方转成可见提示。
      const failure = toBridgeSessionCreationError(error)
      this.log(`创建会话失败: ${failure.detail}`)
      throw failure
    }

    const binding: BridgeChatBinding = {
      chatId,
      sessionId: session.id,
      workspaceId,
      channelId,
      modelId,
      agentRuntime,
    }
    this.config.enrichBinding?.(binding, contextData)
    this.chatBindings.set(chatId, binding)
    this.sessionToChat.set(session.id, chatId)
    this.config.afterBindingChanged?.()
    this.log(`为 ${chatId.slice(0, 8)}... 创建会话: ${session.id.slice(0, 8)}`)
    this.notifySessionCreated(session.id, session.title)
    return binding
  }

  /** 检查指定 chatId 的 session 是否正在运行 */
  isSessionActive(chatId: string): boolean {
    const binding = this.chatBindings.get(chatId)
    if (!binding) return false
    return isAgentSessionActive(binding.sessionId)
  }

  /** 订阅 Agent EventBus（Bridge 连接建立后调用） */
  subscribe(): void {
    this.eventBusUnsubscribe?.()
    this.eventBusUnsubscribe = agentEventBus.on((sessionId, payload) => {
      this.handleAgentPayload(sessionId, payload)
    })
  }

  /** 取消订阅（Bridge 断开时调用） */
  unsubscribe(): void {
    this.eventBusUnsubscribe?.()
    this.eventBusUnsubscribe = null
    this.sessionBuffers.clear()
  }

  /** 获取聊天绑定 */
  getBinding(chatId: string): BridgeChatBinding | undefined {
    return this.chatBindings.get(chatId)
  }

  /** 清理所有状态 */
  clear(): void {
    this.chatBindings.clear()
    this.sessionToChat.clear()
    this.sessionBuffers.clear()
  }

  // ===== 命令路由 =====

  private async handleCommand(chatId: string, text: string, contextData?: unknown): Promise<void> {
    const [command, ...args] = text.split(/\s+/)
    const arg = args.join(' ').trim()

    switch (command?.toLowerCase()) {
      case '/help':
      case '/h':
        await this.sendHelp(chatId, contextData)
        break

      case '/new':
      case '/n':
        await this.createNewSession(chatId, arg || undefined, contextData)
        break

      case '/list':
      case '/ls':
        await this.handleListCommand(chatId, contextData)
        break

      case '/stop':
      case '/s':
        await this.handleStopCommand(chatId, contextData)
        break

      case '/switch':
      case '/sw':
        if (!arg) {
          await this.send(chatId, '用法: /switch <序号>（先用 /list 查看）', contextData)
          return
        }
        await this.handleSwitchCommand(chatId, arg, contextData)
        break

      case '/workspace':
      case '/ws':
        await this.handleWorkspaceCommand(chatId, arg || undefined, contextData)
        break

      case '/now':
        await this.handleNowCommand(chatId, contextData)
        break

      case '/model':
      case '/m':
        await this.handleModelCommand(chatId, arg, contextData)
        break

      default:
        await this.send(chatId, `未知命令: ${command}。输入 /help 查看帮助。`, contextData)
    }
  }

  /**
   * 解析某个 chat 当前应使用的 Agent 内核。
   *
   * 顺序：binding（建会话时写入） > 会话元数据（旧 binding 无字段时推导） > 全局设置。
   */
  private resolveChatRuntime(binding?: BridgeChatBinding): AgentRuntime {
    const sessionRuntime = binding ? getAgentSessionMeta(binding.sessionId)?.agentRuntime : undefined
    return normalizeAgentRuntime(binding?.agentRuntime ?? sessionRuntime ?? getSettings().agentRuntime)
  }

  /**
   * 为指定内核挑选建会话用的渠道。
   *
   * 默认渠道与内核不兼容时回退到第一个可用渠道（并在回复里说明），
   * 避免建出「一发送就报内核不匹配」的会话。
   */
  private pickChannelForRuntime(agentRuntime: AgentRuntime): RuntimeChannelSelection | null {
    return resolveChannelIdForRuntime(getSettings().agentChannelId, agentRuntime)
  }

  /** 回退到其它渠道时的提示语 */
  private describeChannelFallback(agentRuntime: AgentRuntime): string {
    return `⚠️ 默认渠道未启用 ${describeAgentRuntime(agentRuntime)} 内核，已自动改用其它可用渠道。可用 /model 重新选择。`
  }

  // ===== 命令实现 =====

  private async sendHelp(chatId: string, contextData?: unknown): Promise<void> {
    if (await this.trySendCard(chatId, this.config.renderers?.help?.(), contextData)) return
    const lines = [
      '📋 可用命令（斜杠后为简写）:',
      '',
      '/help (/h) — 显示此帮助',
      '/new (/n) [标题] — 创建新 Agent 会话',
      '/list (/ls) — 列出所有会话',
      '/switch (/sw) <序号> — 切换到指定会话',
      '/stop (/s) — 停止当前 Agent',
      '/workspace (/ws) [名称] — 查看或切换工作区',
      '/model (/m) [渠道 [模型]] — 查看或切换渠道/模型',
      '/now — 查看当前状态',
    ]
    await this.send(chatId, lines.join('\n'), contextData)
  }

  private async createNewSession(chatId: string, title?: string, contextData?: unknown): Promise<void> {
    const settings = getSettings()
    const preferredChannelId = this.config.getPreferredChannelId?.() ?? settings.agentChannelId
    if (!preferredChannelId) {
      await this.send(chatId, '请先在 Profer 设置中选择 Agent 渠道。', contextData)
      return
    }

    // 会话内核跟随全局设置，不能隐式退回 Claude（Pi-only 渠道会发送失败）
    const agentRuntime = normalizeAgentRuntime(settings.agentRuntime)
    const picked = resolveChannelIdForRuntime(preferredChannelId, agentRuntime)
    if (!picked) {
      await this.send(
        chatId,
        `暂无同时启用 ${describeAgentRuntime(agentRuntime)} 内核的可用渠道，请先在 Profer 渠道设置中启用。`,
        contextData,
      )
      return
    }
    const channelId = picked.channelId
    const modelId = resolveModelIdForChannel(
      channelId,
      picked.fellBack ? undefined : this.config.getPreferredModelId?.() ?? settings.agentModelId,
    )

    // 确定工作区
    const workspaceId = this.config.getDefaultWorkspaceId?.() ?? settings.agentWorkspaceId ?? this.config.fallbackWorkspaceId?.() ?? ''

    let session
    try {
      session = createAgentSession(
        this.config.sessionTitle ? this.config.sessionTitle(title) : title || '新会话',
        channelId,
        workspaceId || undefined,
        modelId,
        agentRuntime,
      )
    } catch (error) {
      if (await this.reportSessionCreationError(chatId, toBridgeSessionCreationError(error), contextData)) return
      throw error
    }

    // 清理旧绑定
    const oldBinding = this.chatBindings.get(chatId)
    if (oldBinding) {
      this.sessionToChat.delete(oldBinding.sessionId)
    }

    const binding: BridgeChatBinding = {
      chatId,
      sessionId: session.id,
      workspaceId,
      channelId,
      modelId,
      agentRuntime,
    }
    this.config.enrichBinding?.(binding, contextData)
    this.chatBindings.set(chatId, binding)
    this.sessionToChat.set(session.id, chatId)
    this.config.afterBindingChanged?.()

    // 通知渲染进程刷新会话列表
    this.notifySessionCreated(session.id, session.title)

    const fallbackNotice = picked.fellBack ? `\n${this.describeChannelFallback(agentRuntime)}` : ''
    await this.send(
      chatId,
      `✅ 已创建 Agent 会话: ${session.title} (${session.id.slice(0, 8)})${fallbackNotice}`,
      contextData,
    )
  }

  private async handleListCommand(chatId: string, contextData?: unknown): Promise<void> {
    const sessions = listAgentSessions(true).filter(isVisibleAgentSession)
    const workspaces = listAgentWorkspacesByUpdatedAt()
    const binding = this.chatBindings.get(chatId)

    if (sessions.length === 0) {
      await this.send(chatId, '暂无会话。发送消息将自动创建，或使用 /new 创建。', contextData)
      return
    }

    const MAX_PER_WS = 5

    const toItem = (s: (typeof sessions)[number]): BridgeSessionItem => ({
      id: s.id,
      index: sessions.indexOf(s) + 1,
      title: s.title,
      idPrefix: s.id.slice(0, 8),
      active: binding?.sessionId === s.id,
    })

    // 先组装与平台无关的分组结构，卡片与文本共用同一份数据
    const groups: BridgeSessionGroup[] = []
    for (const ws of workspaces) {
      const wsSessions = sessions
        .filter((s) => s.workspaceId === ws.id)
        .slice(0, MAX_PER_WS)

      if (wsSessions.length === 0) continue
      groups.push({ id: ws.id, name: ws.name, sessions: wsSessions.map(toItem) })
    }

    // 未归属工作区的会话
    const orphans = sessions
      .filter((s) => !s.workspaceId || !workspaces.some((w) => w.id === s.workspaceId))
      .slice(0, MAX_PER_WS)

    if (orphans.length > 0) {
      groups.push({ id: '', name: '未分配工作区', sessions: orphans.map(toItem) })
    }

    const card = this.config.renderers?.sessionList?.({
      groups,
      currentWorkspaceId: binding?.workspaceId,
    })
    if (await this.trySendCard(chatId, card, contextData)) return

    const lines: string[] = ['📋 会话列表:']
    for (const group of groups) {
      lines.push('')
      lines.push(`【${group.name}】`)
      for (const s of group.sessions) {
        lines.push(`  ${s.index}. ${s.title} (${s.idPrefix})${s.active ? ' ← 当前' : ''}`)
      }
    }

    lines.push('')
    lines.push('使用 /switch <序号> 切换会话')

    await this.send(chatId, lines.join('\n'), contextData)
  }

  private async handleStopCommand(chatId: string, contextData?: unknown): Promise<void> {
    const binding = this.chatBindings.get(chatId)
    if (!binding) {
      await this.send(chatId, '当前没有绑定的会话。', contextData)
      return
    }
    stopAgent(binding.sessionId)
    this.config.afterStop?.(binding.sessionId)
    await this.send(chatId, '✅ 已停止 Agent', contextData)
  }

  private async handleSwitchCommand(chatId: string, arg: string, contextData?: unknown): Promise<void> {
    const sessions = listAgentSessions(true).filter(isVisibleAgentSession)
    const settings = getSettings()

    // 支持序号和 ID 前缀两种匹配
    const index = Number(arg)
    const match = Number.isInteger(index) && index >= 1 && index <= sessions.length
      ? sessions[index - 1]
      : sessions.find((s) => s.id.startsWith(arg))

    if (!match) {
      await this.send(chatId, `未找到会话。使用 /list 查看可用会话。`, contextData)
      return
    }

    // 清理旧绑定
    const oldBinding = this.chatBindings.get(chatId)
    if (oldBinding) {
      this.sessionToChat.delete(oldBinding.sessionId)
    }

    // 会话内核以会话元数据为准（切换到的会话可能本来就是 Pi 会话）
    const agentRuntime = normalizeAgentRuntime(match.agentRuntime ?? settings.agentRuntime)
    // 会话历史渠道可能未启用该内核，此时回退到第一个可用渠道，避免切过去就发送失败
    const preferredChannelId = match.channelId ?? this.config.getPreferredChannelId?.() ?? settings.agentChannelId ?? ''
    const picked = preferredChannelId
      ? resolveChannelIdForRuntime(preferredChannelId, agentRuntime)
      : null
    if (!picked) {
      await this.send(
        chatId,
        `会话「${match.title}」使用 ${describeAgentRuntime(agentRuntime)} 内核，但暂无同时启用该内核的可用渠道，请先在 Profer 渠道设置中启用。`,
        contextData,
      )
      return
    }

    const binding: BridgeChatBinding = {
      chatId,
      sessionId: match.id,
      workspaceId: match.workspaceId ?? this.config.getDefaultWorkspaceId?.() ?? settings.agentWorkspaceId ?? '',
      channelId: picked.channelId,
      // 优先保留目标会话自己的模型；不属于回退渠道时取该渠道第一个启用模型。
      modelId: resolveModelIdForChannel(
        picked.channelId,
        match.modelId ?? this.config.getPreferredModelId?.() ?? settings.agentModelId,
      ),
      agentRuntime,
    }
    this.config.enrichBinding?.(binding, contextData)
    this.chatBindings.set(chatId, binding)
    this.sessionToChat.set(match.id, chatId)
    this.config.afterBindingChanged?.()

    const fallbackNotice = picked.fellBack ? `\n${this.describeChannelFallback(agentRuntime)}` : ''
    await this.send(
      chatId,
      `✅ 已切换到会话: ${match.title} (${match.id.slice(0, 8)})${fallbackNotice}`,
      contextData,
    )
  }

  private async handleWorkspaceCommand(chatId: string, arg?: string, contextData?: unknown): Promise<void> {
    const workspaces = listAgentWorkspacesByUpdatedAt()
    const binding = this.chatBindings.get(chatId)
    const currentWorkspaceId = binding?.workspaceId

    // 无参数 → 列出
    if (!arg) {
      if (workspaces.length === 0) {
        await this.send(chatId, '暂无工作区。', contextData)
        return
      }

      const items: BridgeWorkspaceItem[] = workspaces.map((w, i) => ({
        index: i + 1,
        name: w.name,
        isCurrent: w.id === currentWorkspaceId,
      }))

      const card = this.config.renderers?.workspaceList?.({ items, currentWorkspaceId })
      if (await this.trySendCard(chatId, card, contextData)) return

      const lines = ['📋 工作区列表:']
      for (const item of items) {
        lines.push(`  ${item.index}. ${item.name}${item.isCurrent ? ' ← 当前' : ''}`)
      }
      lines.push('')
      lines.push('使用 /workspace <序号或名称> 切换')
      await this.send(chatId, lines.join('\n'), contextData)
      return
    }

    // 支持序号和名称匹配
    const index = Number(arg)
    const match = Number.isInteger(index) && index >= 1 && index <= workspaces.length
      ? workspaces[index - 1]
      : workspaces.find(
          (w) => w.name.toLowerCase() === arg.toLowerCase() || w.slug === arg.toLowerCase(),
        )

    if (!match) {
      const available = workspaces.map((w, i) => `${i + 1}. ${w.name}`).join(', ')
      await this.send(chatId, `未找到工作区 "${arg}"。可用: ${available}`, contextData)
      return
    }

    // 清理旧绑定（切换工作区后需要新建会话）
    if (binding) {
      this.sessionToChat.delete(binding.sessionId)
      this.chatBindings.delete(chatId)
      this.config.afterBindingChanged?.()
    }

    // 通知平台持久化
    this.config.onWorkspaceSwitched?.(match.id)

    // 列出该工作区下最近会话
    const sessions = listAgentSessions(true).filter(isVisibleAgentSession)
    const recentSessions = sessions
      .filter((s) => s.workspaceId === match.id)
      .slice(0, 5)

    const recentItems: BridgeSessionItem[] = recentSessions.map((s) => ({
      id: s.id,
      index: sessions.indexOf(s) + 1,
      title: s.title,
      idPrefix: s.id.slice(0, 8),
      active: false,
    }))

    const card = this.config.renderers?.workspaceSwitched?.({
      workspaceName: match.name,
      recentSessions: recentItems,
    })
    if (await this.trySendCard(chatId, card, contextData)) return

    const lines = [`✅ 已切换到工作区: ${match.name}`]
    if (recentItems.length > 0) {
      lines.push('')
      lines.push('最近会话:')
      for (const s of recentItems) {
        lines.push(`  ${s.index}. ${s.title} (${s.idPrefix})`)
      }
      lines.push('')
      lines.push('使用 /switch <序号> 切换，或发送消息自动创建新会话')
    } else {
      lines.push('该工作区暂无会话，发送消息将自动创建。')
    }

    await this.send(chatId, lines.join('\n'), contextData)
  }

  private async handleNowCommand(chatId: string, contextData?: unknown): Promise<void> {
    const binding = this.chatBindings.get(chatId)

    // 先组装结构化快照，卡片与文本共用同一份数据
    const snapshot: BridgeNowSnapshot = {
      mcpServers: [],
      skills: [],
      workspaceFiles: [],
      sessionFiles: [],
    }

    if (binding) {
      const session = getAgentSessionMeta(binding.sessionId)
      const nowSettings = getSettings()
      // 与发送路径同序解析：binding > 应用设置
      const effChannelId = binding.channelId || this.config.getPreferredChannelId?.() || nowSettings.agentChannelId
      const effModelId = binding.modelId ?? this.config.getPreferredModelId?.() ?? nowSettings.agentModelId
      const modelInfo = describeBindingModel(effChannelId, effModelId)
      snapshot.session = { title: session?.title ?? '未知', idPrefix: binding.sessionId.slice(0, 8) }
      snapshot.model = {
        channelName: modelInfo.channelName,
        modelName: modelInfo.modelName,
        valid: modelInfo.valid,
      }
      snapshot.runtimeLabel = describeAgentRuntime(this.resolveChatRuntime(binding))
    }

    // 工作区信息
    const workspaceId = binding?.workspaceId
    const workspace = workspaceId ? getAgentWorkspace(workspaceId) : undefined
    if (workspace) {
      snapshot.workspace = { name: workspace.name, slug: workspace.slug }

      const capabilities = getWorkspaceCapabilities(workspace.slug)
      snapshot.mcpServers = capabilities.mcpServers.map((mcp) => ({
        name: mcp.name,
        enabled: mcp.enabled !== false,
      }))
      snapshot.skills = capabilities.skills.map((skill) => ({
        name: skill.name,
        enabled: skill.enabled !== false,
      }))

      // 工作区文件（递归，体现文件夹-文件层级）
      try {
        const wsPath = resolveWorkspaceFilesDir(workspace.slug)
        snapshot.workspaceFiles = buildFileTree(wsPath, this.config.fileTreeOptions)
      } catch {
        // 忽略
      }

      // 会话文件（体现文件夹-文件层级）
      if (binding) {
        try {
          snapshot.sessionFiles = buildSessionFileTree(
            workspace.slug,
            binding.sessionId,
            this.config.fileTreeOptions,
          )
        } catch {
          // 忽略
        }
      }
    }

    const card = this.config.renderers?.now?.(snapshot)
    if (await this.trySendCard(chatId, card, contextData)) return

    const lines: string[] = ['📊 当前状态:']
    if (snapshot.session && snapshot.model) {
      lines.push(`会话: ${snapshot.session.title} (${snapshot.session.idPrefix})`)
      lines.push(
        `模型: ${snapshot.model.channelName} / ${snapshot.model.modelName}${snapshot.model.valid ? '' : '（已失效）'}`,
      )
      lines.push(`内核: ${snapshot.runtimeLabel}`)
    } else {
      lines.push('会话: 未绑定（发送消息将自动创建）')
    }

    if (snapshot.workspace) {
      lines.push(`工作区: ${snapshot.workspace.name} (${snapshot.workspace.slug})`)

      if (snapshot.mcpServers.length > 0) {
        lines.push('')
        lines.push('MCP Servers:')
        for (const mcp of snapshot.mcpServers) {
          lines.push(`  ${mcp.enabled ? '✅' : '⏸️'} ${mcp.name}`)
        }
      }

      if (snapshot.skills.length > 0) {
        lines.push('')
        lines.push('Skills:')
        for (const skill of snapshot.skills) {
          lines.push(`  ${skill.enabled ? '✅' : '⏸️'} ${skill.name}`)
        }
      }

      if (snapshot.workspaceFiles.length > 0) {
        lines.push('')
        lines.push('工作区文件:')
        for (const l of snapshot.workspaceFiles) {
          lines.push(`  ${l}`)
        }
      }

      if (snapshot.sessionFiles.length > 0) {
        lines.push('')
        lines.push('会话文件:')
        for (const l of snapshot.sessionFiles) {
          lines.push(`  ${l}`)
        }
      }
    } else {
      lines.push('工作区: 未设置')
    }

    await this.send(chatId, lines.join('\n'), contextData)
  }

  /**
   * /model 命令：罗列渠道 / 罗列模型 / 切换模型（per-chat）
   * - /model            列出可用渠道
   * - /model <渠道序号>  列出该渠道下的模型
   * - /model <渠道> <模型> 切换到该渠道的该模型
   */
  private async handleModelCommand(chatId: string, arg: string, contextData?: unknown): Promise<void> {
    const binding = this.chatBindings.get(chatId)
    // 渠道列表必须按当前会话内核过滤：否则会把 Pi 会话切到只勾了 Claude 的渠道
    const agentRuntime = this.resolveChatRuntime(binding)
    const runtimeLabel = describeAgentRuntime(agentRuntime)
    const channels = listSwitchableChannels(agentRuntime)
    if (channels.length === 0) {
      await this.send(
        chatId,
        `当前会话使用 ${runtimeLabel} 内核，暂无同时启用该内核的可用渠道。请先在 Profer 设置中配置并启用渠道（需填入 API Key、至少启用一个模型，并勾选 ${runtimeLabel} 内核）。`,
        contextData,
      )
      return
    }

    const parts = arg.split(/\s+/).filter(Boolean)

    // /model — 列出渠道
    if (parts.length === 0) {
      const items: BridgeChannelItem[] = channels.map((c, i) => ({
        index: i + 1,
        name: c.name,
        modelCount: getEnabledModels(c).length,
        isCurrent: binding?.channelId === c.id,
      }))

      const card = this.config.renderers?.channelList?.({ runtimeLabel, items })
      if (await this.trySendCard(chatId, card, contextData)) return

      const lines = [`📡 可用渠道（当前内核: ${runtimeLabel}）:`]
      for (const item of items) {
        lines.push(`  ${item.index}. ${item.name}（${item.modelCount} 个模型）${item.isCurrent ? ' ← 当前' : ''}`)
      }
      lines.push('')
      lines.push('使用 /model <渠道序号> 查看模型')
      await this.send(chatId, lines.join('\n'), contextData)
      return
    }

    // 解析渠道（序号基于上面已过滤的列表，与用户看到的一致）
    const channelIdx = Number(parts[0])
    const channel = resolveChannelByIndex(channelIdx, agentRuntime)
    if (!channel) {
      await this.send(
        chatId,
        `未找到渠道 "${parts[0]}"（当前内核: ${runtimeLabel}）。使用 /model 查看可用渠道。`,
        contextData,
      )
      return
    }

    // 防御：列表与切换之间渠道配置可能被改，明确拒绝而不是静默失败
    if (!isChannelEnabledForRuntime(channel, agentRuntime)) {
      await this.send(
        chatId,
        `渠道「${channel.name}」未启用 ${runtimeLabel} 内核，无法用于当前会话。请选择其它渠道，或在 Profer 渠道设置中启用 ${runtimeLabel} 内核。`,
        contextData,
      )
      return
    }

    const models = getEnabledModels(channel)

    // /model <渠道> — 列出该渠道模型
    if (parts.length === 1) {
      const items: BridgeModelItem[] = models.map((m, i) => ({
        index: i + 1,
        name: m.name,
        isCurrent: binding?.channelId === channel.id && binding?.modelId === m.id,
      }))

      const card = this.config.renderers?.modelList?.({
        channelName: channel.name,
        channelIndex: channelIdx,
        items,
      })
      if (await this.trySendCard(chatId, card, contextData)) return

      const lines = [`🤖 ${channel.name} 的可用模型:`]
      for (const item of items) {
        lines.push(`  ${item.index}. ${item.name}${item.isCurrent ? ' ← 当前' : ''}`)
      }
      lines.push('')
      lines.push(`使用 /model ${channelIdx} <模型序号> 切换`)
      await this.send(chatId, lines.join('\n'), contextData)
      return
    }

    // /model <渠道> <模型> — 切换
    const modelIdx = Number(parts[1])
    const model = resolveModelByIndex(channel, modelIdx)
    if (!model) {
      await this.send(
        chatId,
        `未找到模型 "${parts[1]}"。使用 /model ${channelIdx} 查看该渠道的模型。`,
        contextData,
      )
      return
    }

    // 切换需要一个 binding 承载；没有则自动创建
    let targetBinding = this.chatBindings.get(chatId)
    if (!targetBinding) {
      targetBinding = this.ensureBinding(chatId, contextData) ?? undefined
      if (!targetBinding) {
        await this.send(chatId, '请先发送一条消息创建会话，或在 Profer 设置中选择 Agent 渠道。', contextData)
        return
      }
    }

    targetBinding.channelId = channel.id
    targetBinding.modelId = model.id
    this.config.afterBindingChanged?.()

    const switchedCard = this.config.renderers?.modelSwitched?.({
      channelName: channel.name,
      modelName: model.name,
    })
    if (await this.trySendCard(chatId, switchedCard, contextData)) return

    await this.send(
      chatId,
      `✅ 已切换模型: ${channel.name} / ${model.name}\n（注：重启应用后会恢复默认渠道设置）`,
      contextData,
    )
  }

  // ===== Agent 消息路由 =====

  private async handleUserMessage(
    chatId: string,
    text: string,
    contextData?: unknown,
    attachments?: BridgeAttachment[],
  ): Promise<void> {
    const settings = getSettings()
    const channelId = settings.agentChannelId
    if (!channelId) {
      await this.send(chatId, '请先在 Profer 设置中选择 Agent 渠道。', contextData)
      return
    }

    let binding = this.chatBindings.get(chatId)

    // 自动创建会话（复用 ensureBinding）
    if (!binding) {
      const result = this.ensureBinding(chatId, contextData)
      if (!result) {
        await this.send(chatId, '请先在 Profer 设置中选择 Agent 渠道。', contextData)
        return
      }
      binding = result
    }

    // 并发保护：如果该会话的 Agent 仍在运行，直接拒绝，不要触碰 buffer
    if (isAgentSessionActive(binding.sessionId)) {
      await this.send(chatId, '❌ 上一条消息仍在处理中，请稍候再试', contextData)
      return
    }

    // 即时确认：[workspace_name]->[session_title]: ⏳ Agent 处理中...
    const workspace = binding.workspaceId ? getAgentWorkspace(binding.workspaceId) : undefined
    const session = getAgentSessionMeta(binding.sessionId)
    const wsName = workspace?.name ?? '默认'
    const chatName = session?.title ?? '新会话'
    await this.send(chatId, `${wsName} → ${chatName}: ⏳ Agent 处理中...`, contextData)

    // 初始化回复缓冲
    this.sessionBuffers.set(binding.sessionId, {
      text: '',
      chatId,
      contextData,
      startedAt: Date.now(),
    })

    // 渠道/模型解析：binding（per-chat 用户在 IM 里切过的）优先，其次全局设置
    const latestSettings = getSettings()
    const agentRuntime = this.resolveChatRuntime(binding)
    const preferredChannelId = binding.channelId || latestSettings.agentChannelId || ''
    // 旧 binding 可能指向未启用当前内核的渠道；不兼容时回退到可用渠道，避免发送阶段才报错
    const picked = preferredChannelId
      ? resolveChannelIdForRuntime(preferredChannelId, agentRuntime)
      : null
    if (picked?.fellBack) {
      this.log(`渠道 ${preferredChannelId} 未启用 ${describeAgentRuntime(agentRuntime)} 内核，本次发送改用 ${picked.channelId}`)
    }
    const latestChannelId = picked?.channelId ?? preferredChannelId
    // 回退到其它渠道时，binding/全局模型往往不属于新渠道；必须按新渠道重新选一个，
    // 否则 orchestrator 会回落到默认模型（claude-sonnet-4-6），与渠道能力不匹配。
    const modelId = resolveModelIdForChannel(
      latestChannelId,
      binding.modelId ?? latestSettings.agentModelId,
    )

    // 如果有附件，拼接 <attached_files> 块到用户消息前
    const fileReferences = attachments?.length
      ? buildAttachedFilesBlock(attachments.map(a => ({ label: a.label, path: a.absolutePath })))
      : ''
    const effectiveText = resolveAgentAttachmentPrompt(
      text,
      attachments?.map((attachment) => attachment.kind) ?? [],
    )
    const userMessage = fileReferences + effectiveText

    const input = {
      sessionId: binding.sessionId,
      userMessage,
      // 气泡只展示用户原文，<attached_files> 路径块不进 transcript
      rawUserMessage: effectiveText,
      titleSourceText: effectiveText,
      channelId: latestChannelId,
      modelId,
      workspaceId: binding.workspaceId,
      permissionModeOverride: 'bypassPermissions' as const,
    }

    runAgentHeadless(input, {
      source: this.config.source,
      onError: (error) => {
        this.log(`Agent 错误: ${error}`)
        this.send(chatId, `❌ Agent 错误: ${error}`, contextData).catch(console.error)
        this.sessionBuffers.delete(binding!.sessionId)
      },
      onComplete: () => {
        // complete 由 EventBus listener 处理
      },
      onTitleUpdated: () => {},
    }).catch((error) => {
      this.log(`Agent 运行异常: ${error}`)
    })
  }

  // ===== EventBus 事件处理 =====

  private handleAgentPayload(sessionId: string, payload: AgentStreamPayload): void {
    const buffer = this.sessionBuffers.get(sessionId)
    if (!buffer) return

    if (payload.kind === 'sdk_message') {
      const msg = payload.message

      // 从 assistant 消息中提取文本
      if (msg.type === 'assistant') {
        const aMsg = msg as AssistantMessagePayload
        for (const block of aMsg.message?.content ?? []) {
          if (block.type === 'text' && block.text) {
            buffer.text += block.text
          }
        }
      }

      // result → 会话完成
      if (msg.type === 'result') {
        this.handleSessionComplete(sessionId)
      }
    }
  }

  private handleSessionComplete(sessionId: string): void {
    const buffer = this.sessionBuffers.get(sessionId)
    if (!buffer) return

    const duration = ((Date.now() - buffer.startedAt) / 1000).toFixed(1)
    const replyText = buffer.text.trim() || '✅ Agent 已完成（无文本输出）'

    this.log(`Agent 回复 (${duration}s): ${replyText.slice(0, 100)}${replyText.length > 100 ? '...' : ''}`)
    this.send(buffer.chatId, replyText, buffer.contextData).catch(console.error)
    this.sessionBuffers.delete(sessionId)
  }

  // ===== 工具方法 =====

  private async send(chatId: string, text: string, contextData?: unknown): Promise<void> {
    await this.config.adapter.sendText(chatId, text, contextData)
  }

  /**
   * 尝试用卡片发送。
   *
   * 平台未提供 `sendCard`、或渲染器返回空时返回 false，调用方回退到原有的纯文本分支。
   */
  private async trySendCard(
    chatId: string,
    card: BridgeCard | null | undefined,
    contextData?: unknown,
  ): Promise<boolean> {
    if (!card || !this.config.adapter.sendCard) return false
    await this.config.adapter.sendCard(chatId, card, contextData)
    return true
  }

  private notifySessionCreated(sessionId: string, title: string): void {
    const win = BrowserWindow.getAllWindows()[0]
    if (win && !win.isDestroyed()) {
      win.webContents.send(AGENT_IPC_CHANNELS.TITLE_UPDATED, { sessionId, title })
    }
  }
}
