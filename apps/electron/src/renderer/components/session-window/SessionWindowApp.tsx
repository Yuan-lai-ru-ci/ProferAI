/**
 * SessionWindowApp — 独立会话窗口的轻量壳。
 *
 * 只渲染一个被拆出的 chat / agent 会话，不复制左侧会话列表、顶栏 TabBar
 * 和主界面的全局初始化器。窗口顶部保留一条可拖拽的标题条与窗口控制。
 */

import * as React from 'react'
import { useAtomValue, useStore } from 'jotai'
import { Bot, CornerUpLeft, MessageSquare, X } from 'lucide-react'
import { AgentView } from '@/components/agent/AgentView'
import { ChatView } from '@/components/chat/ChatView'
import { TabErrorBoundary } from '@/components/tabs/TabErrorBoundary'
import { WindowControls } from '@/components/WindowControls'
import { detectIsMac, detectIsWindows } from '@profer/ui'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { resolveWindowControlsRightInset } from '@/lib/window-controls-layout'
import { getWindowBootstrap } from '@/lib/window-bootstrap'
import {
  agentSessionDraftHtmlAtom,
  agentSessionDraftsAtom,
  agentSessionsAtom,
  agentWorkspacesAtom,
  currentAgentSessionIdAtom,
  currentAgentWorkspaceIdAtom,
} from '@/atoms/agent-atoms'
import {
  conversationDraftsAtom,
  conversationsAtom,
  currentConversationIdAtom,
} from '@/atoms/chat-atoms'
import { appModeAtom } from '@/atoms/app-mode'
import { userProfileAtom } from '@/atoms/user-profile'
import { activeTabIdAtom, tabsAtom, type TabItem } from '@/atoms/tab-atoms'

export type SessionWindowType = 'chat' | 'agent'

interface SessionWindowAppProps {
  sessionId: string
  type: SessionWindowType
}

export function SessionWindowApp({ sessionId, type }: SessionWindowAppProps): React.ReactElement {
  const store = useStore()
  const sessions = useAtomValue(agentSessionsAtom)
  const conversations = useAtomValue(conversationsAtom)
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const [loaded, setLoaded] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [initialMeta, setInitialMeta] = React.useState<{ title: string; workspaceId?: string } | null>(null)
  const seededRef = React.useRef(false)

  React.useEffect(() => {
    // 会话窗口不挂左侧栏，用户头像/名称需要单独水合。
    void window.electronAPI.getUserProfile()
      .then((profile) => store.set(userProfileAtom, profile))
      .catch(() => {})
  }, [store])

  React.useEffect(() => {
    let cancelled = false
    void Promise.all([
      window.electronAPI.listConversations(true),
      window.electronAPI.listAgentSessions(true),
      getWindowBootstrap(),
    ]).then(([loadedConversations, loadedSessions, bootstrap]) => {
      if (cancelled) return
      store.set(conversationsAtom, loadedConversations)
      store.set(agentSessionsAtom, loadedSessions)

      const meta = type === 'agent'
        ? loadedSessions.find((session) => session.id === sessionId)
        : loadedConversations.find((conversation) => conversation.id === sessionId)
      if (!meta) {
        setError('会话不存在或已被删除')
        return
      }
      setInitialMeta({
        title: meta.title,
        ...('workspaceId' in meta && meta.workspaceId ? { workspaceId: meta.workspaceId } : {}),
      })
      if (seededRef.current) return
      seededRef.current = true

      const parentSessionId = 'parentSessionId' in meta
        ? meta.parentSessionId ?? meta.explorationParentSessionId
        : undefined
      const tab: TabItem = {
        id: sessionId,
        type,
        sessionId,
        title: meta.title,
        ...(parentSessionId ? { parentSessionId } : {}),
      }
      store.set(tabsAtom, [tab])
      store.set(activeTabIdAtom, sessionId)

      if (type === 'agent') {
        store.set(appModeAtom, 'agent')
        store.set(currentAgentSessionIdAtom, sessionId)
        store.set(currentConversationIdAtom, null)
        const workspaceId = 'workspaceId' in meta ? meta.workspaceId : undefined
        if (workspaceId) store.set(currentAgentWorkspaceIdAtom, workspaceId)
      } else {
        store.set(appModeAtom, 'chat')
        store.set(currentConversationIdAtom, sessionId)
        store.set(currentAgentSessionIdAtom, null)
      }

      const draft = bootstrap.initialTab?.draft
      if (draft) {
        if (type === 'agent') {
          store.set(agentSessionDraftsAtom, (previous) => new Map(previous).set(sessionId, draft))
        } else {
          store.set(conversationDraftsAtom, (previous) => new Map(previous).set(sessionId, draft))
        }
      }
      // 富文本草稿单独恢复：引用胶囊、编号和原文侧标记都依赖它，不能只搬纯文本。
      const draftHtml = bootstrap.initialTab?.draftHtml
      if (type === 'agent' && draftHtml) {
        store.set(agentSessionDraftHtmlAtom, (previous) => new Map(previous).set(sessionId, draftHtml))
      }
    }).catch((loadError) => {
      if (cancelled) return
      console.error('[SessionWindow] 加载会话失败:', loadError)
      setError('加载会话失败')
    }).finally(() => {
      if (!cancelled) setLoaded(true)
    })
    return () => { cancelled = true }
  }, [sessionId, type, store])

  const meta = type === 'agent'
    ? sessions.find((session) => session.id === sessionId)
    : conversations.find((conversation) => conversation.id === sessionId)
  const title = meta?.title || initialMeta?.title || 'Profer'
  const workspaceId = (meta && 'workspaceId' in meta ? meta.workspaceId : undefined) ?? initialMeta?.workspaceId
  const workspaceName = type === 'agent' && workspaceId
    ? workspaces.find((workspace) => workspace.id === workspaceId)?.name
    : undefined

  const handleReturnToMain = React.useCallback((): void => {
    const tab = store.get(tabsAtom).find((item) => item.id === sessionId)
    const draft = type === 'agent'
      ? store.get(agentSessionDraftsAtom).get(sessionId)
      : store.get(conversationDraftsAtom).get(sessionId)
    const draftHtml = type === 'agent'
      ? store.get(agentSessionDraftHtmlAtom).get(sessionId)
      : undefined
    void window.electronAPI.returnTabToMain({
      id: tab?.id ?? sessionId,
      type,
      sessionId,
      title: meta?.title ?? initialMeta?.title ?? '会话',
      ...(tab?.parentSessionId ? { parentSessionId: tab.parentSessionId } : {}),
      ...(draft ? { draft } : {}),
      ...(draftHtml ? { draftHtml } : {}),
    }).then((result) => {
      if (!result.ok) toast.error(result.error ?? '移回主窗口失败')
    }).catch((error: unknown) => {
      console.error('[SessionWindow] 移回主窗口失败:', error)
      toast.error('移回主窗口失败')
    })
  }, [initialMeta?.title, meta?.title, sessionId, store, type])

  React.useEffect(() => {
    document.title = title
  }, [title])

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <SessionWindowHeader title={title} type={type} workspaceName={workspaceName} onReturnToMain={handleReturnToMain} />
      <main className="min-h-0 flex-1 overflow-hidden">
        {!loaded ? (
          <CenteredState>正在打开会话…</CenteredState>
        ) : error || !initialMeta ? (
          <SessionWindowError message={error ?? '会话不存在或已被删除'} />
        ) : type === 'agent' ? (
          <TabErrorBoundary sessionId={sessionId}>
            <AgentView sessionId={sessionId} standalone />
          </TabErrorBoundary>
        ) : (
          <TabErrorBoundary sessionId={sessionId}>
            <ChatView conversationId={sessionId} standalone />
          </TabErrorBoundary>
        )}
      </main>
    </div>
  )
}

