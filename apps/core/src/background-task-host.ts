import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BackgroundTaskPort, ProcessLifecyclePort } from '@profer/agent-runtime'
import type { GetTaskOutputResult } from '@profer/shared'
import { CoreProcessHost, hostKey, writeHostJson } from './process-host'

interface TaskRecord {
  sessionId: string
  taskId: string
  provider: 'pi' | 'claude'
  type: 'agent' | 'shell'
  command?: string
  status: 'running' | 'completed' | 'failed' | 'stopped'
  summary?: string
  outputFile?: string
  pid?: number
  processId?: string
  attemptId?: string
  interrupted?: boolean
}

/** 输出正文单独追加写入；每次状态变更先持久化，再返回 provider。 */
export class CoreBackgroundTaskHost implements BackgroundTaskPort {
  private readonly tasks: TaskRecord[]
  private readonly indexPath: string
  private readonly outputDir: string

  constructor(dataDir: string, private readonly processes: CoreProcessHost) {
    mkdirSync(dataDir, { recursive: true })
    this.outputDir = join(dataDir, 'task-output')
    mkdirSync(this.outputDir, { recursive: true })
    this.indexPath = join(dataDir, 'background-tasks.json')
    this.tasks = existsSync(this.indexPath) ? JSON.parse(readFileSync(this.indexPath, 'utf8')) as TaskRecord[] : []
    if (!Array.isArray(this.tasks)) throw new Error('Core 后台任务索引损坏')
    for (const task of this.tasks) {
      if (task.status !== 'running') continue
      task.status = 'failed'
      task.interrupted = true
      task.summary = 'Core 已重启，原执行已中断；不会自动重放，也不能使用旧任务停止新进程。'
    }
    this.save()
  }

  private save(): void { writeHostJson(this.indexPath, this.tasks) }
  private outputPath(sessionId: string, taskId: string): string {
    return join(this.outputDir, `${hostKey(JSON.stringify([sessionId, taskId]))}.log`)
  }
  private require(sessionId: string, taskId: string, provider?: 'pi' | 'claude'): TaskRecord {
    const task = this.tasks.find(item => item.sessionId === sessionId && item.taskId === taskId
      && (!provider || item.provider === provider))
    if (!task) throw new Error(`后台任务不存在或不属于当前会话: ${taskId}`)
    return task
  }

