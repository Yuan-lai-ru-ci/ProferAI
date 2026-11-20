import * as React from 'react'
import { useAtom } from 'jotai'
import { Check, ChevronDown, CircleAlert, Cpu, LoaderCircle, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@profer/ui/primitives/button'
import { Input } from '@profer/ui/primitives/input'
import { Label } from '@profer/ui/primitives/label'
import { Popover, PopoverContent, PopoverTrigger } from '@profer/ui/primitives/popover'
import { cn } from '@/lib/utils'
import { coreTargetsAtom, loadCoreTargets } from '@/atoms/core-target-atoms'
import type { CoreTargetSummary } from '@/types/settings'

export function CoreTargetSwitcher(): React.ReactElement {
  const [state, setState] = useAtom(coreTargetsAtom)
  const [open, setOpen] = React.useState(false)
  const [editing, setEditing] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [name, setName] = React.useState('')
  const [baseUrl, setBaseUrl] = React.useState('http://127.0.0.1:17791')
  const [token, setToken] = React.useState('')
  const current = state.targets.find(target => target.id === state.currentId)

  React.useEffect(() => {
    let cancelled = false
    void loadCoreTargets().then(snapshot => { if (!cancelled) setState(snapshot) }).catch(error => toast.error(String(error)))
    const unsubscribe = window.electronAPI.onCoreTargetChanged(snapshot => {
      if (!cancelled) setState(current => snapshot.generation < current.generation ? current : snapshot)
    })
    return () => { cancelled = true; unsubscribe() }
  }, [setState])

  const addTarget = async (): Promise<void> => {
    setBusy(true)
    try {
      await window.electronAPI.testCoreTarget({ name, baseUrl, token })
      const saved = await window.electronAPI.addCoreTarget({ name, baseUrl, token })
      setState(await window.electronAPI.listCoreTargets())
      setToken('')
      setEditing(false)
      toast.success(`已添加 ${saved.name}`)
    } catch (error) { toast.error(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }

  const select = async (target: CoreTargetSummary): Promise<void> => {
    if (target.id === state.currentId) return
    setBusy(true)
    try {
      const snapshot = await window.electronAPI.selectCoreTarget(target.id)
      setState(snapshot)
      window.dispatchEvent(new CustomEvent('profer-core-target-changed', { detail: snapshot }))
      toast.success(`已切换到${target.name}`)
    } catch (error) { toast.error(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }

  const remove = async (target: CoreTargetSummary): Promise<void> => {
    try {
      setState(await window.electronAPI.removeCoreTarget(target.id))
      toast.success(`已移除 ${target.name}`)
    } catch (error) { toast.error(error instanceof Error ? error.message : String(error)) }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" aria-label={`当前内核：${current?.name ?? '本机内核'}`} title={`内核：${current?.name ?? '本机内核'}`} className="relative flex size-[36px] flex-none items-center justify-center rounded-[9px] text-foreground/[0.58] transition-colors hover:bg-foreground/[0.045] hover:text-foreground/[0.82] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 titlebar-no-drag">
          <Cpu size={18} />
          <span className={cn('absolute right-[6px] top-[6px] size-[6px] rounded-full', current?.status === 'connected' ? 'bg-green-500' : current?.status === 'error' ? 'bg-destructive' : 'bg-foreground/25')} />
        </button>
      </PopoverTrigger>
      <PopoverContent side="right" align="end" className="w-[320px] p-2" sideOffset={8}>
        <div className="flex items-center justify-between px-2 py-1.5">
          <div><div className="text-sm font-medium">切换内核</div><div className="text-xs text-muted-foreground">当前 Profer 环境</div></div>
          <Button variant="ghost" size="icon" aria-label="添加远程内核" title="添加远程内核" onClick={() => setEditing(value => !value)}><Plus className="size-4" /></Button>
        </div>
        <div className="my-1 h-px bg-border" />
        <div className="space-y-1">
          {state.targets.map(target => (
            <div key={target.id} className="flex items-center gap-1">
              <button type="button" disabled={busy} onClick={() => void select(target)} className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-accent disabled:opacity-50">
                <Cpu className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1"><span className="block truncate text-sm">{target.name}</span><span className="block truncate text-xs text-muted-foreground">{target.kind === 'local' ? '本机' : target.baseUrl}{target.version ? ` · v${target.version}` : ''}</span></span>
                {target.id === state.currentId ? <Check className="size-4 shrink-0 text-primary" /> : target.status === 'error' ? <CircleAlert className="size-4 shrink-0 text-destructive" /> : null}
              </button>
              {target.kind === 'remote' && <Button variant="ghost" size="icon" aria-label={`移除 ${target.name}`} title={`移除 ${target.name}`} onClick={() => void remove(target)}><Trash2 className="size-4" /></Button>}
            </div>
          ))}
        </div>
        {editing && <div className="mt-2 space-y-2 border-t border-border px-2 pt-3">
          <Label htmlFor="core-target-name">名称</Label><Input id="core-target-name" value={name} onChange={event => setName(event.target.value)} placeholder="给这个内核起个名字" />
          <p className="text-[11px] leading-4 text-muted-foreground/70">名称只用于在内核列表里区分，不影响连接。</p>
          <Label htmlFor="core-target-url">Core 地址</Label><Input id="core-target-url" value={baseUrl} onChange={event => setBaseUrl(event.target.value)} placeholder="https://core.example.com" />
          <Label htmlFor="core-target-token">Token</Label><Input id="core-target-token" type="password" autoComplete="new-password" value={token} onChange={event => setToken(event.target.value)} />
          <div className="flex justify-end gap-2 pt-1"><Button variant="ghost" size="sm" disabled={busy} onClick={() => setEditing(false)}>取消</Button><Button size="sm" disabled={busy || !name.trim() || !token.trim()} onClick={() => void addTarget()}>{busy ? <LoaderCircle className="mr-2 size-4 animate-spin" /> : null}添加内核</Button></div>
        </div>}
      </PopoverContent>
    </Popover>
  )
}
