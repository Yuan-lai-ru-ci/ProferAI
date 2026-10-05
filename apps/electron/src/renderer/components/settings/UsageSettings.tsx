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
  longTextPasteAsAttachmentEnabledAtom,
  updateLongTextPasteAsAttachmentEnabled,
  richTextRenderingEnabledAtom,
  updateRichTextRenderingEnabled,
  composerCompactModeAtom,
  updateComposerCompactMode,
} from '@/atoms/ui-preferences'
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
import { agentProcessGroupsKeepExpandedAtom } from '@/atoms/agent-atoms'
import { autoPreviewEnabledAtom } from '@/atoms/preview-atoms'
import { manualReadConfirmEnabledAtom, updateManualReadConfirmEnabled } from '@/atoms/agent-unread-settings'
import { applyUnreadModeTransition } from '@/lib/agent-unread-transition'
import type { AgentUnreadMode } from '@/lib/agent-unread-gate'
import { VoiceInputSettings } from './VoiceInputSettings'
import { Button } from '@profer/ui/primitives/button'
import type { NotificationSoundId, NotificationSoundType, NotificationSoundSettings } from '@/types/settings'

export function UsageSettings(): React.ReactElement {
  const [notificationsEnabled, setNotificationsEnabled] = useAtom(notificationsEnabledAtom)
  const [notificationSoundEnabled, setNotificationSoundEnabled] = useAtom(notificationSoundEnabledAtom)
  const [notificationSounds, setNotificationSounds] = useAtom(notificationSoundsAtom)
  const [customSounds, setCustomSounds] = useAtom(customNotificationSoundsAtom)
  const [showCreditsInSidebar, setShowCreditsInSidebar] = useAtom(showCreditsInSidebarAtom)
  const [stickyUserMessageEnabled, setStickyUserMessageEnabled] = useAtom(stickyUserMessageEnabledAtom)
  const [longTextPasteAsAttachmentEnabled, setLongTextPasteAsAttachmentEnabled] = useAtom(longTextPasteAsAttachmentEnabledAtom)
  const [richTextRenderingEnabled, setRichTextRenderingEnabled] = useAtom(richTextRenderingEnabledAtom)
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

  // 添加自定义音效弹窗状态
  const [addSoundOpen, setAddSoundOpen] = React.useState(false)
  const [addSoundLabel, setAddSoundLabel] = React.useState('')
  const [addSoundFilePath, setAddSoundFilePath] = React.useState<string | null>(null)
  const [addSoundValidating, setAddSoundValidating] = React.useState(false)

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
  const handleRemoveCustomSound = React.useCallback(async (id: string) => {
    try {
      const result = await removeCustomNotificationSound(id, notificationSounds, customSounds)
      setCustomSounds(result.customSounds)
      setNotificationSounds(result.sounds)
      toast.success('已删除自定义音效')
    } catch (err) {
      console.error('[使用偏好] 删除自定义音效失败:', err)
      toast.error('删除失败，请重试')
    }
  }, [notificationSounds, customSounds, setCustomSounds, setNotificationSounds])

  /** 所有可用音效列表（内置 + 自定义） */
  const allSounds = React.useMemo(
    () => getAllNotificationSounds(customSounds),
    [customSounds]
  )

  // 加载设置
  React.useEffect(() => {
    window.electronAPI.getSettings().then((settings) => {
      setArchiveAfterDays(settings.archiveAfterDays ?? 7)
      setCompactViewportHeightDraft(String(normalizeCompactViewportHeight(settings.inputCompactViewportHeight)))
      setCompactMinHeightDraft(String(normalizeCompactMinHeight(settings.inputCompactMinHeight)))
      setCompactMaxHeightDraft(String(normalizeCompactMaxHeight(settings.inputCompactMaxHeight)))
    }).catch(console.error)
  }, [])

  /**
   * 保存「触发窗口高度」（失焦时归一化落盘）。
   * 空输入视为回退默认；0 是合法值，表示关闭紧凑档。
   */
  const handleCompactViewportHeightBlur = async (): Promise<void> => {
    const raw = compactViewportHeightDraft.trim()
    const normalized = normalizeCompactViewportHeight(raw === '' ? undefined : Number(raw))
    setCompactViewportHeightDraft(String(normalized))
    setComposerCompactMode((prev) => ({ ...prev, viewportHeight: normalized }))
    await updateComposerCompactMode({ viewportHeight: normalized })
  }

  /** 保存「紧凑档输入框最小高度」（失焦时归一化落盘）。 */
  const handleCompactMinHeightBlur = async (): Promise<void> => {
    const raw = compactMinHeightDraft.trim()
    const normalized = normalizeCompactMinHeight(raw === '' ? undefined : Number(raw))
    setCompactMinHeightDraft(String(normalized))
    setComposerCompactMode((prev) => ({ ...prev, minHeight: normalized }))
    await updateComposerCompactMode({ minHeight: normalized })
  }

  /** 保存「紧凑档输入框上限」（失焦时归一化落盘）。 */
  const handleCompactMaxHeightBlur = async (): Promise<void> => {
    const raw = compactMaxHeightDraft.trim()
    const normalized = normalizeCompactMaxHeight(raw === '' ? undefined : Number(raw))
    setCompactMaxHeightDraft(String(normalized))
    setComposerCompactMode((prev) => ({ ...prev, maxHeight: normalized }))
    await updateComposerCompactMode({ maxHeight: normalized })
  }

  /** 更新归档天数 */
  const handleArchiveDaysChange = async (value: string): Promise<void> => {
    const days = parseInt(value, 10)
    setArchiveAfterDays(days)
    try {
      await window.electronAPI.updateSettings({ archiveAfterDays: days })
    } catch (error) {
      console.error('[使用偏好] 更新归档天数失败:', error)
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
            onRemoveSound={handleRemoveCustomSound}
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
            onRemoveSound={handleRemoveCustomSound}
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
            onRemoveSound={handleRemoveCustomSound}
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
            description="超过指定天数未更新的对话将自动归档（置顶对话除外）"
          >
            <Select value={String(archiveAfterDays)} onValueChange={handleArchiveDaysChange}>
              <SelectTrigger className="w-[120px] h-8 text-[13px]">
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
            onChange={setCompactViewportHeightDraft}
            onBlur={handleCompactViewportHeightBlur}
            placeholder={String(DEFAULT_COMPACT_VIEWPORT_HEIGHT)}
          />
          <SettingsInput
            label="紧凑档输入框高度"
            description={`紧凑档下输入框空内容时的高度（px，${COMPACT_MIN_HEIGHT_RANGE.min}–${COMPACT_MIN_HEIGHT_RANGE.max}）；常规为 ${COMPOSER_EDITOR_MIN_HEIGHT}，默认压到 ${DEFAULT_COMPACT_MIN_HEIGHT}（变矮约 ${COMPOSER_EDITOR_MIN_HEIGHT - DEFAULT_COMPACT_MIN_HEIGHT}px）。这就是“看得见”的变矮量`}
            type="number"
            value={compactMinHeightDraft}
            onChange={setCompactMinHeightDraft}
            onBlur={handleCompactMinHeightBlur}
            placeholder={String(DEFAULT_COMPACT_MIN_HEIGHT)}
          />
          <SettingsInput
            label="紧凑档输入框上限"
            description={`紧凑档下输入框最大高度（px，${COMPACT_MAX_HEIGHT_RANGE.min}–${COMPACT_MAX_HEIGHT_RANGE.max}）；输入超过 5 行时的展开档为该值的 2 倍（不超过 ${COMPOSER_TIER_HEIGHTS.expanded}）。默认 ${DEFAULT_COMPACT_MAX_HEIGHT}`}
            type="number"
            value={compactMaxHeightDraft}
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
          <SelectTrigger className="w-[130px] h-8 text-[13px]">
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
            <Label>音频文件</Label>
            <input
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
