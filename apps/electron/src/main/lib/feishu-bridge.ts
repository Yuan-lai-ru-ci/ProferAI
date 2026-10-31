/**
 * 飞书 Bridge 服务
 *
 * 核心职责：
 * - 通过 WebSocket 长连接接收飞书消息
 * - 路由命令或转发用户消息到 Agent/Chat 服务
 * - 监听 AgentEventBus 事件，累积完整回复后发送到飞书
 * - 管理聊天绑定（chatId ↔ sessionId）
 * - Session 镜像：桌面发起的会话可同步为飞书群内流式卡片
 */

import { BrowserWindow } from 'electron'
import type {
  AgentStreamPayload,
  AgentSendInput,
  FeishuBridgeState,
  FeishuChatBinding,
  FeishuTestResult,
  FeishuMention,
  FeishuGroupInfo,
  FeishuGroupMember,
  FeishuMessageContext,
  FeishuChatMessage,
  FeishuUpdateBindingInput,
  FeishuBotConfig,
  AgentSessionMeta,
  SDKAssistantMessage,
  SDKUserMessage,
} from '@profer/shared'
import { FEISHU_IPC_CHANNELS, AGENT_IPC_CHANNELS, normalizeAgentRuntime, resolveAgentAttachmentPrompt } from '@profer/shared'
import type { AgentRuntime } from '@profer/shared'
import { getDecryptedBotAppSecret, saveFeishuBotConfig } from './feishu-config'
import { BridgeCommandHandler } from './bridge-command-handler'
import type { BridgeChatBinding, BridgeNowSnapshot } from './bridge-command-handler'
import { agentEventBus, runAgentHeadless, stopAgent } from './agent-service'
import { createAgentSession, getAgentSessionMeta } from './agent-session-manager'
import {
  listAgentWorkspacesByUpdatedAt,
  getAgentWorkspace,
} from './agent-workspace-manager'
import { getFeishuBotBindingsPath, getFeishuBotMetadataPath } from './config-paths'
import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import {
  inferImageMediaType as inferImageMediaTypeShared,
  saveImageToSession as saveImageToSessionShared,
  saveFileToSession as saveFileToSessionShared,
  inferExtension,
} from './bridge-attachment-utils'
import { getSettings } from './settings-service'
import {
  buildAgentReplyCard,
  buildErrorCard,
  buildSessionListCard,
  buildWorkspaceSwitchedCard,
  buildWorkspaceListCard,
  buildHelpCard,
  buildChannelListCard,
  buildModelListCard,
  buildModelSwitchedCard,
  accumulateToolStart,
  splitLongContent,
} from './feishu-message'
import {
  describeAgentRuntime,
  resolveChannelIdForRuntime,
  resolveModelIdForChannel,
} from './bridge-model-utils'
import type { ToolSummary, FormattedAgentResult, WorkspaceListItem } from './feishu-message'
import { CardStream } from './feishu/card-stream'
import {
  createInitialState,
  finalizeIfRunning,
  markError,
  markInterrupted,
  reduce as reduceRunState,
  type RunState,
} from './feishu/card-run-state'
import { renderCard as renderRunCard } from './feishu/card-renderer-v2'
import { buildSessionMirrorGroupName } from './feishu/session-mirror'
import { resolveGroupMessageAccess } from './feishu/group-message-policy'
import { ScopedQueue } from './feishu/scoped-queue'
import { RunCoordinator } from './feishu/run-coordinator'
import {
  buildAgentUserMessage,
  fetchQuotedMessage,
  type BridgeContext,
  type QuotedMessage,
} from './feishu/prompt-builder'

// ===== 类型定义 =====

/** 飞书图片附件（已下载，待保存到 session 工作目录） */
interface FeishuImageAttachment {
  /** 飞书 image_key */
  imageKey: string
  /** 图片二进制数据 */
  data: Buffer
  /** MIME 类型 */
  mediaType: string
}

/** 飞书文件附件（已下载，待保存到 session 工作目录） */
interface FeishuFileAttachment {
  /** 飞书 file_key */
  fileKey: string
  /** 原始文件名 */
  fileName: string
  /** 文件二进制数据 */
  data: Buffer
}

/** 会话累积缓冲 */
interface SessionBuffer {
  text: string
  toolSummaries: Map<string, ToolSummary>
  startedAt: number
}

/** 进入 ScopedQueue 防抖队列的飞书消息载荷 */
interface QueuedFeishuMessage {
  msgCtx: FeishuMessageContext
  text: string
  imageAttachments: FeishuImageAttachment[]
  fileAttachments: FeishuFileAttachment[]
  /** 用户长按"回复"指向的消息 id（飞书 message.parent_id） */
  parentMessageId?: string
}

const MESSAGE_DEBOUNCE_MS = 600
const DEFAULT_MAX_CONCURRENT_RUNS = 3

// ===== Bridge =====

class FeishuBridge {
  /** Bot 配置（构造时注入，workspace 切换时同步更新） */
  private botConfig: FeishuBotConfig

  /** 命令处理（与微信/钉钉共用同一套实现，通过 renderers 保留飞书卡片） */
  private readonly commandHandler: BridgeCommandHandler

  /** SDK Client（发消息用，等于 channel.rawClient） */
  private client: InstanceType<typeof import('@larksuiteoapi/node-sdk').Client> | null = null
  /** LarkChannel（统一 WebSocket + 卡片回调路由） */
  private channel: import('@larksuiteoapi/node-sdk').LarkChannel | null = null

  /** 连接状态 */
  private status: FeishuBridgeState = { status: 'disconnected', activeBindings: 0 }

  /** Bot 自身的 open_id（连接时获取，用于群聊 @Bot 精确检测） */
  private botOpenId: string | null = null

  /** chatId → 绑定信息 */
  private chatBindings = new Map<string, FeishuChatBinding>()
  /** sessionId → chatId（反向索引） */
  private sessionToChat = new Map<string, string>()
  /** sessionId → 文本累积缓冲（桌面通知场景仍依赖） */
  private sessionBuffers = new Map<string, SessionBuffer>()
  /** sessionId → 流式卡片状态（飞书发起的会话才有） */
  private streamingRunStates = new Map<string, RunState>()
  /** sessionId → 流式卡片句柄（飞书发起的会话才有） */
  private streamingCards = new Map<string, CardStream>()
  /** 用过流式卡的 sessionId 集合（complete 时判定是否需要降级回复卡） */
  private streamingCardsUsedSessions = new Set<string>()
  /** 已经由飞书流式卡处理过终态的 session → 标记时间戳。
   *  收到 result 时 delete 即可；如果 Agent 异常退出 result 不到达，
   *  下次写入会顺手回收 5 分钟前的过期条目，避免长尾泄漏。 */
  private streamingTerminalHandledSessions = new Map<string, number>()

  /** 防抖队列：scope → 累积的待处理消息（合并 batch 触发一次 Agent） */
  private readonly messageQueue = new ScopedQueue<QueuedFeishuMessage>(
    MESSAGE_DEBOUNCE_MS,
    (scope, batch) => this.flushMessageBatch(scope, batch),
  )

  /** Run 协调：per-scope 串行 + 全局并发上限 */
  private readonly runCoordinator = new RunCoordinator(DEFAULT_MAX_CONCURRENT_RUNS)
  /** 最近与该 Bot 交互的用户 open_id，用于桌面 Session 镜像建群。 */
  private lastInteractedUserOpenId: string | null = null

  /** chatId → 待合并的图片（纯图片消息暂存，等待后续文本一起发送） */
  private pendingImages = new Map<string, FeishuImageAttachment[]>()
  /** chatId → 待合并的文件（纯文件消息暂存，等待后续文本一起发送） */
  private pendingFiles = new Map<string, FeishuFileAttachment[]>()

  /** chatId → 最近收到的用户消息 ID（用于群聊 thread reply） */
  private lastUserMessageId = new Map<string, string>()
  /** chatId → 群聊信息缓存 */
  private groupInfoCache = new Map<string, FeishuGroupInfo>()
  /** open_id → 用户显示名称缓存 */
  private userNameCache = new Map<string, string>()
  /** 群信息缓存有效期（毫秒）：1 小时 */
  private static readonly GROUP_CACHE_TTL = 3600_000

  /** 消息去重（防止 SDK WebSocket 重复投递） */
  private recentMessageIds = new Set<string>()
  /** 事件去重（防止网关超时重投） */
  private recentEventIds = new Set<string>()
  /** chatId 级处理锁（防止 bot 回复触发的事件重入） */
  private processingChats = new Set<string>()
  private static readonly DEDUP_MAX = 200

  /** EventBus 监听器取消函数 */
  private eventBusUnsubscribe: (() => void) | null = null

  constructor(botConfig: FeishuBotConfig) {
    this.botConfig = botConfig
    this.commandHandler = new BridgeCommandHandler({
      platformName: '飞书',
      source: 'feishu',
      adapter: {
        sendText: (chatId, text) => this.sendMessage(chatId, text),
        sendCard: (chatId, card) => this.sendCardMessage(chatId, card as Record<string, unknown>),
      },
      // 工作区：Bot 默认 > 全局默认 > default/最近工作区（与迁移前一致）
      getDefaultWorkspaceId: () => this.botConfig.defaultWorkspaceId,
      // 渠道/模型：Bot 默认 > 全局设置（与迁移前一致）
      getPreferredChannelId: () => this.botConfig.defaultChannelId,
      getPreferredModelId: () => this.botConfig.defaultModelId,
      fallbackWorkspaceId: () => {
        const byTime = listAgentWorkspacesByUpdatedAt()
        const def = byTime.find((w) => w.slug === 'default')
        return def?.id ?? byTime[0]?.id
      },
      // 飞书保留“不预设标题，首轮后自动生成”的行为
      sessionTitle: (title) => title,
      onWorkspaceSwitched: (workspaceId) => {
        saveFeishuBotConfig({
          id: this.botConfig.id,
          name: this.botConfig.name,
          enabled: this.botConfig.enabled,
          appId: this.botConfig.appId,
          appSecret: '', // 空字符串表示不修改
          defaultWorkspaceId: workspaceId,
          defaultChannelId: this.botConfig.defaultChannelId,
          defaultModelId: this.botConfig.defaultModelId,
        })
        this.botConfig = { ...this.botConfig, defaultWorkspaceId: workspaceId }
      },
      // 飞书绑定比通用绑定多 botId/userId/chatType/groupName/source/createdAt
      enrichBinding: (binding, contextData) => {
        const ctx = contextData as FeishuMessageContext | undefined
        const target = binding as FeishuChatBinding
        target.botId = this.botConfig.id
        target.userId = ctx?.senderOpenId ?? 'unknown'
        target.source = 'feishu'
        target.chatType = ctx?.chatType
        target.groupName = ctx?.groupName
        target.createdAt = Date.now()
      },
      afterBindingChanged: () => {
        this.updateStatus({ activeBindings: this.chatBindings.size })
        this.saveBindings()
      },
      afterStop: (sessionId) => this.markStreamingInterrupted(sessionId),
      // 卡片里的文件树不带 emoji（与迁移前一致）
      fileTreeOptions: { dirIcon: '', fileIcon: '' },
      bindings: this.chatBindings as unknown as Map<string, BridgeChatBinding>,
      sessionToChat: this.sessionToChat,
      renderers: {
        help: () => buildHelpCard(),
        sessionList: ({ groups, currentWorkspaceId }) =>
          buildSessionListCard(
            groups.map((group) => ({
              id: group.id,
              name: group.name,
              sessions: group.sessions.map((s) => ({
                id: s.id,
                title: s.title,
                active: s.active,
                index: s.index,
              })),
            })),
            currentWorkspaceId,
          ),
        workspaceList: ({ items }) => buildWorkspaceListCard(items),
        workspaceSwitched: ({ workspaceName, recentSessions }) =>
          buildWorkspaceSwitchedCard(
            workspaceName,
            recentSessions.map((s) => ({ id: s.id, title: s.title, index: s.index })),
          ),
        now: (snapshot) => this.buildNowCard(snapshot),
        channelList: ({ items }) => buildChannelListCard(items),
        modelList: ({ channelName, channelIndex, items }) =>
          buildModelListCard(channelName, channelIndex, items),
        modelSwitched: ({ channelName, modelName }) => buildModelSwitchedCard(channelName, modelName),
      },
    })
  }

