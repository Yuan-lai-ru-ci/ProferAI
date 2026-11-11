/**
 * rail.tsx — 常驻图标列（54px）
 *
 * 侧栏改成「rail 常驻 + 列表可收起」后，rail 是唯一的全局导航层：
 *   panel toggle
 *   ── Agent / Chat
 *   ── Todo / 日程 / 定时任务 / Agent 技能 / Agent 记忆 / 插件
 *   （弹性留白）
 *   余额 / 头像（设置）
 *
 * 规划中心拆成三个并列入口：它们共享 activeView='planning'，
 * 由 planningTab 决定显示哪个分区，选中态也按分区分别判断。
 *
 * 展开与收起只影响右侧列表是否渲染，rail 本身不换视图，
 * 因此图标列在两种状态下位置完全一致（顶部留白同为 50 / 32）。
 */

import * as React from 'react'
import { PluginSidebarEntries } from '@/components/plugins/PluginEntries'
import { GOAL_OVERVIEW_ENTRY_ENABLED } from '@/lib/product-feature-flags'
import { PanelLeftClose, PanelLeftOpen, Bot, MessageSquare, Plus, Search, CalendarDays, Clock, ListTodo, Blocks, Brain, Target, UserRound } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipTrigger, TooltipContent } from '@profer/ui/primitives/tooltip'
import { CollapsedWorkspacePopover } from '@/components/agent/CollapsedWorkspacePopover'
import { SidebarBalanceBar } from '@/components/app-shell/SidebarBalanceBar'
import { isCommercialBuild } from '@/lib/build-target'
import { UserAvatar } from '@/components/chat/UserAvatar'
import {
  PLANNING_NAV_ITEM,
  RAIL_BUTTON_ACTIVE_CLASS,
  RAIL_BUTTON_CLASS,
  RAIL_BUTTON_IDLE_CLASS,
  RailSeparator,
  SidebarRailEntry,
} from './navigation-items'
import { getActiveAccelerator, getAcceleratorDisplay } from '@/lib/shortcut-registry'
import type { SidebarModel } from './use-left-sidebar'

/** 侧栏 Goal 入口的 tooltip：把「在跑」和「等你处理」分开说清楚。 */
function describeGoalRailTooltip(counts: { live: number; running: number; attention: number }): string {
  if (counts.live === 0) return 'Goal（当前没有目标）'
  const parts = [`${counts.live} 个目标`]
  if (counts.running > 0) parts.push(`${counts.running} 个在跑`)
  if (counts.attention > 0) parts.push(`${counts.attention} 个待处理`)
  return `Goal（${parts.join(' · ')}）`
}

