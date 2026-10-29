/**
 * UI 偏好设置状态管理
 *
 * 管理用户界面相关的显示偏好，如悬浮置顶条、输入框 Markdown 渲染等。
 */

import { atom } from 'jotai'
import { DEFAULT_PREVIEW_OPEN_MODE, DEFAULT_USER_MESSAGE_POSITION, type PreviewOpenMode, type UserMessagePosition } from '@/types/settings'
import {
  DEFAULT_COMPACT_MAX_HEIGHT,
  DEFAULT_COMPACT_MIN_HEIGHT,
  DEFAULT_COMPACT_VIEWPORT_HEIGHT,
  normalizeCompactMaxHeight,
  normalizeCompactMinHeight,
  normalizeCompactViewportHeight,
} from '@/lib/composer-compact-height'

// ===== Jotai Atoms =====

/** 是否在左侧栏显示我的积分条 */
export const showCreditsInSidebarAtom = atom<boolean>(true)

/** 是否显示用户消息悬浮置顶条 */
export const stickyUserMessageEnabledAtom = atom<boolean>(true)

/** 用户消息与头像的显示位置，默认在右侧 */
export const userMessagePositionAtom = atom<UserMessagePosition>(DEFAULT_USER_MESSAGE_POSITION)

/** 粘贴长文本时是否自动转为附件 */
export const longTextPasteAsAttachmentEnabledAtom = atom<boolean>(false)

/** 输入框是否渲染 Markdown 富文本格式（默认关闭，纯文本模式；开启后渲染富文本，仍保留 Mention 引用） */
export const richTextRenderingEnabledAtom = atom<boolean>(false)

/**
 * Windows 鼠标滚轮平滑滚动（默认关闭，仅 Windows 生效）
 *
 * 自绘弹簧接管必须挂非 passive 的 wheel 监听并 preventDefault，代价是整页失去
 * Chromium 合成器线程的滚动快速路径：滚动改由主线程逐帧写 scrollTop。流式输出
 * 期间主线程被渲染占满时，接管反而比原生更卡（Windows 用户实测反馈）。
 * 因此默认交回 Chromium 自带的合成器平滑滚动，需要 macOS 式惯性加速的用户再手动开启。
 */
export const smoothScrollEnabledAtom = atom<boolean>(false)

/** 是否强制接管像素级输入（触控板 / 高精度滚轮），默认关闭 */
export const smoothScrollForceAtom = atom<boolean>(false)

/** 「矮窗口压缩输入框」配置 */
export interface ComposerCompactModeSettings {
  /** 触发阈值（窗口内高，px）；0 = 关闭该行为 */
  viewportHeight: number
  /** 紧凑档下输入框最小高度（px）；空内容时的可见高度 */
  minHeight: number
  /** 紧凑档下输入框上限（px） */
  maxHeight: number
}

/** 窗口高度驱动输入框紧凑档（默认 < 700px 时输入框 81px → 60px、上限 200px → 140px） */
export const composerCompactModeAtom = atom<ComposerCompactModeSettings>({
  viewportHeight: DEFAULT_COMPACT_VIEWPORT_HEIGHT,
  minHeight: DEFAULT_COMPACT_MIN_HEIGHT,
  maxHeight: DEFAULT_COMPACT_MAX_HEIGHT,
})

/**
 * 文件预览打开方式（默认独立标签页）：
 * - 'tab'：预览开成独立标签页（既有行为）
 * - 'split'：预览与所属会话标签左右并排（组合标签分屏）
 */
export const previewOpenModeAtom = atom<PreviewOpenMode>(DEFAULT_PREVIEW_OPEN_MODE)

// ===== 初始化 =====

/**
 * 从主进程加载 UI 偏好设置
 */
