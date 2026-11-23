/**
 * 渲染进程入口
 *
 * 挂载 React 应用，初始化主题系统。
 */

// 手写笔点按侧栏/标签等 draggable 元素时，别被当成拖动
import { installPenClickAdaptation } from '@/lib/pen-click-adaptation'
installPenClickAdaptation()

// 引入 Inter Variable 自托管字体（含 400/500/600/700 等所有字重）
// index.css 声明了全部语言子集（latin/latin-ext/cyrillic/greek/vietnamese 等），
// 但每个 @font-face 都带 unicode-range，浏览器仅按需下载实际用到的子集（本应用主要是 latin）。
import '@fontsource-variable/inter/index.css'

import React, { useEffect, useMemo, useRef } from 'react'
import ReactDOM from 'react-dom/client'
import { coreTargetsAtom } from '@/atoms/core-target-atoms'
import { useSetAtom, useAtomValue, useStore } from 'jotai'
import App from './App'
import { SmoothWheelInitializer } from './hooks/useSmoothWheel'
import {
  themeModeAtom,
  themeStyleAtom,
  interfaceVariantAtom,
  systemIsDarkAtom,
  resolvedThemeAtom,
  applyThemeToDOM,
  applyInterfaceVariantToDOM,
  initializeTheme,
  handleSkinsChanged,
} from './atoms/theme'
import {
  agentWorkspacesAtom,
  currentAgentWorkspaceIdAtom,
  currentAgentSessionIdAtom,
  workspaceCapabilitiesVersionAtom,
  workspaceFilesVersionAtom,
  dockBadgeCountAtom,
  unviewedCompletedSessionIdsAtom,
  agentSessionsAtom,
  memoryUnviewedCompletedSessionIdsAtom,
  agentSessionDraftsAtom,
  agentSessionDraftHtmlAtom,
} from './atoms/agent-atoms'
import {
  manualReadConfirmEnabledAtom,
  initializeAgentUnreadSettings,
} from './atoms/agent-unread-settings'
import {
  sessionHoverPreviewEnabledAtom,
  initializeSessionHoverPreviewEnabled,
} from './atoms/session-preview-settings'
import {
  currentSessionVisibleCountAtom,
  initializeCurrentSessionVisibleCount,
} from './atoms/sidebar-atoms'
import {
  handoffSuggestTurnCountAtom,
  initializeHandoffSuggestTurnCount,
} from './atoms/session-handoff'
import { planUnreadSeedOnInit } from './lib/agent-unread-gate'
import { updateStatusAtom, initializeUpdater } from './atoms/updater'
import { automationsAtom } from './atoms/automation-atoms'
import {
  notificationsEnabledAtom,
  notificationSoundEnabledAtom,
  notificationSoundsAtom,
  customNotificationSoundsAtom,
  goalIdleCheckinMinutesAtom,
  goalIdleCheckinMaxCountAtom,
  goalProposalPolicyAtom,
  initializeNotifications,
  initDesktopNotificationListener,
} from './atoms/notifications'
import {
  stickyUserMessageEnabledAtom,
  userMessagePositionAtom,
  showCreditsInSidebarAtom,
  smoothScrollEnabledAtom,
  smoothScrollForceAtom,
  longTextPasteAsAttachmentEnabledAtom,
  richTextRenderingEnabledAtom,
  composerCompactModeAtom,
  previewOpenModeAtom,
  initializeUiPreferences,
} from './atoms/ui-preferences'
import {
  markdownFontSizeAtom,
  initializeMarkdownFontSize,
} from './atoms/markdown-font-size'
import {
  uiScaleAtom,
  initializeUiScale,
} from './atoms/ui-scale'
import { installedPluginsAtom } from './atoms/plugin-system'
import { composerToolbarPreferencesAtom, initializeComposerToolbarPreferences } from './atoms/composer-toolbar-preferences'
import { developerModeEnabledAtom } from './atoms/developer-mode'
import { useGlobalAgentListeners } from './hooks/useGlobalAgentListeners'
import { useOpenSession } from './hooks/useOpenSession'
import { useBrowserLocalFileSelectionQuote } from './hooks/useBrowserLocalFileSelectionQuote'
import { useBrowserPreviewThemeSync } from './hooks/useBrowserPreviewThemeSync'
import { useGlobalChatListeners } from './hooks/useGlobalChatListeners'
import {
  todosAtom,
  calendarEventsAtom,
  todoPlanningGroupsAtom,
  calendarPlanningGroupsAtom,
  planningTagsAtom,
} from './atoms/planning-atoms'
import { PlanningReminderRail } from './components/planning/PlanningReminderRail'
import { initShortcutRegistry, updateShortcutOverrides } from './lib/shortcut-registry'
import { tabsAtom, activeTabIdAtom, ensureScratchPadTab, scratchPadContentAtom, scratchPadLoadedAtom, SCRATCH_PAD_ID } from './atoms/tab-atoms'
import { initializeCoreSessionNavigation } from './lib/core-session-navigation'
import { chatToolsAtom } from './atoms/chat-tool-atoms'
import { feishuBotStatesAtom } from './atoms/feishu-atoms'
import { dingtalkBotStatesAtom } from './atoms/dingtalk-atoms'
import { wechatBridgeStateAtom } from './atoms/wechat-atoms'
import { conversationDraftsAtom, currentConversationIdAtom } from './atoms/chat-atoms'
import { initializeAgentSettings } from './lib/agent-settings-initialization'
import { appModeAtom } from './atoms/app-mode'
import type { FeishuBotBridgeState, FeishuBridgeState, DingTalkBotBridgeState, DingTalkBridgeState, WeChatBridgeState } from '@profer/shared'
import { Toaster } from '@profer/ui'

/** 桌面壳 Toaster：把皮肤系统解析出的主题注入通用基元（基元本身已不含 jotai 依赖） */
function ProferToaster(props: Omit<React.ComponentProps<typeof Toaster>, 'theme'>) {
  const theme = useAtomValue(resolvedThemeAtom)
  return <Toaster theme={theme} {...props} />
}
import { toast } from 'sonner'
import { diffCapabilities } from '@profer/shared'
import type { WorkspaceCapabilities } from '@profer/shared'
import { showCapabilityChangeToasts } from './lib/capabilities-toast'
import { invalidateFileSnapshotCache, invalidateWorkspaceCapabilitiesCache } from './components/agent/mention-query-utils'
import { UpdateDialog } from './components/settings/UpdateDialog'
import { GlobalShortcuts } from './components/shortcuts/GlobalShortcuts'
import { TabSwitcher } from './components/tabs/TabSwitcher'
import { NavigationInputProvider } from './components/navigation/NavigationInputProvider'
import { SessionWindowApp } from './components/session-window/SessionWindowApp'
import { TooltipProvider } from '@profer/ui/primitives/tooltip'
import { settingsOpenAtom } from './atoms/settings-tab'
import { sendWithCmdEnterAtom, shortcutOverridesAtom } from './atoms/shortcut-atoms'
import { htmlToMarkdown, markdownToHtml } from './lib/markdown-rich-text'
import './styles/globals.css'
import './styles/skin-base.css'
import 'katex/dist/katex.min.css'

