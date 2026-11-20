import type { AgentContextUsageSnapshot as Snapshot, AgentStreamPayload } from '@profer/shared'
import { nextContextUsageReading } from './agent-context-usage-reading'

interface Store {
  save(id: string, reading: Snapshot): Promise<void>
  remove(id: string): Promise<void>
}
interface RunState {
  reading?: Snapshot
  afterBoundary?: boolean
  pending?: boolean
  ended?: boolean
}

/** 事件可能早于首次 JSONL 刷盘。主消息队列确认后重写快照，与最终历史版本绑定。 */
export function createContextUsageRecorder(store: Store, clock = Date.now) {
  const runs = new Map<string, RunState>()
  function persist(id: string, reading: Snapshot | undefined): void {
    void (reading ? store.save(id, reading) : store.remove(id)).catch(error => {
      console.warn(`[Agent 会话] 上下文用量保存失败: sessionId=${id}`, error)
    })
  }
  function finish(id: string): void {
    const run = runs.get(id)
    if (!run || run.ended) return
    run.ended = true
    if (!run.pending) {
      if (run.reading || run.afterBoundary) persist(id, run.reading)
      runs.delete(id)
    }
  }
  return {
    begin: (id: string) => { runs.delete(id) },
    finish,
    hidesPreCompactReading: (id: string) => runs.get(id)?.afterBoundary === true && !runs.get(id)?.reading,
    observe(id: string, payload: AgentStreamPayload, window?: number): void {
      const run = runs.get(id) ?? {}
      if (payload.kind === 'profer_event') {
        if (payload.event.type === 'run_idle') { finish(id); return }
        if (payload.event.type !== 'session_persistence') return
        run.pending = payload.event.status === 'pending'
        if (payload.event.status === 'saved' && (run.reading || run.afterBoundary)) persist(id, run.reading)
        if (!run.pending && (run.ended || !run.reading && !run.afterBoundary)) runs.delete(id)
        else runs.set(id, run)
        return
      }
      if (payload.kind !== 'sdk_message') return
      const msg = payload.message
      const boundary = msg.type === 'system' && msg.subtype === 'compact_boundary' && !('parent_tool_use_id' in msg && msg.parent_tool_use_id)
      if (boundary) {
        run.afterBoundary = true
        run.reading = undefined
      }
      const reading = nextContextUsageReading(run.reading, msg, window, clock())
      if (!reading && !boundary) return
      run.reading = reading
      runs.set(id, run)
      // 与 UI 共用同一个读数（包括时间）；普通消息及额度累计不附加字段。
      if (reading) payload.contextUsage = reading
      persist(id, reading)
    },
  }
}
