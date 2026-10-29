/**
 * UsageSettings - 使用偏好页
 *
 * 承接使用中的高频开关，按场景分三个 section：
 * - 通知与声音：桌面通知、提示音与各场景音效
 * - 对话浏览：自动归档、消息悬浮置顶条、手动确认已读
 * - Agent 执行展示：自动预览修改中文件、输出完保持展开
 * - 输入体验：长文本粘贴转附件、Markdown 渲染、矮窗口紧凑输入框
 * - 语音输入：豆包流式语音输入（从原 Chat 工具页迁入）
 *
 * 从原「通用偏好」（GeneralSettings）拆分而来；系统级与环境配置保留在 GeneralSettings。
 */

import * as React from 'react'
import { useAtom, useSetAtom, useStore } from 'jotai'
import { Volume2, Plus, X, Music, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  SettingsSection,
  SettingsCard,
  SettingsRow,
  SettingsToggle,
  SettingsInput,
  SettingsSegmentedControl,
} from './primitives'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@profer/ui/primitives/select'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@profer/ui/primitives/dialog'
import { Input } from '@profer/ui/primitives/input'
import { Label } from '@profer/ui/primitives/label'
import {
  notificationsEnabledAtom,
  notificationSoundEnabledAtom,
  notificationSoundsAtom,
  customNotificationSoundsAtom,
  updateNotificationsEnabled,
  updateNotificationSoundEnabled,
  updateNotificationSound,
  playNotificationSound,
  playNotificationSoundAsync,
  addCustomNotificationSound,
  removeCustomNotificationSound,
  getAllNotificationSounds,
  BUILTIN_NOTIFICATION_SOUNDS,
  DEFAULT_NOTIFICATION_SOUNDS,
} from '@/atoms/notifications'
import type { NotificationSoundMeta } from '@/atoms/notifications'
import {
  showCreditsInSidebarAtom,
  updateShowCreditsInSidebar,
  stickyUserMessageEnabledAtom,
  updateStickyUserMessageEnabled,
  userMessagePositionAtom,
  longTextPasteAsAttachmentEnabledAtom,
  updateLongTextPasteAsAttachmentEnabled,
  richTextRenderingEnabledAtom,
  updateRichTextRenderingEnabled,
  smoothScrollEnabledAtom,
  updateSmoothScrollEnabled,
  smoothScrollForceAtom,
  updateSmoothScrollForce,
  previewOpenModeAtom,
  updatePreviewOpenMode,
  composerCompactModeAtom,
} from '@/atoms/ui-preferences'
import { showCurrentSessionSectionAtom } from '@/atoms/sidebar-atoms'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@profer/ui/primitives/alert-dialog'
import type { ComposerCompactModeSettings } from '@/atoms/ui-preferences'
import {
  COMPACT_MAX_HEIGHT_RANGE,
  COMPACT_MIN_HEIGHT_RANGE,
  COMPACT_VIEWPORT_HEIGHT_RANGE,
  COMPOSER_EDITOR_MIN_HEIGHT,
  COMPOSER_TIER_HEIGHTS,
  DEFAULT_COMPACT_MAX_HEIGHT,
  DEFAULT_COMPACT_MIN_HEIGHT,
  DEFAULT_COMPACT_VIEWPORT_HEIGHT,
  normalizeCompactMaxHeight,
  normalizeCompactMinHeight,
  normalizeCompactViewportHeight,
} from '@/lib/composer-compact-height'
import { useWindowInnerHeight } from '@/hooks/use-window-inner-height'
import {
  readSmoothWheelSamples,
  readSmoothWheelVersion,
  subscribeSmoothWheelSamples,
} from '@/lib/smooth-wheel-telemetry'
import { detectIsWindows } from '@profer/ui'
import { agentProcessGroupsKeepExpandedAtom } from '@/atoms/agent-atoms'
import { autoPreviewEnabledAtom } from '@/atoms/preview-atoms'
import { manualReadConfirmEnabledAtom, updateManualReadConfirmEnabled } from '@/atoms/agent-unread-settings'
import { applyUnreadModeTransition } from '@/lib/agent-unread-transition'
import type { AgentUnreadMode } from '@/lib/agent-unread-gate'
import { VoiceInputSettings } from './VoiceInputSettings'
import { Button } from '@profer/ui/primitives/button'
import type { NotificationSoundId, NotificationSoundType, NotificationSoundSettings, PreviewOpenMode } from '@/types/settings'

