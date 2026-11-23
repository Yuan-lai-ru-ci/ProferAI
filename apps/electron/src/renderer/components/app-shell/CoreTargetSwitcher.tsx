import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { settingsOpenAtom, settingsTabAtom } from '@/atoms/settings-tab'
import { CoreSystemIcon } from './CoreSystemIcon'
import { Popover, PopoverContent, PopoverTrigger } from '@profer/ui/primitives/popover'
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
  error?: string
  onSelect: (target: CoreTargetSummary) => void
  onManage?: () => void
}

export function CoreTargetSegments({ targets, current, busy, restoring, fallback, onSelect, onManage }: CoreTargetPanelProps): React.ReactElement {
  const [hovered, setHovered] = React.useState<string>()
  const [focused, setFocused] = React.useState<string>()
  const expandedId = hovered ?? focused ?? current.id
  const items = [...targets.map(target => ({ id: target.id, name: target.name, target })), { id: 'core-settings', name: '设置内核', target: undefined }]
  const expandedIndex = items.findIndex(item => item.id === expandedId)

  return (
    <ScrollRegion role="group" aria-label="切换 Core" aria-busy={busy || restoring} className="scrollbar-none overflow-x-auto overflow-y-hidden px-2">
      <div className="mx-auto flex w-max items-center gap-0.5 rounded-full bg-primary/5 px-1 py-0.5" onMouseLeave={() => { setHovered(undefined); setFocused(undefined) }} onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
        const buttons = Array.from(event.currentTarget.querySelectorAll('button'))
        const index = buttons.indexOf(event.target as HTMLButtonElement)
        if (index < 0) return
        event.preventDefault()
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length
        setHovered(undefined)
        setFocused(items[next]?.id)
        buttons[next]?.focus()
      }}>
        {items.map((item, index) => {
          const { target } = item
          const selected = target?.id === current.id
          const available = !target || !busy && (target.kind === 'local' && (restoring || fallback) || !restoring && canSelectTarget(target, current.id))
          const retry = selected && target?.kind === 'remote' && target.status !== 'connected'
          const label = fallback && selected ? '设为启动内核：本机内核' : retry ? `重试连接 ${item.name}` : item.name
          const expanded = item.id === expandedId
          const distance = expandedIndex < 0 ? Infinity : Math.abs(index - expandedIndex)
          return (
            <button
              key={item.id}
              type="button"
              aria-label={label}
              aria-pressed={selected}
              aria-disabled={!available}
              data-expanded={expanded}
              onMouseEnter={() => setHovered(item.id)}
              onFocus={() => { setHovered(undefined); setFocused(item.id) }}
              onBlur={() => setFocused(undefined)}
              onClick={() => { if (available) { if (target) onSelect(target); else onManage?.() } }}
              className={cn('relative flex h-5 shrink-0 items-center justify-center rounded-full transition-[width,background-color,color] duration-200 ease-out motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50', expanded ? 'w-32 bg-primary text-primary-foreground' : 'w-4 text-muted-foreground')}
            >
              <span aria-hidden="true" className={cn('absolute w-1 rounded-full transition-[height,opacity,background-color] duration-200 motion-reduce:transition-none', expanded ? 'h-4 opacity-0' : selected ? 'h-3.5 bg-primary' : distance === 1 ? 'h-3.5 bg-primary/60' : distance === 2 ? 'h-3 bg-primary/40' : 'h-2.5 bg-primary/25')} />
              <span aria-hidden="true" className={cn('truncate px-2 text-xs font-medium transition-[opacity,filter] duration-200 motion-reduce:transition-none', expanded ? 'opacity-100 blur-none' : 'opacity-0 blur-sm')}>{item.name}</span>
            </button>
          )
        })}
      </div>
    </ScrollRegion>
  )
}

export function CoreTargetPanel({ targets, current, busy, restoring, fallback, onSelect, onManage, error }: CoreTargetPanelProps): React.ReactElement {
  const isRemote = current.kind === 'remote'
  const status = restoring ? '正在恢复连接' : current.status === 'connected' ? '已连接' : '未连接'
  const latency = current.latencyMs
  const showLatency = !restoring && isRemote && current.status === 'connected' && latency !== undefined && Number.isFinite(latency) && latency >= 0

  return (
    <>
      <div>
        <div className="flex items-center gap-3 px-2 py-2.5">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <CoreSystemIcon platform={current.platform} osId={current.osId} local={!isRemote} className="size-[18px]" />
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
        <CoreTargetSegments targets={targets} current={current} busy={busy} restoring={restoring} fallback={fallback} onSelect={onSelect} onManage={onManage} />
      </div>
      {error && <p role="alert" className="px-3 py-2 text-xs text-destructive-text">{error}</p>}
    </>
  )
}

export function CoreTargetSwitcher(): React.ReactElement | null {
  const state = useAtomValue(coreTargetsAtom)
  const setSettingsOpen = useSetAtom(settingsOpenAtom)
  const setSettingsTab = useSetAtom(settingsTabAtom)
  const [open, setOpen] = React.useState(false)
  const [error, setError] = React.useState<string>()
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
    setError(undefined)
    try {
      // 切换提交后由顶层 IPC 订阅更新快照，等待期间不乐观切换选中点。
      await window.electronAPI.selectCoreTarget(target.id)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '连接未完成，请重试。')
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  if (!current) return null

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" aria-label={`当前内核：${current.name}`} title={`内核：${current.name}`} className="relative flex size-[36px] flex-none items-center justify-center rounded-[9px] text-foreground/[0.58] transition-colors hover:bg-foreground/[0.045] hover:text-foreground/[0.82] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 titlebar-no-drag">
          <CoreSystemIcon platform={current.platform} osId={current.osId} local={current.kind === 'local'} className="size-[18px]" />
          <span aria-hidden="true" className={cn('absolute right-[6px] top-[6px] size-[6px] rounded-full', restoring ? 'bg-foreground/25' : current.status === 'connected' ? 'bg-green-500' : current.status === 'error' ? 'bg-destructive' : 'bg-foreground/25')} />
        </button>
      </PopoverTrigger>
      <PopoverContent aria-label="切换内核" side="right" align="end" className="w-64 max-w-[var(--radix-popover-content-available-width)] p-1.5" sideOffset={8}>
        <CoreTargetPanel targets={targets} current={current} busy={busy} restoring={restoring} fallback={fallback} error={error} onManage={() => { setSettingsTab('bots'); setSettingsOpen(true); setOpen(false) }} onSelect={target => void select(target)} />
      </PopoverContent>
    </Popover>
  )
}
