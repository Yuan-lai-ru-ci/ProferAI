import { app } from 'electron'
import { join } from 'node:path'
import type { AgentStreamPayload } from '@profer/shared'
import { CoreHostContentStore } from './core-host-content'
import { CoreHostHandler } from './core-host-handler'
import { createElectronPreviewPort } from './agent-runtime-host'
import { agentFilePreviewSessionManager } from './agent-file-preview-session'
import type { CoreClient } from './core-client'

interface HostConnectionOptions {
  coreId?: string
  contentRoot?: string
  sessionId: (raw: string) => string
  isCurrent: () => boolean
  emitPreview: (sessionId: string, payload: AgentStreamPayload) => void
}

const connectionEpoch = new WeakMap<CoreClient, number>()
let nextEpoch = 0

/** 将宿主 RPC 限制到当前已提交连接及其权威 run 快照。 */
export function configureCoreHostConnection(client: CoreClient, options: HostConnectionOptions): void {
  const epoch = ++nextEpoch
  connectionEpoch.set(client, epoch)
  let coreId = options.coreId
  const runs = new Map<string, Set<string>>()
  const valid = () => connectionEpoch.get(client) === epoch && options.isCurrent()
  const setRun = (sessionId: string, runId: string, active: boolean) => {
    let ids = runs.get(sessionId)
    if (active) {
      if (!ids) runs.set(sessionId, ids = new Set())
      ids.add(runId)
    } else {
      ids?.delete(runId)
      if (!ids?.size) runs.delete(sessionId)
    }
  }
  const handler = new CoreHostHandler({
    get coreId() { return coreId ?? '' },
    contentStore: new CoreHostContentStore(options.contentRoot ?? join(app.getPath('temp'), 'profer-core-host')),
    isBoundRun: (sessionId, runId) => valid() && runs.get(sessionId)?.has(runId) === true,
    previewContext: sessionId => {
      const localSessionId = options.sessionId(sessionId)
      const preview = createElectronPreviewPort({ emit: (_id, payload) => options.emitPreview(localSessionId, payload) }, agentFilePreviewSessionManager)
      const previewSessionId = options.sessionId(sessionId)
      return { onRequest: event => preview.open({ ...event, sessionId: previewSessionId }), onInspectRequest: request => preview.inspect({ ...request, sessionId: previewSessionId }) }
    },
  })

  const unsubscribeSnapshot = client.addSnapshotListener(snapshot => {
    if (!valid()) return
    runs.clear()
    for (const run of snapshot.runs ?? []) {
      if (run.sessionRef && ['running', 'waiting', 'queued'].includes(run.status)) setRun(run.sessionRef, run.id, true)
    }
  })
  const unsubscribeEvents = client.addEventListener(event => {
    if (!valid()) return
    const payload = event.payload as { kind?: string; event?: { type?: string; runId?: string } } | undefined
    const type = payload?.event?.type
    const runId = payload?.event?.runId
    if (runId && (type === 'runtime_started' || type === 'run_completed')) setRun(event.sessionId, runId, type === 'runtime_started')
  })
  const ready = client.identity().then(identity => {
    if (!valid()) throw new Error('Core 宿主连接已失效')
    if (coreId && coreId !== identity.coreId) throw new Error('Core 宿主 RPC 身份不匹配')
    coreId = identity.coreId
  })
  client.setHostRequestHandler(async request => {
    await ready
    return handler.handle(request)
  })
  void ready.catch(error => {
    unsubscribeSnapshot()
    unsubscribeEvents()
    if (connectionEpoch.get(client) === epoch) console.error('[Core] 宿主 RPC 注册失败:', error instanceof Error ? error.message : String(error))
  })
}