export function UsageSettings(): React.ReactElement {
  const [notificationsEnabled, setNotificationsEnabled] = useAtom(notificationsEnabledAtom)
  const [notificationSoundEnabled, setNotificationSoundEnabled] = useAtom(notificationSoundEnabledAtom)
  const [notificationSounds, setNotificationSounds] = useAtom(notificationSoundsAtom)
  const [customSounds, setCustomSounds] = useAtom(customNotificationSoundsAtom)
  const [showCreditsInSidebar, setShowCreditsInSidebar] = useAtom(showCreditsInSidebarAtom)
  const [showCurrentSessionSection, setShowCurrentSessionSection] = useAtom(showCurrentSessionSectionAtom)
  const [stickyUserMessageEnabled, setStickyUserMessageEnabled] = useAtom(stickyUserMessageEnabledAtom)
  const [smoothScrollEnabled, setSmoothScrollEnabled] = useAtom(smoothScrollEnabledAtom)
  const [smoothScrollForce, setSmoothScrollForce] = useAtom(smoothScrollForceAtom)
  const isWindows = React.useMemo(() => detectIsWindows(), [])
  const [userMessagePosition, setUserMessagePosition] = useAtom(userMessagePositionAtom)
  const [longTextPasteAsAttachmentEnabled, setLongTextPasteAsAttachmentEnabled] = useAtom(longTextPasteAsAttachmentEnabledAtom)
  const [richTextRenderingEnabled, setRichTextRenderingEnabled] = useAtom(richTextRenderingEnabledAtom)
  const [previewOpenMode, setPreviewOpenMode] = useAtom(previewOpenModeAtom)
  const [autoPreviewEnabled, setAutoPreviewEnabled] = useAtom(autoPreviewEnabledAtom)
  const [processGroupsKeepExpanded, setProcessGroupsKeepExpanded] = useAtom(agentProcessGroupsKeepExpandedAtom)
  // 「手动确认已读」开关：开启态未读需要用户确认才清除（见 `requirements.md` §3.2）。
  const [manualReadConfirmEnabled, setManualReadConfirmEnabled] = useAtom(manualReadConfirmEnabledAtom)
  const store = useStore()
  const setComposerCompactMode = useSetAtom(composerCompactModeAtom)
  // 「矮窗口压缩输入框」三个数值字段用本地字符串态：允许中途输入空值/非法值，失焦时归一化落盘
  const [compactViewportHeightDraft, setCompactViewportHeightDraft] = React.useState(String(DEFAULT_COMPACT_VIEWPORT_HEIGHT))
  const [compactMinHeightDraft, setCompactMinHeightDraft] = React.useState(String(DEFAULT_COMPACT_MIN_HEIGHT))
  const [compactMaxHeightDraft, setCompactMaxHeightDraft] = React.useState(String(DEFAULT_COMPACT_MAX_HEIGHT))
  // 实时窗口内高：直接告诉用户当前是否达到触发条件（窗口最大化时高度可能远高于阈值）
  const viewportHeight = useWindowInnerHeight()
  // 阈值草稿是否已触发紧凑档（仅用于文案提示；实际切换还带 60px 退出迟滞）
  const compactThresholdDraftNumber = Number(compactViewportHeightDraft.trim())
  const compactTriggered = Number.isFinite(compactThresholdDraftNumber)
    && compactThresholdDraftNumber > 0
    && viewportHeight < compactThresholdDraftNumber
  const [archiveAfterDays, setArchiveAfterDays] = React.useState<number>(7)
  const [archiveKeepRecent, setArchiveKeepRecent] = React.useState<number>(3)
  const [settingsLoading, setSettingsLoading] = React.useState(true)
  const [settingsError, setSettingsError] = React.useState<string | null>(null)
  const [compactErrors, setCompactErrors] = React.useState<Partial<Record<keyof ComposerCompactModeSettings, string>>>({})
  const [compactSaving, setCompactSaving] = React.useState<keyof ComposerCompactModeSettings | null>(null)
  const compactSavingRef = React.useRef(false)
  const [archiveSaving, setArchiveSaving] = React.useState(false)
  const [messagePositionSaving, setMessagePositionSaving] = React.useState(false)

  // 添加自定义音效弹窗状态
  const [addSoundOpen, setAddSoundOpen] = React.useState(false)
  const [addSoundLabel, setAddSoundLabel] = React.useState('')
  const [addSoundFilePath, setAddSoundFilePath] = React.useState<string | null>(null)
  const [addSoundValidating, setAddSoundValidating] = React.useState(false)
  const [removeSoundTarget, setRemoveSoundTarget] = React.useState<import('@/types/settings').CustomNotificationSound | null>(null)
  const [removingSound, setRemovingSound] = React.useState(false)
  const removingSoundRef = React.useRef(false)

  /** 处理音效文件选择 + 时长验证 */
  const handleSoundFilePick = React.useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    // 验证扩展名
    const ext = file.name.split('.').pop()?.toLowerCase()
    const allowedExts = ['mp3', 'wav', 'ogg', 'aac', 'm4a', 'flac', 'webm']
    if (!ext || !allowedExts.includes(ext)) {
      toast.error(`不支持的音频格式: ${ext ?? '未知'}。支持: ${allowedExts.join(', ')}`)
      e.target.value = ''
      return
    }

    setAddSoundValidating(true)

    // 用 Audio API 解码验证时长 ≤ 10s
    const audio = new Audio()
    const objectUrl = URL.createObjectURL(file)
    audio.src = objectUrl

    const cleanup = () => {
      URL.revokeObjectURL(objectUrl)
      setAddSoundValidating(false)
    }

    let sourcePath: string
    try {
      sourcePath = window.electronAPI.getPathForFile(file)
    } catch {
      toast.error('无法获取文件路径，请重试')
      cleanup()
      e.target.value = ''
      return
    }

    audio.addEventListener('loadedmetadata', () => {
      if (audio.duration > 10) {
        toast.error(`音效时长不能超过 10 秒（当前 ${audio.duration.toFixed(1)}s）`)
        cleanup()
        e.target.value = ''
        return
      }
      setAddSoundFilePath(sourcePath)
      setAddSoundLabel(file.name.replace(/\.[^.]+$/, '')) // 默认名 = 文件名去扩展名
      cleanup()
    })

    audio.addEventListener('error', () => {
      toast.error('无法解析该音频文件，请确认文件未损坏')
      cleanup()
      e.target.value = ''
    })
  }, [])

  /** 确认添加自定义音效 */
  const handleAddSoundConfirm = React.useCallback(async () => {
    if (!addSoundFilePath) return
    const label = addSoundLabel.trim()
    if (!label) {
      toast.error('请输入音效名称')
      return
    }
    try {
      const sound = await addCustomNotificationSound(addSoundFilePath, label)
      setCustomSounds((prev) => [...prev, sound])
      toast.success(`已添加自定义音效: ${label}`)
      // 重置状态
      setAddSoundOpen(false)
      setAddSoundFilePath(null)
      setAddSoundLabel('')
    } catch (err) {
      console.error('[使用偏好] 添加自定义音效失败:', err)
      toast.error('添加音效失败，请重试')
    }
  }, [addSoundFilePath, addSoundLabel, setCustomSounds])

  /** 删除自定义音效 */
  const handleRemoveCustomSound = React.useCallback(async () => {
    if (!removeSoundTarget || removingSoundRef.current) return
    const id = removeSoundTarget.id
    removingSoundRef.current = true
    setRemovingSound(true)
    try {
      const result = await removeCustomNotificationSound(id, notificationSounds, customSounds)
      setCustomSounds(result.customSounds)
      setNotificationSounds(result.sounds)
      toast.success('已删除自定义音效')
      setRemoveSoundTarget(null)
    } catch (err) {
      console.error('[使用偏好] 删除自定义音效失败:', err)
      toast.error('删除失败，请重试')
    } finally {
      removingSoundRef.current = false
      setRemovingSound(false)
    }
  }, [removeSoundTarget, notificationSounds, customSounds, setCustomSounds, setNotificationSounds])

  /** 所有可用音效列表（内置 + 自定义） */
  const allSounds = React.useMemo(
    () => getAllNotificationSounds(customSounds),
    [customSounds]
  )

  // 加载设置
  const loadSettings = React.useCallback(async (): Promise<void> => {
    setSettingsLoading(true)
    setSettingsError(null)
    try {
      const settings = await window.electronAPI.getSettings()
      setArchiveAfterDays(settings.archiveAfterDays ?? 7)
      setArchiveKeepRecent(settings.archiveKeepRecentPerWorkspace ?? 3)
      setUserMessagePosition(settings.userMessagePosition === 'left' ? 'left' : 'right')
      setPreviewOpenMode(settings.previewModePreference === 'split' ? 'split' : 'tab')
      setCompactViewportHeightDraft(String(normalizeCompactViewportHeight(settings.inputCompactViewportHeight)))
      setCompactMinHeightDraft(String(normalizeCompactMinHeight(settings.inputCompactMinHeight)))
      setCompactMaxHeightDraft(String(normalizeCompactMaxHeight(settings.inputCompactMaxHeight)))
    } catch (error) {
      console.error('[使用偏好] 加载设置失败:', error)
      setSettingsError('使用偏好加载失败，请重试后再修改归档与高度设置')
    } finally {
      setSettingsLoading(false)
    }
  }, [])
  React.useEffect(() => { void loadSettings() }, [loadSettings])

  /** 切换文件预览打开方式：先更新本地态保证交互即时，再落盘。 */
  const handlePreviewOpenModeChange = (value: string): void => {
    const mode: PreviewOpenMode = value === 'split' ? 'split' : 'tab'
    setPreviewOpenMode(mode)
    void updatePreviewOpenMode(mode)
  }

  /** 保存用户消息位置；失败时恢复当前布局，避免设置看似成功但未落盘。 */
  const handleUserMessagePositionChange = async (value: string): Promise<void> => {
    if (!['left', 'right'].includes(value) || settingsLoading || Boolean(settingsError) || messagePositionSaving) return
    const position = value as 'left' | 'right'
    const previous = userMessagePosition
    setMessagePositionSaving(true)
    setUserMessagePosition(position)
    try {
      await window.electronAPI.updateSettings({ userMessagePosition: position })
    } catch (error) {
      console.error('[使用偏好] 更新用户消息位置失败:', error)
      setUserMessagePosition(previous)
      toast.error('用户消息位置保存失败，请重试')
    } finally {
      setMessagePositionSaving(false)
    }
  }

  // 绕过会吞错的旧 helper：落盘成功才更新全局显示，失败保留原草稿以便失焦重试。
  const saveCompactHeight = async (field: keyof ComposerCompactModeSettings, value: number, commitDraft: (value: string) => void): Promise<void> => {
    if (settingsLoading || settingsError || compactSavingRef.current) return
    compactSavingRef.current = true
    setCompactSaving(field)
    try {
      const keys = { viewportHeight: 'inputCompactViewportHeight', minHeight: 'inputCompactMinHeight', maxHeight: 'inputCompactMaxHeight' } as const
      await window.electronAPI.updateSettings({ [keys[field]]: value })
      commitDraft(String(value))
      setComposerCompactMode((previous) => ({ ...previous, [field]: value }))
      setCompactErrors((previous) => ({ ...previous, [field]: undefined }))
    } catch (error) {
      console.error('[使用偏好] 保存紧凑高度失败:', error)
      setCompactErrors((previous) => ({ ...previous, [field]: '保存失败，输入已保留，请重新失焦重试' }))
      toast.error('输入框高度保存失败，请重试')
    } finally {
      compactSavingRef.current = false
      setCompactSaving(null)
    }
  }

  /**
   * 保存「触发窗口高度」（失焦时归一化落盘）。
   * 空输入视为回退默认；0 是合法值，表示关闭紧凑档。
   */
  const handleCompactViewportHeightBlur = async (): Promise<void> => {
    const raw = compactViewportHeightDraft.trim()
    const normalized = normalizeCompactViewportHeight(raw === '' ? undefined : Number(raw))
    await saveCompactHeight('viewportHeight', normalized, setCompactViewportHeightDraft)
  }

  /** 保存「紧凑档输入框最小高度」（失焦时归一化落盘）。 */
  const handleCompactMinHeightBlur = async (): Promise<void> => {
    const raw = compactMinHeightDraft.trim()
    const normalized = normalizeCompactMinHeight(raw === '' ? undefined : Number(raw))
    await saveCompactHeight('minHeight', normalized, setCompactMinHeightDraft)
  }

  /** 保存「紧凑档输入框上限」（失焦时归一化落盘）。 */
  const handleCompactMaxHeightBlur = async (): Promise<void> => {
    const raw = compactMaxHeightDraft.trim()
    const normalized = normalizeCompactMaxHeight(raw === '' ? undefined : Number(raw))
    await saveCompactHeight('maxHeight', normalized, setCompactMaxHeightDraft)
  }

  /** 更新归档天数 */
  const handleArchiveDaysChange = async (value: string): Promise<void> => {
    if (settingsLoading || settingsError || archiveSaving) return
    const days = parseInt(value, 10)
    if (![0, 7, 14, 30, 60].includes(days)) return
    setArchiveSaving(true)
    try {
      await window.electronAPI.updateSettings({ archiveAfterDays: days })
      setArchiveAfterDays(days)
    } catch (error) {
      console.error('[使用偏好] 更新归档天数失败:', error)
      toast.error('自动归档设置保存失败，请重试')
    } finally {
      setArchiveSaving(false)
    }
  }

  /** 更新每个工作区的保留会话数 */
  const handleArchiveKeepRecentChange = async (value: string): Promise<void> => {
    if (settingsLoading || settingsError || archiveSaving) return
    const keep = parseInt(value, 10)
    if (![0, 1, 3, 5, 10].includes(keep)) return
    const previous = archiveKeepRecent
    setArchiveSaving(true)
    setArchiveKeepRecent(keep)
    try {
      await window.electronAPI.updateSettings({ archiveKeepRecentPerWorkspace: keep })
    } catch (error) {
      console.error('[使用偏好] 更新保留会话数失败:', error)
      setArchiveKeepRecent(previous)
      toast.error('保留会话数保存失败，请重试')
    } finally {
      setArchiveSaving(false)
    }
  }

  /**
   * 切换「手动确认已读」。
   *
   * 开关本身先落盘（失败回滚），再做一次两向未读迁移：关 → 开补写持久化未读、
   * 开 → 关回填内存集合，两向都不清理未读（对应 `requirements.md` §6 U-1）。
   * 主进程读的是同步更新的设置缓存，因此无需重启，下一帧即按新模式生效。
   */
  const handleManualReadConfirmToggle = async (enabled: boolean): Promise<void> => {
    const from: AgentUnreadMode = manualReadConfirmEnabled ? 'manual' : 'auto'
    const to: AgentUnreadMode = enabled ? 'manual' : 'auto'
    try {
      await updateManualReadConfirmEnabled(enabled, setManualReadConfirmEnabled)
    } catch (error) {
      console.error('[使用偏好] 更新「手动确认已读」失败:', error)
      toast.error('更新「手动确认已读」失败')
      return
    }
    await applyUnreadModeTransition({ from, to, get: store.get, set: store.set })
  }

  return (
    <div className="space-y-6">
      {settingsError && (
        <div role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
          <p>{settingsError}</p>
          <Button type="button" variant="outline" size="sm" onClick={() => { void loadSettings() }}>重试加载</Button>
        </div>
      )}
      <SettingsSection
        title="通知与声音"
        description="设置任务完成和需要你处理时的提醒方式"
      >
        <SettingsCard>
          <SettingsToggle
            label="桌面通知"
            description="Agent 完成任务或需要操作时发送通知"
            checked={notificationsEnabled}
            onCheckedChange={(checked) => {
              setNotificationsEnabled(checked)
              updateNotificationsEnabled(checked)
            }}
          />
          <SettingsToggle
            label="通知提示音"
            description="阻塞操作（权限确认、问题回答、计划审批）触发时播放提示音"
            checked={notificationSoundEnabled}
            disabled={!notificationsEnabled}
            onCheckedChange={(checked) => {
              setNotificationSoundEnabled(checked)
              updateNotificationSoundEnabled(checked)
            }}
          />
          <SoundPicker
            label="任务完成音效"
            type="taskComplete"
            sounds={notificationSounds}
            allSounds={allSounds}
            customSounds={customSounds}
            disabled={!notificationsEnabled || !notificationSoundEnabled}
            onSoundChange={async (type, soundId) => {
              const newSounds = await updateNotificationSound(type, soundId, notificationSounds)
              setNotificationSounds(newSounds)
            }}
            onAddSound={() => {
              setAddSoundFilePath(null)
              setAddSoundLabel('')
              setAddSoundOpen(true)
            }}
            onRemoveSound={(id) => setRemoveSoundTarget(customSounds.find((sound) => sound.id === id) ?? null)}
          />
          <SoundPicker
            label="权限审批音效"
            type="permissionRequest"
            sounds={notificationSounds}
            allSounds={allSounds}
            customSounds={customSounds}
            disabled={!notificationsEnabled || !notificationSoundEnabled}
            onSoundChange={async (type, soundId) => {
              const newSounds = await updateNotificationSound(type, soundId, notificationSounds)
              setNotificationSounds(newSounds)
            }}
            onAddSound={() => {
              setAddSoundFilePath(null)
              setAddSoundLabel('')
              setAddSoundOpen(true)
            }}
            onRemoveSound={(id) => setRemoveSoundTarget(customSounds.find((sound) => sound.id === id) ?? null)}
          />
          <SoundPicker
            label="计划审批音效"
            type="exitPlanMode"
            sounds={notificationSounds}
            allSounds={allSounds}
            customSounds={customSounds}
            disabled={!notificationsEnabled || !notificationSoundEnabled}
            onSoundChange={async (type, soundId) => {
              const newSounds = await updateNotificationSound(type, soundId, notificationSounds)
              setNotificationSounds(newSounds)
            }}
            onAddSound={() => {
              setAddSoundFilePath(null)
              setAddSoundLabel('')
              setAddSoundOpen(true)
            }}
            onRemoveSound={(id) => setRemoveSoundTarget(customSounds.find((sound) => sound.id === id) ?? null)}
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title="对话浏览"
        description="控制会话列表与对话阅读体验"
      >
        <SettingsCard>
          <SettingsRow
            label="自动归档"
            description="超过指定天数未更新的会话将从列表里收纳起来（置顶、进行中、有未完成任务的除外）。归档只改变显示与排序，不释放磁盘空间；需要回收请到「数据管理 → 存储用量」。"
          >
            <Select disabled={settingsLoading || Boolean(settingsError) || archiveSaving} value={String(archiveAfterDays)} onValueChange={handleArchiveDaysChange}>
              <SelectTrigger aria-label="自动归档" className="w-[120px] h-8 text-[13px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="0">禁用</SelectItem>
                <SelectItem value="7">7 天</SelectItem>
                <SelectItem value="14">14 天</SelectItem>
                <SelectItem value="30">30 天</SelectItem>
                <SelectItem value="60">60 天</SelectItem>
              </SelectContent>
            </Select>
          </SettingsRow>
          <SettingsRow
            label="每个工作区保留"
            description="按最后活跃时间保留最近若干个会话，这些会话即使超时也不会自动归档；定时任务、委派子会话不占名额"
          >
            <Select disabled={settingsLoading || Boolean(settingsError) || archiveSaving} value={String(archiveKeepRecent)} onValueChange={handleArchiveKeepRecentChange}>
              <SelectTrigger aria-label="每个工作区保留会话数" className="w-[120px] h-8 text-[13px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="0">不保留</SelectItem>
                <SelectItem value="1">1 个</SelectItem>
                <SelectItem value="3">3 个</SelectItem>
                <SelectItem value="5">5 个</SelectItem>
                <SelectItem value="10">10 个</SelectItem>
              </SelectContent>
            </Select>
          </SettingsRow>
          <SettingsToggle
            label="显示「当前会话」区域"
            description="在左侧栏顶部列出已打开的会话入口；关闭后会话仍保留在对话 / 项目列表中"
            checked={showCurrentSessionSection}
            onCheckedChange={setShowCurrentSessionSection}
          />
          <SettingsToggle
            label="侧栏显示我的积分"
            description="关闭后隐藏左侧栏底部的积分余额条，不影响积分与用量页面"
            checked={showCreditsInSidebar}
            onCheckedChange={(checked) => {
              setShowCreditsInSidebar(checked)
              void updateShowCreditsInSidebar(checked)
            }}
          />
          <SettingsToggle
            label="消息悬浮置顶条"
            description="滚动浏览对话时，在顶部显示最近的用户消息摘要"
            checked={stickyUserMessageEnabled}
            onCheckedChange={(checked) => {
              setStickyUserMessageEnabled(checked)
              updateStickyUserMessageEnabled(checked)
            }}
          />
          {isWindows && (
            <SettingsToggle
              label="平滑滚动"
              description="默认关闭，滚轮交给 Chromium 合成器线程，最顺也最省主线程。开启后用自绘弹簧接管鼠标滚轮的离散刻度，补上 macOS 那样的速度加速与惯性（连转更快、停手自然减速）；代价是滚动改为逐帧写主线程，流式输出或长会话重负载时可能比关闭更卡。触控板、高精度滚轮与 Ctrl+滚轮缩放不受影响。"
              checked={smoothScrollEnabled}
              onCheckedChange={(checked) => {
                setSmoothScrollEnabled(checked)
                void updateSmoothScrollEnabled(checked)
              }}
            />
          )}
          {isWindows && smoothScrollEnabled && (
            <SettingsToggle
              label="强制接管触控板与高精度滚轮"
              description="默认只接管鼠标滚轮的离散刻度；自带平滑滚动的驱动（Logitech 等）与触控板会被判定为像素级输入、原样交还浏览器。打开后这类输入也走弹簧曲线（更硬的刚度、不做加速），触控板本身已连续，可能反而更黏。"
              checked={smoothScrollForce}
              onCheckedChange={(checked) => {
                setSmoothScrollForce(checked)
                void updateSmoothScrollForce(checked)
              }}
            />
          )}
          {isWindows && (
            <details className="px-4 py-3">
              <summary className="cursor-pointer select-none text-[13px] text-muted-foreground">滚动诊断</summary>
              <SmoothScrollDiagnostics enabled={smoothScrollEnabled} force={smoothScrollForce} />
            </details>
          )}
          <SettingsSegmentedControl
            label="用户消息位置"
            description="选择用户头像、用户名和消息气泡显示在对话的哪一侧"
            value={userMessagePosition}
            onValueChange={(value) => { void handleUserMessagePositionChange(value) }}
            options={[{ value: 'left', label: '左侧' }, { value: 'right', label: '右侧' }]}
            disabled={settingsLoading || Boolean(settingsError) || messagePositionSaving}
          />
          <SettingsToggle
            label="手动确认已读"
            description="开启后会话完成即产生未读（即使你正在看），打开或切换标签页不再自动清除；在最新一轮回复操作栏点「确认已读」，或用侧边栏会话菜单切换。关闭时保持现有行为。"
            checked={manualReadConfirmEnabled}
            onCheckedChange={(checked) => { void handleManualReadConfirmToggle(checked) }}
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title="Agent 执行展示"
        description="控制 Agent 修改文件和输出过程的展示行为"
      >
        <SettingsCard divided>
          <SettingsToggle
            label="自动预览修改中文件"
            description="Agent 编辑文件时自动在右侧打开预览"
            checked={autoPreviewEnabled}
            onCheckedChange={setAutoPreviewEnabled}
          />
          <SettingsSegmentedControl
            label="预览打开方式"
            description="「独立标签页」把文件预览开成一个单独的标签页；「与对话分屏」让预览标签自动与所属会话左右并排，边看文件边对话。仅影响你主动打开的预览；Agent 自动预览的跟随行为不变。"
            value={previewOpenMode}
            onValueChange={handlePreviewOpenModeChange}
            options={[{ value: 'tab', label: '独立标签页' }, { value: 'split', label: '与对话分屏' }]}
            disabled={settingsLoading || Boolean(settingsError)}
          />
          <SettingsToggle
            label="输出完保持展开"
            description="Agent 完成输出后保留过程组展开，方便回看执行细节"
            checked={processGroupsKeepExpanded}
            onCheckedChange={setProcessGroupsKeepExpanded}
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title="输入体验"
        description="控制输入框的粘贴、渲染和高度行为"
      >
        <SettingsCard>
          <SettingsToggle
            label="长文本粘贴转附件"
            description="开启后，输入框粘贴超过 2000 字的文本会自动生成可预览编辑的附件"
            checked={longTextPasteAsAttachmentEnabled}
            onCheckedChange={(checked) => {
              setLongTextPasteAsAttachmentEnabled(checked)
              updateLongTextPasteAsAttachmentEnabled(checked)
            }}
          />
          <SettingsToggle
            label="输入框 Markdown 渲染"
            description="开启后，输入框中的 Markdown 语法（如 **粗体**、# 标题）会实时渲染为富文本；关闭后为纯文本模式，保留 @ 引用等功能"
            checked={richTextRenderingEnabled}
            onCheckedChange={(checked) => {
              setRichTextRenderingEnabled(checked)
              updateRichTextRenderingEnabled(checked)
            }}
          />
          <SettingsInput
            label="矮窗口压缩输入框"
            description={`窗口内高（px，${COMPACT_VIEWPORT_HEIGHT_RANGE.min}–${COMPACT_VIEWPORT_HEIGHT_RANGE.max}）低于该值时输入框整体变矮，给消息区让出空间；0 = 关闭。默认 ${DEFAULT_COMPACT_VIEWPORT_HEIGHT}。当前窗口内高 ${viewportHeight}px${compactTriggered ? '，已进入紧凑档' : '，未触发'}（退出需回到阈值 + 60px 以上）`}
            type="number"
            value={compactViewportHeightDraft}
            disabled={settingsLoading || Boolean(settingsError) || compactSaving !== null}
            error={compactErrors.viewportHeight}
            onChange={setCompactViewportHeightDraft}
            onBlur={handleCompactViewportHeightBlur}
            placeholder={String(DEFAULT_COMPACT_VIEWPORT_HEIGHT)}
          />
          <SettingsInput
            label="紧凑档输入框高度"
            description={`紧凑档下输入框空内容时的高度（px，${COMPACT_MIN_HEIGHT_RANGE.min}–${COMPACT_MIN_HEIGHT_RANGE.max}）；常规为 ${COMPOSER_EDITOR_MIN_HEIGHT}，默认压到 ${DEFAULT_COMPACT_MIN_HEIGHT}（变矮约 ${COMPOSER_EDITOR_MIN_HEIGHT - DEFAULT_COMPACT_MIN_HEIGHT}px）。这就是“看得见”的变矮量`}
            type="number"
            value={compactMinHeightDraft}
            disabled={settingsLoading || Boolean(settingsError) || compactSaving !== null}
            error={compactErrors.minHeight}
            onChange={setCompactMinHeightDraft}
            onBlur={handleCompactMinHeightBlur}
            placeholder={String(DEFAULT_COMPACT_MIN_HEIGHT)}
          />
          <SettingsInput
            label="紧凑档输入框上限"
            description={`紧凑档下输入框最大高度（px，${COMPACT_MAX_HEIGHT_RANGE.min}–${COMPACT_MAX_HEIGHT_RANGE.max}）；输入超过 5 行时的展开档为该值的 2 倍（不超过 ${COMPOSER_TIER_HEIGHTS.expanded}）。默认 ${DEFAULT_COMPACT_MAX_HEIGHT}`}
            type="number"
            value={compactMaxHeightDraft}
            disabled={settingsLoading || Boolean(settingsError) || compactSaving !== null}
            error={compactErrors.maxHeight}
            onChange={setCompactMaxHeightDraft}
            onBlur={handleCompactMaxHeightBlur}
            placeholder={String(DEFAULT_COMPACT_MAX_HEIGHT)}
          />
        </SettingsCard>
      </SettingsSection>

      {/* 语音输入（豆包流式）：从原 Chat 工具页迁入，属输入体验 */}
      <VoiceInputSettings />

      {/* 添加自定义音效弹窗 */}
      <AddSoundDialog
        open={addSoundOpen}
        onOpenChange={setAddSoundOpen}
        filePath={addSoundFilePath}
        label={addSoundLabel}
        onLabelChange={setAddSoundLabel}
        validating={addSoundValidating}
        onFilePick={handleSoundFilePick}
        onConfirm={handleAddSoundConfirm}
      />
      <AlertDialog open={removeSoundTarget !== null} onOpenChange={(open) => { if (!open && !removingSoundRef.current) setRemoveSoundTarget(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除自定义音效？</AlertDialogTitle>
            <AlertDialogDescription>将删除「{removeSoundTarget?.label}」，此操作无法撤销。使用此音效的通知将恢复为默认音效。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removingSound}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={removingSound}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(event) => { event.preventDefault(); void handleRemoveCustomSound() }}
            >{removingSound ? '删除中…' : '删除音效'}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

// ===== SoundPicker 内部组件 =====

interface SoundPickerProps {
  label: string
  type: NotificationSoundType
  sounds: NotificationSoundSettings
  allSounds: NotificationSoundMeta[]
  customSounds: import('@/types/settings').CustomNotificationSound[]
  disabled: boolean
  onSoundChange: (type: NotificationSoundType, soundId: NotificationSoundId) => void
  onAddSound: () => void
  onRemoveSound: (id: string) => void
}

/** 单个场景的通知音选择器（下拉 + 试听按钮 + 自定义音效） */
function SoundPicker({
  label,
  type,
  sounds,
  allSounds,
  customSounds,
  disabled,
  onSoundChange,
  onAddSound,
  onRemoveSound,
}: SoundPickerProps): React.ReactElement {
  const currentId = sounds[type] ?? DEFAULT_NOTIFICATION_SOUNDS[type]
  const currentIsCustom = !!(customSounds.length > 0 && customSounds.some((s) => s.id === currentId))

  /** 播放当前音效（支持自定义音效） */
  const handlePreview = React.useCallback(async () => {
    if (currentId === 'none') return
    if (currentIsCustom) {
      await playNotificationSoundAsync(currentId, customSounds)
    } else {
      playNotificationSound(currentId)
    }
  }, [currentId, currentIsCustom, customSounds])

  return (
    <SettingsRow label={label}>
      <div className="flex items-center gap-1.5">
        <Select
          value={currentId}
          onValueChange={(value) => {
            if (value === '__add__') {
              onAddSound()
              return
            }
            onSoundChange(type, value as NotificationSoundId)
          }}
          disabled={disabled}
        >
          <SelectTrigger aria-label={label} className="w-[130px] h-8 text-[13px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {/* 内置音效 */}
            {BUILTIN_NOTIFICATION_SOUNDS.map((s) => (
              <SelectItem key={s.id} value={s.id}>{s.label}</SelectItem>
            ))}
            {/* 分隔线 + 自定义音效 */}
            {customSounds.length > 0 && (
              <>
                <div className="h-px bg-border mx-1.5 my-1" />
                {allSounds.filter((s) => s.isCustom).map((s) => (
                  <div key={s.id} className="flex items-center justify-between pr-1">
                    <SelectItem value={s.id} className="flex-1">
                      {s.label}
                    </SelectItem>
                    <button
                      type="button"
                      aria-label={`删除音效${s.label}`}
                      className="h-5 w-5 shrink-0 rounded text-muted-foreground/60 hover:text-destructive hover:bg-destructive/10 flex items-center justify-center"
                      onClick={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        onRemoveSound(s.id)
                      }}
                      title="删除此音效"
                    >
                      <X size={11} />
                    </button>
                  </div>
                ))}
              </>
            )}
            <div className="h-px bg-border mx-1.5 my-1" />
            <SelectItem value="none">无</SelectItem>
            {/* 添加音效 */}
            <div className="h-px bg-border mx-1.5 my-1" />
            <button
              type="button"
              className="w-full flex items-center gap-1.5 px-2 py-1.5 text-[13px] text-muted-foreground hover:text-foreground hover:bg-accent rounded-sm transition-colors cursor-pointer"
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                onAddSound()
              }}
            >
              <Plus size={13} />
              添加音效
            </button>
          </SelectContent>
        </Select>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0"
          disabled={disabled || currentId === 'none'}
          onClick={handlePreview}
          title="试听"
          aria-label={`试听${label}`}
        >
          <Volume2 size={14} />
        </Button>
      </div>
    </SettingsRow>
  )
}