export async function initializeUiPreferences(
  setShowCreditsInSidebar: (enabled: boolean) => void,
  setStickyUserMessageEnabled: (enabled: boolean) => void,
  setUserMessagePosition: (position: UserMessagePosition) => void,
  setLongTextPasteAsAttachmentEnabled?: (enabled: boolean) => void,
  setRichTextRenderingEnabled?: (enabled: boolean) => void,
  setComposerCompactMode?: (value: ComposerCompactModeSettings) => void,
  setPreviewOpenMode?: (mode: PreviewOpenMode) => void,
  setSmoothScrollEnabled?: (enabled: boolean) => void,
  setSmoothScrollForce?: (enabled: boolean) => void
): Promise<void> {
  try {
    const settings = await window.electronAPI.getSettings()
    setShowCreditsInSidebar(settings.showCreditsInSidebar ?? true)
    setStickyUserMessageEnabled(settings.stickyUserMessageEnabled ?? true)
    setUserMessagePosition(settings.userMessagePosition === 'left' ? 'left' : DEFAULT_USER_MESSAGE_POSITION)
    setLongTextPasteAsAttachmentEnabled?.(settings.longTextPasteAsAttachmentEnabled ?? false)
    setRichTextRenderingEnabled?.(settings.richTextRenderingEnabled ?? false)
    setComposerCompactMode?.({
      viewportHeight: normalizeCompactViewportHeight(settings.inputCompactViewportHeight),
      minHeight: normalizeCompactMinHeight(settings.inputCompactMinHeight),
      maxHeight: normalizeCompactMaxHeight(settings.inputCompactMaxHeight),
    })
    setPreviewOpenMode?.(settings.previewModePreference === 'split' ? 'split' : DEFAULT_PREVIEW_OPEN_MODE)
    setSmoothScrollEnabled?.(settings.smoothScrollEnabled ?? false)
    setSmoothScrollForce?.(settings.smoothScrollForceEnabled ?? false)
  } catch (error) {
    console.error('[UI偏好] 初始化失败:', error)
  }
}

// ===== 持久化更新 =====

/**
 * 更新侧栏积分条开关并持久化
 */
export async function updateShowCreditsInSidebar(enabled: boolean): Promise<void> {
  try {
    await window.electronAPI.updateSettings({ showCreditsInSidebar: enabled })
  } catch (error) {
    console.error('[UI偏好] 更新侧栏积分条设置失败:', error)
  }
}

/**
 * 更新悬浮置顶条开关并持久化
 */
export async function updateStickyUserMessageEnabled(enabled: boolean): Promise<void> {
  try {
    await window.electronAPI.updateSettings({ stickyUserMessageEnabled: enabled })
  } catch (error) {
    console.error('[UI偏好] 更新悬浮置顶条设置失败:', error)
  }
}

/**
 * 更新长文本粘贴转附件开关并持久化
 */
export async function updateLongTextPasteAsAttachmentEnabled(enabled: boolean): Promise<void> {
  try {
    await window.electronAPI.updateSettings({ longTextPasteAsAttachmentEnabled: enabled })
  } catch (error) {
    console.error('[UI偏好] 更新长文本粘贴附件设置失败:', error)
  }
}

/**
 * 更新输入框 Markdown 渲染开关并持久化
 */
export async function updateRichTextRenderingEnabled(enabled: boolean): Promise<void> {
  try {
    await window.electronAPI.updateSettings({ richTextRenderingEnabled: enabled })
  } catch (error) {
    console.error('[UI偏好] 更新输入框 Markdown 渲染设置失败:', error)
  }
}

/**
 * 更新 Windows 平滑滚动开关并持久化
 */
export async function updateSmoothScrollEnabled(enabled: boolean): Promise<void> {
  try {
    await window.electronAPI.updateSettings({ smoothScrollEnabled: enabled })
  } catch (error) {
    console.error('[UI偏好] 更新平滑滚动设置失败:', error)
  }
}

/**
 * 更新「强制接管像素级输入」开关并持久化
 */
export async function updateSmoothScrollForce(enabled: boolean): Promise<void> {
  try {
    await window.electronAPI.updateSettings({ smoothScrollForceEnabled: enabled })
  } catch (error) {
    console.error('[UI偏好] 更新平滑滚动强制接管设置失败:', error)
  }
}

/**
 * 更新文件预览打开方式并持久化
 */
export async function updatePreviewOpenMode(mode: PreviewOpenMode): Promise<void> {
  try {
    await window.electronAPI.updateSettings({ previewModePreference: mode })
  } catch (error) {
    console.error('[UI偏好] 更新文件预览打开方式失败:', error)
  }
}

/**
 * 更新「矮窗口压缩输入框」配置并持久化（只写入实际传入的字段）
 */
export async function updateComposerCompactMode(
  patch: Partial<ComposerCompactModeSettings>
): Promise<void> {
  try {
    const updates: {
      inputCompactViewportHeight?: number
      inputCompactMinHeight?: number
      inputCompactMaxHeight?: number
    } = {}
    if (patch.viewportHeight !== undefined) {
      updates.inputCompactViewportHeight = normalizeCompactViewportHeight(patch.viewportHeight)
    }
    if (patch.minHeight !== undefined) {
      updates.inputCompactMinHeight = normalizeCompactMinHeight(patch.minHeight)
    }
    if (patch.maxHeight !== undefined) {
      updates.inputCompactMaxHeight = normalizeCompactMaxHeight(patch.maxHeight)
    }
    if (Object.keys(updates).length === 0) return
    await window.electronAPI.updateSettings(updates)
  } catch (error) {
    console.error('[UI偏好] 更新输入框紧凑档设置失败:', error)
  }
}
