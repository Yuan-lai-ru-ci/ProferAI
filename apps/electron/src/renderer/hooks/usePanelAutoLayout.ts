/**
 * 面板自适应可见性 — 统一驱动 hook + 模块级 API
 *
 * 模型：面板的「展开意图 A」与「实际可见 B」分离。
 * - A（browserOpenMap / agentSidePanelOpenAtom）只随用户手动操作变化；
 * - B（panelVisibilityAtom）由本 hook 依据窗口宽度统一计算，窗口变窄只让 B 变 false，A 保持不变；
 * - 窗口拉宽后，A=true 的面板自动显示。
 *
 * 参与自动可见性判定的面板：浏览器、右侧文件面板；左侧栏保持纯手动行为。
 * 状态收敛到本模块：单一 window resize 监听 + 唯一可见性计算 effect，
 * 避免 MainArea / AppShell / TabBar 各自订阅窗口造成竞态。
 */

import * as React from 'react'
import { getDefaultStore, useAtomValue, useSetAtom } from 'jotai'
import { toast } from 'sonner'
import {
  windowWidthAtom,
  layoutScopeActiveAtom,
  panelVisibilityAtom,
} from '@/atoms/panel-layout-atoms'
import { browserPanelOpenMapAtom } from '@/atoms/browser-atoms'
import { agentSidePanelOpenAtom, currentAgentSessionIdAtom } from '@/atoms/agent-atoms'
import { sidebarCollapsedAtom } from '@/atoms/tab-atoms'
import { appModeAtom } from '@/atoms/app-mode'
import {
  computeVisibility,
  type PanelLayoutState,
  type PanelVisibility,
} from '@/lib/panel-layout'

/** 全局默认 store（模块级函数与 React 组件共享同一实例） */
const store = getDefaultStore()

/**
 * 从 store 派生当前布局（sidebar 为实际展开；filePanel/browser 为展开意图 A）。
 * 文件面板/浏览器仅在 agent 个人视图（layoutScopeActive）参与判定。
 */
function getCurrentLayout(): PanelLayoutState {
  const scopeActive = store.get(layoutScopeActiveAtom)
  const appMode = store.get(appModeAtom)
  const sessionId = store.get(currentAgentSessionIdAtom)
  const agentSessionActive = scopeActive && appMode === 'agent' && !!sessionId
  return {
    sidebar: !store.get(sidebarCollapsedAtom),
    filePanel: agentSessionActive && store.get(agentSidePanelOpenAtom),
    browser: agentSessionActive && (sessionId ? store.get(browserPanelOpenMapAtom).get(sessionId) === true : false),
  }
}

/**
 * 显式打开动作后的可见性：目标面板按「曾可见」普通阈值判定（不叠加滞后带，避免「打开却不可见」死区），
 * 其他面板保留当前可见性作为 prev（维持其滞后状态，不会因打开另一面板而意外显示）。
 */
function applyOpenVisibility(panel: 'browser' | 'file-panel', layout: PanelLayoutState, windowWidth: number): PanelVisibility {
  const current = store.get(panelVisibilityAtom)
  const prev: PanelVisibility = {
    filePanel: panel === 'file-panel' ? true : current.filePanel,
    browser: panel === 'browser' ? true : current.browser,
  }
  const vis = computeVisibility(windowWidth, layout, prev)
  store.set(panelVisibilityAtom, vis)
  return vis
}

/**
 * 手动打开文件面板：置展开意图 A=true（窗口不足时仅不可见，A 保持）。
 * 窗口不足 → toast 提示，图标随后由 TabBar 依据 A 高亮。
 */
export function openFilePanel(): void {
  store.set(agentSidePanelOpenAtom, true)
  const windowWidth = store.get(windowWidthAtom)
  const layout = getCurrentLayout()
  const vis = applyOpenVisibility('file-panel', layout, windowWidth)
  if (!vis.filePanel) {
    toast.message('文件面板已打开，当前窗口宽度不足暂不可见，拉大窗口后自动显示')
  }
}

/**
 * Agent/状态推送驱动打开浏览器（MainArea 的 BROWSER_STATE_CHANGED 入口，也用于手动打开后落地）。
 * - 空间足够：正常打开显示；
 * - 空间不足：A 保持 open，暂不可见，首次 toast，不腾让文件面板/左侧栏；
 * - 后台会话：仅记录打开意图，激活时由可见性判定。
 */
export function openBrowserFromPush(sessionId: string): void {
  const alreadyOpen = store.get(browserPanelOpenMapAtom).get(sessionId) === true
  store.set(browserPanelOpenMapAtom, (prev) => {
    if (prev.get(sessionId) === true) return prev
    const next = new Map(prev)
    next.set(sessionId, true)
    return next
  })
  if (sessionId !== store.get(currentAgentSessionIdAtom)) return
  const windowWidth = store.get(windowWidthAtom)
  const layout = getCurrentLayout()
  const vis = applyOpenVisibility('browser', layout, windowWidth)
  if (!vis.browser && !alreadyOpen) {
    toast.message('受管浏览器已打开，当前窗口宽度不足暂不可见，拉大窗口后自动显示')
  }
}

export interface UsePanelAutoLayoutOptions {
  /** 文件面板/浏览器是否参与当前布局（agent 个人视图）。AppShell 依据视图作用域传入。 */
  filePanelActive?: boolean
}

/**
 * 挂载在 AppShell（始终渲染的布局容器），驱动浏览器/文件面板可见性。
 * 组件如需查询布局状态，直接读取 panelVisibilityAtom / 调用模块级函数（openFilePanel 等）。
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
  const browserOpenMap = useAtomValue(browserPanelOpenMapAtom)
  const layoutScopeActive = useAtomValue(layoutScopeActiveAtom)

  // 统一可见性计算：以当前可见性为 prev 走滞后带，窗口停在临界值附近不反复横跳
  React.useEffect(() => {
    const layout = getCurrentLayout()
    const prev = store.get(panelVisibilityAtom)
    const vis = computeVisibility(windowWidth, layout, prev)
    const cur = store.get(panelVisibilityAtom)
    if (vis.browser !== cur.browser || vis.filePanel !== cur.filePanel) {
      setPanelVisibility(vis)
    }
  }, [windowWidth, appMode, sessionId, sidebarCollapsed, sidePanelOpen, browserOpenMap, layoutScopeActive, setPanelVisibility])
}