// ===== AddSoundDialog =====

/** 添加自定义音效弹窗 */
function AddSoundDialog({
  open,
  onOpenChange,
  filePath,
  label,
  onLabelChange,
  validating,
  onFilePick,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  filePath: string | null
  label: string
  onLabelChange: (label: string) => void
  validating: boolean
  onFilePick: (e: React.ChangeEvent<HTMLInputElement>) => void
  onConfirm: () => void
}): React.ReactElement {
  const fileInputRef = React.useRef<HTMLInputElement>(null)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[380px]">
        <DialogHeader>
          <DialogTitle>添加自定义音效</DialogTitle>
          <DialogDescription>
            选择一个音频文件（最长 10 秒），支持的格式: mp3, wav, ogg, aac, m4a, flac, webm
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 pt-2">
          {/* 文件选择 */}
          <div className="space-y-1.5">
            <Label htmlFor="custom-sound-file">音频文件</Label>
            <input
              id="custom-sound-file"
              ref={fileInputRef}
              type="file"
              accept="audio/mp3,audio/wav,audio/ogg,audio/aac,audio/m4a,audio/flac,audio/webm,.mp3,.wav,.ogg,.aac,.m4a,.flac,.webm"
              className="hidden"
              onChange={onFilePick}
            />
            <Button
              variant="outline"
              className="w-full h-9 text-[13px] gap-2"
              disabled={validating}
              onClick={() => fileInputRef.current?.click()}
            >
              {validating ? (
                <>
                  <Loader2 size={14} className="animate-spin" />
                  验证中...
                </>
              ) : (
                <>
                  <Music size={14} />
                  {filePath ? filePath.split(/[/\\]/).pop() ?? filePath : '选择音频文件...'}
                </>
              )}
            </Button>
          </div>

          {/* 名称输入 */}
          <div className="space-y-1.5">
            <Label htmlFor="sound-label">音效名称</Label>
            <Input
              id="sound-label"
              value={label}
              onChange={(e) => onLabelChange(e.target.value)}
              placeholder="例如: 我的提示音"
              maxLength={30}
              className="h-9 text-[13px]"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && label.trim() && filePath) onConfirm()
              }}
            />
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <Button
              variant="ghost"
              size="sm"
              className="text-[13px]"
              onClick={() => onOpenChange(false)}
            >
              取消
            </Button>
            <Button
              size="sm"
              className="text-[13px]"
              disabled={!filePath || !label.trim() || validating}
              onClick={onConfirm}
            >
              添加
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/**
 * 平滑滚动诊断读数
 *
 * 滚轮没反应时先看这里：判定成「像素」说明设备是触控板/高精度滚轮（直通原生）；
 * 「未接管」但判定是「刻度」说明没找到可滚动容器；帧间隔明显高于 16.7ms 说明
 * 接管了但主线程跟不上，观感会不如原生。
 */
