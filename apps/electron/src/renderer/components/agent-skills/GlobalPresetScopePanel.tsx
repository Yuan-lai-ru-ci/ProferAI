import * as React from 'react'
import { Check } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { SettingsCard } from '@/components/settings/primitives'
import type { AgentPreset, AgentWorkspace, PresetReference, PresetReferenceReport, PresetWorkspaceReference } from '@profer/shared'

interface Props { preset: AgentPreset }
type ScopeRow = { workspaceSlug: string; workspaceName: string; references: PresetWorkspaceReference[] }
function ref(preset: AgentPreset): PresetReference { return { presetId: preset.id, presetScope: preset.scope ?? (preset.isBuiltin ? 'builtin-meta' : 'user-global') } }

/** 全局/元预设详情中的工作区生效范围；交互与预设编辑器的多选白名单保持一致。 */
export function GlobalPresetScopePanel({ preset }: Props): React.ReactElement {
  const [report, setReport] = React.useState<PresetReferenceReport | null>(null)
  const [workspaces, setWorkspaces] = React.useState<AgentWorkspace[]>([])
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  const [query, setQuery] = React.useState('')
  const [busy, setBusy] = React.useState(false)

  const load = React.useCallback(async () => {
    const [nextReport, listed] = await Promise.all([
      window.electronAPI.getPresetReferenceReport(ref(preset)),
      window.electronAPI.listAgentWorkspaces(),
    ])
    setReport(nextReport)
    setWorkspaces(listed.filter((workspace) => !workspace.isDeleted))
    setSelected(new Set(nextReport.workspaceScopes.map((scope) => scope.workspaceSlug)))
  }, [preset.id, preset.scope])

  React.useEffect(() => { void load().catch((error) => toast.error(error instanceof Error ? error.message : '读取工作区范围失败')) }, [load])

  const rows = React.useMemo(() => {
    const names = new Map(workspaces.map((workspace) => [workspace.slug, workspace.name]))
    const map = new Map<string, ScopeRow>()
    for (const scope of report?.workspaceScopes ?? []) map.set(scope.workspaceSlug, { ...scope, references: [] })
    for (const item of report?.blockers ?? []) {
      const row = map.get(item.workspaceSlug) ?? { workspaceSlug: item.workspaceSlug, workspaceName: item.workspaceName, references: [] }
      row.references.push(item)
      map.set(item.workspaceSlug, row)
    }
    for (const workspace of workspaces) {
      if (!map.has(workspace.slug)) map.set(workspace.slug, { workspaceSlug: workspace.slug, workspaceName: names.get(workspace.slug) ?? workspace.slug, references: [] })
    }
    return [...map.values()]
  }, [report, workspaces])

  const visibleRows = rows.filter((row) => `${row.workspaceName} ${row.workspaceSlug}`.toLowerCase().includes(query.trim().toLowerCase()))
  const toggle = (slug: string): void => setSelected((previous) => {
    const next = new Set(previous)
    if (next.has(slug)) next.delete(slug)
    else next.add(slug)
    return next
  })
  const save = async (): Promise<void> => {
    setBusy(true)
    try {
      const current = new Set(report?.workspaceScopes.map((scope) => scope.workspaceSlug) ?? [])
      const additions = [...selected].filter((slug) => !current.has(slug))
      const removals = [...current].filter((slug) => !selected.has(slug))
      await Promise.all([
        ...additions.map((slug) => window.electronAPI.enableGlobalPresetInWorkspace(slug, ref(preset))),
        ...removals.map((slug) => window.electronAPI.disableGlobalPresetInWorkspace(slug, ref(preset))),
      ])
      await load()
      toast.success('工作区生效范围已更新')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '更新工作区范围失败')
      await load().catch(() => undefined)
    } finally { setBusy(false) }
  }

  return <div className="space-y-2"><div className="flex items-center justify-between gap-2"><div><div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">生效工作区</div><div className="mt-1 text-[11px] text-muted-foreground">已选择 {selected.size} / {workspaces.length}</div></div><Button size="sm" onClick={() => void save()} disabled={busy || !report}>{busy ? '保存中…' : '保存范围'}</Button></div><SettingsCard divided={false}><div className="space-y-3 p-3"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索工作区…" className="h-8 w-full rounded-md border border-border bg-transparent px-2.5 text-xs outline-none focus:ring-1 focus:ring-ring" /><div className="flex items-center justify-between text-[11px] text-muted-foreground"><span>工作区白名单</span><div className="flex gap-2"><button type="button" onClick={() => setSelected(new Set(visibleRows.map((row) => row.workspaceSlug)))} className="hover:text-foreground">全选</button><button type="button" onClick={() => setSelected(new Set())} className="hover:text-foreground">清空</button></div></div><div className="grid max-h-56 gap-1 overflow-y-auto">{visibleRows.map((row) => <button key={row.workspaceSlug} type="button" disabled={busy} onClick={() => toggle(row.workspaceSlug)} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent disabled:opacity-50"><span className="flex size-4 shrink-0 items-center justify-center rounded border border-border">{selected.has(row.workspaceSlug) && <Check size={12} className="text-primary" />}</span><span className="min-w-0 flex-1 truncate">{row.workspaceName}</span>{row.references.length > 0 && <span className="text-[10px] text-muted-foreground">引用 {row.references.reduce((sum, item) => sum + item.objectCount, 0)}</span>}</button>)}{visibleRows.length === 0 && <p className="p-4 text-center text-xs text-muted-foreground">没有匹配的工作区</p>}</div></div></SettingsCard></div>
}
