/**
 * Profer Tablet UI — 桌面式平板界面
 *
 * 完整复用桌面真实组件（与 LeftSidebar 同一搬运策略）：
 *  - 对话区：桌面 <AgentView> 100% 复用（AgentHeader + AgentMessages + 审批横幅 + composer；任务图工具栏项与 Dialog 在 tabletMode 下隐藏）
 *  - 左侧会话栏：桌面 <LeftSidebar> 复用
 *  - 数据源：WsClient → remote-service；electronAPI 桥把 IPC 命令/事件映射为 WS 命令/事件
 *
 * 关键机制：
 *  - electronAPI 桥（electronapi-stub）：事件注册器由 WS agent_event 喂回（emitTabletAgentStreamEvent），
 *    useGlobalAgentListeners / AgentView 的桌面逻辑零改动复用
 *  - jotai Provider（createStore）供给 userProfile/channels/agentSessions 等 atom
 *  - sonner Toaster 提供桌面同款 toast 反馈
 */

import React, { useCallback, useEffect, useRef, useState } from 'react'
import ReactDOM from 'react-dom/client'
import { Provider, createStore, useSetAtom, useAtomValue } from 'jotai'
import { Toaster } from 'sonner'
import '@fontsource-variable/inter/index.css'
import '@/styles/globals.css'
import { installElectronApiStub, setTabletRemoteClient, emitTabletAgentStreamEvent, emitTabletAgentStreamComplete, emitTabletChatStreamEvent, consumeTabletStoppedByUser } from './electronapi-stub'
import { defaultWsUrl, WsClient, type AgentWorkflowEvent, type ChatWorkflowEvent } from './ws-client'
// ===== 复用桌面组件 / atom（必须位于模块顶部，确保 ESM 正常收集）=====
import { AgentView } from '@/components/agent'
import { ChatView } from '@/components/chat'
import { LeftSidebar } from '@/components/app-shell/LeftSidebar'
import { SettingsDialog, type SettingsTabItem } from '@/components/settings'
import { useGlobalAgentListeners } from '@/hooks/useGlobalAgentListeners'
import { useGlobalChatListeners } from '@/hooks/useGlobalChatListeners'
import { userProfileAtom } from '@/atoms/user-profile'
import { channelsAtom, channelsLoadedAtom, conversationsAtom, currentConversationIdAtom } from '@/atoms/chat-atoms'
import { agentSessionsAtom, agentWorkspacesAtom, currentAgentSessionIdAtom, currentAgentWorkspaceIdAtom, agentChannelIdAtom, agentModelIdAtom, agentChannelIdsAtom, agentStreamingStatesAtom } from '@/atoms/agent-atoms'
import { appModeAtom } from '@/atoms/app-mode'
import { initTabletUiScale } from '@/atoms/ui-scale'
import { UiScaleContainer } from '@/components/UiScaleContainer'
import { Button } from '@/components/ui/button'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Menu, Plus, Palette } from 'lucide-react'
import { isAgentCompatibleProvider, type ProviderType, type AgentStreamPayload } from '@profer/shared'

// ===== 先安装 electronAPI stub（必须在任何复用组件求值前）=====
installElectronApiStub()

// ===== 平板模式标记：Portal 到 body 的组件（设置弹窗等）需要 CSS 定向（竖屏差异化布局）=====
if (typeof document !== 'undefined') {
  document.body.classList.add('tablet-mode')
}

// ===== Token 存取 =====
function getStoredToken(): string { return localStorage.getItem('profer-remote-token') || '' }
function storeToken(t: string): void { localStorage.setItem('profer-remote-token', t) }

// ===== 服务器地址存取（App 化必需：Capacitor WebView 内 window.location.host 是 localhost，
// 无法像浏览器场景那样从页面来源自动推导电脑 IP；显式配置后覆盖 defaultWsUrl）=====
function getStoredServerUrl(): string { return localStorage.getItem('profer-remote-server') || '' }
function storeServerUrl(u: string): void { u ? localStorage.setItem('profer-remote-server', u) : localStorage.removeItem('profer-remote-server') }

