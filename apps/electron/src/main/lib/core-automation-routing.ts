import { getLocalCoreClient } from './core-local-bridge'
import { currentCoreId, getActiveCoreClient, getCoreTargetGeneration, getCurrentCoreTargetId } from './core-target-service'
import type { AutomationMaintenanceInput } from '@profer/shared'

/** 项目副本与通知队列属于当前 Core，旧连接结果不能跨目标发布。 */
export async function routeCoreAutomationMaintenance(input: AutomationMaintenanceInput): Promise<unknown> {
  if (!input || !['mirrors', 'mirror_inspect', 'mirror_restore', 'mirror_resolve', 'mirrors_retry', 'outbox', 'notification_retry'].includes(input.operation)) throw new Error('无效的 Automation 维护操作')
  const local = getCurrentCoreTargetId() === 'local'
  const client = local ? getLocalCoreClient() : getActiveCoreClient()
  const coreId = local ? 'local' : currentCoreId(), generation = getCoreTargetGeneration()
  if (!client || !coreId) throw new Error('当前 Core 未连接，不能维护 Automation')
  if (input.coreGeneration !== undefined && input.coreGeneration !== generation) throw new Error('Core 已切换，请重新检查后操作')
  if (['mirror_restore', 'mirror_resolve', 'notification_retry'].includes(input.operation) && input.coreGeneration === undefined) throw new Error('请先读取当前 Core 状态')
  if (input.operation.startsWith('mirror_') && (!input.workspaceId || typeof input.workspaceId !== 'string')) throw new Error('项目工作区不能为空')
  if (['mirror_restore', 'mirror_resolve'].includes(input.operation) && (!input.expectedHash || typeof input.expectedHash !== 'string')) throw new Error('请先检查项目副本并提供当前哈希')
  if (input.operation === 'notification_retry' && (!input.id || typeof input.id !== 'string')) throw new Error('通知标识不能为空')
  const result = await client.automationRequest(input.operation, { workspaceId: input.workspaceId, expectedHash: input.expectedHash, id: input.id })
  if (generation !== getCoreTargetGeneration() || (local ? getLocalCoreClient() : getActiveCoreClient()) !== client || (!local && currentCoreId() !== coreId)) throw new Error('Core 已切换，忽略旧 Automation 维护响应')
  return { result, coreGeneration: generation }
}
