/**
 * 桌面通知状态管理
 *
 * 管理通知开关状态，提供发送桌面通知的工具函数。
 * 使用 Web Notification API（Electron renderer 原生支持）。
 * 支持多场景通知音选择（任务完成、权限审批、计划审批）。
 * 支持用户自定义音效（最长 10s，存储到 ~/.profer/custom-sounds/）。
 */

import { atom } from 'jotai'
import type { NotificationSoundId, NotificationSoundType, NotificationSoundSettings, CustomNotificationSound } from '@/types/settings'

// ===== 音频资源导入 =====
import soundDing from '@/assets/sound/ding.mp3'
import soundDingDong from '@/assets/sound/ding-dong.mp3'
import soundDiscord from '@/assets/sound/discord.mp3'
import soundDone from '@/assets/sound/done.mp3'
import soundDownPower from '@/assets/sound/down-power.mp3'
import soundFood from '@/assets/sound/food.mp3'
import soundLite from '@/assets/sound/lite.mp3'
import soundQuiet from '@/assets/sound/quiet.mp3'

// ===== 音频资源注册表 =====

/** 通知音元数据 */
export interface NotificationSoundMeta {
  id: NotificationSoundId
  label: string
  url: string
  /** 是否为自定义音效（用于在 UI 中显示删除按钮等） */
  isCustom?: boolean
}

/** 所有内置通知音（不含 none） */
export const BUILTIN_NOTIFICATION_SOUNDS: NotificationSoundMeta[] = [
  { id: 'ding', label: 'Ding', url: soundDing },
  { id: 'ding-dong', label: 'Ding Dong', url: soundDingDong },
  { id: 'discord', label: 'Discord', url: soundDiscord },
  { id: 'done', label: 'Done', url: soundDone },
  { id: 'down-power', label: 'Down Power', url: soundDownPower },
  { id: 'food', label: 'Food', url: soundFood },
  { id: 'lite', label: 'Lite', url: soundLite },
  { id: 'quiet', label: 'Quiet', url: soundQuiet },
]

/** @deprecated 使用 BUILTIN_NOTIFICATION_SOUNDS + customNotificationSoundsAtom */
export const NOTIFICATION_SOUNDS = BUILTIN_NOTIFICATION_SOUNDS

/** 内置音频 URL 映射（快速查找） */
const SOUND_URL_MAP: Record<string, string> = Object.fromEntries(
  BUILTIN_NOTIFICATION_SOUNDS.map((s) => [s.id, s.url])
)

/** 自定义音效 URL 缓存：fileName → file:// URL */
const customSoundUrlCache = new Map<string, string>()

/** 各场景的默认通知音 */
export const DEFAULT_NOTIFICATION_SOUNDS: Required<NotificationSoundSettings> = {
  taskComplete: 'ding',
  permissionRequest: 'ding-dong',
  exitPlanMode: 'ding-dong',
}

// ===== Jotai Atoms =====

/** 通知是否启用 */
export const notificationsEnabledAtom = atom<boolean>(true)

/** 通知提示音是否启用 */
export const notificationSoundEnabledAtom = atom<boolean>(true)

/** 各场景通知音配置 */
export const notificationSoundsAtom = atom<NotificationSoundSettings>({})

/** 用户添加的自定义通知音效列表 */
export const customNotificationSoundsAtom = atom<CustomNotificationSound[]>([])

// ===== 合并音效列表 =====

/**
 * 获取所有可用通知音（内置 + 自定义），供 UI 下拉列表使用
 */
export function getAllNotificationSounds(customSounds: CustomNotificationSound[]): NotificationSoundMeta[] {
  if (customSounds.length === 0) return [...BUILTIN_NOTIFICATION_SOUNDS]

  const customMetas: NotificationSoundMeta[] = customSounds.map((cs) => ({
    id: cs.id,
    label: cs.label,
    url: '', // 运行时通过 IPC 获取
    isCustom: true,
  }))

  return [...BUILTIN_NOTIFICATION_SOUNDS, ...customMetas]
}

// ===== 初始化 =====

/**
 * 从主进程加载通知设置
 */
