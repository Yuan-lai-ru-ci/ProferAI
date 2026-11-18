export { computeNextRunAt } from '@profer/agent-runtime/automation-schedule'
import { computeNextRunAt } from '@profer/agent-runtime/automation-schedule'
/**
 * 定时任务（Automation）管理器
 *
 * 负责定时任务的 CRUD 与运行历史持久化。
 * - 索引文件：~/.profer/automations.json
 *
 * 照搬 agent-session-manager.ts 的原子写模式（safe-file）。
 * 调度逻辑见 automation-scheduler.ts，本文件只管数据。
 */

import { randomUUID } from 'node:crypto'
import { writeJsonFileAtomic, readJsonFileSafe } from './safe-file'
import { getAutomationsPath } from './config-paths'
import { readProjectAutomations, writeProjectAutomations } from './project-automation-store'
import {
  AUTOMATION_MAX_HISTORY,
  AUTOMATION_DEFAULT_PERMISSION_MODE,
  normalizeTimeOfDay,
  normalizeDayOfWeek,
  normalizeDayOfMonth,
  DEFAULT_TIME_OF_DAY,
  DEFAULT_DAY_OF_WEEK,
  DEFAULT_DAY_OF_MONTH,
  type Automation,
  type AutomationRun,
  type CreateAutomationInput,
  type UpdateAutomationInput,
  type AutomationTriggerRecord,
  type AutomationPendingTrigger,
} from '@profer/shared'
import { presetReferenceForId, resolvePresetReference } from './agent-preset-manager'
import { enqueueAutomationTrigger as enqueueTrigger, normalizeAutomationTriggerRecords, transitionAutomationTrigger, validateBoundAutomationChannel, validateBoundAutomationSession } from './automation-dispatch'

/** 索引文件格式 */
interface AutomationsIndex {
  version: number
  automations: Automation[]
  triggers?: AutomationTriggerRecord[]
}

const INDEX_VERSION = 4
let coreOwnsAutomations = false

/** Core启动前冻结旧定义/触发账本；失败时不交还桌面调度权。 */
export function claimAutomationsForCore(): void {
  coreOwnsAutomations = true
  cachedIndex = null
}
function assertDesktopAutomationWriter(): void {
  if (coreOwnsAutomations) throw new Error('Automation已由本机Core接管，桌面不得写入旧账本')
}

/**
 * 把自动任务的预设 ID 解析为引用，并拒绝停用或不存在的预设。
 * 创建与更新共用此入口：界面过滤不能替代主进程校验，绕过界面的调用也不能写入停用预设。
 */
function presetReferenceForAutomation(workspaceId: string | undefined, presetId: string) {
  const { getAgentWorkspace } = require('./agent-workspace-manager') as typeof import('./agent-workspace-manager')
  const workspaceSlug = workspaceId ? getAgentWorkspace(workspaceId)?.slug : undefined
  // 停用是按工作区判定的：没有工作区上下文时无法确认预设可用，草稿也不能携带未校验的预设引用
  if (!workspaceSlug) throw new Error('指定预设前需要先选择工作区')
  const reference = presetReferenceForId(workspaceSlug, presetId)
  resolvePresetReference(reference, workspaceSlug)
  return reference
}

function assertValidBoundAutomation(automation: Pick<Automation, 'boundSessionId' | 'workspaceId' | 'channelId' | 'modelId' | 'agentRuntime' | 'presetId'>): void {
  if (!automation.boundSessionId) return
  const { getAgentSessionMeta } = require('./agent-session-manager') as typeof import('./agent-session-manager')
  const { getAgentWorkspace } = require('./agent-workspace-manager') as typeof import('./agent-workspace-manager')
  const { resolvePresetId, getDefaultPresetId } = require('./agent-preset-manager') as typeof import('./agent-preset-manager')
  const { getVisibleChannelById } = require('./channel-manager') as typeof import('./channel-manager')
  const session = getAgentSessionMeta(automation.boundSessionId)
  const workspaceSlug = automation.workspaceId ? getAgentWorkspace(automation.workspaceId)?.slug : undefined
  const expectedPresetId = automation.presetId
    ? resolvePresetId(workspaceSlug, automation.presetId)
    : getDefaultPresetId(workspaceSlug)
  const result = validateBoundAutomationSession(automation, session, expectedPresetId)
  if (!result.valid) throw new Error(`目标会话绑定无效：${result.reason}`)
  const channel = getVisibleChannelById(automation.channelId)
  const availability = validateBoundAutomationChannel(automation, session!, channel)
  if (!availability.valid) throw new Error(`目标会话绑定无效：${availability.reason}`)
}

