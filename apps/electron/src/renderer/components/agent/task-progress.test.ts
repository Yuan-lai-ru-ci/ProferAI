import { describe, expect, test } from 'bun:test'
import type { ToolActivity } from '@/atoms/agent-atoms'
import { aggregateTaskItems } from './task-progress'

function activity(
  toolName: string,
  input: Record<string, unknown>,
  options: Partial<ToolActivity> = {},
): ToolActivity {
  return {
    toolUseId: options.toolUseId ?? `${toolName}-${String(input.taskId ?? '1')}`,
    toolName,
    input,
    done: true,
    ...options,
  }
}

function taskActivities(status: unknown): ToolActivity[] {
  return [
    activity('TaskCreate', { subject: '修复图谱', description: '详细说明' }, {
      toolUseId: 'create-1',
      result: JSON.stringify({ task: { id: '1', subject: '修复图谱' } }),
    }),
    activity('TaskUpdate', { taskId: '1', status }),
  ]
}

describe('aggregateTaskItems statuses', () => {
  test.each(['failed', 'cancelled'] as const)('preserves %s from TaskUpdate', (status) => {
    expect(aggregateTaskItems(taskActivities(status), false)).toEqual([
      expect.objectContaining({ id: '1', status }),
    ])
  })

  test('filters deleted tasks', () => {
    expect(aggregateTaskItems(taskActivities('deleted'), false)).toEqual([])
  })

  test('aggregates the real Claude SDK MCP-prefixed task tools', () => {
    const items = aggregateTaskItems([
      activity('mcp__task-graph__proma_task_create', { subject: '结构化任务' }, {
        toolUseId: 'mcp-create',
        result: JSON.stringify({ task: { id: 'mcp-1', subject: '结构化任务' } }),
      }),
      activity('mcp__task-graph__proma_task_update', { taskId: 'mcp-1', status: 'completed' }),
    ], false)

    expect(items).toEqual([expect.objectContaining({ id: 'mcp-1', status: 'completed' })])
  })

  test('falls back to the previous status for an unknown value', () => {
    const activities = [
      ...taskActivities('in_progress'),
      activity('TaskUpdate', { taskId: '1', status: 'not-a-status' }, { toolUseId: 'update-2' }),
    ]

    expect(aggregateTaskItems(activities, false)).toEqual([
      expect.objectContaining({ id: '1', status: 'in_progress' }),
    ])
  })

  test.each(['failed', 'cancelled', 'completed'] as const)(
    'stream completion does not overwrite terminal status %s',
    (status) => {
      expect(aggregateTaskItems(taskActivities(status), true)).toEqual([
        expect.objectContaining({ id: '1', status }),
      ])
    },
  )

  test.each(['failed', 'cancelled', 'completed'] as const)(
    'user stop does not overwrite terminal status %s',
    (status) => {
      expect(aggregateTaskItems(taskActivities(status), false, undefined, true)).toEqual([
        expect.objectContaining({ id: '1', status }),
      ])
    },
  )

  test('normal stream completion resets only in_progress to pending', () => {
    expect(aggregateTaskItems(taskActivities('in_progress'), true)).toEqual([
      expect.objectContaining({ id: '1', status: 'pending' }),
    ])
  })

  test('user stop changes only in_progress to cancelled', () => {
    expect(aggregateTaskItems(taskActivities('in_progress'), false, undefined, true)).toEqual([
      expect.objectContaining({ id: '1', status: 'cancelled' }),
    ])
  })
})
