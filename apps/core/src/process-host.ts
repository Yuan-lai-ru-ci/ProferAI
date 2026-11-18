import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { ProcessRegistrationInput, ProcessRegistrationPort, ProcessRegistrationShellInput } from '@profer/agent-runtime'
import { getProcessInfo, isSameProcess, terminateProcessTreeGracefully } from '../../../packages/agent-runtime/src/process-monitor'

export function hostKey(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function writeHostJson(path: string, value: unknown): void {
  const temporary = `${path}.${randomUUID()}.tmp`
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 })
  renameSync(temporary, path)
}

interface OwnedProcess extends ProcessRegistrationInput {
  id: string
  pid?: number
  startTime?: number
  status: 'pending' | 'running' | 'interrupted' | 'stopped' | 'exited'
}

/** 单个 Core 独占的进程登记；重启不恢复执行，也不根据旧 PID 自动终止进程。 */
export class CoreProcessHost implements ProcessRegistrationPort {
  private readonly records: OwnedProcess[]
  private readonly path: string
  private readonly captures = new Map<string, Promise<void>>()

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true })
    this.path = join(dataDir, 'owned-processes.json')
    this.records = existsSync(this.path) ? JSON.parse(readFileSync(this.path, 'utf8')) as OwnedProcess[] : []
    if (!Array.isArray(this.records)) throw new Error('Core 进程登记损坏')
    for (const record of this.records) {
      if (record.status === 'running' || record.status === 'pending') record.status = 'interrupted'
    }
    this.save()
  }

  private save(): void { writeHostJson(this.path, this.records) }

  registerPending(input: ProcessRegistrationInput): { id: string } {
    const record: OwnedProcess = { ...input, id: randomUUID(), status: 'pending' }
    this.records.push(record)
    this.save()
    return { id: record.id }
  }

  registerShell(input: ProcessRegistrationShellInput): { id: string; startTime?: number } {
    if (!Number.isSafeInteger(input.pid) || input.pid <= 0) throw new Error('进程 PID 无效')
    const record = [...this.records].reverse().find(item => item.status === 'pending'
      && item.sessionId === input.sessionId && item.command === input.command && item.cwd === input.cwd
      && item.launcher === input.launcher) ?? { ...input, id: randomUUID(), status: 'pending' as const }
    if (!this.records.includes(record)) this.records.push(record)
    Object.assign(record, { pid: input.pid, status: 'running' })
    this.save()
    // registerShell 是同步端口，OS 身份查询异步完成；停止必须等待该次查询。
    const capture = getProcessInfo(input.pid).then(info => {
      if (info?.startTime !== undefined) record.startTime = info.startTime
      this.save()
    })
    this.captures.set(record.id, capture)
    void capture.catch(() => { /* stop 会报告身份无法确认 */ })
    return { id: record.id }
  }

  markExited(sessionId: string, id: string): void {
    const record = this.records.find(item => item.id === id && item.sessionId === sessionId)
    if (!record) throw new Error('进程登记不存在或不属于当前会话')
    if (record.status !== 'running' && record.status !== 'pending') return
    record.status = 'exited'
    this.save()
    this.captures.delete(id)
  }

  findTaskProcess(sessionId: string, pid: number): string {
    const matches = this.records.filter(record => record.sessionId === sessionId && record.pid === pid && record.status === 'running')
    if (matches.length !== 1) throw new Error('任务进程登记不存在或不唯一，拒绝绑定')
    return matches[0]!.id
  }

  async stop(sessionId: string, id: string, pid?: number): Promise<void> {
    const record = this.records.find(item => item.id === id && item.sessionId === sessionId)
    if (!record || record.status !== 'running' || !record.pid || (pid !== undefined && record.pid !== pid)) {
      throw new Error('进程不存在、已中断或不属于当前任务')
    }
    await this.captures.get(id)
    if (record.startTime === undefined || !await isSameProcess(record.pid, record.startTime)) {
      throw new Error('进程身份无法确认或 PID 已复用，拒绝停止')
    }
    const result = await terminateProcessTreeGracefully(record.pid, record.startTime)
    if (!result.ok) throw new Error(result.message)
    record.status = 'stopped'
    this.save()
  }
}
