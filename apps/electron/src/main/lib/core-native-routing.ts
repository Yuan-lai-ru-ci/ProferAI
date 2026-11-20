import type { CoreClient } from './core-client'
import { getLocalCoreClient } from './core-local-bridge'
import { currentCoreId, getActiveCoreClient, getCoreTargetGeneration, getCurrentCoreTargetId, namespaceCoreSessionId, parseCoreSessionId } from './core-target-service'

export interface CoreNativeRoute {
  client: CoreClient
  coreId: string
  sessionId: string
  generation: number
  assertCurrent(): void
  projectSessionId(id: string): string
}

/** 捕获命令的 Core 与连接实例；等待期间切换目标不能把结果写入另一个 Core。 */
export function captureCoreNativeRoute(sessionId: string): CoreNativeRoute | null {
  if (typeof sessionId !== 'string' || !sessionId.trim()) throw new Error('会话标识不能为空')
  const local = getCurrentCoreTargetId() === 'local'
  const owner = parseCoreSessionId(sessionId)
  if (local && owner) throw new Error('会话不属于当前本机 Core')
  const client = local ? getLocalCoreClient() : getActiveCoreClient()
  if (local && !client && process.env.PROFER_CORE_LOCAL !== '1') return null
  const coreId = local ? 'local' : currentCoreId()
  if (!coreId || !client) throw new Error('当前 Core 未连接，不能访问会话历史')
  if (!local && (!owner || owner.coreId !== coreId)) throw new Error('会话不属于当前 Core')
  const generation = getCoreTargetGeneration()
  return {
    client, coreId, sessionId: owner?.sessionId ?? sessionId, generation,
    assertCurrent() {
      if (getCoreTargetGeneration() !== generation || (getCurrentCoreTargetId() === 'local') !== local
        || (local ? getLocalCoreClient() : getActiveCoreClient()) !== client
        || (!local && currentCoreId() !== coreId)) throw new Error('Core 已切换，忽略旧会话响应')
    },
    projectSessionId(id) { return local ? id : namespaceCoreSessionId(id, coreId) },
  }
}

export interface CoreNativeSnapshot {
  sessionId: string
  revision: string
  metadataRevision: number
  unchanged: boolean
  meta?: import('@profer/shared').AgentSessionMeta
  messages?: import('@profer/shared').SDKMessage[]
}
export type CoreNativeOperation = 'fork' | 'rewind' | 'graph' | 'graph_summary' | 'graph_append' | 'harness' | 'rewind_prepare' | 'rewind_refine' | 'rewind_execute' | 'rewind_undo' | 'rewind_submit'
export interface CoreNativeTransport {
  snapshot(client: CoreClient, sessionId: string, since?: string): Promise<CoreNativeSnapshot>
  operation<T>(client: CoreClient, sessionId: string, operation: CoreNativeOperation, input: Record<string, unknown>): Promise<T>
}

/** 所有历史写命令绑定同一次读取的内容 revision；不在冲突后自动重读重试。 */
export async function routeCoreNativeOperation<T>(sessionId: string, operation: CoreNativeOperation,
  input: Record<string, unknown>, transport: CoreNativeTransport): Promise<{ result: T } | null> {
  const route = captureCoreNativeRoute(sessionId)
  if (!route) return null
  const mutating = operation === 'fork' || operation === 'rewind' || operation === 'graph_append'
  let revision = input.revision
  if (mutating && (typeof revision !== 'string' || !revision)) {
    const snapshot = await transport.snapshot(route.client, route.sessionId)
    route.assertCurrent()
    if (snapshot.sessionId !== route.sessionId || !snapshot.revision) throw new Error('Core 历史快照归属或修订号无效')
    revision = snapshot.revision
  }
  const result = await transport.operation<T>(route.client, route.sessionId, operation, { ...input, ...(mutating ? { revision } : {}) })
  route.assertCurrent()
  if (result && typeof result === 'object' && 'sessionId' in result) {
    return { result: { ...result, sessionId: route.projectSessionId(route.sessionId), ...('plan' in result && result.plan && typeof result.plan === 'object' ? { plan: { ...result.plan, sessionId: route.projectSessionId(route.sessionId) } } : {}) } as T }
  }
  if (result && typeof result === 'object' && 'plan' in result && result.plan && typeof result.plan === 'object') return { result: { ...result, plan: { ...result.plan, sessionId: route.projectSessionId(route.sessionId) } } as T }
  return { result }
}

export async function invokeCoreNative<T>(sessionId: string, operation: CoreNativeOperation, input: object = {}): Promise<{ result: T } | null> {
  return routeCoreNativeOperation<T>(sessionId, operation, input as Record<string, unknown>, {
    snapshot: (client, id, since) => client.nativeSnapshot(id, since),
    operation: (client, id, op, args) => client.nativeOperation(id, op, args),
  })
}
export async function forkCoreNative(input: import('@profer/shared').ForkSessionInput): Promise<import('@profer/shared').AgentSessionMeta | null> {
  const route = captureCoreNativeRoute(input.sessionId)
  if (!route) return null
  const snapshot = await route.client.nativeSnapshot(route.sessionId)
  route.assertCurrent()
  const result = await route.client.nativeOperation<import('@profer/shared').AgentSessionMeta>(route.sessionId, 'fork', { ...input, sessionId: route.sessionId, revision: snapshot.revision })
  route.assertCurrent()
  return { ...result, id: route.projectSessionId(result.id), parentSessionId: result.parentSessionId ? route.projectSessionId(result.parentSessionId) : undefined }
}