  /** 获取 Bot 配置 */
  getBotConfig(): FeishuBotConfig {
    return this.botConfig
  }

  // ===== 生命周期 =====

  async start(): Promise<void> {
    const { appId, appSecret } = this.botConfig
    if (!appId || !appSecret) {
      throw new Error('请先配置 App ID 和 App Secret')
    }

    this.updateStatus({ status: 'connecting' })

    try {
      const plainSecret = getDecryptedBotAppSecret(this.botConfig.id)
      const lark = await import('@larksuiteoapi/node-sdk')

      // 用 createLarkChannel 替代 lark.Client + lark.WSClient + EventDispatcher 老组合
      // 关键收益：channel.on({cardAction}) 能拿到卡片按钮回调（老 WSClient.handleEventData
      // 只处理 MessageType.event 通道，会直接丢掉 MessageType.card 帧）
      // 其余调用通过 channel.rawClient 路由，所有现有 client.* API 零改动
      this.channel = lark.createLarkChannel({
        appId,
        appSecret: plainSecret,
        domain: lark.Domain.Feishu,
        loggerLevel: lark.LoggerLevel.warn,
        policy: {
          dmMode: 'open',
          requireMention: false,
          respondToMentionAll: false,
        },
        // 关闭 SDK 内部 per-chat 串行（chatQueue），我们的并发模型自己控
        safety: { chatQueue: { enabled: false } },
        // 接 raw event 用于把 NormalizedMessage 反构成旧 handleFeishuMessage 形态
        includeRawEvent: true,
      })
      this.client = this.channel.rawClient

      // 获取 Bot 自身的 open_id（用于群聊 @Bot 精确检测）
      try {
        const botInfoResp = await this.client.request<{
          code?: number
          bot?: { open_id?: string; app_name?: string }
          data?: { bot?: { open_id?: string; app_name?: string } }
        }>({
          method: 'GET',
          url: 'https://open.feishu.cn/open-apis/bot/v3/info/',
        })
        console.log('[飞书 Bridge] Bot info 响应:', JSON.stringify(botInfoResp, null, 2))
        // 飞书 API 返回 bot 在顶层，Lark SDK 可能包装在 data 下，兼容两种
        this.botOpenId = botInfoResp?.bot?.open_id ?? botInfoResp?.data?.bot?.open_id ?? null
        if (this.botOpenId) {
          console.log(`[飞书 Bridge] Bot open_id: ${this.botOpenId}`)
        } else {
          console.warn('[飞书 Bridge] 未能获取 Bot open_id，群聊 @Bot 检测将使用回退策略')
        }
      } catch (error) {
        console.warn('[飞书 Bridge] 获取 Bot info 失败（非致命）:', error)
      }

      // 注册消息接收（cardAction 暂时不接：飞书 cardAction 不通过长连接推送，
      // 需要单独配置 HTTP 回调 URL；本期保留 LarkChannel 抽象但卡片改用文本
      // 命令 /stop 终止，未来 Phase 3 权限审批做差异化时再评估）
      this.channel.on({
        message: (msg) => {
          // 把 NormalizedMessage 反构成旧 handleFeishuMessage 期望的 raw 形态，
          // 这样 700 行业务逻辑一行不动；msg.raw 含原始 RawMessageEvent 全字段
          const raw = (msg as { raw?: Record<string, unknown> }).raw ?? {}
          this.handleFeishuMessage(raw).catch((error) => {
            console.error('[飞书 Bridge] 处理消息异常:', error)
          })
        },
      })

      await this.channel.connect()

      // 注册 EventBus 监听器
      this.eventBusUnsubscribe = agentEventBus.on((sessionId, payload) => {
        this.handleAgentPayload(sessionId, payload)
      })

      // 恢复之前的聊天绑定
      this.loadBindings()
      // 恢复运行时元数据（最近交互用户等）
      this.loadMetadata()

      this.updateStatus({ status: 'connected', connectedAt: Date.now() })
      console.log('[飞书 Bridge] 已连接')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.updateStatus({ status: 'error', errorMessage: message })
      console.error('[飞书 Bridge] 启动失败:', error)
    }
  }

  stop(): void {
    // 取消 EventBus 监听
    this.eventBusUnsubscribe?.()
    this.eventBusUnsubscribe = null

    // 关闭 LarkChannel（含底层 WSClient）
    if (this.channel) {
      void this.channel.disconnect().catch(() => {
        // 忽略关闭时的错误
      })
      this.channel = null
    }
    this.client = null

    // 清理状态
    this.chatBindings.clear()
    this.sessionToChat.clear()
    this.sessionBuffers.clear()
    // 清空防抖队列与 run 协调状态
    this.messageQueue.cancelAll()
    this.runCoordinator.abortAll()
    // 关闭所有正在跑的流式卡（不等返回，避免阻塞 stop）
    for (const stream of this.streamingCards.values()) {
      void stream.close().catch(() => {})
    }
    this.streamingCards.clear()
    this.streamingRunStates.clear()
    this.streamingCardsUsedSessions.clear()
    this.streamingTerminalHandledSessions.clear()
    this.recentMessageIds.clear()
    this.recentEventIds.clear()
    this.processingChats.clear()
    this.lastUserMessageId.clear()
    this.groupInfoCache.clear()
    this.userNameCache.clear()
    // 注意：lastInteractedUserOpenId 不在 stop 中清空——它代表"用户曾经与该 Bot 互动过"的事实，
    // 重启后仍需用来给桌面 Session 镜像建群。完整重置请删除 ~/.proma/feishu-metadata-{botId}.json。
    this.botOpenId = null

    this.updateStatus({ status: 'disconnected', activeBindings: 0 })
    console.log('[飞书 Bridge] 已停止')
  }

  async restart(): Promise<void> {
    this.stop()
    await this.start()
  }

  // ===== 绑定持久化 =====

  /** 从磁盘恢复聊天绑定（应用重启后延续之前的会话） */
  private loadBindings(): void {
    const bindingsPath = getFeishuBotBindingsPath(this.botConfig.id)
    if (!existsSync(bindingsPath)) return

    try {
      const raw = readFileSync(bindingsPath, 'utf-8')
      const bindings = JSON.parse(raw) as FeishuChatBinding[]
      const appSettings = getSettings()

      for (const b of bindings) {
        // 验证对应会话仍然存在
        const session = getAgentSessionMeta(b.sessionId)
        if (session) {
          // 同步最新的渠道和模型设置（用户可能已更改）
          if (appSettings.agentChannelId) {
            b.channelId = appSettings.agentChannelId
          }
          if (appSettings.agentModelId) {
            b.modelId = appSettings.agentModelId
          }
          // 旧 binding 无 agentRuntime：以会话元数据为准回填，避免误判成 Claude 内核
          b.agentRuntime = normalizeAgentRuntime(session.agentRuntime ?? b.agentRuntime)
          this.chatBindings.set(b.chatId, b)
          this.sessionToChat.set(b.sessionId, b.chatId)
        }
      }
      if (this.chatBindings.size > 0) {
        console.log(`[飞书 Bridge] 已恢复 ${this.chatBindings.size} 个聊天绑定`)
        this.updateStatus({ activeBindings: this.chatBindings.size })
      }
    } catch (error) {
      console.error('[飞书 Bridge] 加载绑定失败:', error)
    }
  }

  /** 持久化聊天绑定到磁盘 */
  private saveBindings(): void {
    try {
      const bindings = Array.from(this.chatBindings.values())
      const bindingsPath = getFeishuBotBindingsPath(this.botConfig.id)
      writeFileSync(bindingsPath, JSON.stringify(bindings, null, 2), 'utf-8')
    } catch (error) {
      console.error('[飞书 Bridge] 保存绑定失败:', error)
    }
  }

  /**
   * 加载 Bot 级运行时元数据（如最近交互用户的 open_id）。
   *
   * 之所以用独立文件而非合入 bindings：bindings 是数组，元数据是对象，
   * 形态不同；并且元数据需要在 disconnect/stop 时仍然保留，被显式
   * 重置才会清空。
   */
  private loadMetadata(): void {
    const metaPath = getFeishuBotMetadataPath(this.botConfig.id)
    if (!existsSync(metaPath)) return

    try {
      const raw = readFileSync(metaPath, 'utf-8')
      const data = JSON.parse(raw) as { lastInteractedUserOpenId?: string }
      if (data.lastInteractedUserOpenId && data.lastInteractedUserOpenId !== 'unknown') {
        this.lastInteractedUserOpenId = data.lastInteractedUserOpenId
      }
    } catch (error) {
      console.error('[飞书 Bridge] 加载元数据失败:', error)
    }
  }

  private saveMetadata(): void {
    try {
      const metaPath = getFeishuBotMetadataPath(this.botConfig.id)
      const data = { lastInteractedUserOpenId: this.lastInteractedUserOpenId }
      writeFileSync(metaPath, JSON.stringify(data, null, 2), 'utf-8')
    } catch (error) {
      console.error('[飞书 Bridge] 保存元数据失败:', error)
    }
  }

  private setLastInteractedUserOpenId(openId: string | null): void {
    if (this.lastInteractedUserOpenId === openId) return
    this.lastInteractedUserOpenId = openId
    this.saveMetadata()
  }

  // ===== 状态查询 =====