// ===== 窗口类型检测 =====
const isQuickTaskWindow = new URLSearchParams(window.location.search).get('window') === 'quick-task'
const isVoiceDictationWindow = new URLSearchParams(window.location.search).get('window') === 'voice-dictation'
const isDetachedPreviewWindow = new URLSearchParams(window.location.search).get('window') === 'detached-preview'
const isAgentPreviewWindow = new URLSearchParams(window.location.search).get('window') === 'agent-preview'
const isPlanningWindow = new URLSearchParams(window.location.search).get('window') === 'planning'
const isSessionWindow = new URLSearchParams(window.location.search).get('window') === 'session'
const sessionWindowId = new URLSearchParams(window.location.search).get('sessionId')
const sessionWindowType = new URLSearchParams(window.location.search).get('sessionType')

/**
 * 主题初始化组件
 *
 * 负责从主进程加载主题设置、监听系统主题变化、
 * 并将最终主题同步到 DOM。
 */
function ThemeInitializer(): null {
  const setThemeMode = useSetAtom(themeModeAtom)
  const setThemeStyle = useSetAtom(themeStyleAtom)
  const setInterfaceVariant = useSetAtom(interfaceVariantAtom)
  const setSystemIsDark = useSetAtom(systemIsDarkAtom)
  const themeMode = useAtomValue(themeModeAtom)
  const themeStyle = useAtomValue(themeStyleAtom)
  const interfaceVariant = useAtomValue(interfaceVariantAtom)
  const systemIsDark = useAtomValue(systemIsDarkAtom)

  // 初始化：从主进程加载设置 + 订阅系统主题变化
  useEffect(() => {
    let isMounted = true
    let cleanup: (() => void) | undefined

    initializeTheme(setThemeMode, setSystemIsDark, setThemeStyle, setInterfaceVariant).then((fn) => {
      if (isMounted) {
        cleanup = fn
      } else {
        // 组件已卸载（StrictMode 场景），立即清理监听器
        fn()
      }
    })

    return () => {
      isMounted = false
      cleanup?.()
    }
  }, [setThemeMode, setSystemIsDark, setThemeStyle, setInterfaceVariant])

  // 皮肤安装/删除/刷新广播：多窗口同步刷新（其他窗口导入/删除皮肤时本窗口立即生效）
  useEffect(() => {
    return window.electronAPI.onSkinsChanged((payload) => { void handleSkinsChanged(payload) })
  }, [])

  // 响应式应用主题到 DOM
  // 用 useMemo 计算"实际会影响 DOM 的状态签名"作为唯一依赖：
  // special 模式下 systemIsDark 不影响最终 class，避免系统主题变化时触发无意义的
  // applyThemeToDOM 调用（配合 applyThemeToDOM 内部的幂等检查双重兜底）。
  const themeSignature = useMemo(() => {
    if (themeMode === 'special') {
      return `special:${themeStyle}`
    }
    if (themeMode === 'system') {
      return `system:${systemIsDark ? 'dark' : 'light'}`
    }
    return themeMode
  }, [themeMode, themeStyle, systemIsDark])

  useEffect(() => {
    applyThemeToDOM(themeMode, themeStyle, systemIsDark)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [themeSignature])

  useEffect(() => {
    applyInterfaceVariantToDOM(interfaceVariant)
  }, [interfaceVariant])

  return null
}

/**
 * Agent 设置初始化组件
 *
 * 从主进程加载 Agent 渠道/模型设置并写入 atoms。
 */
function AgentSettingsInitializer(): null {
  const bumpCapabilities = useSetAtom(workspaceCapabilitiesVersionAtom)
  const bumpFiles = useSetAtom(workspaceFilesVersionAtom)
  const store = useStore()

  // 读取当前工作区信息（用于能力变化 diff）
  const currentWorkspaceId = useAtomValue(currentAgentWorkspaceIdAtom)
  const workspaces = useAtomValue(agentWorkspacesAtom)

  // 缓存上一次工作区能力（用于 diff 检测变化）
  const prevCapabilitiesRef = useRef<WorkspaceCapabilities | null>(null)
  // 初次加载标记 — 应用启动或切换工作区时不显示 toast
  const suppressToastRef = useRef(true)

  useEffect(() => initializeAgentSettings(store, {
    getSettings: window.electronAPI.getSettings,
    listWorkspaces: window.electronAPI.listAgentWorkspaces,
    updateSettings: window.electronAPI.updateSettings,
    onFailure: (error) => console.error('[AgentSettings] 启动设置加载失败:', error),
  }), [store])

  // 工作区切换时重置能力缓存，预加载基线
  useEffect(() => {
    suppressToastRef.current = true
    prevCapabilitiesRef.current = null
    const ws = currentWorkspaceId ? workspaces.find((w) => w.id === currentWorkspaceId) : undefined
    invalidateWorkspaceCapabilitiesCache()
    invalidateFileSnapshotCache()

    if (!currentWorkspaceId) return
    if (!ws) return

    window.electronAPI
      .getWorkspaceCapabilities(ws.slug)
      .then((caps) => {
        prevCapabilitiesRef.current = caps
        suppressToastRef.current = false
      })
      .catch(console.error)
  }, [currentWorkspaceId, workspaces])

  // 订阅主进程文件监听推送
  useEffect(() => {
    const unsubCapabilities = window.electronAPI.onCapabilitiesChanged(() => {
      invalidateWorkspaceCapabilitiesCache()
      // 查找当前工作区 slug
      const ws = workspaces.find((w) => w.id === currentWorkspaceId)
      if (ws) {
        window.electronAPI
          .getWorkspaceCapabilities(ws.slug)
          .then((newCaps) => {
            const prevCaps = prevCapabilitiesRef.current
            if (prevCaps && !suppressToastRef.current) {
              const changes = diffCapabilities(prevCaps, newCaps)
              showCapabilityChangeToasts(changes)
            }
            prevCapabilitiesRef.current = newCaps
            suppressToastRef.current = false
          })
          .catch(console.error)
      }

      bumpCapabilities((v) => v + 1)
    })
    // 用 throttle（节流）代替直接 bump：文件变更事件以 1 秒为最小间隔
    // 避免同步引擎轮询 + 文件监听器同时触发导致文件浏览器频繁重载
    let fileBumpThrottle: ReturnType<typeof setTimeout> | null = null
    const unsubFiles = window.electronAPI.onWorkspaceFilesChanged(() => {
      invalidateFileSnapshotCache()
      if (fileBumpThrottle) return
      bumpFiles((v) => v + 1)
      fileBumpThrottle = setTimeout(() => { fileBumpThrottle = null }, 1000)
    })

    return () => {
      unsubCapabilities()
      unsubFiles()
      if (fileBumpThrottle) clearTimeout(fileBumpThrottle)
    }
  }, [bumpCapabilities, bumpFiles, currentWorkspaceId, workspaces])

  return null
}

/**
 * 自动更新初始化组件
 *
 * 订阅主进程推送的更新状态变化事件。
 */
function UpdaterInitializer(): null {
  const setUpdateStatus = useSetAtom(updateStatusAtom)

  useEffect(() => {
    const cleanup = initializeUpdater(setUpdateStatus)
    return cleanup
  }, [setUpdateStatus])

  return null
}

/**
 * 定时任务初始化组件
 *
 * 加载全部定时任务，并订阅主进程的变更事件（运行完成/状态变化）刷新列表。
 */
function PlanningShortcutInitializer(): null {
  useEffect(() => {
    initShortcutRegistry()
    void window.electronAPI.getSettings().then((settings) => {
      updateShortcutOverrides(settings.shortcutOverrides ?? {})
    }).catch((error) => {
      console.error('[任务/日程] 加载快捷键设置失败:', error)
    })
  }, [])
  return null
}

function PlanningInitializer(): null {
  const setCore = useSetAtom(coreTargetsAtom)
  const core = useAtomValue(coreTargetsAtom)
  const planningAvailable = core.currentId === 'local' || core.targets.some(target => target.id === core.currentId && target.capabilities?.includes('planning'))
  const setTodos = useSetAtom(todosAtom)
  const setCalendarEvents = useSetAtom(calendarEventsAtom)
  const setTodoGroups = useSetAtom(todoPlanningGroupsAtom)
  const setCalendarGroups = useSetAtom(calendarPlanningGroupsAtom)
  const setTags = useSetAtom(planningTagsAtom)

  useEffect(() => {
    let disposed = false
    let fallbackShown = false
    const update = (snapshot: import('@/types/settings').CoreTargetsSnapshot): void => {
      if (disposed) return
      setCore(current => (snapshot.revision ?? snapshot.generation) < (current.revision ?? current.generation) ? current : snapshot)
      if (snapshot.startup === 'offline' && !fallbackShown) {
        fallbackShown = true
        toast.info('所选 Core 暂时离线，已保留原目标；可重试连接或主动切回本机', { id: 'core-startup-offline' })
      }
    }
    void window.electronAPI.listCoreTargets().then(update).catch(console.error)
    const unsubscribe = window.electronAPI.onCoreTargetChanged(update)
    return () => { disposed = true; unsubscribe() }
  }, [setCore])

  useEffect(() => {
    let disposed = false
    const latestRequest = { todos: 0, calendarEvents: 0, todoGroups: 0, calendarGroups: 0, tags: 0 }
    const loadTodos = (): void => {
      const requestId = ++latestRequest.todos
      void window.electronAPI.listTodos().then((todos) => {
        if (!disposed && requestId === latestRequest.todos) setTodos(todos)
      }).catch((error: unknown) => console.error('[任务/日程] 加载 Todo 失败:', error))
    }
    const loadCalendarEvents = (): void => {
      const requestId = ++latestRequest.calendarEvents
      void window.electronAPI.listCalendarEvents().then((events) => {
        if (!disposed && requestId === latestRequest.calendarEvents) setCalendarEvents(events)
      }).catch((error: unknown) => console.error('[任务/日程] 加载日程失败:', error))
    }
    const loadTodoGroups = (): void => {
      const requestId = ++latestRequest.todoGroups
      void window.electronAPI.listPlanningGroups('todo').then((groups) => {
        if (!disposed && requestId === latestRequest.todoGroups) setTodoGroups(groups)
      }).catch((error: unknown) => console.error('[任务/日程] 加载 Todo 分组失败:', error))
    }
    const loadCalendarGroups = (): void => {
      const requestId = ++latestRequest.calendarGroups
      void window.electronAPI.listPlanningGroups('calendar').then((groups) => {
        if (!disposed && requestId === latestRequest.calendarGroups) setCalendarGroups(groups)
      }).catch((error: unknown) => console.error('[任务/日程] 加载日程分组失败:', error))
    }
    const loadTags = (): void => {
      const requestId = ++latestRequest.tags
      void window.electronAPI.listPlanningTags().then((tags) => {
        if (!disposed && requestId === latestRequest.tags) setTags(tags)
      }).catch((error: unknown) => console.error('[任务/日程] 加载标签失败:', error))
    }
    const load = (resources?: string[]): void => {
      const includes = (resource: string): boolean => resources === undefined || resources.includes(resource)
      if (includes('todos')) loadTodos()
      if (includes('calendar_events')) loadCalendarEvents()
      if (includes('todo_groups')) loadTodoGroups()
      if (includes('calendar_groups')) loadCalendarGroups()
      if (includes('tags')) loadTags()
    }
    setTodos([])
    setCalendarEvents([])
    setTodoGroups([])
    setCalendarGroups([])
    setTags([])
    if (!planningAvailable && core.startup !== 'restoring' && core.currentId !== 'local') toast.error('当前 Core 尚不支持任务/日程，请更新 Core；未读取本机数据', { id: 'core-planning-unavailable' })
    if (!planningAvailable || core.startup === 'restoring') return
    load()
    const unsubscribe = window.electronAPI.onPlanningChanged((change) => load(change.resources))
    return () => { disposed = true; unsubscribe() }
  }, [core.currentId, core.generation, core.startup, planningAvailable, setCalendarEvents, setCalendarGroups, setTags, setTodoGroups, setTodos])

  return null
}

function AutomationInitializer(): null {
  const setAutomations = useSetAtom(automationsAtom)

  useEffect(() => {
    const load = (): void => {
      window.electronAPI.listAutomations().then(setAutomations).catch(console.error)
    }
    load()
    const unsub = window.electronAPI.onAutomationChanged(load)
    return unsub
  }, [setAutomations])

  return null
}

/**
 * 通知初始化组件
 *
 * 从主进程加载通知开关设置。
 */
function NotificationsInitializer(): null {
  const setEnabled = useSetAtom(notificationsEnabledAtom)
  const setSoundEnabled = useSetAtom(notificationSoundEnabledAtom)
  const setSounds = useSetAtom(notificationSoundsAtom)
  const setCustomSounds = useSetAtom(customNotificationSoundsAtom)
  const setGoalIdleMinutes = useSetAtom(goalIdleCheckinMinutesAtom)
  const setGoalIdleMax = useSetAtom(goalIdleCheckinMaxCountAtom)
  const setGoalProposalPolicy = useSetAtom(goalProposalPolicyAtom)

  useEffect(() => {
    // Goal 空闲自检与通知同批读取，避免设置页首次打开显示默认值再跳变。
    void window.electronAPI.getSettings().then((settings) => {
      setGoalIdleMinutes(settings.goalIdleCheckinMinutes ?? 0)
      setGoalIdleMax(settings.goalIdleCheckinMaxCount ?? 3)
      setGoalProposalPolicy(settings.goalProposalPolicy ?? 'alwaysAsk')
    }).catch(() => {})
    initializeNotifications(setEnabled, setSoundEnabled, setSounds, setCustomSounds)
    initDesktopNotificationListener()
  }, [setEnabled, setSoundEnabled, setSounds, setCustomSounds, setGoalIdleMinutes, setGoalIdleMax, setGoalProposalPolicy])

  return null
}

/**
 * 「手动确认已读」开关初始化组件（设置 → 使用偏好）
 *
 * 两件事：
 * 1. 从主进程加载开关（默认 false），写入 `manualReadConfirmEnabledAtom`，渲染层判据随之就位；
 * 2. 关闭态下补一次**安全回填**：把持久化未读（`completedButUnconfirmed`）补进内存集合。
 *    与 `use-left-sidebar` 拉列表后的启动恢复同源且幂等，保证设置尚未加载完的窗口内也不丢未读。
 *    开启态不需要（读就是持久化字段的派生）。
 */
function AgentUnreadSettingsInitializer(): null {
  const store = useStore()
  const setEnabled = useSetAtom(manualReadConfirmEnabledAtom)

  useEffect(() => {
    let cancelled = false
    void initializeAgentUnreadSettings(setEnabled).then((enabled) => {
      if (cancelled || enabled) return
      const persistedUnreadIds = store.get(agentSessionsAtom)
        .filter((session) => session.completedButUnconfirmed)
        .map((session) => session.id)
      if (persistedUnreadIds.length === 0) return
      const seedIds = planUnreadSeedOnInit({
        memoryUnreadIds: [...store.get(memoryUnviewedCompletedSessionIdsAtom)],
        persistedUnreadIds,
      })
      if (seedIds.length === 0) return
      // 直写内存集合：开启态不复存在，这里就是关闭态的事实源。
      store.set(memoryUnviewedCompletedSessionIdsAtom, (prev) => {
        const next = new Set(prev)
        for (const id of seedIds) next.add(id)
        return next
      })
    })
    return () => { cancelled = true }
  }, [store, setEnabled])

  return null
}

/**
 * 「会话悬浮预览」开关初始化组件（设置 → 通用）
 *
 * 只做一件事：把持久化开关（默认开启）写进 `sessionHoverPreviewEnabledAtom`，
 * 侧栏会话列表与全局搜索结果里的 `useSessionMiniMapHover` 随之生效。
 */
function SessionPreviewSettingsInitializer(): null {
  const setEnabled = useSetAtom(sessionHoverPreviewEnabledAtom)

  useEffect(() => {
    void initializeSessionHoverPreviewEnabled(setEnabled)
  }, [setEnabled])

  return null
}

/**
 * 「当前会话」容量初始化组件（设置 → 使用偏好）
 *
 * 把 settings.json 里的档位写进 atom；侧栏直接读 atom，切换后立即生效、无需重启。
 */
function CurrentSessionCapacityInitializer(): null {
  const setCount = useSetAtom(currentSessionVisibleCountAtom)

  useEffect(() => {
    void initializeCurrentSessionVisibleCount(setCount)
  }, [setCount])

  return null
}

/**
 * 会话交接（建议新开会话）阈值初始化组件
 *
 * 只把「超过多少轮建议新开会话」读进 atom；建议条本身按会话独立判定，
 * 未开启（默认 0）时整条不渲染，不影响任何既有行为。
 */
function SessionHandoffInitializer(): null {
  const setCount = useSetAtom(handoffSuggestTurnCountAtom)

  useEffect(() => {
    void initializeHandoffSuggestTurnCount(setCount)
  }, [setCount])

  return null
}

/**
 * Dock/Launcher 角标同步组件
 *
 * 将需要用户处理或查看的事项数量同步到系统应用图标。
 */
function DockBadgeInitializer(): null {
  const count = useAtomValue(dockBadgeCountAtom)
  const notificationsEnabled = useAtomValue(notificationsEnabledAtom)
  const currentSessionId = useAtomValue(currentAgentSessionIdAtom)
  const setUnviewedCompleted = useSetAtom(unviewedCompletedSessionIdsAtom)
  const badgeCount = notificationsEnabled ? count : 0

  useEffect(() => {
    window.electronAPI.setDockBadgeCount(badgeCount).catch((error) => {
      console.error('[Dock 角标] 同步失败:', error)
    })
  }, [badgeCount])

  useEffect(() => {
    const clearCurrentSessionBadge = (): void => {
      if (!document.hasFocus() || !currentSessionId) return
      setUnviewedCompleted((prev) => {
        if (!prev.has(currentSessionId)) return prev
        const next = new Set(prev)
        next.delete(currentSessionId)
        return next
      })
    }

    clearCurrentSessionBadge()
    window.addEventListener('focus', clearCurrentSessionBadge)
    document.addEventListener('visibilitychange', clearCurrentSessionBadge)
    return () => {
      window.removeEventListener('focus', clearCurrentSessionBadge)
      document.removeEventListener('visibilitychange', clearCurrentSessionBadge)
    }
  }, [currentSessionId, setUnviewedCompleted])

  return null
}

/**
 * UI 偏好初始化组件
 *
 * 从主进程加载 UI 偏好设置（悬浮置顶条等）。
 */
function UiPreferencesInitializer(): null {
  const setShowCreditsInSidebar = useSetAtom(showCreditsInSidebarAtom)
  const setStickyUserMessageEnabled = useSetAtom(stickyUserMessageEnabledAtom)
  const setUserMessagePosition = useSetAtom(userMessagePositionAtom)
  const setLongTextPasteAsAttachmentEnabled = useSetAtom(longTextPasteAsAttachmentEnabledAtom)
  const setRichTextRenderingEnabled = useSetAtom(richTextRenderingEnabledAtom)
  const setComposerCompactMode = useSetAtom(composerCompactModeAtom)
  const setPreviewOpenMode = useSetAtom(previewOpenModeAtom)
  const setSmoothScrollEnabled = useSetAtom(smoothScrollEnabledAtom)
  const setSmoothScrollForce = useSetAtom(smoothScrollForceAtom)

  useEffect(() => {
    initializeUiPreferences(
      setShowCreditsInSidebar,
      setStickyUserMessageEnabled,
      setUserMessagePosition,
      setLongTextPasteAsAttachmentEnabled,
      setRichTextRenderingEnabled,
      setComposerCompactMode,
      setPreviewOpenMode,
      setSmoothScrollEnabled,
      setSmoothScrollForce
    )
  }, [setShowCreditsInSidebar, setStickyUserMessageEnabled, setUserMessagePosition, setLongTextPasteAsAttachmentEnabled, setRichTextRenderingEnabled, setComposerCompactMode, setPreviewOpenMode, setSmoothScrollEnabled, setSmoothScrollForce])

  return null
}

/**
 * Markdown 字号初始化组件
 *
 * 从主进程加载字号档位，写入 :root CSS 变量驱动 Markdown 预览。
 */
function MarkdownFontSizeInitializer(): null {
  const setMarkdownFontSize = useSetAtom(markdownFontSizeAtom)

  useEffect(() => {
    initializeMarkdownFontSize(setMarkdownFontSize)
  }, [setMarkdownFontSize])

  return null
}

/**
 * 界面缩放初始化组件
 *
 * 从主进程加载持久化的 UI 缩放档位，同步到 atom + localStorage + DOM
 * （localStorage 已有缓存时模块加载即已应用，此处仅校正 settings.json 权威值）。
 */
function UiScaleInitializer(): null {
  const setUiScale = useSetAtom(uiScaleAtom)

  useEffect(() => {
    initializeUiScale(setUiScale)
  }, [setUiScale])

  return null
}

function ComposerToolbarPreferencesInitializer(): null {
  const setPreferences = useSetAtom(composerToolbarPreferencesAtom)

  useEffect(() => {
    void initializeComposerToolbarPreferences(setPreferences)
  }, [setPreferences])

  return null
}

/** 恢复插件列表与开发者模式设置。 */
function PluginSystemInitializer(): null {
  const store = useStore()
  useEffect(() => {
    let revision = 0
    const refresh = (): void => {
      const request = ++revision
      void window.electronAPI.listPlugins().then((plugins) => {
        if (request !== revision) return
        store.set(installedPluginsAtom, plugins)
        const pages = new Set(plugins.filter((plugin) => plugin.enabled).flatMap((plugin) =>
          (plugin.manifest.contributes.pages ?? []).map((page) => `${plugin.manifest.id}:${page.id}`)))
        const tabs = store.get(tabsAtom)
        const next = tabs.filter((tab) => tab.type !== 'plugin' || pages.has(`${tab.pluginId}:${tab.pluginPageId}`))
        if (next.length === tabs.length) return
        store.set(tabsAtom, ensureScratchPadTab(next))
        if (!next.some((tab) => tab.id === store.get(activeTabIdAtom))) {
          store.set(activeTabIdAtom, SCRATCH_PAD_ID); store.set(appModeAtom, 'scratch')
          store.set(currentConversationIdAtom, null); store.set(currentAgentSessionIdAtom, null); store.set(currentAgentWorkspaceIdAtom, null)
        }
      }).catch(() => undefined)
    }
    refresh()
    const unsubscribe = window.electronAPI.onPluginsChanged(refresh)
    return () => { revision += 1; unsubscribe() }
  }, [store])
  const setDeveloperModeEnabled = useSetAtom(developerModeEnabledAtom)

  useEffect(() => {
    const apply = (settings: { developerModeEnabled?: boolean }): void => {
      setDeveloperModeEnabled(settings.developerModeEnabled === true)
    }
    void window.electronAPI.getSettings()
      .then(apply)
      .catch((error: unknown) => console.error('[开发者模式] 初始化状态失败:', error))
    return window.electronAPI.onDeveloperSettingsChanged(apply)
  }, [setDeveloperModeEnabled])

  return null
}

/**
 * Chat IPC 监听器初始化组件
 *
 * 全局挂载，永不销毁。确保 Chat 流式事件
 * 在页面切换时不丢失。
 */
function ChatListenersInitializer(): null {
  useGlobalChatListeners()
  return null
}

/**
 * Agent IPC 监听器初始化组件
 *
 * 全局挂载，永不销毁。确保 Agent 流式事件、权限请求
 * 在页面切换时不丢失。
 */
function AgentListenersInitializer(): null {
  useGlobalAgentListeners()
  // 浏览器列里文件预览的划词由主进程转投过来，落进与预览面板同一个引用 atom
  useBrowserLocalFileSelectionQuote()
  // 换皮肤时让已打开的文件预览跟上（受管浏览器里的普通网页不跟）
  useBrowserPreviewThemeSync()
  return null
}

/** 主窗口接收「移回主窗口」的会话：先恢复草稿，再打开/聚焦 Tab。 */
function ReattachTabListener(): null {
  const store = useStore()
  const openSession = useOpenSession()
  useEffect(() => {
    return window.electronAPI.onReattachTab((tab) => {
      if (tab.type === 'agent') {
        if (tab.draft) {
          store.set(agentSessionDraftsAtom, (previous) => new Map(previous).set(tab.sessionId, tab.draft!))
        }
        if (tab.draftHtml) {
          store.set(agentSessionDraftHtmlAtom, (previous) => new Map(previous).set(tab.sessionId, tab.draftHtml!))
        }
      } else if (tab.draft) {
        store.set(conversationDraftsAtom, (previous) => new Map(previous).set(tab.sessionId, tab.draft!))
      }
      openSession(tab.type, tab.sessionId, tab.title, tab.parentSessionId)
      // 会话窗口关闭后，活跃流要重新绑回主窗口，否则重新打开 Tab 只会停在旧快照。
      if (tab.type === 'agent') {
        void window.electronAPI.restoreActiveAgentStreams([tab.sessionId]).catch(console.error)
      }
    })
  }, [openSession, store])
  return null
}

/** 独立会话窗口：只接管该会话，不挂载浏览器/插件相关的全局桥接。 */
function SessionAgentListenersInitializer({ sessionId }: { sessionId: string }): null {
  useGlobalAgentListeners({ standaloneSessionId: sessionId })
  return null
}

/** 独立会话窗口的键盘快捷键：只保留关闭窗口，Tab 相关快捷键由主窗口负责。 */
function SessionWindowShortcuts(): null {
  const setSendWithCmdEnter = useSetAtom(sendWithCmdEnterAtom)
  const setShortcutOverrides = useSetAtom(shortcutOverridesAtom)
  useEffect(() => {
    // Agent/Chat 视图内部通过 registerShortcut 注册的快捷键需要 dispatcher。
    initShortcutRegistry()
    // 会话窗口不挂 GlobalShortcuts，但发送键与自定义快捷键仍需与主窗口一致。
    void window.electronAPI.getSettings().then((settings) => {
      if (settings.shortcutOverrides) {
        setShortcutOverrides(settings.shortcutOverrides)
        updateShortcutOverrides(settings.shortcutOverrides)
      }
      setSendWithCmdEnter(settings.sendWithCmdEnter ?? false)
    }).catch(console.error)
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return
      if (event.key.toLowerCase() !== 'w') return
      event.preventDefault()
      void window.electronAPI.windowClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    // 应用菜单的 CmdOrCtrl+W 加速器会先于 DOM keydown 触发；主窗口由 GlobalShortcuts
    // 处理 close-tab，轻量窗口没有挂它，这里直接把“关闭标签页”解释为关闭当前窗口。
    const unsubMenuCloseTab = window.electronAPI.onMenuCloseTab(() => {
      void window.electronAPI.windowClose()
    })
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      unsubMenuCloseTab()
    }
  }, [setSendWithCmdEnter, setShortcutOverrides])
  return null
}

