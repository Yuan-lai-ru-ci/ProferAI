/**
 * 探索分支 Tab — 探索分支的顶栏 Tab 化入口
 *
 * 探索分支（Pi /tree fork）从「右侧文件面板内嵌的第二个 AgentView」迁为
 * 父会话上下文内的会话 Tab（type:'agent' + parentSessionId 血缘）：
 * - 创建/重开 = 建 Tab 并激活（用户显式动作，应当看到分支）；
 * - 父会话 Tab 存在且双方都未入组时，自动组合并排（父左、分支右，焦点在分支），
 *   复刻旧「主线在左、分支在右」的并排体验；
 * - 关闭 Tab 只关展示：branch artifact 是普通 Agent session，持久化在主进程 meta。
 */

import { useStore } from 'jotai'
import { activeTabIdAtom, openTab, tabsAtom } from '@/atoms/tab-atoms'
import { createGroup, findTabGroup, replaceTabGroup, tabGroupsAtom } from '@/atoms/tab-group-atoms'

/** Jotai store 类型（从 useStore 推导，避免直接 import 内部 Store 类型） */
type JotaiStore = ReturnType<typeof useStore>

/**
 * 打开（或聚焦）探索分支 Tab。
 *
 * @param autoGroup 为 true 且父/分支都未入组时，建立左右并排组合
 * （父会话左、分支右，焦点在分支）；用户已有布局时保持不动。
 * @returns 分支 Tab id（即分支 sessionId）
 */
export function openExplorationBranchTab(
  store: JotaiStore,
  parentSessionId: string,
  branch: { sessionId: string; title: string },
  options: { autoGroup?: boolean } = {},
): string {
  const tabs = store.get(tabsAtom)
  const result = openTab(tabs, {
    type: 'agent',
    sessionId: branch.sessionId,
    title: branch.title,
    parentSessionId,
  })
  store.set(tabsAtom, result.tabs)
  store.set(activeTabIdAtom, result.activeTabId)

  if (options.autoGroup === true) {
    const groups = store.get(tabGroupsAtom)
    const parentTabExists = result.tabs.some((tab) => tab.id === parentSessionId)
    if (
      parentTabExists
      && !findTabGroup(groups, parentSessionId)
      && !findTabGroup(groups, branch.sessionId)
    ) {
      const group = createGroup(parentSessionId, branch.sessionId, branch.sessionId)
      if (group) store.set(tabGroupsAtom, replaceTabGroup(groups, null, group))
    }
  }
  return branch.sessionId
}