  getStatus(): FeishuBridgeState {
    return { ...this.status }
  }

  listBindings(): FeishuChatBinding[] {
    return Array.from(this.chatBindings.values())
  }

  /** 更新绑定的工作区/会话（从设置页调用） */
  updateBinding(input: FeishuUpdateBindingInput): FeishuChatBinding | null {
    const binding = this.chatBindings.get(input.chatId)
    if (!binding) return null

    if (input.workspaceId !== undefined) {
      binding.workspaceId = input.workspaceId
    }
    if (input.sessionId !== undefined) {
      // 清理旧反向索引，建立新的
      this.sessionToChat.delete(binding.sessionId)
      binding.sessionId = input.sessionId
      this.sessionToChat.set(input.sessionId, input.chatId)
      // 新会话的内核可能与旧会话不同，必须重算，否则 /model 会按错内核过滤
      binding.agentRuntime = this.resolveChatRuntime({ ...binding, agentRuntime: undefined })
    }

    this.saveBindings()
    return { ...binding }
  }

  /** 移除绑定（从设置页调用） */
  removeBinding(chatId: string): boolean {
    const binding = this.chatBindings.get(chatId)
    if (!binding) return false

    this.sessionToChat.delete(binding.sessionId)
    this.streamingTerminalHandledSessions.delete(binding.sessionId)
    this.chatBindings.delete(chatId)
    this.updateStatus({ activeBindings: this.chatBindings.size })
    this.saveBindings()
    return true
  }

  /**
   * 为 Profer 桌面端会话准备飞书镜像群。
   *
   * 该群只包含用户与当前 Bot。用户在群里继续发送消息时，会通过
   * source=session-mirror 的绑定回到同一个 Profer session。
   */
  async ensureSessionMirror(session: AgentSessionMeta): Promise<void> {
    if (!this.client) return

    const existing = this.findBindingBySessionId(session.id)
    if (existing) return

    const userOpenId = this.resolveMirrorUserOpenId()
    if (!userOpenId) {
      console.warn('[飞书 Session 镜像] 缺少用户 open_id，无法创建镜像群。请先让用户在飞书里和该 Bot 互动一次。')
      return
    }

    const appSettings = getSettings()
    const workspaceId = session.workspaceId ?? this.botConfig.defaultWorkspaceId ?? appSettings.agentWorkspaceId
    const channelId = session.channelId ?? this.botConfig.defaultChannelId ?? appSettings.agentChannelId
    if (!workspaceId || !channelId) {
      console.warn('[飞书 Session 镜像] 缺少 workspaceId 或 channelId，跳过镜像群创建', {
        sessionId: session.id,
        workspaceId,
        channelId,
      })
      return
    }

    const groupName = buildSessionMirrorGroupName(session)
    const chatId = await this.createSessionMirrorGroup(userOpenId, groupName)
    if (!chatId) return

    const binding: FeishuChatBinding = {
      chatId,
      botId: this.botConfig.id,
      userId: userOpenId,
      sessionId: session.id,
      workspaceId,
      channelId,
      modelId: this.botConfig.defaultModelId ?? appSettings.agentModelId ?? undefined,
      agentRuntime: normalizeAgentRuntime(session.agentRuntime),
      source: 'session-mirror',
      chatType: 'group',
      groupName,
      createdAt: Date.now(),
    }

    this.chatBindings.set(chatId, binding)
    this.sessionToChat.set(session.id, chatId)
    this.updateStatus({ activeBindings: this.chatBindings.size })
    this.saveBindings()
    console.log(`[飞书 Session 镜像] 已创建群: session=${session.id.slice(0, 8)}, chat=${chatId}`)
  }

  /** Agent 运行前为桌面 Session 镜像打开流式卡片。 */
  async startSessionMirrorRun(session: AgentSessionMeta): Promise<void> {
    if (!this.client) return
    await this.ensureSessionMirror(session)

    const binding = this.findBindingBySessionId(session.id)
    if (!binding || binding.source !== 'session-mirror') return
    if (this.streamingCards.has(session.id)) return

    const initialState = createInitialState()
    this.streamingRunStates.set(session.id, initialState)

    try {
      const cardStream = await CardStream.open(
        this.client,
        binding.chatId,
        renderRunCard(initialState, {
          header: `${binding.groupName ?? buildSessionMirrorGroupName(session)} · Agent 处理中`,
          stopHint: '在群里发送 `/stop` 可终止当前任务',
        }),
      )
      this.streamingCards.set(session.id, cardStream)
      this.streamingCardsUsedSessions.add(session.id)
      this.lastUserMessageId.delete(binding.chatId)
    } catch (error) {
      this.streamingRunStates.delete(session.id)
      console.error('[飞书 Session 镜像] 流式卡片创建失败:', error)
    }
  }

  stopSessionMirrorRun(sessionId: string): void {
    this.markStreamingInterrupted(sessionId)
  }

  // ===== 连接测试 =====

