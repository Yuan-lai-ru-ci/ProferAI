/**
 * 平板端 electronAPI 桥
 *
 * 分层职责：
 * 1. 事件桥：onAgentStreamEvent 等 IPC 事件注册器 → WS agent_event 分发。
 *    桌面渲染层（useGlobalAgentListeners / AgentView / LeftSidebar 依赖树）只感知
 *    electronAPI 形状；平板通过 emitTabletAgentStreamEvent() 把 WS 事件喂回注册器，
 *    使桌面组件的事件处理逻辑 100% 复用（与桌面 IPC AgentStreamEvent 同形状）。
 * 2. 命令映射：AgentView / LeftSidebar 用到的 IPC 命令 → WS 远程命令。
 * 3. 降级层：平板无意义的桌面能力（本地文件对话框 / 知识库 / 进程面板 / 分叉回退）→
 *    安全空实现或明确报错，避免复用组件崩溃或出现“可点但无效果”的伪按钮。
 */

import type { AgentStreamEvent, AgentStreamCompletePayload } from '@profer/shared'

/** WsClient 满足的最小远程命令面（与 ws-client.ts 方法一一对应） */
interface TabletRemoteClient {
  listSessions(): Promise<unknown>
  listWorkspaces(): Promise<unknown>
  listChannels(): Promise<unknown>
  createSession(payload: { title?: string; channelId?: string; workspaceId?: string; modelId?: string }): Promise<unknown>
  renameSession(sessionId: string, title: string): Promise<unknown>
  getSdkMessages(sessionId: string): Promise<unknown>
  sendMessage(payload: { sessionId: string; userMessage: string; channelId: string; modelId?: string; workspaceId?: string }): Promise<unknown>
  updateSessionModel(sessionId: string, channelId: string, modelId?: string): Promise<unknown>
  updateSessionRuntime(sessionId: string, runtime: 'claude' | 'pi'): Promise<unknown>
  updatePermissionMode(sessionId: string, mode: 'auto' | 'plan' | 'bypassPermissions'): Promise<unknown>
  stopAgent(sessionId: string): Promise<unknown>
}

let remoteClient: TabletRemoteClient | null = null

/** 在 WebSocket 建连后注入，使原生桌面组件沿用 electronAPI 形状调用远程服务。 */
export function setTabletRemoteClient(client: TabletRemoteClient | null): void {
  remoteClient = client
}

// ===== 事件桥：注册器（供桌面组件注册）+ emit（供平板 WS 层喂事件） =====

type Listener<T> = (payload: T) => void

const agentStreamEventListeners = new Set<Listener<AgentStreamEvent>>()
const agentStreamCompleteListeners = new Set<Listener<AgentStreamCompletePayload>>()
const agentStreamErrorListeners = new Set<Listener<{ sessionId: string; error: unknown }>>()
const agentTitleUpdatedListeners = new Set<Listener<{ sessionId: string; title: string }>>()
const agentSessionUpdatedListeners = new Set<Listener<{ session: unknown }>>()
const todoAgentSessionReadyListeners = new Set<Listener<unknown>>()
const runtimeProcessesChangedListeners = new Set<Listener<unknown>>()

function register<T>(set: Set<Listener<T>>, cb: Listener<T>): () => void {
  set.add(cb)
  return () => { set.delete(cb) }
}

function emitTo<T>(set: Set<Listener<T>>, payload: T): void {
  for (const listener of [...set]) {
    try {
      listener(payload)
    } catch (e) {
      console.error('[Tablet] 事件监听器执行异常', e)
    }
  }
}

/** 平板 WS agent_event → 桌面 IPC AgentStreamEvent 形状，喂给 useGlobalAgentListeners。 */
export function emitTabletAgentStreamEvent(event: AgentStreamEvent): void {
  emitTo(agentStreamEventListeners, event)
}

/** 供未来 WS 协议扩展时调用（当前 remote-service 暂无对应事件源）。 */
export function emitTabletAgentStreamComplete(payload: AgentStreamCompletePayload): void {
  emitTo(agentStreamCompleteListeners, payload)
}

/** 用户主动停止标记（stopAgent 记录，run_idle 桥接 STREAM_COMPLETE 时消费）。 */
const tabletStoppedByUser = new Set<string>()

/** 取并清除指定会话的用户停止标记（未标记返回 false）。 */
export function consumeTabletStoppedByUser(sessionId: string): boolean {
  const stopped = tabletStoppedByUser.has(String(sessionId))
  tabletStoppedByUser.delete(String(sessionId))
  return stopped
}

// ===== 降级工具 =====

function noop(..._args: unknown[]): unknown {
  return undefined
}

