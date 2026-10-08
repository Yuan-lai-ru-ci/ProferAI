/**
 * AccountSettings - 账户与个人资料
 *
 * 集中管理本地用户档案、团队账户会话和登录状态。
 */

import * as React from 'react'
import { useAtom } from 'jotai'
import { Camera, ImagePlus, LogIn, LogOut, RefreshCw, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import Picker from '@emoji-mart/react'
import data from '@emoji-mart/data'
import { SettingsSection, SettingsCard } from './primitives'
import { Popover, PopoverTrigger, PopoverContent } from '@profer/ui/primitives/popover'
import { UserAvatar } from '../chat/UserAvatar'
import { userProfileAtom } from '@/atoms/user-profile'
import { authStatusAtom } from '@/atoms/identity-atoms'
import { LoginDialog } from '@/components/auth/LoginDialog'
import { DevicesSettings } from './DevicesSettings'
import { cn } from '@/lib/utils'

interface EmojiMartEmoji {
  id: string
  name: string
  native: string
  unified: string
  keywords: string[]
  shortcodes: string
}

export function AccountSettings(): React.ReactElement {
  const [userProfile, setUserProfile] = useAtom(userProfileAtom)
  const [authStatus, setAuthStatus] = useAtom(authStatusAtom)
  const [loginOpen, setLoginOpen] = React.useState(false)
  const [refreshing, setRefreshing] = React.useState(false)
  const [isEditingName, setIsEditingName] = React.useState(false)
  const [nameInput, setNameInput] = React.useState(userProfile.userName)
  const [showEmojiPicker, setShowEmojiPicker] = React.useState(false)
  const fileInputRef = React.useRef<HTMLInputElement>(null)
  const nameInputId = React.useId()
  const profileSavingRef = React.useRef(false)
  const [profileSaving, setProfileSaving] = React.useState(false)
  const authBusyRef = React.useRef(false)
  const [loggingOut, setLoggingOut] = React.useState(false)

  const handleAvatarChange = async (avatar: string): Promise<void> => {
    if (profileSavingRef.current) return
    profileSavingRef.current = true
    setProfileSaving(true)
    try {
      const updated = await window.electronAPI.updateUserProfile({ avatar })
      setUserProfile(updated)
      setShowEmojiPicker(false)
    } catch (error) {
      console.error('[账户设置] 更新头像失败:', error)
      toast.error('头像保存失败，请重新选择重试')
    } finally {
      profileSavingRef.current = false
      setProfileSaving(false)
    }
  }

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.type)) {
      toast.error('请选择 PNG、JPEG、GIF 或 WebP 图片')
      return
    }
    if (file.size > 5 * 1024 * 1024) {
      toast.error('头像图片不能超过 5MB')
      return
    }

    const reader = new FileReader()
    reader.onload = async () => {
      const dataUrl = reader.result as string
      await handleAvatarChange(dataUrl)
    }
    reader.onerror = () => toast.error('无法读取头像图片，请重新选择')
    reader.readAsDataURL(file)
    e.target.value = ''
  }

  const handleSaveName = async (): Promise<void> => {
    if (profileSavingRef.current) return
    const trimmed = nameInput.trim()
    if (!trimmed) {
      toast.error('用户名不能为空，请填写后重试')
      return
    }

    profileSavingRef.current = true
    setProfileSaving(true)
    try {
      const updated = await window.electronAPI.updateUserProfile({ userName: trimmed })
      setUserProfile(updated)
      setIsEditingName(false)
    } catch (error) {
      console.error('[账户设置] 更新用户名失败:', error)
      toast.error('用户名保存失败，输入已保留，请按 Enter 重试')
    } finally {
      profileSavingRef.current = false
      setProfileSaving(false)
    }
  }

  const handleNameKeyDown = (e: React.KeyboardEvent): void => {
    if (profileSavingRef.current) return
    if (e.key === 'Enter') {
      void handleSaveName()
    } else if (e.key === 'Escape') {
      setNameInput(userProfile.userName)
      setIsEditingName(false)
    }
  }

  const handleRefreshAuth = async (): Promise<void> => {
    if (authBusyRef.current) return
    authBusyRef.current = true
    setRefreshing(true)
    try {
      const status = await window.electronAPI.auth.getAuthStatus()
      if (status.isLoggedIn) {
        setAuthStatus({
          isLoggedIn: true,
          teamAccountId: status.teamAccountId,
          teamEmail: status.teamEmail,
        })
        toast.success('登录状态已刷新')
      } else {
        setAuthStatus({ isLoggedIn: false })
        toast.error('未检测到有效登录会话')
      }
    } catch {
      toast.error('刷新失败，请检查网络')
    } finally {
      authBusyRef.current = false
      setRefreshing(false)
    }
  }

  const handleLogout = async (): Promise<void> => {
    if (authBusyRef.current) return
    authBusyRef.current = true
    setLoggingOut(true)
    try {
      const result = await window.electronAPI.auth.logout()
      if (result && result.warning) toast.warning(result.warning)
      setAuthStatus({ isLoggedIn: false })
    } catch {
      toast.error('退出登录未能完成，正在重新读取登录状态')
      try {
        const status = await window.electronAPI.auth.getAuthStatus()
        setAuthStatus({
          isLoggedIn: status.isLoggedIn,
          ...(status.isLoggedIn && { teamAccountId: status.teamAccountId, teamEmail: status.teamEmail }),
        })
      } catch {
        toast.error('无法确认登录状态，请刷新后重试')
      }
    } finally {
      authBusyRef.current = false
      setLoggingOut(false)
    }
  }

  return (
    <div className="space-y-6">
      <SettingsSection title="个人资料" description="设置头像和显示名称，这些信息只保存在本机">
        <SettingsCard>
          <div className="flex items-center gap-5 px-4 py-4">
            <Popover open={showEmojiPicker} onOpenChange={setShowEmojiPicker}>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  aria-label="更换头像"
                  disabled={profileSaving}
                  className="relative group/avatar cursor-pointer rounded-[20%] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-focus/15 disabled:opacity-60"
                >
                  <UserAvatar avatar={userProfile.avatar} size={64} />
                  <div className={cn(
                    'absolute inset-0 rounded-[20%] flex items-center justify-center',
                    'bg-black/40 opacity-0 group-hover/avatar:opacity-100 transition-opacity'
                  )}>
                    <Camera className="size-5 text-white" />
                  </div>
                </button>
              </PopoverTrigger>
              <PopoverContent side="right" align="start" sideOffset={12} className="w-auto p-0 border-none shadow-xl">
                <Picker
                  data={data}
                  onEmojiSelect={(emoji: EmojiMartEmoji) => void handleAvatarChange(emoji.native)}
                  locale="zh"
                  theme="auto"
                  previewPosition="none"
                  skinTonePosition="search"
                  perLine={8}
                />
                <div className="px-3 p-2">
                  <button
                    type="button"
                    disabled={profileSaving}
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
                    aria-label="上传头像图片"
                    accept="image/png,image/jpeg,image/gif,image/webp"
                    className="hidden"
                    onChange={handleImageUpload}
                  />
                </div>
              </PopoverContent>
            </Popover>

            <div className="flex-1 min-w-0">
              {isEditingName ? (
                <>
                  <label htmlFor={nameInputId} className="sr-only">显示名称</label>
                  <input
                    id={nameInputId}
                    type="text"
                    readOnly={profileSaving}
                    value={nameInput}
                    onChange={(e) => setNameInput(e.target.value)}
                    onBlur={() => void handleSaveName()}
                    onKeyDown={handleNameKeyDown}
                    maxLength={30}
                    autoFocus
                    className={cn(
                      'text-lg font-semibold text-foreground bg-transparent border-b-2 border-primary',
                      'outline-none w-full max-w-[200px] pb-0.5'
                    )}
                  />
                </>
              ) : (
                <button
                  type="button"
                  disabled={profileSaving}
                  onClick={() => {
                    setNameInput(userProfile.userName)
                    setIsEditingName(true)
                  }}
                  className="text-lg font-semibold text-foreground hover:text-primary transition-colors text-left"
                >
                  {userProfile.userName}
                </button>
              )}
              <p className="text-[12px] text-foreground/40 mt-0.5">点击头像更换，点击名字编辑</p>
              {profileSaving && <p role="status" className="text-xs text-muted-foreground">保存中…</p>}
            </div>
          </div>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="团队账户" description="登录后可使用服务端渠道、额度和团队协作功能">
        <SettingsCard>
          {authStatus.isLoggedIn ? (
            <div className="flex items-center gap-3 px-4 py-4">
              <span className="w-2 h-2 rounded-full bg-green-500 flex-shrink-0" />
              <span className="text-sm flex-1 truncate">{authStatus.teamEmail}</span>
              <button
                onClick={() => void handleRefreshAuth()}
                disabled={refreshing || loggingOut}
                className="flex items-center gap-1.5 text-[12px] text-muted-foreground hover:text-foreground transition-colors"
                title="从服务端刷新登录状态"
              >
                {refreshing ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
                刷新
              </button>
              <button
                type="button"
                onClick={() => void handleLogout()}
                disabled={loggingOut || refreshing}
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

      {authStatus.isLoggedIn && <DevicesSettings />}
      <LoginDialog open={loginOpen} onOpenChange={setLoginOpen} />
    </div>
  )
}
