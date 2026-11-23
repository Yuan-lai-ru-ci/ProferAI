/**
 * GeneralSettings - 通用设置页
 *
 * 日常使用和浏览器首页直接展示；语言、引导与 Windows Shell 收在低频区块。
 * 通知、对话阅读和输入体验由 UsageSettings 管理，账户资料由 AccountSettings 管理。
 */

import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { toast } from 'sonner'
import {
  SettingsSection,
  SettingsCard,
  SettingsRow,
  SettingsToggle,
  SettingsInput,
  SettingsSelect,
} from './primitives'
import { detectIsWindows } from '@profer/ui'
import { shortcutOverridesAtom } from '@/atoms/shortcut-atoms'
import {
  sessionHoverPreviewEnabledAtom,
  updateSessionHoverPreviewEnabled,
} from '@/atoms/session-preview-settings'
import { settingsOpenAtom } from '@/atoms/settings-tab'
import { coachTourOpenAtom } from '@/atoms/coach-tour-atoms'
import { replayIntroOpenAtom } from '@/atoms/intro-atoms'
import { SHORTCUT_MAP } from '@/lib/shortcut-defaults'
import { getAcceleratorDisplay, isMac } from '@/lib/shortcut-registry'
import { Button } from '@profer/ui/primitives/button'
import type { RuntimeStatus } from '@profer/shared'

