import * as React from 'react'
import { useAtomValue, useSetAtom, useStore } from 'jotai'
import { ChevronDown, ChevronRight, ExternalLink, GitBranch } from 'lucide-react'
import type { SDKMessage } from '@profer/shared'
import {
  agentMessageRefreshAtom,
  agentSDKMessagesCacheAtom,
  agentSessionPathMapAtom,
  agentSessionStreamingStateAtomFamily,
  agentSessionsAtom,
  liveMessagesAtomFamily,
  setSessionMessagesCache,
} from '@/atoms/agent-atoms'
import { AgentSessionProvider } from '@/contexts/session-context'
import { useOpenSession } from '@/hooks/useOpenSession'
import { currentDelegationExecutions, type CurrentDelegationExecution } from '@/lib/current-delegation-projection'
import { ScrollRegion } from '@/components/ai-elements/scroll-region'
import { AgentMessages } from './AgentMessages'
import { normalizeAgentHistoryResult } from './agent-history-pagination'
import { DelegationRuntimeBar } from './DelegationRuntimeBar'
import { resolveDelegationRuntimeDisplay } from '@/domains/agent-runtime/delegation-runtime-display'

const HISTORY_PAGE_SIZE = 100

/** 子记录有自己的消息、游标和实时订阅；从不写入父会话消息或运行状态。 */
function ExecutionTranscript({ execution }: { execution: CurrentDelegationExecution }): React.ReactElement {
  const id = execution.executionSessionId
  const store = useStore()
  const setCache = useSetAtom(agentSDKMessagesCacheAtom)
  const streamState = useAtomValue(agentSessionStreamingStateAtomFamily(id))
  const liveMessages = useAtomValue(liveMessagesAtomFamily(id))
  const paths = useAtomValue(agentSessionPathMapAtom)
  const refreshVersions = useAtomValue(agentMessageRefreshAtom)
  const refreshVersion = refreshVersions.get(id) ?? 0
  const [messages, setMessages] = React.useState<SDKMessage[]>(() => store.get(agentSDKMessagesCacheAtom).get(id) ?? [])
  const [loaded, setLoaded] = React.useState(() => store.get(agentSDKMessagesCacheAtom).has(id))
  const [error, setError] = React.useState<string>()
  const [sessionPath, setSessionPath] = React.useState<string | null>(() => paths.get(id) ?? null)
  const [retry, setRetry] = React.useState(0)
  const [cursor, setCursor] = React.useState({ startIndex: 0, hasMore: false })
  const [loadingEarlier, setLoadingEarlier] = React.useState(false)
  const generation = React.useRef(0)
  const cursorRef = React.useRef(cursor)
  cursorRef.current = cursor
  const messagesRef = React.useRef(messages)
  messagesRef.current = messages

  React.useEffect(() => {
    const current = ++generation.current
    setError(undefined)
    setLoadingEarlier(false)
    void window.electronAPI.getAgentSessionSDKMessages(id, { tail: Math.max(HISTORY_PAGE_SIZE, messagesRef.current.length) })
      .then((value) => {
        if (generation.current !== current) return
        const page = normalizeAgentHistoryResult(value, { startIndex: 0, hasMore: false }, false)
        setMessages(page.messages)
        setCursor(page.cursor)
        setLoaded(true)
        setCache(previous => setSessionMessagesCache(previous, id, page.messages))
      })
      .catch((reason: unknown) => {
        if (generation.current !== current) return
        setError(reason instanceof Error ? reason.message : '无法加载执行记录')
        setLoaded(true)
      })
    return () => { generation.current += 1 }
  }, [id, refreshVersion, execution.status, retry, setCache])

  React.useEffect(() => {
    const cached = paths.get(id)
    if (cached) { setSessionPath(cached); return }
    if (!execution.session?.workspaceId) return
    let active = true
    void window.electronAPI.getAgentSessionPath(execution.session.workspaceId, id)
      .then(path => { if (active) setSessionPath(path) })
      .catch(() => {})
    return () => { active = false }
  }, [id, execution.session?.workspaceId, paths])

  const loadEarlier = React.useCallback(() => {
    if (loadingEarlier || !cursorRef.current.hasMore) return
    const current = generation.current
    setLoadingEarlier(true)
    setError(undefined)
    void window.electronAPI.getAgentSessionSDKMessages(id, { tail: HISTORY_PAGE_SIZE, before: cursorRef.current.startIndex })
      .then((value) => {
        if (generation.current !== current) return
        const page = normalizeAgentHistoryResult(value, cursorRef.current, false)
        const next = [...page.messages, ...messagesRef.current]
        setMessages(next)
        setCursor(page.cursor)
        setCache(previous => setSessionMessagesCache(previous, id, next))
      })
      .catch((reason: unknown) => {
        if (generation.current === current) setError(reason instanceof Error ? reason.message : '无法加载更早记录')
      })
      .finally(() => { if (generation.current === current) setLoadingEarlier(false) })
  }, [id, loadingEarlier, setCache])

  return (
    <AgentSessionProvider sessionId={id}>
      <div className="flex h-[min(24rem,32vh)] min-h-0 flex-col" data-delegation-transcript-session={id}>
        {error && <div role="alert" className="flex items-center gap-2 px-3 py-2 text-xs text-destructive"><span className="min-w-0 flex-1 break-words">无法加载执行记录：{error}</span><button type="button" className="shrink-0 underline underline-offset-2" onClick={() => setRetry(value => value + 1)}>重试</button></div>}
        {!loaded && liveMessages.length === 0 && <div role="status" className="px-3 py-3 text-xs text-muted-foreground">正在加载执行记录…</div>}
        <AgentMessages sessionId={id} sessionModelId={execution.session?.modelId} agentRuntime={execution.session?.agentRuntime} messagesLoaded={loaded} persistedSDKMessages={messages} liveMessages={liveMessages} streaming={streamState?.running ?? false} streamState={streamState} sessionPath={sessionPath} attachedDirs={execution.session?.attachedDirectories} stoppedByUser={execution.session?.stoppedByUser} onLoadEarlierHistory={cursor.hasMore ? loadEarlier : undefined} historyMoreAvailable={cursor.hasMore} historyLoadingEarlier={loadingEarlier} explorationEnabled={false} />
      </div>
    </AgentSessionProvider>
  )
}