/** 独立会话窗口没有设置页：把“前往设置”的意图明确引导回主窗口。 */
function SessionWindowSettingsGuard(): null {
  const settingsOpen = useAtomValue(settingsOpenAtom)
  const setSettingsOpen = useSetAtom(settingsOpenAtom)
  useEffect(() => {
    if (!settingsOpen) return
    setSettingsOpen(false)
    toast.info('请在主窗口修改设置')
  }, [settingsOpen, setSettingsOpen])
  return null
}

/**
 * Chat 工具初始化组件
 *
 * 启动时从主进程加载所有工具信息到 atom。
 * 订阅 chat-tools.json 文件变更通知，自动刷新工具列表。
 */
function ChatToolInitializer(): null {
  const setChatTools = useSetAtom(chatToolsAtom)

  useEffect(() => {
    window.electronAPI.getChatTools()
      .then(setChatTools)
      .catch((err: unknown) => console.error('[ChatToolInitializer] 加载工具列表失败:', err))
  }, [setChatTools])

  // 订阅自定义工具配置变更并静默刷新工具列表。
  // 用户主动操作的反馈由各设置入口提供，避免文件监听产生重复 Toast。
  useEffect(() => {
    const cleanup = window.electronAPI.onCustomToolChanged(() => {
      window.electronAPI.getChatTools()
        .then(setChatTools)
        .catch((err: unknown) => console.error('[ChatToolInitializer] 刷新工具列表失败:', err))
    })
    return cleanup
  }, [setChatTools])

  return null
}

