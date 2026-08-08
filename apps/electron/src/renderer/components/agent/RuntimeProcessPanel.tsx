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
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
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
  const [pendingKill, setPendingKill] = React.useState<MergedRow | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  // registry 轻量计数：仅读盘不派 OS 扫描，决定折叠轨是否初始显示。
  const [registeredCount, setRegisteredCount] = React.useState(0)
  const sdkTasksRef = React.useRef(sdkTasks)
  sdkTasksRef.current = sdkTasks

  // 初始加载会话登记过的进程数（轻量，不派 PowerShell）；也会在每次 registry
  // 变更事件时刷新，保证「agent 一登记进程，面板就出现」而不需要用户展开。
  const refreshRegisteredCount = React.useCallback(async () => {
    try {
      const n = await window.electronAPI.getSessionProcessCount(sessionId)
      setRegisteredCount(n)
    } catch { /* 保持现状 */ }
  }, [sessionId])
  React.useEffect(() => {
    void refreshRegisteredCount()
    // 注册表变化时同步刷新轻量计数，让「agent 一登记进程，面板即出现」
    const unsubscribe = window.electronAPI.onRuntimeProcessesChanged(({ sessionId: changedSessionId }) => {
      if (changedSessionId === sessionId) void refreshRegisteredCount()
    })
    return () => unsubscribe()
  }, [refreshRegisteredCount])

  const refresh = React.useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const currentSdkTasks = sdkTasksRef.current
      const shellTasks = currentSdkTasks.filter((t): t is SDKBackgroundTaskSummary & { type: 'shell' } => t.type === 'shell')
      const procs: SessionProcessInfo[] = await window.electronAPI.listSessionProcesses({
        sessionId,
        sdkShellTasks: shellTasks,
      })
      // 主数据 = 目录枚举/匹配到的真实进程；SDK 任务作为类型/状态补充
      const rowsFromProcs: MergedRow[] = procs.map((p) => {
        const sdk = p.sdkTaskId ? currentSdkTasks.find((t) => t.id === p.sdkTaskId) : undefined
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
      const extraRows: MergedRow[] = currentSdkTasks
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
  }, [sessionId])

  const handleKill = React.useCallback(
    async (row: MergedRow) => {
      if (!row.proc?.pid || !row.proc.startTime) return
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
        setPendingKill(null)
      }
    },
    [sessionId, refresh],
  )

  React.useEffect(() => {
    if (!open) return
    void refresh()
    // 面板刚展开：先立即刷一次，再延迟一轮捕捉 daemonize 的服务。
    const reconciliationTimer = window.setTimeout(() => void refresh(), 3_000)
    const unsubscribe = window.electronAPI.onRuntimeProcessesChanged(({ sessionId: changedSessionId }) => {
      if (changedSessionId === sessionId) void refresh()
    })
    return () => {
      window.clearTimeout(reconciliationTimer)
      unsubscribe()
    }
  }, [refresh, sessionId, open])

  // 面板可见性：SDK 后台活动任务 / registry 登记过进程（两者都不派 OS 扫描）
  // 即可显示折叠轨；真实进程行在展开后才拉取。这样既有入口可点，又避免打开
  // 会话时不必要地触发全量 PowerShell 扫描。
  const hasSdkActive = sdkTasks.some((t) => t.status !== 'exited' && t.status !== 'completed')
  const showRail = hasSdkActive || registeredCount > 0 || rows.length > 0
  if (!showRail) return null

  // 计数：已扫描则用真实进程行（含 SDK 任务补充）；否则用 registry 服务数（与
  // listOwnedRuntimeProcesses 同口径，避免折叠/展开数字跳变）。仅当 registry 为 0
  // 但有 SDK 活动任务时才回落 SDK 数兜底（纯 SDK 任务会话）。
  const sdkActiveCount = sdkTasks.filter((t) => t.status !== 'exited' && t.status !== 'completed').length
  const count = rows.length > 0
    ? rows.length
    : (registeredCount > 0 ? registeredCount : (hasSdkActive ? sdkActiveCount : 0))
  const railClassName = cn(
    'service-rail relative rounded-t-[17px] border-[0.5px] border-border bg-muted/25 pb-5 shadow-sm',
    className,
  )

  return (
    <section className={railClassName} aria-label="运行服务">
      <div className="flex h-9 items-center gap-2 px-4 text-xs text-foreground/65">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-controls="runtime-process-panel-body"
          className="inline-flex items-center gap-1.5 hover:text-foreground"
        >
          {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          <Terminal className="size-3.5" />
          <span>运行服务</span>
          <span className="font-medium text-primary">{count}</span>
        </button>
        {loading && <Loader2 className="size-3 animate-spin" />}
        <button
          type="button"
          className="ml-auto inline-flex items-center gap-1 text-[11px] hover:text-foreground"
          onClick={() => void refresh()}
        >
          <RefreshCw className="size-3" />
          刷新
        </button>
      </div>

      {error && <div className="border-t border-border/40 px-4 py-1.5 text-[11px] text-destructive">{error}</div>}

      {open && (
        <div
          id="runtime-process-panel-body"
          role="region"
          aria-label="运行服务列表"
          className="border-t border-border/40"
        >
          {rows.map((row, index) => {
            const rowId = row.proc?.sdkTaskId ?? String(row.proc?.pid ?? index)
            const isKilling = killing === rowId
            const isOwned = row.proc?.source === 'pi-owned'
            const isPending = row.status === 'pending'
            const canKill = isOwned && Boolean(row.proc?.pid && row.proc.startTime) && !isPending
            const processLabel = row.proc?.ports.length
              ? `:${row.proc.ports.join(',')}`
              : row.proc?.pid
                ? `PID ${row.proc.pid}`
                : '正在确认'

            return (
              <div key={rowId} className="flex min-w-0 items-center gap-2 px-4 py-2 text-xs hover:bg-muted/25">
                {isPending ? (
                  <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground" />
                ) : (
                  <span className="size-2 shrink-0 rounded-full bg-primary" />
                )}
                <span className="shrink-0 text-foreground/75">{isOwned ? 'Pi 已登记' : 'SDK 任务'}</span>
                <span className="shrink-0 font-mono text-[11px] text-foreground/55">{processLabel}</span>
                <span
                  className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground/55"
                  title={row.command ?? row.description}
                >
                  {row.command || row.description || '—'}
                </span>
                {canKill ? (
                  <button
                    type="button"
                    disabled={isKilling}
                    className="shrink-0 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-destructive hover:bg-destructive/10 disabled:opacity-50"
                    onClick={() => setPendingKill(row)}
                  >
                    {isKilling ? <Loader2 className="size-3 animate-spin" /> : <X className="size-3" />}
                    {isKilling ? '结束中' : '结束'}
                  </button>
                ) : (
                  <span className="shrink-0 text-[11px] text-foreground/35">{isPending ? '确认中' : '未定位'}</span>
                )}
              </div>
            )
          })}
        </div>
      )}

      <AlertDialog open={pendingKill !== null} onOpenChange={(open) => !open && setPendingKill(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>结束运行服务？</AlertDialogTitle>
            <AlertDialogDescription>
              将先尝试优雅停止；若超时，才会强制结束整棵进程树。
            </AlertDialogDescription>
          </AlertDialogHeader>
          {pendingKill?.proc && (
            <div className="space-y-1 rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-xs">
              <div><span className="text-muted-foreground">进程：</span>{pendingKill.proc.name}（PID {pendingKill.proc.pid}）</div>
              {pendingKill.proc.cwd && <div className="break-all"><span className="text-muted-foreground">项目目录：</span>{pendingKill.proc.cwd}</div>}
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={killing !== null}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={!pendingKill || killing !== null}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => pendingKill && void handleKill(pendingKill)}
            >
              {killing ? '结束中…' : '结束服务'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
