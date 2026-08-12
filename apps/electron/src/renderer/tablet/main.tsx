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
import { createPortal } from 'react-dom'
import { Provider, createStore, useSetAtom, useAtomValue } from 'jotai'
import { Toaster, toast } from 'sonner'
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
import { authStatusAtom } from '@/atoms/identity-atoms'
import { channelsAtom, channelsLoadedAtom, conversationsAtom, currentConversationIdAtom } from '@/atoms/chat-atoms'
import { agentSessionsAtom, agentWorkspacesAtom, currentAgentSessionIdAtom, currentAgentWorkspaceIdAtom, agentChannelIdAtom, agentModelIdAtom, agentChannelIdsAtom, agentStreamingStatesAtom, agentMessageRefreshAtom } from '@/atoms/agent-atoms'
import { appModeAtom } from '@/atoms/app-mode'
import { initTabletUiScale } from '@/atoms/ui-scale'
import { UiScaleContainer } from '@/components/UiScaleContainer'
import { Button } from '@/components/ui/button'
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogFooter, AlertDialogTitle, AlertDialogDescription, AlertDialogAction, AlertDialogCancel } from '@/components/ui/alert-dialog'
import { TooltipProvider, Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { Menu, Plus, Palette, Link, Loader2, Bell, RefreshCw } from 'lucide-react'
import { type AgentStreamPayload } from '@profer/shared'
import { tabletConnectionStatusAtom, tabletNotifyCompleteAtom, tabletUnbindRequestAtom } from '@/atoms/tablet-settings'

// ===== 先安装 electronAPI stub（必须在任何复用组件求值前）=====
installElectronApiStub()

// ===== Capacitor 原生 App 环境检测 =====
// App 内 WebView 沉浸式全屏，系统状态栏（通知栏）会盖住顶部内容；浏览器模式 env() 为 0 无需处理。
const isNativeApp = typeof window !== 'undefined' && !!((window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.())
const SAFE_AREA_CLS = isNativeApp ? 'tablet-safe-area' : ''

// ===== 移动模式标记：Portal 到 body 的组件（设置弹窗等）需要 CSS 定向（竖屏差异化布局）=====
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

// ===== 上次视图存取（整页重载 / 断线重连后恢复现场）=====
// 进程被系统回收或断线重连后，内存态（当前会话/模式）丢失；记录最近打开的视图，
// 连接就绪后优先恢复，避免每次都回到第一个会话。
function getLastView(): { mode: 'agent' | 'chat'; sessionId?: string; conversationId?: string } | null {
  try {
    const raw = localStorage.getItem('profer-remote-last-view')
    if (!raw) return null
    const v = JSON.parse(raw) as { mode?: string; sessionId?: string; conversationId?: string }
    if (v.mode !== 'agent' && v.mode !== 'chat') return null
    return v as { mode: 'agent' | 'chat'; sessionId?: string; conversationId?: string }
  } catch { /* ignore */ }
  return null
}
function saveLastView(v: { mode: 'agent' | 'chat'; sessionId?: string; conversationId?: string }): void {
  try { localStorage.setItem('profer-remote-last-view', JSON.stringify(v)) } catch { /* ignore */ }
}
function clearLastView(): void {
  try { localStorage.removeItem('profer-remote-last-view') } catch { /* ignore */ }
}

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
interface SessionInfo { id: string; title: string; channelId?: string; modelId?: string; workspaceId?: string; agentRuntime?: 'claude' | 'pi'; permissionMode?: string; active: boolean; createdAt?: number; updatedAt?: number; pinned?: boolean; archived?: boolean; draft?: boolean }

const tabletStore = createStore()

// 平板默认略微放大 UI（触屏友好）：无本地缓存时取 110%，已有用户选择则保持。
// 必须在渲染前写入 tabletStore 的 uiScaleAtom（atom 默认值在模块加载时已固定）
initTabletUiScale(tabletStore)

// ===== 平板设置系统：直接搬运桌面 SettingsDialog，tab 白名单只保留平板可用的「连接 / 外观 / 通知」=====
// （连接/通知为本设备本地能力：localStorage + WS 状态，不依赖 Electron IPC；外观全部本地持久化。
// 其余 tab 大量依赖 electronAPI 能力，在平板上会显示空壳/伪状态，故不暴露）
const TABLET_SETTINGS_TABS: SettingsTabItem[] = [
  { id: 'connection', label: '连接', icon: <Link size={16} /> },
  { id: 'appearance', label: '外观设置', icon: <Palette size={16} /> },
  { id: 'notifications', label: '通知', icon: <Bell size={16} /> },
]

// ===== Agent 完成提醒音（Web Audio API 合成，零插件依赖，浏览器与 Capacitor WebView 通用）=====
let tabletChimeCtx: AudioContext | null = null
function playTabletCompleteChime(): void {
  try {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return
    tabletChimeCtx = tabletChimeCtx ?? new Ctor()
    const ctx = tabletChimeCtx
    if (ctx.state === 'suspended') void ctx.resume()
    const now = ctx.currentTime
    // 双音短促提示（E5 → A5，各 350ms），音量 0.22 不刺耳
    ;[659.25, 880].forEach((freq, i) => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      const t0 = now + i * 0.12
      osc.type = 'sine'
      osc.frequency.value = freq
      gain.gain.setValueAtTime(0.0001, t0)
      gain.gain.exponentialRampToValueAtTime(0.22, t0 + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.35)
      osc.connect(gain).connect(ctx.destination)
      osc.start(t0)
      osc.stop(t0 + 0.4)
    })
  } catch { /* 忽略：设备不支持音频时静默 */ }
}

// ===== 停止超时兜底 =====
// 点击停止后若 10s 内没有 run_idle 确认（SDK abort 延迟 / 事件丢失 / 会话本就不 active 被 stop 守卫跳过），
// 强制清理本地 streaming，避免“一直跑、停止按钮永久亮”的卡死态；下一次 run 事件或刷新会重新同步真实状态。
const pendingStopTimers = new Map<string, ReturnType<typeof setTimeout>>()

// ===== run_completed / run_idle 去重 =====
// remote-service 会在 orchestrator onComplete 时广播 run_completed，orchestrator finally 又会发 run_idle；
// 两者都表示"本轮结束"，若都完整处理会重复播提醒音、重复 emit STREAM_COMPLETE。
// 用短窗口（3s）记录已由 run_completed 处理过的 sessionId，run_idle 到达时若命中则跳过完整处理，
// 只保留 loadSessions（列表刷新无副作用）。旧服务端（无 run_completed）时 run_idle 仍正常成为唯一信号。
const runCompletedProcessed = new Map<string, number>()
const RUN_COMPLETED_DEDUP_WINDOW_MS = 3000

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
  const setUserProfile = useSetAtom(userProfileAtom)
  const setAuthStatus = useSetAtom(authStatusAtom)
  const appMode = useAtomValue(appModeAtom)
  const nativeActiveSessionId = useAtomValue(currentAgentSessionIdAtom)
  const nativeConversationId = useAtomValue(currentConversationIdAtom)
  const conversations = useAtomValue(conversationsAtom)
  const userProfile = useAtomValue(userProfileAtom)
  const clientRef = useRef<WsClient | null>(null)

  // 界面状态：reconnecting = 已绑定但断线，保持主界面 + 横幅自动重连（不再回登录页“重新校验”）
  const [connection, setConnection] = useState<'idle' | 'connecting' | 'open' | 'reconnecting' | 'error' | 'unauthorized'>('idle')
  const [errMsg, setErrMsg] = useState<string | undefined>(undefined)
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null)
  const [currentChatId, setCurrentChatId] = useState<string | null>(null)
  const [currentTitle, setCurrentTitle] = useState('')
  // 窄屏时侧栏以抽屉承载；宽屏保持与原生工作台一致的左侧导航。
  const [sidebarOpen, setSidebarOpen] = useState(false)
  // 解绑确认弹窗：解绑 = 清除本机保存的服务器地址/令牌并断开连接，回到连接页
  const [unbindConfirmOpen, setUnbindConfirmOpen] = useState(false)
  const hasStoredBinding = Boolean(getStoredToken() || getStoredServerUrl())
  // 横屏且 ≥1024px 时使用固定侧栏布局（landscape:min-[1024px]）；竖屏/小屏走抽屉+顶栏。
  // 竖屏时标题由顶栏承担（AgentHeader 隐藏），横屏时 AgentHeader 自带标题。
  const [landscapeWide, setLandscapeWide] = useState(() => window.matchMedia('(orientation: landscape) and (min-width: 1024px)').matches)
  useEffect(() => {
    const mq = window.matchMedia('(orientation: landscape) and (min-width: 1024px)')
    const onChange = (): void => setLandscapeWide(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  // 浮动顶栏的视觉视口偏移跟踪：键盘弹起/浏览器滚动导致 visualViewport 相对布局视口偏移时
  // （offsetTop > 0），顶栏 top 同步跟随，保证始终锚定在用户可视区域顶部。
  const [visualTop, setVisualTop] = useState(0)
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const update = (): void => setVisualTop(vv.offsetTop)
    update()
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)
    return () => {
      vv.removeEventListener('resize', update)
      vv.removeEventListener('scroll', update)
    }
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
          // 平板通过 WS 连接的是已授权（可能已登录）的电脑端，官方渠道（newapi-*）由电脑端
          // 登录后从服务端同步而来。ModelSelector 的「未登录隐藏官方渠道」过滤依赖此标志；
          // 平板无登录流程，authStatusAtom 恒为 isLoggedIn:false，会误杀全部官方渠道，
          // 导致远程端看不到 GPT/Claude 官方模型。这里在连接成功后置为已登录态以放行官方渠道。
          setAuthStatus((prev) => ({ ...prev, isLoggedIn: true }))
          void loadChannels(client)
          void loadSessions(client)
          void loadConversations(client)
          void loadUserProfile(client)
        } else if (status === 'unauthorized') {
          // token 无效：服务端已拒绝对话且客户端已停止自动重连，停留登录页提示用户重新输入
          setConnection('unauthorized')
          setErrMsg('访问令牌无效或已失效，请查看电脑端启动日志中的 Token 后重新输入')
        } else if (status === 'closed') {
          // 断线（后台冻结/网络变化）：已绑定场景保持主界面，横幅提示自动重连；
          // 不再切回登录页，避免用户误以为需要重新输入 token
          setConnection('reconnecting')
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
      // agentChannelIds：桌面从「设置页勾选的 Agent 渠道」派生（仅 Claude runtime 用于过滤模型选择器）。
      // 移动版无设置页勾选，不能用 isAgentCompatibleProvider 白名单硬过滤——那会漏掉 openai 等
      // Pi 支持的 provider 渠道，导致 Claude/Pi 模式下都看不到这些渠道的模型（“少了某些渠道”）。
      // 对齐最初自立 UI 版本的语义：全量纳入所有已启用渠道，runtime/protocol 兼容性由 AgentView 现有机制处理。
      setAgentChannelIds(ch.map((c) => c.id))
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

      // 字段兜底：服务端列表为脱敏形状，若旧版服务端缺 createdAt/updatedAt 等字段，
      // 补齐默认值后再喂给桌面组件（LeftSidebar 分组/排序/树形导航依赖这些字段，
      // 缺失时可能引发读取 undefined 属性崩溃）。
      const normalizedSessions: SessionInfo[] = data.map((s) => ({
        ...s,
        createdAt: s.createdAt ?? 0,
        updatedAt: s.updatedAt ?? s.createdAt ?? 0,
        pinned: s.pinned ?? false,
        archived: s.archived ?? false,
        draft: s.draft ?? false,
      }))

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

      const personalSessions = normalizedSessions.filter((s) => !teamWorkspaceIds.has(s.workspaceId ?? ''))
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
      // 查不到真实名字的 workspaceId（如因 list_workspaces 失败而漏过滤的团队工作区、或历史孤儿）
      // 不再硬编「项目 · UUID」这种无意义编号——直接跳过，避免侧栏出现纯编号项目误导用户。
      // 「default」特殊保留（默认工作区）以保证始终有一个可回退项目。
      const workspaces = ids
        .map((id) => {
          const real = realWorkspaces.get(id)
          if (real) return real
          if (id === 'default') return { id, name: '默认工作区', slug: 'default', type: 'personal', createdAt: 0, updatedAt: 0 }
          return null
        })
        .filter((w): w is NonNullable<typeof w> => w != null)
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

  /** 连接建立后主动拉取用户档案填充 userProfileAtom。
   *  移动版空态问候语（“…，早上好”）依赖 userName；桌面靠 LeftSidebar 副作用填充，
   *  移动版 LeftSidebar 副作用的触发时机/依赖（authStatus）不保证，必须在此显式拉取，
   *  否则始终显示默认“用户”。 */
  const loadUserProfile = useCallback(async (client: WsClient) => {
    try {
      const profile = await client.getUserProfile() as { userName?: string; avatar?: string } | undefined
      if (profile && typeof profile === 'object') {
        setUserProfile({
          userName: profile.userName || '用户',
          avatar: profile.avatar || '',
        })
      }
    } catch (e) { console.error('拉取用户档案失败', e) }
  }, [setUserProfile])

  // ===== 打开会话：AgentView 自行加载持久化消息与流式状态，平板只切换 sessionId =====
  const openSession = useCallback(async (sessionId: string, title?: string) => {
    setSidebarOpen(false)
    setCurrentSessionId(sessionId)
    setNativeSessionId(sessionId)
    setNativeAppMode('agent')
    setCurrentTitle(title || '')
    saveLastView({ mode: 'agent', sessionId })
  }, [setNativeSessionId, setNativeAppMode])

  /** 打开 Chat 对话：ChatView 自行加载消息与流式状态，平板只切换 conversationId 与模式 */
  const openChatConversation = useCallback((conversationId: string, title?: string) => {
    setSidebarOpen(false)
    setCurrentChatId(conversationId)
    setNativeConversationId(conversationId)
    setNativeAppMode('chat')
    setCurrentTitle(title || '')
    saveLastView({ mode: 'chat', conversationId })
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

  // Chat 模式下刷新后恢复最近对话 → 已合并到下方“恢复上次视图” effect
  // （appMode 持久化可能停在 chat，此时 conversationId 为空，由恢复逻辑统一处理）

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
    const p = evt.payload as { kind?: string; event?: { type?: string; stoppedByUser?: boolean; startedAt?: number; resultSubtype?: string; resultErrors?: string[]; backgroundTasksPending?: boolean } } | null
    // run_completed（remote-service 在 orchestrator onComplete 时广播，携带真实完成元数据）
    // 与 run_idle（orchestrator finally 释放 active 时广播）都可能到达；两者都表示"本轮结束"。
    // 优先用 run_completed 携带的真实 startedAt/stoppedByUser，避免用 Date.now() 伪造 startedAt
    // 导致 onAgentStreamComplete 的 startedAt 竞态保护误判。
    if (p && p.kind === 'profer_event' && p.event && (p.event.type === 'run_completed' || p.event.type === 'run_idle')) {
      const isRunCompleted = p.event.type === 'run_completed'
      // 去重：run_completed 先处理并打标记；紧随其后的 run_idle 若命中短窗口标记，
      // 跳过完整处理（提醒音/STREAM_COMPLETE），只刷新列表。旧服务端无 run_completed 时不命中。
      const now = Date.now()
      const lastCompleted = runCompletedProcessed.get(evt.sessionId)
      const deduped = !isRunCompleted && lastCompleted !== undefined && (now - lastCompleted) < RUN_COMPLETED_DEDUP_WINDOW_MS
      if (isRunCompleted) runCompletedProcessed.set(evt.sessionId, now)

      // 桥接桌面 STREAM_COMPLETE：useGlobalAgentListeners 只有它会把 running 置 false
      // （桌面由 IPC 送达；平板 WS 无此消息，必须由 run_completed / run_idle 代理触发），
      // 否则 streaming 状态永不结束 → 停止按钮永不消失。
      // stoppedByUser：run_completed 用服务端真实值（opts.stoppedByUser）为准；
      // run_idle 无此字段，用本地 stopAgent 记录的标记。无论哪个分支都消费本地标记，
      // 避免两者都到达时（run_completed→run_idle）或顺序颠倒时残留。
      const localStopped = consumeTabletStoppedByUser(evt.sessionId)
      const stoppedByUser = isRunCompleted ? (p.event.stoppedByUser ?? false) : localStopped

      if (!deduped) {
        // startedAt 用真实值：run_completed 带 opts.startedAt，run_idle 无此字段则回退 Date.now()
        const startedAt = p.event.startedAt ?? Date.now()
        emitTabletAgentStreamComplete({
          sessionId: evt.sessionId,
          messages: [],
          stoppedByUser,
          startedAt,
          resultSubtype: p.event.resultSubtype,
          resultErrors: p.event.resultErrors,
          backgroundTasksPending: p.event.backgroundTasksPending,
        })
        // Agent 完成提醒音：开关开启、非用户主动停止、且完成会话不是当前正在查看的会话
        // （自己盯着屏幕看时不需要提醒；正在看其他会话 / Chat 模式时值得提示）
        if (!stoppedByUser && tabletStore.get(tabletNotifyCompleteAtom)) {
          const viewingId = tabletStore.get(currentAgentSessionIdAtom)
          if (viewingId !== evt.sessionId) playTabletCompleteChime()
        }
      }
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

  /** 解绑：断开连接并清除本机保存的服务器地址与访问令牌，回到连接页重新绑定 */
  const unbind = useCallback(() => {
    clientRef.current?.disconnect()
    localStorage.removeItem('profer-remote-token')
    localStorage.removeItem('profer-remote-server')
    clearLastView()
    setConnection('idle'); setSessions([]); setCurrentSessionId(null); setCurrentChatId(null)
    setTokenInput('')
    setServerInput('')
    setSidebarOpen(false)
    toast.success('已解绑此设备，可重新输入服务器地址与访问令牌')
  }, [])

  /** 手动刷新当前视图内容：除事件桥接自动刷新外，提供一键重拉兜底，
   *  解决“显示结束但最后一条结果未出现”的残余情况（分页/事件竞态）。
   *  - Agent：递增 agentMessageRefreshAtom 版本 → AgentView 重拉持久化消息（含分页刷新）。
   *  - Chat：重拉对话列表 + 已打开对话的消息（ChatView 监听 conversationId 变化时自行加载）。 */
  const handleRefresh = useCallback(() => {
    const client = clientRef.current
    if (appMode === 'agent' && currentSessionId) {
      tabletStore.set(agentMessageRefreshAtom, (prev) => {
        const map = new Map(prev)
        map.set(currentSessionId, (prev.get(currentSessionId) ?? 0) + 1)
        return map
      })
      if (client?.isOpen()) void loadSessions(client)
      toast.success('已刷新会话', { duration: 1500 })
    } else if (appMode === 'chat') {
      if (client?.isOpen()) { void loadConversations(client); void loadSessions(client) }
      toast.success('已刷新对话', { duration: 1500 })
    }
  }, [appMode, currentSessionId, loadSessions, loadConversations])

  // 连接状态同步到设置页 atom（「连接」tab 的状态徽标）
  useEffect(() => {
    tabletStore.set(tabletConnectionStatusAtom, connection)
  }, [connection])

  // 设置页「解绑此设备」请求：计数变化时执行完整解绑流程（弹窗确认已在设置页内完成）
  const unbindRequestCount = useAtomValue(tabletUnbindRequestAtom)
  useEffect(() => {
    if (unbindRequestCount > 0) unbind()
  }, [unbindRequestCount, unbind])

  // 初次挂载自动连接（App 场景用已存的显式服务器地址）
  useEffect(() => {
    if (getStoredToken()) {
      setConnection('connecting')
      const t = setTimeout(() => connect(getStoredToken(), getStoredServerUrl()), 0)
      // 卸载时清理：开发 StrictMode 双挂载/页面销毁时断开，避免残留连接
      return () => { clearTimeout(t); clientRef.current?.disconnect() }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ===== 连接就绪后恢复上次视图（整页重载 / 断线重连 / 冷启动都回到上次位置）=====
  // 优先 last-view 记录（含模式与会话 ID）；记录缺失或目标已不存在时按持久化 appMode 兜底
  // （chat → 最近非归档对话；agent → 第一个会话），并接管原“首次连入自动打开第一个会话”逻辑。
  useEffect(() => {
    if (connection !== 'open') return
    if (currentSessionId || currentChatId) return
    const last = getLastView()
    if (last?.mode === 'chat') {
      const conv = last.conversationId ? conversations.find((c) => c.id === last.conversationId) : undefined
      if (conv) { openChatConversation(conv.id, conv.title); return }
      const first = conversations.find((c) => !c.archived)
      if (first) { openChatConversation(first.id, first.title); return }
    }
    if (last?.mode === 'agent') {
      const s = last.sessionId ? sessions.find((x) => x.id === last.sessionId) : undefined
      if (s) { void openSession(s.id, s.title); return }
      if (sessions[0]) { void openSession(sessions[0].id, sessions[0].title); return }
    }
    // 无记录：按持久化 appMode 兜底
    if (appMode === 'chat') {
      const first = conversations.find((c) => !c.archived)
      if (first) { openChatConversation(first.id, first.title); return }
    }
    if (sessions[0]) void openSession(sessions[0].id, sessions[0].title)
  }, [connection, currentSessionId, currentChatId, sessions, conversations, appMode, openSession, openChatConversation])

  // ===== 前后台切换：恢复前台时立即检测/重连 WebSocket =====
  // Android 后台可能冻结 WebView、网络休眠导致 WS 失效；恢复前台主动检查，
  // 已断则立即重连（不等 2s 定时器），仍连则 reconnectNow 内部 no-op，完全无感。
  useEffect(() => {
    const onVisibility = (): void => {
      if (document.hidden) return
      clientRef.current?.reconnectNow()
    }
    document.addEventListener('visibilitychange', onVisibility)
    // Capacitor App 插件（若已安装 @capacitor/app）：原生 resume 事件同样兜底
    const appPlugin = (window as unknown as {
      Capacitor?: { Plugins?: { App?: { addListener: (event: string, cb: () => void) => Promise<{ remove: () => void }> } } }
    })?.Capacitor?.Plugins?.App
    let resumeHandle: { remove: () => void } | null = null
    if (appPlugin?.addListener) {
      void appPlugin.addListener('resume', () => clientRef.current?.reconnectNow()).then((h) => { resumeHandle = h })
    }
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      resumeHandle?.remove()
    }
  }, [])

  // 抽屉遵循原生弹层习惯：Escape 可立即返回工作区。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSidebarOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // ============ 渲染 ============
  // 登录页只在两种情况下出现：未绑定（从未输入过 token / 已解绑）或 token 被服务端拒绝（4001）。
  // 已绑定但断线（closed/connecting/error）→ 保持主界面 + 顶部横幅提示自动重连，不再“重新校验”。
  const showLogin = connection === 'unauthorized' || !hasStoredBinding
  const reconnectBannerText = connection === 'error'
    ? '连接失败，正在自动重连…'
    : connection === 'reconnecting'
      ? '连接已断开，正在重连…'
      : '正在连接…'
  return (
    <>
      {showLogin ? (
        // 未连接：token 页
        <div className={`flex h-full w-full items-center justify-center bg-background text-foreground p-6 ${SAFE_AREA_CLS}`}>
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
          {hasStoredBinding && (
            <div className="space-y-2">
              {/* 已绑定状态指示：明确当前并非“未连接”，而是已保存绑定信息 */}
              <div className="flex items-center justify-center gap-1.5 text-[12px] text-muted-foreground">
                <span className="size-1.5 shrink-0 rounded-full bg-emerald-500" aria-hidden />
                <span className="truncate">
                  已绑定{getStoredServerUrl() ? `：${getStoredServerUrl()}` : '（自动地址）'}
                </span>
              </div>
              <button
              type="button"
              onClick={() => setUnbindConfirmOpen(true)}
              className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-border py-2 text-[12px] text-foreground/70 hover:text-destructive hover:border-destructive/40 transition-colors"
            >
              <Link className="size-3.5" />
              解绑并重新连接
            </button>
            </div>
          )}
        </div>
      </div>
      ) : (
        <>
        {/* 断线重连横幅：已绑定场景切屏回来若 WS 已断，主界面不消失，顶部横幅提示自动重连；
            连接恢复后横幅自动消失。Portal 到 body 避开 UiScaleContainer 的 transform。 */}
        {connection !== 'open' && createPortal(
          <div
            className="fixed inset-x-0 z-40 flex justify-center px-4"
            style={{ top: `calc(${visualTop}px + ${landscapeWide ? '12px' : '60px'} + env(safe-area-inset-top))` }}
          >
            <div className="pointer-events-auto flex items-center gap-2 rounded-full bg-amber-500/95 px-4 py-1.5 text-[12px] font-medium text-white shadow-lg">
              <Loader2 className="size-3.5 animate-spin" />
              <span>{reconnectBannerText}</span>
            </div>
          </div>,
          document.body
        )}
        {/* 已连接：桌面式布局（左侧会话栏 + 主区，无右侧栏；对话区整体复用桌面 AgentView）。
            断点约定：横屏且 ≥1024px 显示固定侧栏（iPad 横屏/桌面浏览器）；其余一律抽屉+顶栏——
            竖屏不管宽度（含 iPad Pro 12.9" 竖屏 1024px）都走抽屉，避免固定侧栏挤压对话区。 */}
        {/* 浮动顶栏（竖屏/窄屏；横屏固定侧栏布局由 AgentHeader 自带标题）。
            Portal 到 body 是关键：UiScaleContainer 的 transform 是定位 containing block，
            顶栏若渲染在容器内，fixed 会退化为相对容器定位，键盘弹起触发文档滚动时被顶出屏幕；
            Portal 后 fixed 相对视口 + visualViewport.offsetTop 驱动，永远锚定可视区域顶部，
            键盘弹起/滚动都不影响。 */}
        {!landscapeWide && createPortal(
          <div
            className="fixed inset-x-0 z-30 flex h-12 items-center bg-tabbar-surface/90 px-2 backdrop-blur-md"
            style={{ top: `calc(${visualTop}px + env(safe-area-inset-top))` }}
          >
            <Button type="button" variant="ghost" size="icon" onClick={() => setSidebarOpen(true)} className="mr-1 size-10 shrink-0 rounded-[12px] text-foreground/65 hover:bg-foreground/[0.06]" aria-label="打开导航"><Menu className="size-[18px]" /></Button>
            <div className="flex-1 min-w-0 px-1">
              <span className="block truncate text-sm font-medium text-foreground">{activeTitle}</span>
            </div>
            {/* 手动刷新入口：兼做“完成但结果未出现”的兑底——一键重拉当前会话消息 */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button type="button" variant="ghost" size="icon" onClick={handleRefresh} className="size-10 shrink-0 rounded-[12px] text-foreground/65 hover:bg-foreground/[0.06]" aria-label="刷新当前内容">
                  <RefreshCw className="size-[18px]" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">刷新当前内容</TooltipContent>
            </Tooltip>
            {/* 顶栏解绑入口：Link 图标 + 绿色状态点表示“已绑定”，避免 Unlink（断链图标）被误读为未连接 */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button type="button" variant="ghost" size="icon" onClick={() => setUnbindConfirmOpen(true)} className="relative size-10 shrink-0 rounded-[12px] text-foreground/65 hover:bg-foreground/[0.06]" aria-label="已绑定，点击解绑">
                  <Link className="size-[18px]" />
                  <span className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-emerald-500" aria-hidden />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">已绑定 · 点击解绑</TooltipContent>
            </Tooltip>
          </div>,
          document.body
        )}

        <div className={`tablet-app-root flex h-full w-full overflow-hidden bg-background p-0 text-foreground landscape:min-[1024px]:p-2 ${SAFE_AREA_CLS}`}>
      <NativeTabletSidebar mobileOpen={sidebarOpen} onDismiss={() => setSidebarOpen(false)} />

      {/* 主区（竖屏 pt-12 为浮动顶栏预留高度，滚动内容从悬浮条下方穿过；横屏无顶栏不需要） */}
      <div className="flex-1 min-w-0 flex flex-col overflow-hidden bg-content-area pt-12 landscape:min-[1024px]:pt-0 landscape:min-[1024px]:ml-2 landscape:min-[1024px]:rounded-[24px] landscape:min-[1024px]:border landscape:min-[1024px]:border-border/70 landscape:min-[1024px]:shadow-xl">
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
        </>
      )}

      {/* 解绑确认弹窗（Portal 到 body，不随缩放容器变换） */}
      <AlertDialog open={unbindConfirmOpen} onOpenChange={setUnbindConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>解绑此设备？</AlertDialogTitle>
            <AlertDialogDescription>
              解绑后将清除本机保存的服务器地址和访问令牌，断开当前连接并回到连接页，需要重新输入才能继续使用。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={unbind}>确认解绑</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

// ===== 平板直接复用桌面 LeftSidebar；浏览器端只以 WebSocket adapter 替代 Electron IPC。 =====
function NativeTabletSidebar({ mobileOpen, onDismiss }: { mobileOpen: boolean; onDismiss: () => void }): React.ReactElement {
  return (
    <>
      <div className="hidden h-full shrink-0 landscape:min-[1024px]:block"><LeftSidebar width={288} tabletMode /></div>
      <div className={`fixed inset-0 z-50 landscape:min-[1024px]:hidden ${mobileOpen ? 'pointer-events-auto' : 'pointer-events-none'}`} aria-hidden={!mobileOpen}>
        <button type="button" className={`absolute inset-0 z-0 bg-black/40 transition-opacity duration-200 ${mobileOpen ? 'opacity-100' : 'opacity-0'}`} onClick={onDismiss} aria-label="关闭会话导航" tabIndex={mobileOpen ? 0 : -1} />
        <div className={`absolute inset-y-0 left-0 z-10 touch-pan-y transition-transform duration-200 ease-out ${SAFE_AREA_CLS} ${mobileOpen ? 'translate-x-0' : '-translate-x-full'}`}>
          {/* 搜索面板（SearchDialog）是全局 atom + Portal，只需渲染一份；由横屏固定侧栏实例承担。
              抽屉实例设为 false，避免双 SearchDialog 叠加导致打开即被 interactOutside 关闭（“一闪即逝”）。 */}
          <LeftSidebar width={288} tabletMode renderSearchDialog={false} />
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

// ===== 全局错误捕获：便于定位（仅开发模式；生产环境不显示红色错误横幅） =====
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
  el.textContent = '[移动端 UI 运行错误]\n' + errs.map((e, i) => `${i}. ${e.msg}${e.stack ? '\n' + e.stack.slice(0, 400) : ''}`).join('\n\n')
}
if (import.meta.env.DEV) {
  window.addEventListener('error', (ev) => { errs.push({ msg: ev.message || 'unknown', stack: ev.error?.stack }); renderErrBanner() })
  window.addEventListener('unhandledrejection', (ev) => {
    const r = ev.reason
    const msg = r && typeof r === 'object' && 'message' in r ? String((r as { message: unknown }).message) : String(r)
    errs.push({ msg: 'UnhandledRejection: ' + msg }); renderErrBanner()
  })
}
