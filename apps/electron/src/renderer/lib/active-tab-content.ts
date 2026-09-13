import type { TabItem } from '@/atoms/tab-atoms'

/**
 * 解析主内容实际应显示的 Tab。只接受仍存在的同步 activeTabId，
 * 防止标签高亮与内容所属会话在 deferred 值上暂时分叉。
 */
export function resolveContentTabId(tabs: readonly TabItem[], activeTabId: string | null): string | null {
  if (!activeTabId) return null
  return tabs.some((tab) => tab.id === activeTabId) ? activeTabId : null
}
