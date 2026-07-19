import { describe, expect, test } from 'bun:test'
import {
  isStructuredTaskGraphTool,
  isTaskCreateTool,
  isTaskUpdateTool,
  normalizeTaskGraphToolName,
} from './index'

describe('task graph tool names', () => {
  test('recognizes the real Claude SDK MCP server-prefixed names', () => {
    expect(normalizeTaskGraphToolName('mcp__task-graph__proma_task_create')).toBe('proma_task_create')
    expect(isStructuredTaskGraphTool('mcp__task-graph__proma_task_create')).toBe(true)
    expect(isTaskCreateTool('mcp__task-graph__proma_task_create')).toBe(true)
    expect(isTaskUpdateTool('mcp__task_graph__proma_task_update')).toBe(true)
  })

  test('keeps native and historical bare tool names compatible', () => {
    expect(isTaskCreateTool('TaskCreate')).toBe(true)
    expect(isTaskUpdateTool('TaskUpdate')).toBe(true)
    expect(isStructuredTaskGraphTool('proma_task_update')).toBe(true)
    expect(isStructuredTaskGraphTool('mcp__automation__create_automation')).toBe(false)
  })
})
