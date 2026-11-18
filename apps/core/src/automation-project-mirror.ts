import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, realpathSync, readFileSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentWorkspace, Automation, AutomationRun, AutomationNotificationTarget, AutomationTriggerRecord } from '@profer/shared'
import type { AutomationsIndex } from '@profer/agent-runtime/automation-manager'
import { assertProjectPathSafe } from '@profer/session-store/project-session-paths'

export interface CoreAutomationMirrorState {
  workspaceId: string
  rootPath: string
  pending: boolean
  knownAutomationIds: string[]
  lastHash?: string
  error?: string
}
export interface CoreAutomationNotification {
  id: string
  automation: Automation
  run: AutomationRun
  target: AutomationNotificationTarget
  status: 'pending' | 'sending' | 'delivered' | 'uncertain'
  error?: string
}
export interface CoreAutomationIndex extends AutomationsIndex { projectMirrors?: CoreAutomationMirrorState[]; notificationOutbox?: CoreAutomationNotification[] }

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  return JSON.stringify(value) ?? 'undefined'
}
const hash = (bytes: string) => createHash('sha256').update(bytes).digest('hex')

/** 显式读取项目副本，不从恢复残片猜测数据。 */
export function readAutomationMirror(workspace: AgentWorkspace): { automations: Automation[]; triggers: AutomationTriggerRecord[]; hash: string } {
  const root = workspace.rootPath
  if (workspace.storageMode !== 'project' || !root || !existsSync(root) || lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory() || realpathSync(root) !== root) throw new Error('项目Automation镜像根目录不可用')
  const path = join(root, '.profer', 'automations.json')
  assertProjectPathSafe(root, path)
  if (!existsSync(path) || lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) throw new Error('项目Automation镜像不存在或路径不安全')
  const raw = readFileSync(path, 'utf8')
  const value: unknown = JSON.parse(raw)
  if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1 || !('automations' in value) || !Array.isArray(value.automations) || !('triggers' in value) || !Array.isArray(value.triggers)) throw new Error('项目Automation镜像格式无效')
  const ids = new Set<string>(), triggerIds = new Set<string>()
  for (const task of value.automations) {
    if (!task || typeof task.id !== 'string' || !task.id || ids.has(task.id) || typeof task.name !== 'string' || typeof task.prompt !== 'string' || typeof task.active !== 'boolean' || !Number.isFinite(task.updatedAt) || !Number.isFinite(task.nextRunAt) || !Array.isArray(task.runHistory)) throw new Error('项目Automation定义无效')
    ids.add(task.id)
  }
  for (const trigger of value.triggers) {
    if (!trigger || typeof trigger.triggerId !== 'string' || !trigger.triggerId || triggerIds.has(trigger.triggerId) || !ids.has(trigger.automationId) || !Number.isFinite(trigger.updatedAt) || !Number.isFinite(trigger.scheduledAt) || !['queued', 'blocked', 'running', 'interrupted', 'completed', 'failed', 'cancelled'].includes(trigger.status)) throw new Error('项目Automation触发记录无效')
    triggerIds.add(trigger.triggerId)
  }
  return { automations: value.automations, triggers: value.triggers, hash: hash(raw) }
}

/** 与中央业务写入同次提交的投影意图。移动/删除也保留原归属ID，便于清空旧镜像。 */
export function markAutomationMirrors(index: CoreAutomationIndex, workspaces: readonly AgentWorkspace[]): CoreAutomationIndex {
  const states = structuredClone(index.projectMirrors ?? [])
  for (const workspace of workspaces) {
    if (workspace.storageMode !== 'project' || !workspace.rootPath) continue
    let state = states.find(item => item.workspaceId === workspace.id)
    if (state && state.rootPath !== workspace.rootPath) {
      // 重新定位不能继承旧目录的覆盖凭证；原目录不再写入。
      Object.assign(state, { rootPath: workspace.rootPath, lastHash: undefined, knownAutomationIds: [], error: undefined })
    }
    if (!state) { state = { workspaceId: workspace.id, rootPath: workspace.rootPath, pending: true, knownAutomationIds: [] }; states.push(state) }
    state.pending = true
  }
  return { ...index, projectMirrors: states }
}

