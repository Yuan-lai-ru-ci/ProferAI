/**
 * 「会话悬浮预览」开关的渲染层状态
 *
 * 与 `atoms/agent-unread-settings.ts`、`atoms/ui-preferences.ts` 写法一致：
 * 朴素 boolean atom + 初始化函数 + 「先写本地再持久化、失败回滚」的更新函数。
 *
 * 这个 atom 是预览是否弹出的唯一判据：`useSessionMiniMapHover` 直接读它，
 * 因此侧栏会话列表与全局搜索结果共用同一个开关，切换后立即生效、无需重启。
 * 不新增 IPC：复用既有的 `settings:get` / `settings:update`。
 */

import { atom } from 'jotai'
import { resolveSessionHoverPreviewEnabled } from '@/lib/session-preview-intent'

/** 鼠标悬停侧栏会话时是否弹出内容迷你预览（默认开启） */
export const sessionHoverPreviewEnabledAtom = atom<boolean>(true)

/** 从主进程加载开关值；读失败保持默认开启（fail-safe：不改变既有行为） */
export async function initializeSessionHoverPreviewEnabled(
  setEnabled: (enabled: boolean) => void,
): Promise<void> {
  try {
    const settings = await window.electronAPI.getSettings()
    setEnabled(resolveSessionHoverPreviewEnabled(settings))
  } catch (error) {
    console.error('[会话预览] 初始化开关失败:', error)
  }
}

/** 更新开关并持久化：先写本地 atom（立即生效），落盘失败回滚 */
export async function updateSessionHoverPreviewEnabled(
  enabled: boolean,
  setEnabled: (enabled: boolean) => void,
): Promise<void> {
  setEnabled(enabled)
  try {
    await window.electronAPI.updateSettings({ sessionHoverPreviewEnabled: enabled })
  } catch (error) {
    console.error('[会话预览] 更新开关失败:', error)
    setEnabled(!enabled)
    throw error
  }
}