  async testConnection(appId: string, appSecret: string): Promise<FeishuTestResult> {
    try {
      const lark = await import('@larksuiteoapi/node-sdk')
      const client = new lark.Client({
        appId,
        appSecret,
        appType: lark.AppType.SelfBuild,
      })

      // 通过获取 tenant_access_token 来验证凭证
      const resp = await client.auth.tenantAccessToken.internal({
        data: {
          app_id: appId,
          app_secret: appSecret,
        },
      })

      if (resp.code === 0) {
        return {
          success: true,
          message: '连接成功',
          botName: `App ${appId.slice(0, 8)}...`,
        }
      }

      return {
        success: false,
        message: `飞书 API 错误: ${resp.msg ?? '未知错误'} (code: ${resp.code})`,
      }
    } catch (error) {
      return {
        success: false,
        message: `连接失败: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }

  // ===== 飞书图片处理 =====

  /**
   * 从飞书下载图片
   *
   * 使用 im.messageResource.get API 获取消息中的图片资源。
   */
  private async downloadFeishuImage(messageId: string, imageKey: string): Promise<Buffer> {
    if (!this.client) throw new Error('飞书 Client 未初始化')

    const resp = await this.client.im.messageResource.get({
      path: { message_id: messageId, file_key: imageKey },
      params: { type: 'image' },
    })

    // Lark SDK 返回 { writeFile, getReadableStream, headers } 对象
    const stream = resp.getReadableStream()
    const chunks: Buffer[] = []
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
    return Buffer.concat(chunks)
  }

  /**
   * 下载飞书消息中的文件资源
   */
  private async downloadFeishuFile(messageId: string, fileKey: string): Promise<Buffer> {
    if (!this.client) throw new Error('飞书 Client 未初始化')

    const resp = await this.client.im.messageResource.get({
      path: { message_id: messageId, file_key: fileKey },
      params: { type: 'file' },
    })

    const stream = resp.getReadableStream()
    const chunks: Buffer[] = []
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
    return Buffer.concat(chunks)
  }

  // ===== 飞书消息处理 =====

  private async handleFeishuMessage(data: Record<string, unknown>): Promise<void> {
    if (!this.client) return

    // 事件级去重（飞书网关超时重投时 event_id 相同）
    const eventId = data.event_id as string | undefined
    if (eventId && this.recentEventIds.has(eventId)) {
      console.log('[飞书 Bridge] 跳过重复事件 (event_id):', eventId)
      return
    }
    if (eventId) {
      this.addToDedup(this.recentEventIds, eventId)
    }

    // 解析消息
    const message = (data as { message?: Record<string, unknown> }).message
    if (!message) return

    const sender = (data as { sender?: Record<string, unknown> }).sender

    // 过滤非用户消息（Bot 自己发的消息 sender_type 不是 "user"）
    const senderType = (sender?.sender_type as string) ?? ''
    if (senderType !== 'user') {
      return
    }

    // 消息级去重（同一条消息被不同 event 包裹时 message_id 相同）
    const messageId = message.message_id as string
    if (messageId && this.recentMessageIds.has(messageId)) {
      console.log('[飞书 Bridge] 跳过重复消息 (message_id):', messageId)
      return
    }
    if (messageId) {
      this.addToDedup(this.recentMessageIds, messageId)
    }

    const chatId = message.chat_id as string
    const messageType = message.message_type as string
    const chatType = message.chat_type as string
    const userId = (sender?.sender_id as Record<string, unknown>)?.open_id as string ?? 'unknown'
    const mentions = message.mentions as FeishuMention[] | undefined

    // 早期 fast-path：如果该 chat 正在处理消息（含图片下载等耗时 IO），
    // 提前 return 避免无谓的资源下载。真正的并发保护在 line 711 的
    // processingChats.add/delete try/finally 块里。
    if (this.processingChats.has(chatId)) {
      console.log('[飞书 Bridge] 跳过重入消息 (chatId lock):', chatId)
      return
    }

    const existingBinding = this.chatBindings.get(chatId)
    const isSessionMirrorGroup = existingBinding?.source === 'session-mirror'

    if (chatType === 'group') {
      const isMentioned = await this.isBotMentioned(mentions)
      const groupInfo = isSessionMirrorGroup || isMentioned ? null : await this.getGroupInfo(chatId)
      const access = resolveGroupMessageAccess({
        isSessionMirrorGroup,
        isBotMentioned: isMentioned,
        groupInfo,
        senderOpenId: userId,
        botOpenId: this.botOpenId,
        binding: existingBinding,
      })

      if (!access.accepted) {
        console.log(
          `[飞书 Bridge] 群消息未触发 Agent（需 @Bot）——chatId=${chatId}, ` +
          `userCount=${groupInfo?.userCount ?? 'N/A'}, isMentioned=${isMentioned}, ` +
          `reason=${access.reason}。若这是仅你和 Bot 的群却仍要求 @，请确认已申请并发布 im:chat 权限。`,
        )
        return
      }

      if (access.reason === 'single-user-group') {
        console.log('[飞书 Bridge] 检测到单用户群聊，允许免 @ 续聊:', chatId)
      }
    }

    // 记录群聊最近用户消息 ID（用于 thread reply）
    if (chatType === 'group' && messageId) {
      this.lastUserMessageId.set(chatId, messageId)
    }

    // 记录最近交互用户，用于桌面 Session 镜像建群（持久化以跨进程重启）。
    if (userId && userId !== 'unknown') {
      this.setLastInteractedUserOpenId(userId)
    }

    // 仅处理文本、图片、富文本和文件消息
    const supportedTypes = new Set(['text', 'image', 'post', 'file'])
    if (!supportedTypes.has(messageType)) {
      console.log(`[飞书 Bridge] 不支持的消息类型: ${messageType}`)
      await this.sendTextMessage(chatId, '目前仅支持文本、图片和文件消息。')
      return
    }

    // 解析消息内容
    let text = ''
    const imageAttachments: FeishuImageAttachment[] = []
    const fileAttachments: FeishuFileAttachment[] = []

    if (messageType === 'text') {
      const content = JSON.parse(message.content as string) as { text?: string }
      text = content.text?.trim() ?? ''
      // 去除 @Bot 的占位符（如 @_user_1）
      text = text.replace(/@_user_\d+/g, '').trim()
    } else if (messageType === 'post') {
      // 富文本消息：提取文本和图片
      const content = JSON.parse(message.content as string) as {
        title?: string
        content?: Array<Array<{ tag: string; text?: string; image_key?: string }>>
      }
      const textParts: string[] = []
      if (content.title) textParts.push(content.title)
      for (const line of content.content ?? []) {
        for (const node of line) {
          if (node.tag === 'text' && node.text) {
            textParts.push(node.text)
          } else if (node.tag === 'img' && node.image_key) {
            try {
              const imageData = await this.downloadFeishuImage(messageId, node.image_key)
              const mediaType = inferImageMediaTypeShared(imageData)
              imageAttachments.push({ imageKey: node.image_key, data: imageData, mediaType })
            } catch (error) {
              console.error('[飞书 Bridge] 下载富文本图片失败:', error)
            }
          }
        }
      }
      text = textParts.join(' ').replace(/@_user_\d+/g, '').trim()
    } else if (messageType === 'image') {
      const content = JSON.parse(message.content as string) as { image_key?: string }
      if (content.image_key) {
        try {
          const imageData = await this.downloadFeishuImage(messageId, content.image_key)
          const mediaType = inferImageMediaTypeShared(imageData)
          if (imageData.length > 10 * 1024 * 1024) {
            console.warn(`[飞书 Bridge] 图片较大: ${(imageData.length / 1024 / 1024).toFixed(1)}MB`)
          }
          imageAttachments.push({ imageKey: content.image_key, data: imageData, mediaType })
        } catch (error) {
          console.error('[飞书 Bridge] 下载图片失败:', error)
          await this.sendCardMessage(chatId, buildErrorCard('图片下载失败，请重试。'))
          return
        }
      }
    } else if (messageType === 'file') {
      const content = JSON.parse(message.content as string) as { file_key?: string; file_name?: string }
      if (content.file_key) {
        try {
          const fileData = await this.downloadFeishuFile(messageId, content.file_key)
          const fileName = content.file_name || `feishu-${content.file_key}`
          if (fileData.length > 50 * 1024 * 1024) {
            await this.sendTextMessage(chatId, '文件过大（超过 50MB），暂不支持处理。')
            return
          }
          fileAttachments.push({ fileKey: content.file_key, fileName, data: fileData })
        } catch (error) {
          console.error('[飞书 Bridge] 下载文件失败:', error)
          await this.sendCardMessage(chatId, buildErrorCard('文件下载失败，请重试。'))
          return
        }
      }
    }

    const hasAttachments = imageAttachments.length > 0 || fileAttachments.length > 0
    if (!text && !hasAttachments) return

    // 纯附件消息（无文本）：暂存，等待后续文本一起触发 Agent
    if (!text && hasAttachments) {
      if (imageAttachments.length > 0) {
        const existing = this.pendingImages.get(chatId) ?? []
        existing.push(...imageAttachments)
        this.pendingImages.set(chatId, existing)
      }
      if (fileAttachments.length > 0) {
        const existing = this.pendingFiles.get(chatId) ?? []
        existing.push(...fileAttachments)
        this.pendingFiles.set(chatId, existing)
      }
      const parts: string[] = []
      const imgCount = this.pendingImages.get(chatId)?.length ?? 0
      const fileCount = this.pendingFiles.get(chatId)?.length ?? 0
      if (imgCount > 0) parts.push(`${imgCount} 张图片`)
      if (fileCount > 0) parts.push(`${fileCount} 个文件`)
      await this.sendTextMessage(chatId, `已收到${parts.join('和')}，请继续发送文字消息来触发处理。`)
      return
    }

    // 文本消息到达时，合并暂存的图片和文件
    if (text && this.pendingImages.has(chatId)) {
      const pending = this.pendingImages.get(chatId)!
      imageAttachments.unshift(...pending)
      this.pendingImages.delete(chatId)
    }
    if (text && this.pendingFiles.has(chatId)) {
      const pending = this.pendingFiles.get(chatId)!
      fileAttachments.unshift(...pending)
      this.pendingFiles.delete(chatId)
    }

    // 获取群聊上下文
    let groupName: string | undefined
    let senderName: string | undefined
    if (chatType === 'group') {
      const [groupInfo, userName] = await Promise.all([
        this.getGroupInfo(chatId),
        this.getUserName(userId),
      ])
      groupName = groupInfo?.name
      senderName = userName
    }

    // 构建消息上下文
    const msgCtx: FeishuMessageContext = {
      chatId,
      senderOpenId: userId,
      senderName,
      messageId,
      chatType: chatType as 'p2p' | 'group',
      groupName,
    }

    // 加锁：防止同一聊天的消息并发处理（飞书 SDK 回调不 await，多条消息可能同时执行）
    if (this.processingChats.has(chatId)) return
    this.processingChats.add(chatId)
    try {
      // 命令路由：命令跳过防抖立即执行；同时取消该 scope 累积的普通消息
      if (text.startsWith('/')) {
        this.messageQueue.cancel(this.resolveScope(chatId))
        await this.handleCommand(msgCtx, text)
        return
      }

      // 普通消息：push 到防抖队列，600ms quiet window 后合并 batch 触发 Agent
      // 取出用户长按"回复"指向的消息 id（用于 PromptBuilder 拉取被引消息）
      const parentMessageId = (message.parent_id as string | undefined) || undefined

      const scope = this.resolveScope(chatId)
      const queued = this.messageQueue.push(scope, {
        msgCtx,
        text,
        imageAttachments,
        fileAttachments,
        parentMessageId,
      })
      console.log(`[飞书 Bridge] 消息入队: scope=${scope}, 队列长度=${queued}`)
    } finally {
      this.processingChats.delete(chatId)
    }
  }

  /**
   * 解析飞书 scope（与 ScopedQueue + RunCoordinator 共享 scope 语义）。
   * 当前飞书桥不区分话题群 thread，全部按 chatId 处理；未来若支持话题群
   * 再扩展为 `chatId:threadId`。
   */
  private resolveScope(chatId: string): string {
    return chatId
  }

  /**
   * ScopedQueue.onFlush 回调：把 batch 内多条消息合并为单次 Agent 调用。
   * 这里执行：
   *   1. 申请并发槽位（runCoordinator.acquire）
   *   2. 在 messageQueue 上 block 该 scope（run 期间新消息只累积不 flush）
   *   3. 合并 batch 的 text / attachments / parentMessageId
   *   4. 调用原有的 handleUserMessage 走完所有现有流程
   *   5. finally 释放槽位 + unblock 队列（重新 arm quiet window）
   *
   * fire-and-forget：onFlush 不能阻塞 ScopedQueue 的内部 timer。
   */
  private flushMessageBatch(scope: string, batch: QueuedFeishuMessage[]): void {
    if (batch.length === 0) return
    void this.runMergedBatch(scope, batch).catch((error) => {
      console.error('[飞书 Bridge] flushMessageBatch 异常', { scope, err: error })
    })
  }

  private async runMergedBatch(scope: string, batch: QueuedFeishuMessage[]): Promise<void> {
    const first = batch[0]!
    const last = batch[batch.length - 1]!

    // 合并：text 用空行拼接；attachments 数组连接；parentMessageId 取最新一条
    const mergedText = batch
      .map((m) => m.text.trim())
      .filter((t) => t.length > 0)
      .join('\n\n')
    const mergedImages = batch.flatMap((m) => m.imageAttachments)
    const mergedFiles = batch.flatMap((m) => m.fileAttachments)
    const parentMessageId = [...batch].reverse().find((m) => m.parentMessageId)?.parentMessageId

    // batch 内的 msgCtx 取最新一条（messageId 用于 thread reply，senderName 等也用最新值）
    const msgCtx: FeishuMessageContext = { ...last.msgCtx }

    if (batch.length > 1) {
      console.log(`[飞书 Bridge] 合并 batch: scope=${scope}, 消息数=${batch.length}, textChars=${mergedText.length}`)
    }

    // 全局并发槽位（跨 chat）+ per-scope 串行（block/unblock）
    // RunCoordinator.acquire() 内部已基于 waiters 队列保证 per-scope 串行：
    // 同一 scope 第二次 acquire 必须等第一次 release 后才返回。
    const release = await this.runCoordinator.acquire(scope, first.msgCtx.chatId)
    this.messageQueue.block(scope)
    try {
      await this.handleUserMessage(msgCtx, mergedText, mergedImages, mergedFiles, parentMessageId)
    } finally {
      release()
      this.messageQueue.unblock(scope)
    }
  }

  private async handleCommand(msgCtx: FeishuMessageContext, text: string): Promise<void> {
    // 命令实现已统一到 BridgeCommandHandler；飞书通过 renderers / 钩子保留卡片与绑定字段
    await this.commandHandler.handleIncomingMessage(msgCtx.chatId, text, msgCtx)
  }

  /**
   * `/now` 的飞书卡片。
   *
   * 排版与迁移前一致：字段加粗、MCP/Skills 用「启用/停用」文字、空态显式写「无」。
   */
  private buildNowCard(snapshot: BridgeNowSnapshot): Record<string, unknown> {
    const lines: string[] = []

    if (snapshot.session && snapshot.model) {
      lines.push(`**会话**: ${snapshot.session.title} (\`${snapshot.session.idPrefix}\`)`)
      lines.push(
        `**模型**: ${snapshot.model.channelName} / ${snapshot.model.modelName}${snapshot.model.valid ? '' : '（已失效）'}`,
      )
      lines.push(`**内核**: ${snapshot.runtimeLabel}`)
    } else {
      lines.push('**会话**: 未绑定（发送消息将自动创建）')
    }

    if (snapshot.workspace) {
      lines.push(`**工作区**: ${snapshot.workspace.name} (\`${snapshot.workspace.slug}\`)`)

      if (snapshot.mcpServers.length > 0) {
        lines.push('')
        lines.push('**MCP Servers**:')
        for (const mcp of snapshot.mcpServers) {
          lines.push(`  ${mcp.enabled ? '启用' : '停用'} ${mcp.name}`)
        }
      } else {
        lines.push('**MCP Servers**: 无')
      }

      if (snapshot.skills.length > 0) {
        lines.push('')
        lines.push('**Skills**:')
        for (const skill of snapshot.skills) {
          lines.push(`  ${skill.enabled ? '启用' : '停用'} ${skill.name}`)
        }
      } else {
        lines.push('**Skills**: 无')
      }

      if (snapshot.workspaceFiles.length > 0) {
        lines.push('')
        lines.push('**工作区文件**:')
        for (const line of snapshot.workspaceFiles) {
          lines.push(`  ${line}`)
        }
      }

      if (snapshot.sessionFiles.length > 0) {
        lines.push('')
        lines.push('**会话文件**:')
        for (const line of snapshot.sessionFiles) {
          lines.push(`  ${line}`)
        }
      }
    } else {
      lines.push('**工作区**: 未设置')
    }

    return {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: 'plain_text', content: '当前状态' },
        template: 'blue',
      },
      elements: [{ tag: 'markdown', content: lines.join('\n') }],
    }
  }

  // ===== 会话管理 =====

  /**
   * 解析某个 chat 当前应使用的 Agent 内核。
   *
   * 顺序：binding（建会话时写入） > 会话元数据（旧 binding 无字段时推导） > 全局设置。
   */
  private resolveChatRuntime(binding?: FeishuChatBinding): AgentRuntime {
    const sessionRuntime = binding ? getAgentSessionMeta(binding.sessionId)?.agentRuntime : undefined
    return normalizeAgentRuntime(binding?.agentRuntime ?? sessionRuntime ?? getSettings().agentRuntime)
  }

  private findBindingBySessionId(sessionId: string): FeishuChatBinding | undefined {
    const chatId = this.sessionToChat.get(sessionId)
    if (chatId) return this.chatBindings.get(chatId)
    return Array.from(this.chatBindings.values()).find((binding) => binding.sessionId === sessionId)
  }

  private resolveMirrorUserOpenId(): string | null {
    if (this.lastInteractedUserOpenId && this.lastInteractedUserOpenId !== 'unknown') {
      return this.lastInteractedUserOpenId
    }
    for (const binding of this.chatBindings.values()) {
      if (binding.userId && binding.userId !== 'unknown') return binding.userId
    }
    return null
  }

  private async createSessionMirrorGroup(userOpenId: string, name: string): Promise<string | null> {
    if (!this.client) return null

    try {
      const resp = await this.client.im.chat.create({
        data: {
          name,
          chat_mode: 'group',
          chat_type: 'private',
          user_id_list: [userOpenId],
        },
        params: { user_id_type: 'open_id' },
      })

      if (resp.code && resp.code !== 0) {
        console.error('[飞书 Session 镜像] 创建群返回非 0 code:', resp.code, resp.msg)
        return null
      }

      const chatId = resp.data?.chat_id
      if (!chatId) {
        console.error('[飞书 Session 镜像] 创建群未返回 chat_id:', JSON.stringify(resp).slice(0, 300))
        return null
      }
      return chatId
    } catch (error) {
      console.error('[飞书 Session 镜像] 创建群失败:', error)
      return null
    }
  }

  private updateSessionMirrorGroupName(sessionId: string, title: string): void {
    const binding = this.findBindingBySessionId(sessionId)
    if (!binding || binding.source !== 'session-mirror') return

    const nextName = buildSessionMirrorGroupName({ id: sessionId, title })
    if (binding.groupName === nextName) return

    void this.renameSessionMirrorGroup(binding.chatId, nextName)
      .then((updated) => {
        if (!updated) return
        binding.groupName = nextName
        this.saveBindings()
      })
      .catch((error) => {
        console.error('[飞书 Session 镜像] 更新群名失败:', error)
      })
  }

  private async renameSessionMirrorGroup(chatId: string, name: string): Promise<boolean> {
    if (!this.client) return false

    try {
      const resp = await this.client.im.chat.update({
        path: { chat_id: chatId },
        data: { name },
      })

      if (resp.code && resp.code !== 0) {
        console.warn('[飞书 Session 镜像] 更新群名返回非 0 code:', resp.code, resp.msg)
        return false
      }
      return true
    } catch (error) {
      console.error('[飞书 Session 镜像] 调用更新群名接口失败:', error)
      return false
    }
  }

  // ===== 用户消息处理 =====

  private async handleUserMessage(
    msgCtx: FeishuMessageContext,
    text: string,
    imageAttachments: FeishuImageAttachment[] = [],
    fileAttachments: FeishuFileAttachment[] = [],
    parentMessageId?: string,
  ): Promise<void> {
    const { chatId } = msgCtx
    let binding = this.chatBindings.get(chatId)

    // 自动创建会话（与命令层共用同一套建会话逻辑）
    if (!binding) {
      const created = this.commandHandler.ensureBinding(chatId, msgCtx)
      if (!created) return
      binding = created as FeishuChatBinding
    }

    // 注：之前在此处有 isAgentSessionActive silent skip 兜底，会在
    // 时序"onComplete 触发但 orchestrator finally 还没清 activeSessions"
    // 间隙下吃掉合法 batch（实测重现：第 1 条任务跑完后第 2 条丢失）。
    // 当前架构靠 RunCoordinator 的 per-scope 串行 + ScopedQueue.block/unblock
    // + finishedPromise 三层保证不会真正并发，移除此兜底以避免误丢消息。

    // 保存飞书图片和文件到 session 工作目录，构建文件引用
    const attachedRefs: string[] = []
    const workspace = binding.workspaceId ? getAgentWorkspace(binding.workspaceId) : undefined

    // 诊断：附件应保存但 workspace 为空时立即报错（用户能在 Console 看到）
    const hasAnyAttachment = imageAttachments.length > 0 || fileAttachments.length > 0
    if (hasAnyAttachment && !workspace) {
      console.error(`[飞书 Bridge] 附件保存失败：binding.workspaceId=${binding.workspaceId} 找不到对应工作区！图片数=${imageAttachments.length}, 文件数=${fileAttachments.length}`)
    }
    if (hasAnyAttachment && workspace) {
      console.log(`[飞书 Bridge] 准备保存附件：工作区=${workspace.slug}, sessionId=${binding.sessionId.slice(-8)}, 图片数=${imageAttachments.length}, 文件数=${fileAttachments.length}`)
    }

    if (workspace) {
      for (const img of imageAttachments) {
        try {
          const savedPath = saveImageToSessionShared(
            workspace.slug, binding.sessionId, `feishu-${img.imageKey}`, img.mediaType, img.data,
          )
          attachedRefs.push(`- feishu-${img.imageKey}.${inferExtension(img.mediaType)}: ${savedPath}`)
          console.log(`[飞书 Bridge] 已保存图片: ${savedPath}`)
        } catch (err) {
          console.error(`[飞书 Bridge] 图片保存失败 imageKey=${img.imageKey}:`, err)
        }
      }
      for (const file of fileAttachments) {
        try {
          const savedPath = saveFileToSessionShared(
            workspace.slug, binding.sessionId, file.fileName, file.data,
          )
          attachedRefs.push(`- ${file.fileName}: ${savedPath}`)
          console.log(`[飞书 Bridge] 已保存文件: ${savedPath}`)
        } catch (err) {
          console.error(`[飞书 Bridge] 文件保存失败 fileName=${file.fileName}:`, err)
        }
      }
    }
    const fileReferences = attachedRefs.length > 0
      ? `<attached_files>\n${attachedRefs.join('\n')}\n</attached_files>\n\n`
      : ''

    // 初始化缓冲（保留供桌面通知/降级路径使用）
    this.sessionBuffers.set(binding.sessionId, {
      text: '',
      toolSummaries: new Map(),
      startedAt: Date.now(),
    })

    // 初始化流式卡片：发送一张"思考中"骨架卡，后续 handleAgentPayload 持续 update
    const prefix = this.resolveContextPrefix(chatId)
    const headerTitle = prefix ? `${prefix.trim()} · Agent 处理中` : 'Agent 处理中'
    const initialState = createInitialState()
    this.streamingRunStates.set(binding.sessionId, initialState)
    try {
      const cardStream = await CardStream.open(
        this.client!,
        chatId,
        renderRunCard(initialState, {
          header: headerTitle,
          // 飞书 cardAction 不通过长连接推送，按钮点击会报 200340；
          // 改为文本提示用户用 /stop 命令终止
          stopHint: '发送 `/stop` 可终止当前任务',
        }),
        {
          replyToMessageId: msgCtx.chatType === 'group' ? msgCtx.messageId : undefined,
        },
      )
      this.streamingCards.set(binding.sessionId, cardStream)
      this.streamingCardsUsedSessions.add(binding.sessionId)
    } catch (error) {
      console.error('[飞书 Bridge] 流式卡片创建失败，降级为文本进度提示:', error)
      // 降级：保留原"处理中..."提示，最终走 sendAgentReply 兜底
      await this.sendMessage(chatId, `${prefix}Agent 处理中...`)
    }

    // 纯图片没有文字任务时默认读图；用户有文字时保留其任务。
    const userText = resolveAgentAttachmentPrompt(text, [
      ...imageAttachments.map(() => 'image' as const),
      ...fileAttachments.map(() => 'file' as const),
    ])

    // 拉取被引用消息（用户长按"回复"触发；parent_id 由 handleFeishuMessage 透传）
    let quoted: QuotedMessage | undefined
    if (parentMessageId && this.client) {
      quoted = await fetchQuotedMessage(this.client, parentMessageId)
      if (quoted) {
        console.log(`[飞书 Bridge] 引用消息已注入: type=${quoted.contentType}, chars=${quoted.content.length}`)
      }
    }

    // 群聊上下文 + 历史摘要（保留原 Phase 1 逻辑，作为 group_extra 块）
    let groupExtraBlock: string | undefined
    if (msgCtx.chatType === 'group') {
      const contextParts: string[] = []
      if (msgCtx.groupName) contextParts.push(`[群聊: ${msgCtx.groupName}]`)
      if (msgCtx.senderName) contextParts.push(`[发送者: ${msgCtx.senderName}]`)

      const groupInfo = this.groupInfoCache.get(chatId)
      if (groupInfo?.members && groupInfo.members.length > 0) {
        const membersExceptBot = groupInfo.members.filter((m) => m.openId !== this.botOpenId)
        const memberList = membersExceptBot.map((m) => `${m.name}(${m.openId})`).join(', ')
        contextParts.push(`[群成员: ${memberList}]`)
        contextParts.push('[提示: 如需 @某人，请直接使用 @姓名 格式，如 @Alice，系统会自动转换为飞书 @mention]')
      }

      const chatHistory = await this.fetchChatHistory(chatId)
      const historyContext = this.formatChatHistoryContext(chatHistory)

      const parts: string[] = []
      if (contextParts.length > 0) parts.push(contextParts.join(' '))
      if (historyContext) parts.push(historyContext)
      groupExtraBlock = parts.length > 0 ? parts.join('\n') : undefined
    }

    const bridgeContext: BridgeContext = {
      chatId: msgCtx.chatId,
      chatType: msgCtx.chatType,
      senderOpenId: msgCtx.senderOpenId,
      senderName: msgCtx.senderName,
    }

    const agentMessage = buildAgentUserMessage({
      userText,
      context: bridgeContext,
      quoted,
      attachedFilesBlock: fileReferences.trim() || undefined,
      groupExtraBlock,
    })

    // fire-and-forget，不阻塞事件回调
    // 群聊时注入动态 MCP 工具（允许 Agent 主动拉取更多群聊历史）
    let customMcpServers: Record<string, Record<string, unknown>> | undefined
    if (msgCtx.chatType === 'group') {
      const mcpServer = await this.createFeishuChatMcpServer(chatId)
      if (mcpServer) {
        customMcpServers = { feishu_chat: mcpServer as unknown as Record<string, unknown> }
      }
    }

    // 渠道/模型解析：binding（per-chat 用户在 IM 里切过的）优先，其次 Bot 配置、应用设置
    const latestSettings = getSettings()
    const agentRuntime = this.resolveChatRuntime(binding)
    const preferredChannelId = binding.channelId || this.botConfig.defaultChannelId || latestSettings.agentChannelId || ''
    // 旧 binding 可能指向未启用当前内核的渠道；不兼容时回退到可用渠道，避免发送阶段才报错
    const picked = preferredChannelId
      ? resolveChannelIdForRuntime(preferredChannelId, agentRuntime)
      : null
    if (picked?.fellBack) {
      console.warn(
        `[飞书 Bridge] 渠道 ${preferredChannelId} 未启用 ${describeAgentRuntime(agentRuntime)} 内核，本次发送改用 ${picked.channelId}`,
      )
    }
    const channelId = picked?.channelId ?? preferredChannelId
    // 回退渠道时全局/绑定模型可能不属于新渠道，按渠道重新解析，避免落到默认 claude 模型。
    const modelId = resolveModelIdForChannel(
      channelId,
      binding.modelId || this.botConfig.defaultModelId || latestSettings.agentModelId,
    )

    const input: AgentSendInput = {
      sessionId: binding.sessionId,
      userMessage: agentMessage,
      // 桌面端只展示用户原文；prompt 工程块（bridge_context/引用/附件）不进气泡
      rawUserMessage: userText,
      titleSourceText: userText,
      channelId,
      modelId,
      workspaceId: binding.workspaceId,
      permissionModeOverride: 'bypassPermissions',
      ...(customMcpServers && { customMcpServers }),
    }

    // 直接 await runAgentHeadless 的 Promise——它会在 orchestrator.sendMessage
    // 完整 await 结束（包含 finally { activeSessions.delete }）后才 resolve。
    // 这是消除并发守卫竞态的核心：上层 runMergedBatch 看到本 Promise resolve
    // 时，orchestrator 已经清理干净，下一个 batch 立刻调 sendMessage 不会撞守卫。
    try {
      await runAgentHeadless(input, {
        source: 'feishu',
        onError: (error) => {
          const errPrefix = this.resolveContextPrefix(chatId)
          // 优先把错误显示到流式卡上；没有流式卡才发独立错误卡
          if (this.streamingCards.has(binding!.sessionId)) {
            this.markStreamingError(binding!.sessionId, error)
          } else {
            this.sendCardMessage(chatId, buildErrorCard(`${errPrefix}${error}`)).catch(console.error)
          }
          this.sessionBuffers.delete(binding!.sessionId)
          this.streamingCardsUsedSessions.delete(binding!.sessionId)
        },
        onComplete: () => {
          // complete 事件由 EventBus listener 处理
        },
        onTitleUpdated: (_title) => {
          // 标题更新可选通知
        },
      })
    } catch (error) {
      console.error('[飞书 Bridge] Agent 运行异常:', error)
    }
  }

  // ===== EventBus 事件处理 =====

  private handleAgentPayload(sessionId: string, payload: AgentStreamPayload): void {
    // 对于飞书发起的会话，缓冲由 handleUserMessage 初始化
    // 对于桌面发起的会话，complete 事件时检查是否需要通知
    const buffer = this.sessionBuffers.get(sessionId)

    // 流式卡片更新（飞书发起的会话才有）
    const runState = this.streamingRunStates.get(sessionId)
    const cardStream = this.streamingCards.get(sessionId)
    if (runState && cardStream) {
      const nextState = reduceRunState(runState, payload)
      if (nextState !== runState) {
        this.streamingRunStates.set(sessionId, nextState)
        const header = this.resolveContextPrefix(this.sessionToChat.get(sessionId) ?? '')
        const headerTitle = (header ? `${header.trim()} · ` : '') +
          (nextState.terminal === 'running' ? 'Agent 处理中' : 'Agent 已完成')
        const card = renderRunCard(nextState, {
          header: headerTitle,
          stopHint: nextState.terminal === 'running' ? '发送 `/stop` 可终止当前任务' : undefined,
        })
        if (nextState.terminal === 'running') {
          cardStream.update(card)
        } else {
          // 终态：强制 flush 然后 close
          void cardStream.flush(card).then(() => cardStream.close()).catch((err) => {
            console.error('[飞书 Bridge] 流式卡片终态刷新失败:', err)
          })
          this.streamingRunStates.delete(sessionId)
          this.streamingCards.delete(sessionId)
        }
      }
    }

    if (buffer && payload.kind === 'sdk_message') {
      const msg = payload.message
      // 从 assistant 消息中提取文本与工具使用摘要
      if (msg.type === 'assistant') {
        const aMsg = msg as SDKAssistantMessage
        for (const block of aMsg.message?.content ?? []) {
          if (block.type === 'text') {
            const text = (block as { text?: unknown }).text
            if (typeof text === 'string') buffer.text += text
          } else if (block.type === 'tool_use') {
            const tb = block as { name?: unknown }
            if (typeof tb.name === 'string') {
              accumulateToolStart(buffer.toolSummaries, tb.name)
            }
          }
        }
      }
      // 从 user tool_result 中检测错误（暂未精细处理，预留扩展点）
      if (msg.type === 'user') {
        const uMsg = msg as SDKUserMessage
        for (const block of uMsg.message?.content ?? []) {
          if (block.type === 'tool_result') {
            // 标记工具有错误（简化处理：无法确定具体工具名）
          }
        }
      }
    }

    // result 路由要放在 buffer 守卫外：桌面发起且未启用 Session 镜像时
    // 没有任何状态需要清理，直接 no-op；启用镜像时由流式卡分支兜住。
    if (payload.kind === 'sdk_message' && payload.message.type === 'result') {
      if (buffer) {
        this.handleFeishuSessionComplete(sessionId)
      } else if (this.streamingTerminalHandledSessions.has(sessionId)) {
        this.streamingTerminalHandledSessions.delete(sessionId)
      } else if (this.streamingCardsUsedSessions.has(sessionId)) {
        // 桌面 Session 镜像已经在流式卡片里完成终态展示，避免重复处理。
        this.streamingCardsUsedSessions.delete(sessionId)
      }
      return
    }

    // SDK assistant 帧偶尔会带顶层 error 字段（非 result 路径）
    // 流式卡场景下 reducer 已转 error 终态；降级路径需要这里补发独立错误卡
    if (payload.kind === 'sdk_message' && payload.message.type === 'assistant') {
      const aMsg = payload.message as SDKAssistantMessage
      if (aMsg.error?.message) {
        const chatId = this.sessionToChat.get(sessionId)
        if (chatId && !this.streamingCardsUsedSessions.has(sessionId)) {
          const prefix = this.resolveContextPrefix(chatId)
          this.sendCardMessage(chatId, buildErrorCard(`${prefix}${aMsg.error.message}`)).catch(console.error)
        }
        this.sessionBuffers.delete(sessionId)
        // 流式卡片同步标记 error（若用过流式卡）
        this.markStreamingError(sessionId, aMsg.error.message)
      }
    }

    if (payload.kind === 'profer_event' && payload.event.type === 'title_updated') {
      this.updateSessionMirrorGroupName(sessionId, payload.event.title)
    }
  }

  /** 给流式卡片打上 error 终态，立即 flush + close。 */
  private markStreamingError(sessionId: string, message: string): void {
    const runState = this.streamingRunStates.get(sessionId)
    const cardStream = this.streamingCards.get(sessionId)
    if (!runState || !cardStream) return
    const nextState = markError(runState, message)
    const header = this.resolveContextPrefix(this.sessionToChat.get(sessionId) ?? '')
    const headerTitle = (header ? `${header.trim()} · ` : '') + 'Agent 出错'
    void cardStream
      .flush(renderRunCard(nextState, { header: headerTitle }))
      .then(() => cardStream.close())
      .catch((err) => console.error('[飞书 Bridge] error 终态刷新失败:', err))
    this.streamingRunStates.delete(sessionId)
    this.streamingCards.delete(sessionId)
  }

  /** 给流式卡片打上 interrupted 终态。用于用户主动 /stop 或终止按钮触发。 */
  private markStreamingInterrupted(sessionId: string): void {
    const runState = this.streamingRunStates.get(sessionId)
    const cardStream = this.streamingCards.get(sessionId)
    if (!runState || !cardStream) return
    const nextState = markInterrupted(runState)
    const header = this.resolveContextPrefix(this.sessionToChat.get(sessionId) ?? '')
    const headerTitle = (header ? `${header.trim()} · ` : '') + 'Agent 已中断'
    void cardStream
      .flush(renderRunCard(nextState, { header: headerTitle }))
      .then(() => cardStream.close())
      .catch((err) => console.error('[飞书 Bridge] interrupted 终态刷新失败:', err))
    this.streamingRunStates.delete(sessionId)
    this.streamingCards.delete(sessionId)
    // stop 后 Agent 仍可能推 result，需清掉 buffer 与 used 标志避免后续触发 sendAgentReply
    this.sessionBuffers.delete(sessionId)
    this.streamingCardsUsedSessions.delete(sessionId)
    this.markTerminalHandled(sessionId)
  }

  /** 懒回收的 5 分钟兜底（防御 Agent 异常退出导致 result 不到达）。 */
  private static readonly TERMINAL_HANDLED_TTL_MS = 5 * 60 * 1000

  private markTerminalHandled(sessionId: string): void {
    const now = Date.now()
    for (const [sid, ts] of this.streamingTerminalHandledSessions) {
      if (now - ts > FeishuBridge.TERMINAL_HANDLED_TTL_MS) {
        this.streamingTerminalHandledSessions.delete(sid)
      }
    }
    this.streamingTerminalHandledSessions.set(sessionId, now)
  }

  /** 飞书发起的会话完成：发送完整回复到飞书 */
  private handleFeishuSessionComplete(sessionId: string): void {
    const buffer = this.sessionBuffers.get(sessionId)
    if (!buffer) return

    const usedStreamingCard = this.streamingCardsUsedSessions.has(sessionId)
    this.streamingCardsUsedSessions.delete(sessionId)

    const duration = (Date.now() - buffer.startedAt) / 1000
    const toolSummaries = Array.from(buffer.toolSummaries.values())
    const result: FormattedAgentResult = {
      text: buffer.text,
      toolSummaries,
      duration,
    }

    const chatId = this.sessionToChat.get(sessionId)
    // 用过流式卡时跳过 sendAgentReply：流式卡已经把完整内容呈现给用户
    if (chatId && !usedStreamingCard) {
      this.sendAgentReply(chatId, result).catch(console.error)
    }

    this.sessionBuffers.delete(sessionId)
  }

  private async sendAgentReply(chatId: string, result: FormattedAgentResult): Promise<void> {
    const subtitle = this.resolveContextSubtitle(chatId)

    if (!result.text.trim()) {
      await this.sendMessage(chatId, `${subtitle ? `${subtitle} | ` : ''}Agent 已完成（无文本输出）`)
      return
    }

    // 群聊时，将 @Name 转换为飞书 <at> 标签
    const binding = this.chatBindings.get(chatId)
    const processedResult: FormattedAgentResult = {
      ...result,
      text: binding?.chatType === 'group'
        ? this.convertMentionsToAtTags(result.text, chatId)
        : result.text,
    }

    const chunks = splitLongContent(processedResult.text)

    if (chunks.length === 1) {
      // 单条卡片
      await this.sendCardMessage(chatId, buildAgentReplyCard(processedResult, subtitle))
    } else {
      // 多条消息
      for (let i = 0; i < chunks.length; i++) {
        const chunkResult: FormattedAgentResult = {
          text: chunks[i]!,
          toolSummaries: i === chunks.length - 1 ? processedResult.toolSummaries : [],
          duration: i === chunks.length - 1 ? processedResult.duration : 0,
        }
        await this.sendCardMessage(chatId, buildAgentReplyCard(chunkResult, subtitle))
      }
    }
  }

  /**
   * 将 Agent 文本中的 @Name 转换为飞书卡片 markdown 的 <at id=open_id>Name</at> 格式
   *
   * 匹配规则：@Name 中的 Name 必须与群成员缓存中的某个成员名称完全匹配。
   */
  private convertMentionsToAtTags(text: string, chatId: string): string {
    const groupInfo = this.groupInfoCache.get(chatId)
    if (!groupInfo?.members || groupInfo.members.length === 0) return text

    // 构建 name → openId 映射（排除 Bot 自身）
    const nameToId = new Map<string, string>()
    for (const m of groupInfo.members) {
      if (m.openId !== this.botOpenId) {
        nameToId.set(m.name, m.openId)
      }
    }
    if (nameToId.size === 0) return text

    // 按名称长度降序排列，避免短名称先匹配导致长名称被截断
    const names = Array.from(nameToId.keys()).sort((a, b) => b.length - a.length)
    // 构建正则：匹配 @Name（Name 为群成员名称）
    const escaped = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    const pattern = new RegExp(`@(${escaped.join('|')})(?![\\w])`, 'g')

    return text.replace(pattern, (_, name: string) => {
      const openId = nameToId.get(name)
      return openId ? `<at id=${openId}>${name}</at>` : `@${name}`
    })
  }

  // ===== 飞书 API =====

  /** 向去重集合添加 ID，保持集合大小不超过上限 */
  private addToDedup(set: Set<string>, id: string): void {
    set.add(id)
    if (set.size > FeishuBridge.DEDUP_MAX) {
      const first = set.values().next().value as string
      set.delete(first)
    }
  }

  // ===== 群聊辅助方法 =====

  /**
   * 从 mention.id 中提取 open_id
   *
   * 飞书事件中 mention.id 可能是字符串（如 "all"）或对象 { open_id, union_id, user_id }。
   */
  private extractMentionOpenId(mention: FeishuMention): string | null {
    const { id } = mention
    if (typeof id === 'string') return id
    if (typeof id === 'object' && id !== null) return id.open_id ?? null
    return null
  }

  /**
   * 检测消息的 mentions 列表中是否包含 @Bot
   *
   * 优先用 botOpenId 精确匹配；未获取时尝试重新获取。
   * 飞书群聊 @所有人 时 mention.id 为 "all"，直接排除。
   */
  private async isBotMentioned(mentions: FeishuMention[] | undefined): Promise<boolean> {
    if (!mentions || mentions.length === 0) return false

    // 提取所有 mention 的 open_id，排除 @所有人
    const mentionIds = mentions
      .map((m) => ({ name: m.name, openId: this.extractMentionOpenId(m) }))
      .filter((m) => m.openId && m.openId !== 'all')
    if (mentionIds.length === 0) return false

    // 如果 botOpenId 未获取，尝试重新获取
    if (!this.botOpenId && this.client) {
      try {
        const botInfoResp = await this.client.request<{
          bot?: { open_id?: string }
          data?: { bot?: { open_id?: string } }
        }>({
          method: 'GET',
          url: 'https://open.feishu.cn/open-apis/bot/v3/info/',
        })
        this.botOpenId = botInfoResp?.bot?.open_id ?? botInfoResp?.data?.bot?.open_id ?? null
        if (this.botOpenId) {
          console.log(`[飞书 Bridge] 延迟获取 Bot open_id 成功: ${this.botOpenId}`)
        }
      } catch (error) {
        console.warn('[飞书 Bridge] 延迟获取 Bot info 失败:', error)
      }
    }

    if (this.botOpenId) {
      const matched = mentionIds.some((m) => m.openId === this.botOpenId)
      if (!matched) {
        console.log(`[飞书 Bridge] @Bot 未匹配 — botOpenId=${this.botOpenId}, mentions=[${mentionIds.map((m) => `${m.name}(${m.openId})`).join(', ')}]`)
      }
      return matched
    }

    // botOpenId 仍未获取：拒绝，避免 @其他人误触发
    console.warn(`[飞书 Bridge] botOpenId 未获取，无法精确匹配，跳过消息（mentions: ${mentionIds.map((m) => `${m.name}(${m.openId})`).join(', ')}）`)
    return false
  }

  /**
   * 获取群聊信息（带缓存，TTL 1 小时）
   */
  private async getGroupInfo(chatId: string): Promise<FeishuGroupInfo | null> {
    const cached = this.groupInfoCache.get(chatId)
    if (cached && Date.now() - cached.cachedAt < FeishuBridge.GROUP_CACHE_TTL) {
      return cached
    }

    if (!this.client) return null

    try {
      const [chatResp, members] = await Promise.all([
        this.client.im.chat.get({ path: { chat_id: chatId } }),
        this.fetchGroupMembers(chatId),
      ])
      const name = chatResp?.data?.name ?? '未知群组'
      const description = chatResp?.data?.description

      // user_count 是飞书侧权威的真人数量（不含机器人），免 @ 续聊判定优先用它。
      // chat.get 需要 im:chat 权限；拿不到时记日志提示，判定会回退到成员列表。
      const rawUserCount = chatResp?.data?.user_count
      const userCount = rawUserCount != null ? Number(rawUserCount) : undefined
      const normalizedUserCount = Number.isFinite(userCount) ? userCount : undefined
      if (normalizedUserCount === undefined) {
        console.warn(
          `[飞书 Bridge] chat.get 未返回 user_count（chatId=${chatId}）——` +
          `请确认已申请并发布 im:chat 权限（读取群基础信息），否则「仅你和 Bot 的群」无法免 @ 续聊。`,
        )
      }

      const info: FeishuGroupInfo = {
        chatId, name, description, members, userCount: normalizedUserCount, cachedAt: Date.now(),
      }
      this.groupInfoCache.set(chatId, info)

      // 同时填充 userNameCache
      for (const m of members) {
        this.userNameCache.set(m.openId, m.name)
      }

      return info
    } catch (error) {
      console.warn('[飞书 Bridge] 获取群聊信息失败:', error)
      return null
    }
  }

  /**
   * 拉取群成员列表（最多 100 人，不含机器人）
   */
  private async fetchGroupMembers(chatId: string): Promise<FeishuGroupMember[]> {
    if (!this.client) return []

    try {
      const resp = await this.client.im.chatMembers.get({
        path: { chat_id: chatId },
        params: { member_id_type: 'open_id', page_size: 100 },
      })
      const items = resp?.data?.items ?? []
      return items
        .filter((item) => item.member_id && item.name)
        .map((item) => ({ openId: item.member_id!, name: item.name! }))
    } catch (error) {
      console.warn('[飞书 Bridge] 获取群成员列表失败:', error)
      return []
    }
  }

  /**
   * 获取用户显示名称（带缓存）
   *
   * 失败时回退返回 open_id 前 8 位。
   */
  private async getUserName(openId: string): Promise<string> {
    const cached = this.userNameCache.get(openId)
    if (cached) return cached

    if (!this.client) return openId.slice(0, 8)

    try {
      const resp = await this.client.contact.user.get({
        path: { user_id: openId },
        params: { user_id_type: 'open_id' },
      })
      const name = resp?.data?.user?.name
      if (name) {
        this.userNameCache.set(openId, name)
        return name
      }
    } catch (error) {
      console.warn('[飞书 Bridge] 获取用户信息失败:', error)
    }

    return openId.slice(0, 8)
  }

  // ===== 群聊消息历史 =====

  /** 默认拉取的群聊历史消息数量 */
  private static readonly DEFAULT_HISTORY_COUNT = 20

  /**
   * 获取聊天历史消息
   *
   * 调用 `im/v1/messages` 接口，按时间倒序拉取指定数量的消息。
   * 需要 `im:message.group_msg` 权限。
   */
  private async fetchChatHistory(
    chatId: string,
    options?: {
      pageSize?: number
      beforeTimestamp?: number
    },
  ): Promise<FeishuChatMessage[]> {
    if (!this.client) return []

    try {
      const pageSize = Math.min(options?.pageSize ?? FeishuBridge.DEFAULT_HISTORY_COUNT, 50)
      const endTime = options?.beforeTimestamp
        ? Math.floor(options.beforeTimestamp / 1000).toString()
        : undefined

      const resp = await this.client.im.message.list({
        params: {
          container_id_type: 'chat',
          container_id: chatId,
          sort_type: 'ByCreateTimeDesc',
          page_size: pageSize,
          ...(endTime && { end_time: endTime }),
        },
      })

      if (resp.code !== 0) {
        console.warn('[飞书 Bridge] 获取聊天历史失败:', resp.msg)
        return []
      }

      const items = resp.data?.items ?? []
      const messages: FeishuChatMessage[] = []

      for (const item of items) {
        // 跳过已删除的消息
        if (item.deleted) continue

        const senderId = item.sender?.id ?? 'unknown'
        const senderType = (item.sender?.sender_type ?? 'unknown') as FeishuChatMessage['senderType']
        const msgType = item.msg_type ?? 'unknown'
        const createTime = Number(item.create_time ?? 0)

        // 解析消息内容
        const content = this.parseChatMessageContent(msgType, item.body?.content)

        messages.push({
          messageId: item.message_id ?? '',
          senderId,
          senderType,
          msgType,
          content,
          createTime,
        })
      }

      // 按时间正序返回（API 返回的是倒序）
      messages.reverse()

      // 异步解析发送者名称（不阻塞返回）
      await this.resolveMessageSenderNames(messages)

      return messages
    } catch (error) {
      console.warn('[飞书 Bridge] 获取聊天历史异常:', error)
      return []
    }
  }

  /**
   * 解析消息内容为可读文本
   */
  private parseChatMessageContent(msgType: string, rawContent?: string): string {
    if (!rawContent) return '[空消息]'

    try {
      switch (msgType) {
        case 'text': {
          const parsed = JSON.parse(rawContent) as { text?: string }
          return parsed.text ?? ''
        }
        case 'post': {
          // 富文本消息，提取纯文本
          const parsed = JSON.parse(rawContent) as {
            title?: string
            content?: Array<Array<{ tag: string; text?: string }>>
          }
          const parts: string[] = []
          if (parsed.title) parts.push(parsed.title)
          for (const line of parsed.content ?? []) {
            const lineText = line
              .filter((el) => el.tag === 'text' && el.text)
              .map((el) => el.text)
              .join('')
            if (lineText) parts.push(lineText)
          }
          return parts.join('\n') || '[富文本消息]'
        }
        case 'interactive':
          return '[交互卡片]'
        case 'image':
          return '[图片]'
        case 'file':
          return '[文件]'
        case 'audio':
          return '[语音]'
        case 'media':
          return '[视频]'
        case 'sticker':
          return '[表情]'
        case 'share_chat':
          return '[群名片]'
        case 'share_user':
          return '[个人名片]'
        default:
          return `[${msgType}]`
      }
    } catch {
      return `[${msgType}]`
    }
  }

  /**
   * 批量解析消息发送者名称
   */
  private async resolveMessageSenderNames(messages: FeishuChatMessage[]): Promise<void> {
    const uniqueUserIds = new Set<string>()
    for (const msg of messages) {
      if (msg.senderType === 'user' && !this.userNameCache.has(msg.senderId)) {
        uniqueUserIds.add(msg.senderId)
      }
    }

    // 并发获取用户名称（最多 10 个并发）
    const userIds = Array.from(uniqueUserIds).slice(0, 10)
    await Promise.allSettled(userIds.map((id) => this.getUserName(id)))

    // 回填名称
    for (const msg of messages) {
      if (msg.senderType === 'user') {
        msg.senderName = this.userNameCache.get(msg.senderId)
      } else if (msg.senderType === 'app') {
        msg.senderName = 'Bot'
      }
    }
  }

  /**
   * 将消息历史格式化为 Agent 可读的上下文文本
   */
  private formatChatHistoryContext(messages: FeishuChatMessage[]): string {
    if (messages.length === 0) return ''

    const lines = messages.map((msg) => {
      const time = new Date(msg.createTime).toLocaleTimeString('zh-CN', {
        hour: '2-digit',
        minute: '2-digit',
      })
      const sender = msg.senderName ?? msg.senderId.slice(0, 8)
      const role = msg.senderType === 'app' ? 'Bot' : sender
      return `[${time}] ${role}: ${msg.content}`
    })

    return [
      '--- 群聊历史消息（最近） ---',
      ...lines,
      '--- 历史消息结束 ---',
    ].join('\n')
  }

  /**
   * 创建飞书群聊 MCP 服务器（动态工具，仅在群聊 Agent 会话中注入）
   *
   * 提供 `fetch_group_chat_history` 工具，让 Agent 可以主动拉取更多群聊历史。
   */
  private async createFeishuChatMcpServer(
    chatId: string,
  ): Promise<Record<string, unknown> | null> {
    try {
      const sdk = await import('@anthropic-ai/claude-agent-sdk')
      const { z } = await import('zod')

      const server = sdk.createSdkMcpServer({
        name: 'feishu_chat',
        version: '1.0.0',
        tools: [
          sdk.tool(
            'fetch_group_chat_history',
            '获取飞书群聊的历史消息。当你需要了解更多群聊上下文来完成任务时使用此工具。' +
            '返回指定数量的历史消息，包含发送者、时间和内容。',
            {
              limit: z.number().min(1).max(50).optional()
                .describe('要获取的消息数量（默认 20，最多 50）'),
              before_timestamp: z.number().optional()
                .describe('获取此时间戳（毫秒）之前的消息，用于向前翻页'),
            },
            async (args) => {
              const messages = await this.fetchChatHistory(chatId, {
                pageSize: args.limit,
                beforeTimestamp: args.before_timestamp,
              })

              if (messages.length === 0) {
                return {
                  content: [{ type: 'text' as const, text: '没有更多历史消息。' }],
                }
              }

              const formatted = this.formatChatHistoryContext(messages)
              const oldestTimestamp = messages[0]?.createTime ?? 0

              return {
                content: [{
                  type: 'text' as const,
                  text: `${formatted}\n\n（如需更早的消息，使用 before_timestamp: ${oldestTimestamp}）`,
                }],
              }
            },
            { annotations: { readOnlyHint: true } },
          ),
        ],
      })

      console.log('[飞书 Bridge] 已创建群聊 MCP 工具')
      return server as unknown as Record<string, unknown>
    } catch (error) {
      console.warn('[飞书 Bridge] 创建群聊 MCP 工具失败:', error)
      return null
    }
  }

  /**
   * 解析消息上下文前缀：[工作区名称]->[会话名称]：
   *
   * 用于在每条回复的飞书消息开头标注来源，方便用户区分。
   */
  private resolveContextPrefix(chatId: string): string {
    const binding = this.chatBindings.get(chatId)
    if (!binding) return ''

    const workspace = binding.workspaceId ? getAgentWorkspace(binding.workspaceId) : undefined
    const session = getAgentSessionMeta(binding.sessionId)

    const wsName = workspace?.name ?? '默认工作区'
    const sessName = session?.title ?? binding.sessionId.slice(0, 8)

    return `[${wsName}]->[${sessName}]：`
  }

  /** 获取卡片 header subtitle 用的上下文描述 */
  private resolveContextSubtitle(chatId: string): string {
    const binding = this.chatBindings.get(chatId)
    if (!binding) return ''

    const workspace = binding.workspaceId ? getAgentWorkspace(binding.workspaceId) : undefined
    const session = getAgentSessionMeta(binding.sessionId)

    const wsName = workspace?.name ?? '默认工作区'
    const sessName = session?.title ?? binding.sessionId.slice(0, 8)

    return `${wsName} · ${sessName}`
  }

  private async sendTextMessage(chatId: string, text: string): Promise<void> {
    if (!this.client) return

    try {
      const resp = await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text }),
        },
      })
      // 将 Bot 发出的消息 ID 加入去重集合，防止回环
      const sentId = (resp?.data as Record<string, unknown>)?.message_id as string | undefined
      if (sentId) this.addToDedup(this.recentMessageIds, sentId)
    } catch (error) {
      console.error('[飞书 Bridge] 发送文本消息失败:', error)
    }
  }

  private async sendCard(chatId: string, card: Record<string, unknown>): Promise<void> {
    if (!this.client) return

    try {
      const resp = await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'interactive',
          content: JSON.stringify(card),
        },
      })
      // 将 Bot 发出的消息 ID 加入去重集合，防止回环
      const sentId = (resp?.data as Record<string, unknown>)?.message_id as string | undefined
      if (sentId) this.addToDedup(this.recentMessageIds, sentId)
    } catch (error) {
      console.error('[飞书 Bridge] 发送卡片消息失败:', error)
    }
  }

  /** 主动向指定飞书聊天发送卡片，不绑定上一条用户消息线程。 */
  async sendCardToChat(chatId: string, card: Record<string, unknown>): Promise<void> {
    await this.sendCard(chatId, card)
  }

  // ===== 群聊 Thread Reply =====

  /** 回复指定消息（文本，群聊线程回复） */
  private async replyTextMessage(messageId: string, text: string): Promise<void> {
    if (!this.client) return

    try {
      const resp = await this.client.im.message.reply({
        path: { message_id: messageId },
        data: {
          content: JSON.stringify({ text }),
          msg_type: 'text',
        },
      })
      const sentId = (resp?.data as Record<string, unknown>)?.message_id as string | undefined
      if (sentId) this.addToDedup(this.recentMessageIds, sentId)
    } catch (error) {
      console.error('[飞书 Bridge] 回复文本消息失败:', error)
    }
  }

  /** 回复指定消息（卡片，群聊线程回复） */
  private async replyCard(messageId: string, card: Record<string, unknown>): Promise<void> {
    if (!this.client) return

    try {
      const resp = await this.client.im.message.reply({
        path: { message_id: messageId },
        data: {
          content: JSON.stringify(card),
          msg_type: 'interactive',
        },
      })
      const sentId = (resp?.data as Record<string, unknown>)?.message_id as string | undefined
      if (sentId) this.addToDedup(this.recentMessageIds, sentId)
    } catch (error) {
      console.error('[飞书 Bridge] 回复卡片消息失败:', error)
    }
  }

  /**
   * 发送文本消息到聊天（自动选择回复或新建）
   *
   * 群聊时使用 reply（线程回复），单聊时使用 create。
   */
  private async sendMessage(chatId: string, text: string): Promise<void> {
    const binding = this.chatBindings.get(chatId)
    const replyToId = binding?.chatType === 'group'
      ? this.lastUserMessageId.get(chatId)
      : undefined

    if (replyToId) {
      await this.replyTextMessage(replyToId, text)
    } else {
      await this.sendTextMessage(chatId, text)
    }
  }

  /**
   * 发送卡片消息到聊天（自动选择回复或新建）
   */
  private async sendCardMessage(chatId: string, card: Record<string, unknown>): Promise<void> {
    const binding = this.chatBindings.get(chatId)
    const replyToId = binding?.chatType === 'group'
      ? this.lastUserMessageId.get(chatId)
      : undefined

    if (replyToId) {
      await this.replyCard(replyToId, card)
    } else {
      await this.sendCard(chatId, card)
    }
  }

  // ===== 状态更新与广播 =====

  private updateStatus(partial: Partial<FeishuBridgeState>): void {
    this.status = { ...this.status, ...partial }

    // 广播到渲染进程（包含 botId 和 botName）
    const windows = BrowserWindow.getAllWindows()
    if (windows.length > 0 && !windows[0]!.isDestroyed()) {
      windows[0]!.webContents.send(FEISHU_IPC_CHANNELS.STATUS_CHANGED, {
        ...this.status,
        botId: this.botConfig.id,
        botName: this.botConfig.name,
      })
    }
  }
}

// ===== 导出类（由 FeishuBridgeManager 创建实例） =====

export { FeishuBridge }