export function SidebarRail({ s, topOffset }: { s: SidebarModel; topOffset: number }): React.ReactElement {
  const {
    sidebarCollapsed,
    setSidebarCollapsed,
    handleRailModeSwitch,
    mode,
    handleNewAgentSession,
    handleNewConversation,
    setSearchDialogOpen,
    automationCount,
    goalRailCounts,
    todoOpenCount,
    todayCalendarCount,
    planningTab,
    handleOpenPlanning,
    activeView,
    handleOpenSkills,
    handleOpenMemory,
    handleOpenUserProfile,
    capabilities,
    setSettingsOpen,
    userProfile,
    hasUpdate,
    hasEnvironmentIssues,
  } = s

  const collapseShortcut = navigator.platform.includes('Mac') ? '⌘B' : 'Ctrl+B'
  const newShortcut = getAcceleratorDisplay(getActiveAccelerator('new-session'))
  const skillsUpdateCount = capabilities?.skills.filter((skill) => skill.hasUpdate).length ?? 0

  const agentModeButton = (
    <button
      type="button"
      aria-label="切换到 Agent 模式"
      aria-current={mode === 'agent' ? 'page' : undefined}
      onClick={() => handleRailModeSwitch('agent')}
      className={cn(RAIL_BUTTON_CLASS, mode === 'agent' ? RAIL_BUTTON_ACTIVE_CLASS : RAIL_BUTTON_IDLE_CLASS)}
    >
      {mode === 'agent' && (
        <span
          aria-hidden="true"
          className="absolute -left-[7px] top-[11px] h-[14px] w-[2px] rounded-[2px] bg-primary"
        />
      )}
      <Bot size={19} />
    </button>
  )

  return (
    <div
      data-profer-rail=""
      className="relative flex h-full w-full flex-col items-center gap-[3px] overflow-y-auto scrollbar-none pb-2.5"
      style={{ paddingTop: topOffset }}
    >
      {/* 列表开关：展开时收起、收起时展开 */}
      <SidebarRailEntry
        icon={sidebarCollapsed ? <PanelLeftOpen size={19} /> : <PanelLeftClose size={19} />}
        label={sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'}
        tooltip={`${sidebarCollapsed ? '展开' : '收起'}侧边栏 (${collapseShortcut})`}
        onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
      />

      {/* 收起态没有列表，新建与搜索必须留在 rail 上，否则收起后无法开始新会话 */}
      {sidebarCollapsed && (
        <>
          <SidebarRailEntry
            icon={<Plus size={19} />}
            label={mode === 'agent' ? '新建 Agent 会话' : '新建 Chat 对话'}
            tooltip={
              <>
                {mode === 'agent' ? '新会话' : '新对话'}
                {newShortcut ? ` (${newShortcut})` : ''}
              </>
            }
            onClick={mode === 'agent' ? handleNewAgentSession : handleNewConversation}
            navigationItem="new-session"
          />
          <SidebarRailEntry
            icon={<Search size={19} />}
            label="搜索"
            tooltip="搜索会话"
            onClick={() => setSearchDialogOpen(true)}
          />
        </>
      )}

      {/* 展开态：Agent/Chat 切换由列表顶部的 ModeSwitcher 承担，rail 只留一条分隔线。
          收起态：没有列表，模式切换必须留在 rail 上（Agent 按钮悬停可预览工作区）。 */}
      {sidebarCollapsed ? (
        <>
          <RailSeparator className="mt-[2px]" />
          <div className="flex flex-col items-center gap-[3px]" data-tour="mode-switch">
            <CollapsedWorkspacePopover>{agentModeButton}</CollapsedWorkspacePopover>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label="切换到 Chat 模式"
                  aria-current={mode === 'chat' ? 'page' : undefined}
                  onClick={() => handleRailModeSwitch('chat')}
                  className={cn(RAIL_BUTTON_CLASS, mode === 'chat' ? RAIL_BUTTON_ACTIVE_CLASS : RAIL_BUTTON_IDLE_CLASS)}
                >
                  {mode === 'chat' && (
                    <span
                      aria-hidden="true"
                      className="absolute -left-[7px] top-[11px] h-[14px] w-[2px] rounded-[2px] bg-primary"
                    />
                  )}
                  <MessageSquare size={19} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="right">Chat 模式</TooltipContent>
            </Tooltip>
          </div>
          <RailSeparator />
        </>
      ) : (
        <RailSeparator className="mt-[2px]" />
      )}

      {/* 功能入口：Todo / 日程 / 定时任务 / Agent 技能 / Agent 记忆 / 插件页面。
          规划中心原先是一个入口 + 内部三个 tab；拆分后 rail 直接给出三个并列入口，
          主窗口内的 tab 条随之下线（独立规划窗口仍保留 tab）。
          记忆原先也是技能页里的一个 tab，拆出来后与技能页并列，不再需要先进能力管理页。 */}
      <SidebarRailEntry
        icon={<ListTodo size={19} />}
        label={`Todo，${todoOpenCount} 项待完成`}
        tooltip={`Todo（${todoOpenCount} 项待完成）`}
        active={activeView === 'planning' && planningTab === 'todos'}
        onClick={() => handleOpenPlanning('todos')}
        navigationItem={PLANNING_NAV_ITEM.todos}
      />
      <SidebarRailEntry
        icon={<CalendarDays size={19} />}
        label={`日程，今天 ${todayCalendarCount} 个安排`}
        tooltip={`日程（今天 ${todayCalendarCount} 个安排）`}
        active={activeView === 'planning' && planningTab === 'calendar'}
        onClick={() => handleOpenPlanning('calendar')}
        navigationItem={PLANNING_NAV_ITEM.calendar}
      />
      <SidebarRailEntry
        icon={<Clock size={19} />}
        label={`定时任务，${automationCount} 个任务`}
        tooltip={`定时任务（${automationCount} 个）`}
        active={activeView === 'planning' && planningTab === 'automations'}
        onClick={() => handleOpenPlanning('automations')}
        navigationItem={PLANNING_NAV_ITEM.automations}
      />
      {/* Goal 跨会话总览入口暂时雪藏（GOAL_OVERVIEW_ENTRY_ENABLED = false）。
          Goal 本身在会话内可用，不需要从侧栏进入；恢复只改开关，组件与数据都在。
          计数用「N 个目标」而不是「N 个进行中」，因为暂停/受阻/预算耗尽都还没结束；
          角标只在受阻或预算耗尽时亮——正在跑的目标不需要你管。 */}
      {GOAL_OVERVIEW_ENTRY_ENABLED && (
        <SidebarRailEntry
          icon={<Target size={19} />}
          label={goalRailCounts.live > 0 ? `Goal，${goalRailCounts.live} 个目标` : 'Goal'}
          tooltip={describeGoalRailTooltip(goalRailCounts)}
          active={activeView === 'planning' && planningTab === 'goals'}
          dot={goalRailCounts.attention > 0}
          onClick={() => handleOpenPlanning('goals')}
          navigationItem={PLANNING_NAV_ITEM.goals}
        />
      )}
      {mode === 'agent' && (
        <SidebarRailEntry
          icon={<Blocks size={19} />}
          label={`Agent 技能，${capabilities?.skills.length ?? 0} 个能力${skillsUpdateCount > 0 ? `，${skillsUpdateCount} 个可更新` : ''}`}
          tooltip={skillsUpdateCount > 0 ? `Agent 技能（${skillsUpdateCount} 个可更新）` : 'Agent 技能'}
          active={activeView === 'agent-skills'}
          dot={skillsUpdateCount > 0}
          onClick={handleOpenSkills}
          navigationItem="agent-skills"
        />
      )}
      {mode === 'agent' && (
        <SidebarRailEntry
          icon={<Brain size={19} />}
          label="Agent 记忆"
          tooltip="Agent 记忆（工作区长期记忆）"
          active={activeView === 'agent-memory'}
          onClick={handleOpenMemory}
          navigationItem="agent-memory"
        />
      )}
      <SidebarRailEntry
        icon={<UserRound size={19} />}
        label="我的画像"
        tooltip="我的画像（所有工作区共享）"
        active={activeView === 'user-profile'}
        onClick={handleOpenUserProfile}
        navigationItem="user-profile"
      />
      <PluginSidebarEntries collapsed />

      <div className="min-h-0 flex-1" />

      {/* 身份区：余额 + 头像（点击进设置）
          积分条属于商业版（额度/会员），开源版没有账号体系，不渲染也不轮询余额。 */}
      {isCommercialBuild() ? <SidebarBalanceBar collapsed /> : null}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label="打开设置"
            onClick={() => setSettingsOpen(true)}
            className={cn(RAIL_BUTTON_CLASS, RAIL_BUTTON_IDLE_CLASS)}
          >
            <UserAvatar avatar={userProfile.avatar} size={28} />
            {(hasUpdate || hasEnvironmentIssues) && (
              <span className="absolute right-[7px] top-[7px] size-[5px] rounded-full bg-red-500" />
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">设置</TooltipContent>
      </Tooltip>
    </div>
  )
}