function ExecutionStatus({ execution }: { execution: CurrentDelegationExecution }): React.ReactElement {
  const stream = useAtomValue(agentSessionStreamingStateAtomFamily(execution.executionSessionId))
  const display = resolveDelegationRuntimeDisplay({
    parentSessionId: execution.session?.parentSessionId ?? 'projection', sourceDelegationId: execution.taskId,
    delegationStatus: execution.status, liveRunning: stream?.running ?? false, liveStartedAt: stream?.startedAt,
    sessionUpdatedAt: execution.session?.updatedAt ?? execution.createdAt,
  })
  return <DelegationRuntimeBar display={display} />
}

/** 仅保留给测试/过渡调用方；父会话视图不再挂载这个展开面板。 */
export function CurrentDelegationPanel({ sessionId, messages }: { sessionId: string; messages: readonly SDKMessage[] }): React.ReactElement | null {
  const sessions = useAtomValue(agentSessionsAtom)
  const openSession = useOpenSession()
  const executions = React.useMemo(() => currentDelegationExecutions(sessionId, sessions, messages), [sessionId, sessions, messages])
  const [selectedId, setSelectedId] = React.useState<string>()
  const selected = executions.find(execution => execution.executionSessionId === selectedId)
  if (executions.length === 0) return null
  return <section className="min-h-0 shrink-0 rounded-xl bg-muted/35 mx-3 mb-2" aria-label="当前会话委派记录" data-current-delegation-parent={sessionId}>
    <div className="px-3 pt-2 text-[11px] font-medium text-muted-foreground">当前会话任务 · {executions.length}</div>
    <ScrollRegion className="max-h-28 overflow-y-auto px-3 py-1.5">{executions.map(execution => <div key={execution.executionSessionId} className="flex min-w-0 items-center gap-2" data-delegation-task-id={execution.taskId}>
      <button type="button" className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md py-1 text-left text-xs hover:text-primary" aria-expanded={execution.executionSessionId === selectedId} onClick={() => setSelectedId(execution.executionSessionId === selectedId ? undefined : execution.executionSessionId)}><GitBranch className="size-3 shrink-0 text-primary/70" /><span className="truncate">{execution.title}</span></button>
      <ExecutionStatus execution={execution} />
      <button type="button" className="shrink-0 rounded p-1 text-muted-foreground hover:text-foreground" aria-label={`打开完整执行会话：${execution.title}`} title="打开完整执行会话" onClick={() => openSession('agent', execution.executionSessionId, execution.title, sessionId)}><ExternalLink className="size-3.5" /></button>
    </div>)}</ScrollRegion>
    {selected && <div role="region" aria-label={`${selected.title}的执行记录`}><ExecutionTranscript key={selected.executionSessionId} execution={selected} /></div>}
  </section>
}
