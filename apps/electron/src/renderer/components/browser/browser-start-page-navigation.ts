import type { BrowserViewState } from '@profer/shared'

/**
 * 默认首页只能导航主进程已经创建的真实空标签。
 *
 * BrowserPanel 在收起时仍会预挂载以维持分栏动画；此时 `state` 为 null 表示
 * 当前会话从未打开过浏览器。若把它误判为空标签并调用 navigate，会反向创建
 * 浏览器会话，导致新会话一出现就自动弹出浏览器，且关闭最后一个标签后再次复活。
 */
export function shouldNavigateDefaultHome(
  state: BrowserViewState | null,
  defaultHomeUrl: string | null,
  lastAutoNavigatedTabId: string | null,
): boolean {
  if (!state || !defaultHomeUrl || state.url) return false
  return state.activeTabId.length > 0 && state.activeTabId !== lastAutoNavigatedTabId
}
