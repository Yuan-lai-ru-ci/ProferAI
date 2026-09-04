import { describe, expect, test } from 'bun:test'
import { buildGraphFromEvents } from '@profer/project-core'
import {
  delegationLinkFromResult,
  delegationToGraphEvents,
  isDelegateAgentTool,
  isTaskCompletionBlocked,
  nativeTaskToolToGraphEvents,
  structuredTaskAutoLinkEvent,
  structuredTaskToolCurrentTaskId,
} from './task-graph-event-converter'

describe('nativeTaskToolToGraphEvents', () => {
  test('persists native TaskCreate after its SDK tool result', () => {
    const result = nativeTaskToolToGraphEvents({
      toolUseId: 'use-1', toolName: 'TaskCreate',
      input: { subject: '实现任务图', description: '先完成 SDK 接入' },
      result: JSON.stringify({ task: { id: 'task-1', subject: '实现任务图' } }),
    }, 'session-1', 1000, { currentTaskId: null, lastCompletedTaskId: null })

    expect(result.nextCurrentTaskId).toBe('task-1')
    expect(result.events).toEqual([
      { type: 'task_created', taskId: 'task-1', timestamp: 1000, payload: { subject: '实现任务图', description: '先完成 SDK 接入', dependsOn: [] } },
      { type: 'task_session_linked', taskId: 'task-1', timestamp: 1000, payload: { sessionId: 'session-1' } },
    ])
  })

  test('explicit empty dependencies replace and clear old graph edges', () => {
    const created = nativeTaskToolToGraphEvents({
      toolUseId: 'create', toolName: 'TaskCreate', input: { subject: '前置' },
      result: JSON.stringify({ task: { id: 'a' } }),
    }, 'session-1', 1000, { currentTaskId: null, lastCompletedTaskId: null })
    const dependent = nativeTaskToolToGraphEvents({
      toolUseId: 'create-2', toolName: 'TaskCreate', input: { subject: '后续', dependsOn: ['a'] },
      result: JSON.stringify({ task: { id: 'b' } }),
    }, 'session-1', 1100, { currentTaskId: 'a', lastCompletedTaskId: null })
    const update = nativeTaskToolToGraphEvents({
      toolUseId: 'update', toolName: 'TaskUpdate', input: { taskId: 'b', dependsOn: [] },
    }, 'session-1', 1200, { currentTaskId: 'b', lastCompletedTaskId: null })

    const graph = buildGraphFromEvents([...created.events, ...dependent.events, ...update.events])
    expect(graph.nodes.b!.dependsOn).toEqual([])
    expect(graph.nodes.a!.dependedBy).toEqual([])
    expect(graph.edges).toEqual([])
  })

  test('auto-links child tasks and sequential tasks without overriding explicit relationships', () => {
    const child = nativeTaskToolToGraphEvents({
      toolUseId: 'child', toolName: 'TaskCreate', input: { subject: '子任务' },
      result: JSON.stringify({ task: { id: 'child' } }),
    }, 'session-1', 1000, { currentTaskId: 'parent', lastCompletedTaskId: 'finished' })
    const sequential = nativeTaskToolToGraphEvents({
      toolUseId: 'next', toolName: 'TaskCreate', input: { subject: '后续任务' },
      result: JSON.stringify({ task: { id: 'next' } }),
    }, 'session-1', 1100, { currentTaskId: null, lastCompletedTaskId: 'finished' })
    const explicit = nativeTaskToolToGraphEvents({
      toolUseId: 'explicit', toolName: 'TaskCreate', input: { subject: '显式任务', dependsOn: ['chosen'] },
      result: JSON.stringify({ task: { id: 'explicit' } }),
    }, 'session-1', 1200, { currentTaskId: 'parent', lastCompletedTaskId: 'finished' })

    expect(child.events[0]).toMatchObject({ payload: { dependsOn: [], forkFrom: 'parent' } })
    expect(sequential.events[0]).toMatchObject({ payload: { dependsOn: ['finished'] } })
    expect(explicit.events[0]).toMatchObject({ payload: { dependsOn: ['chosen'] } })
    expect(explicit.events[0]?.payload).not.toHaveProperty('forkFrom')
  })

  test('Given running delegations When native TaskUpdate requests completed Then does not persist an early completion event', () => {
    const blocked = nativeTaskToolToGraphEvents({
      toolUseId: 'update-blocked', toolName: 'TaskUpdate',
      input: { taskId: 'task-1', status: 'completed' },
    }, 'session-1', 1000, {
      currentTaskId: 'task-1',
      lastCompletedTaskId: null,
      completionBlockedByRunningDelegations: true,
    })
    const permitted = nativeTaskToolToGraphEvents({
      toolUseId: 'update-permitted', toolName: 'TaskUpdate',
      input: { taskId: 'task-1', status: 'completed' },
    }, 'session-1', 1000, {
      currentTaskId: 'task-1',
      lastCompletedTaskId: null,
      completionBlockedByRunningDelegations: false,
    })

    expect(blocked.events).toEqual([])
    expect(permitted.events).toEqual([
      { type: 'task_status_changed', taskId: 'task-1', timestamp: 1000, payload: { newStatus: 'completed' } },
    ])
  })

  test('recognizes the structured completion guard response', () => {
    expect(isTaskCompletionBlocked(JSON.stringify({ completionBlocked: true }))).toBe(true)
    expect(isTaskCompletionBlocked(JSON.stringify({ updated: true }))).toBe(false)
  })

  test('reads structured MCP task and delegation results without duplicating its persistence', () => {
    expect(structuredTaskToolCurrentTaskId({
      toolUseId: 'mcp-create', toolName: 'mcp__task-graph__proma_task_create', input: {},
      result: JSON.stringify({ task: { id: 'task-9' } }),
    })).toBe('task-9')
    expect(isDelegateAgentTool('delegate_agent')).toBe(true)
    expect(isDelegateAgentTool('mcp__collaboration__delegate_agent')).toBe(true)
    expect(isDelegateAgentTool('mcp__collaboration__wait_for_delegations')).toBe(false)
    const delegation = delegationLinkFromResult(JSON.stringify({ delegation: { delegationId: 'd-1', childSessionId: 's-child' } }))
    expect(delegation).toEqual({ delegationId: 'd-1', childSessionId: 's-child' })
    expect(delegationToGraphEvents('parent', delegation!, {
      toolUseId: 'delegate', toolName: 'mcp__collaboration__delegate_agent',
      input: { title: '实现子功能', task: '完成子功能' },
    }, 1000)).toEqual([
      { type: 'task_created', taskId: 'delegation:d-1', timestamp: 1000, payload: { subject: '实现子功能', description: '完成子功能', dependsOn: [], forkFrom: 'parent' } },
      { type: 'task_session_linked', taskId: 'delegation:d-1', timestamp: 1000, payload: { sessionId: 'd-1', childSessionId: 's-child' } },
      { type: 'task_status_changed', taskId: 'delegation:d-1', timestamp: 1000, payload: { newStatus: 'in_progress' } },
    ])
  })
})