/**
 * 内存缓存：避免每次操作都从磁盘读取完整索引。
 * 所有写入操作同时更新缓存和磁盘（write-through），保证一致性。
 * 由于 readFileSync/writeFileSync 是同步的，Node 事件循环不会在 read-modify-write 中间让出，
 * 因此不存在并发竞态。缓存的作用是减少冗余磁盘 I/O。
 */
let cachedIndex: AutomationsIndex | null = null

interface ProjectAutomationMirror {
  id: string
  rootPath: string
}

function listProjectAutomationMirrors(): ProjectAutomationMirror[] {
  // 延迟 require：工作区管理器与定时任务管理器共享索引文件，避免顶层循环依赖。
  const { listAgentWorkspaces } = require('./agent-workspace-manager') as typeof import('./agent-workspace-manager')
  return listAgentWorkspaces()
    .filter((workspace) => workspace.storageMode === 'project' && typeof workspace.rootPath === 'string' && workspace.rootPath.length > 0)
    .map((workspace) => ({ id: workspace.id, rootPath: workspace.rootPath! }))
}

const mirroredAutomationSignatures = new Map<string, string>()
const reconciledAutomationRoots = new Set<string>()

function automationMirrorSignature(
  automations: readonly Automation[],
  triggers: readonly AutomationTriggerRecord[],
): string {
  const automationPart = automations
    .map((automation) => `${automation.id}:${automation.updatedAt ?? 0}:${automation.active ? 1 : 0}:${automation.name}`)
    .join('|')
  const triggerPart = triggers
    .map((trigger) => `${trigger.triggerId}:${trigger.updatedAt ?? 0}:${trigger.status}`)
    .join('|')
  return `${automationPart}##${triggerPart}`
}

/** 把全局索引里属于各 project 的任务镜像到 `<root>/.profer/automations.json`。 */
function mirrorProjectAutomations(index: AutomationsIndex): void {
  const mirrors = listProjectAutomationMirrors()
  if (mirrors.length === 0) return

  for (const mirror of mirrors) {
    const automations = index.automations.filter((automation) => automation.workspaceId === mirror.id)
    const automationIds = new Set(automations.map((automation) => automation.id))
    const triggers = (index.triggers ?? []).filter((trigger) => automationIds.has(trigger.automationId))
    const signature = automationMirrorSignature(automations, triggers)
    const cacheKey = `${mirror.id}|${mirror.rootPath}`
    if (mirroredAutomationSignatures.get(cacheKey) === signature) continue
    try {
      writeProjectAutomations(mirror.rootPath, automations, triggers)
      mirroredAutomationSignatures.set(cacheKey, signature)
    } catch (error) {
      console.warn(`[定时任务] 写入项目任务镜像失败 (${mirror.rootPath}):`, error)
    }
  }
}

/** 启动/打开项目时把项目镜像里更新的任务合并回全局。 */
function reconcileProjectAutomations(index: AutomationsIndex): boolean {
  let changed = false
  index.triggers = index.triggers ?? []

  for (const mirror of listProjectAutomationMirrors()) {
    if (reconciledAutomationRoots.has(mirror.rootPath)) continue
    reconciledAutomationRoots.add(mirror.rootPath)
    const file = readProjectAutomations(mirror.rootPath)
    if (!file) continue

    const workspaceSlug = (() => {
      const { getAgentWorkspace } = require('./agent-workspace-manager') as typeof import('./agent-workspace-manager')
      return getAgentWorkspace(mirror.id)?.slug
    })()
    for (const automation of file.automations) {
      const normalized: Automation = { ...automation, workspaceId: mirror.id }
      // 项目拷到新机器后 slug 可能变化：工作区级预设引用改指当前项目。
      if (workspaceSlug && normalized.presetReference?.presetScope === 'workspace') {
        normalized.presetReference = { ...normalized.presetReference, workspaceSlug }
      }
      const existing = index.automations.find((item) => item.id === normalized.id)
      if (!existing) {
        index.automations.push(normalized)
        changed = true
        continue
      }
      if ((normalized.updatedAt ?? 0) > (existing.updatedAt ?? 0)) {
        Object.assign(existing, normalized)
        changed = true
      }
    }

    for (const trigger of file.triggers) {
      const existing = index.triggers.find((item) => item.triggerId === trigger.triggerId)
      if (!existing) {
        index.triggers.push(trigger)
        changed = true
        continue
      }
      if ((trigger.updatedAt ?? 0) > (existing.updatedAt ?? 0)) {
        Object.assign(existing, trigger)
        changed = true
      }
    }
  }

  return changed
}

