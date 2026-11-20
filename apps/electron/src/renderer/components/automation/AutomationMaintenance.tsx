import * as React from 'react'
import { toast } from 'sonner'
import type { AutomationMaintenanceInput } from '@profer/shared'

interface Mirror { workspaceId: string; pending: boolean; error?: string }
interface Notification { id: string; status: string; error?: string; automation: { name: string } }
interface Inspection { workspaceId: string; hash: string; count: number; generation: number }

/** 在现有 Automation 列表中显式处理副本冲突及未确认投递。 */
export function AutomationMaintenance(): React.ReactElement {
  const [open, setOpen] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [mirrors, setMirrors] = React.useState<Mirror[]>([])
  const [outbox, setOutbox] = React.useState<Notification[]>([])
  const [generation, setGeneration] = React.useState<number>()
  const [inspection, setInspection] = React.useState<Inspection>()
  const request = async <T,>(input: AutomationMaintenanceInput): Promise<{ result: T; coreGeneration: number }> => {
    const value = await window.electronAPI.automationMaintenance(input)
    if (!value || typeof value !== 'object' || !('result' in value) || !('coreGeneration' in value) || typeof value.coreGeneration !== 'number') throw new Error('Core 维护响应无效')
    return value as { result: T; coreGeneration: number }
  }
  const refresh = async (): Promise<void> => {
    const a = await request<Mirror[]>({ operation: 'mirrors' })
    const b = await request<Notification[]>({ operation: 'outbox', coreGeneration: a.coreGeneration })
    setMirrors(a.result); setOutbox(b.result); setGeneration(b.coreGeneration); setInspection(undefined)
  }
  const perform = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true)
    try { await action() } catch (error) { toast.error(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  const button = 'rounded-md bg-muted px-3 py-1.5 text-xs disabled:opacity-50'
  return <div className="px-2 py-2 text-sm">
    <button className={button} disabled={busy} onClick={() => { setOpen(!open); if (!open) void perform(refresh) }}>项目副本与通知队列</button>
    {open && <div className="mt-2 space-y-3 rounded-xl bg-muted/40 p-3">
      <button className={button} disabled={busy} onClick={() => void perform(refresh)}>刷新</button>
      <button className={`${button} ml-2`} disabled={busy} onClick={() => void perform(async () => { await request({ operation: 'mirrors_retry', coreGeneration: generation }); await refresh() })}>重试副本同步</button>
      {mirrors.map(mirror => <div key={mirror.workspaceId} className="space-y-1">
        <div>{mirror.workspaceId} · {mirror.error ?? (mirror.pending ? '待同步' : '已同步')}</div>
        <button className={button} disabled={busy} onClick={() => void perform(async () => {
          const data = await request<{ hash: string; automations: unknown[] }>({ operation: 'mirror_inspect', workspaceId: mirror.workspaceId, coreGeneration: generation })
          setInspection({ workspaceId: mirror.workspaceId, hash: data.result.hash, count: data.result.automations.length, generation: data.coreGeneration })
        })}>检查项目副本</button>
      </div>)}
      {inspection && <div className="space-y-2">
        <p>已检查 {inspection.workspaceId}，包含 {inspection.count} 个任务。恢复后任务保持暂停。</p>
        {(['mirror_restore', 'mirror_resolve'] as const).map(operation => <button key={operation} className={`${button} mr-2`} disabled={busy} onClick={() => {
          if (!window.confirm(operation === 'mirror_restore' ? '将项目副本中的较新任务恢复到当前 Core？' : '使用当前 Core 数据覆盖已检查的项目副本？')) return
          void perform(async () => { await request({ operation, workspaceId: inspection.workspaceId, expectedHash: inspection.hash, coreGeneration: inspection.generation }); await refresh() })
        }}>{operation === 'mirror_restore' ? '从项目副本恢复' : '以 Core 为准解决冲突'}</button>)}
      </div>}
      <div>通知队列（{outbox.length}）</div>
      {outbox.map(item => <div key={item.id} className="space-y-1"><p>{item.automation.name} · {item.status}{item.error ? ` · ${item.error}` : ''}</p>
        {item.status === 'uncertain' && <button className={button} disabled={busy} onClick={() => {
          if (!window.confirm('该通知可能已经送达。重试可能重复发送，确定继续？')) return
          void perform(async () => { await request({ operation: 'notification_retry', id: item.id, coreGeneration: generation }); await refresh() })
        }}>确认并重试通知</button>}
      </div>)}
    </div>}
  </div>
}
