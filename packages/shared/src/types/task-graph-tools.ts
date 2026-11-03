/**
 * 任务图工具名。
 *
 * 改名前的存量数据不再兼容读取：新写入一律用 `profer_task_*`。
 */
export const TASK_GRAPH_TOOL_CREATE = 'profer_task_create'
export const TASK_GRAPH_TOOL_UPDATE = 'profer_task_update'

/** 去掉 `mcp__<server>__` 前缀，得到裸工具名。 */
export function normalizeTaskGraphShortName(toolName: string): string {
  return toolName.split('__').at(-1) ?? toolName
}