/**
 * 飞书集成初始化组件
 *
 * - 订阅飞书 Bridge 状态变化
 * - 定期上报用户在场状态（用于智能通知路由）
 * - 监听通知已发送事件（显示 Sonner + 桌面通知）
 */
function FeishuInitializer(): null {
  const store = useStore()

  useEffect(() => {
    // 加载初始多 Bot 状态
    const loadFeishuMultiStatus = window.electronAPI.getFeishuMultiStatus
    if (!loadFeishuMultiStatus) {
      window.electronAPI.getFeishuStatus()
        .then((state: FeishuBridgeState) => {
          const s = state as FeishuBotBridgeState
          const botId = s.botId ?? 'default'
          store.set(feishuBotStatesAtom, { [botId]: { ...s, botId, botName: s.botName ?? '飞书助手' } })
        })
        .catch((err: unknown) => console.error('[FeishuInitializer] 加载状态失败:', err))
    } else loadFeishuMultiStatus()
      .then((multiState: { bots: Record<string, FeishuBotBridgeState> }) => {
        store.set(feishuBotStatesAtom, multiState.bots)
      })
      .catch(() => {
        // 回退：使用旧 API 获取单 Bot 状态
        window.electronAPI.getFeishuStatus()
          .then((state: FeishuBridgeState) => {
            const s = state as FeishuBotBridgeState
            const botId = s.botId ?? 'default'
            store.set(feishuBotStatesAtom, { [botId]: { ...s, botId, botName: s.botName ?? '飞书助手' } })
          })
          .catch((err: unknown) => console.error('[FeishuInitializer] 加载状态失败:', err))
      })

    // 订阅状态变化（现在每次推送包含 botId）
    const cleanupStatus = window.electronAPI.onFeishuStatusChanged((raw: FeishuBridgeState) => {
      const state = raw as FeishuBotBridgeState
      const botId = state.botId ?? 'default'
      store.set(feishuBotStatesAtom, (prev) => ({
        ...prev,
        [botId]: { ...state, botId, botName: state.botName ?? '飞书助手' },
      }))
    })

    // 定期上报在场状态（5 秒间隔 + 焦点变化时即时上报）
    const reportPresence = (): void => {
      const activeSessionId = store.get(currentAgentSessionIdAtom) ?? store.get(currentConversationIdAtom)
      window.electronAPI.reportFeishuPresence({
        activeSessionId,
        lastInteractionAt: Date.now(),
      }).catch(() => { /* 忽略 */ })
    }
    const interval = setInterval(reportPresence, 5000)
    window.addEventListener('focus', reportPresence)
    window.addEventListener('blur', reportPresence)

    return () => {
      cleanupStatus()
      clearInterval(interval)
      window.removeEventListener('focus', reportPresence)
      window.removeEventListener('blur', reportPresence)
    }
  }, [store])

  return null
}

