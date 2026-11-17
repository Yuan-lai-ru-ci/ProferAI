import type { AgentStreamPayload } from '@profer/shared'

export interface RemoteAgentEventRecord {
  eventId: number
  sessionId: string
  payload: AgentStreamPayload
  createdAt: number
}

export interface RemoteAgentEventReplay {
  records: RemoteAgentEventRecord[]
  fromEventId: number | null
  toEventId: number | null
  oldestEventId: number | null
  latestEventId: number | null
  requiresSnapshot: boolean
}

/**
 * 进程内 Agent 事件日志：为远程 Pocket 提供有限窗口的断线补发能力。
 * 事件内容不落盘，服务重启后由调用方通过快照恢复。
 *
 * 窗口尺寸（8000 条 / 8 小时）：客户端断线超过窗口时 resume 只能回
 * requiresSnapshot（不补发事件），漏掉的 result / run_completed 只能靠重拉恢复 ——
 * 手机锁屏/切后台一个上午是常态，10 分钟的旧窗口太小（曾导致「跑完的一轮永远
 * 停在运行中」）。上限双保险：条数防内存爆（投影后每条约 1-3KB，8000 条典型 <25MB），
 * 时长防陈旧事件无限堆积。
 */
export class RemoteAgentEventLog {
  private readonly records: RemoteAgentEventRecord[] = []
  private nextEventId = 1

  constructor(
    private readonly maxEvents = 8000,
    private readonly maxAgeMs = 8 * 60 * 60 * 1000,
  ) {
    if (!Number.isInteger(maxEvents) || maxEvents < 1) {
      throw new Error('maxEvents 必须是正整数')
    }
    if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) {
      throw new Error('maxAgeMs 必须是非负数')
    }
  }

  append(sessionId: string, payload: AgentStreamPayload, createdAt = Date.now()): RemoteAgentEventRecord {
    this.prune(createdAt)
    const record: RemoteAgentEventRecord = {
      eventId: this.nextEventId++,
      sessionId,
      payload,
      createdAt,
    }
    this.records.push(record)
    this.prune(createdAt)
    return record
  }

  replayAfter(cursor: number | null): RemoteAgentEventReplay {
    const oldestEventId = this.records[0]?.eventId ?? null
    const latestEventId = this.records[this.records.length - 1]?.eventId ?? null

    if (cursor === null || latestEventId === null) {
      return {
        records: [],
        fromEventId: null,
        toEventId: null,
        oldestEventId,
        latestEventId,
        requiresSnapshot: false,
      }
    }

    if (cursor < 0 || !Number.isSafeInteger(cursor)) {
      return {
        records: [],
        fromEventId: null,
        toEventId: null,
        oldestEventId,
        latestEventId,
        requiresSnapshot: true,
      }
    }

    const requiresSnapshot = oldestEventId !== null && cursor < oldestEventId - 1
    const records = requiresSnapshot
      ? []
      : this.records.filter((record) => record.eventId > cursor)

    return {
      records,
      fromEventId: records[0]?.eventId ?? null,
      toEventId: records[records.length - 1]?.eventId ?? cursor,
      oldestEventId,
      latestEventId,
      requiresSnapshot,
    }
  }

  getOldestEventId(): number | null {
    return this.records[0]?.eventId ?? null
  }

  getLatestEventId(): number | null {
    return this.records[this.records.length - 1]?.eventId ?? null
  }

  clear(): void {
    this.records.length = 0
    this.nextEventId = 1
  }

  private prune(now: number): void {
    const cutoff = now - this.maxAgeMs
    while (this.records.length > 0 && this.records[0]!.createdAt < cutoff) {
      this.records.shift()
    }
    while (this.records.length > this.maxEvents) {
      this.records.shift()
    }
  }
}
