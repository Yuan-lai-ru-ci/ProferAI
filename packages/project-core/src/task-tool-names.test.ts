import { describe, expect, test } from 'bun:test'
import {
  isStructuredTaskGraphTool,
  isTaskCreateTool,
  isTaskUpdateTool,
  normalizeTaskGraphToolName,
} from './index'

describe('task graph tool names', () => {
  test('recognizes the current Claude SDK MCP server-prefixed names', () => {
    expect(normalizeTaskGraphToolName('mcp__task-graph__profer_task_create')).toBe('profer_task_create')
    expect(isStructuredTaskGraphTool('mcp__task-graph__profer_task_create')).toBe(true)
    expect(isTaskCreateTool('mcp__task-graph__profer_task_create')).toBe(true)
    expect(isTaskUpdateTool('mcp__task_graph__profer_task_update')).toBe(true)
  })

  test('keeps native and bare tool names compatible', () => {
    expect(isTaskCreateTool('TaskCreate')).toBe(true)
    expect(isTaskUpdateTool('TaskUpdate')).toBe(true)
    expect(isStructuredTaskGraphTool('mcp__automation__create_automation')).toBe(false)
  })
})
