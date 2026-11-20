import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { join, isAbsolute } from 'node:path'
import { assertProjectPathSafe } from '@profer/session-store/project-session-paths'
import { migrateLegacyAutomationFields, type AutomationsIndex } from '@profer/agent-runtime/automation-manager'
import { DEFAULT_TIME_OF_DAY, DEFAULT_DAY_OF_WEEK, DEFAULT_DAY_OF_MONTH, type Automation, type AutomationTriggerRecord } from '@profer/shared'
import type { CoreConfig } from './config'
import { CoreAutomationStore, assertAutomationNotificationTargets } from './automation-store'

const IMPORT_ID = 'desktop-automations-v4-import'
const nonterminal = new Set(['queued', 'blocked', 'running', 'interrupted'])
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  return JSON.stringify(value) ?? 'undefined'
}
const idValid = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) && !id.endsWith('.')

/** 只接管桌面已停调度后的已知版本原文件；副本升级，源文件不改，ACK与数据同盘提交。 */
export function importDesktopAutomations(config: CoreConfig, store: CoreAutomationStore, now = Date.now()): void {
  if (!config.desktopAutomationTimeZone) return
  if (!config.desktopWorkspaceIndexPath || !config.desktopWorkspaceIndexWritable || !['127.0.0.1', 'localhost', '::1'].includes(config.host)) throw new Error('Automation历史接管只允许桌面自有本机Core')
  const zone = config.desktopAutomationTimeZone
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(now) } catch { throw new Error('原桌面Automation时区无效') }
  const path = join(config.configDir, 'automations.json')
  if (!existsSync(path)) {
    if (existsSync(`${path}.bak`) || existsSync(`${path}.tmp`)) throw new Error('桌面Automation主文件缺失但有恢复文件，拒绝猜测交接快照')
    if (existsSync(config.desktopWorkspaceIndexPath)) {
      const index: unknown = JSON.parse(readFileSync(config.desktopWorkspaceIndexPath, 'utf8'))
      if (!index || typeof index !== 'object' || !('workspaces' in index) || !Array.isArray(index.workspaces)) throw new Error('无法核对桌面Automation项目镜像')
      for (const entry of index.workspaces) {
        if (!entry || typeof entry !== 'object' || typeof entry.rootPath !== 'string' || !isAbsolute(entry.rootPath)) continue
        const mirrorPath = join(entry.rootPath, '.profer', 'automations.json')
        assertProjectPathSafe(entry.rootPath, mirrorPath)
        // 镜像存在但里面没有任务时不算“可能遗漏”，否则一个空镜像就能让 Core 起不来；
        // 解析失败按“可能有任务”处理，仍然拒绝启动，避免真的丢任务。
        const mirrorHasTasks = (file: string): boolean => {
          try {
            const body: unknown = JSON.parse(readFileSync(file, 'utf8'))
            if (!body || typeof body !== 'object' || !('automations' in body) || !Array.isArray((body as { automations?: unknown }).automations)) return true
            return (body as { automations: unknown[] }).automations.length > 0
          } catch { return true }
        }
        if ([mirrorPath, `${mirrorPath}.bak`, `${mirrorPath}.tmp`].some(file => existsSync(file) && mirrorHasTasks(file))) {
          throw new Error('桌面Automation主文件缺失但项目有任务镜像，拒绝遗漏任务')
        }
      }
    }
    return
  }
  if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) throw new Error('桌面Automation源文件不安全')
  const bytes = readFileSync(path)
  const fingerprint = createHash('sha256').update(bytes).digest('hex')
  const current = store.read()
  const receipt = current.operations?.find(item => item.id === IMPORT_ID)
  if (receipt) {
    if (receipt.fingerprint !== fingerprint) throw new Error('桌面Automation源文件在接管后变化，拒绝覆盖Core数据或重复导入')
    return
  }
  const parsed: unknown = JSON.parse(bytes.toString('utf8'))
  if (!parsed || typeof parsed !== 'object' || !('version' in parsed) || !Number.isInteger(parsed.version)
    || typeof parsed.version !== 'number' || parsed.version < 1 || parsed.version > 4
    || !('automations' in parsed) || !Array.isArray(parsed.automations)
    || ('triggers' in parsed && !Array.isArray(parsed.triggers))
    || (parsed.version === 4 && !('triggers' in parsed))) throw new Error('桌面Automation交接快照版本或结构无效，源数据保留')
  const sourceVersion = parsed.version
  const missingTriggerLedger = !('triggers' in parsed)
  if (current.automations.length || current.triggers?.length) throw new Error('Core已有Automation数据且无原交接凭证，拒绝猜测合并')
  const tasks = structuredClone(parsed.automations) as Automation[]
  const triggers = structuredClone('triggers' in parsed ? parsed.triggers : []) as AutomationTriggerRecord[]
  // 项目镜像可能携带尚未进入中央索引的任务；不能在交接时静默漏掉再删除其绑定。
  if (existsSync(config.desktopWorkspaceIndexPath)) {
    const workspaceIndex: unknown = JSON.parse(readFileSync(config.desktopWorkspaceIndexPath, 'utf8'))
    if (!workspaceIndex || typeof workspaceIndex !== 'object' || !('version' in workspaceIndex) || workspaceIndex.version !== 4
      || !('workspaces' in workspaceIndex) || !Array.isArray(workspaceIndex.workspaces)) throw new Error('桌面工作区索引无效，无法核对Automation镜像')
    for (const entry of workspaceIndex.workspaces) {
      if (!entry || typeof entry !== 'object') throw new Error('桌面工作区条目无效')
      if (typeof entry.rootPath !== 'string' || !isAbsolute(entry.rootPath)) continue
      const mirrorPath = join(entry.rootPath, '.profer', 'automations.json')
      assertProjectPathSafe(entry.rootPath, mirrorPath)
      if (!existsSync(mirrorPath)) {
        if (existsSync(`${mirrorPath}.bak`) || existsSync(`${mirrorPath}.tmp`)) throw new Error('项目Automation镜像缺失但有恢复文件，拒绝猜测任务范围')
        continue
      }
      if (lstatSync(mirrorPath).isSymbolicLink() || !lstatSync(mirrorPath).isFile()) throw new Error('项目Automation镜像路径不安全')
      const mirror: unknown = JSON.parse(readFileSync(mirrorPath, 'utf8'))
      if (!mirror || typeof mirror !== 'object' || !('version' in mirror) || mirror.version !== 1
        || !('automations' in mirror) || !Array.isArray(mirror.automations) || !('triggers' in mirror) || !Array.isArray(mirror.triggers)) throw new Error('项目Automation镜像格式无效，拒绝遗漏任务')
      for (const task of mirror.automations) {
        const central = tasks.find(item => item.id === task?.id)
        if (!central || central.workspaceId !== entry.id || !Number.isFinite(task.updatedAt) || task.updatedAt > central.updatedAt
          || task.updatedAt === central.updatedAt && canonical(task) !== canonical(central)) throw new Error('项目Automation镜像有未对账任务，先完成原宿主对账再交接')
      }
      for (const trigger of mirror.triggers) {
        const central = triggers.find(item => item.triggerId === trigger?.triggerId)
        if (!central || central.automationId !== trigger.automationId || !Number.isFinite(trigger.updatedAt) || trigger.updatedAt > central.updatedAt
          || trigger.updatedAt === central.updatedAt && canonical(trigger) !== canonical(central)) throw new Error('项目Automation镜像有未对账触发记录，拒绝交接')
      }
    }
  }
  if (sourceVersion < 4) {
    // 共享旧规则会丢弃非法值；交接必须先拒绝它们，不能把损坏数据修成另一份任务。
    for (const task of tasks) {
      if (!task || typeof task !== 'object') throw new Error('旧Automation条目无效')
      const raw = task as unknown as Record<string, unknown>
      if (raw.permissionMode !== undefined && raw.permissionMode !== 'auto' && raw.permissionMode !== 'bypassPermissions') throw new Error('旧Automation权限模式无法确认')
      if (raw.sessionMode !== undefined && !['new', 'daily', 'reuse'].includes(String(raw.sessionMode))) throw new Error('旧Automation会话模式无效')
      for (const [field, validate] of [
        ['timeOfDay', (value: unknown) => typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value)],
        ['dayOfWeek', (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 6],
        ['dayOfMonth', (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 31],
      ] as const) {
        const value = raw[field]
        if (value !== undefined && !(Array.isArray(value) ? value : [value]).every(validate)) throw new Error(`旧Automation ${field}无效`)
      }
    }
    migrateLegacyAutomationFields({ version: sourceVersion, automations: tasks, triggers })
    for (const task of tasks) {
      // 旧调度器对空数组使用这些既有默认值；显式固化，不改变旧墙上时间语义。
      if (['daily', 'weekly', 'monthly'].includes(task.scheduleType) && !task.timeOfDay?.length) task.timeOfDay = [...DEFAULT_TIME_OF_DAY]
      if (task.scheduleType === 'weekly' && !task.dayOfWeek?.length) task.dayOfWeek = [...DEFAULT_DAY_OF_WEEK]
      if (task.scheduleType === 'monthly' && !task.dayOfMonth?.length) task.dayOfMonth = [...DEFAULT_DAY_OF_MONTH]
    }
    if (missingTriggerLedger) for (const task of tasks) {
      task.active = false
      task.dispatchBlockReason = '旧版本缺少trigger账本，无法确认历史执行；请核对后显式启用'
    }
  }
  const ids = new Set<string>(), triggerIds = new Set<string>()
  for (const task of tasks) {
    if (!task || !idValid(task.id) || ids.has(task.id) || typeof task.name !== 'string' || typeof task.prompt !== 'string'
      || typeof task.active !== 'boolean' || !Number.isFinite(task.createdAt) || !Number.isFinite(task.updatedAt) || !Number.isFinite(task.nextRunAt)
      || !Array.isArray(task.runHistory) || !['interval', 'daily', 'weekly', 'monthly', 'once'].includes(task.scheduleType)
      || (task.workspaceId !== undefined && !idValid(task.workspaceId)) || (task.agentRuntime !== undefined && !['claude', 'pi'].includes(task.agentRuntime))
      || (task.permissionMode !== undefined && task.permissionMode !== 'bypassPermissions')
      || (task.sessionMode !== undefined && !['daily', 'reuse'].includes(task.sessionMode))) throw new Error('桌面Automation定义身份或格式无效，源数据保留')
    ids.add(task.id)
    assertAutomationNotificationTargets(task.notificationTargets)
    // 通知配置随历史保留；无宿主时由Core outbox保留待投递状态。
    if (task.scheduleType === 'interval' && (!Number.isFinite(task.intervalMinutes) || task.intervalMinutes < 1)) throw new Error('旧Automation间隔无效')
    if (task.scheduleType === 'once' && !Number.isFinite(task.scheduledAt)) throw new Error('旧Automation一次性时间无效')
    if (['daily', 'weekly', 'monthly'].includes(task.scheduleType) && (!Array.isArray(task.timeOfDay) || !task.timeOfDay.length || task.timeOfDay.some(time => typeof time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)))) throw new Error('旧Automation墙上时间无效')
    if (task.scheduleType === 'weekly' && (!Array.isArray(task.dayOfWeek) || !task.dayOfWeek.length || task.dayOfWeek.some(day => !Number.isInteger(day) || day < 0 || day > 6))) throw new Error('旧Automation星期无效')
    if (task.scheduleType === 'monthly' && (!Array.isArray(task.dayOfMonth) || !task.dayOfMonth.length || task.dayOfMonth.some(day => !Number.isInteger(day) || day < 1 || day > 31))) throw new Error('旧Automation日期无效')
    for (const run of task.runHistory) if (!run || !Number.isFinite(run.runAt) || typeof run.sessionId !== 'string' || !['success', 'error', 'skipped'].includes(run.status)) throw new Error('旧Automation运行历史无效')
    task.timeZone ??= zone
    try { new Intl.DateTimeFormat('en-US', { timeZone: task.timeZone }).format(now) } catch { throw new Error('旧Automation已存时区无效') }
    if (task.pendingTriggers !== undefined) throw new Error('旧Automation源文件包含派生pendingTriggers字段，拒绝当作权威快照')
  }
  for (const trigger of triggers) {
    if (!trigger || typeof trigger.triggerId !== 'string' || !trigger.triggerId || triggerIds.has(trigger.triggerId) || !ids.has(trigger.automationId)
      || !Number.isFinite(trigger.scheduledAt) || !Number.isFinite(trigger.createdAt) || !Number.isFinite(trigger.updatedAt)
      || !['queued', 'blocked', 'running', 'interrupted', 'completed', 'failed', 'cancelled'].includes(trigger.status)) throw new Error('旧Automation触发记录身份或格式无效')
    triggerIds.add(trigger.triggerId)
    // 桌面Run账本并未转移；未确认的旧副作用绝不能因为换主管而重放。
    if (nonterminal.has(trigger.status)) {
      trigger.status = 'interrupted'
      trigger.error = '桌面交接时旧trigger执行结果未确认；需人工检查后显式处理，不自动重放'
      trigger.updatedAt = now
      tasks.find(task => task.id === trigger.automationId)!.active = false
    }
  }
  const next: AutomationsIndex = { ...current, automations: tasks, triggers,
    operations: [...(current.operations ?? []), { id: IMPORT_ID, fingerprint, result: { importedAt: now, sourceVersion, missingTriggerLedger, timeZone: zone, automationIds: tasks.map(task => task.id), triggerIds: triggers.map(trigger => trigger.triggerId) } }] }
  store.write(next)
}
