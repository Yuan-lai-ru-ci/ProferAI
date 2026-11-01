import { describe, expect, test } from 'bun:test'
import type { AgentSessionMeta, SDKMessage } from '@profer/shared'
import { currentDelegationExecutions } from './current-delegation-projection'
function session(id: string, overrides: Partial<AgentSessionMeta> = {}): AgentSessionMeta { return { id, title: id, createdAt: 1, updatedAt: 1, ...overrides } }
function toolResult(value: unknown): SDKMessage { return { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'delegate', content: JSON.stringify(value) }] }, parent_tool_use_id: null } as SDKMessage }
describe('current 委派执行记录选择', () => {
  test('仅把 current + subtask 投影给真实来源会话，旧 child 与 independent 不混入', () => {
    const sessions = [session('current', { sourceSessionId: 'parent', parentSessionId: 'parent', sourceDelegationId: 'task', delegationPlacement: 'current', delegationRelation: 'subtask' }), session('child', { parentSessionId: 'parent', sourceDelegationId: 'child-task' }), session('independent', { sourceSessionId: 'parent', sourceDelegationId: 'independent-task', delegationPlacement: 'independent', delegationRelation: 'independent' }), session('other', { sourceSessionId: 'other', parentSessionId: 'parent', sourceDelegationId: 'other-task', delegationPlacement: 'current' })]
    expect(currentDelegationExecutions('parent', sessions, []).map(item => item.executionSessionId)).toEqual(['current'])
  })
  test('使用真实 tool_result 的 projection.executionSessionId 恢复可定位记录，不从正文推断', () => {
    const result = { delegation: { delegationId: 'task', title: '实现缓存', placement: 'current', relation: 'subtask', projection: { sessionId: 'parent', executionSessionId: 'execution', taskId: 'task' }, status: 'completed', resultSummary: '验证通过' } }
    expect(currentDelegationExecutions('parent', [], [toolResult(result)])).toMatchObject([{ taskId: 'task', executionSessionId: 'execution', title: '实现缓存', status: 'completed', resultSummary: '验证通过' }])
    expect(currentDelegationExecutions('other', [], [toolResult(result)])).toEqual([])
    expect(currentDelegationExecutions('parent', [], [{ type: 'user', message: { content: JSON.stringify(result) } } as SDKMessage])).toEqual([])
  })
  test('批量和 MCP 文本信封支持，metadata 覆盖并去重', () => {
    const delegation = { delegationId: 'task', placement: 'current', projection: { sessionId: 'parent', executionSessionId: 'execution', taskId: 'task' }, title: '旧标题', status: 'running' }
    const messages = [toolResult({ content: [{ type: 'text', text: JSON.stringify({ delegations: [delegation] }) }] })]
    expect(currentDelegationExecutions('parent', [], messages)).toMatchObject([{ executionSessionId: 'execution', title: '旧标题', status: 'running' }])
    const sessions = [session('execution', { title: '完成标题', sourceSessionId: 'parent', sourceDelegationId: 'task', delegationPlacement: 'current', delegationRelation: 'subtask', delegationStatus: 'completed' })]
    expect(currentDelegationExecutions('parent', sessions, messages)).toMatchObject([{ executionSessionId: 'execution', title: '完成标题', status: 'completed' }])
    expect(currentDelegationExecutions('parent', sessions, messages)).toHaveLength(1)
  })
  test('拒绝自引用、冲突 taskId、跨来源链接和 independent 关系', () => {
    const projection = { sessionId: 'parent', executionSessionId: 'execution', taskId: 'task' }
    const make = (overrides: object) => toolResult({ delegation: { delegationId: 'task', placement: 'current', projection, ...overrides } })
    expect(currentDelegationExecutions('parent', [], [make({ projection: { ...projection, executionSessionId: 'parent' } })])).toEqual([])
    expect(currentDelegationExecutions('parent', [], [make({ projection: { ...projection, taskId: 'different' } })])).toEqual([])
    expect(currentDelegationExecutions('parent', [], [make({ relation: 'independent' })])).toEqual([])
    expect(currentDelegationExecutions('parent', [session('execution', { sourceSessionId: 'other', sourceDelegationId: 'task', delegationPlacement: 'current' })], [make({})])).toEqual([])
  })
})
