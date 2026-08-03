/**
 * RuntimeProcessPanel — 会话运行进程面板（期一 M4）
 *
 * 展示该会话的运行中的后台任务/进程：
 *  - SDK 后台任务（sdkBackgroundTasksAtomFamily，来自 result.background_tasks，免费实时）
 *  - 真实 OS 进程（经 IPC listSessionProcesses 按 sdkShellTasks 匹配到 pid/端口）
 *  - 一键 kill（IPC killProcess，{pid,startTime} 双因子防转世；二次确认）
 *
 * 设计：默认收起（PowerShell 采集中等耗时 ~5s，避免频繁触发慢操作）。
 * 用户展开时才拉取真实进程；SDK 任务则实时（免费）。折叠面板含会话级徽标。
 */

import * as React from 'react'
import { Loader2, Terminal, X, ChevronDown, ChevronRight, RefreshCw } from 'lucide-react'
import { useAtom } from 'jotai'
import { cn } from '@/lib/utils'
import { sdkBackgroundTasksAtomFamily } from '@/atoms/agent-atoms'
import type { SessionProcessInfo, SDKBackgroundTaskSummary } from '@profer/shared'

interface RuntimeProcessPanelProps {
  sessionId: string
  className?: string
}

interface MergedRow {
  /** SDK 后台任务 id，可能没有（纯 OS 进程） */
  sdkTaskId?: string
  /** 任务类型 / 显示类型 */
  type: string
  /** 展示描述 */
  description: string
  /** 命令（如果有） */
  command?: string
  status: string
  /** 真实进程信息（经 IPC 匹配后） */
  proc?: SessionProcessInfo
}

