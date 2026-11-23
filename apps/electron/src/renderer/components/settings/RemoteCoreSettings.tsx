import * as React from 'react'
import { useAtomValue } from 'jotai'
import { ArrowRight, Check, ChevronRight, Plus } from 'lucide-react'
import { CoreSystemIcon } from '@/components/app-shell/CoreSystemIcon'
import { Button } from '@profer/ui/primitives/button'
import { Input } from '@profer/ui/primitives/input'
import { Label } from '@profer/ui/primitives/label'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@profer/ui/primitives/alert-dialog'
import { SettingsSection } from './primitives'
import { coreTargetsAtom } from '@/atoms/core-target-atoms'
import { CoreConnectionSettings, authorizationExpiryLabel } from './CoreConnectionSettings'
import { saveVerifiedConnection, validateCoreUrl } from './remote-core-connection'

type Editor =
  | { kind: 'core' }
  | { kind: 'name'; targetId: string }
  | { kind: 'endpoint'; targetId: string; endpointId?: string }

interface Fields { name: string; baseUrl: string; token: string }
interface Confirmation { text: string; resolve: (confirmed: boolean) => void }
const EMPTY_FIELDS: Fields = { name: '', baseUrl: '', token: '' }

export function RemoteCoreSettings(): React.ReactElement {
  const snapshot = useAtomValue(coreTargetsAtom)
  const targets = snapshot.targets.filter(target => target.kind === 'remote')
  const [editor, setEditor] = React.useState<Editor | null>(null)
  const [fields, setFields] = React.useState<Fields>(EMPTY_FIELDS)
  const [busy, setBusy] = React.useState(false)
  const [feedback, setFeedback] = React.useState<{ scope: string; message: string; error?: boolean }>()
  const [confirmation, setConfirmation] = React.useState<Confirmation>()
  const pendingConfirmation = React.useRef<Confirmation>()
  const formId = React.useId()
  const formStart = React.useRef<HTMLInputElement>(null)
  const editorTrigger = React.useRef<HTMLElement | null>(null)

  React.useEffect(() => { if (editor) formStart.current?.focus() }, [editor])

  React.useEffect(() => () => pendingConfirmation.current?.resolve(false), [])

  function confirm(text: string): Promise<boolean> {
    return new Promise(resolve => {
      const request = { text, resolve }
      pendingConfirmation.current = request
      setConfirmation(request)
    })
  }

  function answer(confirmed: boolean): void {
    pendingConfirmation.current?.resolve(confirmed)
    pendingConfirmation.current = undefined
    setConfirmation(undefined)
  }

  function open(next: Editor, initial: Partial<Fields> = {}): void {
    editorTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setFeedback(undefined)
    setFields({ ...EMPTY_FIELDS, ...initial })
    setEditor(next)
  }

  async function run(scope: string, operation: () => Promise<string | undefined>): Promise<void> {
    setBusy(true)
    setFeedback(undefined)
    try {
      const message = await operation()
      if (message) setFeedback({ scope, message })
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error)
      const token = fields.token.trim()
      setFeedback({ scope, error: true, message: token ? raw.replaceAll(token, '[已隐藏]') : raw })
    } finally {
      setBusy(false)
    }
  }

  function closeEditor(): void {
    setFields(EMPTY_FIELDS)
    setEditor(null)
    editorTrigger.current?.focus()
  }

  function submit(event: React.FormEvent): void {
    event.preventDefault()
    if (busy || snapshot.startup === 'restoring' || !editor) return
    void run('form', async () => {
      const api = window.electronAPI
      if ((editor.kind === 'core' || (editor.kind === 'endpoint' && !editor.endpointId)) && !fields.token.trim()) {
        throw new Error('请输入 Core Token。')
      }
      if (editor.kind === 'name') {
        await api.updateCoreTarget(editor.targetId, { name: fields.name.trim() })
      } else if (editor.kind === 'endpoint') {
        await api.saveCoreEndpoint(editor.targetId, {
          endpointId: editor.endpointId,
          label: fields.name.trim() || undefined,
          baseUrl: validateCoreUrl(fields.baseUrl),
          token: fields.token.trim() || undefined,
        })
      } else if (!await saveVerifiedConnection(api, fields, targets,
        target => confirm(`验证发现这是「${target.name}」的另一条线路。添加到该内核？`))) return
      closeEditor()
      return editor.kind === 'name' ? '名称已更新。' : '已验证并保存，未切换内核。'
    })
  }

  function feedbackAt(scope: string): React.ReactNode {
    if (feedback?.scope !== scope) return null
    return <p role={feedback.error ? 'alert' : 'status'} className={feedback.error ? 'break-words text-sm text-destructive-text' : 'break-words text-sm text-muted-foreground'}>{feedback.message}</p>
  }

  const controlsDisabled = busy || snapshot.startup === 'restoring'
  const currentTarget = snapshot.targets.find(target => target.id === snapshot.currentId)
  const localSelected = snapshot.currentId === 'local'
  const currentStatus = snapshot.startup === 'restoring' ? '正在恢复连接' : currentTarget?.status === 'connected' ? '已连接' : currentTarget?.status === 'error' ? '连接异常' : '未连接'

  return (
    <section aria-label="Core 连接设置" className="min-w-0 space-y-5" aria-busy={busy || snapshot.startup === 'restoring'}>
      <header className="space-y-2"><h2 className="text-xl font-semibold tracking-tight">设备与连接</h2></header>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/50 pb-4"><div className="flex min-w-0 items-center gap-3"><CoreSystemIcon platform={currentTarget?.platform} osId={currentTarget?.osId} local={localSelected} className="size-5 shrink-0" /><div className="min-w-0"><p className="break-words text-sm font-medium">当前使用：{currentTarget?.name ?? '本机'}</p><p role="status" className="text-xs text-muted-foreground">{currentStatus}</p></div></div><div className="flex flex-wrap gap-2">{currentTarget?.status !== 'connected' && <Button size="sm" disabled={controlsDisabled} onClick={() => void run('current', async () => { await window.electronAPI.selectCoreTarget(snapshot.currentId); return '已重新连接。' })}>重试连接</Button>}{!localSelected && <Button variant="outline" size="sm" disabled={controlsDisabled} onClick={() => void run('current', async () => { await window.electronAPI.selectCoreTarget('local'); return '已切换到本机。' })}>使用本机</Button>}</div></div>
      {feedbackAt('current')}
      <CoreConnectionSettings />
      {snapshot.startup === 'offline' && <p role="alert" className="rounded-lg bg-muted/40 px-4 py-3 text-sm leading-6 text-muted-foreground">所选内核暂时离线，已保留原目标。请重试连接，或主动切回本机。</p>}
      {snapshot.startup === 'fallback' && <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-muted/40 px-4 py-3">
        <p role="alert" className="text-sm text-muted-foreground">上次使用的远程内核不可达，本次已回到本机。</p>
        <Button size="sm" variant="outline" disabled={controlsDisabled} onClick={() => void run('form', async () => { await window.electronAPI.selectCoreTarget('local'); return '下次启动将使用本机内核。' })}>下次从本机启动</Button>
      </div>}
      <SettingsSection title={<span className="inline-flex items-center gap-2">已保存设备<span className="rounded-md bg-muted px-1.5 py-0.5 text-xs font-normal tabular-nums text-muted-foreground">{targets.length}</span></span>} action={<details className="relative"><summary className="cursor-pointer rounded-md px-2 py-1 text-xs text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring">高级连接</summary><Button size="sm" variant="outline" disabled={controlsDisabled} onClick={() => open({ kind: 'core' })}><Plus className="size-4" aria-hidden="true" />使用地址 + Token</Button></details>}>
      {editor && (
        <form onSubmit={submit} className="space-y-3 rounded-lg border border-border/60 bg-card p-4">
          <h4 className="text-sm font-medium">{editor.kind === 'core' ? '添加远程内核' : editor.kind === 'name' ? '编辑内核名称' : editor.endpointId ? '编辑线路' : '添加线路'}</h4>
          <fieldset disabled={controlsDisabled} className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor={`${formId}-name`}>{editor.kind === 'endpoint' ? '线路名称（选填）' : '名称'}</Label>
              <Input ref={formStart} id={`${formId}-name`} value={fields.name} maxLength={80} required={editor.kind !== 'endpoint'} onChange={event => setFields({ ...fields, name: event.target.value })} />
            </div>
            {editor.kind !== 'name' && <>
              <div className="space-y-1">
                <Label htmlFor={`${formId}-address`}>Core 地址</Label>
                <Input id={`${formId}-address`} type="url" required placeholder="https://core.example.com" value={fields.baseUrl} onChange={event => setFields({ ...fields, baseUrl: event.target.value })} />
                <p className="text-xs leading-5 text-muted-foreground">公网连接需 HTTPS；本机隧道可用 http://127.0.0.1:17788。</p>
              </div>
              <div className="space-y-1">
                <Label htmlFor={`${formId}-token`}>Core Token</Label>
                <Input id={`${formId}-token`} type="password" autoComplete="new-password" required={editor.kind === 'core' || !editor.endpointId} value={fields.token} placeholder={editor.kind === 'endpoint' && editor.endpointId ? '留空保留原 Token' : undefined} onChange={event => setFields({ ...fields, token: event.target.value })} />
              </div>
              {editor.kind === 'endpoint' && <p className="text-xs text-muted-foreground">线路必须指向同一个 Core。连接不同的 Core 时请另行添加内核。</p>}
            </>}
            <div className="flex flex-wrap justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => { closeEditor(); setFeedback(undefined) }}>取消</Button>
              <Button type="submit" size="sm" disabled={controlsDisabled || (editor.kind !== 'endpoint' && !fields.name.trim())}>{busy ? '处理中…' : editor.kind === 'name' ? '保存名称' : '验证并保存'}</Button>
            </div>
          </fieldset>
        </form>
      )}
      {feedbackAt('form')}
      <AlertDialog open={Boolean(confirmation)} onOpenChange={isOpen => { if (!isOpen) answer(false) }}>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>确认连接操作</AlertDialogTitle><AlertDialogDescription>{confirmation?.text}</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel onClick={() => answer(false)}>取消</AlertDialogCancel><AlertDialogAction onClick={() => answer(true)}>确认</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {targets.map(target => {
        const current = snapshot.currentId === target.id
        const connected = target.status === 'connected'
        return <article key={target.id} aria-label={target.name} className="border-b border-border/50">
          <header className="flex flex-wrap items-center justify-between gap-3 py-3">
            <div className="flex min-w-0 items-center gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted/60"><CoreSystemIcon platform={target.platform} osId={target.osId} className="size-4 text-muted-foreground" /></span>
              <div className="min-w-0">
                <h4 className="break-words text-sm font-semibold">{target.name}</h4>
                <p className="text-xs text-muted-foreground">{authorizationExpiryLabel(target.expiresAt)}</p>
              </div>
            </div>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-xs">{current && connected && <Check className="size-3" aria-hidden="true" />}{current && connected ? '当前使用中' : connected ? '已连接' : '未连接'}</span>
          </header>
          <div className="flex justify-end pb-2">
            {(!current || !connected) && <Button size="sm" variant="outline" disabled={controlsDisabled} onClick={() => void run(target.id, async () => { await window.electronAPI.selectCoreTarget(target.id); return '已切换内核。' })}>{current ? '重试连接' : '连接使用'}<ArrowRight className="size-3.5" aria-hidden="true" /></Button>}
          </div>
          <details className="group border-t border-border/50">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 py-2 text-xs text-muted-foreground transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus [&::-webkit-details-marker]:hidden"><span>管理设备 · {target.endpoints?.length ?? (target.baseUrl ? 1 : 0)} 条线路</span><ChevronRight className="size-3.5 shrink-0 transition-transform group-open:rotate-90 motion-reduce:transition-none" aria-hidden="true" /></summary>
            <div className="space-y-3 pb-3">
          <ul className="space-y-2" aria-label="连接线路">
            {target.endpoints?.map(endpoint => {
              const selected = endpoint.id === target.selectedEndpointId
              return <li key={endpoint.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted/30 px-3 py-2">
                <div className="min-w-0">
                  <p className="break-words text-sm">{endpoint.label || '连接线路'}{selected ? ' · 已选线路' : ''}</p>
                  <p className="break-all text-xs text-muted-foreground">{endpoint.baseUrl}</p>
                </div>
                <div className="flex flex-wrap gap-1" aria-label={`${endpoint.label || '连接线路'}的操作`}>
                  {!selected && <Button variant="outline" size="sm" disabled={controlsDisabled} onClick={() => void run(target.id, async () => {
                    await window.electronAPI.selectCoreEndpoint(target.id, endpoint.id)
                    return current ? '已切换到此线路。' : '已选定此线路，未切换内核。'
                  })}>选择线路</Button>}
                  <Button variant="ghost" size="sm" disabled={controlsDisabled} onClick={() => open({ kind: 'endpoint', targetId: target.id, endpointId: endpoint.id }, { name: endpoint.label, baseUrl: endpoint.baseUrl })}>编辑</Button>
                  <Button variant="ghost" size="sm" disabled={controlsDisabled || selected} title={selected ? '请先选择其他线路' : undefined} onClick={() => void run(target.id, async () => {
                    if (!await confirm(`移除「${target.name}」的线路 ${endpoint.baseUrl}？`)) return
                    await window.electronAPI.removeCoreEndpoint(target.id, endpoint.id)
                    return '已移除线路。'
                  })}>移除线路</Button>
                </div>
              </li>
            })}
            {!target.endpoints?.length && target.baseUrl && <li className="break-all text-sm text-muted-foreground">{target.baseUrl}</li>}
          </ul>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" disabled={controlsDisabled} onClick={() => open({ kind: 'endpoint', targetId: target.id })}>添加线路</Button>
            <Button variant="ghost" size="sm" disabled={controlsDisabled} onClick={() => open({ kind: 'name', targetId: target.id }, { name: target.name })}>重命名</Button>
            <Button variant="ghost" size="sm" disabled={controlsDisabled || current} title={current ? '请先切回本机' : undefined} onClick={() => void run(target.id, async () => {
              if (!await confirm(`移除「${target.name}」的本机连接配置？这不会删除远端数据或停止远端任务。`)) return
              await window.electronAPI.removeCoreTarget(target.id)
              return '已移除本机连接配置。'
            })}>移除连接</Button>
          </div>
            </div>
          </details>
          <div className="pb-3 empty:hidden">{feedbackAt(target.id)}</div>
        </article>
      })}
      </SettingsSection>
    </section>
  )
}
