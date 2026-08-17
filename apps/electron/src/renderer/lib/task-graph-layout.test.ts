import { describe, expect, test } from 'bun:test'
import type { TaskGraph, TaskNode } from '@profer/project-core'
import { computeTaskGraphLayout } from './task-graph-layout'

function node(id: string, createdAt: number, dependsOn: string[] = []): TaskNode {
  return {
    id,
    subject: id,
    description: '',
    status: 'pending',
    dependsOn,
    dependedBy: [],
    artifact: [],
    reviewStatus: 'none',
    createdAt,
    updatedAt: createdAt,
  }
}

function graph(nodes: TaskNode[]): TaskGraph {
  return {
    nodes: Object.fromEntries(nodes.map((item) => [item.id, item])),
    edges: nodes.flatMap((item) => item.dependsOn.map((dependency) => ({ from: item.id, to: dependency }))),
    forkEdges: [],
    updatedAt: 10,
  }
}

function positionMap(input: TaskGraph) {
  return new Map(computeTaskGraphLayout(input).positions.map((position) => [position.id, position]))
}

describe('computeTaskGraphLayout', () => {
  test('keeps the longest dependency path as a left-to-right mainline', () => {
    const layout = computeTaskGraphLayout(graph([
      node('plan', 1),
      node('implement', 2, ['plan']),
      node('verify', 3, ['implement']),
    ]))
    const positions = new Map(layout.positions.map((position) => [position.id, position]))

    expect(layout.mainline).toEqual(['plan', 'implement', 'verify'])
    expect(positions.get('plan')!.x).toBeLessThan(positions.get('implement')!.x)
    expect(positions.get('implement')!.x).toBeLessThan(positions.get('verify')!.x)
    expect(positions.get('plan')!.y).toBe(positions.get('verify')!.y)
  })

  test('keeps branches below their nearest mainline anchor', () => {
    const input = graph([
      node('plan', 1),
      node('implement', 2, ['plan']),
      node('verify', 3, ['implement']),
      node('release', 4, ['verify']),
      node('research', 5, ['plan']),
      node('prototype', 6, ['research']),
    ])
    const positions = positionMap(input)

    expect(positions.get('research')!.x).toBe(positions.get('plan')!.x)
    expect(positions.get('research')!.y).toBeGreaterThan(positions.get('plan')!.y)
    expect(positions.get('prototype')!.y).toBeGreaterThan(positions.get('research')!.y)

    const branchEdge = computeTaskGraphLayout(input).edges.find((edge) => edge.from === 'plan' && edge.to === 'research')
    expect(branchEdge?.x1).toBe(positions.get('plan')!.x + 130)
    expect(branchEdge?.y1).toBe(positions.get('plan')!.y + 100)
  })

  test('keeps forked exploration off the dependency mainline', () => {
    const input = graph([
      node('plan', 1),
      node('implement', 2, ['plan']),
      node('verify', 3, ['implement']),
      node('explore-a', 4),
      node('explore-b', 5),
      node('explore-c', 6),
    ])
    input.forkEdges = [
      { from: 'plan', to: 'explore-a' },
      { from: 'explore-a', to: 'explore-b' },
      { from: 'explore-b', to: 'explore-c' },
    ]
    const positions = positionMap(input)

    expect(computeTaskGraphLayout(input).mainline).toEqual(['plan', 'implement', 'verify'])
    expect(positions.get('explore-a')!.y).toBeGreaterThan(positions.get('plan')!.y)
  })

  test('moves disconnected work into an unlinked lane below the execution flow', () => {
    const layout = computeTaskGraphLayout(graph([
      node('plan', 1),
      node('implement', 2, ['plan']),
      node('verify', 3, ['implement']),
      node('unrelated-a', 4),
      node('unrelated-b', 5, ['unrelated-a']),
    ]))
    const positions = new Map(layout.positions.map((position) => [position.id, position]))

    expect(layout.unlinkedLane?.count).toBe(2)
    expect(positions.get('unrelated-a')!.y).toBeGreaterThan(positions.get('implement')!.y)
    expect(positions.get('unrelated-b')!.y).toBe(positions.get('unrelated-a')!.y)
  })

  test('does not depend on task-map insertion order', () => {
    const tasks = [
      node('plan', 1),
      node('implement', 2, ['plan']),
      node('verify', 3, ['implement']),
      node('research', 4, ['plan']),
    ]
    const first = computeTaskGraphLayout(graph(tasks))
    const second = computeTaskGraphLayout(graph([...tasks].reverse()))

    expect(second.mainline).toEqual(first.mainline)
    expect(second.positions).toEqual(first.positions)
  })
})
