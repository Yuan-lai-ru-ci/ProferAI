import { describe, expect, test } from 'bun:test'
import { buildGraphFromEvents } from '@profer/project-core'
import {
  delegationLinkFromResult,
  delegationToGraphEvents,
  isDelegateAgentTool,
  nativeTaskToolToGraphEvents,
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
