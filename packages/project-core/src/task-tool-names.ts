/** Task graph tool name normalization shared by SDK-facing surfaces. */

import {
  TASK_GRAPH_TOOL_CREATE,
  TASK_GRAPH_TOOL_UPDATE,
  normalizeTaskGraphShortName,
} from '@profer/shared'

export type TaskGraphToolKind = 'create' | 'update' | null

/**
 * SDK MCP tools are surfaced as mcp__<server>__<tool>. Keep accepting the
 * historical bare names because persisted messages from older builds use them;
 * both spellings collapse to the current `profer_task_*` names.
 */
export function normalizeTaskGraphToolName(toolName: string): string {
  return normalizeTaskGraphShortName(toolName)
}

export function taskGraphToolKind(toolName: string): TaskGraphToolKind {
  switch (normalizeTaskGraphToolName(toolName)) {
    case TASK_GRAPH_TOOL_CREATE: return 'create'
    case TASK_GRAPH_TOOL_UPDATE: return 'update'
    default: return null
  }
}

export function isStructuredTaskGraphTool(toolName: string): boolean {
  return taskGraphToolKind(toolName) !== null
}

export function isTaskCreateTool(toolName: string): boolean {
  return toolName === 'TaskCreate' || taskGraphToolKind(toolName) === 'create'
}

export function isTaskUpdateTool(toolName: string): boolean {
  return toolName === 'TaskUpdate' || taskGraphToolKind(toolName) === 'update'
}
