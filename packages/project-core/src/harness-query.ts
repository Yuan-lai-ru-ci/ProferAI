/**
 * Deterministic Project Graph queries used by the Pi Host Harness.
 *
 * This module is browser-safe and intentionally has no Pi, Electron, model, or
 * persistence dependency. It selects graph facts only; the host decides whether
 * a selected task may result in a new model turn.
 */

import type { TaskGraph, TaskNode } from './types'
import { getReadyTasks } from './graph-state'

export type HarnessFocusKind = 'in_progress' | 'previous_focus' | 'ready' | 'blocked' | 'graphless'

export interface HarnessFocus {
  kind: HarnessFocusKind
  task?: TaskNode
  reason: string
}

export interface HarnessBlockedTask {
  task: TaskNode
  unmetDependencies: Array<{ id: string; status: TaskNode['status'] | 'missing' }>
}

export interface TaskVerificationContext {
  taskId: string
  artifacts: string[]
  explicitCriteria: string[]
  required: boolean
}

function stableTaskOrder(a: TaskNode, b: TaskNode): number {
  return a.createdAt - b.createdAt || a.id.localeCompare(b.id)
}

/**
 * Selects exactly one focus without mutating the graph:
 * in-progress task -> still-valid previous focus -> oldest ready task -> blocked/graphless.
 */
export function selectHarnessFocus(graph: TaskGraph, previousFocusTaskId?: string): HarnessFocus {
  const nodes = Object.values(graph.nodes)
  const inProgress = nodes.filter((node) => node.status === 'in_progress').sort(stableTaskOrder)
  if (inProgress.length > 0) {
    return { kind: 'in_progress', task: inProgress[0], reason: '选择现有进行中的任务' }
  }

  if (previousFocusTaskId) {
    const previous = graph.nodes[previousFocusTaskId]
    if (previous && previous.status === 'pending' && previous.dependsOn.every((id) => graph.nodes[id]?.status === 'completed')) {
      return { kind: 'previous_focus', task: previous, reason: '沿用仍可执行的上次焦点任务' }
    }
  }

  const ready = getReadyTasks(graph).sort(stableTaskOrder)
  if (ready.length > 0) {
    return { kind: 'ready', task: ready[0], reason: '选择创建时间最早的就绪任务' }
  }

  if (nodes.length > 0) {
    return { kind: 'blocked', reason: '图中不存在可执行任务；所有待处理任务均被依赖阻塞或图存在循环' }
  }
  return { kind: 'graphless', reason: '当前会话尚无任务图' }
}

/** Returns pending tasks that cannot start, with only their unmet dependency facts. */
export function getHarnessBlockedTasks(graph: TaskGraph): HarnessBlockedTask[] {
  return Object.values(graph.nodes)
    .filter((task) => task.status === 'pending')
    .map((task) => ({
      task,
      unmetDependencies: task.dependsOn
        .filter((id) => graph.nodes[id]?.status !== 'completed')
        .map((id): { id: string; status: TaskNode['status'] | 'missing' } => ({
          id,
          status: graph.nodes[id]?.status ?? 'missing',
        })),
    }))
    .filter((item) => item.unmetDependencies.length > 0)
    .sort((a, b) => stableTaskOrder(a.task, b.task))
}

/**
 * Reads only explicit, finite verification facts from a task. It does not infer
 * a command or semantic completion from general prose.
 */
export function getTaskVerificationContext(task: TaskNode): TaskVerificationContext {
  const explicitCriteria = task.description
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*@?verify:\s*(.+)$/i)?.[1]?.trim())
    .filter((value): value is string => Boolean(value))

  return {
    taskId: task.id,
    artifacts: [...new Set(task.artifact)].sort((a, b) => a.localeCompare(b)),
    explicitCriteria,
    required: explicitCriteria.length > 0 || task.artifact.length > 0,
  }
}
