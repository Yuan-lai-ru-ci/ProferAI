import { coreTargetsAtom, ownsCoreResources } from '@/atoms/core-target-atoms'
import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { toast } from 'sonner'
import { Button } from '@profer/ui/primitives/button'
import { ConfirmDialog } from '@profer/ui/primitives/confirm-dialog'
import { Sheet, SheetContent, SheetTitle } from '@profer/ui/primitives/sheet'
import type { AgentWorkspace, GlobalMcpDefinition, McpServerEntry } from '@profer/shared'
import { workspaceCapabilitiesVersionAtom } from '@/atoms/agent-atoms'
import { WorkspaceMultiSelect } from './WorkspaceMultiSelect'
import { McpServerForm } from '../settings/McpServerForm'

interface Props {
  workspaces: AgentWorkspace[]
  search: string
  open: boolean
  setOpen: (value: boolean) => void
}

export function GlobalMcpPanel({ workspaces, search, open, setOpen }: Props): React.ReactElement {
  const coreOwned = ownsCoreResources(useAtomValue(coreTargetsAtom))
  const [items, setItems] = React.useState<GlobalMcpDefinition[]>([])
  const [editing, setEditing] = React.useState<GlobalMcpDefinition | null>(null)
  const [ids, setIds] = React.useState<string[]>([])
  const [deleting, setDeleting] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [revision, refresh] = React.useReducer(n => n + 1, 0)
  const bump = useSetAtom(workspaceCapabilitiesVersionAtom)
  React.useEffect(() => {
    if (coreOwned) return
    let current = true
    void window.electronAPI.listGlobalMcpServers().then(
      list => { if (current) setItems(list) },
      () => { if (current) toast.error('读取全局 MCP 失败') },
    )
    return () => { current = false }
  }, [revision, coreOwned])
  const close = () => { setOpen(false); setEditing(null); setIds([]) }
  const changed = () => { refresh(); bump(v => v + 1) }
  const visible = items.filter(item => item.name.toLowerCase().includes(search))
  const edit = (item: GlobalMcpDefinition) => {
    setEditing(item)
    setIds(item.workspaceIds)
    setOpen(true)
  }
  const save = async (name: string, entry: McpServerEntry) => {
    if (coreOwned) throw new Error('Core 暂不支持全局 MCP 管理')
    setBusy(true)
    try {
      await window.electronAPI.saveGlobalMcpServer({ name, entry, workspaceIds: ids }, editing ? 'update' : 'create')
    } catch (error) {
      toast.error('保存全局 MCP 失败，请检查名称和配置')
      throw error
    } finally {
      setBusy(false)
    }
  }
  const remove = async () => {
    if (coreOwned || !deleting || busy) return
    setBusy(true)
    try {
      await window.electronAPI.deleteGlobalMcpServer(deleting)
      setDeleting(null)
      changed()
    } catch {
      toast.error('删除全局 MCP 失败')
    } finally {
      setBusy(false)
    }
  }

  if (coreOwned) return <p role="status" className="text-sm text-muted-foreground">当前 Core 暂不支持全局 MCP 管理。请使用工作区 MCP 配置；不会读取或修改桌面全局配置。</p>

  return (
    <section aria-label="全局 MCP" className="space-y-3">
      <p className="text-sm text-muted-foreground">
        只有勾选的工作区会使用此配置；新工作区不会自动继承。同名时使用完整的工作区配置。
      </p>
      {visible.map(item => (
        <div key={item.name} className="flex items-center gap-3 rounded-lg bg-muted/40 p-3">
          <strong className="flex-1 truncate">{item.name}</strong>
          <span className="text-xs text-muted-foreground">{item.entry.type} · {item.entry.enabled ? '已启用' : '已停用'} · {item.workspaceIds.length} 个工作区</span>
          <Button variant="outline" onClick={() => edit(item)}>编辑</Button>
          <Button variant="ghost" onClick={() => setDeleting(item.name)}>删除</Button>
        </div>
      ))}
      {!visible.length && <p className="text-sm text-muted-foreground">{search ? '没有匹配的全局 MCP' : '尚无全局 MCP'}</p>}
      <Sheet open={open} onOpenChange={next => { if (!next && !busy) close() }}>
        <SheetContent hideClose aria-describedby={undefined} className="overflow-y-auto sm:max-w-[560px] space-y-4">
          <SheetTitle>全局 MCP 配置</SheetTitle>
          {open && <>
            <fieldset disabled={busy} className="space-y-2">
              <legend className="font-medium">允许使用的工作区</legend>
              <WorkspaceMultiSelect workspaces={workspaces} valueKey="id" values={ids} onChange={setIds} />
            </fieldset>
            <McpServerForm
              server={editing}
              onCancel={() => { if (!busy) close() }}
              onSaved={() => { close(); changed() }}
              onGlobalSave={save}
            />
          </>}
        </SheetContent>
      </Sheet>
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={next => { if (!next && !busy) setDeleting(null) }}
        title={`删除全局 MCP「${deleting}」？`}
        description="所有引用它的工作区将失去此服务。本地同名配置不会删除。"
        confirmLabel="删除"
        loadingLabel="删除中…"
        loading={busy}
        onConfirm={remove}
      />
    </section>
  )
}
