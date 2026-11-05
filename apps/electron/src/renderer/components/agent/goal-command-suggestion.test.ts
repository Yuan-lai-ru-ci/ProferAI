import { describe, expect, test } from 'bun:test'
import { filterGoalCommandItems, GOAL_COMMAND_ITEMS, matchGoalCommandQuery } from './goal-command-suggestion'
import { parseGoalCommand } from '@profer/shared'

describe('Goal 命令提示', () => {
  test('只在 /goal 或 /goal 子命令前缀时接管', () => {
    expect(matchGoalCommandQuery('/goal')).toEqual({ query: '' })
    expect(matchGoalCommandQuery('/goal ')).toEqual({ query: '' })
    expect(matchGoalCommandQuery('/goal sta')).toEqual({ query: 'sta' })
    expect(matchGoalCommandQuery('  /goal pa')).toEqual({ query: 'pa' })
    // 非 Goal 文本交回 Skill 补全
    expect(matchGoalCommandQuery('/skill')).toBeNull()
    expect(matchGoalCommandQuery('/goal 完成登录页')).toBeNull()
    expect(matchGoalCommandQuery('hello')).toBeNull()
  })

  test('空查询展示全部模板，子命令前缀按标签过滤', () => {
    expect(filterGoalCommandItems('')).toHaveLength(GOAL_COMMAND_ITEMS.length)
    expect(filterGoalCommandItems('sta').map((item) => item.insert)).toEqual(['/goal status'])
    expect(filterGoalCommandItems('res').map((item) => item.insert)).toEqual(['/goal resume'])
  })

  test('每个模板都对应 parseGoalCommand 真实支持的命令（不会提示出非法命令）', () => {
    for (const item of GOAL_COMMAND_ITEMS) {
      const text = item.insert.trim()
      const parsed = parseGoalCommand(text)
      // 启动模板 `/goal ` 是待补全的空目标，其余都必须是可执行子命令
      if (text === '/goal') {
        expect(parsed.type).toBe('invalid')
      } else {
        expect(parsed.type).toBe(text.replace('/goal ', '') as typeof parsed.type)
      }
    }
  })
})
