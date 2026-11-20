import { randomUUID } from 'node:crypto'
import { AUTOMATION_IPC_CHANNELS, type Automation } from '@profer/shared'
import { getLocalCoreClient } from './core-local-bridge'
import { currentCoreId, getActiveCoreClient, getCoreTargetGeneration, getCurrentCoreTargetId, namespaceCoreSessionId, parseCoreSessionId } from './core-target-service'

/** 任务ID与关联会话都带Core身份；工作区/渠道只在已选Core命名空间中解析。 */
export function projectCoreAutomation(task: Automation, coreId: string): Automation {
  const ns = (id?: string) => id ? namespaceCoreSessionId(id, coreId) : id
  return { ...task, id: ns(task.id)!, sourceSessionId: ns(task.sourceSessionId), boundSessionId: ns(task.boundSessionId), lastSessionId: ns(task.lastSessionId),
    runHistory: task.runHistory.map(run => ({ ...run, sessionId: ns(run.sessionId)! })),
    pendingTriggers: task.pendingTriggers?.map(trigger => ({ ...trigger, boundSessionId: ns(trigger.boundSessionId), targetSessionId: ns(trigger.targetSessionId) })) }
}

/** 仅显式local返回null；断线、错误归属和旧响应拒绝，不能回落桌面调度器。 */
export async function routeAutomationToCore(channel: string, args: unknown[]): Promise<{ result: unknown } | null> {
  const local = getCurrentCoreTargetId() === 'local'
  if (local && !getLocalCoreClient() && process.env.PROFER_CORE_LOCAL !== '1') return null
  const client = local ? getLocalCoreClient() : getActiveCoreClient(), coreId = local ? 'local' : currentCoreId(), generation = getCoreTargetGeneration()
  if (!client || !coreId) throw new Error('当前远程Core未连接，不能访问Automation')
  const rawId = (value: unknown): string => {
    if (local && typeof value === 'string' && value && !parseCoreSessionId(value)) return value
    const owner = typeof value === 'string' ? parseCoreSessionId(value) : null
    if (!owner || owner.coreId !== coreId) throw new Error('Automation或关联会话不属于当前Core')
    return owner.sessionId
  }
  let operationId: string = randomUUID()
  let operation: string, input: Record<string, unknown> = {}
  if (channel === AUTOMATION_IPC_CHANNELS.LIST) operation = 'list'
  else if (channel === AUTOMATION_IPC_CHANNELS.CREATE || channel === AUTOMATION_IPC_CHANNELS.UPDATE) {
    if (!args[0] || typeof args[0] !== 'object' || Array.isArray(args[0])) throw new Error('Automation输入必须是对象')
    const fields = { ...args[0] } as Record<string, unknown>
    if (typeof fields.operationId === 'string' && fields.operationId.trim()) operationId = fields.operationId.trim()
    delete fields.operationId
    operation = channel === AUTOMATION_IPC_CHANNELS.CREATE ? 'create' : 'update'
    if (operation === 'update') fields.id = rawId(fields.id)
    for (const field of ['boundSessionId', 'sourceSessionId'] as const) if (fields[field]) fields[field] = rawId(fields[field])
    if (!fields.timeZone && operation === 'create') fields.timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
    input = { input: fields }
  } else if (channel === AUTOMATION_IPC_CHANNELS.TOGGLE) {
    if (typeof args[1] !== 'boolean') throw new Error('active必须是boolean')
    operation = 'update'; input = { input: { id: rawId(args[0]), active: args[1] } }
  } else if (channel === AUTOMATION_IPC_CHANNELS.DELETE || channel === AUTOMATION_IPC_CHANNELS.RUN_NOW) {
    operation = channel === AUTOMATION_IPC_CHANNELS.DELETE ? 'delete' : 'run_now'; input = { id: rawId(args[0]) }
  } else throw new Error('不支持此Automation操作')
  const result = await client.automationRequest<unknown>(operation, { ...input, operationId })
  if ((local ? getLocalCoreClient() : getActiveCoreClient()) !== client || (!local && currentCoreId() !== coreId) || getCoreTargetGeneration() !== generation) throw new Error('Core已切换，忽略旧Automation响应')
  return { result: operation === 'list' ? (result as Automation[]).map(task => local ? task : projectCoreAutomation(task, coreId))
    : operation === 'create' || operation === 'update' ? local ? result : projectCoreAutomation(result as Automation, coreId) : operation === 'run_now' ? undefined : result }
}