/**
 * DingTalkInitializer
 *
 * - 加载多 Bot 初始状态
 * - 订阅钉钉 Bridge 状态变化
 */
function DingTalkInitializer(): null {
  const store = useStore()

  useEffect(() => {
    // 加载初始多 Bot 状态
    const loadDingTalkMultiStatus = window.electronAPI.getDingTalkMultiStatus
    if (!loadDingTalkMultiStatus) {
      window.electronAPI.getDingTalkStatus()
        .then((state: DingTalkBridgeState) => {
          const s = state as DingTalkBotBridgeState
          const botId = s.botId ?? 'default'
          store.set(dingtalkBotStatesAtom, { [botId]: { ...s, botId, botName: s.botName ?? '钉钉助手' } })
        })
        .catch((err: unknown) => console.error('[DingTalkInitializer] 加载状态失败:', err))
    } else loadDingTalkMultiStatus()
      .then((multiState: { bots: Record<string, DingTalkBotBridgeState> }) => {
        store.set(dingtalkBotStatesAtom, multiState.bots)
      })
      .catch(() => {
        // 回退：使用旧 API 获取单 Bot 状态
        window.electronAPI.getDingTalkStatus()
          .then((state: DingTalkBridgeState) => {
            const s = state as DingTalkBotBridgeState
            const botId = s.botId ?? 'default'
            store.set(dingtalkBotStatesAtom, { [botId]: { ...s, botId, botName: s.botName ?? '钉钉助手' } })
          })
          .catch((err: unknown) => console.error('[DingTalkInitializer] 加载状态失败:', err))
      })

    // 订阅状态变化（现在每次推送包含 botId）
    const cleanupStatus = window.electronAPI.onDingTalkStatusChanged((raw: DingTalkBridgeState) => {
      const state = raw as DingTalkBotBridgeState
      const botId = state.botId ?? 'default'
      store.set(dingtalkBotStatesAtom, (prev) => ({
        ...prev,
        [botId]: { ...state, botId, botName: state.botName ?? '钉钉助手' },
      }))
    })

    return () => {
      cleanupStatus()
    }
  }, [store])

  return null
}

