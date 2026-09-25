/**
 * 面板自适应可见性 — 统一驱动 hook + 模块级 API
 *
 * 模型：面板的「展开意图 A」与「实际可见 B」分离。
 * - A（agentSidePanelOpenAtom）只随用户手动操作变化；
 * - B（panelVisibilityAtom）由本 hook 依据窗口宽度统一计算，窗口变窄只让 B 变 false，A 保持不变；
 * - 窗口拉宽后，A=true 的面板自动显示。
 *
 * 参与自动可见性判定的面板：右侧文件面板；左侧栏保持纯手动行为。
 * 受管浏览器已 Tab 化（见 lib/browser-tab.ts），不再参与宽度预算。
 * 状态收敛到本模块：单一 window resize 监听 + 唯一可见性计算 effect，
 * 避免 MainArea / AppShell / TabBar 各自订阅窗口造成竞态。
 *
 * 主区栏数也在这里参与判定：组合 tab 激活时对话区是两栏，最小宽度要翻倍（见 lib/panel-layout）。
 */

import * as React from 'react'
import { getDefaultStore, useAtomValue, useSetAtom } from 'jotai'
import { toast } from 'sonner'
import {
  windowWidthAtom,
  layoutScopeActiveAtom,
  panelVisibilityAtom,
} from '@/atoms/panel-layout-atoms'
import { agentSidePanelOpenAtom, currentAgentSessionIdAtom } from '@/atoms/agent-atoms'
import { sidebarCollapsedAtom, activeTabIdAtom } from '@/atoms/tab-atoms'
import { findTabGroup, tabGroupsAtom } from '@/atoms/tab-group-atoms'
import { appModeAtom } from '@/atoms/app-mode'
import {
  computeVisibility,
  type PanelLayoutState,
  type PanelVisibility,
} from '@/lib/panel-layout'

/** 全局默认 store（模块级函数与 React 组件共享同一实例） */
const store = getDefaultStore()

/**
 * 从 store 派生当前布局（sidebar 为实际展开；filePanel 为展开意图 A）。
 * 文件面板仅在 agent 个人视图（layoutScopeActive）参与判定。
 */
function getCurrentLayout(): PanelLayoutState {
  const scopeActive = store.get(layoutScopeActiveAtom)
  const appMode = store.get(appModeAtom)
  const sessionId = store.get(currentAgentSessionIdAtom)
  const agentSessionActive = scopeActive && appMode === 'agent' && !!sessionId
  // 主区栏数：用与 MainArea 相同的纯判定（isGroupActive），
  // 避免"预算算几栏"和"实际渲染几栏"各写一套。
  const group = findTabGroup(store.get(tabGroupsAtom), store.get(activeTabIdAtom))
  const groupViewActive = !!group && (!!group.leftTabId || !!group.rightTabId)
  return {
    sidebar: !store.get(sidebarCollapsedAtom),
    filePanel: agentSessionActive && store.get(agentSidePanelOpenAtom),
    mainPaneCount: groupViewActive ? 2 : 1,
  }
}

/**
 * 手动打开文件面板：置展开意图 A=true（窗口不足时仅不可见，A 保持）。
 * 窗口不足 → toast 提示，图标随后由 TabBar 依据 A 高亮。
 */
export function openFilePanel(): void {
  store.set(agentSidePanelOpenAtom, true)
  const windowWidth = store.get(windowWidthAtom)
  const layout = getCurrentLayout()
  const current = store.get(panelVisibilityAtom)
  const vis = computeVisibility(windowWidth, layout, { ...current, filePanel: true })
  store.set(panelVisibilityAtom, vis)
  if (!vis.filePanel) {
    toast.message('文件面板已打开，当前窗口宽度不足暂不可见，拉大窗口后自动显示')
  }
}

export interface UsePanelAutoLayoutOptions {
  /** 文件面板是否参与当前布局（agent 个人视图）。AppShell 依据视图作用域传入。 */
  filePanelActive?: boolean
}

/**
 * 挂载在 AppShell（始终渲染的布局容器），驱动文件面板可见性。
 * 组件如需查询布局状态，直接读取 panelVisibilityAtom / 调用模块级函数（openFilePanel）。
 */
export function usePanelAutoLayout(options: UsePanelAutoLayoutOptions = {}): void {
  const { filePanelActive = true } = options

  const setWindowWidth = useSetAtom(windowWidthAtom)
  const setLayoutScopeActive = useSetAtom(layoutScopeActiveAtom)
  const setPanelVisibility = useSetAtom(panelVisibilityAtom)

  // 唯一窗口 resize 监听（收敛竞态来源）
  React.useEffect(() => {
    const update = (): void => setWindowWidth(window.innerWidth)
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [setWindowWidth])

  // 同步布局作用域
  React.useEffect(() => {
    setLayoutScopeActive(filePanelActive)
  }, [filePanelActive, setLayoutScopeActive])

  // 订阅布局相关状态（可见性计算 effect 依赖它们重跑）
  const windowWidth = useAtomValue(windowWidthAtom)
  const appMode = useAtomValue(appModeAtom)
  const sessionId = useAtomValue(currentAgentSessionIdAtom)
  const sidebarCollapsed = useAtomValue(sidebarCollapsedAtom)
  const sidePanelOpen = useAtomValue(agentSidePanelOpenAtom)
  const layoutScopeActive = useAtomValue(layoutScopeActiveAtom)
  const tabGroups = useAtomValue(tabGroupsAtom)
  const activeTabId = useAtomValue(activeTabIdAtom)

  // 统一可见性计算：以当前可见性为 prev 走滞后带，窗口停在临界值附近不反复横跳
  React.useEffect(() => {
    const layout = getCurrentLayout()
    const prev = store.get(panelVisibilityAtom)
    const vis = computeVisibility(windowWidth, layout, prev)
    const cur = store.get(panelVisibilityAtom)
    if (vis.filePanel !== cur.filePanel) {
      setPanelVisibility(vis)
    }
  }, [windowWidth, appMode, sessionId, sidebarCollapsed, sidePanelOpen, layoutScopeActive, tabGroups, activeTabId, setPanelVisibility])
}
