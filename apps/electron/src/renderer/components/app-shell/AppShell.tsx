/**
 * AppShell - 应用主布局容器
 *
 * 布局结构：[LeftSidebar 可折叠] | [MainArea: TabBar + TabContent] | [RightSidePanel 可折叠]
 *
 * MainArea 支持多标签页，Settings 视图为独立覆盖。
 */

import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { LeftSidebar } from './LeftSidebar'
import { RightSidePanel } from './RightSidePanel'
import { MainArea } from '@/components/tabs/MainArea'
import { TabBar } from '@/components/tabs/TabBar'
import { TeamWorkspaceView } from '@/components/agent/TeamWorkspaceView'
import { WindowControlsTemplateProvider } from '@/components/WindowControlsTemplate'
import { AppShellProvider, type AppShellContextType } from '@/contexts/AppShellContext'
import { appModeAtom } from '@/atoms/app-mode'
import { agentSidePanelOpenAtom, agentSidePanelWidthAtom, currentAgentSessionIdAtom, agentWorkspacesAtom, currentAgentWorkspaceIdAtom } from '@/atoms/agent-atoms'
import { panelVisibilityAtom } from '@/atoms/panel-layout-atoms'
import { automationFormAtom } from '@/atoms/automation-atoms'
import { activeViewAtom } from '@/atoms/active-view'
import { leftSidebarWidthAtom } from '@/atoms/sidebar-atoms'
import { sidebarCollapsedAtom } from '@/atoms/tab-atoms'
import { detectIsWindows } from '@/lib/platform'
import { interfaceVariantAtom } from '@/atoms/theme'
import { usePanelAutoLayout } from '@/hooks/usePanelAutoLayout'
import { cn } from '@/lib/utils'

const MIN_RIGHT_PANEL_WIDTH = 300
const MAX_RIGHT_PANEL_WIDTH = 560

const MIN_LEFT_SIDEBAR_WIDTH = 300
const MAX_LEFT_SIDEBAR_WIDTH = 420

function clampRightPanelWidth(width: number): number {
  return Math.max(MIN_RIGHT_PANEL_WIDTH, Math.min(MAX_RIGHT_PANEL_WIDTH, width))
}

function clampLeftSidebarWidth(width: number): number {
  return Math.max(MIN_LEFT_SIDEBAR_WIDTH, Math.min(MAX_LEFT_SIDEBAR_WIDTH, width))
}

export interface AppShellProps {
  /** Context 值，用于传递给子组件 */
  contextValue: AppShellContextType
}

