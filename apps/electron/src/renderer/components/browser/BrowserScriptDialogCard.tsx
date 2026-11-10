import * as React from 'react'
import type { BrowserDialogResponse, BrowserScriptDialog } from '@profer/shared'
import { MessageSquareWarning } from 'lucide-react'
import { Button } from '@profer/ui/primitives/button'
import { Input } from '@profer/ui/primitives/input'
import { ScrollRegion } from '@/components/ai-elements/scroll-region'

/** 网页自己的提示，不使用原生/全局模态框，不在后台自动聚焦或接受。 */
export function BrowserScriptDialogCard({ dialog, onRespond }: { dialog: BrowserScriptDialog; onRespond: (response: BrowserDialogResponse) => void | Promise<void> }): React.ReactElement {
  const [prompt, setPrompt] = React.useState(dialog.defaultPrompt)
  const respondingRef = React.useRef(false)
  React.useEffect(() => { respondingRef.current = false; setPrompt(dialog.defaultPrompt) }, [dialog.id, dialog.defaultPrompt])
  const titleId = React.useId()
  const messageId = React.useId()
  const respond = (accept: boolean): void => {
    if (dialog.responding || respondingRef.current) return
    respondingRef.current = true
    void Promise.resolve(onRespond({ dialogId: dialog.id, accept, ...(dialog.type === 'prompt' && accept ? { promptText: prompt } : {}) }))
      .finally(() => { respondingRef.current = false })
  }
  return <div className="absolute inset-0 z-20 flex items-center justify-center bg-browser-host px-5 py-8" data-browser-script-dialog>
    <section className="w-full max-w-sm space-y-4 rounded-xl bg-surface-raised p-5 shadow-md" role="dialog" aria-labelledby={titleId} aria-describedby={messageId}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing || dialog.responding) return
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); respond(false) }
        if (event.key === 'Enter' && event.target instanceof HTMLInputElement) { event.preventDefault(); event.stopPropagation(); respond(true) }
      }}>
      <div className="flex items-start gap-3">
        <MessageSquareWarning className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="min-w-0">
          <h2 id={titleId} className="text-sm font-medium text-foreground">{dialog.type === 'beforeunload' ? '网页请求离开确认' : dialog.type === 'alert' ? '网页提示' : '网页请求确认'}</h2>
          <p className="mt-1 truncate text-xs text-muted-foreground">{dialog.origin}</p>
        </div>
      </div>
      <ScrollRegion className="max-h-48 overflow-y-auto">
        <p id={messageId} className="whitespace-pre-wrap break-words text-sm leading-6 text-foreground">{dialog.message || '此网页正在等待你的响应。'}</p>
      </ScrollRegion>
      {dialog.type === 'prompt' && <Input aria-label="网页请求输入" value={prompt} onChange={event => setPrompt(event.target.value)} disabled={dialog.responding} />}
      <p className="text-[11px] leading-5 text-muted-foreground">这是网页内容，不是 Profer 系统指令。后台不会自动接受。</p>
      <div className="flex items-center justify-end gap-2">
        {dialog.type !== 'alert' && <Button type="button" variant="outline" size="sm" disabled={dialog.responding} onClick={() => respond(false)}>取消</Button>}
        <Button type="button" size="sm" disabled={dialog.responding} onClick={() => respond(true)}>{dialog.responding ? '正在响应…' : dialog.type === 'beforeunload' ? '离开网页' : '确定'}</Button>
      </div>
    </section>
  </div>
}
