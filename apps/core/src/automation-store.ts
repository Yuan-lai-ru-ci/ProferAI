import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, openSync, fsyncSync, closeSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { CoreAutomationIndex } from './automation-project-mirror'

/** Core私有单写者存储；每次返回副本，写盘失败不发布内存中的半成功修改。 */
export class CoreAutomationStore {
  constructor(private readonly path: string) {}
  read(): CoreAutomationIndex {
    if (!existsSync(this.path)) return { version: 4, automations: [], triggers: [] }
    const value = JSON.parse(readFileSync(this.path, 'utf8')) as CoreAutomationIndex
    if (value.version !== 4 || !Array.isArray(value.automations) || !Array.isArray(value.triggers)) throw new Error('Core Automation存储格式无效，拒绝覆盖或调度')
    const ids = new Set<string>(), triggers = new Set<string>()
    for (const item of value.automations) {
      if (!item || typeof item.id !== 'string' || !item.id || ids.has(item.id) || !Array.isArray(item.runHistory)
        || !Number.isFinite(item.nextRunAt) || typeof item.active !== 'boolean') throw new Error('Core Automation定义无效')
      ids.add(item.id)
    }
    for (const record of value.triggers) {
      if (!record || typeof record.triggerId !== 'string' || !record.triggerId || triggers.has(record.triggerId)
        || !ids.has(record.automationId) || !['queued', 'blocked', 'running', 'completed', 'failed', 'cancelled', 'interrupted'].includes(record.status)
        || !Number.isFinite(record.scheduledAt)) throw new Error('Core Automation触发记录无效')
      triggers.add(record.triggerId)
    }
    if (value.projectMirrors !== undefined && (!Array.isArray(value.projectMirrors) || value.projectMirrors.some(state => !state
      || typeof state.workspaceId !== 'string' || typeof state.rootPath !== 'string' || typeof state.pending !== 'boolean'
      || !Array.isArray(state.knownAutomationIds) || state.knownAutomationIds.some(id => typeof id !== 'string')
      || state.lastHash !== undefined && !/^[a-f0-9]{64}$/.test(state.lastHash))
      || new Set(value.projectMirrors.map(state => state.workspaceId)).size !== value.projectMirrors.length)) throw new Error('Core Automation镜像状态无效')
    if (value.notificationOutbox !== undefined && (!Array.isArray(value.notificationOutbox) || value.notificationOutbox.some(item => !item || typeof item.id !== 'string' || !item.id || !item.automation || !item.run || !item.target || !['pending', 'sending', 'delivered', 'uncertain'].includes(item.status)) || new Set(value.notificationOutbox.map(item => item.id)).size !== value.notificationOutbox.length)) throw new Error('Core Automation通知队列无效')
    return value
  }
  write(index: CoreAutomationIndex): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const temp = `${this.path}.${randomUUID()}.tmp`
    try {
      const fd = openSync(temp, 'wx', 0o600)
      try { writeFileSync(fd, JSON.stringify(index, null, 2)); fsyncSync(fd) }
      finally { closeSync(fd) }
      renameSync(temp, this.path)
    } finally { if (existsSync(temp)) unlinkSync(temp) }
  }
}