/**
 * 规范化服务器地址为 WS URL。支持输入形式：
 *  - http://192.168.1.10:7788 / https://host:port  → ws(s)://host:port/ws
 *  - ws://192.168.1.10:7788 / ws://192.168.1.10:7788/ws → 补 /ws 或原样
 *  - 192.168.1.10:7788（无协议）→ ws://192.168.1.10:7788/ws
 *  - 空字符串 → null（调用方回退 defaultWsUrl 自动推导）
 */
function normalizeWsUrl(raw: string): string | null {
  const s = raw.trim().replace(/\/+$/, '')
  if (!s) return null
  if (/^https?:\/\//i.test(s)) {
    const proto = /^https:/i.test(s) ? 'wss:' : 'ws:'
    return `${proto}${s.replace(/^https?:/i, '')}/ws`
  }
  if (/^wss?:\/\//i.test(s)) {
    return s.endsWith('/ws') ? s : `${s}/ws`
  }
  return `ws://${s}/ws`
}

// ===== 类型 =====
interface ChannelInfo { id: string; name: string; provider: string; models: { id: string; name: string }[] }
interface SessionInfo { id: string; title: string; channelId?: string; modelId?: string; workspaceId?: string; agentRuntime?: 'claude' | 'pi'; permissionMode?: string; active: boolean; updatedAt?: number }

const tabletStore = createStore()

// 平板默认略微放大 UI（触屏友好）：无本地缓存时取 110%，已有用户选择则保持。
// 必须在渲染前写入 tabletStore 的 uiScaleAtom（atom 默认值在模块加载时已固定）
initTabletUiScale(tabletStore)

// ===== 平板设置系统：直接搬运桌面 SettingsDialog，tab 白名单只保留平板可用的「外观」=====
// （主题/界面大小/Markdown 字号均为本地持久化，不依赖 Electron IPC；其余 tab 大量依赖
// electronAPI 能力，在平板上会显示空壳/伪状态，故不暴露）
const TABLET_SETTINGS_TABS: SettingsTabItem[] = [
  { id: 'appearance', label: '外观设置', icon: <Palette size={16} /> },
]

// ===== 停止超时兜底 =====
// 点击停止后若 10s 内没有 run_idle 确认（SDK abort 延迟 / 事件丢失 / 会话本就不 active 被 stop 守卫跳过），
// 强制清理本地 streaming，避免“一直跑、停止按钮永久亮”的卡死态；下一次 run 事件或刷新会重新同步真实状态。
const pendingStopTimers = new Map<string, ReturnType<typeof setTimeout>>()

{
  const origStopAgent = window.electronAPI.stopAgent.bind(window.electronAPI)
  window.electronAPI.stopAgent = ((sessionId: string) => {
    const sid = String(sessionId)
    const existing = pendingStopTimers.get(sid)
    if (existing) clearTimeout(existing)
    pendingStopTimers.set(sid, setTimeout(() => {
      pendingStopTimers.delete(sid)
      tabletStore.set(agentStreamingStatesAtom, (prev) => {
        const cur = prev.get(sid)
        if (!cur?.running) return prev
        const map = new Map(prev)
        map.set(sid, { ...cur, running: false, stopping: false })
        return map
      })
    }, 10_000))
    return origStopAgent(sessionId)
  }) as typeof window.electronAPI.stopAgent
}

// ===== 根组件 =====
function TabletApp(): React.ReactElement {
  return (
    <Provider store={tabletStore}>
      {/* AgentView/LeftSidebar 组件树大量使用 Tooltip，缺少 Provider 会批量抛错 */}
      <TooltipProvider>
        <Toaster theme="system" position="top-center" richColors />
        {/* 等比缩放容器：内容整体 scale(s)，容器反补偿保持视口内，区域不放大 */}
        <UiScaleContainer>
          <App />
        </UiScaleContainer>
        {/* 设置入口：LeftSidebar 底部头像/设置按钮置位 settingsOpenAtom，此处渲染原版 Dialog；
            Portal 到 body，不随缩放容器变换 */}
        <SettingsDialog tabsOverride={TABLET_SETTINGS_TABS} />
      </TooltipProvider>
    </Provider>
  )
}