/** 只写当前仍绑定的项目，不自动把项目副本当作Core权威；冲突保留待处理。 */
export function writeAutomationMirror(index: CoreAutomationIndex, state: CoreAutomationMirrorState, workspace: AgentWorkspace): CoreAutomationMirrorState {
  if (workspace.id !== state.workspaceId || workspace.storageMode !== 'project' || workspace.rootPath !== state.rootPath) throw new Error('项目Automation镜像绑定已变化')
  const root = state.rootPath
  if (!existsSync(root) || !lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink() || realpathSync(root) !== root) throw new Error('项目Automation镜像根目录缺失或身份变化')
  const configDir = join(root, '.profer'), path = join(configDir, 'automations.json')
  for (const candidate of [configDir, path, join(configDir, 'profer.json')]) {
    assertProjectPathSafe(root, candidate)
    let stats
    try { stats = lstatSync(candidate) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error }
    if (stats.isSymbolicLink() || (candidate === configDir ? !stats.isDirectory() : !stats.isFile())) throw new Error('项目Automation镜像路径不安全')
  }
  if (!existsSync(configDir)) throw new Error('项目配置目录缺失，镜像不自动重建项目')
  const manifestPath = join(configDir, 'profer.json')
  if (existsSync(manifestPath)) {
    const manifest: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || ('schema' in manifest && manifest.schema !== 'profer.project/1')) throw new Error('项目清单版本或格式不支持镜像写入')
  }
  const automations = index.automations.filter(item => item.workspaceId === workspace.id)
  const ids = new Set(automations.map(item => item.id))
  const triggers = (index.triggers ?? []).filter(item => ids.has(item.automationId))
  let previous: Record<string, unknown> = {}, raw: string | undefined
  if (existsSync(path)) {
    raw = readFileSync(path, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !('version' in parsed) || parsed.version !== 1
      || !('automations' in parsed) || !Array.isArray(parsed.automations) || !('triggers' in parsed) || !Array.isArray(parsed.triggers)) throw new Error('项目Automation镜像损坏或未来版本，拒绝覆盖')
    previous = parsed as Record<string, unknown>
    const matchesCurrent = canonical(parsed.automations) === canonical(automations) && canonical(parsed.triggers) === canonical(triggers)
    if (state.lastHash) {
      if (hash(raw) !== state.lastHash && !matchesCurrent) throw new Error('项目Automation镜像被外部修改，拒绝覆盖')
    } else if (!matchesCurrent) {
      for (const value of parsed.automations) {
        const current = automations.find(item => item.id === value?.id)
        if (!current || value.workspaceId !== workspace.id || !Number.isFinite(value.updatedAt) || value.updatedAt > current.updatedAt
          || value.updatedAt === current.updatedAt && canonical(value) !== canonical(current)) throw new Error('项目Automation镜像含未对账定义，拒绝覆盖')
      }
      for (const value of parsed.triggers) {
        const current = triggers.find(item => item.triggerId === value?.triggerId)
        if (!current || value.automationId !== current.automationId || !Number.isFinite(value.updatedAt) || value.updatedAt > current.updatedAt
          || value.updatedAt === current.updatedAt && canonical(value) !== canonical(current)) throw new Error('项目Automation镜像含未对账触发记录，拒绝覆盖')
      }
    }
  } else if (state.lastHash || existsSync(`${path}.bak`) || existsSync(`${path}.tmp`)) throw new Error('项目Automation镜像缺失或存在待恢复副本，拒绝猜测覆盖')
  const content = `${JSON.stringify({ ...previous, version: 1, automations, triggers }, null, 2)}\n`
  if (raw !== content) {
    const temporary = `${path}.${randomUUID()}.tmp`
    try {
      const fd = openSync(temporary, 'wx', 0o600)
      try { writeFileSync(fd, content); fsyncSync(fd) } finally { closeSync(fd) }
      assertProjectPathSafe(root, path)
      if ((existsSync(path) ? readFileSync(path, 'utf8') : undefined) !== raw) throw new Error('写入期间项目Automation镜像发生变化')
      renameSync(temporary, path)
    } finally { if (existsSync(temporary)) unlinkSync(temporary) }
  }
  return { workspaceId: state.workspaceId, rootPath: root, pending: false, knownAutomationIds: [...ids], lastHash: hash(content) }
}
