import { describe, expect, test } from 'bun:test'
import type { TaskGraph, TaskNode } from '@profer/project-core'
import { decideGoalIntake } from './goal-controller'

function graph(nodes: TaskNode[] = []): TaskGraph {
  return { nodes: Object.fromEntries(nodes.map((node) => [node.id, node])), edges: [], forkEdges: [], updatedAt: 1 }
}

function node(id: string): TaskNode {
  return { id, subject: id, description: '', status: 'pending', dependsOn: [], dependedBy: [], artifact: [], reviewStatus: 'none', createdAt: 1, updatedAt: 1 }
}

describe('Pi Harness goal intake', () => {
  test('treats manual compact as a hard task boundary', () => {
    expect(decideGoalIntake({ userMessage: '/compact', graph: graph() })).toMatchObject({ kind: 'manual_compact' })
  })

  test('uses existing graph rather than creating a second root', () => {
    expect(decideGoalIntake({ userMessage: '继续实现功能', graph: graph([node('task-1')]) })).toMatchObject({ kind: 'existing_graph', focus: { task: { id: 'task-1' } } })
  })

  test('proposes only an explicit multi-step execution request as a minimal root', () => {
    const decision = decideGoalIntake({ userMessage: '分阶段实现 Pi Harness，并先写测试再接入运行时', graph: graph() })
    expect(decision).toMatchObject({ kind: 'minimal_root', rootTask: { subject: expect.stringContaining('分阶段实现 Pi Harness') } })
    expect(decision.rootTask?.description).toContain('最小任务骨架')
  })

  test('copies only explicit line-local verification markers into a minimal root', () => {
    const decision = decideGoalIntake({
      userMessage: '分阶段创建一个受控文件任务\n@artifact: dist/output.txt\n@verify: bun test target\n自然语言说它应该通过，但不是 marker',
      graph: graph(),
    })
    expect(decision.rootTask?.description).toContain('@artifact: dist/output.txt')
    expect(decision.rootTask?.description).toContain('@verify: bun test target')
    expect(decision.rootTask?.description).not.toContain('自然语言说它应该通过')
  })

  test('keeps simple questions graphless', () => {
    expect(decideGoalIntake({ userMessage: '为什么 Pi 的自动压缩属于同一个 Turn？', graph: graph() })).toMatchObject({ kind: 'graphless' })
  })

  test('creates a new proposed root on an explicit conflicting goal', () => {
    expect(decideGoalIntake({ userMessage: '重构这套执行控制逻辑', graph: graph([node('old')]), goalConflict: true })).toMatchObject({ kind: 'minimal_root' })
  })
})
