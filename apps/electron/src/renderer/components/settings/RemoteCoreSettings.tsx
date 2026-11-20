import * as React from 'react'
import { useAtomValue } from 'jotai'
import { Cpu, Plus } from 'lucide-react'
import { Button } from '@profer/ui/primitives/button'
import { Input } from '@profer/ui/primitives/input'
import { Label } from '@profer/ui/primitives/label'
import { coreTargetsAtom } from '@/atoms/core-target-atoms'
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
  const confirmationStart = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => { if (editor) formStart.current?.focus() }, [editor])
  React.useEffect(() => { if (confirmation) confirmationStart.current?.focus() }, [confirmation])

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
    return <p role={feedback.error ? 'alert' : 'status'} className={feedback.error ? 'break-words text-sm text-destructive' : 'text-sm text-muted-foreground'}>{feedback.message}</p>
  }

  const controlsDisabled = busy || snapshot.startup === 'restoring'

  return (
    <section aria-label="远程内核" className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">远程内核</h3>
          <p className="text-xs text-muted-foreground">每个内核一张卡片；同一内核的多条地址可手动选择，不会自动换线。</p>
        </div>
        <Button size="sm" disabled={controlsDisabled} onClick={() => open({ kind: 'core' })}><Plus className="mr-1 size-4" />添加远程内核</Button>
      </header>
      {snapshot.startup === 'restoring' && <p role="status" className="text-sm text-muted-foreground">正在恢复上次使用的内核…</p>}
      {snapshot.startup === 'fallback' && <div className="flex flex-wrap items-center gap-2">
        <p role="alert" className="text-sm text-muted-foreground">上次使用的远程内核不可达，本次已回到本机。</p>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run('form', async () => {
          await window.electronAPI.selectCoreTarget('local')
          return '下次启动将使用本机内核。'
        })}>下次从本机启动</Button>
      </div>}
      {targets.length === 0 && <p className="rounded-lg bg-muted/30 p-3 text-sm text-muted-foreground">尚未添加远程内核。准备好已有部署的 HTTPS 地址与 Core Token 后，即可验证并添加。内部测试版也可用本机 HTTP 隧道地址。</p>}
      <details className="rounded-lg bg-muted/30 px-3 py-2 text-sm">
        <summary className="cursor-pointer font-medium">如何连接已部署的 Core？</summary>
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-muted-foreground">
          <li>先在远端主机完成 Profer Core 部署并启动服务。本页只配置连接，不安装 Core。</li>
          <li>生产环境通过使用受信任证书的 HTTPS 入口访问 Core，并让反向代理支持 WebSocket 升级。</li>
          <li>向部署管理员获取 HTTPS 服务地址和 Core Token。验证保存后，手动选择使用该内核。</li>
        </ol>
      </details>
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
                <Input id={`${formId}-address`} type="url" required placeholder="https://core.example.com 或 http://127.0.0.1:17788" value={fields.baseUrl} onChange={event => setFields({ ...fields, baseUrl: event.target.value })} />
                <p className="text-xs text-muted-foreground">内部测试版允许 HTTP loopback 隧道；公网连接仍需 HTTPS。</p>
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
      {confirmation && <div ref={confirmationStart} tabIndex={-1} role="group" aria-label="确认连接操作" className="space-y-2 rounded-lg border border-border/60 bg-card p-3">
        <p className="text-sm">{confirmation.text}</p>
        <div className="flex justify-end gap-2">
          <Button type="button" size="sm" variant="ghost" onClick={() => answer(false)}>取消</Button>
          <Button type="button" size="sm" onClick={() => answer(true)}>确认</Button>
        </div>
      </div>}
      {targets.map(target => {
        const current = snapshot.currentId === target.id
        const connected = target.status === 'connected'
        return <article key={target.id} aria-label={target.name} className="space-y-3 rounded-lg border border-border/60 bg-card p-4 shadow-sm">
          <header className="flex flex-wrap items-start justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <Cpu className="size-5 shrink-0 text-primary" aria-hidden="true" />
              <div className="min-w-0">
                <h4 className="break-words text-sm font-semibold">{target.name}</h4>
                <p className="text-xs text-muted-foreground">{target.version ? `版本 ${target.version}` : '版本未知'}{connected && target.latencyMs !== undefined ? ` · ${target.latencyMs} ms` : ''}</p>
              </div>
            </div>
            <span className="rounded-full bg-muted px-2 py-1 text-xs">{current ? connected ? '当前使用中' : '当前已断开' : '已保存'}</span>
          </header>
          <ul className="space-y-2" aria-label="连接线路">
            {target.endpoints?.map(endpoint => {
              const selected = endpoint.id === target.selectedEndpointId
              return <li key={endpoint.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted/30 px-3 py-2">
                <div className="min-w-0">
                  <p className="break-words text-sm">{endpoint.label || '连接线路'}{selected ? ' · 已选线路' : ''}</p>
                  <p className="break-all text-xs text-muted-foreground">{endpoint.baseUrl}</p>
                </div>
                <div className="flex flex-wrap gap-1">
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
            {(!current || !connected) && <Button size="sm" disabled={controlsDisabled} onClick={() => void run(target.id, async () => {
              await window.electronAPI.selectCoreTarget(target.id)
              return current ? '已重新连接。' : '已切换内核。'
            })}>{current ? '重试连接' : '使用此内核'}</Button>}
            {current && <Button variant="outline" size="sm" disabled={controlsDisabled} onClick={() => void run(target.id, async () => {
              await window.electronAPI.selectCoreTarget('local')
              return '已切换到本机内核。'
            })}>切回本机</Button>}
            <Button variant="outline" size="sm" disabled={controlsDisabled} onClick={() => open({ kind: 'endpoint', targetId: target.id })}>添加线路</Button>
            <Button variant="ghost" size="sm" disabled={controlsDisabled} onClick={() => open({ kind: 'name', targetId: target.id }, { name: target.name })}>重命名</Button>
            <Button variant="ghost" size="sm" disabled={controlsDisabled || current} title={current ? '请先切回本机' : undefined} onClick={() => void run('form', async () => {
              if (!await confirm(`移除「${target.name}」的本机连接配置？这不会删除远端数据或停止远端任务。`)) return
              await window.electronAPI.removeCoreTarget(target.id)
              return '已移除本机连接配置。'
            })}>移除连接</Button>
          </div>
          {current && <p className="text-xs text-muted-foreground">移除当前连接前，请先切回本机。切换不会停止远端任务。</p>}
          {feedbackAt(target.id)}
        </article>
      })}
    </section>
  )
}
