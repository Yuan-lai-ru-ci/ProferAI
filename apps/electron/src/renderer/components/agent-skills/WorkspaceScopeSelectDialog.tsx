import * as React from 'react'
import { Check, ArrowLeft, Trash2, Save } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { AgentWorkspace } from '@profer/shared'

interface Props {
  open: boolean
  title: string
  description: string
  workspaces: AgentWorkspace[]
  initialWorkspaceSlug?: string
  onOpenChange: (open: boolean) => void
  onConfirm: (workspaceSlugs: string[], keepWorkspaceCopy: boolean) => void | Promise<void>
}

/** 提升能力的两步选择器：先选全局范围，再明确选择保留或删除当前工作区副本。 */
export function WorkspaceScopeSelectDialog({ open, title, description, workspaces, initialWorkspaceSlug, onOpenChange, onConfirm }: Props): React.ReactElement {
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  const [query, setQuery] = React.useState('')
  const [step, setStep] = React.useState<1 | 2>(1)
  const [keepWorkspaceCopy, setKeepWorkspaceCopy] = React.useState(true)
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => {
    if (open) {
      setSelected(new Set(initialWorkspaceSlug ? [initialWorkspaceSlug] : []))
      setQuery('')
      setStep(1)
      setKeepWorkspaceCopy(true)
    }
  }, [open, initialWorkspaceSlug])

  const visible = workspaces.filter((workspace) => `${workspace.name} ${workspace.slug}`.toLowerCase().includes(query.trim().toLowerCase()))
  const toggle = (slug: string): void => setSelected((previous) => {
    const next = new Set(previous)
    if (next.has(slug)) next.delete(slug)
    else next.add(slug)
    return next
  })
  const confirm = async (): Promise<void> => {
    setBusy(true)
    try { await onConfirm([...selected], keepWorkspaceCopy) } finally { setBusy(false) }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next) }}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{step === 1 ? description : '请选择是否保留当前工作区中的原能力。此选择会立即影响当前工作区。'}</DialogDescription>
        </DialogHeader>
        {step === 1 ? (
          <div className="flex flex-col gap-3">
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索工作区…" className="h-9 rounded-md border border-border bg-transparent px-3 text-sm outline-none focus:ring-1 focus:ring-ring" />
            <div className="flex items-center justify-between text-xs text-muted-foreground"><span>已选择 {selected.size} 个工作区</span><div className="flex gap-2"><button type="button" onClick={() => setSelected((current) => new Set([...current, ...visible.map((workspace) => workspace.slug)]))} className="hover:text-foreground">全选</button><button type="button" onClick={() => setSelected(new Set())} className="hover:text-foreground">清空</button></div></div>
            <div className="grid max-h-64 gap-1 overflow-y-auto rounded-md border border-border/60 p-1">{visible.map((workspace) => <button key={workspace.id} type="button" onClick={() => toggle(workspace.slug)} className="flex items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm hover:bg-accent"><span className="flex size-4 items-center justify-center rounded border border-border">{selected.has(workspace.slug) && <Check size={12} className="text-primary" />}</span><span className="truncate">{workspace.name}</span></button>)}{visible.length === 0 && <p className="p-4 text-center text-xs text-muted-foreground">没有匹配的工作区</p>}</div>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border/60 p-3 hover:bg-accent/40"><input type="radio" name="promote-copy-policy" checked={keepWorkspaceCopy} onChange={() => setKeepWorkspaceCopy(true)} className="mt-0.5" /><span><span className="block text-sm font-medium">保留并关闭原工作区能力</span><span className="mt-1 block text-xs text-muted-foreground">原条目保留在原排序位置，但立即变为关闭状态。</span></span></label>
            <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-destructive/30 p-3 hover:bg-destructive/5"><input type="radio" name="promote-copy-policy" checked={!keepWorkspaceCopy} onChange={() => setKeepWorkspaceCopy(false)} className="mt-0.5" /><span><span className="block text-sm font-medium text-destructive">删除原工作区能力</span><span className="mt-1 block text-xs text-muted-foreground">删除后无法从当前工作区恢复；预设仍会执行引用保护。</span></span></label>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => step === 1 ? onOpenChange(false) : setStep(1)} disabled={busy}>{step === 1 ? '取消' : <><ArrowLeft size={14} className="mr-1" />返回</>}</Button>
          {step === 1 ? <Button onClick={() => setStep(2)} disabled={busy}>下一步<Save size={14} className="ml-1" /></Button> : <Button variant={keepWorkspaceCopy ? 'default' : 'destructive'} onClick={() => void confirm()} disabled={busy}>{busy ? '处理中…' : keepWorkspaceCopy ? '提升并保留（关闭原能力）' : <><Trash2 size={14} className="mr-1" />提升并删除原能力</>}</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
