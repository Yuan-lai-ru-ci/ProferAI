import * as React from 'react'
import type { BrowserFindState } from '@profer/shared'
import { ArrowDown, ArrowUp, CaseSensitive, Search, X } from 'lucide-react'
import { Button } from '@profer/ui/primitives/button'
import { Input } from '@profer/ui/primitives/input'

interface BrowserFindBarProps {
  state: BrowserFindState | null
  onFind: (query: string, next?: boolean, forward?: boolean, matchCase?: boolean) => void
  onClose: () => void
  inputRef: React.RefObject<HTMLInputElement>
}

export function BrowserFindBar({ state, onFind, onClose, inputRef }: BrowserFindBarProps): React.ReactElement {
  const [query, setQuery] = React.useState(state?.query ?? '')
  const [matchCase, setMatchCase] = React.useState(state?.matchCase ?? false)
  const [composing, setComposing] = React.useState(false)
  const timerRef = React.useRef<ReturnType<typeof setTimeout>>()
  React.useEffect(() => {
    if (composing) return
    timerRef.current = setTimeout(() => onFind(query, false, true, matchCase), 120)
    return () => { clearTimeout(timerRef.current) }
  }, [query, matchCase, composing, onFind])
  const nextMatch = (forward: boolean): void => {
    clearTimeout(timerRef.current)
    onFind(query, true, forward, matchCase)
  }
  const currentResult = state?.query === query && !!state?.matchCase === matchCase
  return <div className="titlebar-no-drag flex min-h-10 shrink-0 items-center gap-1 border-b border-border/30 bg-surface-raised px-2" role="search" aria-label="在网页中查找">
    <Search className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
    <Input ref={inputRef} aria-label="查找网页内容" placeholder="在网页中查找" value={query}
      onChange={event => setQuery(event.target.value)}
      onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing || composing) return
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose() }
        if (event.key === 'Enter') { event.preventDefault(); nextMatch(!event.shiftKey) }
      }}
      className="h-7 min-w-0 flex-1 text-xs md:text-xs" />
    <span className="min-w-9 shrink-0 text-center text-[10px] tabular-nums text-muted-foreground" role="status" aria-live="polite">
      {!query ? '' : !currentResult || state?.searching ? '…' : `${state?.activeMatchOrdinal ?? 0}/${state?.matches ?? 0}`}
    </span>
    <Button type="button" variant="ghost" size="icon" className="size-7 shrink-0" aria-pressed={matchCase} onClick={() => setMatchCase(previous => !previous)} aria-label="区分大小写"><CaseSensitive className="size-3.5" /></Button>
    <Button type="button" variant="ghost" size="icon" className="size-7 shrink-0" disabled={!query || composing} onClick={() => nextMatch(false)} aria-label="上一个匹配"><ArrowUp className="size-3.5" /></Button>
    <Button type="button" variant="ghost" size="icon" className="size-7 shrink-0" disabled={!query || composing} onClick={() => nextMatch(true)} aria-label="下一个匹配"><ArrowDown className="size-3.5" /></Button>
    <Button type="button" variant="ghost" size="icon" className="size-7 shrink-0" onClick={onClose} aria-label="关闭网页查找"><X className="size-3.5" /></Button>
  </div>
}
