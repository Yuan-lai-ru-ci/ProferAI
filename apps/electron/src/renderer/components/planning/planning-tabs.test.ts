import { describe, expect, test } from 'bun:test'
import { GOAL_OVERVIEW_ENTRY_ENABLED } from '@/lib/product-feature-flags'
import { PLANNING_TABS } from './PlanningView'

describe('规划中心分区入口', () => {
  test('Goal 总览入口雪藏期间，独立规划窗口的 tab 里也没有 Goal', () => {
    expect(GOAL_OVERVIEW_ENTRY_ENABLED).toBe(false)
    expect(PLANNING_TABS.some((tab) => tab.id === 'goals')).toBe(false)
  })

  test('其余三个分区不受影响', () => {
    expect(PLANNING_TABS.map((tab) => tab.id)).toEqual(['todos', 'calendar', 'automations'])
  })
})
