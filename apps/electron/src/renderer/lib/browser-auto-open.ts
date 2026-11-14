import type { BrowserViewState } from '@profer/shared'

/**
 * 能代表「浏览器工作已经实际开始」的展示型动作。
 *
 * 只读动作（observe / wait / screenshot / dom inspect / script）不会产生新的可见页面，
 * 因此不应改变用户界面；否则模型一次误调用就会把浏览器面板顶出来。
 */
const BROWSER_DISPLAY_ACTIONS: ReadonlySet<string> = new Set(['navigate', 'tab'])

/**
 * 判断一次主进程 BROWSER_STATE_CHANGED 推送是否应自动在侧边打开浏览器面板。
 *
 * 产品语义：Agent 开始浏览（导航或新建页面）时，浏览器面板自动出现在侧边，
 * 让用户直接看见 Agent 正在看什么；只读同步不能顶出面板。
 * 用户手动收起该会话的浏览器后，MainArea 的 dismissed 记录会阻止再次自动打开。
 */
export function shouldAutoOpenBrowserFromPush(
  state: Pick<BrowserViewState, 'agentTabId' | 'tabs' | 'activity'>,
): boolean {
  if (!state.agentTabId) return false
  // 工作标签必须真实存在：会话被销毁但状态晚到时不能打开空白面板。
  if (!state.tabs.some((tab) => tab.tabId === state.agentTabId)) return false
  const action = state.activity?.action
  return action !== undefined && BROWSER_DISPLAY_ACTIONS.has(action)
}
