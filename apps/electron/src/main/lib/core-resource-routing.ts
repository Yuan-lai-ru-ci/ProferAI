import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { CORE_RESOURCE_OPERATIONS, type CoreResourceScope } from '../../lib/core-resource-channels'
import { localCoreOwnsBusinessData } from './core-business-ownership'
import { getLocalCoreClient } from './core-local-bridge'
import { getActiveCoreClient, listCoreTargets } from './core-target-service'
import type { CoreClient } from './core-client'

interface ResourceClient { resourceOperation<T>(operation: string, args: unknown[]): Promise<T> }
export interface ResourceRoutingSnapshot {
  targetId: string
  generation: number
  ownsBusinessData: boolean
  capabilities: readonly string[]
  client: ResourceClient | null
}
function snapshot(): ResourceRoutingSnapshot {
  const state = listCoreTargets()
  return {
    targetId: state.currentId, generation: state.generation,
    ownsBusinessData: state.currentId !== 'local' || localCoreOwnsBusinessData(),
    capabilities: state.targets.find(target => target.id === state.currentId)?.capabilities ?? [],
    client: state.currentId === 'local' ? getLocalCoreClient() : getActiveCoreClient(),
  }
}
function scopeOf(value: unknown): CoreResourceScope | null {
  if (!value || typeof value !== 'object' || !('__proferCoreResourceScope' in value)) return null
  const scope = value.__proferCoreResourceScope
  if (!scope || typeof scope !== 'object' || !('targetId' in scope) || !('generation' in scope) || typeof scope.targetId !== 'string' || !Number.isSafeInteger(scope.generation)) throw new Error('Core 资源目标 scope 无效')
  return scope as CoreResourceScope
}
const UNSUPPORTED = new Set(['saveMasterSkill', 'renameMasterSkillMeta', 'rollbackMasterSkill', 'syncMasterSkillToWorkspaces', 'exportAgentPresets', 'importAgentPresets', 'rebindAndDisableGlobalPresetScope'])
/** 在 HTTP 前验证调用归属，在响应后验证连接/代际，禁止回落本机。 */
export async function routeCoreResource(channel: string, input: unknown[], readSnapshot = snapshot): Promise<{ result: unknown } | null> {
  const current = readSnapshot()
  const args = input.slice()
  while (args.length > 0 && args[args.length - 1] === undefined) args.pop()
  const scope = scopeOf(args.at(-1))
  if (scope) args.pop()
  while (args.length > 0 && args[args.length - 1] === undefined) args.pop()
  if (scope && (scope.targetId !== current.targetId || scope.generation !== current.generation)) throw new Error('Core 已切换，资源请求目标已过期')
  if (!current.ownsBusinessData) return null
  if (!scope) throw new Error('Core 资源请求缺少目标 scope')
  if (!current.client) throw new Error('当前 Core 未连接，不能访问资源；不会回退本机')
  if (!current.capabilities.includes('resources.manage')) throw new Error('当前 Core 不支持 resources.manage；不会回退本机')
  let operation = CORE_RESOURCE_OPERATIONS[channel]
  if (!operation || UNSUPPORTED.has(operation)) throw new Error(`当前 Core 不支持资源操作: ${operation ?? channel}`)
  if (operation === 'getAllWorkspaceSkills') args.push(true)
  // 全局预设沿用同一个 CRUD 契约，显式 null 表示用户全局作用域。
  if (operation === 'createGlobalAgentPreset' || operation === 'updateGlobalAgentPreset') {
    operation = operation === 'createGlobalAgentPreset' ? 'createAgentPreset' : 'updateAgentPreset'
    args.unshift(null)
  } else if (operation === 'deleteGlobalAgentPreset') {
    const reference = args[0]
    if (!reference || typeof reference !== 'object' || !('presetScope' in reference) || reference.presetScope !== 'user-global'
      || !('presetId' in reference) || typeof reference.presetId !== 'string' || !reference.presetId.trim()) throw new Error('只允许删除明确引用的用户全局预设')
    operation = 'deleteAgentPreset'
    args.splice(0, args.length, null, reference.presetId)
  }
  // 全局 Skill 协议与 ElectronAPI 保持相同参数顺序。
  const response = await current.client.resourceOperation<unknown>(operation, args)
  const latest = readSnapshot()
  if (latest.targetId !== current.targetId || latest.generation !== current.generation || latest.client !== current.client) throw new Error('Core 已切换，忽略旧 Core 资源响应')
  return { result: response }
}
export function registerCoreResourceHandler(channel: string, fallback: (event: IpcMainInvokeEvent, ...args: never[]) => unknown): void {
  if (!CORE_RESOURCE_OPERATIONS[channel]) throw new Error(`未注册 Core 资源通道: ${channel}`)
  ipcMain.handle(channel, async (event, ...input: unknown[]) => {
    const routed = await routeCoreResource(channel, input)
    if (routed) return routed.result
    const args = input.slice()
    if (scopeOf(args.at(-1))) args.pop()
    return fallback(event, ...args as never[])
  })
}
