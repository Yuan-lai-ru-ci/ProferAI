/**
 * ProxySettings - 代理配置页
 *
 * 全局代理配置，支持系统代理自动检测和手动配置。
 * 所有 AI API 请求（Chat + Agent）都会使用这里的代理配置。
 */

import * as React from 'react'
import { useAtom, useSetAtom } from 'jotai'
import { Globe, Loader2, CheckCircle2, XCircle, RefreshCw } from 'lucide-react'
import {
  SettingsSection,
  SettingsCard,
  SettingsToggle,
  SettingsInput,
} from './primitives'
import { proxyConfigAtom, loadProxyConfigAtom, updateProxyConfigAtom } from '@/atoms/proxy-atoms'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'

export function ProxySettings(): React.ReactElement {
  const [config, setConfig] = useAtom(proxyConfigAtom)
  const loadProxyConfig = useSetAtom(loadProxyConfigAtom)
  const updateProxyConfig = useSetAtom(updateProxyConfigAtom)

  const [detecting, setDetecting] = React.useState(false)
  const [detectResult, setDetectResult] = React.useState<{ success: boolean; message: string } | null>(null)
  const [loadError, setLoadError] = React.useState('')
  const [saving, setSaving] = React.useState(false)
  const [manualUrl, setManualUrl] = React.useState('')
  const [urlError, setUrlError] = React.useState('')

  const reload = React.useCallback(() => {
    setLoadError('')
    void loadProxyConfig().catch(() => setLoadError('代理设置加载失败'))
  }, [loadProxyConfig])

  React.useEffect(() => {
    reload()
  }, [reload])

  React.useEffect(() => {
    setManualUrl(config?.manualUrl ?? '')
  }, [config?.manualUrl])

  if (!config) {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground">
        {loadError ? (
          <div className="space-y-3 text-center">
            <p role="alert" className="text-destructive">{loadError}</p>
            <button type="button" onClick={reload} className="rounded-md border border-border px-3 py-2 hover:bg-control">重试</button>
          </div>
        ) : (
          <><Loader2 size={24} className="animate-spin" /><span className="ml-2">加载中...</span></>
        )}
      </div>
    )
  }

  /** 更新代理配置（本地状态 + 持久化） */
  const handleUpdate = async (updates: Partial<typeof config>): Promise<void> => {
    if (saving || loadError) return
    const previous = config
    setSaving(true)
    const updated = { ...config, ...updates }
    setConfig(updated)
    try {
      await updateProxyConfig(updated)
    } catch (error) {
      console.error('[代理设置] 更新失败:', error)
      setConfig(previous)
      toast.error('代理设置保存失败，请重试')
    } finally {
      setSaving(false)
    }
  }

  const saveManualUrl = async (): Promise<void> => {
    const trimmed = manualUrl.trim()
    if (trimmed === config.manualUrl || saving) return
    if (trimmed) {
      try {
        const url = new URL(trimmed)
        if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) throw new Error('protocol')
      } catch {
        setUrlError('请输入完整的 http:// 或 https:// 代理地址')
        return
      }
    }
    setUrlError('')
    await handleUpdate({ manualUrl: trimmed })
  }

  /** 检测系统代理 */
  const handleDetectSystemProxy = async (): Promise<void> => {
    setDetecting(true)
    setDetectResult(null)

    try {
      const result = await window.electronAPI.detectSystemProxy()
      setDetectResult({
        success: result.success,
        message: result.success
          ? `检测到系统代理: ${result.proxyUrl}`
          : result.message,
      })
    } catch (error) {
      setDetectResult({
        success: false,
        message: '检测失败',
      })
    } finally {
      setDetecting(false)
    }
  }

  return (
    <div className="space-y-6">
      {loadError && <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-destructive">
        <span>{loadError}</span>
        <button type="button" onClick={reload} className="underline">重试</button>
      </div>}
      {/* 代理开关 */}
      <SettingsSection
        title="代理配置"
        description="配置后所有 AI API 请求（Chat + Agent）将通过代理发送"
      >
        <SettingsCard>
          <SettingsToggle
            label="启用代理"
            description="开启后可选择系统代理或手动配置代理地址"
            checked={config.enabled}
            disabled={saving || Boolean(loadError)}
            onCheckedChange={(enabled) => handleUpdate({ enabled })}
          />
        </SettingsCard>
      </SettingsSection>

      {/* 代理模式选择（仅在启用时显示） */}
      {config.enabled && (
        <SettingsSection title="代理模式">
          <SettingsCard divided={false}>
            {/* 系统代理选项 */}
            <div
              className={cn(
                'flex items-start gap-3 px-4 py-3 cursor-pointer transition-colors hover:bg-muted/50',
                config.mode === 'system' && 'bg-accent/10'
              )}
            >
              <input
                type="radio"
                name="proxy-mode"
                id="proxy-mode-system"
                aria-describedby="proxy-mode-system-description"
                disabled={saving || Boolean(loadError)}
                checked={config.mode === 'system'}
                onChange={() => handleUpdate({ mode: 'system' })}
                className="mt-0.5 w-4 h-4 accent-foreground cursor-pointer"
              />
              <div className="flex-1">
                <div className="text-sm font-medium text-foreground flex items-center gap-2">
                  <Globe size={16} />
                  <label htmlFor="proxy-mode-system">系统代理（推荐）</label>
                </div>
                <p id="proxy-mode-system-description" className="text-xs text-muted-foreground mt-1">
                  自动检测操作系统的代理设置（macOS 网络偏好设置、Windows Internet 选项等）
                </p>
                {config.mode === 'system' && (
                  <div className="mt-3">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        handleDetectSystemProxy()
                      }}
                      disabled={detecting}
                      className="inline-flex items-center gap-1.5 text-xs text-primary hover:text-primary/80 transition-colors disabled:opacity-50"
                    >
                      {detecting ? (
                        <Loader2 size={12} className="animate-spin" />
                      ) : (
                        <RefreshCw size={12} />
                      )}
                      <span>检测系统代理</span>
                    </button>
                    {detectResult && (
                      <div
                        role="status"
                        className={cn(
                          'flex items-center gap-1.5 text-xs mt-2',
                          detectResult.success ? 'text-emerald-600' : 'text-muted-foreground'
                        )}
                      >
                        {detectResult.success ? (
                          <CheckCircle2 size={12} />
                        ) : (
                          <XCircle size={12} />
                        )}
                        <span>{detectResult.message}</span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* 分隔线 */}
            <div className="border-b border-border/50" />

            {/* 手动配置选项 */}
            <div
              className={cn(
                'px-4 py-3 cursor-pointer transition-colors hover:bg-muted/50',
                config.mode === 'manual' && 'bg-accent/10'
              )}
            >
              <div className="flex items-start gap-3">
                <input
                  type="radio"
                  name="proxy-mode"
                  id="proxy-mode-manual"
                  disabled={saving || Boolean(loadError)}
                  checked={config.mode === 'manual'}
                  onChange={() => handleUpdate({ mode: 'manual' })}
                  className="mt-0.5 w-4 h-4 accent-foreground cursor-pointer"
                />
                <div className="flex-1">
                  <label htmlFor="proxy-mode-manual" className="text-sm font-medium text-foreground">手动配置</label>
                  <p className="text-xs text-muted-foreground mt-1">
                    手动输入代理地址和端口
                  </p>
                </div>
              </div>
              {config.mode === 'manual' && (
                <div className="mt-3 ml-7">
                  <SettingsInput
                    label="代理地址"
                    value={manualUrl}
                    onChange={(value) => { setManualUrl(value); setUrlError('') }}
                    onBlur={saveManualUrl}
                    error={urlError}
                    type="url"
                    disabled={saving || Boolean(loadError)}
                    placeholder="http://127.0.0.1:7890"
                    description="格式: http://host:port 或 https://host:port"
                  />
                </div>
              )}
            </div>
          </SettingsCard>
        </SettingsSection>
      )}
    </div>
  )
}