export function AppShell({ contextValue }: AppShellProps): React.ReactElement {
  const appMode = useAtomValue(appModeAtom)
  const currentSessionId = useAtomValue(currentAgentSessionIdAtom)
  const interfaceVariant = useAtomValue(interfaceVariantAtom)
  const isClassic = interfaceVariant === 'classic'
  const filePanelVisible = useAtomValue(panelVisibilityAtom).filePanel
  const setSidePanelOpen = useSetAtom(agentSidePanelOpenAtom)

  // 聚焦右侧面板（profer:focus-right-panel 事件，来自快捷键/全局提示）
  React.useEffect(() => {
    const focusRightPanel = (): void => {
      setSidePanelOpen(true)
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const panel = document.querySelector<HTMLElement>('[data-profer-navigation-region="right-panel"]')
          const target = panel && Array.from(panel.querySelectorAll<HTMLElement>(
            'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
          )).find((element) => element.offsetParent !== null)
          target?.focus()
        })
      })
    }
    window.addEventListener('profer:focus-right-panel', focusRightPanel)
    return () => window.removeEventListener('profer:focus-right-panel', focusRightPanel)
  }, [setSidePanelOpen])

  const automationForm = useAtomValue(automationFormAtom)
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const currentWorkspaceId = useAtomValue(currentAgentWorkspaceIdAtom)
  const currentWorkspace = workspaces.find((w) => w.id === currentWorkspaceId)
  const isTeamWorkspace = currentWorkspace?.type === 'team'
  // 定时任务表单打开时隐藏右侧文件面板，让中间区域扩展到全宽（表单内含自己的右栏配置）
  const activeView = useAtomValue(activeViewAtom)
  const showRightPanel = appMode === 'agent' && !!currentSessionId && !automationForm.open && activeView !== 'planning' && activeView !== 'agent-skills'
  // 文件面板/浏览器仅在 agent 个人视图参与布局判定（团队/规划/自动化表单时右侧面板不渲染）
  const filePanelActive = !isTeamWorkspace && showRightPanel
  // 统一自适应可见性：窗口 resize 监听 + 浏览器/文件面板可见性计算（挂载于此布局容器）
  usePanelAutoLayout({ filePanelActive })
  const isWindows = React.useMemo(() => detectIsWindows(), [])
  // 团队工作区的默认 Agent 页仍展示文件主区；规划中心必须进入 MainArea，
  // 否则 TeamWorkspaceView 会覆盖其中的 PlanningView。
  const showTeamWorkspaceView = isTeamWorkspace && appMode === 'agent' && activeView !== 'agent-skills' && activeView !== 'planning'

  // 窗口标题设为用户名
  React.useEffect(() => {
    try {
      const raw = localStorage.getItem('profer-user-profile')
      if (raw) {
        const profile = JSON.parse(raw)
        if (profile?.userName) {
          document.title = profile.userName
        }
      }
    } catch { /* ignore */ }
  }, [])

  // 右侧面板可拖拽宽度
  const [rightPanelWidth, setRightPanelWidth] = useAtom(agentSidePanelWidthAtom)
  const dragging = React.useRef(false)
  const clampedRightPanelWidth = clampRightPanelWidth(rightPanelWidth)

  React.useEffect(() => {
    if (clampedRightPanelWidth !== rightPanelWidth) {
      setRightPanelWidth(clampedRightPanelWidth)
    }
  }, [clampedRightPanelWidth, rightPanelWidth, setRightPanelWidth])

  const handleMouseDown = React.useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    dragging.current = true
    const startX = e.clientX
    const startWidth = clampedRightPanelWidth
    let rafId = 0

    const onMouseMove = (ev: MouseEvent) => {
      if (!dragging.current) return
      if (rafId) return
      rafId = requestAnimationFrame(() => {
        rafId = 0
        const delta = startX - ev.clientX
        const newWidth = clampRightPanelWidth(startWidth + delta)
        setRightPanelWidth(newWidth)
      })
    }

    const onMouseUp = () => {
      dragging.current = false
      if (rafId) cancelAnimationFrame(rafId)
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }

    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [clampedRightPanelWidth, setRightPanelWidth])

  // 左侧边栏可拖拽宽度
  const [leftSidebarWidth, setLeftSidebarWidth] = useAtom(leftSidebarWidthAtom)
  const sidebarCollapsed = useAtomValue(sidebarCollapsedAtom)
  const leftDragging = React.useRef(false)
  const [isDraggingLeftSidebar, setIsDraggingLeftSidebar] = React.useState(false)
  const clampedLeftSidebarWidth = clampLeftSidebarWidth(leftSidebarWidth)

  React.useEffect(() => {
    if (clampedLeftSidebarWidth !== leftSidebarWidth) {
      setLeftSidebarWidth(clampedLeftSidebarWidth)
    }
  }, [clampedLeftSidebarWidth, leftSidebarWidth, setLeftSidebarWidth])

  const handleLeftSidebarMouseDown = React.useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    leftDragging.current = true
    setIsDraggingLeftSidebar(true)
    const startX = e.clientX
    const startWidth = clampedLeftSidebarWidth
    let latestClientX = startX
    let rafId = 0

    const applyWidth = () => {
      const delta = latestClientX - startX
      setLeftSidebarWidth(clampLeftSidebarWidth(startWidth + delta))
    }

    const onMouseMove = (ev: MouseEvent) => {
      if (!leftDragging.current) return
      latestClientX = ev.clientX
      if (rafId) return
      rafId = requestAnimationFrame(() => {
        rafId = 0
        applyWidth()
      })
    }

    const onMouseUp = () => {
      leftDragging.current = false
      setIsDraggingLeftSidebar(false)
      if (rafId) {
        cancelAnimationFrame(rafId)
        rafId = 0
      }
      applyWidth()
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }

    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [clampedLeftSidebarWidth, setLeftSidebarWidth])

  return (
    <WindowControlsTemplateProvider>
    <AppShellProvider value={contextValue}>
      {/* 只保留顶端 8px 的全局拖拽缝隙。
          过去这里覆盖 50px 高的固定 drag-region；它会和 TabBar 内的 no-drag
          控件重叠。Electron 的原生 app-region 命中并不总是遵循 CSS z-index，
          尤其当皮肤为 TabBar 创建 backdrop-filter 合成层时，Tab、工具按钮会被
          误判为窗口拖动区而不可点击。TabBar、侧栏和各独立视图已经各自提供
          局部 drag region，因此全局层不能覆盖任何实际交互区域。 */}
      <div
        className={cn(
          'titlebar-drag-region fixed top-0 left-0 h-2 z-50',
          isWindows ? 'right-[126px]' : 'right-0'
        )}
      />

      <div className="shell-bg h-screen w-screen flex overflow-clip bg-surface-shell">
        {/* 左侧边栏：可折叠，可拖拽调整宽度 */}
        <div
          className={cn(
            isClassic ? 'p-2 pr-0' : '',
            // 收起 rail 必须压过其右侧的分隔线；冷启动直接恢复收起状态时，
            // 分隔线处于更高层会裁掉 rail 最右侧，造成整列图标视觉上向左偏移。
            sidebarCollapsed ? 'relative z-[62] flex-none crt-sidebar' : 'relative z-[70] flex-none crt-sidebar',
          )}
        >
          <LeftSidebar width={clampedLeftSidebarWidth} noTransition={isDraggingLeftSidebar} />
          {/* 左栏复用主区既有的 8px 外边距作为拖动命中区：不额外占宽度，也不覆盖侧栏滚动条。 */}
          {!sidebarCollapsed && (
            <div
              className="titlebar-no-drag absolute left-full top-0 bottom-0 z-[80] w-1.5 translate-x-px cursor-col-resize pointer-events-auto"
              onMouseDown={handleLeftSidebarMouseDown}
              role="separator"
              aria-orientation="vertical"
              aria-label="调整左侧边栏宽度"
            />
          )}
        </div>

        {/* 中间容器 */}
        <div className="main-area-glass-host flex-1 min-w-0 p-2 relative z-[60]">
          {/* 团队工作区也必须挂载统一顶栏；否则团队页面与个人页面各自拥有一套入口，
              标签切换、关闭和拖拽排序会与团队 Agent 面板脱节。 */}
          {showTeamWorkspaceView ? (
            <div className="flex h-full min-h-0 flex-col">
              <TabBar teamMode />
              <div className="min-h-0 flex-1">
                <TeamWorkspaceView />
              </div>
            </div>
          ) : (
            <MainArea />
          )}
        </div>

        {/* 右侧边栏：个人模式显示文件面板；团队模式文件已在主区域。
            实际可见由 filePanelVisible（意图 A + 窗口足够）驱动；SidePanel 内部按此做宽度过渡动画。 */}
        {!isTeamWorkspace && showRightPanel && (
          <div
            data-profer-navigation-region="right-panel"
            className={cn(
              // 只让 SidePanel 自身展开。若同时动画化外层 padding，面板会在横向展开时
              // 从 top: 0 平移到 p-2 的最终基线，视觉上像从右上方斜着滑入。
              filePanelVisible ? 'relative z-[70] flex items-stretch crt-sidebar p-2 pl-0' : 'relative z-[60] flex items-stretch crt-sidebar p-0'
            )}
          >
            <RightSidePanel width={clampedRightPanelWidth} />
            {/* 透明命中区收窄为 6px，仅落在现有中缝中心，不参与布局也不产生额外留白。 */}
            {filePanelVisible && (
              <div
                className="titlebar-no-drag absolute -left-[7px] top-0 bottom-0 z-[80] w-1.5 cursor-col-resize pointer-events-auto"
                onMouseDown={handleMouseDown}
                role="separator"
                aria-orientation="vertical"
                aria-label="调整右侧文件面板宽度"
              />
            )}
          </div>
        )}
      </div>
    </AppShellProvider>
    </WindowControlsTemplateProvider>
  )
}
