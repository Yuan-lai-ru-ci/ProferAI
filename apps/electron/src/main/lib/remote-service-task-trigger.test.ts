import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let root: string
let sessions: typeof import('./agent-session-manager')
let handleRemoteCommand: typeof import('./remote-service').handleRemoteCommand
const configBefore = process.env.PROFER_CONFIG_DIR
const sdkConfigBefore = process.env.CLAUDE_CONFIG_DIR

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'profer-trigger-remote-test-'))
  process.env.PROFER_CONFIG_DIR = root
  sessions = await import('./agent-session-manager')
  const remote = await import('./remote-service')
  handleRemoteCommand = remote.handleRemoteCommand
})
afterAll(() => {
  if (configBefore === undefined) delete process.env.PROFER_CONFIG_DIR
  else process.env.PROFER_CONFIG_DIR = configBefore
  if (sdkConfigBefore === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = sdkConfigBefore
  if (root) rmSync(root, { recursive: true, force: true })
})

describe('task_trigger 远程命令投影', () => {
  test('get_sdk_messages 全量/分页与 session_detail 均保留说明和真实作者且不泄露私有来源字段', async () => {
    const session = sessions.createAgentSession('task trigger projection')
    const provenance = { schemaVersion: 1, messageId: 'notice-1', author: { type: 'automation', id: 'daily' }, runId: 'run-1', triggerId: 'daily:1' } as const
    sessions.appendSDKMessages(session.id, [{
      type: 'system', subtype: 'task_trigger', uuid: 'notice-1', _createdAt: 100,
      message: '可信来源：定时任务触发', _provenance: provenance,
      authorization: { token: 'secret' }, output_file: '/private/output',
    }])
    for (const command of [
      { type: 'get_sdk_messages' },
      { type: 'get_sdk_messages', targetMessages: 1 },
      { type: 'session_detail' },
    ]) {
      const response = await handleRemoteCommand(JSON.stringify({ ...command, sessionId: session.id }))
      expect(response.ok).toBe(true)
      if (!response.ok) throw new Error(response.error)
      const data = response.data as { messages?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>
      const messages = Array.isArray(data) ? data : data.messages
      expect(messages).toHaveLength(1)
      expect(messages?.[0]).toMatchObject({ subtype: 'task_trigger', _provenance: provenance })
      expect(JSON.stringify(messages)).toContain('可信来源：定时任务触发')
      expect(JSON.stringify(messages)).not.toContain('/private/output')
      expect(JSON.stringify(messages)).not.toContain('secret')
    }
  })

  test('session_detail 下发会话级思考档位，移动端不必退回默认', async () => {
    const { updateAgentSessionUiMeta } = await import('./agent-session-ui-projection-publisher')
    const session = sessions.createAgentSession('thinking projection')
    updateAgentSessionUiMeta(session.id, { openAIThinkingLevel: 'xhigh', agentEffort: 'max' })

    const response = await handleRemoteCommand(JSON.stringify({ type: 'session_detail', sessionId: session.id }))
    expect(response.ok).toBe(true)
    if (!response.ok) throw new Error(response.error)
    const meta = (response.data as { meta: Record<string, unknown> }).meta
    expect(meta.openAIThinkingLevel).toBe('xhigh')
    expect(meta.agentEffort).toBe('max')
  })
})
