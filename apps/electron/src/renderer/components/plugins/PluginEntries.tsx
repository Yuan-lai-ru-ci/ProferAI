import * as React from 'react'
import { useAtomValue } from 'jotai'
import { Blocks } from 'lucide-react'
import { toast } from 'sonner'
import { allowsPluginPagePlacement, resolvePluginPageSurfaceVisibility, type ProferPluginTaskReference } from '@profer/plugin-api'
import { installedPluginsAtom } from '@/atoms/plugin-system'
import { usePluginPage } from '@/hooks/usePluginPage'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

function report(error: unknown): void { toast.error(error instanceof Error ? error.message : '无法打开插件') }

type PluginPageEntry = { pluginId: string; updatedAt: number; page: { id: string; title: string; icon?: string } }

function usePluginPages(placement: 'tab' | 'sidebar'): { pages: PluginPageEntry[]; open: ReturnType<typeof usePluginPage> } {
  const plugins = useAtomValue(installedPluginsAtom)
  const open = usePluginPage()
  const pages = plugins.filter((plugin) => plugin.enabled).flatMap((plugin) => (plugin.manifest.contributes.pages ?? [])
    .filter((page) => resolvePluginPageSurfaceVisibility(page, plugin.pagePlacements?.[page.id], placement))
    .map((page) => ({ pluginId: plugin.manifest.id, updatedAt: plugin.updatedAt, page })))
  return { pages, open }
}

/** 图标 data URL 缓存：key 含插件 updatedAt，插件更新后自动失效。 */
const iconCache = new Map<string, Promise<string | null>>()

function usePluginPageIcon(entry: PluginPageEntry): string | null {
  const [url, setUrl] = React.useState<string | null>(null)
  const { pluginId, updatedAt, page } = entry
  React.useEffect(() => {
    if (!page.icon) { setUrl(null); return }
    let alive = true
    const key = `${pluginId}:${page.id}:${updatedAt}`
    let cached = iconCache.get(key)
    if (!cached) {
      cached = window.electronAPI.getPluginPageIcon(pluginId, page.id)
        .then((result) => (result ? `data:${result.mime};base64,${result.dataBase64}` : null))
        .catch(() => null)
      iconCache.set(key, cached)
    }
    void cached.then((value) => { if (alive) setUrl(value) })
    return () => { alive = false }
  }, [pluginId, page, updatedAt])
  return url
}

/** 页面入口图标：清单声明 icon 时渲染图片，否则回退宿主占位图标。 */
function PluginPageIcon({ entry, size = 16 }: { entry: PluginPageEntry; size?: number }): React.ReactElement {
  const url = usePluginPageIcon(entry)
  if (!url) return <Blocks size={size} aria-hidden="true" />
  return <img src={url} alt="" width={size} height={size} className="rounded-[4px] object-contain" />
}

export function PluginSidebarEntries({ collapsed = false }: { collapsed?: boolean }): React.ReactElement | null {
  const { pages, open } = usePluginPages('sidebar')
  if (!pages.length) return null
  return <div className={collapsed ? 'max-h-40 overflow-y-auto space-y-1' : 'max-h-48 overflow-y-auto px-3 py-1 space-y-1'}>
    {pages.map((entry) => <button key={`${entry.pluginId}:${entry.page.id}`} type="button" title={entry.page.title} aria-label={entry.page.title}
      className={`titlebar-no-drag flex items-center gap-2 rounded-xl text-sm text-muted-foreground hover:bg-primary/10 hover:text-foreground ${collapsed ? 'size-10 justify-center' : 'w-full px-3 py-2'}`}
      onClick={() => void open(entry.pluginId, entry.page.id, entry.page.title, undefined, 'sidebar').catch(report)}>
      <PluginPageIcon entry={entry} />{!collapsed && <span className="truncate">{entry.page.title}</span>}
    </button>)}
  </div>
}

/** 声明了顶栏入口的插件页面逐个渲染为图标按钮；没有可展示页面时不占顶栏。 */
export function PluginTopBarEntries(): React.ReactElement | null {
  const { pages, open } = usePluginPages('tab')
  if (!pages.length) return null
  return <>
    {pages.map((entry) => (
      <Tooltip key={`${entry.pluginId}:${entry.page.id}`}>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="topbar-tool-button relative z-20 h-8 w-8"
            aria-label={entry.page.title}
            onClick={() => void open(entry.pluginId, entry.page.id, entry.page.title, undefined, 'tab').catch(report)}
          >
            <PluginPageIcon entry={entry} />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <p>{entry.page.title}</p>
        </TooltipContent>
      </Tooltip>
    ))}
  </>
}

export function PluginMessageActions({ reference }: { reference: ProferPluginTaskReference }): React.ReactElement | null {
  const plugins = useAtomValue(installedPluginsAtom), open = usePluginPage()
  const actions = plugins.filter((plugin) => plugin.enabled).flatMap((plugin) => (plugin.manifest.contributes.messageActions ?? [])
    .filter((action) => plugin.manifest.contributes.pages?.some((page) => page.id === action.pageId && allowsPluginPagePlacement(page, 'tab')))
    .map((action) => ({ pluginId: plugin.manifest.id, action })))
  if (!actions.length) return null
  return <select aria-label="用插件处理消息" value="" className="max-w-40 rounded-md bg-transparent px-1 py-1 text-xs text-muted-foreground"
    onChange={(event) => {
      const selected = actions[Number(event.target.value)]
      if (selected) void open(selected.pluginId, selected.action.pageId, selected.action.title, { ...reference, selection: window.getSelection()?.toString().slice(0, 100_000) || undefined }, 'tab').catch(report)
    }}>
    <option value="" disabled>用插件处理…</option>
    {actions.map(({ pluginId, action }, index) => <option value={index} key={`${pluginId}:${action.id}`}>{action.title}</option>)}
  </select>
}

export type { PluginPageEntry }
