import { describe, expect, test } from 'bun:test'
import { AgentEventBus } from './agent-event-bus'
import { AgentCatalogInvalidationPublisher } from './agent-catalog-invalidation'

describe('AgentCatalogInvalidationPublisher', () => {
  test('同 catalog/scope revision 单调递增，不同 scope 独立计数', () => {
    const bus = new AgentEventBus()
    const publisher = new AgentCatalogInvalidationPublisher(bus)
    const seen: Array<{ sessionId: string; catalog: string; revision: number; workspaceSlug: string | null }> = []
    bus.on((sessionId, payload) => {
      if (payload.kind === 'catalog_invalidation') {
        seen.push({ sessionId, catalog: payload.catalog, revision: payload.revision, workspaceSlug: payload.workspaceSlug })
      }
    })

    const first = publisher.invalidate('presets', 'demo')
    const second = publisher.invalidate('presets', 'demo')
    const other = publisher.invalidate('presets', 'other')

    expect(first.revision).toBe(1)
    expect(second.revision).toBe(2)
    expect(other.revision).toBe(1)
    expect(seen).toEqual([
      { sessionId: 'catalog:presets:demo', catalog: 'presets', revision: 1, workspaceSlug: 'demo' },
      { sessionId: 'catalog:presets:demo', catalog: 'presets', revision: 2, workspaceSlug: 'demo' },
      { sessionId: 'catalog:presets:other', catalog: 'presets', revision: 1, workspaceSlug: 'other' },
    ])
  })

  test('通知 payload 不含目录正文或敏感配置', () => {
    const bus = new AgentEventBus()
    const publisher = new AgentCatalogInvalidationPublisher(bus)
    let raw = ''
    bus.on((_id, payload) => { raw = JSON.stringify(payload) })
    publisher.invalidate('workspace_capabilities', 'workspace-a')
    expect(raw).toBe(JSON.stringify({
      kind: 'catalog_invalidation',
      catalog: 'workspace_capabilities',
      workspaceSlug: 'workspace-a',
      revision: 1,
      changedAt: JSON.parse(raw).changedAt,
    }))
    expect(raw).not.toContain('mcpServers')
    expect(raw).not.toContain('skillContent')
  })

  // 渠道失效是 P0 #12 的最小充分集：无 workspaceSlug 时使用保留 scope key，
  // 保证 Remote event log 与 Pocket 客户端的 catalog+scope 去重键稳定。
  test('无 workspaceSlug 时 scope key 为 catalog:*', () => {
    const bus = new AgentEventBus()
    const publisher = new AgentCatalogInvalidationPublisher(bus)
    const scopeKeys: string[] = []
    bus.on((sessionId, payload) => {
      if (payload.kind === 'catalog_invalidation') scopeKeys.push(sessionId)
    })

    const first = publisher.invalidate('channels')
    const second = publisher.invalidate('channels')

    expect(first).toMatchObject({ catalog: 'channels', workspaceSlug: null, revision: 1 })
    expect(second.revision).toBe(2)
    expect(scopeKeys).toEqual(['catalog:channels:*', 'catalog:channels:*'])
  })
})
