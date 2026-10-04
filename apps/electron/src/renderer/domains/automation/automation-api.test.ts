import { afterEach, expect, test } from 'bun:test'
import type { Automation, CreateAutomationInput } from '@profer/shared'
import * as api from './automation-api'

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')

function installHost(host: Partial<api.AutomationApi>): void {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { electronAPI: host } })
}

afterEach(() => {
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
  else Reflect.deleteProperty(globalThis, 'window')
})

const input: CreateAutomationInput = {
  name: '巡检', prompt: '检查 issue', scheduleType: 'weekly', intervalMinutes: 10,
  timeOfDay: ['09:00', '18:00'], dayOfWeek: [0, 3], channelId: 'channel',
  workspaceId: 'workspace', agentRuntime: 'pi', presetId: 'preset',
  permissionMode: 'bypassPermissions', sessionMode: 'reuse', sourceSessionId: 'source', active: false,
}
const task: Automation = {
  ...input, id: 'task', active: false, createdAt: 1, updatedAt: 1, nextRunAt: 2, runHistory: [],
  timeOfDay: ['09:00', '18:00'], dayOfWeek: [0, 3], dayOfMonth: [1],
}

test('写入保留完整 payload 与返回快照，更新清除语义不被 facade 丢弃', async () => {
  const writes: unknown[] = []
  installHost({
    createAutomation: async (value) => { writes.push(value); return task },
    updateAutomation: async (value) => { writes.push(value); return undefined },
  })
  expect(await api.createAutomation(input)).toBe(task)
  const patch = { id: task.id, presetId: '', workspaceId: '', notificationTargets: [], active: false }
  expect(await api.updateAutomation(patch)).toBeUndefined()
  expect(writes).toEqual([input, patch])
})

test('立即运行失败原样交给页面，不重试也不假报成功', async () => {
  let calls = 0
  const failure = new Error('宿主拒绝运行')
  installHost({ runAutomationNow: async (id) => { calls++; expect(id).toBe('task'); throw failure } })
  await expect(api.runAutomationNow('task')).rejects.toBe(failure)
  expect(calls).toBe(1)
})

test('会话跳转保留默认列表与包含归档的查询差异', async () => {
  const scopes: Array<boolean | undefined> = []
  installHost({ listAgentSessions: async (includeArchived) => { scopes.push(includeArchived); return [] } })
  expect(await api.listAgentSessions()).toEqual([])
  expect(await api.listAgentSessions(true)).toEqual([])
  expect(scopes).toEqual([undefined, true])
})

test('工作区预设请求保持各自独立，失败不遮蔽另一个结果', async () => {
  const slugs: Array<string | undefined> = []
  installHost({
    listAgentPresets: async (slug) => { slugs.push(slug); throw new Error('列表失败') },
    getDefaultAgentPreset: async (slug) => { slugs.push(slug); return 'standard' },
  })
  await expect(api.listAgentPresets('workspace-slug')).rejects.toThrow('列表失败')
  expect(await api.getDefaultAgentPreset('workspace-slug')).toBe('standard')
  expect(slugs).toEqual(['workspace-slug', 'workspace-slug'])
})

test('推荐订阅传入原回调并返回原注销函数', () => {
  let notify: (() => void) | undefined
  let notifications = 0
  let removals = 0
  const unsubscribe = () => { removals++ }
  const callback = () => { notifications++ }
  installHost({ onRecommendationsChanged: (value) => { notify = value; return unsubscribe } })
  const cleanup = api.onRecommendationsChanged(callback)
  expect(notify).toBe(callback)
  notify?.()
  expect(notifications).toBe(1)
  expect(cleanup).toBe(unsubscribe)
  cleanup()
  expect(removals).toBe(1)
})
