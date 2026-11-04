/**
 * 项目定时任务镜像（`<root>/.profer/automations.json`）
 *
 * 与项目会话索引同策略：全局 `~/.profer/automations.json` 是实时权威，
 * 项目文件是该工作区任务的可移植副本；启动/打开项目时对账，项目拷来即可恢复任务。
 */

import { join } from 'node:path'
import type { Automation, AutomationTriggerRecord } from '@profer/shared'
import { readJsonFileSafe, writeJsonFileAtomic } from './safe-file'

export const PROJECT_AUTOMATIONS_VERSION = 1

export interface ProjectAutomationsFile {
  version?: number
  automations?: unknown
  triggers?: unknown
}

export function projectAutomationsPath(rootPath: string): string {
  return join(rootPath, '.profer', 'automations.json')
}

function isAutomation(value: unknown): value is Automation {
  if (!value || typeof value !== 'object') return false
  const automation = value as Partial<Automation>
  return typeof automation.id === 'string' && automation.id.length > 0
    && typeof automation.name === 'string'
    && typeof automation.prompt === 'string'
}

function isTrigger(value: unknown): value is AutomationTriggerRecord {
  if (!value || typeof value !== 'object') return false
  const trigger = value as Partial<AutomationTriggerRecord>
  return typeof trigger.triggerId === 'string' && typeof trigger.automationId === 'string'
}

export function readProjectAutomations(rootPath: string): {
  automations: Automation[]
  triggers: AutomationTriggerRecord[]
} | null {
  const data = readJsonFileSafe<ProjectAutomationsFile>(projectAutomationsPath(rootPath))
  if (!data) return null
  return {
    automations: Array.isArray(data.automations) ? data.automations.filter(isAutomation) : [],
    triggers: Array.isArray(data.triggers) ? data.triggers.filter(isTrigger) : [],
  }
}

export function writeProjectAutomations(
  rootPath: string,
  automations: readonly Automation[],
  triggers: readonly AutomationTriggerRecord[],
): void {
  writeJsonFileAtomic(projectAutomationsPath(rootPath), {
    version: PROJECT_AUTOMATIONS_VERSION,
    automations: [...automations],
    triggers: [...triggers],
  })
}
