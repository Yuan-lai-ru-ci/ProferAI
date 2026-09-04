import { describe, expect, test } from 'bun:test'
import { getHarnessBlockedTasks, getTaskVerificationContext, selectHarnessFocus } from './harness-query'
import type { TaskGraph, TaskNode } from './types'

function node(id: string, status: TaskNode['status'], createdAt: number, dependsOn: string[] = [], description = '', artifact: string[] = []): TaskNode {
  return { id, subject: id, description, status, dependsOn, dependedBy: [], artifact, reviewStatus: 'none', createdAt, updatedAt: createdAt }
}

function graph(nodes: TaskNode[]): TaskGraph {
  return { nodes: Object.fromEntries(nodes.map((item) => [item.id, item])), edges: [], forkEdges: [], updatedAt: 1 }
}

describe('Harness Project Graph queries', () => {
  test('prioritizes the oldest in-progress task before a previous or ready task', () => {
    const input = graph([
      node('ready', 'pending', 1),
      node('running-later', 'in_progress', 5),
      node('running-earlier', 'in_progress', 3),
    ])
    expect(selectHarnessFocus(input, 'ready')).toMatchObject({ kind: 'in_progress', task: { id: 'running-earlier' } })
  })

  test('keeps a prior focus only when it remains ready', () => {
    const input = graph([
      node('done', 'completed', 1),
      node('prior', 'pending', 2, ['done']),
      node('other', 'pending', 1),
    ])
    expect(selectHarnessFocus(input, 'prior')).toMatchObject({ kind: 'previous_focus', task: { id: 'prior' } })
    expect(selectHarnessFocus(input, 'missing')).toMatchObject({ kind: 'ready', task: { id: 'other' } })
  })

  test('does not select failed, cancelled, blocked or cycle nodes and reports a blocked graph', () => {
    const input = graph([
      node('failed', 'failed', 1),
      node('cancelled', 'cancelled', 2),
      node('waiting', 'pending', 3, ['failed']),
      node('cycle-a', 'pending', 4, ['cycle-b']),
      node('cycle-b', 'pending', 5, ['cycle-a']),
    ])
    expect(selectHarnessFocus(input)).toMatchObject({ kind: 'blocked' })
    expect(getHarnessBlockedTasks(input).map((item) => item.task.id)).toEqual(['waiting', 'cycle-a', 'cycle-b'])
    expect(getHarnessBlockedTasks(input)[0]?.unmetDependencies).toEqual([{ id: 'failed', status: 'failed' }])
  })

  test('returns graphless only for an empty graph', () => {
    expect(selectHarnessFocus(graph([]))).toMatchObject({ kind: 'graphless' })
  })

  test('reads only explicit verify markers and declared artifacts', () => {
    const task = node('verify', 'pending', 1, [], '普通描述\n@verify: bun test target\nverify: readback output', ['dist/a.txt', 'dist/a.txt'])
    expect(getTaskVerificationContext(task)).toEqual({
      taskId: 'verify',
      artifacts: ['dist/a.txt'],
      explicitCriteria: ['bun test target', 'readback output'],
      required: true,
    })
  })
})
