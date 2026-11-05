/**
 * GoalOverviewList — 规划中心的跨会话 Goal 总览
 *
 * 之前 Goal 只存在于「打开的那个会话」的状态栏里：用户无法回答「我有哪些目标在跑、
 * 卡住、刚完成」。这里把活跃槽位与最近归档并列展示，并给出跳转 / 恢复 / 停止 / 清除。
 *
 * 数据来源分两路：
 * - 当前：`agentGoalsAtom`（GOAL_EVENT 实时推送 + 启动水合）+ `agentSessionsAtom` 的会话标题；
 * - 历史：`getGoalOverview` 的 history（打开分区或状态变化时重读）。
 * 终态（completed/stopped/failed）但尚未清除的 Goal 归到「最近结束」，因为它们的槽位还占着、
 * 但已经不是进行中的目标；从 `agentGoalsAtom` 拿到的条目没有 sessionTitle，必须从会话索引补，
 * 否则会全部渲染成「会话已删除」。
 */

import * as React from 'react'
import { useAtomValue } from 'jotai'
import { AlertTriangle, Check, CircleSlash, Loader2, Pause, Play, Square, Target } from 'lucide-react'
import { toast } from 'sonner'
import { getGoalActions, GOAL_REASON_LABELS, normalizeGoalReason } from '@profer/shared'
import type { AgentGoalOverviewEntry, AgentGoalState } from '@profer/shared'
import { agentGoalsAtom } from '@/atoms/goal-atoms'
import { agentSessionsAtom, agentWorkspacesAtom } from '@/atoms/agent-atoms'
import { cn } from '@/lib/utils'
import { getGoalElapsed, getGoalStatusLabel, isGoalRunning, needsGoalAttention } from '@/domains/goal/goal-display-policy'
import { formatTokens } from '@/lib/format-tokens'
import { useOpenSession } from '@/hooks/useOpenSession'

const STATUS_TONE: Record<AgentGoalState['status'], string> = {
  active: 'text-primary', stopping: 'text-muted-foreground', paused: 'text-muted-foreground',
  completed: 'text-success', blocked: 'text-warning', budget_limited: 'text-warning',
  failed: 'text-destructive', stopped: 'text-muted-foreground',
}

function StatusIcon({ status }: { status: AgentGoalState['status'] }): React.ReactElement {
  const cls = cn('size-4 shrink-0', STATUS_TONE[status])
  if (status === 'active' || status === 'stopping') return <Loader2 className={cn(cls, 'animate-spin')} aria-hidden="true" />
  if (status === 'completed') return <Check className={cls} aria-hidden="true" />
  if (status === 'blocked' || status === 'budget_limited') return <AlertTriangle className={cls} aria-hidden="true" />
  if (status === 'paused') return <Pause className={cls} aria-hidden="true" />
  if (status === 'failed') return <CircleSlash className={cls} aria-hidden="true" />
  return <Square className={cls} aria-hidden="true" />
}

function relativeTime(at: number, now: number): string {
  const diff = Math.max(0, now - at)
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return new Date(at).toLocaleDateString()
}

/** 一行预算摘要：只列出已设置维度的用量。 */
export function formatGoalBudgetUsage(goal: AgentGoalState): string {
  const parts: string[] = []
  if (goal.limits.maxIterations !== undefined) parts.push(`${goal.iteration}/${goal.limits.maxIterations} 轮`)
  if (goal.limits.maxDurationMs !== undefined) parts.push(`${Math.round((goal.elapsedMs ?? 0) / 60_000)}/${Math.round(goal.limits.maxDurationMs / 60_000)} 分钟`)
  if (goal.limits.maxTokens !== undefined) parts.push(`${formatTokens(goal.usage?.totalTokens ?? 0)}/${formatTokens(goal.limits.maxTokens)} tokens`)
  return parts.length > 0 ? parts.join(' · ') : '不限预算'
}

/** 终态摘要：优先展示模型给出的结论，其次停止原因。 */
export function goalOverviewSummary(goal: AgentGoalState): string {
  const reason = goal.reasonCode ?? normalizeGoalReason(goal.stopReason)
  if (goal.status === 'active' || goal.status === 'stopping') return goal.lastSummary || '执行中'
  if (goal.status === 'paused' && reason === 'user_pause') return GOAL_REASON_LABELS.user_pause
  // 已清除的目标 stopReason 就是 'cleared' 这类内部码，不能直接给用户看。
  const detail = goal.reasonDetail && goal.reasonDetail !== goal.stopReason ? goal.reasonDetail : undefined
  return goal.lastSummary || detail || GOAL_REASON_LABELS[reason]
}

