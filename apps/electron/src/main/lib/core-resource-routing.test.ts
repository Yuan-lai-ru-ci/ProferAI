import { describe, expect, test } from 'bun:test'
import { AGENT_IPC_CHANNELS, AGENT_PRESET_IPC_CHANNELS } from '@profer/shared'
import { routeCoreResource, type ResourceRoutingSnapshot } from './core-resource-routing'

function makeSnapshot(overrides: Partial<ResourceRoutingSnapshot> = {}): ResourceRoutingSnapshot {
  return { targetId: 'remote-a', generation: 3, ownsBusinessData: true, capabilities: ['resources.manage'], client: { resourceOperation: async <T>(_operation: string, _args: unknown[]) => ({ ok: true } as T) } , ...overrides }
}

describe('Core resource routing ownership', () => {
  test('remote normal route returns Core result', async () => {
    let called = false
    const snapshot = makeSnapshot({ client: { resourceOperation: async <T>() => { called = true; return ['core'] as T } } })
    await expect(routeCoreResource(AGENT_IPC_CHANNELS.GET_SKILLS, ['ws', { __proferCoreResourceScope: { targetId: 'remote-a', generation: 3 } }], () => snapshot)).resolves.toEqual({ result: ['core'] })
    expect(called).toBe(true)
  })
  test('缺卡决定路由到当前 Core，并保留明确的 Skill 身份', async () => {
    const received: Array<{ operation: string; args: unknown[] }> = []
    const state = makeSnapshot({ client: { resourceOperation: async <T>(operation: string, args: unknown[]) => {
      received.push({ operation, args }); return undefined as T
    } } })
    const target = { scope: 'workspace', workspaceSlug: 'ws', skillSlug: 'sample', workspaceSkillId: 'stable-id' }
    await routeCoreResource(AGENT_IPC_CHANNELS.RESOLVE_SKILL_CARD_REMINDER, [target, 'dismiss', { __proferCoreResourceScope: { targetId: 'remote-a', generation: 3 } }], () => state)
    expect(received).toEqual([{ operation: 'resolveSkillCardReminder', args: [target, 'dismiss'] }])
  })
  test('old desktop falls back without scope', async () => {
    const snapshot = makeSnapshot({ targetId: 'local', ownsBusinessData: false, client: null })
    await expect(routeCoreResource(AGENT_IPC_CHANNELS.GET_SKILLS, ['ws'], () => snapshot)).resolves.toBeNull()
  })
  test.each([
    ['missing scope', [], '缺少'],
    ['stale scope', [{ __proferCoreResourceScope: { targetId: 'other', generation: 1 } }], '过期'],
  ])('%s rejects before routing', async (_name, args, message) => {
    await expect(routeCoreResource(AGENT_IPC_CHANNELS.GET_SKILLS, args, () => makeSnapshot())).rejects.toThrow(message)
  })
  test('disconnected Core never falls back', async () => {
    await expect(routeCoreResource(AGENT_IPC_CHANNELS.GET_SKILLS, ['ws', { __proferCoreResourceScope: { targetId: 'remote-a', generation: 3 } }], () => makeSnapshot({ client: null }))).rejects.toThrow('不会回退')
  })
  test('unsupported capability never falls back', async () => {
    await expect(routeCoreResource(AGENT_IPC_CHANNELS.GET_SKILLS, ['ws', { __proferCoreResourceScope: { targetId: 'remote-a', generation: 3 } }], () => makeSnapshot({ capabilities: [] }))).rejects.toThrow('不会回退')
  })
  test.each([
    [AGENT_IPC_CHANNELS.TEST_MCP_SERVER, 'probeMcpServer', ['demo', { type: 'http', url: 'http://fixture.invalid', enabled: true }, 'ws']],
    [AGENT_IPC_CHANNELS.RESTART_MCP_SERVER, 'restartMcpServer', ['demo', 'ws']],
    [AGENT_IPC_CHANNELS.GET_MCP_CONNECTION_STATUS, 'listMcpConnectionSnapshots', []],
  ])('MCP 管理 %s 交给当前 Core，不落到本机', async (channel, operation, args) => {
    const received: unknown[] = []
    const state = makeSnapshot({ client: { resourceOperation: async <T>(op: string, input: unknown[]) => {
      received.push(op, input); return { ok: true } as T
    } } })
    await expect(routeCoreResource(channel, [...args, { __proferCoreResourceScope: { targetId: 'remote-a', generation: 3 } }], () => state)).resolves.toEqual({ result: { ok: true } })
    expect(received).toEqual([operation, args])
  })
  test('late response rejects after target switch', async () => {
    let current = makeSnapshot()
    const promise = routeCoreResource(AGENT_PRESET_IPC_CHANNELS.LIST_PRESETS, [undefined, { __proferCoreResourceScope: { targetId: 'remote-a', generation: 3 } }], () => current)
    current = makeSnapshot({ targetId: 'remote-b', generation: 4 })
    await expect(promise).rejects.toThrow('忽略旧')
  })
  test('trims trailing undefined but preserves middle optional args and adds skills flag', async () => {
    let received: unknown[] = []
    const snapshot = makeSnapshot({ client: { resourceOperation: async <T>(_operation: string, args: unknown[]) => { received = args; return [] as T } } })
    await routeCoreResource(AGENT_IPC_CHANNELS.GET_SKILLS, ['ws', undefined, 'optional', { __proferCoreResourceScope: { targetId: 'remote-a', generation: 3 } }], () => snapshot)
    expect(received).toEqual(['ws', undefined, 'optional', true])
  })
})
