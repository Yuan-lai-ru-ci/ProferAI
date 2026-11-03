import { describe, expect, test } from 'bun:test'
import type { SDKMessage } from '@profer/shared'
import { mergeMessagesByUuid } from './agent-message-merge'
import { upsertLiveMessageByUuid } from './agent-live-message-upsert'
import { orderTranscriptMessages } from './agent-transcript-order'
import { isScheduledTaskInput, isTaskSourceInput, projectTaskInputTimeline } from './task-input-timeline'

const input = (runId = 'run-1', messageId = 'input-1'): SDKMessage => ({
  type: 'user', parent_tool_use_id: null, _createdAt: 100,
  message: { content: [{ type: 'text', text: '获取时间并写入日志\n<!--PROFER_SCHEDULED_RUN-->' }] },
  _provenance: { schemaVersion: 1, messageId, runId, triggerId: `${runId}-trigger`, author: { type: 'user' }, source: { type: 'automation', id: 'schedule' } },
}) as SDKMessage
const notice = (runId = 'run-1'): SDKMessage => ({
  type: 'system', subtype: 'task_trigger', uuid: `${runId}-notice`,
  _provenance: { ...input(runId)._provenance!, messageId: `${runId}-notice`, author: { type: 'automation' } },
})

describe('定时任务历史与实时投影', () => {
  test('Given 无 UUID 的同一输入 When 历史和实时合并 Then 运行中与结束后均只有一份', () => {
    const persisted = input()
    const live = structuredClone(persisted)
    const during = orderTranscriptMessages(mergeMessagesByUuid([persisted], [live]))
    expect(during).toEqual([live])
    expect(orderTranscriptMessages([persisted, live])).toEqual([live])
    expect(upsertLiveMessageByUuid([persisted], live)).toEqual([persisted])
    expect(mergeMessagesByUuid([persisted], [])).toHaveLength(1)
  })

  test('Given 无 UUID 的业务消息 When partial 变 final Then 原地更新且不改写 Provider uuid', () => {
    const partial = { ...input(), _partial: true }
    const final = input()
    expect(upsertLiveMessageByUuid([partial], final)).toEqual([final])
    expect('uuid' in final ? final.uuid : undefined).toBeUndefined()
  })

  test('Given 相同正文或消息 ID When 来自不同运行 Then 保留两次真实触发', () => {
    const first = input()
    const next = input('run-2')
    expect(mergeMessagesByUuid([first], [next])).toHaveLength(2)
    expect(orderTranscriptMessages([first, next])).toHaveLength(2)
  })

  test('Given 触发提示和对应输入 When 投影 Then 仅隐藏同 run 与 trigger 的提示且不修改原始记录', () => {
    const pendingNotice = notice('run-2')
    const messages = [notice(), input(), pendingNotice]
    expect(projectTaskInputTimeline(messages)).toEqual([messages[1]!, pendingNotice])
    expect(messages).toHaveLength(3)
    expect(projectTaskInputTimeline([pendingNotice])).toEqual([pendingNotice])
    const otherTrigger = { ...notice(), _provenance: { ...notice()._provenance!, triggerId: 'other-trigger' } }
    expect(projectTaskInputTimeline([otherTrigger, input()])).toHaveLength(2)
  })

  test('Given 子会话交接、外部及系统输入 When 来源可信 Then 合并同次提示，保留普通用户和Goal控制记录', () => {
    for (const author of ['agent', 'external', 'system'] as const) {
      const task = { ...input(), _provenance: { ...input()._provenance!, author: { type: author }, source: { type: 'session' as const, id: 'parent' } } }
      const trigger = { ...notice(), _provenance: { ...task._provenance!, messageId: 'notice' } }
      expect(isTaskSourceInput(task)).toBe(true)
      expect(projectTaskInputTimeline([trigger, task])).toEqual([task])
      expect(isTaskSourceInput({ ...task, _goalIteration: 1 })).toBe(false)
      expect(isTaskSourceInput({ ...task, message: { content: [{ type: 'tool_result', tool_use_id: 'tool', content: 'ok' }] } } as SDKMessage)).toBe(false)
    }
    const direct = { ...input(), _provenance: { ...input()._provenance!, source: undefined } }
    expect(isTaskSourceInput(direct)).toBe(false)
  })

  test('Given 普通用户、工具结果及缺失来源 When 识别 Then 不凭任务正文或当前会话来源误判', () => {
    expect(isScheduledTaskInput(input())).toBe(true)
    const direct = { ...input(), _provenance: { ...input()._provenance!, source: undefined } }
    expect(isScheduledTaskInput(direct)).toBe(false)
    const toolResult = { ...input(), message: { content: [{ type: 'tool_result', tool_use_id: 'tool', content: '完成' }] } } as SDKMessage
    expect(isScheduledTaskInput(toolResult)).toBe(false)
    expect(isScheduledTaskInput({ ...input(), _provenance: undefined })).toBe(true)
    expect(projectTaskInputTimeline([notice(), direct])).toHaveLength(2)
  })
})
