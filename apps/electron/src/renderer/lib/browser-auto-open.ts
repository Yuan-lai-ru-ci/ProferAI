import type { BrowserViewState } from '@profer/shared'

/**
 * 自动展示必须以用户已明确开启「跟随 Agent」为前提；默认只同步后台状态。
 * 只读动作、输入和点击即使开启跟随也不负责打开面板。
 */
const BROWSER_DISPLAY_ACTIONS: ReadonlySet<string> = new Set(['navigate', 'tab'])

/**
 * 判断一次主进程 BROWSER_STATE_CHANGED 推送是否应自动打开浏览器面板。
 *
 * 用户手动打开走 TabBar 的显式路径；切回会话只被动对账，不能当作展示授权。
 * 后台任务、只读同步和恢复状态绝不隐式打开界面。
 */
export function shouldAutoOpenBrowserFromPush(
  state: Pick<BrowserViewState, 'agentTabId' | 'tabs' | 'activity'>,
  followAgent = false,
): boolean {
  if (!followAgent || !state.agentTabId) return false
  // 工作标签必须真实存在：会话被销毁但状态晚到时不能打开空白面板。
  if (!state.tabs.some((tab) => tab.tabId === state.agentTabId)) return false
  const action = state.activity?.action
  return action !== undefined && BROWSER_DISPLAY_ACTIONS.has(action)
}
