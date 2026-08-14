/**
 * GeneralSettings - 通用设置页
 *
 * 顶部：用户档案编辑（头像 + 用户名）
 * 下方：语言等通用设置
 */

import * as React from 'react'
import { useAtom } from 'jotai'
import { Camera, ImagePlus, Volume2, LogIn, LogOut, RefreshCw, Loader2, Plus, X, Music } from 'lucide-react'
import { toast } from 'sonner'
import Picker from '@emoji-mart/react'
import data from '@emoji-mart/data'
import {
  SettingsSection,
  SettingsCard,
  SettingsRow,
  SettingsToggle,
  SettingsInput,
  SettingsSelect,
} from './primitives'
import { Popover, PopoverTrigger, PopoverContent } from '../ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '../ui/dialog'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { UserAvatar } from '../chat/UserAvatar'
import { userProfileAtom } from '@/atoms/user-profile'
import { authStatusAtom } from '@/atoms/identity-atoms'
import { LoginDialog } from '@/components/auth/LoginDialog'
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
  stickyUserMessageEnabledAtom,
  updateStickyUserMessageEnabled,
  longTextPasteAsAttachmentEnabledAtom,
  updateLongTextPasteAsAttachmentEnabled,
  richTextRenderingEnabledAtom,
  updateRichTextRenderingEnabled,
} from '@/atoms/ui-preferences'
import { cn } from '@/lib/utils'
import { Button } from '../ui/button'
import type { RuntimeStatus } from '@profer/shared'
import type { NotificationSoundId, NotificationSoundType, NotificationSoundSettings } from '@/types/settings'

/** emoji-mart 选择回调的 emoji 对象类型 */
interface EmojiMartEmoji {
  id: string
  name: string
  native: string
  unified: string
  keywords: string[]
  shortcodes: string
}

