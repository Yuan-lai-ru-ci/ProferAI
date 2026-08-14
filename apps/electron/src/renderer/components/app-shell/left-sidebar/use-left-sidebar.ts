/**
 * use-left-sidebar.ts — 侧边栏状态与业务逻辑 hook
 *
 * 从 LeftSidebar 主组件抽离的全部 state / handler / 派生数据。
 * 主组件只负责 props 透传与组装 rail / expanded-sidebar 两个视图；
 * rail.tsx 与 expanded-sidebar.tsx 通过解构本 hook 返回值读取状态。
 */

import * as React from 'react'
import { useAtom, useSetAtom, useAtomValue, useStore } from 'jotai'
import { toast } from 'sonner'
import { interfaceVariantAtom } from '@/atoms/theme'
import { activeViewAtom } from '@/atoms/active-view'
import { automationFormAtom, automationsAtom } from '@/atoms/automation-atoms'
import { appModeAtom, type AppMode } from '@/atoms/app-mode'
import { settingsTabAtom, settingsOpenAtom } from '@/atoms/settings-tab'
import {
  conversationsAtom,
  currentConversationIdAtom,
  selectedModelAtom,
  streamingConversationIdsAtom,
  conversationModelsAtom,
  conversationContextLengthAtom,
  conversationThinkingEnabledAtom,
  conversationParallelModeAtom,
  conversationDraftsAtom,
} from '@/atoms/chat-atoms'
import {
  agentSessionsAtom,
  agentSDKMessagesCacheAtom,
  currentAgentSessionIdAtom,
  agentSessionIndicatorMapAtom,
  unviewedCompletedSessionIdsAtom,
  agentChannelIdAtom,
  agentModelIdAtom,
  agentSessionChannelMapAtom,
  agentSessionModelMapAtom,
  agentSessionPathMapAtom,
  currentAgentWorkspaceIdAtom,
  agentWorkspacesAtom,
  workspaceCapabilitiesVersionAtom,
  agentDiffPanelTabAtom,
  agentDiffRefreshVersionAtom,
  agentDiffUnseenChangesAtom,
  agentDiffUnseenFilesAtom,
  agentDiffDataAtom,
  agentStreamingStatesAtom,
  liveMessagesMapAtom,
  agentSessionPendingFilesAtom,
  agentSessionStreamingStateAtomFamily,
  agentSessionDraftAtomFamily,
  agentSessionDraftHtmlAtomFamily,
  agentSessionDraftsAtom,
  agentSessionDraftHtmlAtom,
  agentPendingFilesAtomFamily,
  backgroundTasksAtomFamily,
  sessionPersistedPermissionModeAtom,
  sessionExistsAtom,
  agentStreamErrorsAtom,
  agentPromptSuggestionsAtom,
  allPendingPermissionRequestsAtom,
  allPendingAskUserRequestsAtom,
  askUserAnswersAtom,
  allPendingExitPlanRequestsAtom,
} from '@/atoms/agent-atoms'
import type { SessionIndicatorStatus } from '@/atoms/agent-atoms'
import { previewPanelOpenMapAtom, previewFileMapAtom } from '@/atoms/preview-atoms'
import { clearPreviewCacheForSession } from '@/components/diff/DiffTabContent'
import {
  tabsAtom,
  activeTabIdAtom,
  activeSessionIdAtom,
  sidebarCollapsedAtom,
  closeTab,
  updateTabTitle,
  sessionViewStateMapAtom,
} from '@/atoms/tab-atoms'
import { userProfileAtom } from '@/atoms/user-profile'
import { authStatusAtom } from '@/atoms/identity-atoms'
import { sidebarViewModeAtom, workspaceSortModeAtom } from '@/atoms/sidebar-atoms'
import { searchDialogOpenAtom } from '@/atoms/search-atoms'
import { hasUpdateAtom } from '@/atoms/updater'
import { draftSessionIdsAtom } from '@/atoms/draft-session-atoms'
import { hasEnvironmentIssuesAtom } from '@/atoms/environment'
import { promptConfigAtom, selectedPromptIdAtom, conversationPromptIdAtom } from '@/atoms/system-prompt-atoms'
import { useOpenSession } from '@/hooks/useOpenSession'
import { useSyncActiveTabSideEffects } from '@/hooks/useSyncActiveTabSideEffects'
import { detectIsMac } from '@/lib/platform'
import { navigationController } from '@/lib/navigation-controller'
import type { NavigationAction } from '@/lib/navigation-actions'
import {
  replaceAgentSessionInFreshnessOrder,
  sortAgentSessionsByUpdatedAtDesc,
} from '@/lib/agent-session-list'
import type { AgentSessionMeta, AgentWorkspace, WorkspaceCapabilities } from '@profer/shared'

import {
  groupByDate,
  getRailInitial,
  toggleSetEntry,
  deleteSetEntry,
  sliceGroupsByCount,
  workspaceNameCollator,
  getNextWorkspaceSortMode,
} from './sidebar-utils'
import {
  getDirectDelegatedChildren,
  getSyncableDelegatedChildren,
  hasPinnedVisibleParent,
  PROJECT_SESSION_EXPAND_STEP,
  type AgentSessionTreeItem,
} from './session-tree'
import { focusEnterableViewItem } from './navigation-items'
import type { AgentProjectGroup } from './session-items'


