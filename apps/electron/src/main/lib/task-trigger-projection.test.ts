import { describe, expect, test } from 'bun:test'
import type { SDKMessage } from '@profer/shared'
import { matchAgentJsonlLine } from './agent-session-search'
import { projectAgentPayloadForPocket, projectSdkMessageForPocket, projectSdkMessagesToPocketView } from './pocket-agent-projection'

const provenance = {
  schemaVersion: 1, messageId: 'notice-1', author: { type: 'automation', id: 'daily' },
  runId: 'run-1', taskId: 'task-1', triggerId: 'daily:1', source: { type: 'automation', id: 'daily' },
} as const
const notice = {
  type: 'system', subtype: 'task_trigger', uuid: 'notice-1', _createdAt: 100,
  message: '可信来源：定时任务触发', _provenance: {
    ...provenance, authorization: { token: 'secret' }, path: '/private/source',
    author: { ...provenance.author, credential: 'private-key' },
  },
  authorization: { token: 'secret' }, output_file: '/private/output', privatePath: '/private/host',
} as unknown as SDKMessage

describe('task_trigger 搜索与 Pocket 两路投影', () => {
  test('JSONL 搜索可读 message，role 为 status 且作者仍为触发者', () => {
    const hit = matchAgentJsonlLine(JSON.stringify(notice), '定时任务', 4)
    expect(hit).toMatchObject({ messageId: 'notice-1', role: 'status', author: provenance.author, provenance, snippet: '可信来源：定时任务触发' })
  })

  test('SDK 实时/历史投影只透传来源通知的安全白名单', () => {
    const projected = projectSdkMessageForPocket(notice)
    expect(projected).toEqual({ type: 'system', subtype: 'task_trigger', uuid: 'notice-1', _createdAt: 100, message: '可信来源：定时任务触发', _provenance: provenance })
    expect(projectAgentPayloadForPocket({ kind: 'sdk_message', message: notice })).toEqual({ kind: 'sdk_message', message: projected })
  })

  test('详情视图保留来源 notice，定时正文仍单独是 user 作者', () => {
    const bodyProvenance = { ...provenance, messageId: 'body-1', author: { type: 'user' } } as const
    const body: SDKMessage = { type: 'user', uuid: 'body-1', parent_tool_use_id: null, message: { content: [{ type: 'text', text: '每日汇总' }] }, _provenance: bodyProvenance }
    const views = projectSdkMessagesToPocketView([notice, body])
    expect(views).toHaveLength(2)
    expect(views[0]).toMatchObject({ id: 'notice-1', role: 'status', subtype: 'task_trigger', content: '可信来源：定时任务触发', createdAt: 100, _provenance: provenance })
    expect(views[1]).toMatchObject({ role: 'user', content: '每日汇总', _provenance: bodyProvenance })
    expect(JSON.stringify(views)).not.toContain('/private')
    expect(JSON.stringify(views)).not.toContain('secret')
    expect(JSON.stringify(views)).not.toContain('private-key')
  })
})