/** 按状态分组排序：需要关注的在前，已结束的在后。 */
const STATUS_ORDER: Record<AgentGoalState['status'], number> = {
  blocked: 0, active: 1, stopping: 2, paused: 3, budget_limited: 4, failed: 5, stopped: 6, completed: 7,
}

export function sortGoalEntries(entries: AgentGoalOverviewEntry[]): AgentGoalOverviewEntry[] {
  return [...entries].sort((a, b) => {
    const byStatus = STATUS_ORDER[a.goal.status] - STATUS_ORDER[b.goal.status]
    return byStatus !== 0 ? byStatus : b.goal.updatedAt - a.goal.updatedAt
  })
}

/** 已经是终态、但还占着会话槽位的 Goal：不该再算「进行中」。 */
const TERMINAL_STATUSES: ReadonlySet<AgentGoalState['status']> = new Set(['completed', 'stopped', 'failed'])

/**
 * 把 live Goal 与归档 history 分成「进行中」和「最近结束」两段。
 * - 会话标题从会话索引补，live 条目不再一律显示「会话已删除」；
 * - 终态 live Goal 与归档同列（同 id 以 live 为准），否则「最近归档」永远是空的。
 */
export function buildGoalOverviewSections(
  liveGoals: Iterable<AgentGoalState>,
  history: AgentGoalOverviewEntry[],
  sessionTitles: Map<string, string | undefined>,
): { live: AgentGoalOverviewEntry[]; ended: AgentGoalOverviewEntry[] } {
  const live: AgentGoalOverviewEntry[] = []
  const ended: AgentGoalOverviewEntry[] = []
  for (const goal of liveGoals) {
    const entry: AgentGoalOverviewEntry = { goal, archived: false, sessionTitle: sessionTitles.get(goal.sessionId) }
    if (TERMINAL_STATUSES.has(goal.status)) ended.push(entry)
    else live.push(entry)
  }
  const endedIds = new Set(ended.map((entry) => entry.goal.id))
  const merged = [...ended, ...history.filter((entry) => !endedIds.has(entry.goal.id))]
    .sort((a, b) => b.goal.updatedAt - a.goal.updatedAt)
  return { live: sortGoalEntries(live), ended: merged }
}

/**
 * 按工作区把条目分组。
 *
 * 为什么必须分组：左侧栏是「项目 → 会话」的两层结构，Goal 总览原来把所有会话的
 * 目标压成一个平铺列表、只按状态排序，项目信息只剩卡片底部的灰字会话名。
 * 五六个项目并行时用户看不出「这条是哪个项目的」。
 *
 * 只有 1 个分组时不加分组层级（单项目用户不该为这个多一层噪音）。
 */
export function groupGoalEntriesByWorkspace(
  entries: AgentGoalOverviewEntry[],
  workspaceNames: Map<string, string>,
): Array<{ workspaceId: string | undefined; workspaceName: string; entries: AgentGoalOverviewEntry[] }> {
  const groups = new Map<string, { workspaceId: string | undefined; workspaceName: string; entries: AgentGoalOverviewEntry[] }>()
  for (const entry of entries) {
    const key = entry.workspaceId ?? '__orphan__'
    let group = groups.get(key)
    if (!group) {
      group = {
        workspaceId: entry.workspaceId,
        workspaceName: entry.workspaceId ? (workspaceNames.get(entry.workspaceId) ?? '未知项目') : '会话已删除',
        entries: [],
      }
      groups.set(key, group)
    }
    group.entries.push(entry)
  }
  if (groups.size <= 1) return [...groups.values()]
  // 组顺序：需要你介入的排前面，其次最近更新过的；孤儿组（会话已删）沉到最后。
  const attention = (group: { entries: AgentGoalOverviewEntry[] }): number =>
    group.entries.some((entry) => needsGoalAttention(entry.goal)) ? 0 : 1
  return [...groups.values()].sort((a, b) => {
    const byOrphan = (a.workspaceId ? 0 : 1) - (b.workspaceId ? 0 : 1)
    if (byOrphan !== 0) return byOrphan
    const byAttention = attention(a) - attention(b)
    if (byAttention !== 0) return byAttention
    const latest = (group: { entries: AgentGoalOverviewEntry[] }): number =>
      Math.max(0, ...group.entries.map((entry) => entry.goal.updatedAt))
    return latest(b) - latest(a)
  })
}

