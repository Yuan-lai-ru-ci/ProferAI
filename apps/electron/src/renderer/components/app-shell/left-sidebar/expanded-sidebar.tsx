/**
 * expanded-sidebar.tsx — 展开态完整侧边栏
 *
 * 从 LeftSidebar 抽离的展开态视图。通过 SidebarModel 读取状态与 handler。
 */

import * as React from 'react'
import { useAtomValue } from 'jotai'
import { Plus, Search, FolderOpen, Archive, ArchiveRestore, ArrowLeft } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ScrollRegion } from '@/components/ai-elements/scroll-region'
import { Tooltip, TooltipTrigger, TooltipContent } from '@profer/ui/primitives/tooltip'
import { Popover, PopoverTrigger, PopoverContent } from '@profer/ui/primitives/popover'
import { ModeSwitcher } from '../ModeSwitcher'
import { SIDEBAR_ROW_GAP, renderWorkspaceSortIcon } from './navigation-items'
import { ConversationItem, AgentSessionItem, RelatedChildSessionItem, AgentProjectGroupItem, PINNED_SESSION_MAX_HEIGHT, getSessionLeftAccent } from './session-items'
import { getOpenSessionEntries, WORKSPACE_SORT_LABEL, SIDEBAR_SECTION_TITLE_CLASS, sidebarRowClass } from './sidebar-utils'
import { showCurrentSessionSectionAtom } from '@/atoms/sidebar-atoms'
import { getActiveAccelerator, getAcceleratorDisplay } from '@/lib/shortcut-registry'
import { useCloseTab } from '@/hooks/useCloseTab'
import type { SidebarModel } from './use-left-sidebar'

function CurrentSessionSection({ s }: { s: SidebarModel }): React.ReactElement {
  const {
    mode,
    conversations,
    agentSessions,
    tabs,
    activeSessionId,
    conversationDraftMap,
    streamingIds,
    handleSelectConversation,
    handleRequestDelete,
    handleRename,
    handleRegenerateConversationTitle,
    regeneratingConversationTitleIds,
    handleTogglePin,
    handleToggleArchive,
    agentIndicatorMap,
    agentDraftIds,
    workspaceNameMap,
    handleSelectAgentSession,
    handleRequestMove,
    handleAgentRename,
    handleAgentRegenerateTitle,
    handleToggleSessionUnread,
    handleTogglePinAgent,
    handleToggleArchiveAgent,
    relativeTimeNow,
  } = s
  const { requestClose: requestCloseTab, requestCloseMany: requestCloseTabs } = useCloseTab()
  const openSessionEntries = React.useMemo(
    () => getOpenSessionEntries(mode, tabs, conversations, agentSessions),
    [agentSessions, conversations, mode, tabs],
  )
  /** 关闭本区除 keepTabId 以外的入口（不删除会话数据）。 */
  const closeOtherOpenSessions = React.useCallback((keepTabId: string) => {
    requestCloseTabs(openSessionEntries.filter((entry) => entry.tab.id !== keepTabId).map((entry) => entry.tab.id))
  }, [openSessionEntries, requestCloseTabs])
  /** 关闭本区全部入口（不删除会话数据，关联的预览/浏览器 Tab 随会话一并关闭）。 */
  const closeAllOpenSessions = React.useCallback(() => {
    requestCloseTabs(openSessionEntries.map((entry) => entry.tab.id))
  }, [openSessionEntries, requestCloseTabs])

  return (
    <div className="flex-none pb-1 titlebar-no-drag">
      <div className="flex h-[26px] items-center justify-between px-2">
        <span className={SIDEBAR_SECTION_TITLE_CLASS}>当前会话</span>
        <span className="text-[10.5px] tabular-nums text-foreground/[0.26]">{openSessionEntries.length}</span>
      </div>
      <ScrollRegion className={cn('sidebar-session-scroll flex max-h-[144px] flex-col gap-px overflow-y-auto scrollbar-thin')}>
        {openSessionEntries.map((entry) => {
          const { tab } = entry
          const active = tab.sessionId === activeSessionId
          if (entry.type === 'chat') {
            const { conversation } = entry
            return (
              <ConversationItem
                key={tab.id}
                conversation={conversation}
                active={active}
                streaming={streamingIds.has(conversation.id)}
                showPinIcon={false}
                hasDraft={conversationDraftMap.has(conversation.id)}
                relativeTimeNow={relativeTimeNow}
                onSelect={handleSelectConversation}
                onRequestDelete={handleRequestDelete}
                onRename={handleRename}
                onRegenerateTitle={handleRegenerateConversationTitle}
                regeneratingTitle={regeneratingConversationTitleIds.has(conversation.id)}
                onTogglePin={handleTogglePin}
                onToggleArchive={handleToggleArchive}
                onCloseTab={() => requestCloseTab(tab.id)}
                onCloseOtherTabs={openSessionEntries.length > 1 ? () => closeOtherOpenSessions(tab.id) : undefined}
                onCloseAllTabs={closeAllOpenSessions}
              />
            )
          }
          const { session } = entry
          return (
            <AgentSessionItem
              key={tab.id}
              session={session}
              active={active}
              indicatorStatus={agentIndicatorMap.get(session.id) ?? 'idle'}
              showPinIcon={false}
              hasDraft={agentDraftIds.has(session.id)}
              leftAccent={getSessionLeftAccent(agentIndicatorMap.get(session.id) ?? 'idle')}
              workspaceName={session.workspaceId ? workspaceNameMap.get(session.workspaceId) : undefined}
              relativeTimeNow={relativeTimeNow}
              onSelect={handleSelectAgentSession}
              onRequestDelete={handleRequestDelete}
              onRequestMove={handleRequestMove}
              onRename={handleAgentRename}
              onRegenerateTitle={handleAgentRegenerateTitle}
              onTogglePin={handleTogglePinAgent}
              onToggleArchive={handleToggleArchiveAgent}
              onMarkUnread={handleToggleSessionUnread}
              onCloseTab={() => requestCloseTab(tab.id)}
              onCloseOtherTabs={openSessionEntries.length > 1 ? () => closeOtherOpenSessions(tab.id) : undefined}
              onCloseAllTabs={closeAllOpenSessions}
            />
          )
        })}
      </ScrollRegion>
    </div>
  )
}

