/** 设置导航：桌面分类列表与窄窗口选择器共用搜索和可见性结果。 */
import * as React from 'react'
import { Search, X } from 'lucide-react'
import type { SettingsTab } from '@/atoms/settings-tab'
import { ScrollRegion } from '@/components/ai-elements/scroll-region'
import { cn } from '@/lib/utils'
import { matchesSettingsSearch } from './settings-search'

export interface SettingsTabItem {
  id: SettingsTab
  label: string
  icon: React.ReactNode
  /** 页面内配置名称及同义词。 */
  searchTerms?: readonly string[]
}

export interface SettingsTabGroup {
  title?: string
  items: SettingsTabItem[]
}

interface SettingsNavigationProps {
  groups: SettingsTabGroup[]
  activeTab: SettingsTab
  query: string
  onQueryChange: (query: string) => void
  onTabChange: (tab: SettingsTab) => void
  onClose?: () => void
  needsAttention?: boolean
}

export function SettingsNavigation({
  groups,
  activeTab,
  query,
  onQueryChange,
  onTabChange,
  onClose,
  needsAttention,
}: SettingsNavigationProps): React.ReactElement {
  const searchRef = React.useRef<HTMLInputElement>(null)
  const filteredGroups = React.useMemo(() => groups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => matchesSettingsSearch(item, group.title, query)),
    }))
    .filter((group) => group.items.length > 0), [groups, query])
  const results = filteredGroups.flatMap((group) => group.items)
  const clearSearch = (): void => {
    onQueryChange('')
    searchRef.current?.focus()
  }

  return (
    <aside className="settings-nav flex min-h-0 shrink-0 flex-col border-b border-surface-border/50 bg-surface-sunken/30 md:w-[224px] md:border-b-0 md:border-r" aria-label="设置导航">
      <div className="settings-nav-header flex items-center justify-between px-4 py-3 md:px-5 md:pb-4 md:pt-6">
        <h2 className="text-base font-semibold text-foreground">设置</h2>
        {onClose && (
          <button type="button" onClick={onClose} aria-label="关闭设置" title="关闭设置" className="rounded-md p-2 text-muted-foreground hover:bg-control hover:text-foreground focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-focus/15 md:hidden">
            <X size={18} aria-hidden="true" />
          </button>
        )}
      </div>
      <div className="flex items-center gap-2 px-3 pb-3">
        <div className="relative min-w-0 flex-1">
          <Search size={15} aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <label htmlFor="settings-nav-search" className="sr-only">搜索设置</label>
          <input
            ref={searchRef}
            id="settings-nav-search"
            type="search"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && query) {
                event.preventDefault()
                event.stopPropagation()
                clearSearch()
              }
            }}
            placeholder="搜索设置"
            className="h-9 w-full rounded-md border border-surface-border/50 bg-input/30 pl-8 pr-8 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-focus/15 [&::-webkit-search-cancel-button]:appearance-none"
          />
          {query && (
            <button type="button" onClick={clearSearch} aria-label="清除设置搜索" className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-1.5 text-muted-foreground hover:bg-control hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
              <X size={14} aria-hidden="true" />
            </button>
          )}
        </div>
        <label htmlFor="settings-mobile-nav" className="sr-only">设置分类</label>
        <select
          id="settings-mobile-nav"
          value={results.some((item) => item.id === activeTab) ? activeTab : ''}
          onChange={(event) => onTabChange(event.target.value as SettingsTab)}
          disabled={results.length === 0}
          className="h-9 min-w-0 max-w-[45%] rounded-md border border-surface-border/60 bg-input/40 px-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-focus/15 disabled:opacity-50 md:hidden"
        >
          <option value="" disabled>{results.length ? '选择设置分类' : '没有匹配的设置'}</option>
          {filteredGroups.map((group) => group.title ? (
            <optgroup key={group.title} label={group.title}>
              {group.items.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
            </optgroup>
          ) : group.items.map((item) => <option key={item.id} value={item.id}>{item.label}</option>))}
        </select>
      </div>
      {query.trim() && <p role="status" className="sr-only">找到 {results.length} 个设置分类</p>}
      {results.length === 0 && (
        <div className="px-4 pb-4 text-sm text-muted-foreground">
          <p>没有匹配的设置</p>
          <button type="button" onClick={clearSearch} className="mt-2 rounded text-foreground underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">清除搜索</button>
        </div>
      )}
      <ScrollRegion className="hidden min-h-0 flex-1 overflow-y-auto px-2.5 pb-5 md:block">
        <nav
          className="flex flex-col gap-4"
          aria-label="设置分类"
          onKeyDown={(event) => {
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
            const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button[data-settings-tab]'))
            const index = buttons.indexOf(event.currentTarget.ownerDocument.activeElement as HTMLButtonElement)
            if (index < 0) return
            event.preventDefault()
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
            buttons[next]?.focus()
          }}
        >
          {filteredGroups.map((group) => (
            <div key={group.title ?? '__root__'} className="space-y-1">
              {group.title && <h3 className="px-3 pb-1 text-xs font-medium text-muted-foreground">{group.title}</h3>}
              {group.items.map((tab) => (
                <button
                  type="button"
                  key={tab.id}
                  data-settings-tab={tab.id}
                  onClick={() => onTabChange(tab.id)}
                  aria-current={activeTab === tab.id ? 'page' : undefined}
                  className={cn(
                    'group flex min-h-9 w-full items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-focus/15',
                    activeTab === tab.id
                      ? 'bg-surface-selected font-medium text-foreground shadow-sm'
                      : 'text-muted-foreground hover:bg-surface-selected/50 hover:text-foreground',
                  )}
                >
                  <span aria-hidden="true" className={cn('shrink-0', activeTab === tab.id ? 'text-primary' : 'text-muted-foreground group-hover:text-foreground')}>{tab.icon}</span>
                  <span className="min-w-0 flex-1 truncate text-left">{tab.label}</span>
                  {tab.id === 'about' && needsAttention && <span className="size-2 shrink-0 rounded-full bg-destructive" role="img" aria-label="有更新或环境问题待处理" />}
                </button>
              ))}
            </div>
          ))}
        </nav>
      </ScrollRegion>
    </aside>
  )
}
