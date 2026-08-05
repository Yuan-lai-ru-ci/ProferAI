/**
 * Profer Tablet UI — 桌面式平板界面
 *
 * 复用桌面版真实组件：对话区用 @/components/agent/AgentMessages（与桌面 100% 一致），
 * 桌面式左侧会话栏 + 顶栏 + 输入框，砍掉右侧栏。
 *
 * 数据源：WsClient → remote-service，把持久化 SDKMessage / 流式 agent_event
 *         组装后喂给 AgentMessages（persistedSDKMessages + liveMessages + streaming）。
 *
 * 关键机制：
 *  - jotai Provider（createStore）供给 userProfile/channels 等 atom，供被复用组件消费
 *  - 顶部安装 window.electronAPI 最小 stub，避免复用组件触碰边角功能时崩
 */

import React, { useCallback, useEffect, useRef, useState } from 'react'
import ReactDOM from 'react-dom/client'
import { Provider, createStore, useSetAtom, useAtomValue } from 'jotai'
import '@fontsource-variable/inter/index.css'
import '@/styles/globals.css'
import { installElectronApiStub } from './electronapi-stub'
import { defaultWsUrl, WsClient, type AgentWorkflowEvent } from './ws-client'
import { InteractionPanels, type PendingInteractions } from './interaction-panels'
import { ContextUsageBadge } from '@/components/agent/ContextUsageBadge'
// ===== 复用桌面组件 / atom（必须位于模块顶部，确保 ESM 正常收集）=====
import { userProfileAtom } from '@/atoms/user-profile'
import { channelsAtom } from '@/atoms/chat-atoms'
import { AgentMessages } from '@/components/agent/AgentMessages'
import { RichTextInput } from '@/components/ai-elements/rich-text-input'
import { TooltipProvider } from '@/components/ui/tooltip'
import { InputToolbarOverflow, type ToolbarItem } from '@/components/ai-elements/InputToolbarOverflow'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { Button } from '@/components/ui/button'
import { CornerDownLeft, Square, Menu, Plus, LogOut, X, Bot, MessageSquare, Pencil, Brain, ShieldCheck, Paperclip, Eye } from 'lucide-react'
import type { SDKMessage } from '@profer/shared'

// ===== 先安装 electronAPI stub（必须在任何复用组件求值前）=====
installElectronApiStub()

// ===== Token 存取 =====
function getStoredToken(): string { return localStorage.getItem('profer-remote-token') || '' }
function storeToken(t: string): void { localStorage.setItem('profer-remote-token', t) }

// ===== 类型 =====
interface ChannelInfo { id: string; name: string; provider: string; models: { id: string; name: string }[] }
interface SessionInfo { id: string; title: string; channelId?: string; modelId?: string; workspaceId?: string; parentSessionId?: string; sourceDelegationId?: string; agentRuntime?: 'claude' | 'pi'; permissionMode?: string; active: boolean; updatedAt?: number }
interface SessionDetail { meta: Pick<SessionInfo, 'id' | 'title' | 'channelId' | 'modelId' | 'agentRuntime' | 'permissionMode' | 'active'> }

const tabletStore = createStore()

// ===== 根组件 =====
function TabletApp(): React.ReactElement {
  return (
    <Provider store={tabletStore}>
      <TooltipProvider>
        <App />
      </TooltipProvider>
    </Provider>
  )
}