/** 常见但平板不需要真正实现的方法 → 安全空实现 */
const safeNoop = (): Promise<unknown> => Promise.resolve(undefined)

/** 平板明确不支持的能力 → 拒绝并给出中文提示（调用方 catch 后 toast 呈现） */
const unsupported = (what: string): Promise<never> =>
  Promise.reject(new Error(`平板暂不支持${what}`))

/**
 * 安装平板版 electronAPI 桥。
 * 在业务 React 渲染之前调用（main.tsx 顶部）。
 */
export function installElectronApiStub(): void {
  const existing = (globalThis as unknown as { electronAPI?: unknown }).electronAPI
  if (existing) return // 若已存在（Electron 环境）则不覆盖

  const stub: Record<string, unknown> = {
    // ---- 事件桥（注册器；WS 事件由 emitTabletAgentStreamEvent 喂回） ----
    onAgentStreamEvent: (cb: Listener<AgentStreamEvent>) => register(agentStreamEventListeners, cb),
    onAgentStreamComplete: (cb: Listener<AgentStreamCompletePayload>) => register(agentStreamCompleteListeners, cb),
    onAgentStreamError: (cb: Listener<{ sessionId: string; error: unknown }>) => register(agentStreamErrorListeners, cb),
    onAgentTitleUpdated: (cb: Listener<{ sessionId: string; title: string }>) => register(agentTitleUpdatedListeners, cb),
    onAgentSessionUpdated: (cb: Listener<{ session: unknown }>) => register(agentSessionUpdatedListeners, cb),
    onTodoAgentSessionReady: (cb: Listener<unknown>) => register(todoAgentSessionReadyListeners, cb),
    onRuntimeProcessesChanged: (cb: Listener<unknown>) => register(runtimeProcessesChangedListeners, cb),
    // 大刷新后恢复活跃流：平板刷新时事件已通过 WS 继续推送（断线期间的历史事件丢失），
    // 无需 main 回放，返回空列表即可（桌面调用方会遍历 sessionIds 写 streaming 占位）。
    restoreActiveAgentStreams: () => Promise.resolve([]),

    // ---- 命令映射：Agent 核心动作 → WS 远程命令 ----
    sendAgentMessage: (input: Record<string, unknown>) => {
      if (!remoteClient) return Promise.reject(new Error('平板连接未就绪'))
      return remoteClient.sendMessage({
        sessionId: String(input.sessionId || ''),
        userMessage: String(input.userMessage || ''),
        channelId: String(input.channelId || ''),
        modelId: input.modelId as string | undefined,
        workspaceId: input.workspaceId as string | undefined,
      })
    },
    queueAgentMessage: (input: Record<string, unknown>) => {
      // 平板上消息队列与直接发送等价（不打断当前 turn 的语义由主进程 agent 队列承担）
      if (!remoteClient) return Promise.reject(new Error('平板连接未就绪'))
      return remoteClient.sendMessage({
        sessionId: String(input.sessionId || ''),
        userMessage: String(input.userMessage || ''),
        channelId: String(input.channelId || ''),
        modelId: input.modelId as string | undefined,
        workspaceId: input.workspaceId as string | undefined,
      })
    },
    getAgentSessionSDKMessages: (sessionId: string) =>
      remoteClient?.getSdkMessages(sessionId) ?? Promise.resolve([]),
    updateAgentSessionModel: (sessionId: string, channelId: string, modelId?: string) => {
      if (!remoteClient) return Promise.reject(new Error('平板连接未就绪'))
      return remoteClient.updateSessionModel(sessionId, channelId, modelId)
    },
    updateSessionAgentRuntime: (sessionId: string, runtime: 'claude' | 'pi') => {
      if (!remoteClient) return Promise.reject(new Error('平板连接未就绪'))
      return remoteClient.updateSessionRuntime(sessionId, runtime)
    },
    updateSessionPermissionMode: (sessionId: string, mode: 'auto' | 'plan' | 'bypassPermissions') => {
      if (!remoteClient) return Promise.reject(new Error('平板连接未就绪'))
      return remoteClient.updatePermissionMode(sessionId, mode)
    },
    // ---- 交互式问答/审批响应：AskUserQuestion、权限审批、ExitPlanMode 的选项必须真正回传给主进程 ----
    respondAskUser: ({ requestId, answers }: { requestId: string; answers: Record<string, string> }) => {
      if (!remoteClient) return Promise.reject(new Error('平板连接未就绪'))
      return remoteClient.respondAskUser(requestId, answers)
    },
    respondPermission: ({ requestId, behavior, alwaysAllow }: { requestId: string; behavior: 'allow' | 'deny'; alwaysAllow?: boolean }) => {
      if (!remoteClient) return Promise.reject(new Error('平板连接未就绪'))
      return remoteClient.respondPermission(requestId, behavior, alwaysAllow ?? false)
    },
    respondExitPlanMode: ({ requestId, action, feedback }: { requestId: string; action: string; feedback?: string }) => {
      if (!remoteClient) return Promise.reject(new Error('平板连接未就绪'))
      return remoteClient.respondExitPlanMode(requestId, action as 'approve_auto' | 'approve_edit' | 'deny' | 'feedback', feedback)
    },
    stopAgent: (sessionId: string) => {
      // 记录用户主动停止标记：run_idle 桥接 STREAM_COMPLETE 时用（stoppedByUser 展示“已停止”）
      if (sessionId) tabletStoppedByUser.add(String(sessionId))
      if (!remoteClient) return Promise.reject(new Error('平板连接未就绪'))
      return remoteClient.stopAgent(sessionId)
    },
    // ---- 命令映射：LeftSidebar 会话管理（已在 WebSocket 建连后注入） ----
    listAgentSessions: () => remoteClient?.listSessions() ?? Promise.resolve([]),
    createAgentSession: async (title?: string, channelId?: string, workspaceId?: string, modelId?: string) => {
      if (!remoteClient) throw new Error('平板连接未就绪')
      const created = await remoteClient.createSession({ title, channelId, workspaceId, modelId }) as { sessionId: string; title: string }
      return { id: created.sessionId, title: created.title, channelId, modelId, workspaceId, createdAt: Date.now(), updatedAt: Date.now() }
    },
    ensureProjectDraftAgentSession: async (workspaceId: string, channelId?: string, modelId?: string) => {
      if (!remoteClient) throw new Error('平板连接未就绪')
      const created = await remoteClient.createSession({ workspaceId, channelId, modelId }) as { sessionId: string; title: string }
      return { id: created.sessionId, title: created.title, channelId, modelId, workspaceId, draft: true, createdAt: Date.now(), updatedAt: Date.now() }
    },
    updateAgentSessionTitle: (id: string, title: string) => remoteClient?.renameSession(id, title) ?? Promise.reject(new Error('平板连接未就绪')),
    getAgentSessionMeta: async (id: string) => {
      const sessions = await (remoteClient?.listSessions() ?? Promise.resolve([])) as Array<{ id: string }>
      return sessions.find((session) => session.id === id)
    },
    // 优先走真实工作区列表（list_workspaces 由 remote-service 返回桌面同构数据，含真实项目名称）；
    // 旧版服务端无此指令时回退为从会话归纳 workspaceId（仅作兜底，名称不再硬编码为 ID 前缀）。
    listAgentWorkspaces: async () => {
      if (remoteClient) {
        try {
          const workspaces = await remoteClient.listWorkspaces() as Array<{ id: string; name: string; slug: string; type?: string; createdAt?: number; updatedAt?: number }> | undefined
          if (Array.isArray(workspaces) && workspaces.length > 0) {
            return workspaces.map((w) => ({
              id: w.id,
              name: w.name,
              slug: w.slug,
              type: w.type ?? 'personal',
              createdAt: w.createdAt ?? 0,
              updatedAt: w.updatedAt ?? 0,
            }))
          }
        } catch {
          /* 服务端不支持时走下面的归纳回退 */
        }
      }
      const sessions = await (remoteClient?.listSessions() ?? Promise.resolve([])) as Array<{ workspaceId?: string }>
      const ids = [...new Set(sessions.map((session) => session.workspaceId).filter((id): id is string => Boolean(id)))]
      return (ids.length ? ids : ['default']).map((id) => ({
        id,
        name: id === 'default' ? '默认工作区' : id,
        slug: id,
        type: 'personal',
        createdAt: 0,
        updatedAt: 0,
      }))
    },

    // ---- 降级：只读/空数据，维持复用组件可渲染 ----
    getSettings: () => Promise.resolve({}),
    updateSettings: safeNoop,
    getSystemTheme: () => Promise.resolve(true),
    listConversations: () => Promise.resolve([]),
    getUserProfile: () => Promise.resolve({ userName: 'Profer 用户', avatar: '' }),
    getChannels: () => Promise.resolve([]),
    // ModelSelector 打开时会调用 listChannels 刷新渠道列表：
    // 必须返回 WS 真实渠道，否则空数组会覆盖平板已喂好的 channelsAtom，模型选择器变成空列表。
    // 注意：WS 返回的是桌面渠道原始形状，没有平板补丁后的 enabled 语义（桌面 enabled 由
    // ChannelSettings 持久化，WS 不应用用户设置）。这里与 loadChannels 一样补全 enabled，
    // 否则 ModelSelector 的 modelOptions（enabled && models[].enabled）恒空 → “暂无可用模型”。
    listChannels: async () => {
      const data = await (remoteClient?.listChannels() ?? Promise.resolve([]))
      return (Array.isArray(data) ? data : []).map((c) => ({
        ...c,
        enabled: true,
        models: ((c as { models?: Array<{ id?: string }> }).models || []).map((m) => ({ ...m, enabled: true })),
      }))
    },
    getModels: () => Promise.resolve([]),
    getWorkspaceCapabilities: () => Promise.resolve(null),
    getWorkspaceHeatmapDaily: () => Promise.resolve([]),
    getAccountCapabilities: () => Promise.resolve({ membershipTier: 'free', canSelfConfig: false }),
    getWorkspaceFilesPath: () => Promise.resolve(null),
    getGitRepoStatus: () => Promise.resolve(null),
    getWorkspaceDirectories: () => Promise.resolve([]),
    getWorkspaceAttachedFiles: () => Promise.resolve([]),
    getSessionProcessCount: () => Promise.resolve(0),
    listSessionProcesses: () => Promise.resolve([]),
    getAgentKnowledgeReferences: () => Promise.resolve([]),
    knowledge: {
      getLibrarySnapshot: () => Promise.resolve({ items: [] }),
    },
    searchAgentSessionReferences: () => Promise.resolve([]),
    getPathForFile: () => Promise.resolve(''),
    checkPathsType: () => Promise.resolve({ directories: [], files: [] }),
    saveImageAs: safeNoop,
    openExternal: noop,
    team: { onWorkspacesSynced: () => noop },
    notifications: { show: safeNoop },

    // ---- 降级：明确拒绝（调用方 catch → toast 提示“平板暂不支持”） ----
    forkAgentSession: () => unsupported('分叉会话'),
    rewindSession: () => unsupported('回退会话'),
    attachFile: () => unsupported('附加本地文件'),
    attachDirectory: () => unsupported('附加本地目录'),
    detachFile: () => unsupported('移除本地文件'),
    detachDirectory: () => unsupported('移除本地目录'),
    openFileDialog: () => unsupported('本地文件选择'),
    openFolderDialog: () => unsupported('本地目录选择'),
    writeClipboardPreview: () => unsupported('剪贴板预览'),
    resolveAndReadFile: () => unsupported('读取本地文件'),
    saveFilesToAgentSession: () => unsupported('保存文件到会话'),
    addAgentKnowledgeReferences: () => unsupported('知识库引用'),
    removeAgentKnowledgeReference: () => unsupported('知识库引用'),
    killProcess: () => unsupported('进程管理'),
  }

  // 用 Proxy 兜底：任何未显式 stub 的方法都返回安全空实现，杜绝 "undefined is not a function"
  const handler = {
    get(_target: Record<string, unknown>, prop: string): unknown {
      if (prop in _target) return _target[prop]
      // 常见 IPC 返回 Promise；纯函数返回 undefined
      if (prop.startsWith('get') || prop.endsWith('Async') || prop === 'invoke') {
        return safeNoop
      }
      return noop
    },
  }

  // 需要嵌套命名空间（electronAPI.team.*, electronAPI.chat.* 等）也 Proxy 化。
  // ⚠️ 必须返回【可调用】对象：target 是函数（typeof 为 function），否则
  // window.electronAPI.xxx() 直接调用会抛 "is not a function"（曾因返回纯对象 Proxy 踩坑）。
  const makeDeepStub = (): unknown => {
    const fn = (() => Promise.resolve(undefined)) as unknown as Record<string, unknown>
    return new Proxy(fn, {
      get: (_t, p) => {
        if (typeof p === 'string') return makeDeepStub()
        return undefined
      },
      apply: () => Promise.resolve(undefined),
    })
  }

  // 顶层也允许任意嵌套访问
  const top = new Proxy(stub, {
    get(t, p) {
      if (typeof p === 'string' && p in t) return t[p]
      if (typeof p === 'string') return makeDeepStub()
      return undefined
    },
  }) as unknown as Record<string, unknown>

  ;(globalThis as unknown as { electronAPI?: Record<string, unknown> }).electronAPI = top
  void handler
}

/** 检查当前是否在 Electron/有真实 electronAPI（供平板逻辑判断） */
export function hasRealElectronApi(): boolean {
  return Boolean((globalThis as unknown as { electronAPI?: unknown }).electronAPI)
}