export async function initializeNotifications(
  setEnabled: (enabled: boolean) => void,
  setSoundEnabled: (enabled: boolean) => void,
  setSounds: (sounds: NotificationSoundSettings) => void,
  setCustomSounds?: (sounds: CustomNotificationSound[]) => void
): Promise<void> {
  try {
    const settings = await window.electronAPI.getSettings()
    setEnabled(settings.notificationsEnabled ?? true)
    setSoundEnabled(settings.notificationSoundEnabled ?? true)
    setSounds(settings.notificationSounds ?? {})
    setCustomSounds?.(settings.customNotificationSounds ?? [])
  } catch (error) {
    console.error('[通知] 初始化失败:', error)
  }
}

// ===== 持久化更新 =====

/**
 * 更新通知开关并持久化
 */
export async function updateNotificationsEnabled(enabled: boolean): Promise<void> {
  try {
    await window.electronAPI.updateSettings({ notificationsEnabled: enabled })
  } catch (error) {
    console.error('[通知] 更新设置失败:', error)
  }
}

/**
 * 更新通知提示音开关并持久化
 */
export async function updateNotificationSoundEnabled(enabled: boolean): Promise<void> {
  try {
    await window.electronAPI.updateSettings({ notificationSoundEnabled: enabled })
  } catch (error) {
    console.error('[通知] 更新提示音设置失败:', error)
  }
}

/**
 * 更新某场景的通知音并持久化
 */
export async function updateNotificationSound(
  type: NotificationSoundType,
  soundId: NotificationSoundId,
  currentSounds: NotificationSoundSettings
): Promise<NotificationSoundSettings> {
  const newSounds: NotificationSoundSettings = { ...currentSounds, [type]: soundId }
  try {
    await window.electronAPI.updateSettings({ notificationSounds: newSounds })
  } catch (error) {
    console.error('[通知] 更新通知音设置失败:', error)
  }
  return newSounds
}

/**
 * 添加自定义通知音效
 * 由 UI 在验证时长后调用
 */
export async function addCustomNotificationSound(
  sourcePath: string,
  label: string
): Promise<CustomNotificationSound> {
  const sound = await window.electronAPI.addCustomNotificationSound(sourcePath, label)
  return sound
}

/**
 * 删除自定义通知音效
 * 返回更新后的自定义音效列表
 */
export async function removeCustomNotificationSound(
  id: string,
  currentSounds: NotificationSoundSettings,
  customSounds: CustomNotificationSound[]
): Promise<{
  customSounds: CustomNotificationSound[]
  sounds: NotificationSoundSettings
}> {
  const updatedCustom = await window.electronAPI.removeCustomNotificationSound(id)

  // 清理各场景中引用此音效的配置
  const cleanedSounds: NotificationSoundSettings = { ...currentSounds }
  let needsClean = false
  for (const key of ['taskComplete', 'permissionRequest', 'exitPlanMode'] as const) {
    if (cleanedSounds[key] === id) {
      cleanedSounds[key] = DEFAULT_NOTIFICATION_SOUNDS[key]
      needsClean = true
    }
  }
  if (needsClean) {
    await window.electronAPI.updateSettings({ notificationSounds: cleanedSounds })
  }

  // 清理自定义音效的 URL 缓存和音频缓存
  const target = customSounds.find((s) => s.id === id)
  if (target) {
    customSoundUrlCache.delete(target.fileName)
    audioCache.delete(id)
  }

  return { customSounds: updatedCustom, sounds: cleanedSounds }
}

// ===== 音频播放 =====

/** 音频元素缓存池（按 soundId 缓存，避免重复创建） */
const audioCache = new Map<string, HTMLAudioElement>()

/**
 * 获取内置音效的音频元素
 */
function getBuiltinAudioElement(soundId: string): HTMLAudioElement | null {
  const url = SOUND_URL_MAP[soundId]
  if (!url) return null

  let audio = audioCache.get(soundId)
  if (!audio) {
    audio = new Audio(url)
    audio.onerror = () => audioCache.delete(soundId)
    audioCache.set(soundId, audio)
  }
  return audio
}

/**
 * 获取自定义音效的音频元素（通过 IPC 获取 file:// URL）
 */
