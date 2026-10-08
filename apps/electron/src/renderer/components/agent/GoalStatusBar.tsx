import * as React from 'react'
import { AlertTriangle, Check, ChevronDown, ChevronRight, CircleX, History, Pause, Pencil, Play, Square, Target } from 'lucide-react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { applyGoalLimitsPatch, getGoalBudgetExhaustedReasons, GOAL_REASON_LABELS, isGoalResumableByMessage, normalizeGoalReason, parseGoalLimitsInput } from '@profer/shared'
import type { AgentGoalReasonCode, AgentGoalState } from '@profer/shared'
import {
  agentGoalAtomFamily, getGoalActions, GOAL_STATUS_LABELS,
  goalActionPendingAtomFamily, goalEditorAtomFamily, goalHistoryAtomFamily,
} from '@/atoms/goal-atoms'
import { Button } from '@profer/ui/primitives/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@profer/ui/primitives/dialog'
import { Input } from '@profer/ui/primitives/input'
import { Textarea } from '@profer/ui/primitives/textarea'
import { toast } from 'sonner'
import { allPendingAskUserRequestsAtom, allPendingPermissionRequestsAtom } from '@/atoms/agent-atoms'
import { cn } from '@/lib/utils'
import { formatTokens } from '@/lib/format-tokens'

type Props = { sessionId: string }

const statusTone: Record<AgentGoalState['status'], string> = {
  active: 'text-primary', stopping: 'text-muted-foreground', paused: 'text-muted-foreground',
  completed: 'text-success', blocked: 'text-warning', budget_limited: 'text-warning',
  failed: 'text-destructive', stopped: 'text-muted-foreground',
}

function GoalIcon({ status }: { status: AgentGoalState['status'] }): React.ReactElement {
  const cls = cn('size-3.5 shrink-0', statusTone[status], status === 'active' && 'animate-pulse')
  if (status === 'blocked' || status === 'budget_limited') return <AlertTriangle className={cls} aria-hidden="true" />
  if (status === 'completed') return <Check className={cls} aria-hidden="true" />
  if (status === 'failed') return <CircleX className={cls} aria-hidden="true" />
  return <Target className={cls} aria-hidden="true" />
}

/** 需要时每秒刷新的当前时间；运行计时与重试倒计时共用一个计时器。 */
function useNow(enabled: boolean): number {
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    if (!enabled) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [enabled])
  return now
}

/** 只在明确存在 Goal run owner 时累加，暂停与启动水合不计墙钟时间。 */
function isGoalRunning(goal: AgentGoalState | undefined): boolean {
  return (goal?.status === 'active' || goal?.status === 'stopping') && Boolean(goal.activeRunId)
}

function goalElapsed(goal: AgentGoalState, now: number): number {
  return Math.max(0, goal.elapsedMs ?? 0) + (isGoalRunning(goal) ? Math.max(0, now - goal.updatedAt) : 0)
}

