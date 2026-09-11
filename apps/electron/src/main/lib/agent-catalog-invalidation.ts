import type { AgentCatalogInvalidation, AgentCatalogKind } from '@profer/shared'
import type { AgentEventBus } from './agent-event-bus'
import type { AgentStreamPayload } from '@profer/shared'

/** 目录失效发布器：每个 catalog/scope 独立单调递增，通知不携带目录正文。 */
export class AgentCatalogInvalidationPublisher {
  private readonly revisions = new Map<string, number>()

  constructor(private readonly eventBus: AgentEventBus) {}

  invalidate(catalog: AgentCatalogKind, workspaceSlug: string | null = null): AgentCatalogInvalidation {
    const key = `${catalog}:${workspaceSlug ?? '*'}`
    const revision = (this.revisions.get(key) ?? 0) + 1
    this.revisions.set(key, revision)
    const notification: AgentCatalogInvalidation = {
      kind: 'catalog_invalidation',
      catalog,
      workspaceSlug,
      revision,
      changedAt: Date.now(),
    }
    const payload: AgentStreamPayload = notification
    // 目录没有 session 归属；使用保留 scope key 作为 EventBus 路由键，Remote event log
    // 仍会按统一 eventId 记录，客户端按 catalog/scope 去重。
    this.eventBus.emit(`catalog:${key}`, payload)
    return notification
  }
}
