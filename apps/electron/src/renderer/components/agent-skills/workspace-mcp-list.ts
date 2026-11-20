import type { WorkspaceGlobalMcpSummary, WorkspaceMcpConfig } from '@profer/shared'

/** 按有效服务名计数，按来源展示；同名的全局摘要仍独立显示遮蔽原因。 */
export function workspaceMcpList(servers: WorkspaceMcpConfig['servers'], summaries: WorkspaceGlobalMcpSummary[], query: string) {
  const localEntries = Object.entries(servers).filter(([name]) => name !== 'memos-cloud')
  const total = new Set([...localEntries.map(([name]) => name), ...summaries.map(s => s.name)]).size
  const matches = (name: string) => name.toLowerCase().includes(query.trim().toLowerCase())
  const local = localEntries.filter(([name]) => matches(name))
  const global = summaries.filter(s => matches(s.name))
  const empty = !total ? 'unconfigured' : !local.length && !global.length ? 'unmatched' : null
  return { total, local, global, empty } as const
}