export function RuntimeProcessPanel({ sessionId, className }: RuntimeProcessPanelProps): React.ReactElement | null {
  const [sdkTasks] = useAtom(sdkBackgroundTasksAtomFamily(sessionId))
  const [open, setOpen] = React.useState(false)
  const [rows, setRows] = React.useState<MergedRow[]>([])
  const [loading, setLoading] = React.useState(false)
  const [killing, setKilling] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [refreshing, setRefreshing] = React.useState(false)

  const refresh = React.useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const shellTasks = sdkTasks.filter((t): t is SDKBackgroundTaskSummary & { type: 'shell' } => t.type === 'shell')
      const procs: SessionProcessInfo[] = await window.electronAPI.listSessionProcesses({
        sessionId,
        sdkShellTasks: shellTasks,
      })
      setRows(
        sdkTasks.map((t) => {
          const proc = procs.find((p) => p.sdkTaskId === t.id)
          return {
            sdkTaskId: t.id,
            type: t.type,
            description: t.description ?? '',
            command: t.command,
            status: t.status ?? 'running',
            proc,
          }
        }),
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : '拉取进程失败')
    } finally {
      setLoading(false)
    }
  }, [sessionId, sdkTasks])

  const handleKill = React.useCallback(
    async (row: MergedRow) => {
      if (!row.proc) return
      if (!window.confirm(`确定结束进程 ${row.proc.pid}（${row.proc.name}）？\n该操作会结束整棵进程树。`)) return
      setKilling(row.proc.sdkTaskId ?? String(row.proc.pid))
      setError(null)
      try {
        const res = await window.electronAPI.killProcess({
          sessionId,
          pid: row.proc.pid,
          startTime: row.proc.startTime,
        })
        if (!res.ok) setError(res.message)
        // 成功则下次展开时刷新
        refresh()
      } catch (e) {
        setError(e instanceof Error ? e.message : 'kill 失败')
      } finally {
        setKilling(null)
      }
    },
    [sessionId, refresh],
  )

  // 展开时拉取一次
  React.useEffect(() => {
    if (open) void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // SDK 任务变化时若面板展开则刷新
  React.useEffect(() => {
    if (open) void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sdkTasks])

  const count = sdkTasks.length

  return (
    <div className={cn('w-full px-2.5', className)}>
      {/* 折叠头 */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs text-foreground/60 hover:bg-accent/40 transition-colors"
      >
        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        <Terminal className="size-3.5" />
        <span>运行中 {count > 0 && <span className="text-primary font-medium">{count}</span>}</span>
        {count > 0 && (
          <span className="ml-auto inline-flex size-4 items-center rounded-full bg-primary/10 text-[10px] text-primary">
            {count}
          </span>
        )}
        {loading && <Loader2 className="ml-1 size-3 animate-spin" />}
      </button>

      {/* 展开内容 */}
      {open && (
        <div className="mt-1 rounded-md border border-border/50 bg-muted/20">
          {error && (
            <div className="flex items-center justify-between px-2.5 py-1.5 text-[11px] text-destructive">
              <span>{error}</span>
              <button type="button" onClick={() => setError(null)} aria-label="关闭错误">
                <X className="size-3" />
              </button>
            </div>
          )}

          {rows.length === 0 && !loading ? (
            <div className="px-2.5 py-2 text-[11px] text-foreground/50">没有运行中的后台任务/进程</div>
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border/50 bg-muted/30">
                  <th className="text-left py-1 px-2 font-medium text-foreground/50 text-[11px]">类型</th>
                  <th className="text-left py-1 px-2 font-medium text-foreground/50 text-[11px]">状态</th>
                  <th className="text-left py-1 px-2 font-medium text-foreground/50 text-[11px]">PID</th>
                  <th className="text-left py-1 px-2 font-medium text-foreground/50 text-[11px]">端口</th>
                  <th className="text-left py-1 px-2 font-medium text-foreground/50 text-[11px]">命令</th>
                  <th className="text-right py-1 px-2 font-medium text-foreground/50 text-[11px]">操作</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => {
                  const isLoadingRow = killing === (row.proc?.sdkTaskId ?? String(row.proc?.pid ?? i))
                  return (
                    <tr key={row.sdkTaskId ?? String(row.proc?.pid ?? i)} className="border-b border-border/30 last:border-b-0 hover:bg-muted/30">
                      <td className="py-1 px-2 text-[11px] text-foreground/70">{row.type}</td>
                      <td className="py-1 px-2">
                        <span className={cn('text-[11px]', row.status === 'running' ? 'text-primary' : row.status === 'failed' ? 'text-destructive' : 'text-foreground/50')}>
                          {row.status}
                        </span>
                      </td>
                      <td className="py-1 px-2 font-mono text-[10px]">{row.proc?.pid ?? '—'}</td>
                      <td className="py-1 px-2 font-mono text-[10px]">{row.proc?.ports.join(',') || '—'}</td>
                      <td className="py-1 px-2">
                        <div className="truncate max-w-[220px]" title={row.command ?? row.description}>
                          <span className="font-mono text-[10px] text-foreground/60">{row.command?.slice(0, 60) || row.description || '—'}</span>
                        </div>
                      </td>
                      <td className="py-1 px-2 text-right">
                        {row.proc ? (
                          <button
                            type="button"
                            disabled={isLoadingRow}
                            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-destructive hover:bg-destructive/10 disabled:opacity-50"
                            onClick={() => void handleKill(row)}
                          >
                            {isLoadingRow ? <Loader2 className="size-3 animate-spin" /> : <X className="size-3" />}
                            {isLoadingRow ? '结束中' : '结束'}
                          </button>
                        ) : (
                          <span className="text-[10px] text-foreground/30">未定位</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}

          <div className="flex items-center justify-end gap-2 border-t border-border/30 px-2 py-1">
            <button
              type="button"
              className="inline-flex items-center gap-1 text-[11px] text-foreground/60 hover:text-foreground"
              onClick={() => void refresh()}
            >
              <RefreshCw className={cn('size-3', refreshing && 'animate-spin')} />
              刷新
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
