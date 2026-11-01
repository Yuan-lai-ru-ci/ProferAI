import * as React from 'react'
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { Provider, createStore } from 'jotai'
import type { AgentSessionMeta, SDKMessage } from '@profer/shared'
import { agentSDKMessagesCacheAtom, agentSessionsAtom, liveMessagesMapAtom } from '@/atoms/agent-atoms'
import { CurrentDelegationPanel } from './CurrentDelegationPanel'
function session(id: string, overrides: Partial<AgentSessionMeta> = {}): AgentSessionMeta { return { id, title: '检查缓存', createdAt: 1, updatedAt: 1, ...overrides } }
const execution = session('execution', { sourceSessionId: 'parent', parentSessionId: 'parent', sourceDelegationId: 'task', delegationPlacement: 'current', delegationRelation: 'subtask', delegationStatus: 'completed' })
const assistant = (uuid: string, text: string): SDKMessage => ({ type: 'assistant', uuid, message: { role: 'assistant', model: 'model', content: [{ type: 'text', text }] }, parent_tool_use_id: null }) as SDKMessage
function render(sessions: AgentSessionMeta[]) { const store = createStore(); store.set(agentSessionsAtom, sessions); store.set(agentSDKMessagesCacheAtom, new Map([['parent', [assistant('parent-answer', '父上下文私有内容')]], ['execution', [assistant('result', '缓存回归已通过')]]])); store.set(liveMessagesMapAtom, new Map([['unrelated', [assistant('unrelated-answer', '其他任务私有内容')]]])); return renderToStaticMarkup(React.createElement(Provider, { store }, React.createElement(CurrentDelegationPanel, { sessionId: 'parent', messages: [] }))) }
describe('父会话 current 任务 legacy 面板（组件不再挂载）', () => {
  test('面板组件保留但不由父会话入口挂载', () => { expect(render([execution])).toContain('当前会话任务'); expect(render([session('child', { parentSessionId: 'parent', sourceDelegationId: 'old' })])).toBe('') })
})
