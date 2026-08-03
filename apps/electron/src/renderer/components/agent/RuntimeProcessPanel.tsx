/**
 * RuntimeProcessPanel — 会话运行进程面板（期一 M4）
 *
 * 展示该会话的运行中的后台任务/进程：
 *  - Pi 在 Bash 启动点登记并确认到 PID 的服务（聊天结束后仍保留）
 *  - Claude SDK 活跃后台任务（补充来源）
 *  - 一键 kill（IPC killProcess，{pid,startTime} 双因子防转世；二次确认）
 *
 * 不按 Profer 会话临时目录扫描：外部项目 dev server 的真实 cwd 并不在那里。
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

function inferProcType(name: string, cmd: string): string {
  const n = name.toLowerCase()
  const c = cmd.toLowerCase()
  if (c.includes('vite')) return 'dev-server'
  if (c.includes('node') || n.includes('node')) return 'node'
  if (n.includes('python')) return 'python'
  if (c.includes('bun')) return 'bun'
  return n || 'process'
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
      // 主数据 = 目录枚举/匹配到的真实进程；SDK 任务作为类型/状态补充
      const rowsFromProcs: MergedRow[] = procs.map((p) => {
        const sdk = p.sdkTaskId ? sdkTasks.find((t) => t.id === p.sdkTaskId) : undefined
        return {
          sdkTaskId: sdk?.id,
          type: sdk?.type ?? inferProcType(p.name, p.cmd),
          description: sdk?.description ?? p.name,
          command: sdk?.command ?? p.cmd,
          status: p.status ?? sdk?.status ?? 'running',
          proc: p,
        }
      })
      // 未匹配到真实 pid 的 SDK 后台任务也展示（如已结束但仍列出的）
      const coveredSdkIds = new Set(procs.filter((p) => p.sdkTaskId).map((p) => p.sdkTaskId))
      const extraRows: MergedRow[] = sdkTasks
        .filter((t) => !coveredSdkIds.has(t.id))
        .map((t) => ({
          sdkTaskId: t.id,
          type: t.type,
          description: t.description ?? '',
          command: t.command,
          status: t.status ?? 'running',
        }))
      setRows([...rowsFromProcs, ...extraRows])
    } catch (e) {
      setError(e instanceof Error ? e.message : '拉取进程失败')
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, sdkTasks])

  const handleKill = React.useCallback(
    async (row: MergedRow) => {
      if (!row.proc?.pid || !row.proc.startTime) return
      const location = row.proc.cwd ? `\n项目目录：${row.proc.cwd}` : ''
      if (!window.confirm(`确定结束进程 ${row.proc.pid}（${row.proc.name}）？${location}\n将先尝试优雅停止；若超时，才强制结束整棵进程树。`)) return
      setKilling(row.proc.sdkTaskId ?? String(row.proc.pid))
      setError(null)
      try {
        const res = await window.electronAPI.killProcess({
          sessionId,
          pid: row.proc.pid,
          startTime: row.proc.startTime,
          source: row.proc.source,
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

  // 运行中计数：优先真实进程数（展开后），未展开时退化到 SDK 任务数（免费实时）
  const count = rows.length > 0 ? rows.length : sdkTasks.length

  return (
    <div className={cn('w-full px-2.5 md:px-[18px]', className)}>
      {/* 折叠头 */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs text-foreground/60 hover:bg-accent/40 transition-colors"
      >
        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        <Terminal className="size-3.5" />
        <span>运行服务 {count > 0 && <span className="text-primary font-medium">{count}</span>}</span>
        {count > 0 && (
          <span className="ml-auto inline-flex size-4 items-center rounded-full bg-primary/10 text-[10px] text-primary">
            {count}
          </span>
        )}
        {loading && <Loader2 className="ml-1 size-3 animate-spin" />}
      </button>

      {/* 展开内容 */}
      {open && (
        <div className="mt-1 overflow-x-auto rounded-md border border-border/50 bg-muted/20">
          {error && (
            <div className="flex items-center justify-between px-2.5 py-1.5 text-[11px] text-destructive">
              <span>{error}</span>
              <button type="button" onClick={() => setError(null)} aria-label="关闭错误">
                <X className="size-3" />
              </button>
            </div>
          )}

          {rows.length === 0 && !loading ? (
            <div className="px-2.5 py-2 text-[11px] text-foreground/50">没有本会话已登记的运行服务</div>
          ) : (
            <table className="min-w-[680px] w-full text-xs">
              <thead>
                <tr className="border-b border-border/50 bg-muted/30">
                  <th className="text-left py-1 px-2 font-medium text-foreground/50 text-[11px]">来源</th>
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
                      <td className="py-1 px-2 text-[11px] text-foreground/70" title={row.proc?.cwd}>
                        {row.proc?.source === 'pi-owned' ? 'Pi 已登记' : row.proc?.source === 'sdk' ? 'SDK 任务' : row.type}
                      </td>
                      <td className="py-1 px-2">
                        <span className={cn('text-[11px]', row.status === 'running' ? 'text-primary' : row.status === 'failed' ? 'text-destructive' : 'text-foreground/50')}>
                          {row.status}
                        </span>
                      </td>
                      <td className="py-1 px-2 font-mono text-[10px]">{row.proc?.pid ?? '确认中'}</td>
                      <td className="py-1 px-2 font-mono text-[10px]">{row.proc?.ports.join(',') || '—'}</td>
                      <td className="py-1 px-2">
                        <div className="truncate max-w-[220px]" title={row.command ?? row.description}>
                          <span className="font-mono text-[10px] text-foreground/60">{row.command?.slice(0, 60) || row.description || '—'}</span>
                          {row.proc?.persistsAfterChat && <span className="ml-1 text-[10px] text-amber-600">聊天结束后仍运行</span>}
                        </div>
                      </td>
                      <td className="py-1 px-2 text-right">
                        {row.proc?.source === 'pi-owned' && row.proc.pid && row.proc.status !== 'pending' ? (
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
                          <span className="text-[10px] text-foreground/30">{row.proc?.status === 'pending' ? '确认中' : '未定位'}</span>
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
