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

  // Mount-time fetch makes a persistent service visible without a separate empty-state card.
  React.useEffect(() => { void refresh() }, [refresh])
  React.useEffect(() => { if (rows.length > 0 || sdkTasks.length > 0) void refresh() }, [sdkTasks])

  if (rows.length === 0 && !loading && !error) return null
  const count = rows.length

  return (
    <section
      className={cn(
        'relative -mb-3 rounded-t-[17px] rounded-b-xl border-[0.5px] border-border bg-muted/25 pb-3 shadow-sm',
        className,
      )}
      aria-label="运行服务"
    >
      <div className="flex h-9 items-center gap-2 px-4 text-xs text-foreground/65">
        <button type="button" onClick={() => setOpen((v) => !v)} className="inline-flex items-center gap-1.5 hover:text-foreground">
          {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          <Terminal className="size-3.5" />
          <span>运行服务</span><span className="font-medium text-primary">{count}</span>
        </button>
        {loading && <Loader2 className="size-3 animate-spin" />}
        <button type="button" className="ml-auto inline-flex items-center gap-1 text-[11px] hover:text-foreground" onClick={() => void refresh()}>
          <RefreshCw className="size-3" />刷新
        </button>
      </div>
      {error && <div className="border-t border-border/40 px-4 py-1.5 text-[11px] text-destructive">{error}</div>}
      {open && <div className="border-t border-border/40 pb-3">
        {rows.map((row, i) => {
          const isLoadingRow = killing === (row.proc?.sdkTaskId ?? String(row.proc?.pid ?? i))
          const isOwned = row.proc?.source === 'pi-owned'
          const canKill = isOwned && Boolean(row.proc?.pid && row.proc.startTime) && row.proc?.status !== 'pending'
          return <div key={row.sdkTaskId ?? String(row.proc?.pid ?? i)} className="flex min-w-0 items-center gap-2 px-4 py-2 text-xs hover:bg-muted/25">
            {row.status === 'pending' ? <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground" /> : <span className="size-2 shrink-0 rounded-full bg-primary" />}
            <span className="shrink-0 text-foreground/75">{isOwned ? 'Pi 已登记' : 'SDK 任务'}</span>
            <span className="shrink-0 font-mono text-[11px] text-foreground/55">{row.proc?.ports.length ? `:${row.proc.ports.join(',')}` : row.proc?.pid ? `PID ${row.proc.pid}` : '正在确认'}</span>
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground/55" title={row.command ?? row.description}>{row.command || row.description || '—'}</span>
            {canKill ? <button type="button" disabled={isLoadingRow} className="shrink-0 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-destructive hover:bg-destructive/10 disabled:opacity-50" onClick={() => void handleKill(row)}>{isLoadingRow ? <Loader2 className="size-3 animate-spin" /> : <X className="size-3" />}{isLoadingRow ? '结束中' : '结束'}</button> : <span className="shrink-0 text-[11px] text-foreground/35">{row.status === 'pending' ? '确认中' : '未定位'}</span>}
          </div>
        })}
      </div>}
    </section>
  )
}
