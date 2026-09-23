import type { GetTaskOutputResult } from '@profer/shared'
import { isSameProcess, terminateProcessTreeGracefully } from './process-monitor'
import { listOwnedRuntimeProcesses, markOwnedRuntimeProcessExited, type RuntimeProcessRecord } from './runtime-process-registry'

export type PiBackgroundTaskStatus = 'running' | 'completed' | 'failed' | 'stopped'

interface PiBackgroundTask {
  sessionId: string
  taskId: string
  command: string
  status: PiBackgroundTaskStatus
  output: string
  summary?: string
  pid?: number
  startTime?: number
  updatedAt: number
}

const MAX_OUTPUT_CHARS = 2 * 1024 * 1024

/** Pi 长命服务的 TaskOutput/TaskStop 适配层；ownership 仍完全由 runtime registry 负责。 */
export class PiBackgroundTaskManager {
  private readonly tasks = new Map<string, Map<string, PiBackgroundTask>>()

  begin(sessionId: string, taskId: string, command: string): void {
    let sessionTasks = this.tasks.get(sessionId)
    if (!sessionTasks) {
      sessionTasks = new Map()
      this.tasks.set(sessionId, sessionTasks)
    }
    sessionTasks.set(taskId, { sessionId, taskId, command, status: 'running', output: '', updatedAt: Date.now() })
  }

  attachProcess(sessionId: string, taskId: string, pid: number, startTime?: number): void {
    const task = this.tasks.get(sessionId)?.get(taskId)
    if (!task) return
    task.pid = pid
    task.startTime = startTime
    task.updatedAt = Date.now()
  }

  append(sessionId: string, taskId: string, chunk: Buffer | string): void {
    const task = this.tasks.get(sessionId)?.get(taskId)
    if (!task) return
    task.output = `${task.output}${typeof chunk === 'string' ? chunk : chunk.toString('utf8')}`
    if (task.output.length > MAX_OUTPUT_CHARS) task.output = task.output.slice(-MAX_OUTPUT_CHARS)
    task.updatedAt = Date.now()
  }

  complete(sessionId: string, taskId: string, status: Exclude<PiBackgroundTaskStatus, 'running'>, summary?: string): void {
    const task = this.tasks.get(sessionId)?.get(taskId)
    if (!task) return
    task.status = status
    task.summary = summary
    task.updatedAt = Date.now()
  }

  /** 由持久化 registry 恢复一个仍然活跃的服务句柄；输出正文只能恢复后续新产生的增量。 */
  hydrate(record: RuntimeProcessRecord): void {
    if (record.status === 'exited' || !record.likelyService) return
    let sessionTasks = this.tasks.get(record.sessionId)
    if (!sessionTasks) {
      sessionTasks = new Map()
      this.tasks.set(record.sessionId, sessionTasks)
    }
    if (sessionTasks.has(record.id)) return
    sessionTasks.set(record.id, {
      sessionId: record.sessionId,
      taskId: record.id,
      command: record.command,
      status: 'running',
      output: '',
      pid: record.pid,
      startTime: record.startTime,
      updatedAt: Date.now(),
    })
  }

  private async ensureTask(sessionId: string, taskId: string): Promise<PiBackgroundTask | undefined> {
    const current = this.tasks.get(sessionId)?.get(taskId)
    if (current) return current
    const records = await listOwnedRuntimeProcesses(sessionId)
    const record = records.find((item) => item.id === taskId)
    if (record) {
      this.hydrate(record)
      return this.tasks.get(sessionId)?.get(taskId)
    }
    return undefined
  }

  async getOutput(sessionId: string, taskId: string, options: { block?: boolean; timeoutMs?: number } = {}): Promise<GetTaskOutputResult> {
    const task = await this.ensureTask(sessionId, taskId)
    if (!task) throw new Error(`后台任务不存在或不属于当前会话: ${taskId}`)
    const deadline = Date.now() + Math.min(Math.max(options.timeoutMs ?? 5_000, 0), 30_000)
    let current = task
    while (options.block && current.status === 'running' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50))
      current = this.tasks.get(sessionId)?.get(taskId) ?? current
    }
    return {
      output: current.output,
      isComplete: current.status !== 'running',
      status: current.status,
      ...(current.summary ? { summary: current.summary } : {}),
    }
  }

  async stop(sessionId: string, taskId: string): Promise<void> {
    const task = await this.ensureTask(sessionId, taskId)
    if (!task) throw new Error(`后台任务不存在或不属于当前会话: ${taskId}`)
    if (task.status !== 'running') return
    const records = await listOwnedRuntimeProcesses(sessionId)
    const record = records.find((item) => item.id === taskId && item.status === 'running')
    if (!record?.pid || record.startTime === undefined) throw new Error('后台任务尚未确认真实进程，拒绝停止')
    if (!(await isSameProcess(record.pid, record.startTime))) throw new Error('后台任务进程已变化或已退出，拒绝停止')
    const result = await terminateProcessTreeGracefully(record.pid, record.startTime)
    if (!result.ok) throw new Error(`后台任务停止失败: ${result.message}`)
    markOwnedRuntimeProcessExited(sessionId, record.pid, record.startTime)
    this.complete(sessionId, taskId, 'stopped', result.message)
  }

  clear(): void {
    this.tasks.clear()
  }
}

export const piBackgroundTaskManager = new PiBackgroundTaskManager()