function SmoothScrollDiagnostics({ enabled, force }: { enabled: boolean; force: boolean }): React.ReactElement {
  React.useSyncExternalStore(subscribeSmoothWheelSamples, readSmoothWheelVersion)
  const samples = readSmoothWheelSamples()
  const reducedMotion = React.useMemo(
    () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
    [],
  )
  const latest = samples[samples.length - 1]

  return (
    <div className="mt-2 space-y-2 rounded-lg border border-border/60 bg-muted/20 p-3 text-[12px]">
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
        <span>监听：{enabled ? `已启用（强制接管${force ? '开' : '关'}）` : '已关闭'}</span>
        <span>减少动效：{reducedMotion ? '开（不接管）' : '关'}</span>
        {latest?.frameMs != null && (
          <span>
            上段动画帧间隔 {latest.frameMs.toFixed(1)}ms
            {latest.slowFrames > 0 ? ` · 掉帧 ${latest.slowFrames}` : ''}
          </span>
        )}
      </div>
      {samples.length === 0 ? (
        <p className="text-muted-foreground">把鼠标移到消息区滚一下，这里会显示最近 6 次滚轮事件。</p>
      ) : (
        <ul className="space-y-0.5 font-mono text-[11px] leading-5">
          {[...samples].reverse().map((sample, index) => (
            <li key={`${sample.at}-${index}`} className="truncate">
              Δy {Math.round(sample.deltaY)} · mode {sample.deltaMode} · {sample.gesture === 'tick' ? '刻度' : sample.forced ? '像素·强制' : '像素'} · {sample.handled ? `已接管 ${sample.scroller ?? ''}` : '未接管'}
              {sample.gapMs < 1000 ? ` · 间隔 ${Math.round(sample.gapMs)}ms` : ''}
            </li>
          ))}
        </ul>
      )}
      <p className="text-muted-foreground">
        一直显示「像素 · 未接管」= 当前设备是触控板或高精度滚轮，这类输入本身连续，会直通原生。
      </p>
    </div>
  )
}
