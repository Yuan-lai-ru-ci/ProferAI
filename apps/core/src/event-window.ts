import { randomUUID } from 'node:crypto'

export interface CoreEventFrame { kind: string; sessionId?: string; payload?: unknown; eventId?: string; [key: string]: unknown }
/** 进程级有界事件窗口；重启epoch改变时必须读取权威快照，不能把旧游标当新进程水位。 */
export class CoreEventWindow {
  readonly epoch = randomUUID()
  private sequence = 0
  private readonly events: CoreEventFrame[] = []
  constructor(private readonly capacity = 2000) {}
  append(frame: CoreEventFrame): CoreEventFrame {
    const event = { ...frame, eventId: `${this.epoch}:${++this.sequence}` }
    this.events.push(event)
    if (this.events.length > this.capacity) this.events.splice(0, this.events.length - this.capacity)
    return event
  }
  get cursor(): string { return `${this.epoch}:${this.sequence}` }
  resume(cursor: unknown): { events: CoreEventFrame[]; requiresSnapshot: boolean; latestEventId: string; oldestEventId: string | null } {
    const latestEventId = this.cursor, oldestEventId = this.events[0]?.eventId ?? null
    const prefix = `${this.epoch}:`
    const offset = typeof cursor === 'string' && cursor.startsWith(prefix) ? Number(cursor.slice(prefix.length)) : NaN
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > this.sequence || offset < this.sequence - this.events.length) return { events: [], requiresSnapshot: true, latestEventId, oldestEventId }
    return { events: this.events.filter(frame => Number(frame.eventId!.slice(prefix.length)) > offset), requiresSnapshot: false, latestEventId, oldestEventId }
  }
}
