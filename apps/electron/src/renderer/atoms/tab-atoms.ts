/**
 * Tab Atoms — 当前工作区入口状态管理
 *
 * 顶部保留 Scratch Pad 与用户打开的会话入口；会话恢复与导航交给左侧列表。
 * 通过桥接 atom 与现有 currentConversationIdAtom / currentAgentSessionIdAtom 同步，
 * 确保所有现有派生 atoms 无需修改。
 */

import { atom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'
import {
  streamingConversationIdsAtom,
} from './chat-atoms'
import {
  agentRunningSessionIdsAtom,
  agentSessionIndicatorMapAtom,
  unviewedCompletedSessionIdsAtom,
} from './agent-atoms'
import type { SessionIndicatorStatus } from './agent-atoms'
import { getFileBaseName } from '@/lib/file-utils'
import { removeMruId, selectMruFallbackId } from '@profer/shared'

// basename 提取统一走 renderer/lib 公共实现（R1），此处转发以保持既有导入路径兼容
export { getFileBaseName }

// ===== 类型定义 =====

/** 标签页类型（Settings 不作为 Tab，保留独立视图） */
export type TabType = 'chat' | 'agent' | 'scratch' | 'preview' | 'browser' | 'tutorial' | 'plugin'

/** Scratch Pad 专用的固定 sessionId */
export const SCRATCH_PAD_ID = '__scratch-pad__'

/** 教程 Tab 固定 ID */
export const TUTORIAL_TAB_ID = '__tutorial__'
export const TUTORIAL_TAB_TITLE = 'Profer 使用教程'

/** 会话文件预览 Tab 的 ID 前缀（每文件一个 Tab）：运行时临时入口，不参与持久化 */
const PREVIEW_TAB_PREFIX = '__preview__:'

/** 会话浏览器 Tab 的 ID 前缀（每网页一个，对应主进程浏览器内部标签）：运行时临时入口，不参与持久化 */
const BROWSER_TAB_PREFIX = '__browser__:'

/** Scratch Pad 标签默认标题 */
export const SCRATCH_PAD_TITLE = 'Scratch Pad'

export const PLUGIN_GLOBAL_SESSION_ID = '__plugin-global__'

/** 标签页数据 */
export interface TabItem {
  /** 唯一标签 ID（直接使用 sessionId） */
  id: string
  /** 标签页类型 */
  type: TabType
  /** Chat conversationId 或 Agent sessionId；插件页使用稳定 page key */
  sessionId: string
  /** 标签页显示标题 */
  title: string
  /** 插件页归属，仅 type=plugin 时存在。 */
  pluginId?: string
  pluginPageId?: string
  /** 插件页是否绑定宿主会话；global 用于设置页和桌宠等全局例外。 */
  pluginScope?: 'session' | 'global'
  /** 预览文件路径，仅 type=preview 时存在（每文件一个 Tab 的身份依据） */
  filePath?: string
  /** 浏览器内部标签 id，仅 type=browser 时存在（对应主进程 BrowserViewState.tabs[].tabId） */
  browserTabId?: string
  /**
   * 子会话血缘：探索分支（explorationParentSessionId）或委派子会话（parentSessionId）。
   * 存在时该 Tab 在顶栏归入根会话的上下文（与父会话的预览/浏览器工作 Tab 并列），
   * id 仍是子会话自身的 sessionId。
   */
  parentSessionId?: string
}

/** Tab 持久化数据（保存到 settings.json） */
export interface PersistedTabState {
  tabs: TabItem[]
  activeTabId: string | null
}

// ===== 核心 Atoms =====

/** 顶部入口列表：Scratch Pad + 当前会话 */
export const tabsAtom = atom<TabItem[]>([])

/** 当前激活的标签 ID */
export const activeTabIdAtom = atom<string | null>(null)

/** 标签页 MRU（最近使用）顺序，最近使用的 ID 排在前面 */
export const tabMruAtom = atom<string[]>([])

/**
 * 侧边栏是否收起（持久化）。
 * 启动时同步读取 localStorage，避免先按默认展开态渲染、随后才收起，
 * 造成刷新首帧将完整侧栏内容裁进 60px 窄轨道的闪烁。
 */
export const sidebarCollapsedAtom = atomWithStorage<boolean>(
  'profer-sidebar-collapsed',
  false,
  undefined,
  { getOnInit: true },
)

/** Tab 迷你地图缓存（每个 Tab 的消息预览列表，在消息组件中填充） */
export interface TabMinimapItem {
  id: string
  role: 'user' | 'assistant' | 'status'
  preview: string
  avatar?: string
  model?: string
}
export const tabMinimapCacheAtom = atom<Map<string, TabMinimapItem[]>>(new Map())

/** Scratch Pad 编辑内容（HTML 字符串，供 TipTap 编辑器使用） */
export const scratchPadContentAtom = atom<string>('')
/** Scratch Pad 内容是否已从磁盘加载 */
export const scratchPadLoadedAtom = atom<boolean>(false)

// ===== 派生 Atoms =====

/** 当前活跃标签 */
export const activeTabAtom = atom<TabItem | null>((get) => {
  const activeId = get(activeTabIdAtom)
  if (!activeId) return null
  return get(tabsAtom).find((t) => t.id === activeId) ?? null
})

/**
 * 当前活跃标签所属的会话 ID。
 * 预览 Tab 归一化为其 owner 会话的 sessionId，使"会话高亮"与"Ctrl+Tab 定位"
 * 都把预览 Tab 视为所属会话的一部分（preview tab 的 id 自身不参与这些判定）。
 */
export const activeSessionIdAtom = atom<string | null>((get) => {
  const activeTab = get(activeTabAtom)
  if (!activeTab) return null
  if (activeTab.type === 'plugin' && activeTab.pluginScope !== 'session') return null
  return activeTab.sessionId
})

/** 标签是否在流式输出中（派生，从现有流式 atoms 计算） */
export const tabStreamingMapAtom = atom<Map<string, boolean>>((get) => {
  const tabs = get(tabsAtom)
  const chatStreaming = get(streamingConversationIdsAtom)
  const agentRunning = get(agentRunningSessionIdsAtom)
  const map = new Map<string, boolean>()
  for (const tab of tabs) {
    if (tab.type === 'scratch') continue
    if (tab.type === 'chat') {
      map.set(tab.id, chatStreaming.has(tab.sessionId))
    } else if (tab.type === 'agent') {
      map.set(tab.id, agentRunning.has(tab.sessionId))
    }
  }
  return map
})

/** 标签页指示点状态（chat 用 running/idle，agent 用完整 SessionIndicatorStatus） */
export const tabIndicatorMapAtom = atom<Map<string, SessionIndicatorStatus>>((get) => {
  const tabs = get(tabsAtom)
  const chatStreaming = get(streamingConversationIdsAtom)
  const agentIndicator = get(agentSessionIndicatorMapAtom)
  const unviewedCompletedIds = get(unviewedCompletedSessionIdsAtom)
  const map = new Map<string, SessionIndicatorStatus>()
  for (const tab of tabs) {
    if (tab.type === 'scratch') continue
    if (tab.type === 'chat') {
      map.set(tab.id, chatStreaming.has(tab.sessionId) ? 'running' : 'idle')
    } else if (tab.type === 'agent') {
      const status = agentIndicator.get(tab.sessionId)
        ?? (unviewedCompletedIds.has(tab.sessionId) ? 'completed' : 'idle')
      map.set(tab.id, status)
    }
  }
  return map
})

// ===== 操作函数 =====

function createScratchPadTab(): TabItem {
  return {
    id: SCRATCH_PAD_ID,
    type: 'scratch',
    sessionId: SCRATCH_PAD_ID,
    title: SCRATCH_PAD_TITLE,
  }
}

/** 每文件一个预览 Tab：id 携带文件路径，同一文件重复打开时命中同一个 Tab。 */
export function createPreviewTabId(sessionId: string, filePath: string): string {
  return `${PREVIEW_TAB_PREFIX}${sessionId}:${encodeURIComponent(filePath)}`
}

export function createBrowserTabId(sessionId: string, browserTabId: string): string {
  return `${BROWSER_TAB_PREFIX}${sessionId}:${browserTabId}`
}

export function getPreviewTabTitle(filePath: string): string {
  return `预览：${getFileBaseName(filePath)}`
}

export function isPreviewTab(tab: TabItem): boolean {
  return tab.type === 'preview' || tab.id.startsWith(PREVIEW_TAB_PREFIX)
}

export function isBrowserTab(tab: TabItem): boolean {
  return tab.type === 'browser' || tab.id.startsWith(BROWSER_TAB_PREFIX)
}

/**
 * 会话绑定的工作 Tab：文件预览、浏览器与插件页面。
 * 它们属于某个 Agent 会话，跟随会话上下文展示，不参与持久化。
 */
export function isSessionWorkTab(tab: TabItem): boolean {
  return isPreviewTab(tab) || isBrowserTab(tab) || (isPluginTab(tab) && tab.pluginScope === 'session')
}

function isSessionTab(tab: TabItem): boolean {
  return tab.type === 'chat' || tab.type === 'agent'
}

export function isPluginTab(tab: TabItem): boolean {
  return tab.type === 'plugin' && !!tab.pluginId && !!tab.pluginPageId
}

/**
 * 解析 Tab 在顶栏上下文中的归属会话：沿 parentSessionId 血缘走到根会话。
 * 探索分支/委派子会话与父会话及其工作 Tab 同上下文显示；
 * 血缘成环或父 Tab 缺失时安全回退到自身 sessionId。
 */
export function tabContextSessionId(tabs: readonly TabItem[], tab: TabItem): string {
  const byId = new Map(tabs.map((item) => [item.sessionId, item]))
  const visited = new Set<string>([tab.sessionId])
  let current = tab
  while (current.parentSessionId) {
    const parent = byId.get(current.parentSessionId)
    if (!parent || visited.has(parent.sessionId)) break
    visited.add(parent.sessionId)
    current = parent
  }
  return current.sessionId
}

export function createPluginTabId(pluginId: string, pageId: string, sessionId?: string): string {
  return sessionId
    ? `__plugin__:${pluginId}:${pageId}:${encodeURIComponent(sessionId)}`
    : `__plugin__:${pluginId}:${pageId}`
}

function insertSessionWorkTab(tabs: TabItem[], workTab: TabItem): TabItem[] {
  const scratchTab = tabs.find((tab) => tab.id === SCRATCH_PAD_ID) ?? createScratchPadTab()
  const baseTabs = tabs.some((tab) => tab.id === SCRATCH_PAD_ID) ? [...tabs] : [scratchTab, ...tabs]
  const ownerIndex = baseTabs.findIndex((tab) => (tab.type === 'agent' || tab.type === 'chat') && tab.sessionId === workTab.sessionId)
  if (ownerIndex < 0) return [...baseTabs, workTab]
  let insertIndex = ownerIndex + 1
  while (insertIndex < baseTabs.length && isSessionWorkTab(baseTabs[insertIndex]!) && baseTabs[insertIndex]!.sessionId === workTab.sessionId) insertIndex += 1
  return [...baseTabs.slice(0, insertIndex), workTab, ...baseTabs.slice(insertIndex)]
}

export function openPluginTab(
  tabs: TabItem[],
  input: { pluginId: string; pageId: string; title: string; sessionId?: string; scope?: 'session' | 'global' },
): { tabs: TabItem[]; activeTabId: string } {
  const scope = input.scope ?? (input.sessionId ? 'session' : 'global')
  const sessionId = scope === 'session' ? input.sessionId : undefined
  if (scope === 'session' && !sessionId) return { tabs, activeTabId: tabs.find((tab) => tab.id === SCRATCH_PAD_ID)?.id ?? SCRATCH_PAD_ID }
  const id = createPluginTabId(input.pluginId, input.pageId, sessionId)
  const existing = tabs.find((tab) => tab.id === id)
  if (existing) return { tabs, activeTabId: id }
  const pluginTab: TabItem = {
    id,
    type: 'plugin',
    sessionId: sessionId ?? PLUGIN_GLOBAL_SESSION_ID,
    title: input.title,
    pluginId: input.pluginId,
    pluginPageId: input.pageId,
    pluginScope: scope,
  }
  return {
    tabs: scope === 'session' ? insertSessionWorkTab(tabs, pluginTab) : [...(tabs.some((tab) => tab.id === SCRATCH_PAD_ID) ? tabs : [createScratchPadTab(), ...tabs]), pluginTab],
    activeTabId: id,
  }
}

function getPersistentTabs(tabs: TabItem[]): TabItem[] {
  return tabs.filter((tab) => isSessionTab(tab))
}

export function getPersistableTabState(
  tabs: TabItem[],
  activeTabId: string | null,
): PersistedTabState {
  const persistentTabs = getPersistentTabs(tabs)
  const activeTab = activeTabId ? tabs.find((tab) => tab.id === activeTabId) : null
  const persistentActiveTabId = activeTab && isSessionWorkTab(activeTab)
    ? persistentTabs.find((tab) => tab.sessionId === activeTab.sessionId && tab.type === 'agent')?.id
      ?? persistentTabs.at(-1)?.id
      ?? null
    : activeTab && isSessionTab(activeTab)
      ? activeTab.id
      : persistentTabs.at(-1)?.id ?? null

  return {
    tabs: persistentTabs,
    activeTabId: persistentActiveTabId,
  }
}

/** openTab 的入参：文件预览 Tab 必须携带 filePath（id 与单例判定的身份依据）。 */
export type OpenTabInput = {
  type: TabType
  sessionId: string
  title: string
  pluginId?: string
  pluginPageId?: string
  /** 仅 type=preview 时必须提供 */
  filePath?: string
  /** 仅 type=browser 时必须提供（对应主进程浏览器内部标签） */
  browserTabId?: string
  /** 子会话 Tab：传入父会话 sessionId（探索分支 / 委派子会话） */
  parentSessionId?: string
}

/** 打开或聚焦会话入口：保留已打开的 Tab，新会话追加到末尾。 */
export function openTab(
  tabs: TabItem[],
  item: OpenTabInput,
): { tabs: TabItem[]; activeTabId: string } {
  const scratchTab = tabs.find((t) => t.id === SCRATCH_PAD_ID) ?? createScratchPadTab()

  if (item.type === 'plugin') {
    if (item.pluginId && item.pluginPageId) return openPluginTab(tabs, { pluginId: item.pluginId, pageId: item.pluginPageId, title: item.title })
    return { tabs, activeTabId: SCRATCH_PAD_ID }
  }

  if (item.type === 'scratch') {
    return {
      tabs: tabs.some((tab) => tab.id === SCRATCH_PAD_ID) ? tabs : [scratchTab, ...tabs],
      activeTabId: SCRATCH_PAD_ID,
    }
  }

  if (item.type === 'tutorial') {
    const tutorialTab: TabItem = tabs.find((t) => t.id === TUTORIAL_TAB_ID) ?? {
      id: TUTORIAL_TAB_ID,
      type: 'tutorial',
      sessionId: TUTORIAL_TAB_ID,
      title: TUTORIAL_TAB_TITLE,
    }
    return {
      tabs: tabs.some((tab) => tab.id === TUTORIAL_TAB_ID) ? tabs : [...tabs, tutorialTab],
      activeTabId: TUTORIAL_TAB_ID,
    }
  }

  // 会话绑定的工作 Tab（文件预览 / 浏览器）：挂在 owner 会话 Tab 之后。
  // - preview：每文件一个实例（id 含 filePath），重复打开同一文件 = 聚焦既有 Tab；
  // - browser：每会话单例。
  if (item.type === 'preview' || item.type === 'browser') {
    const workTab: TabItem = item.type === 'preview'
      ? {
        id: createPreviewTabId(item.sessionId, item.filePath ?? item.title),
        type: 'preview',
        sessionId: item.sessionId,
        title: item.title,
        filePath: item.filePath,
      }
      : {
        id: createBrowserTabId(item.sessionId, item.browserTabId ?? ''),
        type: 'browser',
        sessionId: item.sessionId,
        title: item.title,
        ...(item.browserTabId ? { browserTabId: item.browserTabId } : {}),
      }
    const existing = tabs.find((tab) => tab.id === workTab.id)
    if (existing) {
      return {
        tabs: tabs.some((tab) => tab.id === SCRATCH_PAD_ID) ? tabs : [scratchTab, ...tabs],
        activeTabId: existing.id,
      }
    }
    // owner 会话 Tab：优先复用同会话的 agent/chat 入口（chat 会话的文件预览不应造出幻影 agent Tab）
    const ownerAgentTab = tabs.find((t) => (t.type === 'agent' || t.type === 'chat') && t.sessionId === item.sessionId) ?? {
      id: item.sessionId,
      type: 'agent' as const,
      sessionId: item.sessionId,
      title: 'Agent 会话',
    }
    const ownerIndex = tabs.findIndex((tab) => tab.id === ownerAgentTab.id)
    // 追加到该会话工作 Tab 簇末尾（而非紧跟 owner），保证多个工作 Tab 按创建顺序排列
    let insertIndex = ownerIndex + 1
    if (ownerIndex !== -1) {
      while (insertIndex < tabs.length
        && isSessionWorkTab(tabs[insertIndex]!)
        && tabs[insertIndex]!.sessionId === item.sessionId) {
        insertIndex += 1
      }
    }
    const nextTabs = ownerIndex === -1
      ? [...tabs, ownerAgentTab, workTab]
      : [...tabs.slice(0, insertIndex), workTab, ...tabs.slice(insertIndex)]

    return {
      tabs: nextTabs.some((tab) => tab.id === SCRATCH_PAD_ID) ? nextTabs : [scratchTab, ...nextTabs],
      activeTabId: workTab.id,
    }
  }

  const existingTab = tabs.find((t) => t.sessionId === item.sessionId && t.type === item.type)
  const sessionTab: TabItem = existingTab
    ? (item.parentSessionId && !existingTab.parentSessionId
        ? { ...existingTab, parentSessionId: item.parentSessionId }
        : existingTab)
    : {
      id: item.sessionId,
      type: item.type,
      sessionId: item.sessionId,
      title: item.title,
      ...(item.parentSessionId ? { parentSessionId: item.parentSessionId } : {}),
    }

  const existingIndex = tabs.findIndex((tab) => tab.id === sessionTab.id)
  const tabsWithSession = existingIndex === -1
    ? [...tabs, sessionTab]
    : tabs.map((tab) => tab.id === sessionTab.id ? sessionTab : tab)
  const tabsWithScratch = tabsWithSession.some((tab) => tab.id === SCRATCH_PAD_ID)
    ? tabsWithSession
    : [scratchTab, ...tabsWithSession]

  return {
    tabs: tabsWithScratch,
    activeTabId: sessionTab.id,
  }
}

/**
 * 关闭会话入口后选择回退 Tab：优先同模式会话（按 MRU），同类关完则回 Scratch Pad。
 * 返回 null 表示不需要覆盖 closeTab 引擎选出的结果（如关闭工作 Tab、回退目标已是同类）。
 * 关键约束：绝不跨模式自动跳转（关 Agent 不跳 Chat，关 Chat 不跳 Agent）。
 */
export function selectSameModeCloseFallback(
  remainingTabs: TabItem[],
  closingTab: TabItem | undefined,
  activationChanges: boolean,
  mru: readonly string[],
  fallbackTabId: string | null,
): string | null {
  if (!closingTab || !activationChanges) return null
  if (closingTab.type !== 'agent' && closingTab.type !== 'chat') return null
  const fallbackTab = fallbackTabId ? remainingTabs.find((tab) => tab.id === fallbackTabId) : undefined
  if (fallbackTab?.type === closingTab.type) return null
  const sameKind = mru
    .map((sessionId) => remainingTabs.find((tab) => tab.type === closingTab.type && tab.sessionId === sessionId))
    .find((tab): tab is TabItem => !!tab)
    ?? remainingTabs.find((tab) => tab.type === closingTab.type)
    ?? remainingTabs.find((tab) => tab.type === 'scratch')
  return sameKind?.id ?? null
}

/** 关闭标签页（scratch tab 不可关闭） */
export function closeTab(
  tabs: TabItem[],
  activeTabId: string | null,
  tabId: string,
  mru: readonly string[] = [],
): { tabs: TabItem[]; activeTabId: string | null; mru: string[] } {
  // Scratch Pad 不可关闭
  if (tabId === SCRATCH_PAD_ID) return { tabs, activeTabId, mru: [...mru] }

  const tabIndex = tabs.findIndex((t) => t.id === tabId)
  if (tabIndex === -1) return { tabs, activeTabId, mru: [...mru] }
  const closingTab = tabs[tabIndex]!
  // 关闭会话 Tab 时连带关闭其全部工作 Tab（文件预览×N + 浏览器单例）
  const boundWorkTabIds = isSessionTab(closingTab)
    ? new Set(tabs.filter((t) => t.sessionId === closingTab.sessionId && isSessionWorkTab(t)).map((t) => t.id))
    : null

  const newTabs = tabs.filter((t) => t.id !== tabId && !boundWorkTabIds?.has(t.id))

  const nextMru = isSessionWorkTab(closingTab)
    ? removeMruId(mru, tabId)
    : removeMruId(mru, closingTab.sessionId)
  // 关闭当前标签时按最近访问顺序回退；关闭非当前标签保持活动标签不变。
  let newActiveTabId = activeTabId
  const activeTabWasRemoved = newActiveTabId !== null && !newTabs.some((t) => t.id === newActiveTabId)
  if (activeTabId === tabId || activeTabWasRemoved) {
    // MRU 以会话 ID 记账，工作 Tab 需要映射回其实际 Tab ID。
    // 关闭工作 Tab 时保留 owner 会话作为回退目标，避免关闭后悬空在其他会话。
    const mruTarget = selectMruFallbackId(
      nextMru,
      isSessionWorkTab(closingTab) ? tabId : closingTab.sessionId,
      newTabs.flatMap((tab) => [tab.id, tab.sessionId]),
    )
    const targetTab = mruTarget
      ? newTabs.find((tab) => tab.id === mruTarget || tab.sessionId === mruTarget)
      : undefined
    if (targetTab) {
      newActiveTabId = targetTab.id
    } else if (newTabs.length > 0) {
      const nextIndex = Math.min(tabIndex, newTabs.length - 1)
      newActiveTabId = newTabs[nextIndex]!.id
    } else {
      newActiveTabId = null
    }
  }

  return { tabs: newTabs, activeTabId: newActiveTabId, mru: nextMru }
}

/** 重排标签顺序（Scratch Pad 固定在第 0 位） */
export function reorderTabs(
  tabs: TabItem[],
  fromIndex: number,
  toIndex: number,
): TabItem[] {
  if (fromIndex === toIndex) return tabs
  // Scratch 不可移出第 0 位
  if (tabs[0]?.id === SCRATCH_PAD_ID && (fromIndex === 0 || toIndex === 0)) return tabs
  const newTabs = [...tabs]
  const [moved] = newTabs.splice(fromIndex, 1)
  newTabs.splice(toIndex, 0, moved!)
  return newTabs
}

/** 更新标签标题 */
export function updateTabTitle(
  tabs: TabItem[],
  sessionId: string,
  title: string,
): TabItem[] {
  return tabs.map((t) =>
    t.sessionId === sessionId && !isSessionWorkTab(t) ? { ...t, title } : t
  )
}

/** 确保 Scratch Pad 标签存在并位于首位，保留所有已打开标签。 */
export function ensureScratchPadTab(tabs: TabItem[]): TabItem[] {
  const scratchTab = tabs.find((t) => t.id === SCRATCH_PAD_ID) ?? createScratchPadTab()
  const withoutScratch = tabs.filter((tab) => tab.id !== SCRATCH_PAD_ID)
  return [scratchTab, ...withoutScratch]
}
