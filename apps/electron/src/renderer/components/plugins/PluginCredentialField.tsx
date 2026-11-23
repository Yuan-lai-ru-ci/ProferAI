import { Input } from '@profer/ui/primitives/input'
import * as React from 'react'
import { toast } from 'sonner'
import { Button } from '@profer/ui/primitives/button'
export function PluginCredentialField({ pluginId, id, title, origin }: { pluginId: string; id: string; title: string; origin: string }): React.ReactElement {
  const [secret, setSecret] = React.useState(''), [busy, setBusy] = React.useState(false)
  const save = async (clear: boolean): Promise<void> => {
    setBusy(true)
    try {
      await window.electronAPI.setPluginCredential(pluginId, id, clear ? null : secret)
      setSecret(''); toast.success(clear ? '凭据已移除' : '凭据已安全保存')
    } catch (error) { toast.error(error instanceof Error ? error.message : '凭据保存失败') }
    finally { setBusy(false) }
  }
  return <label className="mt-3 block text-xs text-muted-foreground">{title} · {origin}
    <span className="mt-1 flex flex-wrap items-center gap-2">
      <Input type="password" value={secret} autoComplete="new-password" placeholder="输入或替换服务凭据" aria-label={title}
        onChange={(event) => setSecret(event.target.value)} className="min-w-40 flex-1" />
      <Button size="sm" variant="outline" disabled={busy || !secret} onClick={() => void save(false)}>保存</Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void save(true)}>清除</Button>
    </span>
  </label>
}
