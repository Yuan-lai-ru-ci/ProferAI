/**
 * session-file-changes.ts — 非 Git 目录中 Agent 写入的文件变更追踪
 *
 * 在非 Git 项目里，Agent 通过 Write/Edit 等工具创建或修改的文件不会产生
 * Git diff，但仍应在「文件改动」面板中展示。本模块提供变更记录的类型定义
 * 和去重/分组工具，配合 useGlobalAgentListeners 监听写工具事件来积累变更，
 * 并由 DiffChangesList 渲染。
 */

export type SessionFileChangeKind = 'created' | 'edited'

export interface SessionFileChange {
  path: string
  kind: SessionFileChangeKind
  runId: string
  updatedAt: number
}

/** 根据工具名判断变更类型：Write 视为新建，Edit 等视为编辑 */
export function getSessionFileChangeKind(toolName: string): SessionFileChangeKind {
  if (toolName === 'Write') return 'created'
  return 'edited'
}

/**
 * 向已有变更列表中插入或更新一条记录。
 * - 按 path 去重，同路径保留「最早」的 kind（created 不会被后续 edit 覆盖）
 * - 最新记录排在数组最前面
 */
export function upsertSessionFileChange(
  changes: readonly SessionFileChange[],
  next: SessionFileChange,
): SessionFileChange[] {
  const index = changes.findIndex((change) => change.path === next.path)
  if (index < 0) return [next, ...changes]

  const current = changes[index]!
  const updated: SessionFileChange = {
    ...next,
    // 文件在本会话中首次创建后，后续编辑仍标记为 created
    kind: current.kind === 'created' ? 'created' : next.kind,
  }
  return changes.map((change, changeIndex) =>
    changeIndex === index ? updated : change,
  )
}

/** 按当前 runId 将变更分为「本轮」和「更早」两组 */
export function groupSessionFileChanges(
  changes: readonly SessionFileChange[],
  currentRunId: string | undefined,
): { current: SessionFileChange[]; earlier: SessionFileChange[] } {
  if (!currentRunId) return { current: [...changes], earlier: [] }
  return {
    current: changes.filter((change) => change.runId === currentRunId),
    earlier: changes.filter((change) => change.runId !== currentRunId),
  }
}
