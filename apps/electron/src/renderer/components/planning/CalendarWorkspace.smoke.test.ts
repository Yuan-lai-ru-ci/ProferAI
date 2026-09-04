import { describe, expect, test } from 'bun:test'
import type { Todo } from '@profer/shared'
import { buildWeekView } from './CalendarWorkspace'

// 周锚点：2026-08-03 00:00 当地时区（buildWeekView 以该值为周一展开 7 天）。
const WEEK_START = new Date(2026, 7, 3, 0, 0, 0, 0).getTime()

function startOfDay(value: number | Date): number {
  const date = new Date(value)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

function makeTodo(partial: Partial<Todo> & { id: string; title: string }): Todo {
  const now = Date.now()
  return {
    status: 'open',
    priority: 'medium',
    tags: [],
    reminders: [],
    sessionLinks: [],
    workspaceId: undefined,
    createdAt: now,
    updatedAt: now,
    completedAt: undefined,
    ...partial,
  }
}

function collectTodos(week: ReturnType<typeof buildWeekView>): Todo[] {
  const todos: Todo[] = []
  for (const items of week.dayItems.values()) {
    for (const todo of items.allDayTodos) todos.push(todo)
    for (const segment of items.timedSegments) {
      if (segment.item.kind === 'todo') todos.push(segment.item.todo)
    }
  }
  return todos
}

describe('日程冒烟测试 · 已完成 todo 仍显示在日历（本次改动核心）', () => {
  test('completed + dueAt 的 todo 会进入周视图对应日期', () => {
    const due = WEEK_START + 14 * 60 * 60 * 1000 // 周二 14:00
    const completed = makeTodo({ id: 'c1', title: '已完成任务', status: 'completed', dueAt: due })

    const week = buildWeekView(WEEK_START, [], [completed], [])
    const found = collectTodos(week)
    expect(found.length).toBe(1)
    expect(found[0]!.id).toBe('c1')
    expect(found[0]!.status).toBe('completed')
  })

  test('open + dueAt 的 todo 仍正常进入周视图（无回归）', () => {
    const due = WEEK_START + 30 * 60 * 60 * 1000 // 周二
    const open = makeTodo({ id: 'o1', title: '未完成任务', status: 'open', dueAt: due })

    const week = buildWeekView(WEEK_START, [], [open], [])
    const found = collectTodos(week)
    expect(found.length).toBe(1)
    expect(found[0]!.id).toBe('o1')
  })

  test('无 dueAt 的 todo（无论状态）不进入周视图', () => {
    const noDueOpen = makeTodo({ id: 'x1', title: '未设时间', status: 'open' })
    const noDueDone = makeTodo({ id: 'x2', title: '未设时间已完成', status: 'completed' })

    const week = buildWeekView(WEEK_START, [], [noDueOpen, noDueDone], [])
    expect(collectTodos(week)).toEqual([])
  })

  test('同一天未完成与已完成 todo 都保留（互不覆盖）', () => {
    const due = WEEK_START + 9 * 60 * 60 * 1000 // 周二 09:00
    const open = makeTodo({ id: 'a1', title: '做中', status: 'open', dueAt: due })
    const done = makeTodo({ id: 'a2', title: '做完', status: 'completed', dueAt: due })

    const week = buildWeekView(WEEK_START, [], [open, done], [])
    const found = collectTodos(week).map((t) => t.id).sort()
    expect(found).toEqual(['a1', 'a2'])
  })
})
