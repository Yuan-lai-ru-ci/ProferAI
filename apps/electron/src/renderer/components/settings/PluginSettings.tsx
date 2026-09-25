import { PluginCredentialField } from '@/components/plugins/PluginCredentialField'
import { allowsPluginPagePlacement, PROFER_PLUGIN_PERMISSION_LABELS } from '@profer/plugin-api'
import { installedPluginsAtom } from '@/atoms/plugin-system'
import { usePluginPage } from '@/hooks/usePluginPage'
import * as React from 'react'
import { useAtom } from 'jotai'
import { Blocks, ExternalLink, FolderOpen, Loader2, PackagePlus, RefreshCw, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import type { ProferInstalledPlugin } from '@profer/plugin-api'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { SettingsCard, SettingsSection } from './primitives'

function formatInstalledAt(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium' }).format(new Date(timestamp))
}

const PAGE_PLACEMENT_OPTIONS: Array<{ value: 'default' | 'sidebar' | 'tab' | 'hidden'; label: string }> = [
  { value: 'default', label: '按插件声明' },
  { value: 'sidebar', label: '左侧栏' },
  { value: 'tab', label: '顶栏' },
  { value: 'hidden', label: '隐藏（静默生效）' },
]

export function PluginSettings(): React.ReactElement {
  const [plugins, setPlugins] = useAtom(installedPluginsAtom)
  const openPluginPage = usePluginPage()
  const [loading, setLoading] = React.useState(true)
  const [busyKey, setBusyKey] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const refresh = React.useCallback(async (): Promise<void> => {
    setError(null)
    try {
      const nextPlugins = await window.electronAPI.listPlugins()
      setPlugins(nextPlugins)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '无法读取插件列表'
      setError(message)
    } finally {
      setLoading(false)
    }
  }, [setPlugins])

  React.useEffect(() => {
    void refresh()
    return window.electronAPI.onPluginsChanged(() => { void refresh() })
  }, [refresh])

  const install = async (kind: 'zip' | 'folder'): Promise<void> => {
    setBusyKey(`install-${kind}`)
    try {
      const path = await window.electronAPI.selectPluginPackage(kind)
      if (!path) return
      let result = await window.electronAPI.installPlugin(path)
      if (!result.ok && result.status === 'conflict' && window.confirm(`${result.message}。确定替换已安装版本吗？`)) {
        result = await window.electronAPI.installPlugin(path, true)
      }
      if (!result.ok) {
        toast.error(result.status === 'conflict' ? '插件已存在' : '插件安装失败', { description: result.message })
        return
      }
      toast.success(result.message)
      await refresh()
    } catch (cause) {
      toast.error('插件安装失败', { description: cause instanceof Error ? cause.message : String(cause) })
    } finally {
      setBusyKey(null)
    }
  }

  const toggle = async (plugin: ProferInstalledPlugin, enabled: boolean): Promise<void> => {
    setBusyKey(`toggle-${plugin.manifest.id}`)
    try {
      const result = await window.electronAPI.setPluginEnabled(plugin.manifest.id, enabled)
      if (!result.ok) toast.error('插件状态更新失败', { description: result.message })
      else toast.success(result.message)
      await refresh()
    } catch (cause) {
      toast.error('插件状态更新失败', { description: cause instanceof Error ? cause.message : String(cause) })
    } finally {
      setBusyKey(null)
    }
  }

  const remove = async (plugin: ProferInstalledPlugin): Promise<void> => {
    if (!window.confirm(`确定卸载「${plugin.manifest.name}」吗？插件私有数据会保留。`)) return
    setBusyKey(`remove-${plugin.manifest.id}`)
    try {
      const result = await window.electronAPI.removePlugin(plugin.manifest.id)
      if (!result.ok) toast.error('插件卸载失败', { description: result.message })
      else toast.success(result.message)
      await refresh()
    } catch (cause) {
      toast.error('插件卸载失败', { description: cause instanceof Error ? cause.message : String(cause) })
    } finally {
      setBusyKey(null)
    }
  }

  const openPage = (plugin: ProferInstalledPlugin, pageId: string, title: string): void => {
    void openPluginPage(plugin.manifest.id, pageId, title, undefined, 'settings').catch((error: unknown) => toast.error(String(error)))
  }
  const changePermission = async (pluginId: string, revoke = false): Promise<void> => {
    setBusyKey(`permission-${pluginId}`)
    try {
      if (revoke) await window.electronAPI.revokePluginPermissions(pluginId)
      else await window.electronAPI.authorizePlugin(pluginId)
      await refresh()
    } catch (error) { toast.error(error instanceof Error ? error.message : '权限操作失败') }
    finally { setBusyKey(null) }
  }
  const changePagePlacement = async (plugin: ProferInstalledPlugin, pageId: string, value: string): Promise<void> => {
    setBusyKey(`placement-${plugin.manifest.id}-${pageId}`)
    try {
      const preference = value === 'default' ? null : (value as 'sidebar' | 'tab' | 'hidden')
      const result = await window.electronAPI.setPluginPagePlacement(plugin.manifest.id, pageId, preference)
      if (!result.ok) {
        toast.error('入口位置更新失败', { description: result.message })
        return
      }
      toast.success(result.message)
      await refresh()
    } catch (error) { toast.error(error instanceof Error ? error.message : '入口位置更新失败') }
    finally { setBusyKey(null) }
  }
  return (
    <div className="space-y-6">
      <SettingsSection
        title="插件系统"
        description="通过插件扩展 Profer 的能力；插件管理使用 Profer 原生控件，插件页面在独立标签页和任务入口中运行。"
        action={(
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}>
              <RefreshCw className={loading ? 'animate-spin' : undefined} aria-hidden="true" />
              刷新
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => void window.electronAPI.openPluginsFolder()}>
              <FolderOpen aria-hidden="true" />
              插件目录
            </Button>
          </div>
        )}
      >
        <div className="rounded-xl bg-primary/5 px-4 py-3 text-sm leading-6 text-muted-foreground">
          支持工具页面、模型路由和 Agent 工具。安装后请查看并授权所需能力；模型调用会使用你的渠道额度，网络请求仅限已授权的服务。
        </div>
      </SettingsSection>

      <SettingsSection title="安装插件" description="开发阶段可直接选择插件目录；分发时建议使用 ZIP 包。">
        <SettingsCard divided={false} className="p-4">
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" onClick={() => void install('zip')} disabled={busyKey !== null}>
              {busyKey === 'install-zip' ? <Loader2 className="animate-spin" aria-hidden="true" /> : <PackagePlus aria-hidden="true" />}
              安装 ZIP
            </Button>
            <Button type="button" variant="outline" onClick={() => void install('folder')} disabled={busyKey !== null}>
              {busyKey === 'install-folder' ? <Loader2 className="animate-spin" aria-hidden="true" /> : <FolderOpen aria-hidden="true" />}
              安装目录
            </Button>
            <span className="text-xs text-muted-foreground">根目录需要包含 profer-plugin.json</span>
          </div>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="已安装插件" description="插件停用后不会删除配置数据；卸载也会保留 plugin-data。">
        <div aria-busy={loading} aria-live="polite">
          {loading && (
            <SettingsCard divided={false} className="p-6 text-center text-sm text-muted-foreground">
              <Loader2 className="mx-auto mb-2 animate-spin" aria-hidden="true" />
              正在读取插件列表…
            </SettingsCard>
          )}
          {!loading && error && (
            <SettingsCard divided={false} className="p-6 text-center">
              <p className="text-sm text-destructive">{error}</p>
              <Button className="mt-3" type="button" variant="outline" size="sm" onClick={() => void refresh()}>重试</Button>
            </SettingsCard>
          )}
          {!loading && !error && plugins.length === 0 && (
            <SettingsCard divided={false} className="flex min-h-[320px] flex-col items-center justify-center rounded-xl bg-surface-raised/70 px-6 py-12 text-center shadow-sm">
              <div className="flex size-14 items-center justify-center rounded-2xl bg-muted/70 text-muted-foreground">
                <Blocks aria-hidden="true" className="size-7" />
              </div>
              <h3 className="mt-5 text-base font-medium text-foreground">插件系统已就绪</h3>
              <p className="mt-2 max-w-sm text-sm leading-6 text-muted-foreground">
                还没有安装插件。先选择 ZIP 或本地插件目录，安装后可在这里启用、管理和打开插件页面。
              </p>
            </SettingsCard>
          )}
          {!loading && !error && plugins.length > 0 && (
            <div className="space-y-3">
              {plugins.map((plugin) => {
                const pluginBusy = busyKey?.includes(plugin.manifest.id) ?? false
                const enabledBusy = busyKey !== null
                const settingsPages = (plugin.manifest.contributes.pages ?? []).filter((page) => allowsPluginPagePlacement(page, 'settings'))
                const surfacePages = (plugin.manifest.contributes.pages ?? []).filter((page) => allowsPluginPagePlacement(page, 'sidebar') || allowsPluginPagePlacement(page, 'tab'))
                return (
                  <SettingsCard key={plugin.manifest.id} divided={false} className="p-4">
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="text-sm font-semibold text-foreground">{plugin.manifest.name}</h3>
                          <Badge variant={plugin.enabled ? 'secondary' : 'outline'}>{plugin.enabled ? '已启用' : '已停用'}</Badge>
                          <span className="text-xs font-mono text-muted-foreground">v{plugin.manifest.version}</span>
                        </div>
                        <p className="mt-1 text-sm leading-6 text-muted-foreground">{plugin.manifest.description ?? '未提供插件描述。'}</p>
                        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                          <span>安装于 {formatInstalledAt(plugin.installedAt)}</span>
                          {plugin.manifest.publisher && <span>作者 {plugin.manifest.publisher}</span>}
                          <span>{plugin.manifest.contributes.pages?.length ?? 0} 个页面</span>
                        </div>
                        <div className="mt-3 flex flex-wrap gap-1.5">
                          {(plugin.manifest.permissions ?? []).map((permission) => <Badge key={permission} variant="outline">{PROFER_PLUGIN_PERMISSION_LABELS[permission]}{plugin.revoked ? ' · 已撤销' : plugin.grantedPermissions?.includes(permission) ? ' · 已授权' : ' · 待授权'}</Badge>)}
                        </div>
                        {!!plugin.manifest.network?.origins.length && <p className="mt-2 text-xs text-muted-foreground">网络服务：{plugin.manifest.network.origins.join('、')}</p>}
                        {plugin.manifest.network?.credentials?.map((credential) => <PluginCredentialField key={credential.id} pluginId={plugin.manifest.id} {...credential} />)}
                        <div className="mt-3 flex gap-2">
                          <Button size="sm" variant="outline" disabled={busyKey !== null} onClick={() => void changePermission(plugin.manifest.id)}>查看并授权能力</Button>
                          <Button size="sm" variant="ghost" disabled={busyKey !== null} onClick={() => void changePermission(plugin.manifest.id, true)}>撤销授权</Button>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Switch
                          checked={plugin.enabled}
                          disabled={pluginBusy}
                          onCheckedChange={(checked) => void toggle(plugin, checked)}
                          aria-label={`${plugin.manifest.name}${plugin.enabled ? '停用' : '启用'}`}
                        />
                        <Button type="button" variant="ghost" size="icon-sm" disabled={pluginBusy} onClick={() => void remove(plugin)} aria-label={`卸载 ${plugin.manifest.name}`}>
                          {pluginBusy ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Trash2 aria-hidden="true" />}
                        </Button>
                      </div>
                    </div>
                    {plugin.enabled && settingsPages.length > 0 && (
                      <div className="mt-4 flex flex-wrap gap-2 border-t border-surface-border/40 pt-3">
                        {settingsPages.map((page) => (
                          <Button key={page.id} type="button" variant="outline" size="sm" onClick={() => openPage(plugin, page.id, page.title)}>
                            {page.title}
                            <ExternalLink aria-hidden="true" />
                          </Button>
                        ))}
                      </div>
                    )}
                    {plugin.enabled && surfacePages.length > 0 && (
                      <div className="mt-3 space-y-2 border-t border-surface-border/40 pt-3">
                        <p className="text-xs text-muted-foreground">入口位置：只能收窄插件声明的入口；隐藏后插件静默生效。</p>
                        {surfacePages.map((page) => {
                          const options = PAGE_PLACEMENT_OPTIONS.filter((option) =>
                            option.value === 'default' || option.value === 'hidden' || allowsPluginPagePlacement(page, option.value))
                          return (
                            <div key={page.id} className="flex items-center justify-between gap-3">
                              <span className="text-sm text-foreground">{page.title}</span>
                              <Select
                                value={plugin.pagePlacements?.[page.id] ?? 'default'}
                                disabled={enabledBusy}
                                onValueChange={(value) => void changePagePlacement(plugin, page.id, value)}
                              >
                                <SelectTrigger className="h-8 w-44 text-xs" aria-label={`${page.title} 的入口位置`}>
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  {options.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
                                </SelectContent>
                              </Select>
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </SettingsCard>
                )
              })}
            </div>
          )}
        </div>
      </SettingsSection>
    </div>
  )
}