export function GoalOverviewList(): React.ReactElement {
  const liveGoals = useAtomValue(agentGoalsAtom)
  const sessions = useAtomValue(agentSessionsAtom)
  const openSession = useOpenSession()
  const [history, setHistory] = React.useState<AgentGoalOverviewEntry[]>([])
  const [overviewTitles, setOverviewTitles] = React.useState<Map<string, string | undefined>>(new Map())
  const [loading, setLoading] = React.useState(true)
  const [pendingId, setPendingId] = React.useState<string | null>(null)
  const [now, setNow] = React.useState(() => Date.now())

  // 会话索引尚未水合时，用 IPC 总览自带的标题兜底，避免瞬间闪一下「会话已删除」。
  const titleMap = React.useMemo(() => {
    const map = new Map<string, string | undefined>(overviewTitles)
    for (const session of sessions) if (session.title) map.set(session.id, session.title)
    return map
  }, [overviewTitles, sessions])
  const { live: liveEntries, ended: endedEntries } = React.useMemo(
    () => buildGoalOverviewSections(liveGoals.values(), history, titleMap),
    [liveGoals, history, titleMap],
  )
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const workspaceNames = React.useMemo(() => new Map(workspaces.map((workspace) => [workspace.id, workspace.name])), [workspaces])
  const liveGroups = React.useMemo(() => groupGoalEntriesByWorkspace(liveEntries, workspaceNames), [liveEntries, workspaceNames])
  const endedGroups = React.useMemo(() => groupGoalEntriesByWorkspace(endedEntries, workspaceNames), [endedEntries, workspaceNames])

  // 只在挂载或目标状态变化时重读归档；revision 每轮都会变，不能进依赖签名，
  // 否则运行中的 Goal 会让总览不停重读 goals.json 并闪烁「读取归档…」。
  const liveSignature = [...liveGoals.values()].map((goal) => `${goal.id}:${goal.status}`).sort().join('|')
  React.useEffect(() => {
    let active = true
    window.electronAPI.getGoalOverview()
      .then((overview) => {
        if (!active) return
        setHistory(overview.history)
        const titles = new Map<string, string | undefined>()
        for (const entry of [...overview.live, ...overview.history]) {
          if (entry.sessionTitle) titles.set(entry.goal.sessionId, entry.sessionTitle)
        }
        setOverviewTitles(titles)
      })
      .catch(() => { if (active) setHistory([]) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [liveSignature])

  React.useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [])

  const run = async (key: string, action: () => Promise<unknown>, success: string): Promise<void> => {
    if (pendingId) return
    setPendingId(key)
    try {
      await action()
      toast.success(success)
    } catch (error) {
      toast.error('Goal 操作失败', { description: error instanceof Error ? error.message : String(error) })
    } finally {
      setPendingId(null)
    }
  }

  const renderEntry = (entry: AgentGoalOverviewEntry): React.ReactElement => {
    const { goal, archived } = entry
    const actions = getGoalActions(goal)
    const title = entry.sessionTitle || '会话已删除'
    const canOpen = entry.sessionTitle !== undefined
    const busy = pendingId === goal.id
    return (
      <li key={`${archived ? 'h' : 'l'}:${goal.id}`} className="flex flex-col gap-2 rounded-xl border border-surface-border/45 bg-surface-raised/60 px-3 py-2.5">
        <div className="flex items-start gap-2">
          <StatusIcon status={goal.status} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span className={cn('text-sm font-medium', STATUS_TONE[goal.status])}>{getGoalStatusLabel(goal, { askUser: 0, permission: 0 }, now)}</span>
              <span className="text-xs text-muted-foreground">第 {goal.iteration} 轮 · {formatGoalBudgetUsage(goal)}</span>
              <span className="text-xs text-muted-foreground/70">{relativeTime(goal.updatedAt, now)}</span>
            </div>
            <p className="mt-0.5 line-clamp-2 text-sm text-foreground/90" title={goal.goal}>{goal.goal}</p>
            <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground" title={goalOverviewSummary(goal)}>{goalOverviewSummary(goal)}</p>
            {!archived && goal.idleCheckin?.nextAt !== undefined && (
              <p className="mt-0.5 text-[11px] text-primary/80">
                空闲中，{Math.max(0, Math.ceil((goal.idleCheckin.nextAt - now) / 60_000))} 分钟后自动继续
              </p>
            )}
            {!archived && goal.idleCheckin?.paused && (
              <p className="mt-0.5 text-[11px] text-muted-foreground">空闲自检已暂停（连续 {goal.idleCheckin.count} 次），发消息即可继续</p>
            )}
            <p className="mt-1 text-[11px] text-muted-foreground/70">
              {canOpen
                ? <button type="button" className="hover:text-foreground hover:underline" onClick={() => openSession('agent', goal.sessionId, entry.sessionTitle!)}>{title}</button>
                : title}
              {!archived && isGoalRunning(goal) ? ` · 已运行 ${Math.round(getGoalElapsed(goal, now) / 1000)}s` : ''}
            </p>
          </div>
          {!archived && (
            <div className="flex shrink-0 items-center gap-1">
              {actions.budgetEditRequired && !actions.canResume && (
                <span className="text-[11px] text-warning" title="预算耗尽，需回到会话内状态栏提高预算">预算已满</span>
              )}
              {actions.canResume && (
                <button type="button" disabled={busy} onClick={() => void run(goal.id, () => window.electronAPI.resumeGoal(goal.sessionId), 'Goal 已恢复')} className="inline-flex h-7 items-center gap-1 rounded-md border border-surface-border/50 px-2 text-xs hover:bg-muted/60 disabled:opacity-50">
                  <Play className="size-3" /> 恢复
                </button>
              )}
              {actions.canPause && (
                <button type="button" disabled={busy} onClick={() => void run(goal.id, () => window.electronAPI.pauseGoal(goal.sessionId), 'Goal 已暂停')} className="inline-flex h-7 items-center gap-1 rounded-md border border-surface-border/50 px-2 text-xs hover:bg-muted/60 disabled:opacity-50">
                  <Pause className="size-3" /> 暂停
                </button>
              )}
              {actions.canStop && (
                <button type="button" disabled={busy} onClick={() => void run(goal.id, () => window.electronAPI.stopGoal(goal.sessionId), 'Goal 已停止')} className="inline-flex h-7 items-center gap-1 rounded-md border border-surface-border/50 px-2 text-xs hover:bg-muted/60 disabled:opacity-50">
                  <Square className="size-3" /> 停止
                </button>
              )}
              {actions.canClear && (
                <button type="button" disabled={busy} onClick={() => void run(goal.id, () => window.electronAPI.clearGoal(goal.sessionId), 'Goal 已清除并归档')} className="inline-flex h-7 items-center rounded-md px-2 text-xs text-muted-foreground hover:bg-muted/60 hover:text-foreground disabled:opacity-50">
                  清除
                </button>
              )}
            </div>
          )}
        </div>
        {archived && goal.contract?.verification && (
          <p className="pl-6 text-[11px] text-muted-foreground">验收：{goal.contract.verification}</p>
        )}
      </li>
    )
  }

  /** 只有一个项目时直接平铺；多个项目时按项目分组，避免所有会话的目标压成一串。 */
  const renderGroupedEntries = (
    groups: Array<{ workspaceId: string | undefined; workspaceName: string; entries: AgentGoalOverviewEntry[] }>,
    prefix: string,
  ): React.ReactElement => {
    if (groups.length <= 1) {
      return <ul className="flex flex-col gap-2">{groups[0]?.entries.map(renderEntry) ?? null}</ul>
    }
    return (
      <div className="flex flex-col gap-3">
        {groups.map((group) => (
          <div key={`${prefix}:${group.workspaceId ?? 'orphan'}`} className="flex flex-col gap-1.5">
            <h3 className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
              <span className="truncate">{group.workspaceName}</span>
              <span className="text-muted-foreground/50">{group.entries.length}</span>
              {group.entries.some((entry) => needsGoalAttention(entry.goal)) && (
                <span className="rounded bg-warning/15 px-1 text-[10px] text-warning">待处理</span>
              )}
            </h3>
            <ul className="flex flex-col gap-2">{group.entries.map(renderEntry)}</ul>
          </div>
        ))}
      </div>
    )
  }

  const empty = liveEntries.length === 0 && endedEntries.length === 0 && !loading
  return (
    <div className="h-full overflow-y-auto px-4 py-3 sm:px-5">
      {empty ? (
        <div className="mx-auto mt-16 flex max-w-md flex-col items-center gap-2 text-center">
          <Target className="size-8 text-muted-foreground/50" aria-hidden="true" />
          <p className="text-sm font-medium">还没有 Goal</p>
          <p className="text-xs text-muted-foreground">在任意 Agent 会话输入 <code className="rounded bg-muted px-1 py-0.5">/goal 目标</code> 启动持续目标；完成后会出现在这里。</p>
        </div>
      ) : (
        <div className="mx-auto flex max-w-3xl flex-col gap-5">
          <section className="flex flex-col gap-2">
            <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">进行中（{liveEntries.length}）</h2>
            {liveEntries.length === 0
              ? <p className="text-xs text-muted-foreground">当前没有进行中的目标。</p>
              : renderGroupedEntries(liveGroups, 'live')}
          </section>
          <section className="flex flex-col gap-2">
            <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">最近结束（{endedEntries.length}）</h2>
            {loading && endedEntries.length === 0
              ? <p className="text-xs text-muted-foreground">读取归档…</p>
              : endedEntries.length === 0
                ? <p className="text-xs text-muted-foreground">还没有结束的目标。</p>
                : renderGroupedEntries(endedGroups, 'ended')}
          </section>
          <p className="text-[11px] text-muted-foreground/70">
            默认不限轮次与时长，连续 3 轮无进展时停止；预算可在会话内 Goal 状态栏编辑。完整历史也在那里展开。
          </p>
        </div>
      )}
    </div>
  )
}
