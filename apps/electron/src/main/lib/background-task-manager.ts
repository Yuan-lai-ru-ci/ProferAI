import { existsSync, readFileSync } from 'node:fs'

export type BackgroundTaskStatus = 'running' | 'completed' | 'failed' | 'stopped'

export interface BackgroundTaskRecord {
  sessionId: string
  taskId: string
  /** SDK 任务类型；缺失时仅兼容旧记录，不允许据此猜测 renderer 类型。 */
  type?: 'agent' | 'shell'
  status: BackgroundTaskStatus
  outputFile?: string
  summary?: string
  updatedAt: number
}

export interface BackgroundTaskOutput {
  output: string
  isComplete: boolean
  status: BackgroundTaskStatus
  summary?: string
}

const MAX_OUTPUT_CHARS = 2 * 1024 * 1024

/**
 * Main-process authority for SDK background task ownership and final output.
 * Renderer input is never used to create records or choose an output path.
 */
export class BackgroundTaskManager {
  private readonly tasks = new Map<string, Map<string, BackgroundTaskRecord>>()

  upsert(input: Omit<BackgroundTaskRecord, 'updatedAt'>): BackgroundTaskRecord {
    let sessionTasks = this.tasks.get(input.sessionId)
    if (!sessionTasks) {
      sessionTasks = new Map()
      this.tasks.set(input.sessionId, sessionTasks)
    }
    const previous = sessionTasks.get(input.taskId)
    const record: BackgroundTaskRecord = {
      ...previous,
      ...input,
      ...(input.outputFile === undefined && previous?.outputFile ? { outputFile: previous.outputFile } : {}),
      ...(input.summary === undefined && previous?.summary ? { summary: previous.summary } : {}),
      updatedAt: Date.now(),
    }
    sessionTasks.set(input.taskId, record)
    return record
  }

  get(sessionId: string, taskId: string): BackgroundTaskRecord | undefined {
    return this.tasks.get(sessionId)?.get(taskId)
  }

  markStopped(sessionId: string, taskId: string): BackgroundTaskRecord {
    const current = this.get(sessionId, taskId)
    if (!current) throw new Error(`后台任务不存在或不属于当前会话: ${taskId}`)
    return this.upsert({ ...current, status: 'stopped' })
  }

  readOutput(record: BackgroundTaskRecord): string {
    if (!record.outputFile || !existsSync(record.outputFile)) return ''
    try {
      const output = readFileSync(record.outputFile, 'utf8')
      return output.length > MAX_OUTPUT_CHARS ? output.slice(-MAX_OUTPUT_CHARS) : output
    } catch {
      return ''
    }
  }

  async getOutput(
    sessionId: string,
    taskId: string,
    options: { block?: boolean; timeoutMs?: number } = {},
  ): Promise<BackgroundTaskOutput> {
    const deadline = Date.now() + Math.min(Math.max(options.timeoutMs ?? 5_000, 0), 30_000)
    let record = this.get(sessionId, taskId)
    if (!record) throw new Error(`后台任务不存在或不属于当前会话: ${taskId}`)
    while (options.block && record.status === 'running' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50))
      record = this.get(sessionId, taskId) ?? record
    }
    return {
      output: this.readOutput(record),
      isComplete: record.status !== 'running',
      status: record.status,
      ...(record.summary ? { summary: record.summary } : {}),
    }
  }

  forgetSession(sessionId: string): void {
    this.tasks.delete(sessionId)
  }

  clear(): void {
    this.tasks.clear()
  }
}
