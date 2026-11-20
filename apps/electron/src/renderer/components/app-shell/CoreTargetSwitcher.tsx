import * as React from 'react'
import { useAtomValue } from 'jotai'
import { Cpu, Monitor, Server } from 'lucide-react'
import { toast } from 'sonner'
import { Popover, PopoverContent, PopoverTrigger } from '@profer/ui/primitives/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@profer/ui/primitives/tooltip'
import { ScrollRegion } from '@/components/ai-elements/scroll-region'
import { cn } from '@/lib/utils'
import { coreTargetsAtom } from '@/atoms/core-target-atoms'
import type { CoreTargetsSnapshot, CoreTargetSummary } from '@/types/settings'

export function getCoreSwitcherTargets({ targets }: CoreTargetsSnapshot): CoreTargetSummary[] {
  const verifiedRemotes = targets.filter(target => target.kind === 'remote' && target.coreId)
  return verifiedRemotes.length ? [...targets.filter(target => target.kind === 'local'), ...verifiedRemotes] : []
}

function canSelectTarget(target: CoreTargetSummary, currentId: string): boolean {
  return target.id !== currentId || (target.kind === 'remote' && target.status !== 'connected')
}

interface CoreTargetPanelProps {
  targets: CoreTargetSummary[]
  current: CoreTargetSummary
  busy: boolean
  restoring: boolean
  fallback?: boolean
  onSelect: (target: CoreTargetSummary) => void
}

export function CoreTargetPanel({ targets, current, busy, restoring, fallback, onSelect }: CoreTargetPanelProps): React.ReactElement {
  const isRemote = current.kind === 'remote'
  const Icon = isRemote ? Server : Monitor
  const status = restoring ? '正在恢复连接' : current.status === 'connected' ? '已连接' : '未连接'
  const latency = current.latencyMs
  const showLatency = !restoring && isRemote && current.status === 'connected' && latency !== undefined && Number.isFinite(latency) && latency >= 0

  return (
    <>
      <div className="flex items-center gap-3 px-2 py-2">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <Icon size={18} aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium" title={current.name}>{current.name}</div>
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span>{isRemote ? '远程' : '本机'}</span>
            <span aria-hidden="true">·</span>
            <span role="status">{status}</span>
            {showLatency && <span className="ml-auto tabular-nums" aria-label={`WebSocket 延迟 ${Math.round(latency)} 毫秒`}>{Math.round(latency)} ms</span>}
          </div>
        </div>
      </div>
      <ScrollRegion role="group" aria-label="切换 Core" aria-busy={busy || restoring} className="scrollbar-none overflow-x-auto overflow-y-hidden border-t border-border/60 px-1 py-1">
        <div className="flex w-max min-w-full items-center">
          {targets.map(target => {
            const selected = target.id === current.id
            const available = !busy && (target.kind === 'local' && (restoring || fallback) || !restoring && canSelectTarget(target, current.id))
            const retry = selected && target.kind === 'remote' && target.status !== 'connected'
            const label = fallback && selected ? '设为启动内核：本机内核' : retry ? `重试连接 ${target.name}` : target.name
            return (
              <Tooltip key={target.id}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label={label}
                    aria-pressed={selected}
                    aria-disabled={!available}
                    onClick={() => { if (available) onSelect(target) }}
                    className="flex size-11 shrink-0 items-center justify-center rounded-md hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50"
                  >
                    <span aria-hidden="true" className={cn('size-2.5 rounded-full border', selected ? 'border-primary bg-primary' : 'border-muted-foreground/60')} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">{label}</TooltipContent>
              </Tooltip>
            )
          })}
        </div>
      </ScrollRegion>
    </>
  )
}

export function CoreTargetSwitcher(): React.ReactElement | null {
  const state = useAtomValue(coreTargetsAtom)
  const [busy, setBusy] = React.useState(false)
  const inFlight = React.useRef(false)
  const targets = getCoreSwitcherTargets(state)
  const current = targets.find(target => target.id === state.currentId)
  const restoring = state.startup === 'restoring'
  const fallback = state.startup === 'fallback'

  const select = async (target: CoreTargetSummary): Promise<void> => {
    const explicitLocal = target.kind === 'local' && (restoring || fallback)
    if (inFlight.current || (!explicitLocal && (restoring || !canSelectTarget(target, state.currentId)))) return
    inFlight.current = true
    setBusy(true)
    try {
      // 切换提交后由顶层 IPC 订阅更新快照，等待期间不乐观切换选中点。
      await window.electronAPI.selectCoreTarget(target.id)
    } catch {
      toast.error('该设备不在线')
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  if (!current) return null

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" aria-label={`当前内核：${current.name}`} title={`内核：${current.name}`} className="relative flex size-[36px] flex-none items-center justify-center rounded-[9px] text-foreground/[0.58] transition-colors hover:bg-foreground/[0.045] hover:text-foreground/[0.82] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 titlebar-no-drag">
          <Cpu size={18} aria-hidden="true" />
          <span aria-hidden="true" className={cn('absolute right-[6px] top-[6px] size-[6px] rounded-full', restoring ? 'bg-foreground/25' : current.status === 'connected' ? 'bg-green-500' : current.status === 'error' ? 'bg-destructive' : 'bg-foreground/25')} />
        </button>
      </PopoverTrigger>
      <PopoverContent aria-label="切换内核" side="right" align="end" className="w-64 max-w-[var(--radix-popover-content-available-width)] p-1.5" sideOffset={8}>
        <CoreTargetPanel targets={targets} current={current} busy={busy} restoring={restoring} fallback={fallback} onSelect={target => void select(target)} />
      </PopoverContent>
    </Popover>
  )
}
