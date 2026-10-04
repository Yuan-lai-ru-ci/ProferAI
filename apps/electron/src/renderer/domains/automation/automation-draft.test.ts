import { expect, test } from 'bun:test'
import type { Automation } from '@profer/shared'
import { createEmptyDraft, automationToDraft } from './automation-draft'
import * as legacy from '@/atoms/automation-atoms'
import { draftToCreateInput, draftToUpdateInput, getDraftSignature } from './automation-form-utils'

const task: Automation = {
  id: 'task', name: '检查', prompt: '检查变更', scheduleType: 'daily', intervalMinutes: 10,
  channelId: 'channel', active: true, createdAt: 1, updatedAt: 1, nextRunAt: 2, runHistory: [],
}

test('旧 Atom 入口转发同一组草稿函数，默认对象各自独立', () => {
  expect(legacy.createEmptyDraft).toBe(createEmptyDraft)
  expect(legacy.automationToDraft).toBe(automationToDraft)
  const first = createEmptyDraft()
  const second = createEmptyDraft()
  first.timeOfDay.push('12:00')
  expect(second.timeOfDay).toEqual(['09:00'])
  expect(second).toMatchObject({ agentRuntime: 'claude', permissionMode: 'bypassPermissions', sessionMode: 'daily' })
})

test('旧任务缺省配置按原表单规则映射，显式空数组保留', () => {
  expect(automationToDraft(task)).toMatchObject({
    timeOfDay: ['09:00'], dayOfWeek: [1], dayOfMonth: [1],
    agentRuntime: 'claude', permissionMode: 'bypassPermissions', sessionMode: 'daily',
  })
  expect(automationToDraft({ ...task, timeOfDay: [], dayOfWeek: [], dayOfMonth: [] })).toMatchObject({
    timeOfDay: [], dayOfWeek: [], dayOfMonth: [],
  })
})

test('Pi、reuse、来源会话和通知配置沿用既有保存字段', () => {
  const draft = automationToDraft({ ...task, agentRuntime: 'pi', modelId: 'model', sessionMode: 'reuse',
    workspaceId: 'workspace', sourceSessionId: 'source', presetId: 'preset',
    timeOfDay: ['18:00', '09:00'], dayOfWeek: [0, 6], dayOfMonth: [1, 31],
    notificationTargets: [{ type: 'feishu', enabled: false, trigger: 'error', botId: 'bot', chatId: 'chat' }],
  })
  expect(draftToCreateInput(draft)).toMatchObject({
    agentRuntime: 'pi', sessionMode: 'reuse', modelId: 'model', sourceSessionId: 'source',
    presetId: 'preset', workspaceId: 'workspace', timeOfDay: ['18:00', '09:00'], dayOfWeek: [0, 6], dayOfMonth: [1, 31],
    notificationTargets: draft.notificationTargets,
  })
  expect(draftToUpdateInput(draft)).not.toHaveProperty('sourceSessionId')
})

test('更新的空值显式清除工作区、预设、通知，创建保留缺省语义', () => {
  const draft = { ...createEmptyDraft(), name: '任务', prompt: '检查' }
  expect(draftToUpdateInput(draft)).toMatchObject({ id: '', workspaceId: '', presetId: '', notificationTargets: [] })
  expect(draftToCreateInput(draft)).toMatchObject({ workspaceId: undefined, presetId: undefined, notificationTargets: undefined })
})

test('每个已保存配置字段变化都使 signature 失效，防止漏保存', () => {
  const draft = { ...createEmptyDraft(), name: '任务', prompt: '检查' }
  const patches: Array<Partial<typeof draft>> = [
    { id: 'task' }, { name: '新名称' }, { prompt: '新指令' }, { scheduleType: 'weekly' },
    { intervalMinutes: 30 }, { timeOfDay: ['18:00'] }, { dayOfWeek: [0] }, { dayOfMonth: [31] },
    { channelId: 'channel' }, { modelId: 'model' }, { agentRuntime: 'pi' }, { workspaceId: 'workspace' },
    { presetId: 'preset' }, { sessionMode: 'reuse' }, { active: false },
    { notificationTargets: [{ type: 'feishu', enabled: true, trigger: 'always', botId: 'bot', chatId: 'chat' }] },
  ]
  for (const patch of patches) expect(getDraftSignature({ ...draft, ...patch })).not.toBe(getDraftSignature(draft))
})
