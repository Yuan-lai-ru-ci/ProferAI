import * as React from 'react'
import type { BrowserTabSummary } from '@profer/shared'
import { Check, Globe2, Layers3, LoaderCircle } from 'lucide-react'
import { Button } from '@profer/ui/primitives/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@profer/ui/primitives/dropdown-menu'
import { ScrollRegion } from '@/components/ai-elements/scroll-region'

interface BrowserPageMenuProps {
  pages: readonly BrowserTabSummary[]
  activeTabId: string
  agentTabId: string | null
  disabled?: boolean
  onSelect: (tabId: string) => void
}

/** 后台页面不自动弹出，用户从这份列表主动选择查看。 */
export function BrowserPageMenu({ pages, activeTabId, agentTabId, disabled = false, onSelect }: BrowserPageMenuProps): React.ReactElement {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="icon" className="size-7 shrink-0" disabled={disabled || pages.length === 0} aria-label={`所有浏览器页面，共 ${pages.length} 页`}>
          <Layers3 className="size-3.5" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="z-[90] w-72">
        <DropdownMenuLabel className="text-xs font-medium">浏览器页面 · {pages.length}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <ScrollRegion className="max-h-72 overflow-y-auto">
          {pages.map(page => (
            <DropdownMenuItem key={page.tabId} onSelect={() => onSelect(page.tabId)} className="gap-2" aria-label={`${page.localFile?.name || page.title || '新建标签页'}${page.tabId === agentTabId ? '，Agent 工作页' : ''}${page.tabId === activeTabId ? '，当前显示' : ''}`}>
              {page.loading ? <LoaderCircle className="size-3.5 animate-spin text-muted-foreground" aria-hidden="true" /> : <Globe2 className="size-3.5 text-muted-foreground" aria-hidden="true" />}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs">{page.localFile?.name || page.title || '新建标签页'}</span>
                <span className="block truncate text-[10px] text-muted-foreground">{page.tabId === agentTabId ? 'Agent 工作页' : page.openedByAgent ? 'Agent 后台页' : '用户页面'}</span>
              </span>
              {page.tabId === activeTabId && <Check className="size-3.5 text-muted-foreground" aria-hidden="true" />}
            </DropdownMenuItem>
          ))}
        </ScrollRegion>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
