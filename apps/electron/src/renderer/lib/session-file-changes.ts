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

function normalizeEvidencePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
}

/**
 * 判断内存里的写入路径与回退返回的相对路径是否指同一个文件。
 *
 * 内存记录来自工具的原始入参（可能是绝对路径），回退返回的是相对工作区根的路径，
 * 所以只能比尾部；但纯文件名不参与匹配——否则 `b.md` 会把任意目录下的同名文件一起抹掉。
 */
function refersToSameFile(left: string, right: string): boolean {
  const a = normalizeEvidencePath(left)
  const b = normalizeEvidencePath(right)
  if (!a || !b) return false
  if (a === b) return true
  const [longer, shorter] = a.length >= b.length ? [a, b] : [b, a]
  return shorter.includes('/') && longer.endsWith(`/${shorter}`)
}

/**
 * 回退成功后清理内存里的非 Git 变更记录。
 *
 * `deleted`（文件被回退删除）与 `restored`（文件恢复到回退前内容）都不再是「本次改动」；
 * `conflicts` 保留——文件确实被改过，只是没能自动对齐。
 */
export function dropRewoundSessionFileChanges(
  changes: readonly SessionFileChange[],
  files: { readonly deleted?: readonly string[]; readonly restored?: readonly string[] } | undefined,
): SessionFileChange[] {
  const rewound = [...(files?.deleted ?? []), ...(files?.restored ?? [])]
  if (rewound.length === 0) return [...changes]
  return changes.filter(
    (change) => !rewound.some((path) => refersToSameFile(change.path, path)),
  )
}