/**
 * WeChatInitializer
 *
 * - 加载微信 Bridge 初始状态
 * - 订阅微信 Bridge 状态变化
 *
 * 微信状态此前只在 WeChatSettings 挂载时加载并订阅，导致未进入「微信」页时
 * 侧栏状态点恒为未连接、离开页面后也不再更新。这里与飞书/钉钉对齐到根组件。
 */
function WeChatInitializer(): null {
  const store = useStore()

  useEffect(() => {
    window.electronAPI.getWeChatStatus()
      .then((state: WeChatBridgeState) => {
        store.set(wechatBridgeStateAtom, state)
      })
      .catch((err: unknown) => console.error('[WeChatInitializer] 加载状态失败:', err))

    const cleanupStatus = window.electronAPI.onWeChatStatusChanged((state: WeChatBridgeState) => {
      store.set(wechatBridgeStateAtom, state)
    })

    return () => {
      cleanupStatus()
    }
  }, [store])

  return null
}

/**
 * 标签页持久化组件
 *
 * 启动时从 settings.tabState 恢复上次打开的标签页；
 * 运行时监听标签页变化，自动保存到 settings.json。
 */

/**
 * 旧版（分屏时代）持久化结构——仅用于向后兼容读取迁移。
 * 新版已扁平化为 { tabs, activeTabId }；旧版是 { tabs, splitLayout }。
 */