function App(): React.ReactElement {
  const [tokenInput, setTokenInput] = useState(getStoredToken())
  const setChannels = useSetAtom(channelsAtom)
  const userProfile = useAtomValue(userProfileAtom)
  const clientRef = useRef<WsClient | null>(null)

  // 界面状态
  const [connection, setConnection] = useState<'idle' | 'connecting' | 'open' | 'error'>('idle')
  const [errMsg, setErrMsg] = useState<string | undefined>(undefined)
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [channels, setChannelsState] = useState<ChannelInfo[]>([])
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null)
  const [currentTitle, setCurrentTitle] = useState('')
  const [selectedChannelId, setSelectedChannelId] = useState('')
  const [selectedModelId, setSelectedModelId] = useState('')
  const [currentRuntime, setCurrentRuntime] = useState<'claude' | 'pi'>('claude')
  const [currentPermissionMode, setCurrentPermissionMode] = useState<string | undefined>(undefined)
  const [attachments, setAttachments] = useState<Array<{ filename: string; path: string }>>([])
  const [contextUsage, setContextUsage] = useState<{ inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheCreationTokens?: number; contextWindow?: number; usageUpdatedAt?: number; isCompacting: boolean }>({ isCompacting: false })
  const attachmentInputRef = useRef<HTMLInputElement>(null)
  // 窄屏时侧栏以抽屉承载；宽屏保持与原生工作台一致的左侧导航。
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')

  // AgentMessages 数据
  const [persistedSDKMessages, setPersistedSDKMessages] = useState<SDKMessage[]>([])
  const [liveMessages, setLiveMessages] = useState<SDKMessage[]>([])
  const [streaming, setStreaming] = useState(false)
  const [messagesLoaded, setMessagesLoaded] = useState(false)
  const [stoppedByUser, setStoppedByUser] = useState(false)

  const [input, setInput] = useState('')
  const [pendingInteractions, setPendingInteractions] = useState<PendingInteractions>({ permissions: [], askUsers: [], exitPlans: [] })

  // ===== WS 管理 =====
  const connect = useCallback((token: string) => {
    if (clientRef.current) clientRef.current.disconnect()
    const client = new WsClient({
      url: defaultWsUrl(),
      token,
      onStatusChange: (status) => {
        if (status === 'open') {
          setConnection('open'); setErrMsg(undefined)
          void loadChannels(client)
          void loadSessions(client)
          void loadPendingInteractions(client)
        } else if (status === 'error') setConnection('error')
        else setConnection('connecting')
      },
      onAgentEvent: (evt) => handleAgentEvent(client, evt),
    })
    clientRef.current = client
    client.connect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const loadChannels = useCallback(async (client: WsClient) => {
    try {
      const data = await client.listChannels() as ChannelInfo[]
      const ch = Array.isArray(data) ? data : []
      setChannelsState(ch)
      // 喂给 jotai channelsAtom（AgentMessages 解析模型 logo/name 用）
      setChannels(ch as never)
      setSelectedChannelId((prev) => prev || (ch[0]?.id || ''))
      setSelectedModelId((prev) => prev || (ch[0]?.models?.[0]?.id || ''))
    } catch (e) { console.error('拉取渠道失败', e) }
  }, [setChannels])

  const loadSessions = useCallback(async (client: WsClient) => {
    try {
      const data = await client.listSessions() as SessionInfo[]
      if (Array.isArray(data)) setSessions(data)
    } catch (e) { console.error('拉取会话失败', e) }
  }, [])

  const loadPendingInteractions = useCallback(async (client: WsClient, sessionId?: string) => {
    try {
      const data = await client.getPendingInteractions(sessionId) as PendingInteractions
      setPendingInteractions({ permissions: data.permissions || [], askUsers: data.askUsers || [], exitPlans: data.exitPlans || [] })
    } catch (e) { console.error('拉取待处理交互失败', e) }
  }, [])

  // ===== 打开会话：加载持久化 SDK 消息 =====
  const openSession = useCallback(async (client: WsClient, sessionId: string, title?: string) => {
    setSidebarOpen(false)
    setCurrentSessionId(sessionId)
    setCurrentTitle(title || '')
    setCurrentRuntime(sessionsRef.current.find(s => s.id === sessionId)?.agentRuntime || 'claude')
    setCurrentPermissionMode(sessionsRef.current.find(s => s.id === sessionId)?.permissionMode)
    setMessagesLoaded(false)
    setLiveMessages([])
    setStreaming(false)
    // Usage 是会话私有数据；切换时立即清空，不能让新会话短暂显示上个会话的上下文环。
    setContextUsage({ isCompacting: false })
    void loadPendingInteractions(client, sessionId)
    try {
      const detail = await client.sessionDetail(sessionId) as SessionDetail
      if (detail?.meta) {
        setCurrentTitle(detail.meta.title || title || '')
        setCurrentRuntime(detail.meta.agentRuntime || 'claude')
        setCurrentPermissionMode(detail.meta.permissionMode)
        setSelectedChannelId(previous => detail.meta.channelId || previous)
        setSelectedModelId(previous => detail.meta.modelId || previous)
      }
      const sdk = await client.getSdkMessages(sessionId) as SDKMessage[]
      if (Array.isArray(sdk)) setPersistedSDKMessages(sdk)
      else setPersistedSDKMessages([])
    } catch (e) {
      console.error('加载 SDK 消息失败', e)
      setPersistedSDKMessages([])
    }
    setMessagesLoaded(true)
  }, [])

  // ===== Agent 事件：收集流式 SDK 消息 + 生命周期 =====
  const agentEventsRef = useRef<SDKMessage[]>([])

  const handleAgentEvent = useCallback((client: WsClient, evt: AgentWorkflowEvent) => {
    const p = evt.payload as Record<string, unknown>
    if (evt.sessionId !== currentSessionIdRef.current) return
    if (p.kind === 'sdk_message' && p.message) {
      const msg = p.message as SDKMessage
      const usage = extractContextUsage(msg)
      if (usage) setContextUsage(current => ({ ...current, ...usage, usageUpdatedAt: Date.now() }))
      agentEventsRef.current.push(msg)
      setLiveMessages([...agentEventsRef.current])
      setStreaming(true)
      return
    }
    if (p.kind === 'profer_event' && p.event) {
      const et = (p.event as { type?: string }).type
      if (et === 'permission_request' || et === 'ask_user_request' || et === 'exit_plan_mode_request' || et === 'permission_resolved' || et === 'ask_user_resolved' || et === 'exit_plan_mode_resolved') void loadPendingInteractions(client, evt.sessionId)
      if (et === 'run_idle' || et === 'run_completed') {
        setStreaming(false)
        setContextUsage(current => ({ ...current, isCompacting: false }))
        // 结束后把实时累积清空，回到持久化；并将新消息并入 persisted
        const all = [...persistedSDKMessagesRef.current, ...agentEventsRef.current]
        setPersistedSDKMessages(all)
        agentEventsRef.current = []
        setLiveMessages([])
        void loadSessions(client)
      }
    }
  }, [])

  // 用 ref 访问最新 currentSessionId / persistedSDKMessages（避免 useCallback 闭包过期）
  const currentSessionIdRef = useRef<string | null>(null)
  const persistedSDKMessagesRef = useRef<SDKMessage[]>([])
  const sessionsRef = useRef<SessionInfo[]>([])
  useEffect(() => {
    currentSessionIdRef.current = currentSessionId
    persistedSDKMessagesRef.current = persistedSDKMessages
    sessionsRef.current = sessions
  }, [currentSessionId, persistedSDKMessages, sessions])

  useEffect(() => () => clientRef.current?.disconnect(), [])

  // ===== 发消息 =====
  const sendMessage = useCallback(async () => {
    const client = clientRef.current
    const text = input.trim()
    if (!client || !client.isOpen() || (!text && attachments.length === 0) || !currentSessionId) return
    if (!selectedChannelId) { setErrMsg('请先选择一个渠道'); return }
    const attachmentReferences = attachments.length ? `\n\n<attached_files>\n${attachments.map(file => `- ${file.filename}: ${file.path}`).join('\n')}\n</attached_files>` : ''
    setInput('')
    setAttachments([])
    agentEventsRef.current = []
    setStreaming(true)
    setStoppedByUser(false)
    try {
      await client.sendMessage({
        sessionId: currentSessionId,
        userMessage: `${text || '请处理随附文件。'}${attachmentReferences}`,
        channelId: selectedChannelId,
        modelId: selectedModelId || undefined,
      })
    } catch (e) { setErrMsg('发送失败: ' + String(e)); setStreaming(false) }
  }, [input, attachments, currentSessionId, selectedChannelId, selectedModelId])

  const uploadAttachments = useCallback(async (files: FileList | File[]) => {
    const client = clientRef.current
    if (!client || !currentSessionId) return
    const accepted = Array.from(files).slice(0, 5).filter(file => file.size <= 10 * 1024 * 1024)
    if (accepted.length !== Array.from(files).length) setErrMsg('仅支持最多 5 个、单个不超过 10 MB 的附件')
    try {
      const uploaded = await Promise.all(accepted.map(async file => {
        const base64 = await readFileAsBase64(file)
        return client.uploadAttachment(currentSessionId, file.name, base64)
      }))
      setAttachments(previous => [...previous, ...uploaded.map(file => ({ filename: file.filename, path: file.path }))])
    } catch (error) { setErrMsg('附件上传失败: ' + String(error)) }
  }, [currentSessionId])

  const setSessionModel = useCallback(async (channelId: string, modelId?: string) => {
    const client = clientRef.current
    if (!client || !currentSessionId || streaming) return
    try {
      const result = await client.updateSessionModel(currentSessionId, channelId, modelId) as { channelId?: string; modelId?: string }
      setSelectedChannelId(result.channelId || channelId)
      setSelectedModelId(result.modelId || modelId || '')
      setSessions(previous => previous.map(session => session.id === currentSessionId ? { ...session, channelId: result.channelId || channelId, modelId: result.modelId || modelId } : session))
    } catch (error) { setErrMsg('切换模型失败: ' + String(error)) }
  }, [currentSessionId, streaming])

  const setRuntime = useCallback(async (runtime: 'claude' | 'pi') => {
    const client = clientRef.current
    if (!client || !currentSessionId || streaming) return
    try { await client.updateSessionRuntime(currentSessionId, runtime); setCurrentRuntime(runtime); setSessions(previous => previous.map(s => s.id === currentSessionId ? { ...s, agentRuntime: runtime } : s)) } catch (error) { setErrMsg('切换运行时失败: ' + String(error)) }
  }, [currentSessionId, streaming])

  const setPermissionMode = useCallback(async (mode: 'auto' | 'plan' | 'bypassPermissions') => {
    const client = clientRef.current
    if (!client || !currentSessionId) return
    try { await client.updatePermissionMode(currentSessionId, mode); setCurrentPermissionMode(mode); setSessions(previous => previous.map(s => s.id === currentSessionId ? { ...s, permissionMode: mode } : s)) } catch (error) { setErrMsg('更新权限模式失败: ' + String(error)) }
  }, [currentSessionId])

  const compactContext = useCallback(async () => {
    const client = clientRef.current
    if (!client || !currentSessionId || !selectedChannelId || streaming) return
    setContextUsage(current => ({ ...current, isCompacting: true }))
    setStreaming(true)
    try { await client.sendMessage({ sessionId: currentSessionId, userMessage: '/compact', channelId: selectedChannelId, modelId: selectedModelId || undefined }) } catch (error) { setContextUsage(current => ({ ...current, isCompacting: false })); setStreaming(false); setErrMsg('压缩上下文失败: ' + String(error)) }
  }, [currentSessionId, selectedChannelId, selectedModelId, streaming])

  const stopAgent = useCallback(async () => {
    const client = clientRef.current
    if (!client || !currentSessionId) return
    try { await client.stopAgent(currentSessionId) } catch { /* ignore */ }
    setStoppedByUser(true)
  }, [currentSessionId])

  const renameCurrentSession = useCallback(async () => {
    const client = clientRef.current
    const title = titleDraft.trim()
    if (!client || !currentSessionId || !title || title === currentTitle) { setEditingTitle(false); return }
    try {
      await client.renameSession(currentSessionId, title)
      setCurrentTitle(title)
      setSessions(prev => prev.map(s => s.id === currentSessionId ? { ...s, title } : s))
      setEditingTitle(false)
    } catch (e) { setErrMsg('重命名失败: ' + String(e)) }
  }, [titleDraft, currentSessionId, currentTitle])

  const createSession = useCallback(async () => {
    const client = clientRef.current
    if (!client || !client.isOpen()) return
    try {
      const data = await client.createSession({ title: '新会话', channelId: selectedChannelId || undefined, modelId: selectedModelId || undefined }) as { sessionId: string; title: string }
      if (data?.sessionId) {
        await openSession(client, data.sessionId, data.title)
        await loadSessions(client)
      }
    } catch (e) { setErrMsg('创建会话失败: ' + String(e)) }
  }, [selectedChannelId, selectedModelId, openSession, loadSessions])

  // 提交 token
  const submitToken = useCallback(() => {
    const t = tokenInput.trim()
    if (!t) { setErrMsg('请输入访问令牌'); return }
    storeToken(t)
    setErrMsg(undefined)
    setConnection('connecting')
    setTimeout(() => connect(t), 0)
  }, [tokenInput, connect])

  const logout = useCallback(() => {
    clientRef.current?.disconnect()
    localStorage.removeItem('profer-remote-token')
    setConnection('idle'); setSessions([]); setCurrentSessionId(null)
    setPersistedSDKMessages([]); setLiveMessages([]); setStreaming(false)
    setTokenInput('')
  }, [])

  // 初次挂载自动连接
  useEffect(() => {
    if (getStoredToken()) { setConnection('connecting'); setTimeout(() => connect(getStoredToken()), 0) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 首次连入后自动打开最近会话；没有会话时保持原生工作台式空状态。
  useEffect(() => {
    const client = clientRef.current
    if (connection === 'open' && !currentSessionId && sessions[0] && client?.isOpen()) {
      void openSession(client, sessions[0].id, sessions[0].title)
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
      <div className="flex h-[100dvh] w-full items-center justify-center bg-background text-foreground p-6">
        <div className="w-full max-w-sm space-y-6">
          <div className="space-y-1.5">
            <div className="text-xl font-semibold italic tracking-tight">Profer</div>
            <div className="text-sm text-muted-foreground">在电脑上以 <code className="px-1.5 py-0.5 rounded bg-muted/60 font-mono text-xs">--tablet</code> 启动后连接</div>
          </div>
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

  // 已连接：桌面式布局（左侧会话栏 + 主区，无右侧栏）
  return (
    <div className="flex h-[100dvh] w-full overflow-hidden bg-background p-0 text-foreground md:p-2">
      {/* 与原生 LeftSidebar 同一会话导航语言：宽屏固定侧栏，窄屏放入抽屉。 */}
      <Sidebar
        sessions={sessions}
        currentSessionId={currentSessionId}
        mobileOpen={sidebarOpen}
        onDismiss={() => setSidebarOpen(false)}
        onOpen={(id, title) => openSession(clientRef.current!, id, title)}
        onCreate={createSession}
        onLogout={logout}
      />

      {/* 主区 */}
      <div className="flex-1 min-w-0 flex flex-col overflow-hidden bg-content-area md:ml-2 md:rounded-[24px] md:border md:border-border/70 md:shadow-xl">
        {/* 桌面 MainArea 的 TabBar / AgentHeader 层级：不再把连接状态做成另一个产品顶栏。 */}
        <div className="flex h-12 items-center border-b border-border bg-tabbar-surface px-2 sm:px-3">
          <Button type="button" variant="ghost" size="icon" onClick={() => setSidebarOpen(true)} className="mr-1 size-10 shrink-0 rounded-[12px] text-foreground/65 hover:bg-foreground/[0.06] md:hidden" aria-label="打开导航"><Menu className="size-[18px]" /></Button>
          <div className="flex h-full min-w-0 items-center gap-2 border-r border-border px-3 text-[13px] font-medium text-foreground">
            <Bot className="size-3.5 text-foreground/55" /><span className="truncate">{currentTitle || '新会话'}</span>
          </div>
        </div>
        <div className="flex h-11 shrink-0 items-center gap-2 px-5 sm:px-6">
          {editingTitle ? <input autoFocus value={titleDraft} onChange={(e) => setTitleDraft(e.target.value)} onBlur={() => void renameCurrentSession()} onKeyDown={(e) => { if (e.key === 'Enter') void renameCurrentSession(); if (e.key === 'Escape') setEditingTitle(false) }} className="h-7 min-w-0 max-w-[340px] rounded border-b border-primary/60 bg-transparent px-0 text-[15px] font-semibold outline-none" maxLength={100} /> : <><div className="min-w-0 truncate text-[15px] font-semibold text-foreground">{currentTitle || '新会话'}</div>{currentSessionId && <Button type="button" variant="ghost" size="icon" onClick={() => { setTitleDraft(currentTitle); setEditingTitle(true) }} className="size-7 shrink-0 text-foreground/45"><Pencil className="size-3.5" /></Button>}</>}
          {streaming && <Button type="button" variant="ghost" size="sm" onClick={stopAgent} className="h-8 rounded-md text-destructive hover:bg-destructive/10 hover:text-destructive"><Square className="mr-1.5 size-3.5" fill="currentColor" strokeWidth={0} />停止</Button>}
        </div>

        {/* 对话区：AgentMessages 内部的 Conversation/StickToBottom 承担真实滚动。
            此处必须保留可触摸的纵向手势，不能让父容器截断滚动链。 */}
        <div className="flex-1 min-h-0 touch-pan-y">
          {currentSessionId ? (
            <AgentMessages
              sessionId={currentSessionId}
              messagesLoaded={messagesLoaded}
              persistedSDKMessages={persistedSDKMessages}
              liveMessages={liveMessages}
              streaming={streaming}
              sessionPath={undefined}
              stoppedByUser={stoppedByUser}
            />
          ) : (
            <div className="flex h-full flex-col items-center justify-center px-6 text-center">
              <div className="max-w-sm space-y-2">
                <div className="text-[22px] font-semibold tracking-tight text-foreground">{userProfile.userName}，早上好</div>
                <div className="mt-6 inline-flex rounded-xl bg-primary/5 p-1">
                  <div className="flex h-9 items-center gap-2 rounded-lg bg-background px-6 text-[14px] font-medium shadow-sm"><Bot className="size-4" />Agent</div>
                  <div className="flex h-9 items-center gap-2 px-6 text-[14px] text-muted-foreground"><MessageSquare className="size-4" />Chat</div>
                </div>
                <p className="mt-16 text-[13px] leading-5 text-muted-foreground">开始你的第一个 Agent 会话，Token 消耗热力图将在这里显示</p>
                <Button type="button" variant="outline" size="sm" onClick={createSession} className="mt-3 h-9 gap-1.5"><Plus className="size-3.5" />新建会话</Button>
              </div>
            </div>
          )}
        </div>

        {/* 复刻桌面 AgentView：审批横幅在 Composer 上方；输入内容与工具栏收进同一 agent-input-surface。 */}
        <div className="shrink-0 bg-background px-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))] pt-2.5 md:px-[18px] md:pb-[18px]">
          <InteractionPanels pending={pendingInteractions} onPermission={async (id, behavior, always) => { const c = clientRef.current; if (c) { await c.respondPermission(id, behavior, always); await loadPendingInteractions(c, currentSessionId || undefined) } }} onAskUser={async (id, answers) => { const c = clientRef.current; if (c) { await c.respondAskUser(id, answers); await loadPendingInteractions(c, currentSessionId || undefined) } }} onExitPlan={async (id, action, feedback) => { const c = clientRef.current; if (c) { await c.respondExitPlanMode(id, action, feedback); await loadPendingInteractions(c, currentSessionId || undefined) } }} />
          <div className="composer-stack mx-auto max-w-[min(72rem,100%)]">
            <div className="agent-input-surface relative z-10 rounded-[17px] border-[0.5px] border-border bg-background/70 shadow-sm backdrop-blur-sm transition-[background-color,border-color,box-shadow] duration-200">
          {attachments.length > 0 && <div className="flex flex-wrap gap-1.5 px-3 pt-2">{attachments.map(file => <span key={file.path} className="inline-flex max-w-[220px] items-center gap-1 rounded-md border border-border bg-muted/50 px-2 py-1 text-[11px]"><Paperclip className="size-3 shrink-0"/><span className="truncate">{file.filename}</span><button type="button" aria-label={`移除 ${file.filename}`} onClick={() => setAttachments(current => current.filter(item => item.path !== file.path))}><X className="size-3"/></button></span>)}</div>}
          <div className="px-3 pt-2">
              <RichTextInput
                value={input}
                onChange={setInput}
                onSubmit={sendMessage}
                placeholder={!currentSessionId ? '请先新建或打开一个会话' : selectedChannelId ? '输入消息... (Enter 发送，Shift+Enter 换行)' : '请先选择渠道'}
                disabled={!currentSessionId || !selectedChannelId}
                autoFocusTrigger={currentSessionId}
                collapsible
                enableMentions={false}
              />
              <input ref={attachmentInputRef} type="file" className="hidden" multiple onChange={(event) => { if (event.target.files) void uploadAttachments(event.target.files); event.target.value = '' }} />
          </div>
          <InputToolbarOverflow
            items={[
              {
                key: 'model',
                node: <ChannelModelButton
                  channels={channels}
                  selectedChannelId={selectedChannelId}
                  selectedModelId={selectedModelId}
                  disabled={!currentSessionId || streaming}
                  onSelectChannel={(id) => {
                    const channel = channels.find(item => item.id === id)
                    void setSessionModel(id, channel?.models[0]?.id)
                  }}
                  onSelectModel={(id) => void setSessionModel(selectedChannelId, id)}
                />,
              },
              { key: 'runtime', node: <RuntimeTool runtime={currentRuntime} disabled={streaming || !currentSessionId} onChange={setRuntime} /> },
              { key: 'permission-mode', node: <PermissionModeTool mode={currentPermissionMode} disabled={!currentSessionId} onChange={setPermissionMode} /> },
              { key: 'attachment', node: <Tooltip><TooltipTrigger asChild><Button type="button" variant="ghost" size="icon" className="size-[36px] shrink-0 rounded-full text-foreground/60 hover:text-foreground" onClick={() => attachmentInputRef.current?.click()} disabled={!currentSessionId}><Paperclip className="size-5" /></Button></TooltipTrigger><TooltipContent side="top"><p>添加附件</p></TooltipContent></Tooltip> },
              // 与桌面顺序一致：附件后是上下文圆环、显示选项和任务图。
              { key: 'context-usage', node: <ContextUsageBadge inputTokens={contextUsage.inputTokens} outputTokens={contextUsage.outputTokens} cacheReadTokens={contextUsage.cacheReadTokens} cacheCreationTokens={contextUsage.cacheCreationTokens} contextWindow={contextUsage.contextWindow} usageUpdatedAt={contextUsage.usageUpdatedAt} isCompacting={contextUsage.isCompacting} isProcessing={streaming} onCompact={compactContext} sessionId={currentSessionId || undefined} /> },
              { key: 'display-options', node: <RemoteUnavailableTool icon={<Eye className="size-5" />} label="显示选项" description="文件自动预览和输出保持展开尚未开放平板远程协议。" /> },
            ]}
            trailing={
              streaming ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button type="button" variant="ghost" size="icon" className="size-[36px] rounded-full text-destructive" onClick={stopAgent}>
                      <Square className="size-[16px]" fill="currentColor" strokeWidth={0} />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="top"><p>停止</p></TooltipContent>
                </Tooltip>
              ) : (
                <Button
                  type="button" variant="ghost" size="icon"
                  className={`size-[36px] rounded-full ${input.trim() && selectedChannelId ? 'text-primary' : 'text-foreground/30 cursor-not-allowed'}`}
                  onClick={sendMessage}
                  disabled={!input.trim() || !selectedChannelId}
                >
                  <CornerDownLeft className="size-[22px]" />
                </Button>
              )
            }
          />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ===== 模型选择按钮（对齐桌面 36px 圆形，数据走 WS） =====
function ChannelModelButton(props: {
  channels: ChannelInfo[]
  selectedChannelId: string
  selectedModelId: string
  disabled: boolean
  onSelectChannel: (id: string) => void
  onSelectModel: (id: string) => void
}) {
  const ch = props.channels.find(c => c.id === props.selectedChannelId)
  const label = ch ? (ch.models.find(m => m.id === props.selectedModelId)?.name || ch.name) : '请选择渠道'
  const [open, setOpen] = useState(false)
  return (
    <div className="relative">
      <button
        type="button"
        disabled={props.disabled}
        onClick={() => setOpen(o => !o)}
        className="grid size-[36px] shrink-0 place-items-center rounded-full text-[11px] font-semibold text-foreground/70 hover:bg-accent-foreground/[0.06] hover:text-foreground transition-colors disabled:cursor-not-allowed disabled:opacity-40"
        title={label}
      >
        {ch ? getChannelInitial(ch.name) : '?'}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="fixed bottom-20 left-3 z-50 w-64 rounded-xl border border-border bg-popover p-2 shadow-lg md:left-8">
            <div className="px-2 py-1 text-[11px] text-muted-foreground">渠道</div>
            <div className="max-h-40 overflow-y-auto space-y-0.5">
              {props.channels.map(c => (
                <button key={c.id} onClick={() => { props.onSelectChannel(c.id); setOpen(false) }}
                  className={`w-full rounded-md px-2 py-1.5 text-left text-[13px] ${c.id === props.selectedChannelId ? 'bg-accent' : 'hover:bg-accent/60'}`}>
                  {c.name}
                </button>
              ))}
            </div>
            {ch && ch.models.length > 0 && (
              <>
                <div className="px-2 pt-2 pb-1 text-[11px] text-muted-foreground">模型</div>
                <div className="max-h-40 overflow-y-auto space-y-0.5">
                  {ch.models.map(m => (
                    <button key={m.id} onClick={() => { props.onSelectModel(m.id); setOpen(false) }}
                      className={`w-full rounded-md px-2 py-1.5 text-left text-[13px] ${m.id === props.selectedModelId ? 'bg-accent' : 'hover:bg-accent/60'}`}>
                      {m.name}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </>
      )}
    </div>
  )
}
function getChannelInitial(name: string): string {
  return (name || '?').trim().slice(0, 1).toUpperCase() || '?'
}

function extractContextUsage(message: SDKMessage): Partial<{ inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number; contextWindow: number }> | null {
  const raw = message as unknown as { message?: { usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } }; usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }; contextWindow?: number }
  const usage = raw.message?.usage || raw.usage
  if (!usage) return null
  const cacheReadTokens = usage.cache_read_input_tokens ?? 0
  const cacheCreationTokens = usage.cache_creation_input_tokens ?? 0
  const inputTokens = (usage.input_tokens ?? 0) + cacheReadTokens + cacheCreationTokens
  if (!inputTokens) return null
  return { inputTokens, outputTokens: usage.output_tokens ?? 0, cacheReadTokens, cacheCreationTokens, ...(raw.contextWindow ? { contextWindow: raw.contextWindow } : {}) }
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error || new Error('无法读取文件'))
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '')
    reader.readAsDataURL(file)
  })
}

function permissionModeLabel(mode?: string): string {
  if (mode === 'plan') return '计划模式'
  if (mode === 'bypassPermissions') return '自动审批'
  return '默认权限'
}

function RuntimeTool({ runtime, disabled, onChange }: { runtime: 'claude' | 'pi'; disabled: boolean; onChange: (runtime: 'claude' | 'pi') => void }): React.ReactElement {
  const [open, setOpen] = useState(false)
  return <div className="relative"><Tooltip><TooltipTrigger asChild><Button type="button" variant="ghost" size="icon" className="size-[36px] rounded-full text-foreground/60" disabled={disabled} onClick={() => setOpen(!open)}><Brain className="size-[17px]" /></Button></TooltipTrigger><TooltipContent side="top"><p>{runtime === 'pi' ? 'Pi 运行时' : 'Claude 运行时'}</p></TooltipContent></Tooltip>{open && <><button type="button" className="fixed inset-0 z-40" aria-label="关闭运行时选择" onClick={() => setOpen(false)} /><div className="fixed bottom-20 left-14 z-50 w-40 rounded-xl border border-border bg-popover p-1.5 shadow-lg">{(['claude', 'pi'] as const).map(item => <button key={item} type="button" onClick={() => { onChange(item); setOpen(false) }} className={`w-full rounded-md px-2 py-2 text-left text-xs ${runtime === item ? 'bg-accent font-medium' : 'hover:bg-accent/60'}`}>{item === 'claude' ? 'Claude' : 'Pi'}</button>)}</div></>}</div>
}

function PermissionModeTool({ mode, disabled, onChange }: { mode?: string; disabled: boolean; onChange: (mode: 'auto' | 'plan' | 'bypassPermissions') => void }): React.ReactElement {
  const [open, setOpen] = useState(false)
  const options: Array<['auto' | 'plan' | 'bypassPermissions', string]> = [['auto', '默认权限'], ['plan', '计划模式'], ['bypassPermissions', '自动审批']]
  return <div className="relative"><Tooltip><TooltipTrigger asChild><Button type="button" variant="ghost" size="icon" className="size-[36px] rounded-full text-foreground/60" disabled={disabled} onClick={() => setOpen(!open)}><ShieldCheck className="size-[17px]" /></Button></TooltipTrigger><TooltipContent side="top"><p>{permissionModeLabel(mode)}</p></TooltipContent></Tooltip>{open && <><button type="button" className="fixed inset-0 z-40" aria-label="关闭权限模式选择" onClick={() => setOpen(false)} /><div className="fixed bottom-20 left-24 z-50 w-40 rounded-xl border border-border bg-popover p-1.5 shadow-lg">{options.map(([value, label]) => <button key={value} type="button" onClick={() => { onChange(value); setOpen(false) }} className={`w-full rounded-md px-2 py-2 text-left text-xs ${mode === value ? 'bg-accent font-medium' : 'hover:bg-accent/60'}`}>{label}</button>)}</div></>}</div>
}

function RemoteUnavailableTool({ icon, label, description }: { icon: React.ReactNode; label: string; description: string }): React.ReactElement {
  const [open, setOpen] = useState(false)
  return (
    <div className="relative">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button type="button" variant="ghost" size="icon" className="size-[36px] shrink-0 rounded-full text-foreground/30 hover:text-foreground/50" onClick={() => setOpen(value => !value)} aria-label={`${label}（未接入）`}>
            {icon}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top"><p>{label} · 未接入</p></TooltipContent>
      </Tooltip>
      {open && <>
        <button type="button" className="fixed inset-0 z-40 cursor-default" aria-label={`关闭${label}说明`} onClick={() => setOpen(false)} />
        <div className="absolute bottom-full left-0 z-50 mb-2 w-64 rounded-xl border border-border bg-popover p-3 text-xs shadow-lg">
          <div className="font-medium text-foreground">{label}</div>
          <p className="mt-1 leading-5 text-muted-foreground">{description}</p>
        </div>
      </>}
    </div>
  )
}

// ===== 平板会话侧栏（对齐桌面 LeftSidebar 的会话层次、尺寸与选中语义） =====
function formatRelativeUpdatedAt(updatedAt: number, now: number): string {
  const diff = Math.max(0, now - updatedAt)
  const minute = 60_000, hour = 60 * minute, day = 24 * hour, month = 30 * day, year = 365 * day
  if (diff < minute) return '刚刚'
  if (diff < hour) return `${Math.max(1, Math.floor(diff / minute))} 分钟`
  if (diff < day) return `${Math.floor(diff / hour)} 小时`
  if (diff < month) return `${Math.floor(diff / day)} 天`
  if (diff < year) return `${Math.floor(diff / month)} 月`
  return `${Math.floor(diff / year)} 年`
}
interface SessionTreeItem { session: SessionInfo; childSessions: SessionInfo[] }

// 严格沿用桌面语义：只有带 sourceDelegationId、同属列表且父会话存在的记录才折叠为子 Agent 对话。
// 其他历史/异常记录仍保持根节点，绝不让会话在平板侧栏中消失。
function buildSessionTrees(sessions: SessionInfo[]): SessionTreeItem[] {
  const ids = new Set(sessions.map((session) => session.id))
  const childrenByParent = new Map<string, SessionInfo[]>()
  const roots: SessionInfo[] = []
  for (const session of sessions) {
    if (session.parentSessionId && session.sourceDelegationId && ids.has(session.parentSessionId)) {
      const children = childrenByParent.get(session.parentSessionId) ?? []
      children.push(session)
      childrenByParent.set(session.parentSessionId, children)
    } else {
      roots.push(session)
    }
  }
  return roots.map((session) => ({
    session,
    childSessions: (childrenByParent.get(session.id) ?? []).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)),
  }))
}

function groupSessionTreesByDate(sessions: SessionInfo[]): Array<{ label: string; items: SessionTreeItem[] }> {
  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const yesterdayStart = todayStart - 86_400_000
  const today: SessionTreeItem[] = [], yesterday: SessionTreeItem[] = [], earlier: SessionTreeItem[] = []
  for (const item of buildSessionTrees(sessions)) {
    const updatedAt = item.session.updatedAt ?? Date.now()
    if (updatedAt >= todayStart) today.push(item)
    else if (updatedAt >= yesterdayStart) yesterday.push(item)
    else earlier.push(item)
  }
  const groups: Array<{ label: string; items: SessionTreeItem[] }> = []
  if (today.length) groups.push({ label: '今天', items: today })
  if (yesterday.length) groups.push({ label: '昨天', items: yesterday })
  if (earlier.length) groups.push({ label: '更早', items: earlier })
  return groups
}

// remote-service 当前只提供 Agent 会话列表；不渲染 Chat、搜索、规划、技能、设置、积分或项目管理等
// 没有对应协议的桌面入口，避免在平板上制造“可点但无效果”的伪按钮。
function Sidebar(props: {
  sessions: SessionInfo[]
  currentSessionId: string | null
  mobileOpen: boolean
  onDismiss: () => void
  onOpen: (id: string, title?: string) => void
  onCreate: () => void
  onLogout: () => void
}): React.ReactElement {
  const now = Date.now()
  const sessionGroups = groupSessionTreesByDate(props.sessions)
  const navigation = (
    <aside className="flex h-full w-[288px] shrink-0 flex-col border-r border-border/70 bg-sidebar-surface md:rounded-[24px] md:border md:shadow-xl">
      <div className="flex h-14 shrink-0 items-center gap-2 px-3">
        <div className="flex min-w-0 flex-1 items-center gap-2 px-2 text-[15px] font-semibold text-foreground">
          <Bot className="size-4 shrink-0 text-foreground/60" />
          <span className="truncate">Agent</span>
        </div>
        <Button type="button" variant="ghost" size="icon" onClick={props.onDismiss} className="size-9 shrink-0 rounded-[10px] text-foreground/55 hover:bg-foreground/[0.06] md:hidden" aria-label="关闭导航"><X className="size-4" /></Button>
      </div>
      <div className="flex gap-2 px-3 pb-3">
        <button type="button" onClick={props.onCreate} className="flex h-10 flex-1 items-center gap-2 rounded-[10px] border border-border/60 bg-primary/5 px-3 text-[13px] font-medium text-foreground/75 transition-colors hover:border-border hover:bg-primary/10 hover:text-foreground">
          <Plus className="size-4" />新建会话
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden border-t border-border/70 pt-3">
        <div className="px-5 pb-2 text-[12px] font-semibold text-foreground/45">会话</div>
        <div className="tablet-scrollbar-hidden min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-3">
          {props.sessions.length === 0 ? (
            <div className="px-3 py-8 text-center text-xs text-muted-foreground">暂无会话</div>
          ) : sessionGroups.map((group) => (
            <div key={group.label} className="mb-2">
              <div className="select-none px-3 pb-1 pt-2 text-[11px] font-medium text-foreground/40">{group.label}</div>
              <div className="flex flex-col gap-0.5">
                {group.items.map((item) => <React.Fragment key={item.session.id}>
                  <SessionRow s={item.session} active={item.session.id === props.currentSessionId} now={now} onOpen={() => props.onOpen(item.session.id, item.session.title)} />
                  {item.childSessions.length > 0 && <div className="ml-4 border-l border-foreground/10 pl-2">
                    {item.childSessions.map((child) => <SessionRow key={child.id} s={child} active={child.id === props.currentSessionId} now={now} child onOpen={() => props.onOpen(child.id, child.title)} />)}
                  </div>}
                </React.Fragment>)}
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="shrink-0 border-t border-border/70 p-3">
        <button type="button" onClick={props.onLogout} className="flex w-full items-center gap-3 rounded-[10px] px-3 py-2 text-left text-[13px] text-foreground/65 transition-colors hover:bg-foreground/[0.04] hover:text-foreground" aria-label="退出平板连接">
          <LogOut className="size-4" />
          <span>退出</span>
        </button>
      </div>
    </aside>
  )
  return (
    <>
      <div className="hidden h-full shrink-0 md:flex">{navigation}</div>
      <div className={`fixed inset-0 z-50 md:hidden ${props.mobileOpen ? 'pointer-events-auto' : 'pointer-events-none'}`} aria-hidden={!props.mobileOpen}>
        <button type="button" className={`absolute inset-0 z-0 bg-black/40 transition-opacity duration-200 ${props.mobileOpen ? 'opacity-100' : 'opacity-0'}`} onClick={props.onDismiss} aria-label="关闭会话导航" tabIndex={props.mobileOpen ? 0 : -1} />
        <div className={`absolute inset-y-0 left-0 z-10 touch-pan-y transition-transform duration-200 ease-out ${props.mobileOpen ? 'translate-x-0' : '-translate-x-full'}`}>
          {navigation}
        </div>
      </div>
    </>
  )
}

function SessionRow(props: { s: SessionInfo; active: boolean; now: number; child?: boolean; onOpen: () => void }): React.ReactElement {
  const { s, active, child = false } = props
  return (
    <button type="button" onClick={props.onOpen} className={`group relative flex w-full items-center gap-1.5 rounded-md py-1.5 ${child ? 'pl-2 pr-1.5 text-[12px]' : 'pl-2.5 pr-2 text-[13px]'} text-left transition-colors duration-100 ${active ? 'bg-foreground/[0.08]' : 'hover:bg-foreground/[0.03]'}`}>
      {s.active && <span className="pointer-events-none absolute inset-y-0 left-0 w-[3px] rounded-l-md bg-blue-500" />}
      <span className={`min-w-0 flex-1 truncate leading-[18px] ${active ? 'text-foreground' : 'text-foreground/80'}`}>{s.title || '未命名会话'}</span>
      <span className="shrink-0 text-[11px] text-foreground/35 transition-colors group-hover:text-foreground/50">{formatRelativeUpdatedAt(s.updatedAt ?? props.now, props.now)}</span>
    </button>
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