export function useLeftSidebar(tabletMode?: boolean) {
  const [activeView, setActiveView] = useAtom(activeViewAtom)
  // 持续持有最新 activeView 的稳定引用，供 navigation consumer（useEffect [] 注册一次）
  // 读取最新视图状态，避免陈旧闭包（不能在 [] 闭包里直接读 activeView 变量）。
  const activeViewRef = React.useRef(activeView)
  activeViewRef.current = activeView
  const authStatus = useAtomValue(authStatusAtom)
  const setAutomationForm = useSetAtom(automationFormAtom)
  const automations = useAtomValue(automationsAtom)
  const setAutomations = useSetAtom(automationsAtom)
  const automationCount = automations.length
  const setSettingsTab = useSetAtom(settingsTabAtom)
  const setSettingsOpen = useSetAtom(settingsOpenAtom)
  const [conversations, setConversations] = useAtom(conversationsAtom)
  const [currentConversationId, setCurrentConversationId] = useAtom(currentConversationIdAtom)
  const draftSessionIds = useAtomValue(draftSessionIdsAtom)
  const setDraftSessionIds = useSetAtom(draftSessionIdsAtom)

  // 输入框草稿标记：订阅两个 draft map，任一命中即认为该会话输入框里有未发送内容。
  // 输入框每次按键会重写整 Map（AgentView 已用 family 切片避免自身重渲染），
  // 侧边栏需聚合展示，只能订阅整 Map；行数有限，可接受。
  const agentDraftMap = useAtomValue(agentSessionDraftsAtom)
  const agentDraftHtmlMap = useAtomValue(agentSessionDraftHtmlAtom)
  const conversationDraftMap = useAtomValue(conversationDraftsAtom)
  const allPendingAskUserRequests = useAtomValue(allPendingAskUserRequestsAtom)
  const askUserAnswers = useAtomValue(askUserAnswersAtom)
  /** 输入框有内容的 Agent 会话 ID 集合（markdown + html 任一命中，或 AskUser 提问填写中） */
  const agentDraftIds = React.useMemo(() => {
    const ids = new Set<string>()
    for (const id of agentDraftMap.keys()) ids.add(id)
    for (const id of agentDraftHtmlMap.keys()) ids.add(id)
    // AskUser 提问填写中：会话的当前请求已有答案草稿（含默认选中），视为有待回答的填写内容
    for (const [sessionId, requests] of allPendingAskUserRequests) {
      const current = requests[0]
      if (!current) continue
      const answers = askUserAnswers.get(current.requestId)
      if (answers && answers.size > 0) ids.add(sessionId)
    }
    return ids
  }, [agentDraftMap, agentDraftHtmlMap, allPendingAskUserRequests, askUserAnswers])
  const setAgentMessagesCache = useSetAtom(agentSDKMessagesCacheAtom)

  // 键盘与手柄共用左栏的 DOM 顺序；项目标题和会话行采用 roving focus。
  React.useEffect(() => {
    return navigationController.register((action: NavigationAction) => {
      const focused = document.activeElement
      const current = focused?.closest<HTMLElement>('[data-profer-navigation-item]')
      if (!current) return false
      // mode 切换按钮是独立的“开关”，不参与下面这条纵向主链；否则从项目往上
      // 会跳到 agent/chat 切换按钮，破坏“区专管左右切模式”的直觉。
      const items = Array.from(document.querySelectorAll<HTMLElement>('[data-profer-navigation-item]'))
        .filter((item) => item.dataset.proferNavigationItem !== 'mode')
      const index = items.indexOf(current)
      if (index < 0) return false

      if (action === 'previous' || action === 'next') {
        const delta = action === 'next' ? 1 : -1
        const target = items[index + delta]
        // 主链最顶（新建会话）再↑：进入顶部的 mode 切换按钮（预选态跟随当前激活）。
        if (!target && action === 'previous') {
          const modeBtn = document.querySelector<HTMLElement>(
            '[data-profer-navigation-item="mode"][data-profer-navigation-active="true"]',
          ) || document.querySelector<HTMLElement>('[data-profer-navigation-item="mode"]')
          if (modeBtn) {
            modeBtn.focus()
            return true
          }
        }
        if (!target) {
          // 已在边界：不再消费该方向，让外层（NavigationInputProvider）把焦点
          // 穿出左栏回到主内容/编辑框，避免用户上到 Agent 后按↓被“吃掉”而卡死。
          return false
        }
        target.focus()
        target.scrollIntoView({ block: 'nearest' })
        return true
      }
      if (action === 'confirm') {
        current.click()
        return true
      }
      // 全屏可进入视图（规划中心 / Agent 技能）的“进入/返回”：
      // - right（→/手柄右拨）：进入对应视图并移交焦点进内容区；已激活则只移交焦点，
      //   绝不靠再次 right 切回对话区（否则会“按一下右又跳回对话”）。
      // - left（←）：仅当已在对应视图时返回对话区（复用 onClick toggle 语义）。
      if ((current.dataset.proferNavigationItem === 'planning'
        || current.dataset.proferNavigationItem === 'agent-skills')
        && (action === 'left' || action === 'right')) {
        const item = current.dataset.proferNavigationItem
        const isActive = activeViewRef.current === item
        if (action === 'right') {
          if (!isActive) current.click() // 未激活才进入（避免 toggle 回对话）
          focusEnterableViewItem(item) // 已激活/刚进入都移交焦点进内容区
        } else if (isActive) {
          current.click() // left + 已在对应视图：切回对话区
        }
        return true
      }
      if (current.dataset.proferNavigationItem === 'project' && (action === 'left' || action === 'right')) {
        const expanded = current.getAttribute('aria-expanded') === 'true'
        if ((action === 'left' && expanded) || (action === 'right' && !expanded)) {
          current.querySelector<HTMLElement>('[data-project-collapse]')?.click()
          return true
        }
      }
      return false
    }, 20)
  }, [])

  /** 待删除对话 ID，非空时显示确认弹窗 */
  const [pendingDeleteId, setPendingDeleteId] = React.useState<string | null>(null)
  /** 待删除项目 ID，非空时显示项目删除确认弹窗 */
  const [pendingDeleteWorkspaceId, setPendingDeleteWorkspaceId] = React.useState<string | null>(null)
  const [deletingWorkspaceId, setDeletingWorkspaceId] = React.useState<string | null>(null)
  /** 待迁移会话 ID，非空时显示迁移对话框 */
  const [moveTargetId, setMoveTargetId] = React.useState<string | null>(null)
  /** 每个项目额外展开显示的会话数量（每次点击"显示更多" +10），未点击则为 0 或无值 */
  const [expandedExtraCountMap, setExpandedExtraCountMap] = React.useState<Map<string, number>>(new Map())
  /** 记录被用户手动折叠的工作区 ID（点击当前工作区标题时折叠/展开）。刻意不持久化：折叠被视为临时查看行为，刷新/重启后恢复默认展开 */
  const [collapsedWorkspaceIds, setCollapsedWorkspaceIds] = React.useState<Set<string>>(new Set())
  /** 记录已展开的委派母会话；默认收起，避免批量派遣后撑满侧栏 */
  const [expandedDelegationParentIds, setExpandedDelegationParentIds] = React.useState<Set<string>>(new Set())
  /** 项目拖拽排序状态 */
  const [dragProjectId, setDragProjectId] = React.useState<string | null>(null)
  const [projectDropIndicator, setProjectDropIndicator] = React.useState<{ id: string; position: 'before' | 'after' } | null>(null)
  /** 新建项目输入状态 */
  const [creatingProject, setCreatingProject] = React.useState(false)
  const [newProjectName, setNewProjectName] = React.useState('')
  const newProjectInputRef = React.useRef<HTMLInputElement>(null)
  const projectSelectionRequestRef = React.useRef(0)
  const [showJoinDialog, setShowJoinDialog] = React.useState(false)
  const [inviteCode, setInviteCode] = React.useState('')
  const [relativeTimeNow, setRelativeTimeNow] = React.useState(() => Date.now())
  const [userProfile, setUserProfile] = useAtom(userProfileAtom)
  const selectedModel = useAtomValue(selectedModelAtom)
  const streamingIds = useAtomValue(streamingConversationIdsAtom)
  const mode = useAtomValue(appModeAtom)
  const isMac = React.useMemo(() => detectIsMac(), [])
  const hasUpdate = useAtomValue(hasUpdateAtom)
  const hasEnvironmentIssues = useAtomValue(hasEnvironmentIssuesAtom)
  const promptConfig = useAtomValue(promptConfigAtom)
  const setSelectedPromptId = useSetAtom(selectedPromptIdAtom)
  const interfaceVariant = useAtomValue(interfaceVariantAtom)
  const isClassic = interfaceVariant === 'classic'

  // Agent 模式状态
  const [agentSessions, setAgentSessions] = useAtom(agentSessionsAtom)
  const [currentAgentSessionId, setCurrentAgentSessionId] = useAtom(currentAgentSessionIdAtom)
  const agentIndicatorMap = useAtomValue(agentSessionIndicatorMapAtom)
  const unviewedCompletedSessionIds = useAtomValue(unviewedCompletedSessionIdsAtom)
  const setUnviewedCompleted = useSetAtom(unviewedCompletedSessionIdsAtom)
  const agentChannelId = useAtomValue(agentChannelIdAtom)
  const agentModelId = useAtomValue(agentModelIdAtom)
  const setSessionChannelMap = useSetAtom(agentSessionChannelMapAtom)
  const setSessionModelMap = useSetAtom(agentSessionModelMapAtom)
  const setSessionPathMap = useSetAtom(agentSessionPathMapAtom)
  const [currentWorkspaceId, setCurrentWorkspaceId] = useAtom(currentAgentWorkspaceIdAtom)
  const [workspaces, setWorkspaces] = useAtom(agentWorkspacesAtom)
  // 项目列表排序方式（持久化到 localStorage）
  const [workspaceSortMode, setWorkspaceSortMode] = useAtom(workspaceSortModeAtom)
  /** 工作区切换高亮：记录最近一次切换的时间戳，用于短暂高亮目标工作区 */
  const [workspaceSwitchTs, setWorkspaceSwitchTs] = React.useState(0)
  const prevWorkspaceIdRef = React.useRef(currentWorkspaceId)
  if (currentWorkspaceId !== prevWorkspaceIdRef.current && currentWorkspaceId) {
    prevWorkspaceIdRef.current = currentWorkspaceId
    // 延迟到下一帧设置，避免在 render 中 setState
    setTimeout(() => setWorkspaceSwitchTs(Date.now()), 0)
  }
  /** 稳定 setter：工作区内容未变时保留旧引用，避免级联重渲染 */
  const setWorkspacesStable = React.useCallback((next: AgentWorkspace[]) => {
    setWorkspaces((prev) => {
      if (prev.length !== next.length) return next
      const same = prev.every((w, i) =>
        w.id === next[i]?.id && w.updatedAt === next[i]?.updatedAt && w.isDeleted === next[i]?.isDeleted
      )
      return same ? prev : next
    })
  }, [setWorkspaces])
  const setMode = useSetAtom(appModeAtom)

  // 当前项目能力（MCP + Skill 计数）
  const [capabilities, setCapabilities] = React.useState<WorkspaceCapabilities | null>(null)
  const capabilitiesVersion = useAtomValue(workspaceCapabilitiesVersionAtom)

  // 账号能力：free 用户限 1 个团队工作区
  const [accountCaps, setAccountCaps] = React.useState<{ membershipTier: string; canSelfConfig: boolean }>({ membershipTier: 'free', canSelfConfig: false })
  React.useEffect(() => {
    window.electronAPI.getAccountCapabilities().then((caps) => {
      setAccountCaps({ membershipTier: caps.membershipTier, canSelfConfig: caps.canSelfConfig })
    }).catch(() => {})
  }, [])

  // Tab 状态
  const [tabs, setTabs] = useAtom(tabsAtom)
  const [activeTabId, setActiveTabId] = useAtom(activeTabIdAtom)
  // 会话高亮按"激活 Tab 所属会话"判定：预览 Tab 激活时其 owner 会话仍保持高亮
  const activeSessionId = useAtomValue(activeSessionIdAtom)
  const [sidebarCollapsed, setSidebarCollapsed] = useAtom(sidebarCollapsedAtom)
  const openSession = useOpenSession()
  const syncActiveTabSideEffects = useSyncActiveTabSideEffects()
  const store = useStore()

  // 归档 & 搜索状态
  const [viewMode, setViewMode] = useAtom(sidebarViewModeAtom)

  // ===== 列表渐进渲染：先渲染可见数量（40 条），空闲时批量补全 =====
  const INITIAL_LIST_COUNT = 40
  const LIST_BATCH_SIZE = 40
  const [progressiveCount, setProgressiveCount] = React.useState(INITIAL_LIST_COUNT)
  // 模式/视图切换时重置为初始数量，保证首屏只渲染可见部分
  const progressiveResetKey = `${mode}-${viewMode}`
  React.useEffect(() => {
    setProgressiveCount(INITIAL_LIST_COUNT)
  }, [progressiveResetKey])
  // 空闲时继续补全，直到全部渲染（硬上限避免空转）
  React.useEffect(() => {
    if (progressiveCount >= 1000) return
    const handle = window.requestIdleCallback(
      () => setProgressiveCount((c) => c + LIST_BATCH_SIZE),
      { timeout: 300 },
    )
    return () => window.cancelIdleCallback(handle)
  }, [progressiveCount, progressiveResetKey])
  const setSearchDialogOpen = useSetAtom(searchDialogOpenAtom)

  React.useEffect(() => {
    const id = window.setInterval(() => setRelativeTimeNow(Date.now()), 60_000)
    return () => window.clearInterval(id)
  }, [])

  // 当 activeTabId 变化时，自动滚动侧边栏使选中项可见
  React.useEffect(() => {
    if (!activeTabId) return
    const rafId = requestAnimationFrame(() => {
      const el = document.querySelector('.agent-session-item-active, .session-item-selected')
      el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    })
    return () => cancelAnimationFrame(rafId)
  }, [activeTabId])

  // per-conversation/session Map atoms（删除时清理）
  const setConvModels = useSetAtom(conversationModelsAtom)
  const setConvContextLength = useSetAtom(conversationContextLengthAtom)
  const setConvThinking = useSetAtom(conversationThinkingEnabledAtom)
  const setConvParallel = useSetAtom(conversationParallelModeAtom)
  const setConvPromptId = useSetAtom(conversationPromptIdAtom)
  const setPreviewPanelOpen = useSetAtom(previewPanelOpenMapAtom)
  const setPreviewFile = useSetAtom(previewFileMapAtom)
  const setDiffPanelTab = useSetAtom(agentDiffPanelTabAtom)
  const setDiffRefreshVersion = useSetAtom(agentDiffRefreshVersionAtom)
  const setDiffUnseen = useSetAtom(agentDiffUnseenChangesAtom)
  const setDiffUnseenFiles = useSetAtom(agentDiffUnseenFilesAtom)
  const setDiffData = useSetAtom(agentDiffDataAtom)
  const setStreamingStates = useSetAtom(agentStreamingStatesAtom)
  const setLiveMessagesMap = useSetAtom(liveMessagesMapAtom)
  const setSessionPendingFiles = useSetAtom(agentSessionPendingFilesAtom)
  const setSessionViewStateMap = useSetAtom(sessionViewStateMapAtom)
  const setAgentStreamErrors = useSetAtom(agentStreamErrorsAtom)
  const setAgentPromptSuggestions = useSetAtom(agentPromptSuggestionsAtom)
  const setAllPendingPermissionRequests = useSetAtom(allPendingPermissionRequestsAtom)
  const setAllPendingAskUserRequests = useSetAtom(allPendingAskUserRequestsAtom)
  const setAskUserAnswers = useSetAtom(askUserAnswersAtom)
  const setAllPendingExitPlanRequests = useSetAtom(allPendingExitPlanRequestsAtom)

  /** 清理 per-conversation/session Map atoms 条目 */
  const cleanupMapAtoms = React.useCallback((id: string) => {
    const deleteKey = <T,>(prev: Map<string, T>): Map<string, T> => {
      if (!prev.has(id)) return prev
      const map = new Map(prev)
      map.delete(id)
      return map
    }
    setConvModels(deleteKey)
    setConvContextLength(deleteKey)
    setConvThinking(deleteKey)
    setConvParallel(deleteKey)
    setConvPromptId(deleteKey)
    setPreviewPanelOpen(deleteKey)
    setPreviewFile(deleteKey)
    setDiffPanelTab(deleteKey)
    setDiffRefreshVersion(deleteKey)
    setDiffUnseen(deleteKey)
    setDiffUnseenFiles(deleteKey)
    setDiffData(deleteKey)
    setSessionChannelMap(deleteKey)
    setSessionModelMap(deleteKey)
    // 会话工作目录路径：不清理会导致右侧文件面板继续用已删除目录请求 list-directory
    setSessionPathMap(deleteKey)
    // 视图状态（预览开关 + 上次视图）：删除/归档是终态，统一清理避免孤立条目
    setSessionViewStateMap(deleteKey)

    // 重型流式数据：streamingStates（累积 content + toolActivities）与 liveMessages（SDK 消息数组）
    setStreamingStates(deleteKey)
    setLiveMessagesMap(deleteKey)

    // per-session 请求/错误/提示词状态：删除/归档后清理 Map 条目，避免跨会话累积
    setAgentStreamErrors(deleteKey)
    setAgentPromptSuggestions(deleteKey)
    setAllPendingPermissionRequests(deleteKey)
    setAllPendingAskUserRequests(deleteKey)
    // AskUser 答案草稿按 requestId 存，需按该会话当前请求逐个清理
    {
      const askUserRequestIds = store.get(allPendingAskUserRequestsAtom).get(id)?.map((r) => r.requestId) ?? []
      if (askUserRequestIds.length > 0) {
        setAskUserAnswers((prev) => {
          const map = new Map(prev)
          let changed = false
          for (const rid of askUserRequestIds) if (map.delete(rid)) changed = true
          return changed ? map : prev
        })
      }
    }
    setAllPendingExitPlanRequests(deleteKey)

    // 待发送附件：先释放 blob URL 和 window 缓存中的 base64，再删 base map entry。
    // 与文字草稿不同，附件涉及 ObjectURL 和大体积二进制数据，删除/归档时不保留。
    const sessionPending = store.get(agentSessionPendingFilesAtom).get(id)
    if (sessionPending && sessionPending.length > 0) {
      for (const f of sessionPending) {
        if (f.previewUrl?.startsWith('blob:')) URL.revokeObjectURL(f.previewUrl)
        window.__pendingAgentFileData?.delete(f.id)
      }
      setSessionPendingFiles(deleteKey)
    }

    // atomFamily 内部缓存（Jotai 对 string key 强引用 Map，不显式 remove 永不释放）。
    // 删除/归档是会话的终态，连同草稿一起清理，无需像关闭 Tab 那样保留可恢复输入。
    agentSessionStreamingStateAtomFamily.remove(id)
    agentSessionDraftAtomFamily.remove(id)
    agentSessionDraftHtmlAtomFamily.remove(id)
    agentPendingFilesAtomFamily.remove(id)
    backgroundTasksAtomFamily.remove(id)
    sessionPersistedPermissionModeAtom.remove(id)
    sessionExistsAtom.remove(id)

    clearPreviewCacheForSession(id)
  }, [setConvModels, setConvContextLength, setConvThinking, setConvParallel, setConvPromptId, setPreviewPanelOpen, setPreviewFile, setDiffPanelTab, setDiffRefreshVersion, setDiffUnseen, setDiffUnseenFiles, setDiffData, setSessionChannelMap, setSessionModelMap, setSessionPathMap, setSessionViewStateMap, setStreamingStates, setLiveMessagesMap, setAgentStreamErrors, setAgentPromptSuggestions, setAllPendingPermissionRequests, setAllPendingAskUserRequests, setAskUserAnswers, setAllPendingExitPlanRequests, setSessionPendingFiles, store])

  const currentWorkspaceSlug = React.useMemo(() => {
    if (!currentWorkspaceId) return null
    return workspaces.find((w) => w.id === currentWorkspaceId)?.slug ?? null
  }, [currentWorkspaceId, workspaces])

  const workspaceNameMap = React.useMemo(() => {
    const map = new Map<string, string>()
    for (const w of workspaces) map.set(w.id, w.name)
    return map
  }, [workspaces])

  const pendingDeleteWorkspace = React.useMemo(
    () => workspaces.find((workspace) => workspace.id === pendingDeleteWorkspaceId) ?? null,
    [pendingDeleteWorkspaceId, workspaces],
  )

  React.useEffect(() => {
    if (!currentWorkspaceSlug || mode !== 'agent') {
      setCapabilities(null)
      return
    }
    window.electronAPI
      .getWorkspaceCapabilities(currentWorkspaceSlug)
      .then(setCapabilities)
      .catch(console.error)
  }, [currentWorkspaceSlug, mode, activeView, capabilitiesVersion])

  /** 置顶对话列表（仅活跃模式显示，排除 draft） */
  const pinnedConversations = React.useMemo(
    () => viewMode === 'active' ? conversations.filter((c) => c.pinned && !draftSessionIds.has(c.id)) : [],
    [conversations, viewMode, draftSessionIds]
  )

  /** 置顶 Agent 会话列表（仅活跃模式显示，跨项目展示，排除 draft） */
  const pinnedAgentSessions = React.useMemo(
    () => {
      if (viewMode !== 'active') return []
      const filtered = agentSessions.filter((s) =>
        s.pinned
        && !s.draft
        && !draftSessionIds.has(s.id)
        && !hasPinnedVisibleParent(s, agentSessions)
      )
      return sortAgentSessionsByUpdatedAtDesc(filtered)
    },
    [agentSessions, viewMode, draftSessionIds]
  )

  const pinnedAgentSessionTrees = React.useMemo<AgentSessionTreeItem[]>(
    () => pinnedAgentSessions.map((session) => ({
      session,
      childSessions: getDirectDelegatedChildren(agentSessions, session.id).filter((child) => (
        !child.archived
        && !child.draft
        && !draftSessionIds.has(child.id)
      )),
    })),
    [agentSessions, draftSessionIds, pinnedAgentSessions],
  )

  /** 对话按日期分组（根据 viewMode 过滤归档状态，排除 draft） */
  const conversationGroups = React.useMemo(
    () => {
      const filtered = viewMode === 'archived'
        ? conversations.filter((c) => c.archived && !draftSessionIds.has(c.id))
        : conversations.filter((c) => !c.archived && !c.pinned && !draftSessionIds.has(c.id))
      return groupByDate(filtered)
    },
    [conversations, viewMode, draftSessionIds]
  )

  /** 对话列表渐进切片：先渲染可见数量，空闲补全 */
  const progressiveConversationGroups = React.useMemo(
    () => sliceGroupsByCount(conversationGroups, progressiveCount),
    [conversationGroups, progressiveCount]
  )

  /** 已归档对话数量 */
  const archivedConversationCount = React.useMemo(
    () => conversations.filter((c) => c.archived).length,
    [conversations]
  )

  /** 已归档 Agent 会话数量（跨项目） */
  const archivedAgentSessionCount = React.useMemo(
    () => agentSessions.filter((s) => s.archived && !s.draft && !draftSessionIds.has(s.id)).length,
    [agentSessions, draftSessionIds]
  )

  // 初始加载对话列表 + 用户档案 + Agent 会话
  React.useEffect(() => {
    window.electronAPI
      .listConversations()
      .then((list) => {
        setConversations(list)
      })
      .catch(console.error)
    window.electronAPI
      .getUserProfile()
      .then(setUserProfile)
      .catch(console.error)
    window.electronAPI
      .listAgentSessions()
      .then(setAgentSessions)
      .catch(console.error)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setConversations, setUserProfile, setAgentSessions])

  // 窗口聚焦时重新同步列表，修复长时间后前后端不一致
  React.useEffect(() => {
    const handleFocus = (): void => {
      window.electronAPI.listConversations().then(setConversations).catch(console.error)
      window.electronAPI.listAgentSessions().then(setAgentSessions).catch(console.error)
    }
    window.addEventListener('focus', handleFocus)
    return () => window.removeEventListener('focus', handleFocus)
  }, [setConversations, setAgentSessions])

  // 监听团队工作区同步事件，登录/注册成功后自动刷新侧边栏
  React.useEffect(() => {
    const unsub = window.electronAPI.team.onWorkspacesSynced(() => {
      window.electronAPI.listAgentWorkspaces().then(setWorkspacesStable).catch(console.error)
    })
    return unsub
  }, [setWorkspacesStable])

  // authStatus 变化时刷新工作区（登录/登出）
  // 仅立即刷新一次，不再 500ms 二次刷新——syncTeamWorkspacesToIndex 在 IPC 端已保证原子写入
  React.useEffect(() => {
    window.electronAPI.listAgentWorkspaces().then(setWorkspacesStable).catch(console.error)
  }, [authStatus.isLoggedIn, setWorkspacesStable])

  /** 打开规划中心（Todo · 日程 · 定时任务） */
  const handleOpenAutomations = React.useCallback((): void => {
    // 已激活时再次点击切回对话列表（编辑页则先关表单回列表）（#972）
    if (activeView === 'planning') {
      if (store.get(automationFormAtom).open) {
        setAutomationForm({ open: false, draft: null })
        return
      }
      setActiveView('conversations')
      return
    }
    setAutomationForm({ open: false, draft: null })
    setActiveView('planning')
  }, [activeView, setAutomationForm, setActiveView, store])

  /** 打开 Agent 技能视图 */
  const handleOpenSkills = React.useCallback((): void => {
    // 已激活时再次点击切回对话列表（#972）
    if (activeView === 'agent-skills') {
      setActiveView('conversations')
      return
    }
    setActiveView('agent-skills')
  }, [activeView, setActiveView])

  // 切换模式时重置归档视图
  React.useEffect(() => {
    setViewMode('active')
  }, [mode, setViewMode])

  /** 创建新对话（继承当前选中的模型/渠道） */
  const handleNewConversation = async (): Promise<void> => {
    setActiveView('conversations')
    try {
      const meta = await window.electronAPI.createConversation(
        undefined,
        selectedModel?.modelId,
        selectedModel?.channelId,
      )
      setConversations((prev) => [meta, ...prev])
      // 打开新标签页
      openSession('chat', meta.id, meta.title)
      // 确保在对话视图
      setActiveView('conversations')
      // 根据默认提示词重置选中
      if (promptConfig.defaultPromptId) {
        setSelectedPromptId(promptConfig.defaultPromptId)
      }
    } catch (error) {
      console.error('[侧边栏] 创建对话失败:', error)
    }
  }

  /** 选择对话（打开或聚焦标签页） */
  const handleSelectConversation = React.useCallback((id: string, title: string): void => {
    openSession('chat', id, title)
    setActiveView('conversations')
  }, [openSession, setActiveView])

  /** 请求删除对话（弹出确认框） */
  const handleRequestDelete = React.useCallback((id: string): void => {
    setPendingDeleteId(id)
  }, [])

  /** 重命名对话标题 */
  const handleRename = React.useCallback(async (id: string, newTitle: string): Promise<void> => {
    try {
      const updated = await window.electronAPI.updateConversationTitle(id, newTitle)
      setConversations((prev) =>
        prev.map((c) => (c.id === updated.id ? updated : c))
      )
      // 同步更新标签页标题
      setTabs((prev) => updateTabTitle(prev, id, newTitle))
    } catch (error) {
      console.error('[侧边栏] 重命名对话失败:', error)
    }
  }, [setConversations, setTabs])

  /** 切换对话置顶状态 */
  const handleTogglePin = React.useCallback(async (id: string): Promise<void> => {
    try {
      const original = store.get(conversationsAtom).find((c) => c.id === id)
      const updated = await window.electronAPI.togglePinConversation(id)
      setConversations((prev) =>
        prev.map((c) => (c.id === updated.id ? updated : c))
      )
      // 归档会话被置顶时会自动取消归档
      if (original?.archived && updated.pinned && !updated.archived) {
        toast.success('已取消归档并置顶')
      }
    } catch (error) {
      console.error('[侧边栏] 切换置顶失败:', error)
    }
  }, [store, setConversations])

  /** 切换对话归档状态 */
  const handleToggleArchive = React.useCallback(async (id: string): Promise<void> => {
    try {
      const updated = await window.electronAPI.toggleArchiveConversation(id)
      setConversations((prev) =>
        prev.map((c) => (c.id === updated.id ? updated : c))
      )
      // 归档时自动关闭该对话的标签页，并同步新激活标签的副作用
      // （appMode、currentXxxId 等），避免文件面板/工具栏等 per-tab
      // 状态被遗留为旧值或被错误地置 null。
      if (updated.archived) {
        const currentTabs = store.get(tabsAtom)
        const currentActiveTabId = store.get(activeTabIdAtom)
        const wasActive = currentActiveTabId === id
        const tabResult = closeTab(currentTabs, currentActiveTabId, id)
        setTabs(tabResult.tabs)
        setActiveTabId(tabResult.activeTabId)
        cleanupMapAtoms(id)
        if (wasActive) {
          const newActiveTab = tabResult.activeTabId
            ? tabResult.tabs.find((t) => t.id === tabResult.activeTabId) ?? null
            : null
          syncActiveTabSideEffects(newActiveTab)
        }
      }
      toast.success(updated.archived ? '已归档' : '已取消归档')
    } catch (error) {
      console.error('[侧边栏] 切换归档失败:', error)
    }
  }, [store, setConversations, setTabs, setActiveTabId, cleanupMapAtoms, syncActiveTabSideEffects])

  /** 确认删除对话 */
  const handleConfirmDelete = async (): Promise<void> => {
    if (!pendingDeleteId) return

    // 关闭对应的标签页：setTabs 与 setActiveTabId 成组更新，便于阅读，
    // 也避免将来在两者之间意外插入 await 导致跨渲染状态不一致。
    // （React 18 在同一事件回调中会自动批处理多次 setState，所以单次渲染
    // 的一致性由 React 保证，这里只是保持代码组织清晰。）
    const wasActive = activeTabId === pendingDeleteId
    const tabResult = closeTab(tabs, activeTabId, pendingDeleteId)
    setTabs(tabResult.tabs)
    setActiveTabId(tabResult.activeTabId)

    // 若关闭的是当前活跃标签，同步新激活标签的副作用（appMode、
    // currentXxxId、以及右侧文件面板等 per-tab 状态），保持与 TabBar
    // 关闭逻辑一致，避免删除/归档当前会话后新标签状态缺失。
    if (wasActive) {
      const newActiveTab = tabResult.activeTabId
        ? tabResult.tabs.find((t) => t.id === tabResult.activeTabId) ?? null
        : null
      syncActiveTabSideEffects(newActiveTab)
    }

    // 清理 draft 标记（如有）
    setDraftSessionIds((prev: Set<string>) => {
      if (!prev.has(pendingDeleteId)) return prev
      const next = new Set(prev)
      next.delete(pendingDeleteId)
      return next
    })

    // 清理 per-conversation/session Map atoms 条目
    cleanupMapAtoms(pendingDeleteId)
    setExpandedDelegationParentIds((prev) => deleteSetEntry(prev, pendingDeleteId))

    if (mode === 'agent') {
      // Agent 模式：删除 Agent 会话
      // 注意：当前会话指针（currentAgentSessionId）已由上面的
      // syncActiveTabSideEffects 在 wasActive 分支同步到新激活标签，
      // 这里不要再按旧闭包值强制置 null，否则会覆盖新 sessionId，
      // 导致 RightSidePanel 消失（依赖 currentAgentSessionIdAtom）。
      try {
        await window.electronAPI.deleteAgentSession(pendingDeleteId)
        // 全量刷新确保与后端同步
        const sessions = await window.electronAPI.listAgentSessions()
        setAgentSessions(sessions)
      } catch (error) {
        console.error('[侧边栏] 删除 Agent 会话失败:', error)
        // 即使后端报错，也从本地列表移除（可能是会话已不存在）
        setAgentSessions((prev) => prev.filter((s) => s.id !== pendingDeleteId))
      } finally {
        // 清理该会话的消息缓存，避免已删除会话的消息数组滞留内存
        setAgentMessagesCache((prev) => {
          if (!prev.has(pendingDeleteId)) return prev
          const next = new Map(prev)
          next.delete(pendingDeleteId)
          return next
        })
        setPendingDeleteId(null)
      }
      return
    }

    try {
      await window.electronAPI.deleteConversation(pendingDeleteId)
      // 全量刷新确保与后端同步
      const conversations = await window.electronAPI.listConversations()
      setConversations(conversations)
    } catch (error) {
      console.error('[侧边栏] 删除对话失败:', error)
      // 即使后端报错，也从本地列表移除（可能是对话已不存在）
      setConversations((prev) => prev.filter((c) => c.id !== pendingDeleteId))
    } finally {
      setPendingDeleteId(null)
    }
  }

  /** 在指定项目中创建 Agent 会话；未指定时使用当前项目 */
  const createAgentSessionInWorkspace = React.useCallback(async (workspaceId?: string): Promise<void> => {
    try {
      const targetWorkspaceId = workspaceId ?? currentWorkspaceId ?? undefined
      if (targetWorkspaceId && targetWorkspaceId !== currentWorkspaceId) {
        setCurrentWorkspaceId(targetWorkspaceId)
        window.electronAPI.updateSettings({ agentWorkspaceId: targetWorkspaceId }).catch(console.error)
      }

      const meta = await window.electronAPI.createAgentSession(
        undefined,
        agentChannelId || undefined,
        targetWorkspaceId,
        agentModelId || undefined,
      )
      setAgentSessions((prev) => [meta, ...prev])
      // 从全局默认值初始化 per-session 渠道/模型配置
      if (agentChannelId) {
        setSessionChannelMap((prev) => {
          const map = new Map(prev)
          map.set(meta.id, agentChannelId)
          return map
        })
      }
      if (agentModelId) {
        setSessionModelMap((prev) => {
          const map = new Map(prev)
          map.set(meta.id, agentModelId)
          return map
        })
      }
      // 打开新标签页
      openSession('agent', meta.id, meta.title)
      setActiveView('conversations')
    } catch (error) {
      console.error('[侧边栏] 创建 Agent 会话失败:', error)
      toast.error(error instanceof Error ? error.message : '创建会话失败')
    }
  }, [agentChannelId, agentModelId, currentWorkspaceId, openSession, setActiveView, setAgentSessions, setCurrentWorkspaceId, setSessionChannelMap, setSessionModelMap])

  /** 创建新 Agent 会话 */
  const handleNewAgentSession = React.useCallback(async (): Promise<void> => {
    setActiveView('conversations')
    await createAgentSessionInWorkspace()
  }, [createAgentSessionInWorkspace, setActiveView])

  /** 选择项目并打开其隐藏草稿会话；真实 UI 直接复用 AgentView。 */
  const handleSelectProject = React.useCallback(async (workspaceId: string): Promise<void> => {
    const requestId = ++projectSelectionRequestRef.current
    setCurrentWorkspaceId(workspaceId)
    setActiveView('conversations')
    setCollapsedWorkspaceIds((prev) => deleteSetEntry(prev, workspaceId))
    window.electronAPI.updateSettings({ agentWorkspaceId: workspaceId }).catch(console.error)

    try {
      const session = await window.electronAPI.ensureProjectDraftAgentSession(
        workspaceId,
        agentChannelId || undefined,
        agentModelId || undefined,
      )
      setAgentSessions((previous) => {
        const index = previous.findIndex((item) => item.id === session.id)
        if (index === -1) return [session, ...previous]
        const next = [...previous]
        next[index] = session
        return next
      })
      setDraftSessionIds((previous: Set<string>) => {
        if (previous.has(session.id)) return previous
        const next = new Set(previous)
        next.add(session.id)
        return next
      })
      if (requestId !== projectSelectionRequestRef.current) return
      setCurrentAgentSessionId(session.id)
      openSession('agent', session.id, session.title)
    } catch (error) {
      console.error('[侧边栏] 创建项目草稿会话失败:', error)
      toast.error(error instanceof Error ? error.message : '创建项目草稿会话失败')
    }
  }, [agentChannelId, agentModelId, openSession, setActiveView, setAgentSessions, setCollapsedWorkspaceIds, setCurrentAgentSessionId, setCurrentWorkspaceId, setDraftSessionIds])

  const handleToggleProjectCollapse = React.useCallback((workspaceId: string): void => {
    setCollapsedWorkspaceIds((previous) => toggleSetEntry(previous, workspaceId))
  }, [setCollapsedWorkspaceIds])

  const canDeleteWorkspace = React.useCallback(
    (workspace: AgentWorkspace): boolean => workspace.slug !== 'default' && workspaces.length > 1,
    [workspaces.length],
  )

  /** 请求删除项目（弹出二次确认框） */
  const handleRequestDeleteWorkspace = React.useCallback((workspaceId: string): void => {
    setPendingDeleteWorkspaceId(workspaceId)
  }, [])

  /** 确认删除项目及其绑定资源 */
  const handleConfirmDeleteWorkspace = React.useCallback(async (): Promise<void> => {
    const workspaceId = pendingDeleteWorkspaceId
    const workspace = workspaces.find((item) => item.id === workspaceId)
    if (!workspaceId || !workspace) return

    if (!canDeleteWorkspace(workspace)) {
      toast.error(workspace.slug === 'default' ? '默认项目不能删除' : '至少需要保留一个项目')
      setPendingDeleteWorkspaceId(null)
      return
    }

    const deletedSessionIds = new Set(
      agentSessions
        .filter((session) => session.workspaceId === workspaceId)
        .map((session) => session.id),
    )

    try {
      setDeletingWorkspaceId(workspaceId)

      await window.electronAPI.deleteAgentWorkspace(workspaceId)

      for (const sessionId of deletedSessionIds) {
        cleanupMapAtoms(sessionId)
      }

      setDraftSessionIds((prev: Set<string>) => {
        let changed = false
        const next = new Set(prev)
        for (const sessionId of deletedSessionIds) {
          if (next.delete(sessionId)) changed = true
        }
        return changed ? next : prev
      })

      setAgentMessagesCache((prev) => {
        let changed = false
        const next = new Map(prev)
        for (const sessionId of deletedSessionIds) {
          if (next.delete(sessionId)) changed = true
        }
        return changed ? next : prev
      })
      setAutomations((prev) => prev.filter((automation) => automation.workspaceId !== workspaceId))

      const currentTabs = store.get(tabsAtom)
      const currentActiveTabId = store.get(activeTabIdAtom)
      const nextTabs = currentTabs.filter((tab) => (
        (tab.type !== 'agent' && tab.type !== 'preview') || !deletedSessionIds.has(tab.sessionId)
      ))
      const nextActiveTabId = currentActiveTabId && nextTabs.some((tab) => tab.id === currentActiveTabId)
        ? currentActiveTabId
        : nextTabs[0]?.id ?? null

      setTabs(nextTabs)
      setActiveTabId(nextActiveTabId)
      syncActiveTabSideEffects(nextActiveTabId ? nextTabs.find((tab) => tab.id === nextActiveTabId) ?? null : null)

      const [remainingWorkspaces, sessions] = await Promise.all([
        window.electronAPI.listAgentWorkspaces(),
        window.electronAPI.listAgentSessions(),
      ])

      setWorkspaces(remainingWorkspaces)
      setAgentSessions(sessions)

      setExpandedExtraCountMap((prev) => {
        if (!prev.has(workspaceId)) return prev
        const next = new Map(prev)
        next.delete(workspaceId)
        return next
      })

      setCollapsedWorkspaceIds((prev) => deleteSetEntry(prev, workspaceId))
      setExpandedDelegationParentIds((prev) => {
        let changed = false
        const next = new Set(prev)
        for (const sessionId of deletedSessionIds) {
          if (next.delete(sessionId)) changed = true
        }
        return changed ? next : prev
      })

      if (workspaceId === currentWorkspaceId) {
        const fallback = remainingWorkspaces.find((item) => item.slug === 'default') ?? remainingWorkspaces[0] ?? null
        setCurrentWorkspaceId(fallback?.id ?? null)
        if (fallback) {
          window.electronAPI.updateSettings({ agentWorkspaceId: fallback.id }).catch(console.error)
        }
      }

      toast.success('项目已删除', {
        description: `已删除「${workspace.name}」及其绑定资源`,
      })
    } catch (error) {
      console.error('[侧边栏] 删除项目失败:', error)
      const msg = error instanceof Error ? error.message : '删除项目失败'
      toast.error(msg)
    } finally {
      setDeletingWorkspaceId(null)
      setPendingDeleteWorkspaceId(null)
    }
  }, [
    pendingDeleteWorkspaceId,
    workspaces,
    canDeleteWorkspace,
    agentSessions,
    cleanupMapAtoms,
    setDraftSessionIds,
    setAgentMessagesCache,
    setAutomations,
    store,
    setTabs,
    setActiveTabId,
    syncActiveTabSideEffects,
    setWorkspaces,
    setAgentSessions,
    currentWorkspaceId,
    setCurrentWorkspaceId,
  ])

  /** 展开某个项目时每次额外显示的会话数量 */
  const handleShowMoreSessions = React.useCallback((workspaceId: string): void => {
    setExpandedExtraCountMap((prev) => {
      const next = new Map(prev)
      next.set(workspaceId, (prev.get(workspaceId) ?? 0) + PROJECT_SESSION_EXPAND_STEP)
      return next
    })
  }, [])

  /** 收起某个项目额外展开的会话 */
  const handleCollapseExtraSessions = React.useCallback((workspaceId: string): void => {
    setExpandedExtraCountMap((prev) => {
      if (!prev.has(workspaceId)) return prev
      const next = new Map(prev)
      next.delete(workspaceId)
      return next
    })
  }, [])

  /** 开始拖拽项目排序 */
  const handleProjectDragStart = React.useCallback((e: React.DragEvent, workspaceId: string): void => {
    setDragProjectId(workspaceId)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', workspaceId)
  }, [])

  /** 根据鼠标位置计算项目插入点 */
  const handleProjectDragOver = React.useCallback((e: React.DragEvent, workspaceId: string): void => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (!dragProjectId || dragProjectId === workspaceId) {
      setProjectDropIndicator(null)
      return
    }

    const rect = e.currentTarget.getBoundingClientRect()
    const ratio = (e.clientY - rect.top) / rect.height
    const position: 'before' | 'after' = ratio < 0.5 ? 'before' : 'after'
    setProjectDropIndicator((prev) => (
      prev?.id === workspaceId && prev.position === position
        ? prev
        : { id: workspaceId, position }
    ))
  }, [dragProjectId])

  const handleProjectDragLeave = React.useCallback((e: React.DragEvent): void => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setProjectDropIndicator(null)
    }
  }, [])

  /** 完成项目排序并持久化 */
  const handleProjectDrop = React.useCallback((e: React.DragEvent, targetWorkspaceId: string): void => {
    e.preventDefault()
    if (!dragProjectId || dragProjectId === targetWorkspaceId || !projectDropIndicator || projectDropIndicator.id !== targetWorkspaceId) {
      setDragProjectId(null)
      setProjectDropIndicator(null)
      return
    }

    const fromIndex = workspaces.findIndex((workspace) => workspace.id === dragProjectId)
    const toIndex = workspaces.findIndex((workspace) => workspace.id === targetWorkspaceId)
    if (fromIndex === -1 || toIndex === -1) {
      setDragProjectId(null)
      setProjectDropIndicator(null)
      return
    }

    const reordered = [...workspaces]
    const [moved] = reordered.splice(fromIndex, 1)
    if (!moved) {
      setDragProjectId(null)
      setProjectDropIndicator(null)
      return
    }
    const adjustedToIndex = fromIndex < toIndex ? toIndex - 1 : toIndex
    const insertIndex = projectDropIndicator.position === 'after' ? adjustedToIndex + 1 : adjustedToIndex
    reordered.splice(insertIndex, 0, moved)

    setWorkspaces(reordered)
    setDragProjectId(null)
    setProjectDropIndicator(null)
    window.electronAPI
      .reorderAgentWorkspaces(reordered.map((workspace) => workspace.id))
      .then(setWorkspaces)
      .catch((error) => {
        console.error('[侧边栏] 项目排序失败:', error)
        setWorkspaces(workspaces)
        toast.error('项目排序失败')
      })
  }, [dragProjectId, projectDropIndicator, setWorkspaces, workspaces])

  const handleProjectDragEnd = React.useCallback((): void => {
    setDragProjectId(null)
    setProjectDropIndicator(null)
  }, [])

  /** 打开加入工作区对话框 */
  const handleStartJoinWorkspace = React.useCallback((): void => {
    setInviteCode('')
    setShowJoinDialog(true)
  }, [])

  /** 通过邀请码加入团队工作区 */
  const handleJoinWorkspace = React.useCallback(async (): Promise<void> => {
    const code = inviteCode.trim()
    if (!code) {
      toast.error('请输入邀请码')
      return
    }
    try {
      const workspace = await window.electronAPI.team.acceptInvitation(code)
      toast.success(`已加入工作区「${workspace.name}」`)
      setShowJoinDialog(false)
      // 刷新工作区列表
      const workspaces = await window.electronAPI.listAgentWorkspaces()
      setWorkspaces(workspaces)
    } catch (err) {
      const msg = err instanceof Error ? err.message : '加入失败'
      toast.error(msg)
    }
  }, [inviteCode, setWorkspaces])

  /** 开始创建新项目 */
  const handleStartCreateProject = React.useCallback((): void => {
    setCreatingProject(true)
    setNewProjectName('')
    requestAnimationFrame(() => {
      newProjectInputRef.current?.focus()
    })
  }, [])

  /** 创建新项目，并设为当前项目 */
  const handleCreateProject = React.useCallback(async (): Promise<void> => {
    const trimmed = newProjectName.trim()
    if (!trimmed) {
      setCreatingProject(false)
      return
    }

    try {
      const workspace = await window.electronAPI.createAgentWorkspace(trimmed)
      setWorkspaces((prev) => [workspace, ...prev])
      setCurrentWorkspaceId(workspace.id)
      window.electronAPI.updateSettings({ agentWorkspaceId: workspace.id }).catch(console.error)
      setCreatingProject(false)
      setNewProjectName('')
    } catch (error) {
      const msg = error instanceof Error ? error.message : '创建项目失败'
      toast.error(msg)
    }
  }, [newProjectName, setCurrentWorkspaceId, setWorkspaces])

  const handleCreateProjectKeyDown = React.useCallback((e: React.KeyboardEvent): void => {
    if (e.key === 'Enter') {
      if (e.nativeEvent.isComposing) return
      e.preventDefault()
      void handleCreateProject()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setCreatingProject(false)
      setNewProjectName('')
    }
  }, [handleCreateProject])

  /** 选择 Agent 会话（打开或聚焦标签页） */
  const handleSelectAgentSession = React.useCallback((id: string, title: string): void => {
    openSession('agent', id, title)
    setActiveView('conversations')
    // 清除该会话的"已完成未查看"标记
    setUnviewedCompleted((prev: Set<string>) => {
      if (!prev.has(id)) return prev
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }, [openSession, setActiveView, setUnviewedCompleted])

  /** 重命名工作区（项目）名称 */
  const handleWorkspaceRename = React.useCallback(async (workspaceId: string, newName: string): Promise<void> => {
    try {
      const updated = await window.electronAPI.updateAgentWorkspace(workspaceId, { name: newName })
      setWorkspaces((prev) => prev.map((w) => (w.id === updated.id ? updated : w)))
    } catch (error) {
      console.error('[侧边栏] 重命名工作区失败:', error)
      const msg = error instanceof Error ? error.message : '重命名失败'
      toast.error(msg)
    }
  }, [setWorkspaces])

  /** 重命名 Agent 会话标题 */
  const handleAgentRename = React.useCallback(async (id: string, newTitle: string): Promise<void> => {
    try {
      const updated = await window.electronAPI.updateAgentSessionTitle(id, newTitle)
      setAgentSessions((prev) => replaceAgentSessionInFreshnessOrder(prev, updated))
      // 同步更新标签页标题
      setTabs((prev) => updateTabTitle(prev, id, newTitle))
    } catch (error) {
      console.error('[侧边栏] 重命名 Agent 会话失败:', error)
    }
  }, [setAgentSessions, setTabs])

  const closeArchivedAgentTabs = React.useCallback((sessionIds: string[]): void => {
    const ids = new Set(sessionIds)
    const currentTabs = store.get(tabsAtom)
    const currentActiveTabId = store.get(activeTabIdAtom)
    const nextTabs = currentTabs.filter((tab) => (
      (tab.type !== 'agent' && tab.type !== 'preview') || !ids.has(tab.sessionId)
    ))
    const nextActiveTabId = currentActiveTabId && nextTabs.some((tab) => tab.id === currentActiveTabId)
      ? currentActiveTabId
      : nextTabs[0]?.id ?? null

    setTabs(nextTabs)
    setActiveTabId(nextActiveTabId)
    for (const sessionId of ids) cleanupMapAtoms(sessionId)
    syncActiveTabSideEffects(nextActiveTabId ? nextTabs.find((tab) => tab.id === nextActiveTabId) ?? null : null)
  }, [cleanupMapAtoms, setActiveTabId, setTabs, store, syncActiveTabSideEffects])

  /** 切换 Agent 会话置顶状态 */
  const handleTogglePinAgent = React.useCallback(async (id: string): Promise<void> => {
    const sessions = store.get(agentSessionsAtom)
    const original = sessions.find((s) => s.id === id)
    const delegatedChildren = getSyncableDelegatedChildren(sessions, id, draftSessionIds)
    try {
      const updated = await window.electronAPI.togglePinAgentSession(id)
      const targetPinned = !!updated.pinned
      for (const child of delegatedChildren) {
        if (!!child.pinned !== targetPinned) {
          await window.electronAPI.togglePinAgentSession(child.id)
        }
      }
      const refreshedSessions = delegatedChildren.length > 0
        ? await window.electronAPI.listAgentSessions()
        : null
      if (refreshedSessions) {
        setAgentSessions(refreshedSessions)
      } else {
        setAgentSessions((prev) => replaceAgentSessionInFreshnessOrder(prev, updated))
      }
      if (updated.pinned) {
        if (original?.archived && !updated.archived) {
          toast.success('已置顶', { description: '已自动取消归档' })
        } else if (delegatedChildren.length > 0) {
          toast.success('已置顶', { description: `已同步 ${delegatedChildren.length} 个子会话` })
        } else {
          toast.success('已置顶')
        }
      } else {
        toast.success(
          '已取消置顶',
          delegatedChildren.length > 0
            ? { description: `已同步 ${delegatedChildren.length} 个子会话` }
            : undefined,
        )
      }
    } catch (error) {
      console.error('[侧边栏] 切换 Agent 会话置顶失败:', error)
      if (delegatedChildren.length > 0) {
        try {
          setAgentSessions(await window.electronAPI.listAgentSessions())
        } catch (refreshError) {
          console.error('[侧边栏] 置顶失败后刷新会话列表失败:', refreshError)
        }
      }
    }
  }, [draftSessionIds, store, setAgentSessions])

  /** 切换 Agent 会话归档状态 */
  const handleToggleArchiveAgent = React.useCallback(async (id: string): Promise<void> => {
    const sessions = store.get(agentSessionsAtom)
    let cascaded = false
    const changedChildIds: string[] = []
    try {
      const updated = await window.electronAPI.toggleArchiveAgentSession(id)
      const targetArchived = !!updated.archived
      const delegatedChildren = targetArchived
        ? getSyncableDelegatedChildren(sessions, id, draftSessionIds)
        : []
      cascaded = delegatedChildren.length > 0
      for (const child of delegatedChildren) {
        if (!!child.archived !== targetArchived) {
          const childUpdated = await window.electronAPI.toggleArchiveAgentSession(child.id)
          changedChildIds.push(childUpdated.id)
        }
      }
      const refreshedSessions = delegatedChildren.length > 0
        ? await window.electronAPI.listAgentSessions()
        : null
      if (refreshedSessions) {
        setAgentSessions(refreshedSessions)
      } else {
        setAgentSessions((prev) => replaceAgentSessionInFreshnessOrder(prev, updated))
      }
      if (updated.archived) {
        closeArchivedAgentTabs([updated.id, ...changedChildIds])
      }
      toast.success(
        updated.archived ? '已归档' : '已取消归档',
        delegatedChildren.length > 0
          ? { description: `已同步 ${delegatedChildren.length} 个子会话` }
          : undefined,
      )
    } catch (error) {
      console.error('[侧边栏] 切换 Agent 会话归档失败:', error)
      if (cascaded) {
        if (changedChildIds.length > 0) {
          closeArchivedAgentTabs(changedChildIds)
        }
        try {
          setAgentSessions(await window.electronAPI.listAgentSessions())
        } catch (refreshError) {
          console.error('[侧边栏] 归档失败后刷新会话列表失败:', refreshError)
        }
      }
    }
  }, [closeArchivedAgentTabs, draftSessionIds, store, setAgentSessions])

  /** 请求迁移会话到其他项目（弹出迁移对话框） */
  const handleRequestMove = React.useCallback((id: string): void => {
    setMoveTargetId(id)
  }, [])

  const handleToggleDelegationParent = React.useCallback((sessionId: string): void => {
    setExpandedDelegationParentIds((prev) => toggleSetEntry(prev, sessionId))
  }, [])

  /** 迁移会话到另一个项目后的回调 */
  const handleSessionMoved = (updatedSession: AgentSessionMeta, targetWorkspaceName: string): void => {
    setAgentSessions((prev) => replaceAgentSessionInFreshnessOrder(prev, updatedSession))
    // 如果迁移的是当前选中的会话，取消选中并关闭标签页
    if (currentAgentSessionId === updatedSession.id) {
      const tabResult = closeTab(tabs, activeTabId, updatedSession.id)
      setTabs(tabResult.tabs)
      setActiveTabId(tabResult.activeTabId)
      setCurrentAgentSessionId(null)
    }
    setMoveTargetId(null)
    toast.success('会话已迁移', {
      description: `已迁移到「${targetWorkspaceName}」，请切换项目查看`,
    })
  }

  /** 切换项目排序方式（default → recent → name 循环） */
  const handleCycleWorkspaceSort = React.useCallback((): void => {
    setWorkspaceSortMode((prev) => getNextWorkspaceSortMode(prev))
  }, [setWorkspaceSortMode])

  /** 按当前排序方式重排项目（仅影响显示顺序，不改动 workspaces 原始顺序） */
  const sortedWorkspaces = React.useMemo(() => {
    if (workspaceSortMode === 'recent') {
      // 「最近」按项目最近活跃时间排序：取其最新会话的 updatedAt，无会话时退回项目自身 updatedAt。
      // 草稿会话是点击项目时生成的隐藏占位、归档会话已不活跃，均不参与判定，
      // 否则点击项目就会刷新草稿时间、让项目凭空跳到最上面。
      const recencyByWorkspace = new Map<string, number>()
      for (const session of agentSessions) {
        const workspaceId = session.workspaceId
        if (!workspaceId || session.draft || session.archived) continue
        const previous = recencyByWorkspace.get(workspaceId) ?? 0
        if (session.updatedAt > previous) recencyByWorkspace.set(workspaceId, session.updatedAt)
      }
      return [...workspaces].sort((a, b) => {
        const recencyA = recencyByWorkspace.get(a.id) ?? a.updatedAt
        const recencyB = recencyByWorkspace.get(b.id) ?? b.updatedAt
        return recencyB - recencyA
      })
    }
    if (workspaceSortMode === 'name') {
      return [...workspaces].sort((a, b) => workspaceNameCollator.compare(a.name, b.name))
    }
    return workspaces
  }, [workspaces, workspaceSortMode, agentSessions])

  /** Agent 普通历史按项目分组（排除置顶 / 归档 / draft） */
  const agentProjectGroups = React.useMemo<AgentProjectGroup[]>(
    () => {
      const sessionsByWorkspaceId = new Map<string, AgentSessionMeta[]>()
      for (const workspace of sortedWorkspaces) {
        sessionsByWorkspaceId.set(workspace.id, [])
      }

      const visibleHistory = sortAgentSessionsByUpdatedAtDesc(
        agentSessions.filter((session) =>
          !session.archived
          && !session.pinned
          && !session.draft
          && !draftSessionIds.has(session.id)
          // 已被置顶母会话收纳的子会话留在置顶区的母会话下面，避免重复显示为项目根会话
          && !hasPinnedVisibleParent(session, agentSessions)
        )
      )

      const defaultWsId = sortedWorkspaces.find((ws) => ws.slug === 'default')?.id ?? sortedWorkspaces[0]?.id
      for (const session of visibleHistory) {
        const targetId = session.workspaceId && sessionsByWorkspaceId.has(session.workspaceId)
          ? session.workspaceId
          : defaultWsId
        if (!targetId) continue
        sessionsByWorkspaceId.get(targetId)!.push(session)
      }

      return sortedWorkspaces.map((workspace) => ({
        workspace,
        sessions: sessionsByWorkspaceId.get(workspace.id) ?? [],
      }))
    },
    [agentSessions, draftSessionIds, sortedWorkspaces],
  )

  /** Agent 归档会话按日期分组（跨项目） */
  const agentSessionGroups = React.useMemo(
    () => groupByDate(sortAgentSessionsByUpdatedAtDesc(
      agentSessions.filter((session) => session.archived && !session.draft && !draftSessionIds.has(session.id))
    )),
    [agentSessions, draftSessionIds]
  )

  /** 归档 Agent 会话渐进切片：先渲染可见数量，空闲补全 */
  const progressiveAgentSessionGroups = React.useMemo(
    () => sliceGroupsByCount(agentSessionGroups, progressiveCount),
    [agentSessionGroups, progressiveCount]
  )

  const handleRailModeSwitch = React.useCallback((targetMode: AppMode) => {
    setViewMode('active')
    if (targetMode === mode) return

    const isChatMode = targetMode === 'chat'
    const sessions = isChatMode ? conversations : agentSessions
    const lastId = isChatMode ? currentConversationId : currentAgentSessionId

    if (lastId) {
      const match = sessions.find((s) => s.id === lastId)
      if (match) {
        openSession(targetMode, match.id, match.title)
        return
      }
    }

    const tab = tabs.find((t) => t.type === targetMode)
    if (tab) {
      openSession(targetMode, tab.sessionId, tab.title)
      return
    }

    const recent = isChatMode
      ? conversations.find((conversation) => !conversation.archived && !draftSessionIds.has(conversation.id))
      : agentSessions.find((session) => !session.archived && !session.draft && !draftSessionIds.has(session.id))
    if (recent) {
      openSession(targetMode, recent.id, recent.title)
      return
    }

    setMode(targetMode)
  }, [
    mode,
    conversations,
    agentSessions,
    currentConversationId,
    currentAgentSessionId,
    tabs,
    draftSessionIds,
    openSession,
    setMode,
    setViewMode,
  ])

  const railRecentItems = React.useMemo(() => {
    if (mode === 'chat') {
      return conversations
        .filter((c) => !c.archived && !draftSessionIds.has(c.id))
        .sort((a, b) => {
          const activeDelta = Number(b.id === activeSessionId) - Number(a.id === activeSessionId)
          if (activeDelta !== 0) return activeDelta
          const streamingDelta = Number(streamingIds.has(b.id)) - Number(streamingIds.has(a.id))
          if (streamingDelta !== 0) return streamingDelta
          const pinnedDelta = Number(!!b.pinned) - Number(!!a.pinned)
          if (pinnedDelta !== 0) return pinnedDelta
          return b.updatedAt - a.updatedAt
        })
        .slice(0, 5)
        .map((conversation) => ({
          id: conversation.id,
          title: conversation.title,
          type: 'chat' as const,
          initial: getRailInitial(conversation.title),
          active: conversation.id === activeSessionId,
          status: streamingIds.has(conversation.id) ? 'running' as const : 'idle' as const,
          pinned: !!conversation.pinned,
          workspaceName: undefined,
        }))
    }

    return agentSessions
      .filter((session) =>
        !session.archived
        && !session.draft
        && !draftSessionIds.has(session.id)
        && (!currentWorkspaceId || session.workspaceId === currentWorkspaceId)
      )
      .sort((a, b) => {
        const statusA = agentIndicatorMap.get(a.id) ?? (unviewedCompletedSessionIds.has(a.id) ? 'completed' : 'idle')
        const statusB = agentIndicatorMap.get(b.id) ?? (unviewedCompletedSessionIds.has(b.id) ? 'completed' : 'idle')
        const priority = (session: AgentSessionMeta, status: SessionIndicatorStatus): number => {
          if (session.id === activeSessionId) return 0
          if (status === 'blocked') return 1
          if (status === 'running') return 2
          if (session.pinned) return 3
          if (status === 'completed') return 4
          return 5
        }
        const priorityDelta = priority(a, statusA) - priority(b, statusB)
        if (priorityDelta !== 0) return priorityDelta
        return b.updatedAt - a.updatedAt
      })
      .slice(0, 5)
      .map((session) => ({
        id: session.id,
        title: session.title,
        type: 'agent' as const,
        initial: getRailInitial(session.title),
        active: session.id === activeSessionId,
        status: agentIndicatorMap.get(session.id) ?? (unviewedCompletedSessionIds.has(session.id) ? 'completed' as const : 'idle' as const),
        pinned: !!session.pinned,
        workspaceName: session.workspaceId ? workspaceNameMap.get(session.workspaceId) : undefined,
        isAutomation: !!session.sourceAutomationId,
      }))
  }, [
    mode,
    conversations,
    agentSessions,
    draftSessionIds,
    currentWorkspaceId,
    activeSessionId,
    streamingIds,
    agentIndicatorMap,
    unviewedCompletedSessionIds,
    workspaceNameMap,
  ])


  return {
    // 视图/模式
    activeView,
    setActiveView,
    mode,
    setMode,
    tabletMode,
    isMac,
    isClassic,
    viewMode,
    setViewMode,
    sidebarCollapsed,
    setSidebarCollapsed,
    activeSessionId,

    // automations / skills
    automationCount,
    capabilities,
    handleOpenAutomations,
    handleOpenSkills,

    // conversations
    conversations,
    setConversations,
    currentConversationId,
    selectedModel,
    streamingIds,
    conversationDraftMap,
    pinnedConversations,
    conversationGroups,
    progressiveConversationGroups,
    archivedConversationCount,
    handleNewConversation,
    handleSelectConversation,
    handleRequestDelete,
    handleRename,
    handleTogglePin,
    handleToggleArchive,

    // agent sessions
    agentSessions,
    setAgentSessions,
    currentAgentSessionId,
    setCurrentAgentSessionId,
    agentIndicatorMap,
    unviewedCompletedSessionIds,
    agentDraftIds,
    pinnedAgentSessions,
    pinnedAgentSessionTrees,
    agentProjectGroups,
    agentSessionGroups,
    progressiveAgentSessionGroups,
    archivedAgentSessionCount,
    handleSelectAgentSession,
    handleAgentRename,
    handleTogglePinAgent,
    handleToggleArchiveAgent,
    handleRequestMove,
    handleToggleDelegationParent,
    expandedDelegationParentIds,

    // workspaces / projects
    workspaces,
    setWorkspaces,
    currentWorkspaceId,
    setCurrentWorkspaceId,
    sortedWorkspaces,
    workspaceSortMode,
    handleCycleWorkspaceSort,
    workspaceNameMap,
    workspaceSwitchTs,
    canDeleteWorkspace,
    createAgentSessionInWorkspace,
    handleNewAgentSession,
    handleSelectProject,
    handleToggleProjectCollapse,
    collapsedWorkspaceIds,
    expandedExtraCountMap,
    handleShowMoreSessions,
    handleCollapseExtraSessions,
    handleProjectDragStart,
    handleProjectDragOver,
    handleProjectDragLeave,
    handleProjectDrop,
    handleProjectDragEnd,
    dragProjectId,
    projectDropIndicator,
    handleStartJoinWorkspace,
    handleJoinWorkspace,
    handleStartCreateProject,
    handleCreateProject,
    handleCreateProjectKeyDown,
    handleWorkspaceRename,
    handleRequestDeleteWorkspace,

    // 账号能力（free 用户限制）
    accountCaps,

    // 新建项目输入
    creatingProject,
    setCreatingProject,
    newProjectName,
    setNewProjectName,
    newProjectInputRef,
    showJoinDialog,
    setShowJoinDialog,
    inviteCode,
    setInviteCode,

    // 删除 dialogs 状态
    pendingDeleteId,
    setPendingDeleteId,
    handleConfirmDelete,
    pendingDeleteWorkspaceId,
    setPendingDeleteWorkspaceId,
    deletingWorkspaceId,
    pendingDeleteWorkspace,
    handleConfirmDeleteWorkspace,
    moveTargetId,
    setMoveTargetId,
    handleSessionMoved,

    // 折叠 rail
    railRecentItems,
    handleRailModeSwitch,

    // 通用
    relativeTimeNow,
    progressiveCount,
    userProfile,
    hasUpdate,
    hasEnvironmentIssues,
    setSettingsOpen,
    setSearchDialogOpen,
    setSettingsTab,
    authStatus,
  }
}

export type SidebarModel = ReturnType<typeof useLeftSidebar>
