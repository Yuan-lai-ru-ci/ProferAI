import { describe, expect, test } from 'bun:test'
import type { FeishuChatBinding } from '@profer/shared'
import { createEmptyDraft, type AutomationDraft } from './automation-draft'
import {
  canPersistDraft,
  createFeishuTarget,
  draftToCreateInput,
  draftToUpdateInput,
  formatFeishuBinding,
  getDraftSignature,
  getFeishuBindingValue,
  getFeishuTarget,
  isReadyToRun,
  listMissingFields,
} from './automation-form-utils'

const binding: FeishuChatBinding = {
  botId: 'bot-123456789',
  chatId: 'chat-1',
  userId: 'user-1',
  sessionId: 'session-1',
  workspaceId: 'workspace-1',
  channelId: 'channel-1',
  chatType: 'group',
  groupName: '研发群',
  createdAt: 1,
}

function completeDraft(): AutomationDraft {
  return {
    ...createEmptyDraft(),
    id: 'automation-1',
    name: '  每日检查  ',
    prompt: '  检查 issue  ',
    channelId: 'channel-1',
    modelId: 'model-1',
    workspaceId: 'workspace-1',
    notificationTargets: [createFeishuTarget(binding)],
    sourceSessionId: 'source-1',
    active: true,
  }
}

test('草稿保存与运行判定只要求名称、描述、模型和工作区', () => {
  const draft = createEmptyDraft()
  expect(canPersistDraft(draft)).toBe(false)
  expect(listMissingFields(draft)).toEqual(['任务名称', '任务描述', '模型', '工作区'])
  expect(isReadyToRun({ ...draft, name: '任务', prompt: '执行', channelId: 'channel', workspaceId: 'workspace' })).toBe(true)
})

test('缺失字段按表单提示顺序返回且 trim 后判定', () => {
  const draft = { ...createEmptyDraft(), name: ' 任务 ', prompt: ' ', channelId: '', workspaceId: undefined }
  expect(listMissingFields(draft)).toEqual(['任务描述', '模型', '工作区'])
})

test('创建和更新 payload 保留字段并 trim 文本', () => {
  const draft = completeDraft()
  expect(draftToCreateInput(draft)).toMatchObject({
    name: '每日检查', prompt: '检查 issue', channelId: 'channel-1', workspaceId: 'workspace-1',
    sourceSessionId: 'source-1', active: true,
  })
  expect(draftToCreateInput(draft)).not.toHaveProperty('id')
  expect(draftToUpdateInput(draft)).toMatchObject({ id: 'automation-1', name: '每日检查', prompt: '检查 issue' })
})

test('signature 忽略名称和描述两端空格，但保留配置变化', () => {
  const first = completeDraft()
  const second = { ...first, name: '每日检查', prompt: '检查 issue' }
  expect(getDraftSignature(first)).toBe(getDraftSignature(second))
  expect(getDraftSignature({ ...first, active: false })).not.toBe(getDraftSignature(first))
})

test('飞书目标按类型读取，创建目标默认启用且通知全部结果', () => {
  const target = createFeishuTarget(binding)
  expect(target).toEqual({ type: 'feishu', enabled: true, trigger: 'always', botId: 'bot-123456789', chatId: 'chat-1' })
  expect(getFeishuTarget([target])).toEqual(target)
  expect(getFeishuTarget([{ type: 'feishu', enabled: false, trigger: 'error', botId: 'other', chatId: 'other' }])).toBeDefined()
  expect(getFeishuTarget(undefined)).toBeUndefined()
  expect(getFeishuBindingValue(binding)).toBe('bot-123456789::chat-1')
  expect(formatFeishuBinding(binding)).toBe('研发群 · bot-1234')
})

test('飞书单聊没有群名时使用稳定显示文案', () => {
  expect(formatFeishuBinding({ ...binding, chatType: 'p2p', groupName: undefined })).toBe('飞书单聊 · bot-1234')
})