  begin(sessionId: string, taskId: string, command: string): void {
    if (this.tasks.some(item => item.sessionId === sessionId && item.taskId === taskId)) {
      throw new Error('后台任务 ID 已存在，拒绝覆盖历史输出')
    }
    this.tasks.push({ sessionId, taskId, provider: 'pi', type: 'shell', command, status: 'running' })
    this.save()
  }
  append(sessionId: string, taskId: string, chunk: Buffer | string): void {
    const task = this.require(sessionId, taskId, 'pi')
    if (task.status !== 'running') return
    appendFileSync(this.outputPath(sessionId, taskId), chunk, { mode: 0o600 })
  }
  attachProcess(sessionId: string, taskId: string, pid: number): void {
    const task = this.require(sessionId, taskId, 'pi')
    if (task.status !== 'running') throw new Error('后台任务已终止')
    task.processId = this.processes.findTaskProcess(sessionId, pid)
    task.pid = pid
    this.save()
  }
  complete(sessionId: string, taskId: string, status: 'completed' | 'failed' | 'stopped', summary?: string): void {
    const task = this.require(sessionId, taskId, 'pi')
    if (task.status !== 'running') return
    Object.assign(task, { status, summary })
    this.save()
  }
  async getOutput(sessionId: string, taskId: string, options: { block?: boolean; timeoutMs?: number } = {}): Promise<GetTaskOutputResult> {
    const task = this.require(sessionId, taskId)
    const deadline = Date.now() + Math.min(30_000, Math.max(0, options.timeoutMs ?? 5_000))
    while (options.block && task.status === 'running' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    const ownPath = this.outputPath(sessionId, taskId)
    // Claude 的路径仅接收 SDK 可信事件，调用方不能通过 taskId 传入任意读取路径。
    const source = task.provider === 'claude' ? task.outputFile : ownPath
    const output = source && existsSync(source) ? readFileSync(source, 'utf8') : ''
    return { output, isComplete: task.status !== 'running', status: task.status,
      ...(task.summary ? { summary: task.summary } : {}) }
  }
  async stop(sessionId: string, taskId: string): Promise<void> {
    const task = this.require(sessionId, taskId, 'pi')
    if (task.status !== 'running') return
    if (!task.pid) throw new Error('任务尚无已确认进程，拒绝伪造停止成功')
    if (!task.processId) throw new Error('任务未绑定所属进程登记，拒绝停止')
    await this.processes.stop(sessionId, task.processId, task.pid)
    this.complete(sessionId, taskId, 'stopped', '已停止所属真实进程树')
  }

  createClaudeLifecycle(): ProcessLifecyclePort {
    const attemptProcesses = new Map<string, Set<string>>()
    return {
      onSpawn: (sessionId, pid, _runtime, attemptId) => {
        if (!attemptId) throw new Error('Claude 进程缺少 query attempt 归属')
        const registration = this.processes.registerShell({ sessionId, pid, command: 'claude-sdk', cwd: '', launcher: 'bash' })
        const key = JSON.stringify([sessionId, attemptId])
        const ids = attemptProcesses.get(key) ?? new Set<string>()
        ids.add(registration.id)
        attemptProcesses.set(key, ids)
      },
      onTaskEvent: (sessionId, event, attemptId) => {
        let task = this.tasks.find(item => item.sessionId === sessionId && item.taskId === event.taskId)
        if (!attemptId) throw new Error('Claude 任务缺少 query attempt 归属')
        if (task && task.attemptId !== attemptId) throw new Error('后台任务 ID 已存在于其他 query attempt，拒绝覆盖')
        if (task && task.provider !== 'claude') throw new Error('后台任务 provider 冲突')
        if (!task) {
          task = { sessionId, taskId: event.taskId, provider: 'claude', attemptId, type: event.type ?? 'agent', status: event.status }
          this.tasks.push(task)
        }
        if (task.interrupted || task.status !== 'running' && task.status !== event.status) return
        const wasTerminal = task.status !== 'running'
        if (wasTerminal && task.outputFile === this.outputPath(sessionId, event.taskId)) return
        Object.assign(task, event)
        // 完成时把 SDK 输出保存到 Core 自有目录，避免 SDK 临时目录清理后结果丢失。
        if (task.outputFile && task.status !== 'running' && existsSync(task.outputFile)) {
          const path = this.outputPath(sessionId, event.taskId)
          const contents = readFileSync(task.outputFile)
          // 同路径无需重写，重复终态不会重复追加。
          if (task.outputFile !== path) {
            writeFileSync(path, contents, { mode: 0o600 })
            task.outputFile = path
          }
        }
        this.save()
      },
      getTaskOutput: (sessionId, taskId, options) => {
        this.require(sessionId, taskId, 'claude')
        return this.getOutput(sessionId, taskId, options)
      },
      stopTask: async (sessionId, taskId, expectedType, providerStop) => {
        const task = this.require(sessionId, taskId, 'claude')
        if (expectedType && task.type !== expectedType) throw new Error('后台任务类型不匹配')
        if (task.status !== 'running') return
        if (!providerStop) throw new Error('Claude SDK 停止回调未配置')
        await providerStop()
        if (task.status === 'running') {
          task.status = 'stopped'
          this.save()
        }
      },
      onExit: (sessionId, attemptId) => {
        if (!attemptId) return
        const key = JSON.stringify([sessionId, attemptId])
        for (const id of attemptProcesses.get(key) ?? []) this.processes.markExited(sessionId, id)
        attemptProcesses.delete(key)
        for (const task of this.tasks) {
          if (task.sessionId !== sessionId || task.provider !== 'claude' || task.attemptId !== attemptId || task.status !== 'running') continue
          task.status = 'failed'
          task.summary = 'Claude执行进程已退出，后台任务中断，未自动重放。'
          if (task.outputFile && existsSync(task.outputFile)) {
            const path = this.outputPath(sessionId, task.taskId)
            writeFileSync(path, readFileSync(task.outputFile), { mode: 0o600 })
            task.outputFile = path
          }
        }
        this.save()
      },
    }
  }
}