describe('structuredTaskAutoLinkEvent 跨 run 兜底', () => {
  const createToolCall = (id: string) => ({
    toolUseId: 'use-' + id, toolName: 'mcp__task-graph__proma_task_create',
    input: { subject: '新增子任务' },
    result: JSON.stringify({ task: { id } }),
  })

  test('内存无 completion 时，用持久化兑底 lastCompletedTaskId 连边上一步任务', () => {
    const evt = structuredTaskAutoLinkEvent(createToolCall('new-b'), 2000, {
      currentTaskId: null,
      // 模拟 orchestrator 已用 resolveRecentAutoLinkTaskId 填充：即使本 run 内无完成任务，
      // 也回退到持久化 graph 的最近完成任务 a，让跨 run 新任务自动串联。
      lastCompletedTaskId: 'a',
    })
    expect(evt).toEqual({
      type: 'task_updated', taskId: 'new-b', timestamp: 2000,
      payload: { dependsOn: ['a'] },
    })
  })

  test('显式 dependsOn 优先于兑底，不额外加边', () => {
    const evt = structuredTaskAutoLinkEvent({
      toolUseId: 'use-x', toolName: 'mcp__task-graph__proma_task_create',
      input: { subject: '独立任务', dependsOn: ['x1'] },
      result: JSON.stringify({ task: { id: 'new-c' } }),
    }, 3000, { currentTaskId: null, lastCompletedTaskId: 'a' })
    expect(evt).toBeUndefined()
  })

  test('currentTaskId 存在时优先生效 forkFrom，不重复连 dependsOn', () => {
    const evt = structuredTaskAutoLinkEvent(createToolCall('fork-b'), 4000, {
      currentTaskId: 'parent', lastCompletedTaskId: 'a',
    })
    expect(evt).toEqual({
      type: 'task_updated', taskId: 'fork-b', timestamp: 4000,
      payload: { forkFrom: 'parent' },
    })
  })
})
