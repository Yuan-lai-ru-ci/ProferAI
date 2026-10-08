import * as React from 'react'
import { useAtom, useSetAtom } from 'jotai'
import { toast } from 'sonner'
import { Button } from '@profer/ui/primitives/button'
import { developerModeEnabledAtom, openEpistemicModeEnabledAtom } from '@/atoms/developer-mode'
import { settingsTabAtom } from '@/atoms/settings-tab'
import { SettingsCard, SettingsSection, SettingsToggle } from './primitives'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@profer/ui/primitives/alert-dialog'

export function DeveloperSettings(): React.ReactElement {
  const [developerModeEnabled, setDeveloperModeEnabled] = useAtom(developerModeEnabledAtom)
  const [openEpistemicModeEnabled, setOpenEpistemicModeEnabled] = useAtom(openEpistemicModeEnabledAtom)
  const setActiveTab = useSetAtom(settingsTabAtom)
  const [saving, setSaving] = React.useState(false)
  const savingRef = React.useRef(false)
  const [exitOpen, setExitOpen] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const updateOpenEpistemicMode = async (enabled: boolean): Promise<void> => {
    if (!developerModeEnabled || savingRef.current) return
    savingRef.current = true
    setError(null)
    setSaving(true)
    try {
      const settings = await window.electronAPI.updateSettings({ openEpistemicModeEnabled: enabled })
      setOpenEpistemicModeEnabled(settings.openEpistemicModeEnabled === true)
      toast.success(settings.openEpistemicModeEnabled === true ? '开放认识论已启用，将从下一轮 Agent 消息起生效' : '开放认识论已关闭，将从下一轮 Agent 消息起生效')
    } catch (error) {
      setError(`开发者设置保存失败：${error instanceof Error ? error.message : String(error)}`)
      toast.error('开发者设置保存失败', { description: error instanceof Error ? error.message : String(error) })
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  const exitDeveloperMode = async (): Promise<void> => {
    if (!developerModeEnabled || savingRef.current) return
    savingRef.current = true
    setError(null)
    setSaving(true)
    try {
      const settings = await window.electronAPI.updateSettings({
        developerModeEnabled: false,
        openEpistemicModeEnabled: false,
      })
      if (settings.developerModeEnabled !== false || settings.openEpistemicModeEnabled !== false) throw new Error('应用未确认关闭开发者模式')
      setDeveloperModeEnabled(false)
      setOpenEpistemicModeEnabled(false)
      setExitOpen(false)
      setActiveTab('general')
      toast.success('开发者模式已关闭')
    } catch (error) {
      setError(`关闭开发者模式失败：${error instanceof Error ? error.message : String(error)}`)
      toast.error('关闭开发者模式失败', { description: error instanceof Error ? error.message : String(error) })
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  if (!developerModeEnabled) return <SettingsSection title="开发者模式" description="开发者模式尚未启用；此页不可修改实验设置。"><SettingsCard divided={false} className="p-4 text-sm text-muted-foreground">请通过应用已有入口管理开发者模式。</SettingsCard></SettingsSection>

  return (
    <div className="space-y-6" aria-busy={saving}>
      {error && <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
      <SettingsSection
        title="开发者模式"
        description="管理实验性能力。这里的设置可能改变 Agent 的工作姿态，但不会绕过权限、安全规则或模型服务端约束。"
      >
        <SettingsCard>
          <SettingsToggle
            label="开放认识论（关闭「绝对正确」姿态）"
            description="开启后 Agent 不再为了保持「绝对正确」而回避表态：先给判断、不做两头并列、不堆免责声明，允许暂定结论与创作自由。执行事实、文件修改、测试、发送与发布仍必须真实可核验。全局设置，下一轮 Agent 消息起生效。"
            checked={openEpistemicModeEnabled}
            onCheckedChange={(enabled) => { void updateOpenEpistemicMode(enabled) }}
            disabled={saving}
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="运行时边界" description="本开关改变 Profer 注入的 Agent 姿态，不代表移除所有上游约束；已开启的会话会从下一轮消息起使用新的姿态段。">
        <SettingsCard divided={false} className="p-4 text-sm leading-6 text-muted-foreground">
          Claude Runtime 在开放认识论开启时不再叠加本地 Claude Code 默认 preset，改用 Profer 自管 system prompt；模型服务端更高优先级的 system、developer、安全与法律规则仍然存在。Pi Runtime 始终使用 Profer 自管 system prompt。
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="退出开发者模式" description="关闭后会隐藏开发者与插件入口，并同时关闭开放认识论；已安装插件及其数据不会被删除。">
        <Button type="button" variant="outline" onClick={() => setExitOpen(true)} disabled={saving}>
          退出开发者模式
        </Button>
      </SettingsSection>
      <AlertDialog open={exitOpen} onOpenChange={(open) => { if (!savingRef.current) setExitOpen(open) }}>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>退出开发者模式？</AlertDialogTitle><AlertDialogDescription>开发者和插件入口会隐藏，开放认识论将关闭；已安装插件及私有数据保留。</AlertDialogDescription></AlertDialogHeader>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <AlertDialogFooter><AlertDialogCancel disabled={saving}>取消</AlertDialogCancel><AlertDialogAction disabled={saving} onClick={(event) => { event.preventDefault(); void exitDeveloperMode() }}>{saving ? '关闭中…' : '确认退出'}</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
