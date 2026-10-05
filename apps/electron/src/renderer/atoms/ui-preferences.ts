/**
 * UI 偏好设置状态管理
 *
 * 管理用户界面相关的显示偏好，如悬浮置顶条、输入框 Markdown 渲染等。
 */

import { atom } from 'jotai'
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

/** 粘贴长文本时是否自动转为附件 */
export const longTextPasteAsAttachmentEnabledAtom = atom<boolean>(false)

/** 输入框是否渲染 Markdown 富文本格式（默认关闭，纯文本模式；开启后渲染富文本，仍保留 Mention 引用） */
export const richTextRenderingEnabledAtom = atom<boolean>(false)

/** 「矮窗口压缩输入框」配置 */
export interface ComposerCompactModeSettings {
  /** 触发阈值（窗口内高，px）；0 = 关闭该行为 */
  viewportHeight: number
  /** 紧凑档下输入框最小高度（px）；空内容时的可见高度 */
  minHeight: number
  /** 紧凑档下输入框上限（px） */
  maxHeight: number
}

/** 窗口高度驱动输入框紧凑档（默认 < 700px 时输入框 101px → 60px、上限 200px → 140px） */
export const composerCompactModeAtom = atom<ComposerCompactModeSettings>({
  viewportHeight: DEFAULT_COMPACT_VIEWPORT_HEIGHT,
  minHeight: DEFAULT_COMPACT_MIN_HEIGHT,
  maxHeight: DEFAULT_COMPACT_MAX_HEIGHT,
})

// ===== 初始化 =====

/**
 * 从主进程加载 UI 偏好设置
 */
export async function initializeUiPreferences(
  setShowCreditsInSidebar: (enabled: boolean) => void,
  setStickyUserMessageEnabled: (enabled: boolean) => void,
  setLongTextPasteAsAttachmentEnabled?: (enabled: boolean) => void,
  setRichTextRenderingEnabled?: (enabled: boolean) => void,
  setComposerCompactMode?: (value: ComposerCompactModeSettings) => void
): Promise<void> {
  try {
    const settings = await window.electronAPI.getSettings()
    setShowCreditsInSidebar(settings.showCreditsInSidebar ?? true)
    setStickyUserMessageEnabled(settings.stickyUserMessageEnabled ?? true)
    setLongTextPasteAsAttachmentEnabled?.(settings.longTextPasteAsAttachmentEnabled ?? false)
    setRichTextRenderingEnabled?.(settings.richTextRenderingEnabled ?? false)
    setComposerCompactMode?.({
      viewportHeight: normalizeCompactViewportHeight(settings.inputCompactViewportHeight),
      minHeight: normalizeCompactMinHeight(settings.inputCompactMinHeight),
      maxHeight: normalizeCompactMaxHeight(settings.inputCompactMaxHeight),
    })
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