function App(): React.ReactElement {
  // useGlobalAgentListeners：桌面 Agent 事件 → atoms 的完整逻辑；事件源由 WS 桥喂入
  useGlobalAgentListeners()
  // useGlobalChatListeners：桌面 Chat 流式事件（chunk/reasoning/complete/error/tool-activity）→ atoms
  useGlobalChatListeners()

  const [tokenInput, setTokenInput] = useState(getStoredToken())
  const [serverInput, setServerInput] = useState(getStoredServerUrl())
  const setChannels = useSetAtom(channelsAtom)
  const setChannelsLoaded = useSetAtom(channelsLoadedAtom)
  const setConversations = useSetAtom(conversationsAtom)
  const setAgentChannelId = useSetAtom(agentChannelIdAtom)
  const setAgentModelId = useSetAtom(agentModelIdAtom)
  const setAgentChannelIds = useSetAtom(agentChannelIdsAtom)
  const setNativeSessions = useSetAtom(agentSessionsAtom)
  const setNativeWorkspaces = useSetAtom(agentWorkspacesAtom)
  const setNativeSessionId = useSetAtom(currentAgentSessionIdAtom)
  const setNativeWorkspaceId = useSetAtom(currentAgentWorkspaceIdAtom)
  const setNativeConversationId = useSetAtom(currentConversationIdAtom)
  const setNativeAppMode = useSetAtom(appModeAtom)
  const appMode = useAtomValue(appModeAtom)
  const nativeActiveSessionId = useAtomValue(currentAgentSessionIdAtom)
  const nativeConversationId = useAtomValue(currentConversationIdAtom)
  const conversations = useAtomValue(conversationsAtom)
  const userProfile = useAtomValue(userProfileAtom)
  const clientRef = useRef<WsClient | null>(null)

  // 界面状态
  const [connection, setConnection] = useState<'idle' | 'connecting' | 'open' | 'error'>('idle')
  const [errMsg, setErrMsg] = useState<string | undefined>(undefined)
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null)
  const [currentChatId, setCurrentChatId] = useState<string | null>(null)
  const [currentTitle, setCurrentTitle] = useState('')
  // 窄屏时侧栏以抽屉承载；宽屏保持与原生工作台一致的左侧导航。
  const [sidebarOpen, setSidebarOpen] = useState(false)
  // 横屏且 ≥1024px 时使用固定侧栏布局（landscape:min-[1024px]）；竖屏/小屏走抽屉+顶栏。
  // 竖屏时标题由顶栏承担（AgentHeader 隐藏），横屏时 AgentHeader 自带标题。
  const [landscapeWide, setLandscapeWide] = useState(() => window.matchMedia('(orientation: landscape) and (min-width: 1024px)').matches)
  useEffect(() => {
    const mq = window.matchMedia('(orientation: landscape) and (min-width: 1024px)')
    const onChange = (): void => setLandscapeWide(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  // ===== WS 管理 =====
  const connect = useCallback((token: string, serverInput?: string) => {
    if (clientRef.current) clientRef.current.disconnect()
    const url = normalizeWsUrl(serverInput ?? getStoredServerUrl()) ?? defaultWsUrl()
    const client = new WsClient({
      url,
      token,
      onStatusChange: (status) => {
        if (status === 'open') {
          setConnection('open'); setErrMsg(undefined)
          void loadChannels(client)
          void loadSessions(client)
          void loadConversations(client)
        } else if (status === 'error') setConnection('error')
        else setConnection('connecting')
      },
      onAgentEvent: (evt) => handleAgentEvent(client, evt),
      onChatEvent: (evt) => handleChatEvent(evt),
    })
    clientRef.current = client
    setTabletRemoteClient(client)
    client.connect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const loadChannels = useCallback(async (client: WsClient) => {
    try {
      const data = await client.listChannels() as ChannelInfo[]
      const ch = (Array.isArray(data) ? data : []).map((c) => ({
        ...c,
        // WS 返回的都是可切换渠道：补全桌面 Channel 形状的 enabled 语义，
        // 否则 AgentView 的 hasAvailableModel 判定（channel.enabled && models[].enabled）恒为 false，
        // 会错误提示“请去设置中启用渠道”。
        enabled: true,
        models: (c.models || []).map((m) => ({ ...m, enabled: true })),
      }))
      setChannels(ch as never)
      setChannelsLoaded(true)
      // agentChannelIdsAtom：桌面从 enabled + Agent 兼容 provider 派生（见 ChannelSettings）
      setAgentChannelIds(ch.filter((c) => isAgentCompatibleProvider(c.provider as ProviderType)).map((c) => c.id))
      // AgentView 从 sessionMeta / agentChannelIdAtom / agentModelIdAtom 解析渠道与模型；
      // 默认渠道取第一个可用，避免“请先设置 Agent 供应商”的桌面提示出现在平板上。
      if (ch.length > 0) {
        setAgentChannelId((prev) => prev || ch[0]!.id)
        setAgentModelId((prev) => prev || ch[0]!.models?.[0]?.id || '')
      }
    } catch (e) { console.error('拉取渠道失败', e) }
  }, [setChannels, setChannelsLoaded, setAgentChannelIds, setAgentChannelId, setAgentModelId])

  const loadSessions = useCallback(async (client: WsClient) => {
    try {
      const data = await client.listSessions() as SessionInfo[]
      if (!Array.isArray(data)) return

      // 平板版暂时隐藏团队版功能：先拉工作区列表识别团队工作区（type === 'team'），
      // 其工作区与会话整体排除——项目分组、置顶、最近、归档列表都不会出现团队内容。
      let teamWorkspaceIds = new Set<string>()
      let realWorkspaces = new Map<string, { id: string; name: string; slug: string; type: string; createdAt: number; updatedAt: number }>()
      try {
        const wsList = await client.listWorkspaces() as Array<{ id: string; name: string; slug: string; type?: string; createdAt?: number; updatedAt?: number }> | undefined
        if (Array.isArray(wsList)) {
          for (const w of wsList) {
            if (w.type === 'team') {
              teamWorkspaceIds.add(w.id)
              continue
            }
            realWorkspaces.set(w.id, {
              id: w.id,
              name: w.name,
              slug: w.slug,
              type: w.type ?? 'personal',
              createdAt: w.createdAt ?? 0,
              updatedAt: w.updatedAt ?? 0,
            })
          }
        }
      } catch { /* 服务端不支持，走归纳回退 */ }

      const personalSessions = data.filter((s) => !teamWorkspaceIds.has(s.workspaceId ?? ''))
      setSessions(personalSessions)
      // 原生 LeftSidebar 直接读取这些 atoms；平板只替换数据传输层。
      setNativeSessions(personalSessions as never)

      // 陈旧 streaming 兜底：主进程返回 active=false 的会话若本地仍标记 running，
      // 说明完成事件在断线/事件丢失时没送达（平板没有桌面 STREAM_COMPLETE IPC 保底）。
      // 以主进程权威状态为准强制清理，否则停止按钮会永远亮着、点击也无效（stop 守卫直接 return）。
      const remoteActiveIds = new Set(personalSessions.filter((s) => s.active).map((s) => s.id))
      const staleIds = new Set<string>()
      for (const [sid, st] of tabletStore.get(agentStreamingStatesAtom)) {
        if (st?.running && !remoteActiveIds.has(sid)) staleIds.add(sid)
      }
      if (staleIds.size > 0) {
        tabletStore.set(agentStreamingStatesAtom, (prev) => {
          const map = new Map(prev)
          for (const sid of staleIds) {
            const cur = map.get(sid)
            if (cur?.running) map.set(sid, { ...cur, running: false, stopping: false })
          }
          return map
        })
      }

      // 优先从服务端获取真实项目（工作区）列表，带真实项目名称；
      // 旧版服务端无 list_workspaces 指令时回退为从会话归纳 workspaceId。
      const workspaceIds = [...new Set(personalSessions.map((session) => session.workspaceId).filter((id): id is string => Boolean(id)))]
      // 无会话时也展示服务端真实项目，避免只能看到“默认工作区”
      const ids = workspaceIds.length > 0 ? workspaceIds : (realWorkspaces.size > 0 ? [...realWorkspaces.keys()] : ['default'])
      const workspaces = ids.map((id) => realWorkspaces.get(id) ?? {
        id,
        name: id === 'default' ? '默认工作区' : `项目 · ${id.slice(0, 8)}`,
        slug: id,
        type: 'personal',
        createdAt: 0,
        updatedAt: 0,
      })
      const fallback = workspaces[0] ?? { id: 'default', name: '默认工作区', slug: 'default', type: 'personal', createdAt: 0, updatedAt: 0 }
      setNativeWorkspaces(workspaces.length > 0 ? workspaces as never : [fallback] as never)
      setNativeWorkspaceId(fallback.id)
    } catch (e) { console.error('拉取会话失败', e) }
  }, [setNativeSessions, setNativeWorkspaces, setNativeWorkspaceId])

  const loadConversations = useCallback(async (client: WsClient) => {
    try {
      const data = await client.listConversations() as Array<{ id: string; title: string }>
      setConversations((Array.isArray(data) ? data : []) as never)
    } catch (e) { console.error('拉取对话列表失败', e) }
  }, [setConversations])

  // ===== 打开会话：AgentView 自行加载持久化消息与流式状态，平板只切换 sessionId =====
  const openSession = useCallback(async (sessionId: string, title?: string) => {
    setSidebarOpen(false)
    setCurrentSessionId(sessionId)
    setNativeSessionId(sessionId)
    setNativeAppMode('agent')
    setCurrentTitle(title || '')
  }, [setNativeSessionId, setNativeAppMode])

  /** 打开 Chat 对话：ChatView 自行加载消息与流式状态，平板只切换 conversationId 与模式 */
  const openChatConversation = useCallback((conversationId: string, title?: string) => {
    setSidebarOpen(false)
    setCurrentChatId(conversationId)
    setNativeConversationId(conversationId)
    setNativeAppMode('chat')
    setCurrentTitle(title || '')
  }, [setNativeConversationId, setNativeAppMode])

  useEffect(() => {
    setNativeAppMode('agent')
  }, [setNativeAppMode])

  // LeftSidebar 自己更新 currentAgentSessionIdAtom；这里将原生选择动作接回平板会话切换。
  useEffect(() => {
    if (nativeActiveSessionId && nativeActiveSessionId !== currentSessionId) {
      const session = sessions.find((item) => item.id === nativeActiveSessionId)
      void openSession(nativeActiveSessionId, session?.title)
    }
  }, [nativeActiveSessionId, currentSessionId, sessions, openSession])

  // 与 Agent 同构：LeftSidebar（useOpenSession）写入 currentConversationIdAtom，
  // 这里接回平板 Chat 对话切换（含模式切换按钮与侧栏选择两条路径）。
  useEffect(() => {
    if (nativeConversationId && nativeConversationId !== currentChatId) {
      const conv = conversations.find((item) => item.id === nativeConversationId)
      openChatConversation(nativeConversationId, conv?.title)
    }
  }, [nativeConversationId, currentChatId, conversations, openChatConversation])

  // Chat 模式下刷新后恢复最近对话（appMode 持久化可能停在 chat，此时 conversationId 为空）
  useEffect(() => {
    if (connection === 'open' && appMode === 'chat' && !currentChatId) {
      const first = conversations.find((c) => !c.archived)
      if (first) openChatConversation(first.id, first.title)
    }
  }, [connection, appMode, currentChatId, conversations, openChatConversation])

  // 顶栏标题：优先实时取列表最新标题（标题可被重命名/Agent 自动更新；Chat 对话同理）
  const activeTitle = appMode === 'chat'
    ? (currentChatId ? (conversations.find((c) => c.id === currentChatId)?.title ?? currentTitle) : currentTitle)
    : (currentSessionId ? (sessions.find((s) => s.id === currentSessionId)?.title ?? currentTitle) : currentTitle)

  // ===== Agent 事件：喂给 electronAPI 桥（useGlobalAgentListeners 消费），并在回合结束后刷新会话列表 =====
  const handleChatEvent = useCallback((evt: ChatWorkflowEvent) => {
    emitTabletChatStreamEvent(evt.channel, evt.payload)
  }, [])

  const handleAgentEvent = useCallback((client: WsClient, evt: AgentWorkflowEvent) => {
    emitTabletAgentStreamEvent({ sessionId: evt.sessionId, payload: evt.payload as AgentStreamPayload })
    const p = evt.payload as { kind?: string; event?: { type?: string } } | null
    if (p && p.kind === 'profer_event' && p.event && (p.event.type === 'run_completed' || p.event.type === 'run_idle')) {
      // 桥接桌面 STREAM_COMPLETE：useGlobalAgentListeners 只有它会把 running 置 false
      // （桌面由 IPC 送达；平板 WS 无此消息，必须由 run_idle 事件代理触发），
      // 否则 streaming 状态永不结束 → 停止按钮永不消失。
      emitTabletAgentStreamComplete({
        sessionId: evt.sessionId,
        messages: [],
        stoppedByUser: consumeTabletStoppedByUser(evt.sessionId),
        startedAt: Date.now(),
      })
      // 会话已空闲：撤销该会话的停止超时兜底定时器
      const timer = pendingStopTimers.get(evt.sessionId)
      if (timer) { clearTimeout(timer); pendingStopTimers.delete(evt.sessionId) }
      // 会话标题/时间可能已更新，刷新左侧列表
      void loadSessions(client)
    }
  }, [loadSessions])

  const createSession = useCallback(async () => {
    const client = clientRef.current
    if (!client || !client.isOpen()) return
    try {
      const data = await client.createSession({ title: '新会话' }) as { sessionId: string; title: string }
      if (data?.sessionId) {
        await openSession(data.sessionId, data.title)
        void loadSessions(client)
      }
    } catch (e) { setErrMsg('创建会话失败: ' + String(e)) }
  }, [openSession, loadSessions])

  /** 新建 Chat 对话（空态按钮；LeftSidebar 的“新建对话”走它自己的 handleNewConversation） */
  const createConversation = useCallback(async () => {
    const client = clientRef.current
    if (!client || !client.isOpen()) return
    try {
      const meta = await client.createConversation({}) as { id: string; title: string }
      if (meta?.id) {
        // 插入会话列表头部，LeftSidebar 立即可见（与桌面 handleNewConversation 一致）
        setConversations((prev) => [meta, ...prev] as never)
        openChatConversation(meta.id, meta.title)
      }
    } catch (e) { setErrMsg('创建对话失败: ' + String(e)) }
  }, [openChatConversation, setConversations])

  // 提交 token（服务器地址留空则自动推导，浏览器场景行为不变）
  const submitToken = useCallback(() => {
    const t = tokenInput.trim()
    if (!t) { setErrMsg('请输入访问令牌'); return }
    storeToken(t)
    storeServerUrl(serverInput)
    setErrMsg(undefined)
    setConnection('connecting')
    setTimeout(() => connect(t, serverInput), 0)
  }, [tokenInput, serverInput, connect])

  const logout = useCallback(() => {
    clientRef.current?.disconnect()
    localStorage.removeItem('profer-remote-token')
    localStorage.removeItem('profer-remote-server')
    setConnection('idle'); setSessions([]); setCurrentSessionId(null)
    setTokenInput('')
    setServerInput('')
  }, [])

  // 初次挂载自动连接（App 场景用已存的显式服务器地址）
  useEffect(() => {
    if (getStoredToken()) {
      setConnection('connecting')
      setTimeout(() => connect(getStoredToken(), getStoredServerUrl()), 0)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 首次连入后自动打开最近会话；没有会话时保持空状态。
  useEffect(() => {
    const client = clientRef.current
    if (connection === 'open' && !currentSessionId && sessions[0] && client?.isOpen()) {
      void openSession(sessions[0].id, sessions[0].title)
    }
  }, [connection, currentSessionId, sessions, openSession])

  // 抽屉遵循原生弹层习惯：Escape 可立即返回工作区。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSidebarOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // ============ 渲染 ============
  if (connection !== 'open') {
    // 未连接：token 页
    return (
      <div className="flex h-full w-full items-center justify-center bg-background text-foreground p-6">
        <div className="w-full max-w-sm space-y-6">
          <div className="space-y-1.5">
            <div className="text-xl font-semibold italic tracking-tight">Profer</div>
            <div className="text-sm text-muted-foreground">在电脑上以 <code className="px-1.5 py-0.5 rounded bg-muted/60 font-mono text-xs">--tablet</code> 启动后连接</div>
          </div>
          <input
            value={serverInput}
            onChange={(e) => setServerInput(e.target.value)}
            placeholder="服务器地址，如 http://192.168.1.10:7788（留空自动）"
            className="w-full rounded-lg border border-border bg-background px-3.5 py-3 text-sm outline-none focus:ring-2 focus:ring-primary/30 placeholder:text-muted-foreground/60"
          />
          <input
            value={tokenInput}
            onChange={(e) => setTokenInput(e.target.value)}
            placeholder="访问令牌"
            autoFocus
            className="w-full rounded-lg border border-border bg-background px-3.5 py-3 text-sm outline-none focus:ring-2 focus:ring-primary/30 placeholder:text-muted-foreground/60"
          />
          {errMsg && <div className="text-sm text-destructive">{errMsg}</div>}
          <button onClick={submitToken} className="w-full rounded-lg bg-primary text-primary-foreground py-3 text-sm font-medium active:scale-[0.98] transition">
            {connection === 'connecting' ? '连接中…' : '连接'}
          </button>
        </div>
      </div>
    )
  }

  // 已连接：桌面式布局（左侧会话栏 + 主区，无右侧栏；对话区整体复用桌面 AgentView）
  // 断点约定：横屏且 ≥1024px 显示固定侧栏（iPad 横屏/桌面浏览器）；其余一律抽屉+顶栏——
  // 竖屏不管宽度（含 iPad Pro 12.9" 竖屏 1024px）都走抽屉，避免固定侧栏挤压对话区。
  return (
    <div className="tablet-app-root flex h-full w-full overflow-hidden bg-background p-0 text-foreground landscape:min-[1024px]:p-2">
      <NativeTabletSidebar mobileOpen={sidebarOpen} onDismiss={() => setSidebarOpen(false)} />

      {/* 主区 */}
      <div className="flex-1 min-w-0 flex flex-col overflow-hidden bg-content-area landscape:min-[1024px]:ml-2 landscape:min-[1024px]:rounded-[24px] landscape:min-[1024px]:border landscape:min-[1024px]:border-border/70 landscape:min-[1024px]:shadow-xl">
        {/* 顶栏（非固定侧栏布局时显示）：汉堡 + 当前会话标题（标题由外部承担，AgentView 隐藏 AgentHeader）；
            横屏固定侧栏布局无顶栏，标题由 AgentHeader 自带。 */}
        <div className="flex h-12 shrink-0 items-center border-b border-border bg-tabbar-surface px-2 landscape:min-[1024px]:hidden">
          <Button type="button" variant="ghost" size="icon" onClick={() => setSidebarOpen(true)} className="mr-1 size-10 shrink-0 rounded-[12px] text-foreground/65 hover:bg-foreground/[0.06]" aria-label="打开导航"><Menu className="size-[18px]" /></Button>
          <div className="flex-1 min-w-0 px-1">
            <span className="block truncate text-sm font-medium text-foreground">{activeTitle}</span>
          </div>
        </div>

        {/* 对话区：完整复用桌面 AgentView / ChatView。
            注意：必须是 flex 容器（flex flex-col）——AgentView 根是 flex-1，StickToBottom 滚动容器是
            height:100%，依赖整条父链的高度约束；若此处是普通块级元素，滚动容器被内容撑开后溢出，
            对话区将无法滚动（历史消息被 overflow-hidden 截断）。 */}
        <div className="flex min-h-0 flex-1 flex-col touch-pan-y">
          {appMode === 'chat' ? (
            currentChatId ? (
              <ChatView conversationId={currentChatId} tabletMode hideChatHeader={!landscapeWide} />
            ) : (
              <div className="flex h-full flex-col items-center justify-center px-6 text-center">
                <div className="max-w-sm space-y-2">
                  <div className="text-[22px] font-semibold tracking-tight text-foreground">{userProfile.userName}，早上好</div>
                  <p className="mt-16 text-[13px] leading-5 text-muted-foreground">开始你的第一个 Chat 对话，与 Agent 共享渠道与模型</p>
                  <Button type="button" variant="outline" size="sm" onClick={createConversation} className="mt-3 h-9 gap-1.5"><Plus className="size-3.5" />新建对话</Button>
                </div>
              </div>
            )
          ) : (
            currentSessionId ? (
              <AgentView sessionId={currentSessionId} tabletMode hideAgentHeader={!landscapeWide} />
            ) : (
              <div className="flex h-full flex-col items-center justify-center px-6 text-center">
                <div className="max-w-sm space-y-2">
                  <div className="text-[22px] font-semibold tracking-tight text-foreground">{userProfile.userName}，早上好</div>
                  <p className="mt-16 text-[13px] leading-5 text-muted-foreground">开始你的第一个 Agent 会话，Token 消耗热力图将在这里显示</p>
                  <Button type="button" variant="outline" size="sm" onClick={createSession} className="mt-3 h-9 gap-1.5"><Plus className="size-3.5" />新建会话</Button>
                </div>
              </div>
            )
          )}
        </div>
      </div>
    </div>
  )
}

// ===== 平板直接复用桌面 LeftSidebar；浏览器端只以 WebSocket adapter 替代 Electron IPC。 =====
function NativeTabletSidebar({ mobileOpen, onDismiss }: { mobileOpen: boolean; onDismiss: () => void }): React.ReactElement {
  return (
    <>
      <div className="hidden h-full shrink-0 landscape:min-[1024px]:block"><LeftSidebar width={288} tabletMode /></div>
      <div className={`fixed inset-0 z-50 landscape:min-[1024px]:hidden ${mobileOpen ? 'pointer-events-auto' : 'pointer-events-none'}`} aria-hidden={!mobileOpen}>
        <button type="button" className={`absolute inset-0 z-0 bg-black/40 transition-opacity duration-200 ${mobileOpen ? 'opacity-100' : 'opacity-0'}`} onClick={onDismiss} aria-label="关闭会话导航" tabIndex={mobileOpen ? 0 : -1} />
        <div className={`absolute inset-y-0 left-0 z-10 touch-pan-y transition-transform duration-200 ease-out ${mobileOpen ? 'translate-x-0' : '-translate-x-full'}`}>
          <LeftSidebar width={288} tabletMode />
        </div>
      </div>
    </>
  )
}

// ===== 挂载 =====
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <TabletApp />
  </React.StrictMode>,
)

// ===== 全局错误捕获：便于定位 =====
type ErrInfo = { msg: string; stack?: string }
const errs: ErrInfo[] = []
function renderErrBanner(): void {
  if (errs.length === 0) return
  let el = document.getElementById('tablet-error-banner')
  if (!el) {
    el = document.createElement('div')
    el.id = 'tablet-error-banner'
    el.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#7f1d1d;color:#fff;padding:10px;font:12px monospace;max-height:40vh;overflow:auto;white-space:pre-wrap;word-break:break-all;'
    document.body.appendChild(el)
  }
  el.textContent = '[平板 UI 运行错误]\n' + errs.map((e, i) => `${i}. ${e.msg}${e.stack ? '\n' + e.stack.slice(0, 400) : ''}`).join('\n\n')
}
window.addEventListener('error', (ev) => { errs.push({ msg: ev.message || 'unknown', stack: ev.error?.stack }); renderErrBanner() })
window.addEventListener('unhandledrejection', (ev) => {
  const r = ev.reason
  const msg = r && typeof r === 'object' && 'message' in r ? String((r as { message: unknown }).message) : String(r)
  errs.push({ msg: 'UnhandledRejection: ' + msg }); renderErrBanner()
})
