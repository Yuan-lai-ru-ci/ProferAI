import { describe, expect, mock, test } from 'bun:test'
import type { SDKMessage } from '@profer/shared'
const history: SDKMessage[] = []
mock.module('./agent-session-manager', () => ({ getAgentSessionSDKMessages: () => history, getAgentSessionMeta: () => undefined }))
mock.module('./config-paths', () => ({ getBundledCliPath: () => undefined, getConfigDirName: () => '.profer-test' }))
const { buildContextPrompt } = await import('./agent-prompt-utils')

describe('后续模型读取历史来源', () => {
  test('Given 历史Agent任务位于user协议槽 When 回填上下文 Then 保留作者来源且旧数据为unknown', () => {
    history.splice(0, history.length,
      { type: 'user', uuid: 'delegated', _provenance: { schemaVersion: 1, messageId: 'delegated', author: { type: 'agent', id: 'parent' }, runId: 'r', source: { type: 'run', id: 'parent-run' } }, message: { content: [{ type: 'text', text: '交接任务' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: '历史回答' }] } },
      { type: 'user', message: { content: [{ type: 'text', text: '本轮' }] } },
    )
    const prompt = buildContextPrompt('s', '本轮')
    expect(prompt).toContain('[user; author=agent:parent; source=run:parent-run; run=r]: 交接任务')
    expect(prompt).toContain('[assistant; author=unknown]: 历史回答')
    expect(prompt).not.toContain('author=user')
  })
})