export function GeneralSettings({ revealAdvanced = false }: { revealAdvanced?: boolean } = {}): React.ReactElement {
  const setSettingsOpen = useSetAtom(settingsOpenAtom)
  const setCoachTourOpen = useSetAtom(coachTourOpenAtom)
  const setReplayIntroOpen = useSetAtom(replayIntroOpenAtom)
  const replayPendingRef = React.useRef(false)
  const [shellRuntimeStatus, setShellRuntimeStatus] = React.useState<RuntimeStatus | null>(null)
  const [autoLaunch, setAutoLaunch] = React.useState(false)
  const [autoLaunchBusy, setAutoLaunchBusy] = React.useState(true)
  const isWindows = detectIsWindows()
  const [quickTaskEnabled, setQuickTaskEnabled] = React.useState(false)
  const shortcutOverrides = useAtomValue(shortcutOverridesAtom)
  const hoverPreviewEnabled = useAtomValue(sessionHoverPreviewEnabledAtom)
  const setHoverPreviewEnabled = useSetAtom(sessionHoverPreviewEnabledAtom)
  const [hoverPreviewBusy, setHoverPreviewBusy] = React.useState(false)
  const quickTaskOverride = shortcutOverrides['quick-task']?.[isMac ? 'mac' : 'win']
  const quickTaskDefault = SHORTCUT_MAP.get('quick-task')
  // 尊重用户自定义和显式禁用，不把默认键写死在文案中。
  const quickTaskAccelerator = quickTaskOverride === null ? null : (
    quickTaskOverride || (isMac ? quickTaskDefault?.defaultMac : quickTaskDefault?.defaultWin) || ''
  )
  const quickTaskShortcut = getAcceleratorDisplay(quickTaskAccelerator)
  const [shellPreference, setShellPreference] = React.useState<'auto' | 'git-bash' | 'wsl'>('auto')
  const [browserHomeUrl, setBrowserHomeUrl] = React.useState('')
  const [browserHomeError, setBrowserHomeError] = React.useState('')
  const [settingsLoading, setSettingsLoading] = React.useState(true)
  const [settingsError, setSettingsError] = React.useState('')
  const [quickTaskBusy, setQuickTaskBusy] = React.useState(false)
  const [shellBusy, setShellBusy] = React.useState(false)
  const [homeBusy, setHomeBusy] = React.useState(false)
  const savedHomeUrlRef = React.useRef('')

  // 加载设置
  React.useEffect(() => {
    let cancelled = false
    window.electronAPI.getSettings().then((settings) => {
      if (cancelled) return
      setQuickTaskEnabled(settings.quickTaskEnabled === true)
      setShellPreference(settings.agentShellPreference ?? 'auto')
      setBrowserHomeUrl(settings.browserHomeUrl ?? '')
      savedHomeUrlRef.current = settings.browserHomeUrl ?? ''
    }).catch((error: unknown) => {
      console.error('[通用设置] 加载偏好失败:', error)
      if (!cancelled) setSettingsError('无法加载偏好，请重新打开设置后重试')
    }).finally(() => {
      if (!cancelled) setSettingsLoading(false)
    })

    // 登录项以系统实际状态为准，不使用可能过期的配置缓存。
    window.electronAPI.getAutoLaunch().then((enabled) => {
      if (!cancelled) setAutoLaunch(enabled)
    }).catch((error) => {
      console.error('[通用设置] 读取开机自启动状态失败:', error)
      if (!cancelled) toast.error('读取开机自启动状态失败')
    }).finally(() => {
      if (!cancelled) setAutoLaunchBusy(false)
    })

    window.electronAPI.getRuntimeStatus().then((status) => {
      if (status) setShellRuntimeStatus(status)
    }).catch((error: unknown) => {
      console.error('[通用设置] 检测运行环境失败:', error)
      if (!cancelled && isWindows) toast.error('运行环境检测失败，请在关于/更新中重新检测')
    })
    return () => { cancelled = true }
  }, [])

  /** 切换开机自启动 */
  const handleAutoLaunchChange = async (enabled: boolean): Promise<void> => {
    setAutoLaunchBusy(true)
    setAutoLaunch(enabled)
    try {
      await window.electronAPI.setAutoLaunch(enabled)
      setAutoLaunch(await window.electronAPI.getAutoLaunch())
    } catch (error) {
      console.error('[通用设置] 设置开机自启动失败:', error)
      setAutoLaunch(!enabled) // 回滚
      toast.error('设置开机自启动失败')
    } finally {
      setAutoLaunchBusy(false)
    }
  }

  /** 保存新标签页默认首页（失焦时落盘）。 */
  const handleBrowserHomeUrlBlur = async (): Promise<void> => {
    if (settingsLoading || settingsError || homeBusy) return
    const trimmed = browserHomeUrl.trim()
    if (trimmed === savedHomeUrlRef.current) return
    if (trimmed) {
      try {
        const url = new URL(trimmed)
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error('protocol')
      } catch {
        setBrowserHomeError('请输入完整的 http:// 或 https:// 地址，或留空使用起始页')
        return
      }
    }
    setHomeBusy(true)
    setBrowserHomeError('')
    try {
      const api = (window.electronAPI as Partial<typeof window.electronAPI>)
      if (typeof api.updateBrowserHomeUrl === 'function') {
        await api.updateBrowserHomeUrl(trimmed)
      } else {
        await window.electronAPI.updateSettings({ browserHomeUrl: trimmed })
      }
      savedHomeUrlRef.current = trimmed
      setBrowserHomeUrl(trimmed)
    } catch (error) {
      console.error('[通用设置] 更新默认首页失败:', error)
      setBrowserHomeError('首页保存失败，当前输入尚未保存；请重新失焦重试')
      toast.error('默认首页保存失败')
    } finally {
      setHomeBusy(false)
    }
  }

  /** 切换快速任务窗口，提示当前平台实际配置的快捷键。 */
  const handleQuickTaskToggle = async (enabled: boolean): Promise<void> => {
    if (settingsLoading || settingsError || quickTaskBusy) return
    const previous = quickTaskEnabled
    setQuickTaskBusy(true)
    setQuickTaskEnabled(enabled)
    try {
      await window.electronAPI.updateSettings({ quickTaskEnabled: enabled })
      if (enabled) {
        if (!quickTaskAccelerator) {
          toast.info('快速任务已开启，但快捷键已禁用，请在快捷键管理中设置')
        } else {
          try {
            const results = await window.electronAPI.reregisterGlobalShortcuts()
            if (results['quick-task'] === true) {
              toast.success(`快速任务已开启，按 ${quickTaskShortcut} 唤起`)
            } else {
              toast.warning('快速任务已开启，但快捷键注册失败，请在快捷键管理中更换组合键')
            }
          } catch (error) {
            console.error('[通用设置] 检查快速任务快捷键注册失败:', error)
            toast.warning('快速任务已开启，但无法确认快捷键状态，请在快捷键管理中检查')
          }
        }
      } else {
        toast.success('快速任务已关闭')
      }
    } catch (error) {
      console.error('[通用设置] 更新快速任务开关失败:', error)
      setQuickTaskEnabled(previous)
      toast.error('快速任务设置保存失败，请重试')
    } finally {
      setQuickTaskBusy(false)
    }
  }

  /** 切换会话悬浮预览（atom 先改，侧栏立即生效；落盘失败由 update 回滚） */
  const handleHoverPreviewToggle = async (enabled: boolean): Promise<void> => {
    if (settingsLoading || settingsError || hoverPreviewBusy) return
    setHoverPreviewBusy(true)
    try {
      await updateSessionHoverPreviewEnabled(enabled, setHoverPreviewEnabled)
    } catch (error) {
      console.error('[通用设置] 更新会话悬浮预览失败:', error)
      toast.error('会话悬浮预览设置保存失败，请重试')
    } finally {
      setHoverPreviewBusy(false)
    }
  }

  return (
    <div className="space-y-6">
      {settingsError && <p role="alert" className="text-sm text-destructive">{settingsError}</p>}
      <SettingsSection title="日常使用">
        <SettingsCard>
          <SettingsToggle
            label="开机自启动"
            description="系统启动时自动运行 Profer"
            checked={autoLaunch}
            disabled={autoLaunchBusy}
            onCheckedChange={handleAutoLaunchChange}
          />
          <SettingsToggle
            label={`快速任务（${quickTaskShortcut || '快捷键已禁用'}）`}
            description={quickTaskShortcut
              ? `启用后预创建全局唤起窗口，在任意应用按 ${quickTaskShortcut} 快速向 Profer 发送任务；可在快捷键管理中修改`
              : '快捷键已禁用，可在快捷键管理中重新设置全局唤起组合键'}
            checked={quickTaskEnabled}
            disabled={settingsLoading || Boolean(settingsError) || quickTaskBusy}
            onCheckedChange={handleQuickTaskToggle}
          />
          <SettingsToggle
            label="会话悬浮预览"
            description="鼠标在侧栏会话上停住时弹出内容迷你预览；关闭后不再弹出（全局搜索同样生效）"
            checked={hoverPreviewEnabled}
            disabled={settingsLoading || Boolean(settingsError) || hoverPreviewBusy}
            onCheckedChange={handleHoverPreviewToggle}
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="浏览器">
        <SettingsCard>
          <SettingsInput
            label="新标签页默认首页"
            description="留空时新建标签页显示起始页（书签与最近访问）；填入 URL 后新建标签页直接打开该地址"
            value={browserHomeUrl}
            type="url"
            disabled={settingsLoading || Boolean(settingsError) || homeBusy}
            error={browserHomeError}
            onChange={(value) => {
              setBrowserHomeUrl(value)
              setBrowserHomeError('')
            }}
            onBlur={handleBrowserHomeUrlBlur}
            placeholder="例如 https://example.com"
          />
        </SettingsCard>
      </SettingsSection>

      {isWindows && (
        <SettingsSection title="命令执行环境" collapsible defaultOpen={false} reveal={revealAdvanced}>
          <SettingsCard>
            <SettingsSelect
              label="Agent Shell 环境"
              description="Windows 上 Agent 执行命令的 Shell。切换后新会话生效，不影响已打开的会话。"
              value={shellPreference}
              disabled={settingsLoading || Boolean(settingsError) || shellBusy}
              onValueChange={async (value) => {
                const pref = value as 'auto' | 'git-bash' | 'wsl'
                if (settingsLoading || settingsError || shellBusy) return
                const previous = shellPreference
                setShellBusy(true)
                setShellPreference(pref)
                try {
                  await window.electronAPI.updateSettings({ agentShellPreference: pref })
                } catch (error) {
                  console.error('[通用设置] 更新 Shell 偏好失败:', error)
                  setShellPreference(previous)
                  toast.error('Shell 偏好保存失败，请重试')
                } finally {
                  setShellBusy(false)
                }
              }}
              options={[
                { value: 'auto', label: '自动检测（优先 Git Bash）' },
                { value: 'git-bash', label: `Git Bash${!shellRuntimeStatus?.shell?.gitBash?.available ? '（未检测到）' : shellRuntimeStatus?.shell?.gitBash?.version ? ` (v${shellRuntimeStatus.shell.gitBash.version})` : ''}` },
                { value: 'wsl', label: `WSL${!shellRuntimeStatus?.shell?.wsl?.available ? '（未检测到）' : shellRuntimeStatus?.shell?.wsl?.defaultDistro ? ` (${shellRuntimeStatus.shell.wsl.defaultDistro})` : ''}` },
              ]}
            />
          </SettingsCard>
        </SettingsSection>
      )}

      <SettingsSection title="语言与引导" collapsible defaultOpen={false} reveal={revealAdvanced}>
        <SettingsCard>
          <SettingsRow label="当前语言"><span className="text-sm text-muted-foreground">简体中文</span></SettingsRow>
          <SettingsRow
            label="界面引导"
            description="重新播放界面操作引导；按 Esc 退出"
          >
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                if (replayPendingRef.current) return
                replayPendingRef.current = true
                // 先关闭设置，让引导在主界面上取景。
                setSettingsOpen(false)
                window.setTimeout(() => {
                  setCoachTourOpen(true)
                  window.setTimeout(() => { replayPendingRef.current = false }, 500)
                }, 200)
              }}
            >
              重新播放
            </Button>
          </SettingsRow>
          <SettingsRow
            label="首次引导"
            description="重播欢迎页、功能导览和导入指引；不会重置设置或数据"
          >
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setSettingsOpen(false)
                window.setTimeout(() => setReplayIntroOpen(true), 200)
              }}
            >
              重新播放
            </Button>
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>
    </div>
  )
}