function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m${seconds % 60 > 0 ? `${seconds % 60}s` : ''}`
  return `${Math.floor(minutes / 60)}h${minutes % 60 > 0 ? `${minutes % 60}m` : ''}`
}

function formatBudget(limits: AgentGoalState['limits']): string {
  const parts = [
    limits.maxIterations === undefined ? '' : `${limits.maxIterations} 轮`,
    limits.maxDurationMs === undefined ? '' : formatElapsed(limits.maxDurationMs),
    limits.maxTokens === undefined ? '' : `${limits.maxTokens.toLocaleString()} tokens`,
  ].filter(Boolean)
  return `${parts.length ? parts.join(' · ') : '不限'}（连续 ${limits.maxConsecutiveFailures} 轮无进展时停止）`
}

/** active 期间区分真实运行与各种等待，非 active 时补充可操作提示。 */
function goalStatusLabel(goal: AgentGoalState, waits: { askUser: number; permission: number }, now: number): string {
  if (goal.status === 'active') {
    if (waits.askUser > 0) return '等待你的回答'
    if (waits.permission > 0) return '等待审批'
    if (goal.waiting === 'plan_mode') return '计划模式中，切换为可执行模式后自动继续'
    if (goal.retry && !goal.activeRunId) return `运行出错，${formatElapsed(Math.max(0, goal.retry.nextAt - now))}后第 ${goal.retry.attempt} 次重试`
    return goal.activeRunId ? GOAL_STATUS_LABELS.active : '等待会话空闲'
  }
  if (isGoalResumableByMessage(goal)) return `${GOAL_STATUS_LABELS[goal.status]} · ${goal.status === 'blocked' ? '发消息补充后自动继续' : '发消息即可继续'}`
  // 旧数据只有 stopReason，按共享规则归一化。
  if ((goal.reasonCode ?? normalizeGoalReason(goal.stopReason)) === 'app_restart') return `${GOAL_STATUS_LABELS[goal.status]} · 重启后待恢复`
  return GOAL_STATUS_LABELS[goal.status]
}

function DetailRow({ label, value }: { label: string; value: string }): React.ReactElement {
  return <div className="flex items-baseline gap-2 min-w-0">
    <span className="shrink-0 text-[10px] text-muted-foreground/70 w-14 text-right">{label}</span>
    <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-muted-foreground">{value}</span>
  </div>
}

function formatReason(reason: AgentGoalReasonCode, detail?: string): string {
  const label = GOAL_REASON_LABELS[reason]
  if (!detail || detail === reason || detail === label) return label
  return reason === 'unknown' ? detail : `${label}：${detail}`
}

function GoalReasonDetails({ goal }: { goal: AgentGoalState }): React.ReactElement | null {
  if (!goal.reasonCode && !goal.reasonDetail && !goal.stopReason) return null
  const reason = goal.reasonCode ?? normalizeGoalReason(goal.stopReason)
  const detail = goal.reasonDetail ?? (goal.reasonCode || reason === 'unknown' ? goal.stopReason : undefined)
  return <DetailRow label="原因" value={formatReason(reason, detail)} />
}

function lifecycleTime(at: number): { iso?: string; label: string } {
  const date = new Date(at)
  return Number.isFinite(date.getTime()) ? { iso: date.toISOString(), label: date.toLocaleString() } : { label: '历史时间无效' }
}

export function GoalLifecycleDetails({ goal }: { goal: AgentGoalState }): React.ReactElement | null {
  const events = (goal.lifecycle ?? []).slice(-10).reverse()
  if (events.length === 0) return null
  return <details className="rounded-md bg-background/50 p-2 text-[11px]">
    <summary className="cursor-pointer font-medium">最近状态转移（{events.length}）</summary>
    <ol className="mt-2 flex flex-col gap-2">
      {events.map((event) => <li key={event.id} className="min-w-0">
        <div className="font-medium">{event.from === null ? '尚未创建' : GOAL_STATUS_LABELS[event.from]} → {event.to === 'cleared' ? '已清除并归档' : GOAL_STATUS_LABELS[event.to]}</div>
        <div className="whitespace-pre-wrap break-words text-muted-foreground">{formatReason(event.reason, event.detail)}</div>
        <div className="break-words text-muted-foreground/70">
          <time dateTime={lifecycleTime(event.at).iso}>{lifecycleTime(event.at).label}</time> · 版本 {event.revision}
          {event.runId && <span className="break-all"> · 运行 {event.runId}</span>}
        </div>
      </li>)}
    </ol>
  </details>
}

function IterationHistory({ goal }: { goal: AgentGoalState }): React.ReactElement {
  return <div className="flex flex-col gap-2">
    {(goal.history ?? []).slice(-10).reverse().map((entry) => (
      <div key={entry.iteration} className="rounded-md bg-background/50 px-2 py-1.5 text-[11px]">
        <div className="font-medium">第 {entry.iteration} 轮 · {entry.outcome === 'failed' ? '失败' : entry.outcome === 'stopped' ? '停止' : entry.status === 'complete' ? '完成' : entry.status === 'blocked' ? '受阻' : '推进'} · {formatElapsed(entry.finishedAt - entry.startedAt)}</div>
        <div className="whitespace-pre-wrap break-words text-muted-foreground">{entry.summary}</div>
        {entry.error && <div className="text-destructive whitespace-pre-wrap break-words">{entry.error}</div>}
        {entry.evidence.length > 0 && <div className="whitespace-pre-wrap break-words text-muted-foreground">证据：{entry.evidence.join('；')}</div>}
      </div>
    ))}
    {!goal.history?.length && <span className="text-[11px] text-muted-foreground">尚无已结束的轮次</span>}
  </div>
}

export function GoalHistoryDetails({ goals }: { goals: AgentGoalState[] }): React.ReactElement {
  return <div className="flex flex-col gap-2">
    {goals.map((archived) => <details key={archived.id} className="rounded-md bg-background/50 p-2 text-[11px]">
      <summary className="cursor-pointer break-words">{archived.goal} · {archived.reasonCode === 'cleared' || archived.stopReason === 'cleared' ? '已清除并归档' : GOAL_STATUS_LABELS[archived.status]} · {new Date(archived.startedAt).toLocaleString()}</summary>
      <div className="mt-2 flex flex-col gap-1">
        {archived.contract?.verification && <DetailRow label="验收" value={archived.contract.verification} />}
        {archived.contract?.constraints && <DetailRow label="约束" value={archived.contract.constraints} />}
        {archived.contract?.stopWhen && <DetailRow label="停止条件" value={archived.contract.stopWhen} />}
        <GoalReasonDetails goal={archived} />
        <GoalLifecycleDetails goal={archived} />
        <IterationHistory goal={archived} />
      </div>
    </details>)}
  </div>
}

function GoalEditor({ sessionId }: Props): React.ReactElement {
  const [snapshot, setSnapshot] = useAtom(goalEditorAtomFamily(sessionId))
  const [pending, setPending] = useAtom(goalActionPendingAtomFamily(sessionId))
  const setGoal = useSetAtom(agentGoalAtomFamily(sessionId))
  const [error, setError] = React.useState<string | null>(null)
  React.useEffect(() => { setError(null) }, [snapshot])
  const budgetRequired = snapshot ? getGoalActions(snapshot).budgetEditRequired : false

  const save = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (!snapshot || pending) return
    const form = new FormData(event.currentTarget)
    const text = (name: string) => String(form.get(name) ?? '').trim()
    const resume = (event.nativeEvent as SubmitEvent).submitter?.getAttribute('value') === 'resume'
    setError(null)
    setPending(true)
    try {
      const goal = text('goal')
      if (!goal) throw new Error('目标不能为空')
      const contract = { verification: text('verification'), constraints: text('constraints'), stopWhen: text('stopWhen') }
      if (Object.values(contract).some((value) => value.length > 240)) throw new Error('每项契约最多 240 字符')
      const limits = parseGoalLimitsInput({ maxIterations: text('maxIterations'), maxDurationMinutes: text('maxDurationMinutes'), maxConsecutiveFailures: text('maxConsecutiveFailures'), maxTokens: text('maxTokens') })
      const current = await window.electronAPI.getGoal(sessionId)
      if (!current || current.id !== snapshot.id || current.revision !== snapshot.revision) throw new Error('Goal 已变化，请关闭编辑器后重新打开')
      if (!getGoalActions(current).canEdit) throw new Error('Goal 正在运行或停止，请结束后编辑')
      if (resume && budgetRequired && getGoalBudgetExhaustedReasons({ ...current, limits: applyGoalLimitsPatch(current.limits, limits) }).length > 0) {
        throw new Error('请将已耗尽的预算提高到当前用量以上，或留空改为不限')
      }
      const saved = await window.electronAPI.updateGoal(sessionId, { goal, contract, limits })
      setGoal(saved)
      if (resume) {
        if (!getGoalActions(saved).canResume) throw new Error('修改已保存，但当前状态或预算仍不允许恢复')
        setGoal(await window.electronAPI.resumeGoal(sessionId))
      }
      setSnapshot(null)
      toast.success(resume ? 'Goal 已更新并恢复' : 'Goal 已更新')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally { setPending(false) }
  }

  return <Dialog open={Boolean(snapshot)} onOpenChange={(open) => { if (!open && !pending) setSnapshot(null) }}>
    <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
      <DialogHeader>
        <DialogTitle>编辑目标、契约与预算</DialogTitle>
        <DialogDescription>沿用当前会话上下文和已有执行历史。修改只在 Goal 非运行时生效。</DialogDescription>
      </DialogHeader>
      {snapshot && <form key={`${snapshot.id}:${snapshot.revision ?? snapshot.updatedAt}`} onSubmit={(event) => { void save(event) }} className="flex flex-col gap-3">
        <label className="text-xs">目标<Textarea name="goal" defaultValue={snapshot.goal} required className="mt-1" disabled={pending} /></label>
        {(['verification', 'constraints', 'stopWhen'] as const).map((name, index) => <label key={name} className="text-xs">
          {['验收证据', '执行约束', '停止条件'][index]}
          <Textarea name={name} defaultValue={snapshot.contract?.[name] ?? ''} maxLength={240} className="mt-1 min-h-12" disabled={pending} />
        </label>)}
        <div className="grid grid-cols-2 gap-3">
          <label className="text-xs">轮次上限（可选）<Input name="maxIterations" inputMode="numeric" defaultValue={snapshot.limits.maxIterations ?? ''} placeholder="不限" disabled={pending} className="mt-1" /></label>
          <label className="text-xs">净运行时长（分钟，可选）<Input name="maxDurationMinutes" inputMode="decimal" defaultValue={snapshot.limits.maxDurationMs === undefined ? '' : snapshot.limits.maxDurationMs / 60000} placeholder="不限" disabled={pending} className="mt-1" /></label>
          <label className="text-xs">连续无进展上限<Input name="maxConsecutiveFailures" inputMode="numeric" defaultValue={snapshot.limits.maxConsecutiveFailures} required disabled={pending} className="mt-1" /></label>
          <label className="text-xs">Token 上限（可选）<Input name="maxTokens" inputMode="numeric" defaultValue={snapshot.limits.maxTokens ?? ''} placeholder="不限" disabled={pending} className="mt-1" /></label>
        </div>
        <p className="text-[11px] text-muted-foreground">已执行 {snapshot.iteration} 轮 · {formatElapsed(snapshot.elapsedMs ?? 0)} · {(snapshot.usage?.totalTokens ?? 0).toLocaleString()} tokens。预算留空表示不限；时长与 token 在每轮结束时检查，快用完时会提示 Agent 收尾。</p>
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
        <DialogFooter>
          <Button type="button" variant="ghost" disabled={pending} onClick={() => setSnapshot(null)}>取消</Button>
          <Button type="submit" variant="outline" disabled={pending}>保存</Button>
          {getGoalActions(snapshot).canEdit && (getGoalActions(snapshot).canResume || budgetRequired) && snapshot.status !== 'completed' && <Button type="submit" name="action" value="resume" disabled={pending}>{pending ? '处理中…' : '保存并恢复'}</Button>}
        </DialogFooter>
      </form>}
    </DialogContent>
  </Dialog>
}

export function GoalStatusBar({ sessionId }: Props): React.ReactElement | null {
  const goal = useAtomValue(agentGoalAtomFamily(sessionId))
  const setGoal = useSetAtom(agentGoalAtomFamily(sessionId))
  const setEditor = useSetAtom(goalEditorAtomFamily(sessionId))
  const [pending, setPending] = useAtom(goalActionPendingAtomFamily(sessionId))
  const [history, setHistory] = useAtom(goalHistoryAtomFamily(sessionId))
  const [expanded, setExpanded] = React.useState(false)
  const [historyError, setHistoryError] = React.useState<string | null>(null)
  const now = useNow(isGoalRunning(goal) || (goal?.status === 'active' && goal.retry !== undefined))
  const elapsed = goal ? goalElapsed(goal, now) : 0
  const askUserPending = useAtomValue(allPendingAskUserRequestsAtom).get(sessionId)?.length ?? 0
  const permissionPending = useAtomValue(allPendingPermissionRequestsAtom).get(sessionId)?.length ?? 0
  const statusLabel = goal ? goalStatusLabel(goal, { askUser: askUserPending, permission: permissionPending }, now) : ''
  React.useEffect(() => {
    let active = true
    setHistoryError(null)
    void window.electronAPI.getGoalHistory(sessionId).then((states) => {
      if (active) setHistory(states.filter((state) => state.sessionId === sessionId))
    }).catch((cause) => { if (active) setHistoryError(cause instanceof Error ? cause.message : String(cause)) })
    return () => { active = false }
  }, [sessionId, goal?.id, goal?.revision, expanded, setHistory])
  const archives = (history ?? []).filter((state) => state.id !== goal?.id)
  if (!goal && archives.length === 0) return null

  const invoke = async (action: 'pause' | 'resume' | 'stop' | 'clear'): Promise<void> => {
    if (pending || !goal) return
    setPending(true)
    try {
      const current = await window.electronAPI.getGoal(sessionId)
      if (current?.id !== goal.id) throw new Error('当前 Goal 已变化，请重试')
      if (action === 'clear') {
        if (!getGoalActions(current).canClear) throw new Error('Goal 正在运行或停止，请结束后清除')
        // clear 返回 void；live Goal 只由全局监听收到的 cleared 快照移除。
        await window.electronAPI.clearGoal(sessionId)
        toast.info('Goal 已清除并归档')
        setHistoryError(null)
        try {
          const states = await window.electronAPI.getGoalHistory(sessionId)
          setHistory(states.filter((state) => state.sessionId === sessionId))
        } catch (cause) {
          setHistoryError(cause instanceof Error ? cause.message : String(cause))
        }
        return
      }
      if (action === 'resume' && !getGoalActions(current).canResume) {
        if (getGoalActions(current).budgetEditRequired) setEditor(current)
        throw new Error('当前 Goal 不能直接恢复，请先处理状态或预算')
      }
      setGoal(await window.electronAPI[`${action}Goal`](sessionId))
    } catch (cause) { toast.error('Goal 操作失败', { description: cause instanceof Error ? cause.message : String(cause) }) }
    finally { setPending(false) }
  }
  const actions = goal ? getGoalActions(goal) : null
  const reasons = goal ? getGoalBudgetExhaustedReasons(goal) : []

  return <div className="px-3 pt-2" data-testid="goal-status-bar">
    <div className="rounded-lg border border-border/60 bg-muted/30 shadow-sm">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        {goal ? <>
          <GoalIcon status={goal.status} />
          <span className="min-w-0 flex-1 truncate text-xs font-medium" title={`${goal.goal}\n沿用当前会话上下文`}>{goal.goal}</span>
          <span className={cn('shrink-0 text-[11px] font-medium', statusTone[goal.status])} role="status">{statusLabel}</span>
          <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums" title="轮次 · 累计净运行时长 · token 用量">第 {goal.iteration} 轮 · {formatElapsed(elapsed)}{goal.usage || goal.limits.maxTokens !== undefined ? ` · ${formatTokens(goal.usage?.totalTokens ?? 0)}${goal.limits.maxTokens === undefined ? '' : ` / ${formatTokens(goal.limits.maxTokens)}`} tokens` : ''}</span>
        </> : <><History className="size-3.5 text-muted-foreground" /><span className="flex-1 text-xs">已归档 Goal（{archives.length}）</span></>}
        <Button size="icon" variant="ghost" className="size-6 text-muted-foreground" aria-label={expanded ? '收起 Goal 详情' : '查看 Goal 契约与历史'} title={expanded ? '收起详情' : '查看契约、最近轮次与归档 Goal'} onClick={() => setExpanded((value) => !value)}>{expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}</Button>
        {goal && actions?.canEdit && <Button size="icon" variant="ghost" className="size-6 text-muted-foreground" title="编辑目标、契约与预算" aria-label="编辑目标、契约与预算" disabled={pending} onClick={() => setEditor(goal)}><Pencil className="size-3" /></Button>}
        {actions?.canPause && <Button size="icon" variant="ghost" className="size-6 text-muted-foreground" title="暂停 Goal" aria-label="暂停 Goal" disabled={pending} onClick={() => { void invoke('pause') }}><Pause className="size-3" /></Button>}
        {actions?.canResume && <Button size="icon" variant="ghost" className="size-6 text-muted-foreground" title="恢复 Goal" aria-label="恢复 Goal" disabled={pending} onClick={() => { void invoke('resume') }}><Play className="size-3" /></Button>}
        {actions?.canStop && <Button size="icon" variant="ghost" className="size-6 text-muted-foreground hover:text-destructive" title="停止 Goal" aria-label="停止 Goal" disabled={pending} onClick={() => { void invoke('stop') }}><Square className="size-3" /></Button>}
        {goal && actions?.canClear && <Button size="icon" variant="ghost" className="size-6 text-muted-foreground hover:text-destructive" title="清除 Goal 状态" aria-label="清除 Goal 状态" disabled={pending} onClick={() => { void invoke('clear') }}><CircleX className="size-3" /></Button>}
      </div>
      {goal && actions?.budgetEditRequired && goal.status !== 'completed' && goal.status !== 'active' && goal.status !== 'stopping' && <div className="flex items-center gap-2 px-3 pb-2 text-[11px]">
        <span className="min-w-0 flex-1 text-warning break-words">{reasons.join('；') || goal.stopReason || '预算已耗尽'}。增加预算后才能继续。</span>
        <Button variant="outline" size="sm" className="h-6 text-[11px]" disabled={pending || !actions.canEdit} onClick={() => setEditor(goal)}>{actions.canEdit ? '修改预算后恢复' : '等待本轮停止'}</Button>
      </div>}
      {expanded && <div className="flex flex-col gap-2 border-t border-border/40 px-3 py-2 text-[11px]">
        <p className="text-muted-foreground">沿用当前会话上下文，实际工作保留在对话中。</p>
        {goal && <>
          {goal.contract?.verification && <DetailRow label="验收" value={goal.contract.verification} />}
          {goal.contract?.constraints && <DetailRow label="约束" value={goal.contract.constraints} />}
          {goal.contract?.stopWhen && <DetailRow label="停止条件" value={goal.contract.stopWhen} />}
          <DetailRow label="预算" value={formatBudget(goal.limits)} />
          {goal.lastSummary && <DetailRow label="最近进展" value={goal.lastSummary} />}
          {goal.usage && <DetailRow label="用量" value={`${goal.usage.totalTokens.toLocaleString()} tokens（输入 ${goal.usage.inputTokens.toLocaleString()} · 输出 ${goal.usage.outputTokens.toLocaleString()}）`} />}
          {goal.lastEvidence?.length ? <DetailRow label="证据" value={goal.lastEvidence.join('；')} /> : null}
          <GoalReasonDetails goal={goal} />
          <GoalLifecycleDetails goal={goal} />
          <div className="font-medium">最近轮次</div><IterationHistory goal={goal} />
        </>}
        <div className="font-medium">归档 Goal（{archives.length}）</div>
        {historyError && <p role="alert" className="text-destructive">读取历史失败：{historyError}</p>}
        {history === null ? !historyError && <p className="text-muted-foreground">正在读取历史…</p> : <GoalHistoryDetails goals={archives} />}
      </div>}
    </div>
    <GoalEditor sessionId={sessionId} />
  </div>
}
