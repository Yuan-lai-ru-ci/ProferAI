import { expect, test } from 'bun:test'
import { ownsCoreResources } from './core-target-atoms'

test('仅旧桌面允许桌面专属资源，Core 断连仍保持归属', () => {
  expect(ownsCoreResources({ currentId: 'local', generation: 0, targets: [] })).toBe(false)
  for (const status of ['connected', 'disconnected', 'error'] as const) {
    expect(ownsCoreResources({ currentId: 'local', generation: 1, targets: [{ id: 'local', name: 'Core', kind: 'local', status, capabilities: ['resources.manage'] }] })).toBe(true)
    expect(ownsCoreResources({ currentId: 'remote', generation: 1, targets: [] })).toBe(true)
  }
})

test('Core 的全局 MCP 和上下文快照不回落到桌面 IPC', async () => {
  const source = (path: string) => Bun.file(new URL(path, import.meta.url)).text()
  expect(await source('../components/agent-skills/GlobalMcpPanel.tsx')).toContain('if (coreOwned) return')
  expect(await source('../components/agent-skills/WorkspaceGlobalMcpList.tsx')).toContain('if (!workspaceSlug || coreOwned) return')
  expect(await source('../components/agent/use-session-context-usage.ts')).toContain('if (coreOwned || hasCurrent || !request.sessionId) return')
})