export function GeneralSettings(): React.ReactElement {
  const [userProfile, setUserProfile] = useAtom(userProfileAtom)
  const [authStatus, setAuthStatus] = useAtom(authStatusAtom)
  const [loginOpen, setLoginOpen] = React.useState(false)
  const [refreshing, setRefreshing] = React.useState(false)
  const [notificationsEnabled, setNotificationsEnabled] = useAtom(notificationsEnabledAtom)
  const [notificationSoundEnabled, setNotificationSoundEnabled] = useAtom(notificationSoundEnabledAtom)
  const [notificationSounds, setNotificationSounds] = useAtom(notificationSoundsAtom)
  const [customSounds, setCustomSounds] = useAtom(customNotificationSoundsAtom)
  const [stickyUserMessageEnabled, setStickyUserMessageEnabled] = useAtom(stickyUserMessageEnabledAtom)
  const [longTextPasteAsAttachmentEnabled, setLongTextPasteAsAttachmentEnabled] = useAtom(longTextPasteAsAttachmentEnabledAtom)
  const [richTextRenderingEnabled, setRichTextRenderingEnabled] = useAtom(richTextRenderingEnabledAtom)
  const [shellRuntimeStatus, setShellRuntimeStatus] = React.useState<RuntimeStatus | null>(null)
  const [isEditingName, setIsEditingName] = React.useState(false)
  const [nameInput, setNameInput] = React.useState(userProfile.userName)
  const [showEmojiPicker, setShowEmojiPicker] = React.useState(false)
  const [archiveAfterDays, setArchiveAfterDays] = React.useState<number>(7)
  const [autoLaunch, setAutoLaunch] = React.useState(false)
  const [quickTaskEnabled, setQuickTaskEnabled] = React.useState(false)
  const [shellPreference, setShellPreference] = React.useState<'auto' | 'git-bash' | 'wsl'>('auto')
  const [browserHomeUrl, setBrowserHomeUrl] = React.useState('')
  const fileInputRef = React.useRef<HTMLInputElement>(null)

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
      console.error('[通用设置] 添加自定义音效失败:', err)
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
      console.error('[通用设置] 删除自定义音效失败:', err)
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
      setAutoLaunch(settings.autoLaunch ?? false)
      setQuickTaskEnabled(settings.quickTaskEnabled === true)
      setShellPreference(settings.agentShellPreference ?? 'auto')
      setBrowserHomeUrl(settings.browserHomeUrl ?? '')
    }).catch(console.error)

    window.electronAPI.getRuntimeStatus().then((status) => {
      if (status) setShellRuntimeStatus(status)
    }).catch(() => {})
  }, [])

  /** 切换开机自启动 */
  const handleAutoLaunchChange = async (enabled: boolean): Promise<void> => {
    setAutoLaunch(enabled)
    try {
      await window.electronAPI.setAutoLaunch(enabled)
    } catch (error) {
      console.error('[通用设置] 设置开机自启动失败:', error)
      setAutoLaunch(!enabled) // 回滚
    }
  }

  /** 更新归档天数 */
  const handleArchiveDaysChange = async (value: string): Promise<void> => {
    const days = parseInt(value, 10)
    setArchiveAfterDays(days)
    try {
      await window.electronAPI.updateSettings({ archiveAfterDays: days })
    } catch (error) {
      console.error('[通用设置] 更新归档天数失败:', error)
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

  /** 切换快速任务窗口（Alt+Space 全局唤起） */
  const handleQuickTaskToggle = async (enabled: boolean): Promise<void> => {
    setQuickTaskEnabled(enabled)
    try {
      await window.electronAPI.updateSettings({ quickTaskEnabled: enabled })
      if (enabled) {
        toast.success('快速任务已开启，按 Alt+Space 唤起')
      } else {
        toast.success('快速任务已关闭')
      }
    } catch (error) {
      console.error('[通用设置] 更新快速任务开关失败:', error)
      setQuickTaskEnabled(!enabled) // 回滚
    }
  }

  /** 更新头像 */
  const handleAvatarChange = async (avatar: string): Promise<void> => {
    try {
      const updated = await window.electronAPI.updateUserProfile({ avatar })
      setUserProfile(updated)
      setShowEmojiPicker(false)
    } catch (error) {
      console.error('[通用设置] 更新头像失败:', error)
    }
  }

  /** 上传图片作为头像 */
  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0]
    if (!file) return

    const reader = new FileReader()
    reader.onload = async () => {
      const dataUrl = reader.result as string
      await handleAvatarChange(dataUrl)
    }
    reader.readAsDataURL(file)
    e.target.value = ''
  }

  /** 保存用户名 */
  const handleSaveName = async (): Promise<void> => {
    const trimmed = nameInput.trim()
    if (!trimmed) return

    try {
      const updated = await window.electronAPI.updateUserProfile({ userName: trimmed })
      setUserProfile(updated)
      setIsEditingName(false)
    } catch (error) {
      console.error('[通用设置] 更新用户名失败:', error)
    }
  }

  /** 用户名编辑键盘事件 */
  const handleNameKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter') {
      handleSaveName()
    } else if (e.key === 'Escape') {
      setNameInput(userProfile.userName)
      setIsEditingName(false)
    }
  }

  return (
    <div className="space-y-6">
      {/* 用户档案区域 */}
      <SettingsSection
        title="用户档案"
        description="设置你的头像和显示名称"
      >
        <SettingsCard>
          <div className="flex items-center gap-5 px-4 py-4">
            {/* 头像 + Popover emoji 选择器 */}
            <Popover open={showEmojiPicker} onOpenChange={setShowEmojiPicker}>
              <PopoverTrigger asChild>
                <div className="relative group/avatar cursor-pointer">
                  <UserAvatar avatar={userProfile.avatar} size={64} />
                  {/* 编辑覆盖层 */}
                  <div
                    className={cn(
                      'absolute inset-0 rounded-[20%] flex items-center justify-center',
                      'bg-black/40 opacity-0 group-hover/avatar:opacity-100 transition-opacity'
                    )}
                  >
                    <Camera className="size-5 text-white" />
                  </div>
                </div>
              </PopoverTrigger>
              <PopoverContent
                side="right"
                align="start"
                sideOffset={12}
                className="w-auto p-0 border-none shadow-xl"
              >
                <Picker
                  data={data}
                  onEmojiSelect={(emoji: EmojiMartEmoji) => handleAvatarChange(emoji.native)}
                  locale="zh"
                  theme="auto"
                  previewPosition="none"
                  skinTonePosition="search"
                  perLine={8}
                />
                {/* 上传自定义图片 */}
                <div className="px-3 p-2">
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    className={cn(
                      'w-full flex items-center justify-center gap-1.5 py-2 rounded-lg text-[13px]',
                      'text-foreground/60 hover:text-foreground hover:bg-foreground/[0.06] transition-colors'
                    )}
                  >
                    <ImagePlus className="size-4" />
                    上传自定义图片
                  </button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/gif,image/webp"
                    className="hidden"
                    onChange={handleImageUpload}
                  />
                </div>
              </PopoverContent>
            </Popover>

            {/* 用户名 */}
            <div className="flex-1 min-w-0">
              {isEditingName ? (
                <input
                  type="text"
                  value={nameInput}
                  onChange={(e) => setNameInput(e.target.value)}
                  onBlur={handleSaveName}
                  onKeyDown={handleNameKeyDown}
                  maxLength={30}
                  autoFocus
                  className={cn(
                    'text-lg font-semibold text-foreground bg-transparent border-b-2 border-primary',
                    'outline-none w-full max-w-[200px] pb-0.5'
                  )}
                />
              ) : (
                <button
                  onClick={() => {
                    setNameInput(userProfile.userName)
                    setIsEditingName(true)
                  }}
                  className="text-lg font-semibold text-foreground hover:text-primary transition-colors text-left"
                >
                  {userProfile.userName}
                </button>
              )}
              <p className="text-[12px] text-foreground/40 mt-0.5">
                点击头像更换，点击名字编辑
              </p>
            </div>
          </div>
        </SettingsCard>
      </SettingsSection>

      {/* 账户 */}
      <SettingsSection
        title="账户"
        description="登录以使用服务端渠道和团队协作功能"
      >
        <SettingsCard>
          {authStatus.isLoggedIn ? (
            <div className="flex items-center gap-3 px-4 py-4">
              <span className="w-2 h-2 rounded-full bg-green-500 flex-shrink-0" />
              <span className="text-sm flex-1 truncate">{authStatus.teamEmail}</span>
              <button
                onClick={async () => {
                  setRefreshing(true)
                  try {
                    const status = await window.electronAPI.auth.getAuthStatus()
                    if (status.isLoggedIn) {
                      setAuthStatus({ isLoggedIn: true, teamAccountId: status.teamAccountId, teamEmail: status.teamEmail })
                      toast.success('登录状态已刷新')
                    } else {
                      toast.error('未检测到有效登录会话')
                    }
                  } catch {
                    toast.error('刷新失败，请检查网络')
                  } finally {
                    setRefreshing(false)
                  }
                }}
                disabled={refreshing}
                className="flex items-center gap-1.5 text-[12px] text-muted-foreground hover:text-foreground transition-colors"
                title="从服务端刷新登录状态"
              >
                {refreshing ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
              </button>
              <button
                onClick={async () => {
                  try {
                    const result = await window.electronAPI.auth.logout() as unknown as ({ channelsCleared?: boolean; channelsBackedUp?: boolean; warning?: string } | void)
                    if (result && result.warning) {
                      toast.warning(result.warning)
                    }
                  } catch {
                    /* 非致命 */
                  }
                  setAuthStatus({ isLoggedIn: false })
                }}
                className="flex items-center gap-1.5 text-[12px] text-muted-foreground hover:text-destructive transition-colors"
              >
                <LogOut size={13} />
                退出登录
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-3 px-4 py-4">
              <span className="w-2 h-2 rounded-full bg-muted-foreground/30 flex-shrink-0" />
              <span className="text-sm text-muted-foreground flex-1">未登录</span>
              <button
                onClick={() => setLoginOpen(true)}
                className="flex items-center gap-1.5 text-[12px] text-primary hover:text-primary/80 transition-colors"
              >
                <LogIn size={13} />
                登录
              </button>
            </div>
          )}
        </SettingsCard>
      </SettingsSection>
      <LoginDialog open={loginOpen} onOpenChange={setLoginOpen} />

      {/* 通用设置 */}
      <SettingsSection
        title="通用设置"
        description="应用的基本配置"
      >
        <SettingsCard>
          <SettingsRow
            label="语言"
            description="更多语言支持即将推出"
          >
            <span className="text-[13px] text-foreground/40">简体中文</span>
          </SettingsRow>
          <SettingsToggle
            label="快速任务（Alt+Space）"
            description="启用后预创建全局唤起窗口，在任意应用按 Alt+Space 快速向 Profer 发送任务"
            checked={quickTaskEnabled}
            onCheckedChange={handleQuickTaskToggle}
          />
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
            label="消息悬浮置顶条"
            description="滚动浏览对话时，在顶部显示最近的用户消息摘要"
            checked={stickyUserMessageEnabled}
            onCheckedChange={(checked) => {
              setStickyUserMessageEnabled(checked)
              updateStickyUserMessageEnabled(checked)
            }}
          />
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
          <SettingsToggle
            label="开机自启动"
            description="系统启动时自动运行 Profer"
            checked={autoLaunch}
            onCheckedChange={handleAutoLaunchChange}
          />

          <SettingsSelect
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
          />

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

      {/* ── 代理设置已迁移到独立「代理设置」tab（ProxySettings）── */}
      {/* ── 登录设备已迁移到独立「登录设备」tab（DevicesSettings）── */}

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
