/**
 * OpenApiSettings — 开放 API 页
 *
 * 用户自建 pk_ API Key，通过 HTTP 以 OpenAI/Anthropic 兼容格式访问 Profer API。
 *
 * 铁律：明文 key 只在创建时展示一次；列表只显示脱敏前缀。
 * curl 示例域名从 auth.baseUrl 动态取，不写死。
 */
import * as React from 'react'
import { toast } from 'sonner'
import { Plus, Copy, Pencil, Trash2, ChevronDown, KeyRound, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import {
  Dialog, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription,
} from '@/components/ui/dialog'
import { SettingsSection } from './primitives'

interface ApiKey {
  id: string
  name: string
  key_prefix: string
  status: string
  quota_limit: number | null
  quota_used: number
  request_count: number
  last_used_at: number | null
  created_at: number
}

/** quota → 积分展示（保留 3 位小数，最小 0.001，0 保持为 0） */
const QUOTA_PER_UNIT = 500000
const quotaToPoints = (q: number | null): number => {
  const v = q ?? 0
  if (v <= 0) return 0
  return Math.max(0.001, Math.round((v / QUOTA_PER_UNIT) * 10 * 1000) / 1000)
}

export function OpenApiSettings(): React.ReactElement {
  const [keys, setKeys] = React.useState<ApiKey[]>([])
  const [loading, setLoading] = React.useState(false)
  const [docOpen, setDocOpen] = React.useState(false)
  const [baseUrl, setBaseUrl] = React.useState<string>('')

  // 创建/编辑弹窗
  const [dialogOpen, setDialogOpen] = React.useState(false)
  const [editing, setEditing] = React.useState<ApiKey | null>(null)
  const [formName, setFormName] = React.useState('')
  const [formQuota, setFormQuota] = React.useState('')
  // 新建成功后展示明文（只此一次）
  const [createdKey, setCreatedKey] = React.useState<string | null>(null)

  const auth = React.useRef<{ baseUrl: string; token: string } | null>(null)

  const api = React.useCallback(async (path: string, init?: RequestInit) => {
    if (!auth.current) auth.current = await window.electronAPI.auth.getTeamAuth()
    if (!auth.current) throw new Error('未登录团队工作区')
    return fetch(`${auth.current.baseUrl}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${auth.current.token}`,
        ...(init?.headers || {}),
      },
    })
  }, [])
  const load = React.useCallback(async () => {
    setLoading(true)
    try {
      const a = await window.electronAPI.auth.getTeamAuth()
      auth.current = a
      setBaseUrl(a?.baseUrl || '')
      if (!a) { setKeys([]); return }
      const r = await api('/v1/account/api-keys')
      if (r.ok) {
        const d = await r.json()
        setKeys(d.keys ?? [])
      }
    } catch { /* 静默 */ }
    finally { setLoading(false) }
  }, [api])

  React.useEffect(() => { void load() }, [load])

  const openCreate = (): void => {
    setEditing(null); setFormName(''); setFormQuota(''); setCreatedKey(null); setDialogOpen(true)
  }
  const openEdit = (k: ApiKey): void => {
    setEditing(k); setFormName(k.name); setFormQuota(k.quota_limit != null ? String(quotaToPoints(k.quota_limit)) : '')
    setCreatedKey(null); setDialogOpen(true)
  }

  const submit = async (): Promise<void> => {
    // 积分 → quota：积分 /10 = 美元，×QPU = quota
    const points = formQuota.trim() ? parseFloat(formQuota) : null
    const quotaLimit = points != null && points > 0 ? Math.round((points / 10) * QUOTA_PER_UNIT) : null
    try {
      if (editing) {
        const r = await api(`/v1/account/api-keys/${editing.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ name: formName, quotaLimit }),
        })
        if (!r.ok) throw new Error()
        toast.success('已保存')
        setDialogOpen(false)
        await load()
      } else {
        const r = await api('/v1/account/api-keys', {
          method: 'POST',
          body: JSON.stringify({ name: formName, quotaLimit }),
        })
        if (!r.ok) throw new Error()
        const d = await r.json()
        setCreatedKey(d.key)   // 明文只此一次
        await load()
      }
    } catch {
      toast.error(editing ? '保存失败' : '创建失败')
    }
  }

  const toggleStatus = async (k: ApiKey): Promise<void> => {
    try {
      const next = k.status === 'active' ? 'disabled' : 'active'
      const r = await api(`/v1/account/api-keys/${k.id}`, {
        method: 'PATCH', body: JSON.stringify({ status: next }),
      })
      if (!r.ok) throw new Error()
      await load()
    } catch { toast.error('操作失败') }
  }

  const remove = async (k: ApiKey): Promise<void> => {
    if (!window.confirm(`确定删除 API Key「${k.name || k.key_prefix}」？删除后使用该 key 的请求将立即失效。`)) return
    try {
      const r = await api(`/v1/account/api-keys/${k.id}`, { method: 'DELETE' })
      if (!r.ok) throw new Error()
      toast.success('已删除')
      await load()
    } catch { toast.error('删除失败') }
  }

  const copy = async (text: string, hint = '已复制'): Promise<void> => {
    try { await navigator.clipboard.writeText(text); toast.success(hint) }
    catch { toast.error('复制失败') }
  }

  const displayBase = baseUrl || 'https://<你的服务端地址>'
  const curlExample = `curl ${displayBase}/v1/proxy/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -d '{ "model": "claude-sonnet-5", ... }'`

  const fmtTime = (t: number | null): string => t ? new Date(t).toLocaleString('zh-CN') : '-'
  return (
    <div className="space-y-8">
      {/* API 使用说明 */}
      <SettingsSection title="API" description="管理您的 API 密钥，用于访问 Profer API">
        <div className="rounded-xl border border-border bg-muted/20 overflow-hidden">
          <button
            onClick={() => setDocOpen((v) => !v)}
            className="w-full flex items-center justify-between px-4 py-3 hover:bg-muted/30 transition-colors"
          >
            <div className="text-left">
              <div className="text-sm font-medium">API 使用说明</div>
              <div className="text-xs text-muted-foreground mt-0.5">使用 API Key 可以通过 HTTP 请求访问 Profer API，兼容 OpenAI/Anthropic 格式。</div>
            </div>
            <div className="flex items-center gap-1 text-xs text-muted-foreground shrink-0">
              {docOpen ? '收起' : '展开'}
              <ChevronDown size={14} className={docOpen ? 'rotate-180 transition-transform' : 'transition-transform'} />
            </div>
          </button>
          {docOpen && (
            <div className="px-4 pb-4 pt-1 border-t border-border/50">
              <div className="text-xs font-medium text-muted-foreground mt-3 mb-1.5">OpenAI 兼容格式</div>
              <div className="relative">
                <pre className="text-[11px] leading-relaxed bg-background rounded-lg p-3 overflow-x-auto border border-border/50 font-mono">{curlExample}</pre>
                <button
                  onClick={() => copy(curlExample, '已复制示例')}
                  className="absolute top-2 right-2 rounded p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                  title="复制"
                >
                  <Copy size={13} />
                </button>
              </div>
            </div>
          )}
        </div>
      </SettingsSection>

      {/* API Keys 列表 */}
      <SettingsSection
        title="API Keys"
        description="您创建的所有 API Keys"
        action={
          <Button size="sm" onClick={openCreate}>
            <Plus size={14} /> 创建 API Key
          </Button>
        }
      >
        {keys.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border py-10 text-center text-sm text-muted-foreground">
            {loading ? '加载中…' : '还没有 API Key，点击右上角创建'}
          </div>
        ) : (
          <div className="rounded-xl border border-border overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/30 text-xs text-muted-foreground">
                  <th className="text-left font-medium px-3 py-2.5">名称</th>
                  <th className="text-left font-medium px-3 py-2.5">Key</th>
                  <th className="text-left font-medium px-3 py-2.5">状态</th>
                  <th className="text-right font-medium px-3 py-2.5">请求</th>
                  <th className="text-right font-medium px-3 py-2.5">消耗</th>
                  <th className="text-left font-medium px-3 py-2.5">限额</th>
                  <th className="text-left font-medium px-3 py-2.5">最后使用</th>
                  <th className="px-3 py-2.5" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {keys.map((k) => (
                  <tr key={k.id} className="hover:bg-muted/20">
                    <td className="px-3 py-3">
                      <div className="flex items-center gap-2">
                        <KeyRound size={14} className="text-muted-foreground shrink-0" />
                        <span className="font-medium truncate max-w-[100px]">{k.name || '未命名'}</span>
                      </div>
                    </td>
                    <td className="px-3 py-3">
                      <button
                        onClick={() => copy(k.key_prefix)}
                        className="inline-flex items-center gap-1.5 text-xs font-mono text-muted-foreground hover:text-foreground rounded px-1.5 py-0.5 hover:bg-muted transition-colors"
                        title="仅展示脱敏前缀；完整 key 只在创建时可见"
                      >
                        {k.key_prefix} <Copy size={11} />
                      </button>
                    </td>
                    <td className="px-3 py-3">
                      <span className={`inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded ${k.status === 'active' ? 'text-green-600 bg-green-500/10' : 'text-muted-foreground bg-muted'}`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${k.status === 'active' ? 'bg-green-500' : 'bg-muted-foreground/40'}`} />
                        {k.status === 'active' ? '启用' : '停用'}
                      </span>
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums text-muted-foreground">{k.request_count}</td>
                    <td className="px-3 py-3 text-right tabular-nums text-muted-foreground">{quotaToPoints(k.quota_used).toFixed(1)} 积分</td>
                    <td className="px-3 py-3 text-xs text-muted-foreground">
                      {k.quota_limit != null ? `${quotaToPoints(k.quota_limit)} 积分` : '不限制'}
                    </td>
                    <td className="px-3 py-3 text-xs text-muted-foreground">{fmtTime(k.last_used_at)}</td>
                    <td className="px-3 py-3">
                      <div className="flex items-center gap-1 justify-end">
                        <button onClick={() => openEdit(k)} className="rounded p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors" title="编辑">
                          <Pencil size={14} />
                        </button>
                        <Switch checked={k.status === 'active'} onCheckedChange={() => toggleStatus(k)} />
                        <button onClick={() => remove(k)} className="rounded p-1.5 text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors" title="删除">
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SettingsSection>

      {/* 创建 / 编辑弹窗 */}
      <Dialog open={dialogOpen} onOpenChange={(o) => { if (!o) { setDialogOpen(false); setCreatedKey(null) } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? '编辑 API Key' : createdKey ? 'API Key 已创建' : '创建 API Key'}</DialogTitle>
            <DialogDescription>
              {createdKey
                ? '请立即复制并妥善保存，出于安全考虑，完整 Key 只显示这一次。'
                : '为 Key 起个名字，可选设置额度上限（积分，留空为不限制）。'}
            </DialogDescription>
          </DialogHeader>

          {createdKey ? (
            <div className="space-y-2">
              <div className="relative">
                <pre className="text-xs font-mono bg-muted rounded-lg p-3 pr-10 break-all whitespace-pre-wrap">{createdKey}</pre>
                <button
                  onClick={() => copy(createdKey, '已复制 API Key')}
                  className="absolute top-2 right-2 rounded p-1.5 text-muted-foreground hover:text-foreground hover:bg-background transition-colors"
                  title="复制"
                >
                  <Copy size={14} />
                </button>
              </div>
              <div className="flex items-center gap-1.5 text-xs text-yellow-600">
                <Check size={13} /> 复制后请关闭窗口，Key 不会再次显示
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">名称</label>
                <Input value={formName} onChange={(e) => setFormName(e.target.value)} placeholder="例如：开发、生产、脚本" maxLength={64} />
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">额度上限（积分，可选）</label>
                <Input value={formQuota} onChange={(e) => setFormQuota(e.target.value)} placeholder="留空为不限制" inputMode="decimal" />
              </div>
            </div>
          )}

          <DialogFooter>
            {createdKey ? (
              <Button onClick={() => { setDialogOpen(false); setCreatedKey(null) }}>完成</Button>
            ) : (
              <>
                <Button variant="outline" onClick={() => setDialogOpen(false)}>取消</Button>
                <Button onClick={submit} disabled={!formName.trim() && !editing}>{editing ? '保存' : '创建'}</Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}


