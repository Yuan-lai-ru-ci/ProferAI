import * as React from 'react'
import { useAtomValue } from 'jotai'
import { Activity, RefreshCw } from 'lucide-react'
import { Button } from '@profer/ui/primitives/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@profer/ui/primitives/tooltip'
import { agentWorkspacesAtom } from '@/atoms/agent-atoms'
import { aggregateHeatmapEntries, toCalendarData, type WorkspaceHeatmapEntry } from '@/lib/heatmap-utils'

const CELL = 10
const GAP = 3
const WEEKS = 53
const DAYS = ['一', '', '三', '', '五', '', '日']
const LEVELS = ['bg-muted', 'bg-primary/20', 'bg-primary/40', 'bg-primary/65', 'bg-primary']

function buildGrid(entries: WorkspaceHeatmapEntry[]) {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const start = new Date(today)
  start.setDate(start.getDate() - ((today.getDay() + 6) % 7) - (WEEKS - 1) * 7)
  const values = new Map(entries.map((entry) => [entry.date, entry.tokens]))
  const levels = new Map(toCalendarData(entries).map((entry) => [entry.date, entry.level]))
  const weeks = Array.from({ length: WEEKS }, (_, col) => Array.from({ length: 7 }, (_, row) => {
    const date = new Date(start)
    date.setDate(start.getDate() + col * 7 + row)
    if (date > today) return null
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
    return { date: key, tokens: values.get(key) ?? 0, level: levels.get(key) ?? 0 }
  }))
  const months: Array<{ label: string; col: number }> = []
  let lastMonth = -1
  weeks.forEach((week, col) => {
    const date = week[0] ? new Date(`${week[0].date}T00:00:00`) : null
    if (date && date.getMonth() !== lastMonth) {
      months.push({ label: `${date.getMonth() + 1}月`, col })
      lastMonth = date.getMonth()
    }
  })
  return { weeks, months }
}

function formatTokens(tokens: number): string {
  return tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(1)}M` : tokens >= 1_000 ? `${(tokens / 1_000).toFixed(1)}K` : String(tokens)
}

export function GlobalUsageCard(): React.ReactElement {
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const [entries, setEntries] = React.useState<WorkspaceHeatmapEntry[]>([])
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [reload, setReload] = React.useState(0)
  const personalWorkspaces = React.useMemo(() => workspaces.filter((workspace) =>
    !workspace.isDeleted && (workspace as { type?: string }).type !== 'team',
  ), [workspaces])

  React.useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    Promise.all(personalWorkspaces.map((workspace) => window.electronAPI.getWorkspaceHeatmapDaily(workspace.id)))
      .then((results) => {
        if (cancelled) return
        setEntries(aggregateHeatmapEntries(results))
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [personalWorkspaces, reload])

  const totalTokens = entries.reduce((sum, entry) => sum + entry.tokens, 0)
  const activeDays = entries.filter((entry) => entry.tokens > 0).length
  const { weeks, months } = React.useMemo(() => buildGrid(entries), [entries])

  return (
    <section aria-labelledby="global-usage-title" className="rounded-2xl border border-border/80 bg-card p-5 shadow-sm dark:bg-surface-raised">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"><Activity className="size-4" aria-hidden="true" /></span>
          <div><h2 id="global-usage-title" className="text-sm font-semibold text-foreground">总使用热力图</h2><p className="mt-1 text-xs text-muted-foreground">所有个人工作区的每日 Token 用量</p></div>
        </div>
        <div className="flex items-center gap-5 text-right">
          <div><div className="font-mono text-base font-semibold tabular-nums text-foreground">{loading ? '…' : formatTokens(totalTokens)}</div><div className="text-[10px] text-muted-foreground">近一年 Token</div></div>
          <div><div className="font-mono text-base font-semibold tabular-nums text-foreground">{loading ? '…' : activeDays}</div><div className="text-[10px] text-muted-foreground">活跃天数</div></div>
          {error && <Button variant="ghost" size="icon" onClick={() => setReload((value) => value + 1)} aria-label="重新加载热力图"><RefreshCw className="size-4" /></Button>}
        </div>
      </div>
      {error ? <div role="alert" className="mt-4 flex items-center justify-between gap-3 rounded-lg bg-destructive/5 px-3 py-2 text-xs text-destructive"><span>热力图读取失败：{error}</span><Button variant="outline" size="sm" onClick={() => setReload((value) => value + 1)}>重试</Button></div> : loading ? <div aria-busy="true" className="mt-5 h-[112px] animate-pulse rounded-md bg-muted/40 motion-reduce:animate-none" /> : (
        <>
          <div className="mt-5 overflow-x-auto pb-1">
            <div className="min-w-[410px]">
              <div className="relative mb-2 ml-7 h-3">{months.map((month) => <span key={`${month.label}-${month.col}`} className="absolute top-0 text-[9px] text-muted-foreground" style={{ left: month.col * (CELL + GAP) }}>{month.label}</span>)}</div>
              <div className="flex gap-2">
                <div className="flex shrink-0 flex-col justify-between py-px">{DAYS.map((day, i) => <span key={i} className="h-[10px] w-5 text-[9px] leading-[10px] text-muted-foreground">{day}</span>)}</div>
                <div className="grid grid-flow-col grid-rows-7" style={{ gap: GAP }}>
                  {weeks.flatMap((week) => week).map((cell, index) => cell ? <Tooltip key={cell.date} delayDuration={200}><TooltipTrigger asChild><div aria-label={`${cell.date}，${cell.tokens ? `${formatTokens(cell.tokens)} tokens` : '无消耗'}`} className={`rounded-[2px] ${LEVELS[cell.level] ?? LEVELS[0]} transition-opacity hover:opacity-75`} style={{ width: CELL, height: CELL }} /></TooltipTrigger><TooltipContent className="whitespace-pre-line text-xs">{cell.date}{'\n'}{cell.tokens ? `${formatTokens(cell.tokens)} tokens` : '无消耗'}</TooltipContent></Tooltip> : <div key={`future-${index}`} style={{ width: CELL, height: CELL }} />)}
                </div>
              </div>
            </div>
          </div>
          {activeDays === 0 && <p className="mt-2 text-[11px] text-muted-foreground">开始 Agent 会话后，这里会汇总显示所有个人工作区的每日用量。</p>}
          <div className="mt-2 flex items-center justify-between text-[10px] text-muted-foreground"><span>{personalWorkspaces.length} 个个人工作区</span><span className="flex items-center gap-1">少 {LEVELS.map((level, index) => <span key={index} className={`size-[10px] rounded-[2px] ${level}`} />)} 多</span></div>
        </>
      )}
    </section>
  )
}