function SessionWindowHeader({
  title,
  type,
  workspaceName,
  onReturnToMain,
}: {
  title: string
  type: SessionWindowType
  workspaceName?: string
  onReturnToMain: () => void
}): React.ReactElement {
  const isMac = React.useMemo(() => detectIsMac(), [])
  const isWindows = React.useMemo(() => detectIsWindows(), [])

  return (
    <header
      className={cn(
        'relative flex h-10 shrink-0 items-center gap-2 border-b border-border/60 bg-background/80 px-3',
        // macOS 使用 hiddenInset 原生交通灯，给左上角留出安全区。
        isMac && 'pl-[78px]',
      )}
    >
      {/* Windows 高 DPI 下 drag 矩形不能压到窗口按钮上，否则会出现「点击无效/需要双击」。
          这里沿用主窗口的做法：独立拖拽层在按钮安全宽度前结束，内容层只负责展示。 */}
      <div
        className="titlebar-drag-region absolute inset-y-0"
        style={{
          left: isMac ? 78 : 0,
          right: resolveWindowControlsRightInset(isWindows),
        }}
        aria-hidden="true"
      />
      {type === 'agent'
        ? <Bot className="relative z-10 size-3.5 shrink-0 pointer-events-none text-muted-foreground" aria-hidden="true" />
        : <MessageSquare className="relative z-10 size-3.5 shrink-0 pointer-events-none text-muted-foreground" aria-hidden="true" />}
      <span className="relative z-10 min-w-0 truncate text-xs font-medium pointer-events-none">{title}</span>
      {workspaceName && (
        <span className="relative z-10 shrink-0 max-w-[140px] truncate rounded-full bg-primary/10 px-1.5 py-0 text-[10px] font-medium text-primary pointer-events-none">
          {workspaceName}
        </span>
      )}
      <div className="relative z-30 ml-auto flex items-center gap-1 titlebar-no-drag">
        <button
          type="button"
          className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
          title="移回主窗口"
          aria-label="移回主窗口"
          onClick={onReturnToMain}
        >
          <CornerUpLeft className="size-3.5" aria-hidden="true" />
          <span className="hidden sm:inline">移回主窗口</span>
        </button>
        {isWindows && <WindowControls variant="inline" />}
      </div>
    </header>
  )
}

function CenteredState({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <div className="flex h-full items-center justify-center px-6 text-xs text-muted-foreground">
      {children}
    </div>
  )
}

function SessionWindowError({ message }: { message: string }): React.ReactElement {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <p className="text-sm text-foreground">{message}</p>
      <button
        type="button"
        className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-3 text-xs text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
        onClick={() => { void window.electronAPI.windowClose() }}
      >
        <X className="size-3.5" aria-hidden="true" />
        关闭窗口
      </button>
    </div>
  )
}
