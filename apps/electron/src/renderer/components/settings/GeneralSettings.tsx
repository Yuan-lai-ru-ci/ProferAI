/**
 * GeneralSettings - 通用设置页
 *
 * 只保留系统级与环境配置：工作流入口（语言、快捷任务、界面引导）和系统环境（启动方式、Shell、新标签页）。
 * 使用中的高频开关（通知与声音、对话浏览、输入体验）已拆分至 UsageSettings（使用偏好）。
 * 账户与个人资料由 AccountSettings 独立管理。
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
import { settingsOpenAtom } from '@/atoms/settings-tab'
import { coachTourOpenAtom } from '@/atoms/coach-tour-atoms'
import { SHORTCUT_MAP } from '@/lib/shortcut-defaults'
import { getAcceleratorDisplay, isMac } from '@/lib/shortcut-registry'
import { Button } from '@profer/ui/primitives/button'
import type { RuntimeStatus } from '@profer/shared'

export function GeneralSettings(): React.ReactElement {
  const setSettingsOpen = useSetAtom(settingsOpenAtom)
  const setCoachTourOpen = useSetAtom(coachTourOpenAtom)
  const replayPendingRef = React.useRef(false)
  const [shellRuntimeStatus, setShellRuntimeStatus] = React.useState<RuntimeStatus | null>(null)
  const [autoLaunch, setAutoLaunch] = React.useState(false)
  const [autoLaunchBusy, setAutoLaunchBusy] = React.useState(true)
  const isWindows = detectIsWindows()
  const [quickTaskEnabled, setQuickTaskEnabled] = React.useState(false)
  const shortcutOverrides = useAtomValue(shortcutOverridesAtom)
  const quickTaskOverride = shortcutOverrides['quick-task']?.[isMac ? 'mac' : 'win']
  const quickTaskDefault = SHORTCUT_MAP.get('quick-task')
  // 尊重用户自定义和显式禁用，不把默认键写死在文案中。
  const quickTaskAccelerator = quickTaskOverride === null ? null : (
    quickTaskOverride || (isMac ? quickTaskDefault?.defaultMac : quickTaskDefault?.defaultWin) || ''
  )
  const quickTaskShortcut = getAcceleratorDisplay(quickTaskAccelerator)
  const [shellPreference, setShellPreference] = React.useState<'auto' | 'git-bash' | 'wsl'>('auto')
  const [browserHomeUrl, setBrowserHomeUrl] = React.useState('')

  // 加载设置
  React.useEffect(() => {
    window.electronAPI.getSettings().then((settings) => {
      setQuickTaskEnabled(settings.quickTaskEnabled === true)
      setShellPreference(settings.agentShellPreference ?? 'auto')
      setBrowserHomeUrl(settings.browserHomeUrl ?? '')
    }).catch(console.error)

    // 登录项以系统实际状态为准，不使用可能过期的配置缓存。
    let cancelled = false
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
    }).catch(() => {})
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
    try {
      const api = (window.electronAPI as Partial<typeof window.electronAPI>)
      if (typeof api.updateBrowserHomeUrl === 'function') {
        await api.updateBrowserHomeUrl(browserHomeUrl)
      } else {
        await window.electronAPI.updateSettings({ browserHomeUrl: browserHomeUrl.trim() })
      }
    } catch (error) {
      console.error('[通用设置] 更新默认首页失败:', error)
    }
  }

  /** 切换快速任务窗口，提示当前平台实际配置的快捷键。 */
  const handleQuickTaskToggle = async (enabled: boolean): Promise<void> => {
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
      setQuickTaskEnabled(!enabled) // 回滚
    }
  }

  return (
    <div className="space-y-6">
      <SettingsSection
        title="工作流与引导"
        description="控制任务入口和界面引导"
      >
        <SettingsCard>
          <SettingsRow
            label="语言"
            description="更多语言支持即将推出"
          >
            <span className="text-[13px] text-foreground/40">简体中文</span>
          </SettingsRow>
          <SettingsToggle
            label={`快速任务（${quickTaskShortcut || '快捷键已禁用'}）`}
            description={quickTaskShortcut
              ? `启用后预创建全局唤起窗口，在任意应用按 ${quickTaskShortcut} 快速向 Profer 发送任务；可在快捷键管理中修改`
              : '快捷键已禁用，可在快捷键管理中重新设置全局唤起组合键'}
            checked={quickTaskEnabled}
            onCheckedChange={handleQuickTaskToggle}
          />
          <SettingsRow
            label="界面引导"
            description="重新播放首次进入时的界面蒙层引导（Esc 可随时退出）"
          >
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                if (replayPendingRef.current) return
                replayPendingRef.current = true
                // 先关设置再开播：引导遮罩在主界面上方取景，避免盖住设置对话框
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
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title="系统环境"
        description="配置 Profer 的启动方式、命令执行环境和新标签页"
      >
        <SettingsCard>
          <SettingsToggle
            label="开机自启动"
            description="系统启动时自动运行 Profer"
            checked={autoLaunch}
            disabled={autoLaunchBusy}
            onCheckedChange={handleAutoLaunchChange}
          />

          {isWindows && <SettingsSelect
            label="Agent Shell 环境"
            description="Windows 上 Agent 执行命令的 Shell。切换后新会话生效，不影响已打开的会话。"
            value={shellPreference}
            onValueChange={async (value) => {
              const pref = value as 'auto' | 'git-bash' | 'wsl'
              setShellPreference(pref)
              try {
                await window.electronAPI.updateSettings({ agentShellPreference: pref })
              } catch (error) {
                console.error('[通用设置] 更新 Shell 偏好失败:', error)
              }
            }}
            options={[
              { value: 'auto', label: '自动检测（优先 Git Bash）' },
              { value: 'git-bash', label: `Git Bash${!shellRuntimeStatus?.shell?.gitBash?.available ? '（未检测到）' : shellRuntimeStatus?.shell?.gitBash?.version ? ` (v${shellRuntimeStatus.shell.gitBash.version})` : ''}` },
              { value: 'wsl', label: `WSL${!shellRuntimeStatus?.shell?.wsl?.available ? '（未检测到）' : shellRuntimeStatus?.shell?.wsl?.defaultDistro ? ` (${shellRuntimeStatus.shell.wsl.defaultDistro})` : ''}` },
            ]}
          />}

          <SettingsInput
            label="新标签页默认首页"
            description="留空时新建标签页显示起始页（书签与最近访问）；填入 URL 后新建标签页直接打开该地址"
            value={browserHomeUrl}
            onChange={setBrowserHomeUrl}
            onBlur={handleBrowserHomeUrlBlur}
            placeholder="例如 https://example.com"
          />
        </SettingsCard>
      </SettingsSection>
    </div>
  )
}