export function ExpandedSidebar({ s }: { s: SidebarModel }): React.ReactElement {
  const {
    mode,
    handleNewAgentSession,
    handleNewConversation,
    setSearchDialogOpen,
    pinnedConversations,
    conversationDraftMap,
    activeSessionId,
    streamingIds,
    handleSelectConversation,
    handleRequestDelete,
    handleRename,
    handleRegenerateConversationTitle,
    regeneratingConversationTitleIds,
    handleTogglePin,
    handleToggleArchive,
    agentIndicatorMap,
    expandedRelatedParentIds,
    agentDraftIds,
    workspaceNameMap,
    handleSelectAgentSession,
    handleRequestMove,
    handleAgentRename,
    handleAgentRegenerateTitle,
    handleToggleSessionUnread,
    regeneratingTitleIds,
    handleTogglePinAgent,
    handleToggleArchiveAgent,
    handleToggleRelatedParent,
    relativeTimeNow,
    workspaceSortMode,
    handleCycleWorkspaceSort,
    handleStartCreateProject,
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
    handleWorkspaceRename,
    handleRequestDeleteWorkspace,
    handleToggleWorkspaceArchive,
    archivedWorkspaces,
    canDeleteWorkspace,
    workspaceSwitchTs,
    projectPathStatus,
    handleRelocateProject,
    progressiveConversationGroups,
    progressiveAgentSessionGroups,
    archivedConversationCount,
    archivedAgentSessionCount,
    viewMode,
    setViewMode,
  } = s
  /** 顶部「当前会话」区显隐（设置 → 外观设置 → 侧边栏） */
  const showCurrentSessionSection = useAtomValue(showCurrentSessionSectionAtom)
  return (
    <div className="relative flex h-full flex-col overflow-hidden px-2.5 pb-2.5">
      {/* Agent / Chat 切换 + 搜索：Profer 的标志性分段控件固定在列表顶部，
          搜索作为它的同级图标按钮放在右侧（mt-2 对齐分段控件的 40px 轨道）。
          收起态由 rail 上的两个模式图标承担。 */}
      <div className="flex flex-none items-start gap-1.5">
        <div className="min-w-0 flex-1">
          <ModeSwitcher />
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={() => setSearchDialogOpen(true)}
              aria-label="搜索"
              className="mt-2 flex size-10 flex-none items-center justify-center rounded-xl border border-border/60 bg-primary/5 text-foreground/40 transition-[background-color,border-color,color] duration-150 titlebar-no-drag hover:border-border hover:bg-primary/10 hover:text-foreground/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              <Search size={17} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            搜索 ({getAcceleratorDisplay(getActiveAccelerator('global-search'))})
          </TooltipContent>
        </Tooltip>
      </div>

      {/* 主操作：新建会话。整行提级——常驻 3.5% 底 + 当前项文字色 + medium 字重，
          让它明显区别于下面的普通会话行；按用户要求不再显示 ⌘N 提示。 */}
      <div className="flex flex-none items-center px-0.5" style={{ marginTop: SIDEBAR_ROW_GAP }}>
        <button
          data-profer-navigation-item="new-session"
          onClick={mode === 'agent' ? handleNewAgentSession : handleNewConversation}
          className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-[7px] bg-foreground/[0.035] px-2 text-[13px] font-medium text-foreground transition-colors duration-100 titlebar-no-drag hover:bg-foreground/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          <Plus size={15} className="flex-none text-foreground/70" />
          <span className="truncate">{mode === 'agent' ? '新会话' : '新对话'}</span>
        </button>
      </div>

      <div aria-hidden="true" className="mx-2 my-[7px] h-px flex-none bg-foreground/[0.045]" />

      {/* 当前会话区域按设置独立挂载；关闭后释放其 Tab/缓存订阅与关闭处理器。 */}
      {showCurrentSessionSection && <CurrentSessionSection s={s} />}

      {/* Chat 模式 active 视图：置顶 + 对话历史，结构与 Agent active 视图保持一致 */}
      {mode === 'chat' && viewMode === 'active' ? (
        <div className="flex-1 flex flex-col min-h-0">
          {pinnedConversations.length > 0 && (
            <div className="flex-none pb-1 titlebar-no-drag">
              <div className={cn('flex h-[26px] items-center px-2', SIDEBAR_SECTION_TITLE_CLASS)}>
                置顶
              </div>
              <ScrollRegion
                className="sidebar-session-scroll overflow-y-auto scrollbar-thin"
                style={{ maxHeight: PINNED_SESSION_MAX_HEIGHT }}
              >
                <div className="flex flex-col gap-px">
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
                      onRegenerateTitle={handleRegenerateConversationTitle}
                      regeneratingTitle={regeneratingConversationTitleIds.has(conv.id)}
                      onTogglePin={handleTogglePin}
                      onToggleArchive={handleToggleArchive}
                    />
                  ))}
                </div>
              </ScrollRegion>
            </div>
          )}

          <div className="flex h-[26px] flex-none items-center px-2">
            <span className={SIDEBAR_SECTION_TITLE_CLASS}>对话</span>
          </div>

          <ScrollRegion className="sidebar-session-scroll min-h-0 flex-1 overflow-y-auto pb-2 scrollbar-thin titlebar-no-drag">
            {progressiveConversationGroups.map((group) => (
              <div key={group.label} className="mb-1">
                <div className={cn('flex h-[26px] items-center px-2', SIDEBAR_SECTION_TITLE_CLASS)}>
                  {group.label}
                </div>
                <div className="flex flex-col gap-px">
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
                      onRegenerateTitle={handleRegenerateConversationTitle}
                      regeneratingTitle={regeneratingConversationTitleIds.has(conv.id)}
                      onTogglePin={handleTogglePin}
                      onToggleArchive={handleToggleArchive}
                    />
                  ))}
                </div>
              </div>
            ))}
          </ScrollRegion>
        </div>
      ) : mode === 'agent' && viewMode === 'active' ? (
        <div className="flex-1 flex flex-col min-h-0">
          <div className="flex h-[26px] flex-none items-center justify-between pr-1 titlebar-no-drag">
            <span className={cn('px-2', SIDEBAR_SECTION_TITLE_CLASS)}>项目</span>
            <div className="flex items-center gap-0.5">
              {/* 已收纳入口：仅在存在收纳项时出现，点击弹出列表可逐个取出 */}
              {archivedWorkspaces.length > 0 && (
                <Popover>
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      className="size-6 flex items-center justify-center rounded-md text-foreground/35 hover:bg-foreground/[0.06] hover:text-foreground/60 transition-colors titlebar-no-drag"
                      aria-label={`查看已收纳工作区（${archivedWorkspaces.length}）`}
                    >
                      <Archive size={13} />
                    </button>
                  </PopoverTrigger>
                  <PopoverContent align="end" className="w-56 p-1">
                    <div className="px-2 py-1 text-[11px] font-medium text-foreground/40">
                      已收纳工作区 ({archivedWorkspaces.length})
                    </div>
                    {archivedWorkspaces.map((ws) => (
                      <div
                        key={ws.id}
                        className="group/archived flex items-center gap-1.5 rounded-md px-2 py-1 text-[13px] text-foreground/70 hover:bg-foreground/[0.05]"
                      >
                        <FolderOpen size={13} className="flex-shrink-0 text-foreground/35" />
                        <span className="flex-1 min-w-0 truncate">{ws.name}</span>
                        <button
                          type="button"
                          aria-label={`取出「${ws.name}」`}
                          title="取出工作区"
                          onClick={() => { void handleToggleWorkspaceArchive(ws.id) }}
                          className="flex-shrink-0 rounded p-0.5 text-foreground/35 transition-colors hover:text-foreground/80 titlebar-no-drag"
                        >
                          <ArchiveRestore size={13} />
                        </button>
                      </div>
                    ))}
                  </PopoverContent>
                </Popover>
              )}
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

          <ScrollRegion className="sidebar-session-scroll min-h-0 flex-1 overflow-y-auto pb-2 scrollbar-thin titlebar-no-drag">
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
                  expandedRelatedParentIds={expandedRelatedParentIds}
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
                  onToggleArchiveWorkspace={(workspaceId) => { void handleToggleWorkspaceArchive(workspaceId) }}
                  onRenameWorkspace={handleWorkspaceRename}
                  onRequestDeleteWorkspace={handleRequestDeleteWorkspace}
                  canDeleteWorkspace={canDeleteWorkspace(group.workspace)}
                  onSelectSession={handleSelectAgentSession}
                  onRequestDelete={handleRequestDelete}
                  onRequestMove={handleRequestMove}
                  onRename={handleAgentRename}
                  onRegenerateTitle={handleAgentRegenerateTitle}
                  onTogglePin={handleTogglePinAgent}
                  onToggleArchive={handleToggleArchiveAgent}
                  onToggleRelatedParent={handleToggleRelatedParent}
                  onMarkUnread={handleToggleSessionUnread}
                  workspaceSwitchTs={workspaceSwitchTs}
                  pathStatus={projectPathStatus.get(group.workspace.id)}
                  onRelocateProject={handleRelocateProject}
                />
              ))}
            </div>
          </ScrollRegion>
        </div>
      ) : (
        <>
          {/* 归档视图标题栏 */}
          {viewMode === 'archived' && (
            <div className="flex-none px-2 pb-1 pt-2">
              <div className={SIDEBAR_SECTION_TITLE_CLASS}>
                已归档{mode === 'agent' ? '会话' : '对话'}
              </div>
            </div>
          )}

          {/* 归档视图：单列表布局 */}
          <ScrollRegion className="sidebar-session-scroll flex-1 overflow-y-auto pb-2 pt-1 scrollbar-thin titlebar-no-drag">
            {mode === 'chat' ? (
              /* Chat 归档：对话按日期分组 */
              progressiveConversationGroups.map((group) => (
                <div key={group.label} className="mb-1">
                  <div className={cn('flex h-[26px] items-center px-2', SIDEBAR_SECTION_TITLE_CLASS)}>
                    {group.label}
                  </div>
                  <div className="flex flex-col gap-px">
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
                        onRegenerateTitle={handleRegenerateConversationTitle}
                        regeneratingTitle={regeneratingConversationTitleIds.has(conv.id)}
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
                  <div className={cn('flex h-[26px] items-center px-2', SIDEBAR_SECTION_TITLE_CLASS)}>
                    {group.label}
                  </div>
                  <div className="flex flex-col gap-px">
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
                        onRegenerateTitle={handleAgentRegenerateTitle}
                        regeneratingTitle={regeneratingTitleIds.has(session.id)}
                        onTogglePin={handleTogglePinAgent}
                        onToggleArchive={handleToggleArchiveAgent}
                        onMarkUnread={handleToggleSessionUnread}
                      />
                    ))}
                  </div>
                </div>
              ))
            )}
          </ScrollRegion>
        </>
      )}

      {/* 归档入口 / 返回活跃：列表最后一行，与普通行同高同圆角 */}
      <div className="flex-none pt-1">
        {viewMode === 'active' ? (
          <>
            {mode === 'chat' && archivedConversationCount > 0 && (
              <button
                onClick={() => setViewMode('archived')}
                className={cn(sidebarRowClass({ muted: true }), 'titlebar-no-drag')}
              >
                <Archive size={13} className="flex-none text-foreground/30" />
                <span className="truncate">已归档</span>
                <span className="ml-auto text-[10.5px] tabular-nums text-foreground/[0.26]">{archivedConversationCount}</span>
              </button>
            )}
            {mode === 'agent' && archivedAgentSessionCount > 0 && (
              <button
                onClick={() => setViewMode('archived')}
                className={cn(sidebarRowClass({ muted: true }), 'titlebar-no-drag')}
              >
                <Archive size={13} className="flex-none text-foreground/30" />
                <span className="truncate">已归档</span>
                <span className="ml-auto text-[10.5px] tabular-nums text-foreground/[0.26]">{archivedAgentSessionCount}</span>
              </button>
            )}
          </>
        ) : (
          <button
            onClick={() => setViewMode('active')}
            className={cn(sidebarRowClass(), 'titlebar-no-drag')}
          >
            <ArrowLeft size={13} className="flex-none text-foreground/50" />
            <span className="truncate">返回活跃{mode === 'agent' ? '会话' : '对话'}</span>
          </button>
        )}
      </div>
    </div>
  )
}
