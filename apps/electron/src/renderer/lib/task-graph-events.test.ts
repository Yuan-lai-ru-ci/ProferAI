import { describe, expect, test } from 'bun:test'
import type { ToolActivity } from '@/atoms/agent-atoms'
import { taskActivityToGraphEvents } from './task-graph-events'

function activity(
  toolName: string,
  input: Record<string, unknown>,
  options: Partial<ToolActivity> = {},
): ToolActivity {
  return {
    toolUseId: options.toolUseId ?? 'tool-1',
    toolName,
    input,
    done: true,
    ...options,
  }
}

describe('taskActivityToGraphEvents', () => {
  test('TaskCreate emits created and session-linked events with one timestamp', () => {
    const result = taskActivityToGraphEvents(activity('TaskCreate', {
      subject: '实现登录',
      description: '代码实现\n@dependsOn: t0',
    }, {
      result: JSON.stringify({ task: { id: 't1', subject: '实现登录' } }),
    }), 'session-1', 1234)

    expect(result.nextCurrentTaskId).toBe('t1')
    expect(result.events).toEqual([
      {
        type: 'task_created', taskId: 't1', timestamp: 1234,
        payload: { subject: '实现登录', description: '代码实现\n@dependsOn: t0', dependsOn: ['t0'] },
      },
      {
        type: 'task_session_linked', taskId: 't1', timestamp: 1234,
        payload: { sessionId: 'session-1' },
      },
    ])
  })

  test('TaskCreate preserves subject metadata semantics for persistence', () => {
    const result = taskActivityToGraphEvents(activity('TaskCreate', {
      subject: '实现登录 @dependsOn: t0',
      description: '',
    }, {
      result: JSON.stringify({ task: { id: 't1' } }),
    }), 'session-1', 1500)

    expect(result.events[0]).toEqual({
      type: 'task_created', taskId: 't1', timestamp: 1500,
      payload: { subject: '实现登录 @dependsOn: t0', description: '', dependsOn: ['t0'] },
    })
  })

  test('description-only TaskUpdate forwards metadata, dependency, and abandonment', () => {
    const description = '完成\n@artifact: src/a.ts\n@usage: tokens=500\n@forkFrom: root\n@dependsOn: setup, api\n@abandon: 更换方案'
    const result = taskActivityToGraphEvents(
      activity('TaskUpdate', { taskId: 't1', description }),
      'session-1',
      2000,
    )

    expect(result.events).toEqual([
      {
        type: 'task_updated', taskId: 't1', timestamp: 2000,
        payload: { description },
      },
      {
        type: 'task_dependency_added', taskId: 't1', timestamp: 2000,
        payload: { dependsOn: 'setup' },
      },
      {
        type: 'task_dependency_added', taskId: 't1', timestamp: 2000,
        payload: { dependsOn: 'api' },
      },
      {
        type: 'task_abandon_annotated', taskId: 't1', timestamp: 2000,
        payload: { reason: '更换方案', confidence: 1, evidenceTurns: [], source: 'agent' },
      },
    ])
  })

  test('combines subject and description in one update event', () => {
    expect(taskActivityToGraphEvents(
      activity('TaskUpdate', { taskId: 7, subject: '新标题', description: '新描述' }),
      'session-1',
      3000,
    ).events).toEqual([
      {
        type: 'task_updated', taskId: '7', timestamp: 3000,
        payload: { subject: '新标题', description: '新描述' },
      },
    ])
  })

  test.each(['pending', 'in_progress', 'completed', 'failed', 'cancelled'] as const)(
    'emits status_changed for %s without fabricated oldStatus',
    (status) => {
      expect(taskActivityToGraphEvents(
        activity('TaskUpdate', { taskId: 't1', status }),
        'session-1',
        4000,
      ).events).toEqual([
        {
          type: 'task_status_changed', taskId: 't1', timestamp: 4000,
          payload: { newStatus: status },
        },
      ])
    },
  )

  test('deleted emits only task_deleted when no update fields exist', () => {
    expect(taskActivityToGraphEvents(
      activity('TaskUpdate', { taskId: 't1', status: 'deleted' }),
      'session-1',
      5000,
    ).events).toEqual([
      {
        type: 'task_deleted', taskId: 't1', timestamp: 5000,
        payload: { source: 'agent' },
      },
    ])
  })

  test('does not emit an empty update event', () => {
    expect(taskActivityToGraphEvents(
      activity('TaskUpdate', { taskId: 't1', activeForm: '处理中' }),
      'session-1',
      6000,
    ).events).toEqual([])
  })
})
