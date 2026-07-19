/** Task graph tool name normalization shared by SDK-facing surfaces. */

export type TaskGraphToolKind = 'create' | 'update' | null

/**
 * SDK MCP tools are surfaced as mcp__<server>__<tool>. Keep accepting the
 * historical bare names because persisted messages from older builds use them.
 */
export function normalizeTaskGraphToolName(toolName: string): string {
  return toolName
    .replace(/^mcp__task[-_]graph__/, '')
}

export function taskGraphToolKind(toolName: string): TaskGraphToolKind {
  switch (normalizeTaskGraphToolName(toolName)) {
    case 'proma_task_create': return 'create'
    case 'proma_task_update': return 'update'
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