function TabStatePersistenceInitializer(): null {
  const store = useStore()
  useEffect(() => {
    // 启动连接未决时只等连接结果；原会话导航和持久化规则不变。
    let disposed = false
    let stopWaiting: (() => void) | undefined
    let releaseWait: (() => void) | undefined
    const listReadyCoreTargets = async () => {
      const initial = await window.electronAPI.listCoreTargets()
      if (disposed || initial.startup !== 'restoring') return initial
      return new Promise<typeof initial>(resolve => {
        releaseWait = () => resolve(initial)
        const readSettled = () => {
          const current = store.get(coreTargetsAtom)
          if (current.startup === 'restoring' || (current.revision ?? 0) <= (initial.revision ?? 0)) return
          stopWaiting?.()
          releaseWait = undefined
          resolve(current)
        }
        stopWaiting = store.sub(coreTargetsAtom, readSettled)
        readSettled()
      })
    }
    const navigation = initializeCoreSessionNavigation(store, {
      getSettings: () => window.electronAPI.getSettings(),
      listCoreTargets: listReadyCoreTargets,
      listConversations: () => window.electronAPI.listConversations(true),
      listAgentSessions: () => window.electronAPI.listAgentSessions(true),
      listWorkspaces: () => window.electronAPI.listAgentWorkspaces(),
      updateSettings: (patch) => window.electronAPI.updateSettings(patch),
      onFailure: (error) => { console.error('[Core 会话恢复] 失败:', error); toast.error('恢复当前内核会话失败，请重新连接或选择会话') },
    })
    const beforeUnload = (): void => {
      const patch = navigation.beforeUnload()
      if (patch && !window.electronAPI.updateSettingsSync(patch)) {
        console.error('[Core 会话恢复] 关闭前保存失败')
      }
    }
    window.addEventListener('beforeunload', beforeUnload)
    return () => {
      disposed = true
      window.removeEventListener('beforeunload', beforeUnload)
      navigation.dispose()
      stopWaiting?.()
      releaseWait?.()
    }
  }, [store])
  return null
}

/**
 * Scratch Pad 初始化和持久化组件
 *
 * 启动时注入 scratch tab 到 tabsAtom 首位，
 * 从磁盘加载 scratch-pad.md 内容，自动保存到磁盘。
 */
