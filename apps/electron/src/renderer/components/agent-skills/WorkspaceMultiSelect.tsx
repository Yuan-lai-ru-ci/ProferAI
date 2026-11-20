import * as React from 'react'
import { Check } from 'lucide-react'
import type { AgentWorkspace } from '@profer/shared'

interface Props {
  workspaces: AgentWorkspace[]
  valueKey: 'id' | 'slug'
  values: string[]
  onChange: (values: string[]) => void
}
export function WorkspaceMultiSelect({ workspaces, valueKey, values, onChange }: Props): React.ReactElement {
  const [query, setQuery] = React.useState('')
  const valueOf = (workspace: AgentWorkspace) => workspace[valueKey]
  const visible = workspaces.filter(w => `${w.name} ${w.slug}`.toLowerCase().includes(query.trim().toLowerCase()))
  const toggle = (value: string) => onChange(values.includes(value) ? values.filter(v => v !== value) : [...values, value])
  const selectVisible = () => onChange([...new Set([...values, ...visible.map(valueOf)])])
  return (
    <div className="flex flex-col gap-3">
      <input
        value={query}
        onChange={event => setQuery(event.target.value)}
        placeholder="搜索工作区…"
        className="h-9 rounded-md border border-border bg-transparent px-3 text-sm outline-none focus:ring-1 focus:ring-ring"
      />
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>已选择 {values.length} 个工作区</span>
        <div className="flex gap-2">
          <button type="button" onClick={selectVisible} className="hover:text-foreground">全选</button>
          <button type="button" onClick={() => onChange([])} className="hover:text-foreground">清空</button>
        </div>
      </div>
      <div className="grid max-h-64 gap-1 overflow-y-auto rounded-md border border-border/60 p-1">
        {visible.map(workspace => (
          <button
            key={workspace.id}
            type="button"
            aria-pressed={values.includes(valueOf(workspace))}
            onClick={() => toggle(valueOf(workspace))}
            className="flex items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm hover:bg-accent"
          >
            <span className="flex size-4 items-center justify-center rounded border border-border">
              {values.includes(valueOf(workspace)) && <Check size={12} className="text-primary" />}
            </span>
            <span className="truncate">{workspace.name}</span>
          </button>
        ))}
        {!visible.length && <p className="p-4 text-center text-xs text-muted-foreground">没有匹配的工作区</p>}
      </div>
    </div>
  )
}
