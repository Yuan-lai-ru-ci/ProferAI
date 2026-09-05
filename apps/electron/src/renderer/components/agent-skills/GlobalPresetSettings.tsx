import * as React from 'react'
import { Check, ChevronDown, Eye, Plus, ShieldCheck, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { SettingsCard, SettingsSection } from '@/components/settings/primitives'
import type { AgentPreset, AgentWorkspace, PresetReference, PresetReferenceReport, PresetWorkspaceReference } from '@profer/shared'

function referenceFor(preset: AgentPreset): PresetReference {
  return { presetId: preset.id, presetScope: preset.scope ?? (preset.isBuiltin ? 'builtin-meta' : 'user-global') }
}

export function GlobalPresetSettings(): React.ReactElement {
  const [presets, setPresets] = React.useState<AgentPreset[]>([])
  const [selected, setSelected] = React.useState<AgentPreset | null>(null)
  const [loading, setLoading] = React.useState(true)
  const load = React.useCallback(async () => {
    setLoading(true)
    try { setPresets(await window.electronAPI.listGlobalAgentPresets()) }
    catch (error) { toast.error(error instanceof Error ? error.message : '加载全局预设失败'); setPresets([]) }
    finally { setLoading(false) }
  }, [])
  React.useEffect(() => { void load() }, [load])
  return <SettingsSection title="全局 Agent 预设" description="复用预设设置列表；点击条目查看详情，并在详情中管理工作区生效范围。">
    <div className="flex justify-end"><Button size="sm" variant="outline" onClick={() => void load()} disabled={loading}>刷新</Button></div>
    <SettingsCard divided>{loading ? <div className="p-4 text-sm text-muted-foreground">加载中…</div> : presets.map((preset) => <button key={`${preset.scope}:${preset.id}`} type="button" onClick={() => setSelected(preset)} className="flex w-full items-center justify-between gap-3 p-4 text-left transition-colors hover:bg-muted/40"><div className="min-w-0 flex-1"><div className="flex items-center gap-2"><span className="truncate text-sm font-medium">{preset.name}</span>{preset.scope === 'builtin-meta' ? <BuiltinTag /> : <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">用户全局</span>}</div><p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{preset.description || '暂无描述'}</p></div><Eye size={16} className="shrink-0 text-muted-foreground" /></button>)}</SettingsCard>
    <GlobalPresetDetail preset={selected} onOpenChange={(open) => { if (!open) setSelected(null) }} onChanged={() => void load()} />
  </SettingsSection>
}

function BuiltinTag(): React.ReactElement { return <span className="inline-flex items-center gap-1 rounded-md bg-blue-500/15 px-1.5 py-0.5 text-[10px] font-medium text-blue-700 dark:text-blue-300"><ShieldCheck size={11} />Profer 内置 · 只读</span> }

function GlobalPresetDetail({ preset, onOpenChange, onChanged }: { preset: AgentPreset | null; onOpenChange: (open: boolean) => void; onChanged: () => void }): React.ReactElement {
  const [report, setReport] = React.useState<PresetReferenceReport | null>(null)
  const [workspaces, setWorkspaces] = React.useState<AgentWorkspace[]>([])
  const [candidates, setCandidates] = React.useState<AgentPreset[]>([])
  const [replacementId, setReplacementId] = React.useState('')
  const [removingWorkspaceSlug, setRemovingWorkspaceSlug] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [addOpen, setAddOpen] = React.useState(false)
  const reference = preset ? referenceFor(preset) : null
  const reload = React.useCallback(async () => {
    if (!reference) return
    const [nextReport, listed] = await Promise.all([window.electronAPI.getPresetReferenceReport(reference), window.electronAPI.listAgentWorkspaces()])
    setReport(nextReport); setWorkspaces(listed.filter((workspace) => !workspace.isDeleted))
  }, [reference?.presetId, reference?.presetScope])
  React.useEffect(() => { if (preset) void reload().catch((error) => toast.error(error instanceof Error ? error.message : '读取预设影响失败')) }, [preset, reload])
  const activeScopes = React.useMemo(() => scopeRows(report?.blockers ?? []), [report])
  const activeSlugs = new Set(activeScopes.map((scope) => scope.workspaceSlug))
  const available = workspaces.filter((workspace) => !activeSlugs.has(workspace.slug))
  const loadCandidates = async (workspaceSlug: string): Promise<void> => { setReplacementId(''); setCandidates(await window.electronAPI.listAgentPresets(workspaceSlug)) }
  const mutate = async (action: () => Promise<void>, success: string): Promise<void> => { setBusy(true); try { await action(); toast.success(success); await reload(); onChanged() } catch (error) { toast.error(error instanceof Error ? error.message : '更新范围失败') } finally { setBusy(false) } }
  const addWorkspace = (workspaceSlug: string): void => { if (!reference) return; void mutate(async () => { await window.electronAPI.setDefaultAgentPresetReference(workspaceSlug, reference) }, '已添加工作区生效范围'); setAddOpen(false) }
  const chooseReplacementWorkspace = async (workspaceSlug: string): Promise<void> => { setRemovingWorkspaceSlug(workspaceSlug); try { await loadCandidates(workspaceSlug) } catch (error) { toast.error(error instanceof Error ? error.message : '加载替代预设失败') } }
  const removeScope = (scope: ScopeRow): void => {
    if (!replacementId) { toast.error('请先选择替代预设，再移除该工作区范围'); return }
    const replacement = candidates.find((candidate) => candidate.id === replacementId)
    if (!replacement) { toast.error('请选择有效的替代预设'); return }
    const next = referenceFor(replacement)
    void mutate(async () => {
      for (const entry of scope.references) {
        if (entry.reason === 'workspace-default') await window.electronAPI.setDefaultAgentPresetReference(scope.workspaceSlug, next)
        else if (entry.reason === 'session') await Promise.all(entry.objectIds.map((id) => window.electronAPI.rebindAgentSessionPresetReference(id, next)))
        else if (entry.reason === 'automation') await Promise.all(entry.objectIds.map((id) => window.electronAPI.rebindAutomationPresetReference(id, next)))
      }
    }, '已改绑并移除该工作区范围')
    setRemovingWorkspaceSlug(null)
  }
  const deletePreset = (): void => { if (!reference || !report?.canDelete || preset?.scope !== 'user-global') return; void mutate(() => window.electronAPI.deleteGlobalAgentPreset(reference), '已删除全局预设'); onOpenChange(false) }
  return <Dialog open={preset !== null} onOpenChange={onOpenChange}><DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-[680px]"><DialogHeader><DialogTitle>预设详情 · {preset?.name}</DialogTitle><DialogDescription>保留原有预设信息样式；工作区范围在此详情中管理。</DialogDescription></DialogHeader>{preset && <div className="space-y-4"><div className="flex items-center gap-2">{preset.scope === 'builtin-meta' ? <BuiltinTag /> : <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">用户全局</span>}<span className="text-xs text-muted-foreground">v{preset.version ?? '—'}</span></div><p className="text-sm text-muted-foreground">{preset.description || '暂无描述'}</p><SettingsCard divided={false}><div className="flex flex-wrap items-center gap-2 p-4"><span className="mr-1 text-sm font-medium">已生效工作区：</span>{activeScopes.map((scope) => <span key={scope.workspaceSlug} className="inline-flex items-center gap-1 rounded-full bg-primary/10 py-1 pl-2.5 pr-1.5 text-xs text-primary"><span>{scope.workspaceName}</span><button type="button" aria-label={`移除 ${scope.workspaceName}`} disabled={busy} onClick={() => void chooseReplacementWorkspace(scope.workspaceSlug)} className="rounded-full p-0.5 hover:bg-primary/15 disabled:opacity-50"><X size={12} /></button></span>)}<Popover open={addOpen} onOpenChange={setAddOpen}><PopoverTrigger asChild><Button size="sm" variant="outline" disabled={busy || available.length === 0}><Plus size={13} className="mr-1" />添加工作区<ChevronDown size={13} className="ml-1" /></Button></PopoverTrigger><PopoverContent align="start" className="w-56 p-1">{available.length ? available.map((workspace) => <button key={workspace.id} type="button" onClick={() => addWorkspace(workspace.slug)} className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent"><span className="truncate">{workspace.name}</span><Check size={13} className="text-primary" /></button>) : <p className="p-2 text-xs text-muted-foreground">所有工作区均已生效</p>}</PopoverContent></Popover></div></SettingsCard>
    {activeScopes.filter((scope) => scope.workspaceSlug === removingWorkspaceSlug).map((scope) => <div key={scope.workspaceSlug} className="rounded-lg border border-border/60 p-3"><p className="text-sm font-medium">移除「{scope.workspaceName}」范围</p><p className="mt-1 text-xs text-muted-foreground">需选择该工作区的替代预设，并逐项改绑默认值、会话和自动任务。</p><select className="mt-2 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm" value={replacementId} onChange={(event) => setReplacementId(event.target.value)}><option value="">选择替代预设…</option>{candidates.filter((candidate) => candidate.id !== preset.id || candidate.scope !== preset.scope).map((candidate) => <option key={`${candidate.scope}:${candidate.id}`} value={candidate.id}>{candidate.name}</option>)}</select><div className="mt-2 flex gap-2"><Button size="sm" variant="outline" onClick={() => setRemovingWorkspaceSlug(null)}>取消</Button><Button size="sm" variant="outline" disabled={busy || !replacementId} onClick={() => removeScope(scope)}>确认改绑并移除</Button></div></div>)}
    {preset.scope === 'user-global' && <Button size="sm" variant="ghost" className="text-destructive" disabled={busy || !report?.canDelete} onClick={deletePreset}><Trash2 size={14} className="mr-1" />删除全局预设</Button>}</div>}</DialogContent></Dialog>
}

type ScopeRow = { workspaceSlug: string; workspaceName: string; references: PresetWorkspaceReference[] }
function scopeRows(references: PresetWorkspaceReference[]): ScopeRow[] { const groups = new Map<string, ScopeRow>(); for (const reference of references) { const current = groups.get(reference.workspaceSlug) ?? { workspaceSlug: reference.workspaceSlug, workspaceName: reference.workspaceName, references: [] }; current.references.push(reference); groups.set(reference.workspaceSlug, current) } return [...groups.values()] }