function readGlobalIndex(): AutomationsIndex {
  if (cachedIndex) return cachedIndex

  const data = readJsonFileSafe<AutomationsIndex>(getAutomationsPath())
  if (!data) {
    cachedIndex = { version: INDEX_VERSION, automations: [], triggers: [] }
    return cachedIndex
  }
  if (typeof data.version !== 'number') {
    console.warn(`[定时任务] 索引文件缺少有效 version 字段，将忽略其内容`)
    cachedIndex = { version: INDEX_VERSION, automations: [], triggers: [] }
    return cachedIndex
  }
  if (data.version > INDEX_VERSION) {
    // 数据由更高版本的 Profer 写入（用户回滚到旧版的场景）。保留原始 automations 数组只读返回，
    // 避免下次 writeIndex 用空数据覆盖磁盘导致永久丢失任务配置和运行历史。
    console.warn(
      `[定时任务] 索引文件版本 ${data.version} 高于当前构建（${INDEX_VERSION}），将以原数据加载，` +
        `可能存在不识别的字段；请尽量升级到最新版本。`,
    )
    if (!Array.isArray(data.automations)) {
      cachedIndex = { version: INDEX_VERSION, automations: [] }
      return cachedIndex
    }
    cachedIndex = data
    return cachedIndex
  }
  if (!Array.isArray(data.automations)) {
    cachedIndex = { version: INDEX_VERSION, automations: [], triggers: [] }
    return cachedIndex
  }
  const needsTriggerMigration = !Array.isArray(data.triggers)
    || data.triggers.some((trigger) => trigger.status === 'running')
  data.triggers = normalizeAutomationTriggerRecords(Array.isArray(data.triggers) ? data.triggers : [], Date.now())
  const migrated = migrateLegacyAutomationFields(data) || needsTriggerMigration
  cachedIndex = data
  if (migrated) {
    writeIndex(data)
    console.log('[定时任务] 索引已迁移至最新版本（sessionMode: new → daily，permissionMode: auto → bypassPermissions）')
  }
  return cachedIndex
}

function readIndex(): AutomationsIndex {
  if (coreOwnsAutomations) throw new Error('Automation已由本机Core接管，请从Core查询')
  const index = readGlobalIndex()
  if (reconcileProjectAutomations(index)) {
    try {
      writeJsonFileAtomic(getAutomationsPath(), index)
    } catch (error) {
      console.warn('[定时任务] 项目任务对账后写回全局索引失败:', error)
    }
  }
  return index
}

function writeIndex(index: AutomationsIndex): void {
  assertDesktopAutomationWriter()
  try {
    cachedIndex = index
    writeJsonFileAtomic(getAutomationsPath(), index)
    mirrorProjectAutomations(index)
  } catch (error) {
    cachedIndex = null // 写入失败时丢弃缓存，下次重新从磁盘读取
    console.error('[定时任务] 写入索引文件失败:', error)
    throw new Error('写入定时任务索引失败')
  }
}

import { createAutomationManager, migrateLegacyAutomationFields } from '@profer/agent-runtime/automation-manager'
export const { listAutomations, getAutomation, applyMaxRunsUpdate, createAutomation, updateAutomation, deleteAutomation, pauseAutomationsForWorkspace, getAutomationTrigger, listAutomationTriggers, enqueueAutomationTrigger, transitionAutomationTriggerRecord, linkAutomationTriggerRun, settleAutomationTrigger, getPendingAutomationTrigger, cancelQueuedAutomationTriggers, unblockAutomationTriggers, removeAutomationTriggers, appendRun, setNextRunAt, setLastSessionId } = createAutomationManager({
  readIndex, writeIndex, presetReferenceForAutomation, assertValidBoundAutomation,
  validatePresetReference: (workspaceId, reference) => {
    const { getAgentWorkspace } = require('./agent-workspace-manager') as typeof import('./agent-workspace-manager')
    resolvePresetReference(reference, workspaceId ? getAgentWorkspace(workspaceId)?.slug : undefined)
  },
})

/** 仅测试：清空进程内缓存与镜像签名，回到首次启动状态。 */
export function __resetAutomationManagerForTests(): void {
  cachedIndex = null
  reconciledAutomationRoots.clear()
  mirroredAutomationSignatures.clear()
}

/** 启动时补齐项目任务镜像（不等待下一次写盘）。 */
export function ensureProjectAutomationMirrors(): void {
  if (coreOwnsAutomations) return
  const index = readIndex()
  mirrorProjectAutomations(index)
}