async function getCustomAudioElement(fileName: string): Promise<HTMLAudioElement | null> {
  // 从缓存取 URL
  let url = customSoundUrlCache.get(fileName)
  if (!url) {
    try {
      url = await window.electronAPI.getCustomSoundUrl(fileName)
      customSoundUrlCache.set(fileName, url)
    } catch {
      console.error(`[通知] 获取自定义音效 URL 失败: ${fileName}`)
      return null
    }
  }

  const cacheKey = `custom:${fileName}`
  let audio = audioCache.get(cacheKey)
  if (!audio) {
    audio = new Audio(url)
    audio.onerror = () => {
      audioCache.delete(cacheKey)
      customSoundUrlCache.delete(fileName)
    }
    audioCache.set(cacheKey, audio)
  }
  return audio
}

/**
 * 播放指定通知音（同步版本，仅处理内置音效和 none）
 * 对自定义音效，使用异步版本 playNotificationSoundAsync
 */
export function playNotificationSound(soundId: NotificationSoundId): void {
  try {
    if (soundId === 'none') return

    // 内置音效：直接播放
    const audio = getBuiltinAudioElement(soundId)
    if (audio) {
      audio.currentTime = 0
      audio.play().catch(() => {})
      return
    }

    // 自定义音效：异步播放（不阻塞调用方）
    // playNotificationSound 保持同步签名兼容性，自定义音效通过 playNotificationSoundAsync
  } catch {
    // 静默失败
  }
}

/**
 * 异步播放指定通知音（支持自定义音效）
 */
export async function playNotificationSoundAsync(soundId: NotificationSoundId, customSounds: CustomNotificationSound[]): Promise<void> {
  try {
    if (soundId === 'none') return

    // 内置音效
    const audio = getBuiltinAudioElement(soundId)
    if (audio) {
      audio.currentTime = 0
      await audio.play().catch(() => {})
      return
    }

    // 自定义音效
    const customSound = customSounds.find((s) => s.id === soundId)
    if (customSound) {
      const customAudio = await getCustomAudioElement(customSound.fileName)
      if (customAudio) {
        customAudio.currentTime = 0
        await customAudio.play().catch(() => {})
      }
    }
  } catch {
    // 静默失败
  }
}

/**
 * 根据场景类型播放对应通知音（同步版本）
 */
export function playNotificationSoundForType(
  type: NotificationSoundType,
  sounds: NotificationSoundSettings
): void {
  const soundId = sounds[type] ?? DEFAULT_NOTIFICATION_SOUNDS[type]
  playNotificationSound(soundId)
}

// ===== 桌面通知 =====

/** 发送桌面通知的附加选项 */
export interface DesktopNotificationOptions {
  /** 通知音场景类型（启用时按此类型播放对应音效） */
  soundType?: NotificationSoundType
  /** 是否播放提示音 */
  playSound?: boolean
  /** 当前通知音配置（playSound 为 true 时需要） */
  sounds?: NotificationSoundSettings
  /** 自定义音效列表（用于解析自定义 soundId → file URL） */
  customSounds?: CustomNotificationSound[]
  /** 点击通知时的导航回调（如导航到对应会话） */
  onNavigate?: () => void
  /** 强制弹出通知，无视窗口焦点状态（用于阻塞操作） */
  force?: boolean
}

/**
 * 发送桌面通知
 *
 * 提示音：无论窗口是否聚焦都会播放（阻塞操作需要立即引起注意）。
 * 桌面通知：仅在窗口未聚焦且通知已启用时发送。
 * 点击通知会聚焦应用窗口，并可选导航到对应会话。
 */
export function sendDesktopNotification(
  title: string,
  body: string,
  enabled: boolean,
  options?: DesktopNotificationOptions
): void {
  // 将音频播放和系统通知推迟到下一个宏任务，避免在 React batchedUpdates
  // 同步调用栈中阻塞主线程（audio.currentTime seek + Notification 创建会导致掉帧）
  setTimeout(async () => {
    if (options?.playSound && options.soundType) {
      const soundId = (options.sounds?.[options.soundType] ?? DEFAULT_NOTIFICATION_SOUNDS[options.soundType]) as string
      if (options.customSounds?.length) {
        await playNotificationSoundAsync(soundId, options.customSounds)
      } else {
        playNotificationSound(soundId)
      }
    }

    if (!enabled) return
    if (!options?.force && document.hasFocus()) return

    const notification = new Notification(title, { body, silent: true })
    notification.onclick = () => {
      window.focus()
      options?.onNavigate?.()
    }
  }, 0)
}
