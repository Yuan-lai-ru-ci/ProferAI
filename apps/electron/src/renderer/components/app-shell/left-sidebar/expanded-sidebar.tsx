/**
 * expanded-sidebar.tsx — 展开态完整侧边栏
 *
 * 从 LeftSidebar 抽离的展开态视图。通过 SidebarModel 读取状态与 handler。
 */

import * as React from 'react'
import { PanelLeftClose, Plus, Search, FolderOpen, LogIn, Archive, ArchiveRestore, ArrowLeft, Settings } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { ModeSwitcher } from '../ModeSwitcher'
import { SidebarBalanceBar } from '@/components/app-shell/SidebarBalanceBar'
import { UserAvatar } from '@/components/chat/UserAvatar'
import { SidebarWindowDragStrip, SIDEBAR_DRAG_STRIP_HEIGHT, AutomationSidebarEntry, SkillsSidebarEntry, renderWorkspaceSortIcon } from './navigation-items'
import { ConversationItem, AgentSessionItem, DelegatedChildSessionItem, AgentProjectGroupItem, PINNED_SESSION_MAX_HEIGHT, getSessionLeftAccent } from './session-items'
import { WORKSPACE_SORT_LABEL } from './sidebar-utils'
import { getSessionTreeStatus, treeContainsSessionId, countCompletedDelegatedChildren } from './session-tree'
import { getActiveAccelerator, getAcceleratorDisplay } from '@/lib/shortcut-registry'
import type { SidebarModel } from './use-left-sidebar'

