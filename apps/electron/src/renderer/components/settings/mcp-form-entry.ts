/**
 * MCP 表单条目合并
 *
 * 背景：MCP 表单是「读 → 改 → 写」链路，且编辑态有防抖自动保存。
 * 如果直接把表单构建的条目整体覆盖回去，磁盘上那些表单不编辑的字段
 * （`lastTestResult`、`externalStatePaths`）会被一次自动保存静默抹掉：
 * - 测试结果丢了，UI 会退回「尚未测试」；
 * - 外部配置声明丢了，`externalStateStale` 检测失效。
 *
 * 规则：表单字段以表单值为准，其余字段（如 `externalStatePaths`）保留磁盘上的值。
 * `lastTestResult` 也算表单所有：配置一改，旧结果就不该继续显示为「已测试」。
 */
import type { McpServerEntry } from '@profer/shared'

/** 表单编辑的字段：写回时整体以表单值为准，不做保留 */
export const FORM_OWNED_FIELDS = [
  'type',
  'command',
  'args',
  'env',
  'timeout',
  'url',
  'headers',
  'enabled',
  'isBuiltin',
  'lastTestResult',
] as const

export function mergeEntryWithExisting(
  existing: McpServerEntry | undefined,
  entry: McpServerEntry,
): McpServerEntry {
  if (!existing) return entry

  const preserved: Record<string, unknown> = { ...(existing as unknown as Record<string, unknown>) }
  for (const field of FORM_OWNED_FIELDS) delete preserved[field]

  return { ...(preserved as Partial<McpServerEntry>), ...entry }
}