function ScratchPadPersistence(): null {
  const store = useStore()
  const loadedRef = useRef(false)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout>>()

  // 启动：加载文件内容、注入 scratch tab、恢复激活状态
  useEffect(() => {
    const init = async (): Promise<void> => {
      try {
        // 加载 scratch-pad.md 内容（磁盘存的是 markdown，转为 HTML 给编辑器用）
        const [settings, loadedMd] = await Promise.all([
          window.electronAPI.getSettings(),
          window.electronAPI.loadScratchPad ? window.electronAPI.loadScratchPad() : Promise.resolve(''),
        ])

        const loadedHtml = loadedMd ? markdownToHtml(loadedMd) : ''
        store.set(scratchPadContentAtom, loadedHtml)
        store.set(scratchPadLoadedAtom, true)

        // 将 scratch tab 注入首位
        const currentTabs = store.get(tabsAtom)
        const newTabs = ensureScratchPadTab(currentTabs)

        // 如果 tabs 数组变了（新增了 scratch tab），写入 store
        if (newTabs.length > currentTabs.length || newTabs[0]?.id !== currentTabs[0]?.id) {
          store.set(tabsAtom, newTabs)
        }

        // 恢复 scratch 激活状态：如果上次关闭时在 scratch 页，则激活它。
        if (!settings.coreTabStates && settings.scratchPadActive) {
          store.set(activeTabIdAtom, SCRATCH_PAD_ID)
        }

        console.log('[ScratchPad] 初始化完成，已加载内容:', !!loadedMd)
      } catch (err) {
        console.error('[ScratchPad] 初始化失败:', err)
      } finally {
        loadedRef.current = true
      }
    }

    init()
  }, [store])

  // 自动保存：监听 scratchPadContentAtom 变化，防抖写入磁盘
  useEffect(() => {
    const save = (): void => {
      const html = store.get(scratchPadContentAtom)
      if (window.electronAPI.saveScratchPad) {
        const md = htmlToMarkdown(html)
        window.electronAPI.saveScratchPad(md).then((ok) => {
          if (!ok) console.error('[ScratchPad] 保存失败')
        }).catch(console.error)
      }
    }

    const debouncedSave = (): void => {
      if (!loadedRef.current) return
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      saveTimerRef.current = setTimeout(save, 500)
    }

    const unsub = store.sub(scratchPadContentAtom, debouncedSave)

    // beforeunload 时同步写入
    const handleBeforeUnload = (): void => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      const html = store.get(scratchPadContentAtom)
      if (window.electronAPI.saveScratchPadSync) {
        const md = htmlToMarkdown(html)
        window.electronAPI.saveScratchPadSync(md)
      }
    }
    window.addEventListener('beforeunload', handleBeforeUnload)

    return () => {
      unsub()
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      window.removeEventListener('beforeunload', handleBeforeUnload)
    }
  }, [store])

  // 监听 activeTabIdAtom 变化，持久化 scratchPadActive 到 settings
  useEffect(() => {
    const unsub = store.sub(activeTabIdAtom, () => {
      const activeTabId = store.get(activeTabIdAtom)
      const isScratchActive = activeTabId === SCRATCH_PAD_ID
      window.electronAPI.updateSettings({
        scratchPadActive: isScratchActive,
      }).catch(() => {})
    })
    return unsub
  }, [store])

  return null
}

// ===== 快速任务窗口：轻量渲染 =====
if (isQuickTaskWindow) {
  import('./components/quick-task/QuickTaskApp').then(({ QuickTaskApp }) => {
    ReactDOM.createRoot(document.getElementById('root')!).render(
      <React.StrictMode>
        <ThemeInitializer />
        <QuickTaskApp />
      </React.StrictMode>
    )
  })
} else if (isVoiceDictationWindow) {
  import('./components/voice-dictation/VoiceDictationApp').then(({ VoiceDictationApp }) => {
    ReactDOM.createRoot(document.getElementById('root')!).render(
      <React.StrictMode>
        <ThemeInitializer />
        <VoiceDictationApp />
        <ProferToaster position="top-right" offset={96} />
      </React.StrictMode>
    )
  })
} else if (isDetachedPreviewWindow) {
  import('./components/diff/DetachedPreviewApp').then(({ DetachedPreviewApp }) => {
    ReactDOM.createRoot(document.getElementById('root')!).render(
      <React.StrictMode>
        <ThemeInitializer />
        <MarkdownFontSizeInitializer />
        <UiScaleInitializer />
        <DetachedPreviewApp />
        <ProferToaster position="top-right" offset={96} />
      </React.StrictMode>
    )
  })
} else if (isAgentPreviewWindow) {
  import('./components/agent-preview/AgentPreviewRenderer').then(({ mountAgentPreviewRenderer }) => {
    mountAgentPreviewRenderer()
  })
} else if (isPlanningWindow) {
  import('./components/planning/PlanningWindowApp').then(({ PlanningWindowApp }) => {
    ReactDOM.createRoot(document.getElementById('root')!).render(
      <React.StrictMode>
        <ThemeInitializer />
        <PlanningInitializer />
        <PlanningWindowApp />
        <ProferToaster position="top-right" offset={96} />
      </React.StrictMode>
    )
  })
} else if (isSessionWindow) {
  // ===== 独立会话窗口：只渲染单个会话，不挂载主界面壳与全局业务初始化器 =====
  const sessionId = sessionWindowId
  const sessionType = sessionWindowType === 'chat' ? 'chat' : 'agent'
  if (!sessionId) {
    ReactDOM.createRoot(document.getElementById('root')!).render(
      <div className="flex h-screen items-center justify-center bg-background text-sm text-muted-foreground">
        会话窗口参数缺失
      </div>,
    )
  } else {
    ReactDOM.createRoot(document.getElementById('root')!).render(
      <React.StrictMode>
        <TooltipProvider delayDuration={200}>
          <ThemeInitializer />
          <AgentSettingsInitializer />
          <NotificationsInitializer />
          <AgentUnreadSettingsInitializer />
          <UiPreferencesInitializer />
          <SmoothWheelInitializer />
          <ComposerToolbarPreferencesInitializer />
          <MarkdownFontSizeInitializer />
          <UiScaleInitializer />
          <ChatToolInitializer />
          <ChatListenersInitializer />
          <SessionAgentListenersInitializer sessionId={sessionId} />
          <SessionWindowSettingsGuard />
          <SessionWindowShortcuts />
          <SessionWindowApp sessionId={sessionId} type={sessionType} />
          <ProferToaster position="top-right" offset={16} />
        </TooltipProvider>
      </React.StrictMode>
    )
  }
} else {
  // ===== 主窗口：完整渲染 =====
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <ThemeInitializer />
      <AgentSettingsInitializer />
      <NotificationsInitializer />
      <AgentUnreadSettingsInitializer />
      <SessionPreviewSettingsInitializer />
      <CurrentSessionCapacityInitializer />
      <SessionHandoffInitializer />
      <DockBadgeInitializer />
      <UiPreferencesInitializer />
      <SmoothWheelInitializer />
      <ComposerToolbarPreferencesInitializer />
      <MarkdownFontSizeInitializer />
      <UiScaleInitializer />
      <PluginSystemInitializer />
      <ChatListenersInitializer />
      <AgentListenersInitializer />
      <ReattachTabListener />
      <ChatToolInitializer />
      <UpdaterInitializer />
      <AutomationInitializer />
      <PlanningInitializer />
      <PlanningShortcutInitializer />
      <FeishuInitializer />
      <DingTalkInitializer />
      <WeChatInitializer />
      <TabStatePersistenceInitializer />
      <ScratchPadPersistence />
      <GlobalShortcuts />
      <NavigationInputProvider />
      <TabSwitcher />
      <App />
      <UpdateDialog />
      <ProferToaster position="top-right" offset={96} />
    </React.StrictMode>
  )
}