export function ExpandedSidebar({ s }: { s: SidebarModel }): React.ReactElement {
  const {
    isMac,
    setSidebarCollapsed,
    tabletMode,
    isClassic,
    mode,
    handleNewAgentSession,
    handleNewConversation,
    setSearchDialogOpen,
    automationCount,
    handleOpenAutomations,
    activeView,
    capabilities,
    handleOpenSkills,
    pinnedConversations,
    conversationDraftMap,
    activeSessionId,
    streamingIds,
    handleSelectConversation,
    handleRequestDelete,
    handleRename,
    handleTogglePin,
    handleToggleArchive,
    pinnedAgentSessionTrees,
    agentIndicatorMap,
    expandedDelegationParentIds,
    agentDraftIds,
    workspaceNameMap,
    handleSelectAgentSession,
    handleRequestMove,
    handleAgentRename,
    handleTogglePinAgent,
    handleToggleArchiveAgent,
    handleToggleDelegationParent,
    relativeTimeNow,
    workspaceSortMode,
    handleCycleWorkspaceSort,
    authStatus,
    accountCaps,
    handleStartJoinWorkspace,
    handleStartCreateProject,
    creatingProject,
    setCreatingProject,
    newProjectName,
    setNewProjectName,
    newProjectInputRef,
    handleCreateProjectKeyDown,
    agentProjectGroups,
    progressiveCount,
    currentWorkspaceId,
    expandedExtraCountMap,
    collapsedWorkspaceIds,
    dragProjectId,
    projectDropIndicator,
    handleShowMoreSessions,
    handleCollapseExtraSessions,
    handleSelectProject,
    handleToggleProjectCollapse,
    createAgentSessionInWorkspace,
    handleProjectDragStart,
    handleProjectDragOver,
    handleProjectDragLeave,
    handleProjectDrop,
    handleProjectDragEnd,
    setSettingsTab,
    setSettingsOpen,
    handleWorkspaceRename,
    handleRequestDeleteWorkspace,
    canDeleteWorkspace,
    workspaceSwitchTs,
    progressiveConversationGroups,
    progressiveAgentSessionGroups,
    archivedConversationCount,
    archivedAgentSessionCount,
    viewMode,
    setViewMode,
    userProfile,
    hasUpdate,
    hasEnvironmentIssues,
  } = s

  return (
    <div className="relative h-full flex flex-col overflow-hidden">
      <SidebarWindowDragStrip
        height={isMac ? SIDEBAR_DRAG_STRIP_HEIGHT.expandedMac : SIDEBAR_DRAG_STRIP_HEIGHT.expanded}
      />

      {/* macOS 需要避开左上角红绿灯；边栏覆盖全局标题栏拖拽层，因此留白自身也要可拖拽。 */}
      <div className={cn('w-full flex-shrink-0 titlebar-drag-region', isMac ? 'h-[30px]' : 'h-1')} />

      {/* 模式切换器（Agent/Chat，与桌面原版一致）+ 折叠按钮（原版位置；收起为 60px 窄图标条） */}
      <div className="titlebar-drag-region flex items-start gap-1.5 px-3">
        <div className="flex-1 min-w-0">
          <ModeSwitcher />
        </div>
        <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => setSidebarCollapsed(true)}
                className={cn(
                  'sidebar-collapse-button mt-2 size-10 flex-shrink-0 flex items-center justify-center rounded-[10px] text-foreground/40 titlebar-no-drag',
                  tabletMode && 'ml-auto',
                  isClassic
                    ? 'bg-muted hover:bg-foreground/[0.08] hover:text-foreground/60 transition-colors'
                    : 'bg-primary/5 hover:bg-primary/10 hover:text-foreground/60 transition-[background-color,border-color,color] duration-150 border border-border/60 hover:border-border'
                )}
              >
                <PanelLeftClose size={14} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">收起侧边栏 ({navigator.platform.includes('Mac') ? '⌘B' : 'Ctrl+B'})</TooltipContent>
          </Tooltip>
      </div>

      {/* 新对话/新会话按钮 + 搜索按钮 */}
      <div className="px-3 pt-2 flex items-center gap-1.5">
        <button
          data-profer-navigation-item="new-session"
          onClick={mode === 'agent' ? handleNewAgentSession : handleNewConversation}
          className="flex-1 flex items-center gap-2 px-3 py-2 rounded-[10px] text-[13px] font-medium text-foreground/70 bg-primary/5 hover:bg-primary/10 hover:text-foreground transition-[background-color,border-color,color] duration-150 titlebar-no-drag border border-border/60 hover:border-border"
        >
          <Plus size={14} />
          <span>{mode === 'agent' ? '新会话' : '新对话'}</span>
        </button>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={() => setSearchDialogOpen(true)}
              className="flex-shrink-0 size-[36px] flex items-center justify-center rounded-[10px] text-foreground/40 bg-primary/5 hover:bg-primary/10 hover:text-foreground/60 transition-[background-color,border-color,color] duration-150 titlebar-no-drag border border-border/60 hover:border-border"
            >
              <Search size={14} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">搜索 ({getAcceleratorDisplay(getActiveAccelerator('global-search'))})</TooltipContent>
        </Tooltip>
      </div>

      {/* 自动任务入口：作为任务中心入口放在置顶区上方，不参与置顶列表层级。平板版隐藏（无规划中心能力） */}
      {!tabletMode && (
        <div className="px-3 pt-2 pb-0.5">
          <AutomationSidebarEntry
            count={automationCount}
            active={activeView === 'planning'}
            onClick={handleOpenAutomations}
          />
        </div>
      )}

      {/* Agent 技能入口：Skills / MCP 能力中心，仅 Agent 模式可见；平板版隐藏 */}
      {mode === 'agent' && !tabletMode && (
        <div className="px-3 pb-0.5">
          <SkillsSidebarEntry
            count={capabilities?.skills.length ?? 0}
            updateCount={capabilities?.skills.filter((s) => s.hasUpdate).length ?? 0}
            active={activeView === 'agent-skills'}
            onClick={handleOpenSkills}
          />
        </div>
      )}

      {/* Chat 模式 active 视图：置顶 + 对话历史，结构与 Agent active 视图保持一致 */}
      {mode === 'chat' && viewMode === 'active' ? (
        <div className="flex-1 flex flex-col min-h-0">
          {pinnedConversations.length > 0 && (
            <div className="pt-2 pb-1 flex-shrink-0 titlebar-no-drag">
              <div className="pl-[18px] pr-3.5 pb-1 text-[13px] font-medium leading-[18px] text-foreground/40 select-none">
                置顶
              </div>
              <div
                className="overflow-y-auto scrollbar-thin"
                style={{ maxHeight: PINNED_SESSION_MAX_HEIGHT }}
              >
                <div className="px-2">
                  <div className="ml-4 flex flex-col gap-0.5">
                    {pinnedConversations.map((conv) => (
                      <ConversationItem
                        key={`pinned-${conv.id}`}
                        conversation={conv}
                        active={conv.id === activeSessionId}
                        streaming={streamingIds.has(conv.id)}
                        showPinIcon={false}
                        hasDraft={conversationDraftMap.has(conv.id)}
                        relativeTimeNow={relativeTimeNow}
                        onSelect={handleSelectConversation}
                        onRequestDelete={handleRequestDelete}
                        onRename={handleRename}
                        onTogglePin={handleTogglePin}
                        onToggleArchive={handleToggleArchive}
                      />
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          <div className="px-2 pt-2 pb-1 flex-shrink-0">
            <span className="ml-[4px] px-1.5 text-[13px] font-medium leading-[18px] text-foreground/40 select-none">对话</span>
          </div>

          <div className="flex-1 overflow-y-auto px-2 pb-3 scrollbar-thin min-h-0 titlebar-no-drag">
            {progressiveConversationGroups.map((group) => (
              <div key={group.label} className="mb-1">
                <div className="ml-[4px] px-1.5 pt-2 pb-1 text-[11px] font-medium text-foreground/40 select-none">
                  {group.label}
                </div>
                <div className="flex flex-col gap-0.5">
                  {group.items.map((conv) => (
                    <ConversationItem
                      key={conv.id}
                      conversation={conv}
                      active={conv.id === activeSessionId}
                      streaming={streamingIds.has(conv.id)}
                      showPinIcon={!!conv.pinned}
                      hasDraft={conversationDraftMap.has(conv.id)}
                      relativeTimeNow={relativeTimeNow}
                      onSelect={handleSelectConversation}
                      onRequestDelete={handleRequestDelete}
                      onRename={handleRename}
                      onTogglePin={handleTogglePin}
                      onToggleArchive={handleToggleArchive}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : mode === 'agent' && viewMode === 'active' ? (
        <div className="flex-1 flex flex-col min-h-0">
          {pinnedAgentSessionTrees.length > 0 && (
            <div className="pt-2 pb-1 flex-shrink-0 titlebar-no-drag">
              <div className="pl-[18px] pr-3.5 pb-1 text-[13px] font-medium leading-[18px] text-foreground/40 select-none">
                置顶
              </div>
              <div
                className="overflow-y-auto scrollbar-thin"
                style={{ maxHeight: PINNED_SESSION_MAX_HEIGHT }}
              >
                <div className="px-2">
                  <div className="ml-4 flex flex-col gap-0.5">
                    {pinnedAgentSessionTrees.slice(0, progressiveCount).map((item) => {
                      const childCount = item.childSessions.length
                      const rowStatus = getSessionTreeStatus(item, agentIndicatorMap)
                      const treeActive = treeContainsSessionId(item, activeSessionId)
                      const activeChildVisible = item.childSessions.some((child) => child.id === activeSessionId)
                      const expandedChildren = expandedDelegationParentIds.has(item.session.id) || activeChildVisible

                      return (
                        <div key={`pinned-${item.session.id}`} className="flex flex-col gap-0.5">
                          <AgentSessionItem
                            session={item.session}
                            active={treeActive}
                            indicatorStatus={rowStatus}
                            showPinIcon={false}
                            hasDraft={agentDraftIds.has(item.session.id)}
                            delegationSummary={childCount > 0
                              ? {
                                total: childCount,
                                completed: countCompletedDelegatedChildren(item.childSessions),
                                expanded: expandedChildren,
                                onToggle: () => handleToggleDelegationParent(item.session.id),
                              }
                              : undefined}
                            leftAccent={getSessionLeftAccent(rowStatus)}
                            workspaceName={item.session.workspaceId ? workspaceNameMap.get(item.session.workspaceId) : undefined}
                            relativeTimeNow={relativeTimeNow}
                            onSelect={handleSelectAgentSession}
                            onRequestDelete={handleRequestDelete}
                            onRequestMove={handleRequestMove}
                            onRename={handleAgentRename}
                            onTogglePin={handleTogglePinAgent}
                            onToggleArchive={handleToggleArchiveAgent}
                          />

                          {childCount > 0 && (
                            <div className="ml-3 border-l border-foreground/10 pl-2 flex flex-col gap-0.5">
                              {item.childSessions.map((childSession) => (
                                <DelegatedChildSessionItem
                                  key={childSession.id}
                                  session={childSession}
                                  activeSessionId={activeSessionId}
                                  agentIndicatorMap={agentIndicatorMap}
                                  hasDraft={agentDraftIds.has(childSession.id)}
                                  relativeTimeNow={relativeTimeNow}
                                  workspaceName={childSession.workspaceId ? workspaceNameMap.get(childSession.workspaceId) : undefined}
                                  onSelect={handleSelectAgentSession}
                                  onRequestDelete={handleRequestDelete}
                                  onRequestMove={handleRequestMove}
                                  onRename={handleAgentRename}
                                  onTogglePin={handleTogglePinAgent}
                                  onToggleArchive={handleToggleArchiveAgent}
                                />
                              ))}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* 下区标题：项目历史 */}
          <div className="px-2 pt-2 pb-1 flex items-center justify-between flex-shrink-0">
            <span className="ml-[4px] px-1.5 text-[13px] font-medium leading-[18px] text-foreground/40 select-none">项目</span>
            <div className="flex items-center gap-0.5">
              {/* 项目排序切换：默认（创建时间）/ 最近 / 名称 三种方式循环 */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={handleCycleWorkspaceSort}
                    className="size-6 flex items-center justify-center rounded-md text-foreground/35 hover:bg-foreground/[0.06] hover:text-foreground/60 transition-colors titlebar-no-drag"
                    aria-label={`项目排序：当前${WORKSPACE_SORT_LABEL[workspaceSortMode]}排序，点击切换`}
                  >
                    {renderWorkspaceSortIcon(workspaceSortMode)}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">
                  当前{WORKSPACE_SORT_LABEL[workspaceSortMode]}排序，点击切换排序方式
                </TooltipContent>
              </Tooltip>
              {/* 平板版暂时隐藏团队版功能：不展示“加入团队工作区”入口 */}
              {authStatus.isLoggedIn && accountCaps.membershipTier !== 'free' && !tabletMode && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={handleStartJoinWorkspace}
                      className="size-6 flex items-center justify-center rounded-md text-foreground/35 hover:bg-foreground/[0.06] hover:text-foreground/60 transition-colors titlebar-no-drag"
                      aria-label="加入工作区"
                    >
                      <LogIn size={12} />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top">加入团队工作区</TooltipContent>
                </Tooltip>
              )}
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={handleStartCreateProject}
                    className="size-6 flex items-center justify-center rounded-md text-foreground/40 hover:bg-foreground/[0.06] hover:text-foreground/60 transition-colors titlebar-no-drag"
                    aria-label="新建项目"
                  >
                    <Plus size={16} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">新建项目</TooltipContent>
              </Tooltip>
            </div>
          </div>

          {/* 下区：项目分组历史 */}
          <div className="flex-1 overflow-y-auto px-2 pb-3 scrollbar-thin min-h-0 titlebar-no-drag">
            {creatingProject && (
              <div className="flex items-center gap-2 px-2 py-1.5 mb-1 rounded-md bg-foreground/[0.04]">
                <FolderOpen size={14} className="flex-shrink-0 text-foreground/40" />
                <input
                  ref={newProjectInputRef}
                  value={newProjectName}
                  onChange={(e) => setNewProjectName(e.target.value)}
                  onKeyDown={handleCreateProjectKeyDown}
                  onBlur={() => {
                    setCreatingProject(false)
                    setNewProjectName('')
                  }}
                  placeholder="项目名称..."
                  className="flex-1 min-w-0 bg-transparent text-[13px] text-foreground border-b border-primary/50 outline-none px-0.5"
                  maxLength={50}
                />
              </div>
            )}

            <div className="flex flex-col gap-0.5">
              {agentProjectGroups.slice(0, progressiveCount).map((group) => (
                <AgentProjectGroupItem
                  key={group.workspace.id}
                  group={group}
                  currentWorkspaceId={currentWorkspaceId}
                  expanded={(expandedExtraCountMap.get(group.workspace.id) ?? 0) > 0}
                  extraCount={expandedExtraCountMap.get(group.workspace.id) ?? 0}
                  collapsed={collapsedWorkspaceIds.has(group.workspace.id)}
                  activeSessionId={activeSessionId}
                  agentIndicatorMap={agentIndicatorMap}
                  agentDraftIds={agentDraftIds}
                  expandedDelegationParentIds={expandedDelegationParentIds}
                  relativeTimeNow={relativeTimeNow}
                  dragging={dragProjectId === group.workspace.id}
                  dropPosition={projectDropIndicator?.id === group.workspace.id ? projectDropIndicator.position : null}
                  onShowMore={handleShowMoreSessions}
                  onCollapseExtra={handleCollapseExtraSessions}
                  onSelectProject={handleSelectProject}
                  onToggleProjectCollapse={handleToggleProjectCollapse}
                  onNewSession={createAgentSessionInWorkspace}
                  onDragStart={handleProjectDragStart}
                  onDragOver={handleProjectDragOver}
                  onDragLeave={handleProjectDragLeave}
                  onDrop={handleProjectDrop}
                  onDragEnd={handleProjectDragEnd}
                  onConfigureProject={(workspaceId) => {
                    handleSelectProject(workspaceId)
                    setSettingsTab('agent')
                    setSettingsOpen(true)
                  }}
                  onRenameWorkspace={handleWorkspaceRename}
                  onRequestDeleteWorkspace={handleRequestDeleteWorkspace}
                  canDeleteWorkspace={canDeleteWorkspace(group.workspace)}
                  onSelectSession={handleSelectAgentSession}
                  onRequestDelete={handleRequestDelete}
                  onRequestMove={handleRequestMove}
                  onRename={handleAgentRename}
                  onTogglePin={handleTogglePinAgent}
                  onToggleArchive={handleToggleArchiveAgent}
                  onToggleDelegationParent={handleToggleDelegationParent}
                  workspaceSwitchTs={workspaceSwitchTs}
                />
              ))}
            </div>
          </div>
        </div>
      ) : (
        <>
          {/* 归档视图标题栏 */}
          {viewMode === 'archived' && (
            <div className="px-6 pt-3 pb-1">
              <div className="text-[12px] font-medium text-foreground/40">
                已归档{mode === 'agent' ? '会话' : '对话'}
              </div>
            </div>
          )}

          {/* 归档视图：单列表布局 */}
          <div className="flex-1 overflow-y-auto px-3 pt-2 pb-3 scrollbar-thin titlebar-no-drag">
            {mode === 'chat' ? (
              /* Chat 归档：对话按日期分组 */
              progressiveConversationGroups.map((group) => (
                <div key={group.label} className="mb-1">
                  <div className="px-3 pt-2 pb-1 text-[11px] font-medium text-foreground/40 select-none">
                    {group.label}
                  </div>
                  <div className="flex flex-col gap-0.5">
                    {group.items.map((conv) => (
                      <ConversationItem
                        key={conv.id}
                        conversation={conv}
                        active={conv.id === activeSessionId}
                        streaming={streamingIds.has(conv.id)}
                        showPinIcon={!!conv.pinned}
                        hasDraft={conversationDraftMap.has(conv.id)}
                        relativeTimeNow={relativeTimeNow}
                        onSelect={handleSelectConversation}
                        onRequestDelete={handleRequestDelete}
                        onRename={handleRename}
                        onTogglePin={handleTogglePin}
                        onToggleArchive={handleToggleArchive}
                      />
                    ))}
                  </div>
                </div>
              ))
            ) : (
              /* Agent 模式归档：Agent 会话按日期分组 */
              progressiveAgentSessionGroups.map((group) => (
                <div key={group.label} className="mb-1">
                  <div className="px-3 pt-2 pb-1 text-[11px] font-medium text-foreground/40 select-none">
                    {group.label}
                  </div>
                  <div className="flex flex-col gap-0.5">
                    {group.items.map((session) => (
                      <AgentSessionItem
                        key={session.id}
                        session={session}
                        active={session.id === activeSessionId}
                        indicatorStatus={agentIndicatorMap.get(session.id) ?? 'idle'}
                        showPinIcon={!!session.pinned}
                        hasDraft={agentDraftIds.has(session.id)}
                        leftAccent={getSessionLeftAccent(agentIndicatorMap.get(session.id) ?? 'idle')}
                        workspaceName={session.workspaceId ? workspaceNameMap.get(session.workspaceId) : undefined}
                        relativeTimeNow={relativeTimeNow}
                        onSelect={handleSelectAgentSession}
                        onRequestDelete={handleRequestDelete}
                        onRequestMove={handleRequestMove}
                        onRename={handleAgentRename}
                        onTogglePin={handleTogglePinAgent}
                        onToggleArchive={handleToggleArchiveAgent}
                      />
                    ))}
                  </div>
                </div>
              ))
            )}
          </div>
        </>
      )}

      {/* 已归档入口 / 返回活跃对话 */}
      <div className="px-3 pb-1">
        {viewMode === 'active' ? (
          <>
            {mode === 'chat' && archivedConversationCount > 0 && (
              <button
                onClick={() => setViewMode('archived')}
                className="w-full flex items-center gap-2 px-3 py-2 rounded-[10px] text-[12px] text-foreground/40 hover:bg-foreground/[0.04] hover:text-foreground/60 transition-colors titlebar-no-drag"
              >
                <Archive size={13} className="text-foreground/30" />
                <span>已归档 ({archivedConversationCount})</span>
              </button>
            )}
            {mode === 'agent' && archivedAgentSessionCount > 0 && (
              <button
                onClick={() => setViewMode('archived')}
                className="w-full flex items-center gap-2 px-3 py-2 rounded-[10px] text-[12px] text-foreground/40 hover:bg-foreground/[0.04] hover:text-foreground/60 transition-colors titlebar-no-drag"
              >
                <Archive size={13} className="text-foreground/30" />
                <span>已归档 ({archivedAgentSessionCount})</span>
              </button>
            )}
          </>
        ) : (
          <button
            onClick={() => setViewMode('active')}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-[10px] text-[12px] text-foreground/60 bg-foreground/[0.04] hover:bg-foreground/[0.07] hover:text-foreground/80 transition-colors titlebar-no-drag"
          >
            <ArrowLeft size={13} className="text-foreground/50" />
            <span>返回活跃{mode === 'agent' ? '会话' : '对话'}</span>
          </button>
        )}
      </div>

      {/* 底部：用户资料 + 设置入口 */}
      <div className="px-3 pb-3 space-y-1.5">

        {/* 余额条（仅代管模式显示） */}
        <SidebarBalanceBar />

        <button
          onClick={() => setSettingsOpen(true)}
          className="w-full flex items-center gap-3 px-3 py-2 rounded-[10px] transition-colors titlebar-no-drag text-foreground/70 hover:bg-foreground/[0.04] hover:text-foreground"
        >
          <UserAvatar avatar={userProfile.avatar} size={28} />
          <span className="flex-1 text-sm truncate text-left">{userProfile.userName}</span>
          <div className="relative flex-shrink-0 text-foreground/40">
            <Settings size={16} />
            {(hasUpdate || hasEnvironmentIssues) && (
              <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-red-500" />
            )}
          </div>
        </button>
      </div>
    </div>
  )
}
