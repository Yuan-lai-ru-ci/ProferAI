import * as React from 'react'
import { AlertTriangle, History, Loader2, RotateCcw } from 'lucide-react'
import type { RewindResult } from '@profer/shared'
import { ScrollRegion } from '@/components/ai-elements/scroll-region'
import { asRewindError, createRewindClient, RewindRequestCoordinator, type RewindClient } from '@/lib/agent-rewind-client'

export interface RewindRecoveryRecord {
  recoveryId: string
  createdAt: number
  summary: string
  result?: RewindResult
  undoable?: boolean
}

export interface RewindRecoveryPanelProps {
  sessionId: string
  records: RewindRecoveryRecord[]
  client: RewindClient
  currentRevision?: RewindResult['revision']
  onUndone?: (result: RewindResult) => void
}

export function RewindRecoveryPanel({ sessionId, records, client, currentRevision, onUndone }: RewindRecoveryPanelProps): React.ReactElement {
  const [activeId, setActiveId] = React.useState<string | null>(null)
  const [error, setError] = React.useState<Error | null>(null)
  const coordinator = React.useRef(new RewindRequestCoordinator()).current

  const undo = (record: RewindRecoveryRecord) => {
    if (!record.undoable || activeId) return
    setActiveId(record.recoveryId)
    setError(null)
    const request = coordinator.undo(createRewindClient(client), { sessionId, recoveryId: record.recoveryId, expectedRevision: currentRevision })
    if (!request) return
    void request.then((value) => onUndone?.(value)).catch((cause) => setError(asRewindError(cause))).finally(() => setActiveId(null))
  }

  return <section className="grid min-w-0 gap-2" aria-labelledby="rewind-recovery-title">
    <div className="flex items-center gap-2"><History className="size-4" /><h2 id="rewind-recovery-title" className="text-sm font-medium">回退记录</h2></div>
    {records.length === 0 ? <p className="text-xs text-muted-foreground">暂无可恢复记录</p> : <ScrollRegion className="max-h-48 space-y-1 overflow-y-auto pr-1">{records.map((record) => <div key={record.recoveryId} className="flex min-w-0 items-center gap-2 rounded-md border border-border/60 p-2 text-xs"><div className="min-w-0 flex-1"><div className="break-words">{record.summary}</div><div className="text-muted-foreground">{new Date(record.createdAt).toLocaleString()}</div></div><button type="button" className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-border/70 px-2 text-xs hover:bg-accent disabled:opacity-50" disabled={!record.undoable || activeId !== null} onClick={() => undo(record)} title={record.undoable ? '撤销这次回退' : '该记录不可撤销'}>{activeId === record.recoveryId ? <Loader2 className="size-3 animate-spin" /> : <RotateCcw className="size-3" />}撤销</button></div>)}</ScrollRegion>}
    {error && <div className="flex items-start gap-1.5 text-xs text-destructive" role="alert"><AlertTriangle className="mt-0.5 size-3.5 shrink-0" /><span className="break-words">{error.message}</span></div>}
  </section>
}
