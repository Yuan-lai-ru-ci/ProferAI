/**
 * rail.tsx — 折叠态（mini rail）
 *
 * 从 LeftSidebar 抽离的折叠态图标视图。通过 SidebarModel 读取状态与 handler。
 */

import * as React from 'react'
import { PanelLeftOpen, Bot, MessageSquare, Plus, Search, CalendarDays, Blocks } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { CollapsedWorkspacePopover } from '@/components/agent/CollapsedWorkspacePopover'
import { SidebarBalanceBar } from '@/components/app-shell/SidebarBalanceBar'
import { UserAvatar } from '@/components/chat/UserAvatar'
import { SidebarWindowDragStrip, SIDEBAR_DRAG_STRIP_HEIGHT } from './navigation-items'
import { RailRecentButton } from './session-items'
import { formatAutomationCount } from './sidebar-utils'
import type { SidebarModel } from './use-left-sidebar'

export function SidebarRail({ s }: { s: SidebarModel }): React.ReactElement {
  const {
    isMac,
    setSidebarCollapsed,
    handleRailModeSwitch,
    mode,
    handleNewAgentSession,
    handleNewConversation,
    setSearchDialogOpen,
    tabletMode,
    automationCount,
    handleOpenAutomations,
    activeView,
    handleOpenSkills,
    capabilities,
    railRecentItems,
    handleSelectAgentSession,
    handleSelectConversation,
    setSettingsOpen,
    userProfile,
    hasUpdate,
    hasEnvironmentIssues,
  } = s

  return (
    <div className="relative h-full flex flex-col items-center px-2">
        <SidebarWindowDragStrip
          height={isMac ? SIDEBAR_DRAG_STRIP_HEIGHT.collapsedMac : SIDEBAR_DRAG_STRIP_HEIGHT.collapsed}
        />

        {/* macOS 需要避开左上角红绿灯；边栏覆盖全局标题栏拖拽层，因此留白自身也要可拖拽。 */}
        <div className={cn('w-full flex-shrink-0 titlebar-drag-region', isMac ? 'h-[50px]' : 'h-2')} />

        {/* 展开按钮：mini rail 的唯一布局控制入口 */}
        <div className="pt-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="展开侧边栏"
                onClick={() => setSidebarCollapsed(false)}
                className="size-10 flex items-center justify-center rounded-[12px] text-foreground/60 bg-muted hover:bg-foreground/[0.08] hover:text-foreground transition-colors titlebar-no-drag"
              >
                <PanelLeftOpen size={17} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">展开侧边栏 ({navigator.platform.includes('Mac') ? '⌘B' : 'Ctrl+B'})</TooltipContent>
          </Tooltip>
        </div>

        <div className="my-3 h-px w-8 bg-border/70" />

        {/* 模式切换 */}
        <div className="flex flex-col items-center gap-1.5">
          <CollapsedWorkspacePopover>
            <button
              type="button"
              aria-label="切换到 Agent 模式（悬停查看项目）"
              onClick={() => handleRailModeSwitch('agent')}
              className={cn(
                'relative size-10 flex items-center justify-center rounded-[12px] transition-colors titlebar-no-drag',
                mode === 'agent'
                  ? 'bg-primary/10 text-foreground shadow-[0_1px_2px_0_rgba(0,0,0,0.05)]'
                  : 'text-foreground/45 hover:bg-foreground/[0.06] hover:text-foreground/75'
              )}
            >
              <Bot size={18} />
            </button>
          </CollapsedWorkspacePopover>

          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="切换到 Chat 模式"
                onClick={() => handleRailModeSwitch('chat')}
                className={cn(
                  'relative size-10 flex items-center justify-center rounded-[12px] transition-colors titlebar-no-drag',
                  mode === 'chat'
                    ? 'bg-primary/10 text-foreground shadow-[0_1px_2px_0_rgba(0,0,0,0.05)]'
                    : 'text-foreground/45 hover:bg-foreground/[0.06] hover:text-foreground/75'
                )}
              >
                <MessageSquare size={17} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">Chat 模式</TooltipContent>
          </Tooltip>
        </div>

        <div className="my-3 h-px w-8 bg-border/70" />

        {/* 高频操作 */}
        <div className="flex flex-col items-center gap-1.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={mode === 'agent' ? '新建 Agent 会话' : '新建 Chat 对话'}
                data-profer-navigation-item="new-session"
                onClick={mode === 'agent' ? handleNewAgentSession : handleNewConversation}
                className="size-10 flex items-center justify-center rounded-[12px] text-foreground/70 bg-primary/5 hover:bg-primary/10 hover:text-foreground transition-[background-color,border-color,color] duration-150 titlebar-no-drag border border-border/60 hover:border-border"
              >
                <Plus size={16} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">
              {mode === 'agent' ? '新会话' : '新对话'}
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="搜索"
                onClick={() => setSearchDialogOpen(true)}
                className="size-10 flex items-center justify-center rounded-[12px] text-foreground/45 bg-primary/5 hover:bg-primary/10 hover:text-foreground/70 transition-[background-color,border-color,color] duration-150 titlebar-no-drag border border-border/60 hover:border-border"
              >
                <Search size={16} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">搜索</TooltipContent>
          </Tooltip>

          {/* 规划中心入口：平板版隐藏（无规划中心能力），与展开态保持一致 */}
          {!tabletMode && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={`规划中心，${automationCount} 个定时任务`}
                data-profer-navigation-item="planning"
                onClick={handleOpenAutomations}
                className={cn(
                  'relative size-10 flex items-center justify-center rounded-[12px] transition-colors titlebar-no-drag border',
                  activeView === 'planning'
                    ? 'border-primary/80 bg-primary text-primary-foreground shadow-sm'
                    : 'border-border/45 bg-foreground/[0.025] text-foreground/45 hover:border-border/70 hover:bg-foreground/[0.045] hover:text-primary',
                )}
              >
                <CalendarDays size={16} />
                {automationCount > 0 && (
                  <span
                    className={cn(
                      'absolute -top-1 -right-1 flex h-4 min-w-[16px] items-center justify-center rounded-full px-1 text-[10px] font-medium tabular-nums',
                      activeView === 'planning'
                        ? 'bg-primary-foreground text-primary'
                        : 'bg-primary text-primary-foreground',
                    )}
                  >
                    {formatAutomationCount(automationCount)}
                  </span>
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">
              规划中心（{automationCount} 个定时任务）
            </TooltipContent>
          </Tooltip>
          )}

          {/* Agent 技能入口：平板版隐藏（无 Agent 技能能力），与展开态保持一致 */}
          {mode === 'agent' && !tabletMode && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label="Agent 技能"
                  data-profer-navigation-item="agent-skills"
                  onClick={handleOpenSkills}
                  className={cn(
                    'relative size-10 flex items-center justify-center rounded-[12px] transition-colors titlebar-no-drag border',
                    activeView === 'agent-skills'
                      ? 'border-primary/80 bg-primary text-primary-foreground shadow-sm'
                      : 'border-border/45 bg-foreground/[0.025] text-foreground/45 hover:border-border/70 hover:bg-foreground/[0.045] hover:text-primary',
                  )}
                >
                  <Blocks size={16} />
                  {(capabilities?.skills.filter((s) => s.hasUpdate).length ?? 0) > 0 && (
                    <span className="absolute -top-1 -right-1 size-2.5 rounded-full bg-blue-500" />
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent side="right">Agent 技能</TooltipContent>
            </Tooltip>
          )}
        </div>

        <div className="my-3 h-px w-8 bg-border/70" />

        {/* 最近/关键会话入口 */}
        <div className="flex-1 min-h-0 w-full overflow-y-auto scrollbar-thin">
          <div className="flex flex-col items-center gap-1.5 pb-2">
            {railRecentItems.map((item) => (
              <RailRecentButton
                key={`${item.type}-${item.id}`}
                item={item}
                onSelect={(selected) => {
                  if (selected.type === 'agent') {
                    handleSelectAgentSession(selected.id, selected.title)
                  } else {
                    handleSelectConversation(selected.id, selected.title)
                  }
                }}
              />
            ))}
          </div>
        </div>

        {/* 用户头像（点击打开设置） */}
        <div className="pt-3 pb-3">
          {/* 余额图标（仅代管模式显示） */}
          <div className="px-1 pb-2">
            <SidebarBalanceBar collapsed />
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="打开设置"
                onClick={() => setSettingsOpen(true)}
                className="relative size-10 flex items-center justify-center rounded-[12px] transition-colors titlebar-no-drag hover:bg-foreground/5"
              >
                <UserAvatar avatar={userProfile.avatar} size={28} />
                {(hasUpdate || hasEnvironmentIssues) && (
                  <span className="absolute top-0 right-0 w-2 h-2 rounded-full bg-red-500" />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">设置</TooltipContent>
          </Tooltip>
        </div>
      </div>
  )
}
