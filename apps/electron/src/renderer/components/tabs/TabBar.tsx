/**
 * TabBar — 顶部标签栏
 *
 * 显示所有打开的标签页，支持：
 * - 点击切换标签
 * - 中键关闭标签
 * - 拖拽重排序
 * - 紧凑自适应宽度（溢出时可横向滚动）
 */

import * as React from "react";
import { useLayoutEffect } from "react";
import { useAtom, useAtomValue, useSetAtom, useStore } from "jotai";
import { PluginTopBarEntries } from '@/components/plugins/PluginEntries'
import { resolvePluginPageSurfaceVisibility } from '@profer/plugin-api'
import { installedPluginsAtom } from '@/atoms/plugin-system'
import { Globe2, PanelRight, Ungroup, Blocks } from "lucide-react";
import { toast } from "sonner";
import {
  tabsAtom,
  activeTabIdAtom,
  tabIndicatorMapAtom,
  closeTab,
  reorderTabs,
  updateTabTitle,
  tabMruAtom,
} from "@/atoms/tab-atoms";
import type { TabItem } from "@/atoms/tab-atoms";
import type { SessionIndicatorStatus } from "@/atoms/agent-atoms";
import { currentConversationIdAtom } from "@/atoms/chat-atoms";
import {
  agentSessionsAtom,
  agentSessionDraftsAtom,
  agentSessionDraftHtmlAtom,
  agentSidePanelOpenAtom,
  agentWorkspacesAtom,
  currentAgentSessionIdAtom,
  currentAgentWorkspaceIdAtom,
  unviewedCompletedSessionIdsAtom,
  workspaceFilesVersionAtom,
  seenFilesVersionAtom,
} from "@/atoms/agent-atoms";
import { browserStateMapAtom } from "@/atoms/browser-atoms";
import { appModeAtom } from "@/atoms/app-mode";
import { openFilePanel } from "@/hooks/usePanelAutoLayout";
import { openBrowserTabManually } from "@/lib/browser-tab";
import {
  emptyGroupSide,
  findTabGroup,
  groupTabIds,
  isGroupActive,
  isGroupEligibleTab,
  planGroupDrop,
  ratioForEmptySide,
  removeTabGroup,
  replaceTabGroup,
  tabGroupsAtom,
  tabGroupDragAtom,
  tabGroupRatioAtom,
  type TabGroupSide,
} from "@/atoms/tab-group-atoms";
import { panelVisibilityAtom } from "@/atoms/panel-layout-atoms";
import { automationFormAtom } from "@/atoms/automation-atoms";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { WindowControlsHost } from "@/components/WindowControlsTemplate";
import { TabBarItem } from "./TabBarItem";
import { TabGroupItem } from "./TabGroupItem";
import { useCloseTab } from "@/hooks/useCloseTab";
import { detectIsWindows } from "@/lib/platform";
import { registerShortcut } from "@/lib/shortcut-registry";
import { cn } from "@/lib/utils";
import { replaceAgentSessionInFreshnessOrder } from "@/lib/agent-session-list";
import { isAgentWorkspaceIdVisible } from "@/lib/product-feature-flags";

import { promoteMru } from "@profer/shared";
import { resolveWindowControlsRightInset } from "@/lib/window-controls-layout";
import {
  TOPBAR_CONTENT_HEIGHT,
  TOPBAR_CONTENT_OFFSET,
  TOPBAR_HEIGHT,
} from "./topbar-layout";

export function TabBar({
  teamMode = false,
}: { teamMode?: boolean } = {}): React.ReactElement {
  const tabs = useAtomValue(tabsAtom);
  const setTabs = useSetAtom(tabsAtom);
  const [activeTabId, setActiveTabId] = useAtom(activeTabIdAtom);
  const agentSessions = useAtomValue(agentSessionsAtom);
  const installedPlugins = useAtomValue(installedPluginsAtom)
  const hasPluginPages = installedPlugins.some((plugin) => plugin.enabled && (plugin.manifest.contributes.pages ?? []).some((page) => resolvePluginPageSurfaceVisibility(page, plugin.pagePlacements?.[page.id], 'tab')))
  const contextTabs = React.useMemo(() => {
    const active = tabs.find((tab) => tab.id === activeTabId) ?? null
    if (!active) return tabs
    if (active.type === 'chat') return tabs.filter((tab) => tab.sessionId === active.sessionId)

    const sessionBoundPlugin = active.type === 'plugin' && active.pluginScope === 'session'
    if (active.type === 'agent' || active.type === 'preview' || active.type === 'browser' || sessionBoundPlugin) {
      const sessionId = active.sessionId
      const activeSession = agentSessions.find((session) => session.id === sessionId)
      const ownerTab = tabs.find((tab) => (tab.type === 'chat' || tab.type === 'agent') && tab.sessionId === sessionId)
      if (ownerTab?.type === 'chat') return tabs.filter((tab) => tab.sessionId === sessionId)
      const rootSessionId = activeSession?.parentSessionId ?? activeSession?.explorationParentSessionId ?? sessionId
      const sessionIds = new Set(
        agentSessions
          .filter((session) => session.id === rootSessionId || session.parentSessionId === rootSessionId || session.explorationParentSessionId === rootSessionId)
          .map((session) => session.id),
      )
      sessionIds.add(rootSessionId)
      return tabs.filter((tab) => sessionIds.has(tab.sessionId) || tab.parentSessionId === rootSessionId)
    }
    return tabs.filter((tab) => tab.id === active.id)
  }, [activeTabId, agentSessions, tabs]);
  const indicatorMap = useAtomValue(tabIndicatorMapAtom);
  const setTabMru = useSetAtom(tabMruAtom);
  const isWindows = React.useMemo(() => detectIsWindows(), []);

  // Tab 切换时同步 sidebar 状态
  const appMode = useAtomValue(appModeAtom);
  const setAppMode = useSetAtom(appModeAtom);
  const setCurrentConversationId = useSetAtom(currentConversationIdAtom);
  const setCurrentAgentSessionId = useSetAtom(currentAgentSessionIdAtom);
  const agentWorkspaces = useAtomValue(agentWorkspacesAtom);
  const setCurrentAgentWorkspaceId = useSetAtom(currentAgentWorkspaceIdAtom);
  const setUnviewedCompleted = useSetAtom(unviewedCompletedSessionIdsAtom);
  const setAutomationForm = useSetAtom(automationFormAtom);

  // 统一关闭逻辑：关闭当前会话入口并回到 Scratch Pad，不停止后台 Agent
  const { requestClose } = useCloseTab();
  const store = useStore();

  const workspaceNameBySessionId = React.useMemo(() => {
    const workspaceNameMap = new Map(
      agentWorkspaces.map((workspace) => [workspace.id, workspace.name]),
    );
    const sessionWorkspaceNameMap = new Map<string, string>();
    for (const session of agentSessions) {
      if (!session.workspaceId) continue;
      const workspaceName = workspaceNameMap.get(session.workspaceId);
      if (workspaceName) sessionWorkspaceNameMap.set(session.id, workspaceName);
    }
    return sessionWorkspaceNameMap;
  }, [agentSessions, agentWorkspaces]);

  const automationSessionIds = React.useMemo(() => {
    const ids = new Set<string>();
    for (const s of agentSessions) {
      // 委派来源优先：同时带委派与定时任务来源时不算定时任务（#993）
      if (s.sourceAutomationId && !s.sourceDelegationId) ids.add(s.id);
    }
    return ids;
  }, [agentSessions]);

  // 点击工作区创建的项目 draft 会话不应一直占用标签栏。
  // 只有离开它、且输入框没有任何未发送文字时才移除标签入口；会话本身仍留在
  // 主进程以便下次点击同一工作区复用。用上一枚 active tab 统一覆盖顶栏、侧栏和快捷切换器。
  const previousActiveTabRef = React.useRef<TabItem | null>(null);
  React.useEffect(() => {
    const activeTab = activeTabId
      ? tabs.find((tab) => tab.id === activeTabId)
      : undefined;
    if (activeTab)
      setTabMru((previous) => promoteMru(previous, activeTab.sessionId));
  }, [activeTabId, setTabMru, tabs]);

  React.useEffect(() => {
    const currentTab = activeTabId
      ? (tabs.find((tab) => tab.id === activeTabId) ?? null)
      : null;
    const previousTab = previousActiveTabRef.current;
    previousActiveTabRef.current = currentTab;
    if (
      !previousTab ||
      !currentTab ||
      previousTab.sessionId === currentTab.sessionId
    )
      return;

    const previousSession = agentSessions.find(
      (session) => session.id === previousTab.sessionId,
    );
    if (!previousSession?.draft) return;

    // 自动关闭只在离开标签时判断一次；不要订阅输入草稿 Map，避免用户每敲一个字
    // 都让整个 TabBar（以及所有标签项）重渲染。
    const markdownDraft =
      store.get(agentSessionDraftsAtom).get(previousSession.id)?.trim() ?? "";
    // TipTap 的纯空段落不算输入；其余富文本按文本内容判断，避免空编辑器阻止自动收起。
    const htmlText = (
      store.get(agentSessionDraftHtmlAtom).get(previousSession.id) ?? ""
    )
      .replace(/<[^>]*>/g, "")
      .replace(/&nbsp;/g, " ")
      .trim();
    if (markdownDraft || htmlText) return;

    const sessionTab = tabs.find(
      (tab) => tab.type === "agent" && tab.sessionId === previousSession.id,
    );
    if (sessionTab) requestClose(sessionTab.id);
  }, [activeTabId, agentSessions, requestClose, store, tabs]);

  // 拖拽状态
  /** 进行中的标签排序的取消句柄（合并手势中途接管时调用） */
  const sortCancelRef = React.useRef<(() => void) | null>(null);
  const dragState = React.useRef<{
    dragging: boolean;
    tabId: string;
    startX: number;
    startY: number;
    lastX: number;
    pointerOffsetX: number;
    latestX: number;
  } | null>(null);
  const dragSettleCleanupRef = React.useRef<ReturnType<
    typeof setTimeout
  > | null>(null);

  const handleActivate = React.useCallback(
    (tabId: string) => {
      const tab = tabs.find((t) => t.id === tabId);
      if (!tab) return;
      if (tab.type === "agent" || tab.type === "preview") {
        const session = agentSessions.find((s) => s.id === tab.sessionId);
        if (!isAgentWorkspaceIdVisible(session?.workspaceId, agentWorkspaces)) return;
      }

      // 原生 WebContentsView 位于 renderer DOM 之上，不能等 React 重渲染后再隐藏：
      // 顶栏切换标签的瞬间，旧网页可能仍覆盖新 TabBar，甚至继续拦截鼠标命中。
      // 先同步切换主进程的前台浏览器所有权；新的 BrowserViewport 发布布局后再显示目标网页。
      const pluginApi = (window.electronAPI as Partial<typeof window.electronAPI>)
      const activePluginTab = tab.type === "plugin" && tab.pluginId && tab.pluginPageId
        ? { pluginId: tab.pluginId, pageId: tab.pluginPageId, instance: tab.pluginScope === 'session' ? { kind: 'tab' as const, sessionId: tab.sessionId } : { kind: 'tab' as const } }
        : null
      const hidePluginView = pluginApi.hidePluginView
      if (typeof hidePluginView === 'function') {
        for (const candidate of tabs) {
          if (candidate.type === 'plugin' && candidate.pluginId && candidate.pluginPageId
            && (!activePluginTab || candidate.id !== tab.id)) {
            void hidePluginView(candidate.pluginId, candidate.pluginPageId, candidate.pluginScope === 'session' ? { kind: 'tab', sessionId: candidate.sessionId } : { kind: 'tab' }).catch(() => undefined)
          }
        }
      }
      const setForeground = (
        window.electronAPI as Partial<typeof window.electronAPI>
      ).setAgentBrowserForeground;
      if (typeof setForeground === "function") {
        setForeground(tab.type === "agent" ? tab.sessionId : null);
      }
      // 浏览器页 Tab：激活 = 切换主进程当前页（原生视口按激活页渲染）
      if (tab.type === "browser" && tab.browserTabId) {
        const browserState = store.get(browserStateMapAtom).get(tab.sessionId);
        if (browserState?.activeTabId !== tab.browserTabId) {
          const select = (window.electronAPI as Partial<typeof window.electronAPI>).selectAgentBrowserTab;
          if (typeof select === "function") {
            void select({ sessionId: tab.sessionId, tabId: tab.browserTabId }).catch(() => undefined);
          }
        }
      }
      setActiveTabId(tabId);
      setTabMru((previous) => promoteMru(previous, tab.sessionId));
      // 点击任意 tab 都关闭定时任务编辑表单（overlay 否则会盖在内容区上）
      setAutomationForm({ open: false, draft: null });

      if (tab.type === "plugin") {
        if (tab.pluginScope === 'session') {
          const ownerTab = tabs.find((candidate) => (candidate.type === 'chat' || candidate.type === 'agent') && candidate.sessionId === tab.sessionId)
          if (ownerTab?.type === 'chat') {
            setAppMode("chat")
            setCurrentConversationId(tab.sessionId)
            setCurrentAgentSessionId(null)
            setCurrentAgentWorkspaceId(null)
          } else {
            setAppMode("agent")
            setCurrentConversationId(null)
            setCurrentAgentSessionId(tab.sessionId)
            const session = agentSessions.find((candidate) => candidate.id === tab.sessionId)
            if (session?.workspaceId) setCurrentAgentWorkspaceId(session.workspaceId)
          }
        } else {
          setAppMode("scratch")
          setCurrentConversationId(null)
          setCurrentAgentSessionId(null)
          setCurrentAgentWorkspaceId(null)
        }
      } else if (tab.type === "chat") {
        setAppMode("chat");
        setCurrentConversationId(tab.sessionId);
      } else if (tab.type === "agent" || tab.type === "preview") {
        setAppMode("agent");
        setCurrentAgentSessionId(tab.sessionId);

        // 用户打开查看后只清除未读角标；是否完成由用户通过对勾确认。
        setUnviewedCompleted((prev) => {
          if (!prev.has(tab.sessionId)) return prev;
          const next = new Set(prev);
          next.delete(tab.sessionId);
          return next;
        });

        const session = agentSessions.find((s) => s.id === tab.sessionId);
        if (session?.workspaceId) {
          setCurrentAgentWorkspaceId(session.workspaceId);
          window.electronAPI
            .updateSettings({
              agentWorkspaceId: session.workspaceId,
            })
            .catch(console.error);
        }
      } else if (tab.type === "scratch" || tab.type === "tutorial") {
        setCurrentConversationId(null);
        // 个人 Agent 模式下保留 appMode，避免切到 Scratch 时收起右侧文件面板；
        // 团队模式必须退出 TeamWorkspaceView，否则草稿/教程标签会被团队文件页遮住。
        if (teamMode) {
          setAppMode("scratch");
          setCurrentAgentSessionId(null);
        } else if (appMode !== "agent") {
          setCurrentAgentSessionId(null);
        }
      }
    },
    [
      setActiveTabId,
      setAutomationForm,
      setTabMru,
      tabs,
      agentSessions,
      agentWorkspaces,
      appMode,
      teamMode,
      setAppMode,
      setCurrentConversationId,
      setCurrentAgentSessionId,
      setCurrentAgentWorkspaceId,
      setUnviewedCompleted,
    ],
  );

  const handleDragStart = React.useCallback(
    (tabId: string, e: React.PointerEvent) => {
      if (e.button !== 0) return; // 只处理左键
      const idx = tabs.findIndex((t) => t.id === tabId);
      if (idx === -1) return;

      if (dragSettleCleanupRef.current !== null) {
        clearTimeout(dragSettleCleanupRef.current);
        dragSettleCleanupRef.current = null;
      }
      const tabNode = document.querySelector<HTMLElement>(
        `[data-tab-id="${CSS.escape(tabId)}"]`,
      );
      const tabRect = tabNode?.getBoundingClientRect();
      dragState.current = {
        dragging: false,
        tabId,
        startX: e.clientX,
        startY: e.clientY,
        lastX: e.clientX,
        pointerOffsetX: tabRect ? e.clientX - tabRect.left : 0,
        latestX: e.clientX,
      };

      const getNaturalTabLeft = (node: HTMLElement): number => {
        const offsetParent = node.offsetParent as HTMLElement | null;
        if (!offsetParent) return node.getBoundingClientRect().left;
        const parentRect = offsetParent.getBoundingClientRect();
        return parentRect.left + node.offsetLeft - offsetParent.scrollLeft;
      };

      const applyDraggedTransform = (): void => {
        const current = dragState.current;
        if (!current?.dragging) return;
        const node = document.querySelector<HTMLElement>(
          `[data-tab-id="${CSS.escape(current.tabId)}"]`,
        );
        if (!node) return;
        const left = current.latestX - current.pointerOffsetX;
        const dx = left - getNaturalTabLeft(node);
        node.dataset.tabDragging = "true";
        node.style.transition = "none";
        node.style.transform = `translate3d(${dx}px, 0, 0)`;
        node.style.willChange = "transform";
        node.style.zIndex = "20";
      };

      let pendingMove: PointerEvent | null = null;
      let moveFrame: number | null = null;

      const processMove = (me: PointerEvent): void => {
        const current = dragState.current;
        if (!current) return;

        const dx = Math.abs(me.clientX - current.startX);
        const dy = Math.abs(me.clientY - current.startY);
        if (!current.dragging && Math.max(dx, dy) <= 5) return;
        current.dragging = true;
        current.latestX = me.clientX;
        me.preventDefault();
        applyDraggedTransform();

        // 只根据拖动标签的视觉中心与相邻标签中心线比较，不再用 elementFromPoint。
        // 这样拖动长标签时，即使它暂时覆盖了其他标签，也不会被自己的命中区域反复触发交换。
        const movementX = me.clientX - current.lastX;
        current.lastX = me.clientX;
        if (Math.abs(movementX) < 0.5) return;

        const draggedNode = document.querySelector<HTMLElement>(
          `[data-tab-id="${CSS.escape(current.tabId)}"]`,
        );
        if (!draggedNode) return;
        const draggedCenter =
          me.clientX - current.pointerOffsetX + draggedNode.offsetWidth / 2;
        const direction = movementX < 0 ? -1 : 1;

        setTabs((previous) => {
          const fromIndex = previous.findIndex(
            (tab) => tab.id === current.tabId,
          );
          const toIndex = fromIndex + direction;
          const targetTab = previous[toIndex];
          if (fromIndex === -1 || !targetTab || targetTab.id === current.tabId)
            return previous;

          const targetNode = document.querySelector<HTMLElement>(
            `[data-tab-id="${CSS.escape(targetTab.id)}"]`,
          );
          if (!targetNode) return previous;
          const targetCenter =
            getNaturalTabLeft(targetNode) + targetNode.offsetWidth / 2;
          const crossedTargetCenter =
            direction < 0
              ? draggedCenter <= targetCenter
              : draggedCenter >= targetCenter;
          if (!crossedTargetCenter) return previous;

          return reorderTabs(previous, fromIndex, toIndex);
        });
        // React 提交新顺序后，重新按新的自然位置计算偏移；否则长标签换位后
        // 旧 transform 会残留一帧，造成被拖标签短暂跳一下。
        applyDraggedTransform();
        requestAnimationFrame(applyDraggedTransform);
      };

      // pointermove 可能高于屏幕刷新率；每帧只处理最后一个位置，避免重复布局读写。
      const handleMove = (me: PointerEvent): void => {
        pendingMove = me;
        if (moveFrame !== null) return;
        moveFrame = requestAnimationFrame(() => {
          moveFrame = null;
          const latestMove = pendingMove;
          pendingMove = null;
          if (latestMove) processMove(latestMove);
        });
      };

      /** 让被拖标签回到自然位置（松手回落 / 中途取消共用） */
      const settleDraggedNode = (tabId: string): void => {
        const node = document.querySelector<HTMLElement>(
          `[data-tab-id="${CSS.escape(tabId)}"]`,
        );
        if (!node) return;
        node.style.transition =
          "transform 180ms cubic-bezier(0.22, 1, 0.36, 1)";
        node.style.transform = "translate3d(0, 0, 0)";
        node.style.willChange = "transform";
        if (dragSettleCleanupRef.current !== null)
          clearTimeout(dragSettleCleanupRef.current);
        dragSettleCleanupRef.current = setTimeout(() => {
          node.dataset.tabDragging = "";
          node.style.transition = "";
          node.style.transform = "";
          node.style.willChange = "";
          node.style.zIndex = "";
          dragSettleCleanupRef.current = null;
        }, 200);
      };

      const detachListeners = (): void => {
        document.removeEventListener("pointermove", handleMove);
        document.removeEventListener("pointerup", handleUp);
        document.removeEventListener("pointercancel", handleUp);
      };

      const handleUp = (): void => {
        detachListeners();
        sortCancelRef.current = null;
        if (moveFrame !== null) {
          cancelAnimationFrame(moveFrame);
          moveFrame = null;
        }
        // 松手前的最后一个 pointermove 仍需完成处理，避免鼠标刚越过中心线就松手时漏排一次。
        const latestMove = pendingMove;
        pendingMove = null;
        if (latestMove) processMove(latestMove);

        const current = dragState.current;
        if (current?.dragging) settleDraggedNode(current.tabId);
        dragState.current = null;
      };

      // 中途取消：排序已触发后合并手势接管时调用，避免两个手势同时生效。
      // 注意：已经发生的顺序调换不回滚（标签可能已移动一格），但不会再继续跟随指针。
      sortCancelRef.current = (): void => {
        detachListeners();
        sortCancelRef.current = null;
        if (moveFrame !== null) {
          cancelAnimationFrame(moveFrame);
          moveFrame = null;
        }
        pendingMove = null;
        const current = dragState.current;
        if (current?.dragging) settleDraggedNode(current.tabId);
        dragState.current = null;
      };

      document.addEventListener("pointermove", handleMove);
      document.addEventListener("pointerup", handleUp);
      document.addEventListener("pointercancel", handleUp);
    },
    [setTabs, tabs],
  );

  React.useEffect(() => {
    return () => {
      if (dragSettleCleanupRef.current !== null) {
        clearTimeout(dragSettleCleanupRef.current);
      }
    };
  }, []);

  if (contextTabs.length === 0)
    return (
      <div
        className="topbar-editorial relative tabbar-bg"
        style={{ height: TOPBAR_HEIGHT }}
      >
        <div
          className="topbar-drag-surface absolute inset-y-0 left-0 titlebar-drag-region"
          style={{ right: resolveWindowControlsRightInset(isWindows) }}
        />
      </div>
    );

  return (
    <>
      <TabBarInner
        tabs={contextTabs}
        activeTabId={activeTabId}
        streamingMap={indicatorMap}
        workspaceNameBySessionId={workspaceNameBySessionId}
        automationSessionIds={automationSessionIds}
        hasPluginPages={hasPluginPages}
        onActivate={handleActivate}
        onClose={requestClose}
        onDragStart={handleDragStart}
        onCancelSort={() => sortCancelRef.current?.()}
        teamMode={teamMode}
      />
    </>
  );
}

/** 内部组件：管理全局 hover 状态，确保同一时刻只有一个预览面板 */
function TabBarInner({
  tabs,
  activeTabId,
  streamingMap,
  workspaceNameBySessionId,
  automationSessionIds,
  hasPluginPages,
  onActivate,
  onClose,
  onDragStart,
  onCancelSort,
  teamMode,
}: {
  tabs: TabItem[];
  activeTabId: string | null;
  streamingMap: Map<string, SessionIndicatorStatus>;
  workspaceNameBySessionId: Map<string, string>;
  automationSessionIds: Set<string>;
  hasPluginPages: boolean;
  onActivate: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onDragStart: (tabId: string, e: React.PointerEvent) => void;
  /** 取消进行中的标签排序（合并手势中途接管时调用） */
  onCancelSort: () => void;
  teamMode: boolean;
}): React.ReactElement {
  const agentSessions = useAtomValue(agentSessionsAtom);
  const browserStateMap = useAtomValue(browserStateMapAtom);

  const [hoveredTabId, setHoveredTabId] = React.useState<string | null>(null);
  const store = useStore();
  const setTabMru = useSetAtom(tabMruAtom);
  const setTabs = useSetAtom(tabsAtom);
  const setAgentSessions = useSetAtom(agentSessionsAtom);
  const [isLeaving, setIsLeaving] = React.useState(false);
  const enterTimerRef = React.useRef<ReturnType<typeof setTimeout>>();
  const leaveTimerRef = React.useRef<ReturnType<typeof setTimeout>>();
  const fadeTimerRef = React.useRef<ReturnType<typeof setTimeout>>();
  const isWindows = React.useMemo(() => detectIsWindows(), []);

  // 文件面板切换（全局共享）：活动 Tab 是 Agent 且面板关闭时，在 TabBar 右上角展示"打开"按钮。
  // 操作区使用顶栏自身的真实布局列，不依赖右侧面板内部按钮的 margin 或定位。
  const [isPanelOpen, setSidePanelOpen] = useAtom(agentSidePanelOpenAtom);
  const filesVersion = useAtomValue(workspaceFilesVersionAtom);
  const seenFilesVersion = useAtomValue(seenFilesVersionAtom);
  const hasFileChanges = filesVersion > seenFilesVersion;
  const activeTab = React.useMemo(
    () => tabs.find((t) => t.id === activeTabId),
    [tabs, activeTabId],
  );
  const [tabGroups, setTabGroups] = useAtom(tabGroupsAtom);
  const activeGroup = findTabGroup(tabGroups, activeTabId);
  // 顶栏右侧工具是「会话上下文」动作，不是「会话 Tab」动作：
  // 预览/浏览器等工作 Tab 激活时，入口仍归口到其宿主会话，不能凭空消失。
  const activeSessionId = !activeTab
    ? null
    : (activeTab.type === 'chat' || activeTab.type === 'agent' || activeTab.type === 'preview' || activeTab.type === 'browser' || (activeTab.type === 'plugin' && activeTab.pluginScope === 'session'))
      ? activeTab.sessionId
      : null
  const activeAgentSessionId = !activeTab
    ? null
    : activeTab.type === "agent"
      ? activeTab.sessionId
      : (activeTab.type === "preview" || activeTab.type === "browser") &&
          agentSessions.some((session) => session.id === activeTab.sessionId)
        ? activeTab.sessionId
        : null;
  // 实际可见性（B = 展开意图 A && 窗口足够），由 usePanelAutoLayout 统一计算
  const visibility = useAtomValue(panelVisibilityAtom);
  const filePanelVisible = visibility.filePanel;
  // 文件栏开关跨会话保留；草稿/Chat 等非 Agent 标签不会实际渲染右侧栏，
  // 不能因此让 TabBar 隐藏窗口控制按钮或预留不存在的侧栏空间。
  const rightSidePanelIsVisible =
    filePanelVisible && activeTab?.type === "agent";
  const showOpenPanelButton = !filePanelVisible && activeAgentSessionId !== null;
  const filePanelForcedHidden = isPanelOpen && !filePanelVisible;
  // 受管浏览器入口：仅当当前标签是 Agent 会话时展示。主进程按会话隔离浏览器。
  const setBrowserStateMap = useSetAtom(browserStateMapAtom);
  // 每页一个浏览器 Tab 后「浏览器 Tab」是一组页：首个页 Tab 用于入口聚焦，
  // 「正在展示」指激活的本来就是该会话的浏览器页 Tab。
  const activeBrowserTab = activeAgentSessionId
    ? tabs.find((t) => t.type === "browser" && t.sessionId === activeAgentSessionId) ?? null
    : null;
  const activeIsSessionBrowserPage = activeTab?.type === "browser" && activeTab.sessionId === activeAgentSessionId;
  // 浏览器页 Tab 正在展示时收起入口；存在但未激活时高亮提示「浏览器还在后台运行」
  const showBrowserButton = Boolean(
    activeAgentSessionId && !activeIsSessionBrowserPage,
  );
  const browserBackgroundActive = Boolean(
    activeBrowserTab && !activeIsSessionBrowserPage,
  );
  // MainArea 的右边界会随着右侧文件面板提前结束；
  // 这种情况下窗口控制按钮已经不在当前 TabBar 内，工具组应贴近 MainArea 右缘。
  const hasRightSideContent = rightSidePanelIsVisible;
  // 窗口按钮和顶栏入口共用同一块弹性操作面板；窗口按钮被右侧面板接管时，
  // 面板只保留工具入口，不再预留固定的 132px 空洞。
  const showTabBarWindowControls =
    isWindows && !teamMode && !hasRightSideContent;
  const togglePanel = React.useCallback(() => {
    if (!activeAgentSessionId) return;
    if (isPanelOpen) {
      // A=true（可能被迫收起或可见）→ 点击取消展开意图
      setSidePanelOpen(false);
    } else {
      // A=false 手动收起 → 点击打开意图；窗口不足时仅不可见并 toast，A 保持 true
      openFilePanel();
      // 文件面板只渲染在 Agent 会话 Tab 旁（预览/浏览器 Tab 下不可见）；
      // 从工作 Tab 打开时同时切回宿主会话 Tab，否则「意图已开但看不到」像没反应。
      if (activeTab && activeTab.type !== "agent") {
        const ownerTab = tabs.find(
          (tab) => tab.type === "agent" && tab.sessionId === activeAgentSessionId,
        );
        if (ownerTab) onActivate(ownerTab.id);
      }
    }
  }, [activeAgentSessionId, isPanelOpen, setSidePanelOpen, activeTab, tabs, onActivate]);

  const openBrowser = React.useCallback(async () => {
    if (!activeAgentSessionId) return;
    const open = (window.electronAPI as Partial<typeof window.electronAPI>)
      .openAgentBrowser;
    if (typeof open !== "function") return;
    // 用户明确点击打开时，即使主进程刚热重启、前台所有权状态已丢失，也先同步声明当前会话。
    // 不能只依赖 MainArea 的会话切换 effect：当前 sessionId 未变化时它不会再次执行。
    const setForeground = (
      window.electronAPI as Partial<typeof window.electronAPI>
    ).setAgentBrowserForeground;
    if (typeof setForeground === "function")
      setForeground(activeAgentSessionId);
    const state = await open(activeAgentSessionId);
    setBrowserStateMap((previous) => {
      const next = new Map(previous);
      next.set(activeAgentSessionId, state);
      return next;
    });
    // Tab 化：创建/聚焦浏览器页 Tab 并清除“已手动关闭”标记（reconcile 以主进程状态为准）。
    openBrowserTabManually(activeAgentSessionId, state);
  }, [activeAgentSessionId, setBrowserStateMap]);

  // 浏览器图标在浏览器 Tab 未展示时出现：存在后台浏览器 Tab → 点击聚焦；不存在 → 打开。
  const toggleBrowser = React.useCallback(() => {
    if (!activeAgentSessionId) return;
    if (activeBrowserTab) {
      // 已有页 Tab：走统一激活路径（handleActivate 内含主进程激活页同步）
      onActivate(activeBrowserTab.id);
    } else {
      void openBrowser();
    }
  }, [activeAgentSessionId, activeBrowserTab, openBrowser, onActivate]);

  // ===== 组合 tab =====
  // 唯一创建入口是手势：把标签向下拖出标签栏，在主区左右投放区选位置。
  // 顶栏只在"已处于左右双栏"时提供一个解散按钮（常态不显示任何入口按钮）。
  const setTabGroupRatio = useSetAtom(tabGroupRatioAtom);
  const setTabGroupDrag = useSetAtom(tabGroupDragAtom);

  // 每个组合在顶栏的锚点：成员中在 tabsAtom 里靠前的那个，另一个折叠隐藏。
  const groupAnchorByMemberId = React.useMemo(() => {
    const result = new Map<string, string>();
    for (const group of tabGroups) {
      const present = groupTabIds(group)
        .map((id) => ({ id, index: tabs.findIndex((tab) => tab.id === id) }))
        .filter((entry) => entry.index >= 0)
        .sort((a, b) => a.index - b.index);
      const anchor = present[0]?.id;
      if (!anchor) continue;
      for (const memberId of groupTabIds(group)) result.set(memberId, anchor);
    }
    return result;
  }, [tabGroups, tabs]);

  const dissolveGroup = React.useCallback((group: ReturnType<typeof findTabGroup>) => {
    setTabGroups((previous) => removeTabGroup(previous, group));
  }, [setTabGroups]);

  // 关闭整组：两个标签都关闭（运行中的会话仍按既有语义保留在后台）
  const closeGroup = React.useCallback((group: ReturnType<typeof findTabGroup>) => {
    if (!group) return;
    setTabGroups((previous) => removeTabGroup(previous, group));
    for (const tabId of groupTabIds(group)) onClose(tabId);
  }, [onClose, setTabGroups]);

  const topBarTools: TopBarTool[] = [
    {
      id: "managed-browser",
      // 工具优先于标签：浏览器分栏压窄会话区时仍保留完整入口，标签区自行滚动压缩。
      visible: !teamMode && showBrowserButton,
      label: "打开受管浏览器",
      tooltip: "打开受管浏览器",
      icon: <Globe2 className="size-3.5" />,
      onClick: toggleBrowser,
      // 浏览器 Tab 存在但未激活：高亮提示浏览器还在后台
      highlighted: browserBackgroundActive,
    },
    {
      id: "file-panel",
      visible: !teamMode && showOpenPanelButton,
      label: "打开文件面板",
      tooltip: `打开文件面板 (${navigator.platform.includes("Mac") ? "⌘⇧B" : "Ctrl+Shift+B"})`,
      icon: <PanelRight className="size-3.5" />,
      onClick: togglePanel,
      highlighted: filePanelForcedHidden,
      badge: hasFileChanges ? (
        <span className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-primary animate-pulse" />
      ) : undefined,
    },
    {
      id: "plugin-pages",
      visible: !teamMode && activeSessionId !== null && hasPluginPages,
      label: "打开插件页面",
      tooltip: "打开插件页面",
      icon: <Blocks className="size-3.5" />,
      onClick: () => undefined,
    },
    {
      id: "tab-group",
      // 只在左右双栏（组合）状态下出现：常态不提供入口按钮，创建入口只有"把标签向下拖"手势。
      visible: !teamMode && !!activeGroup,
      label: "解散组合",
      tooltip: "解散当前组合（两个标签都保留）",
      icon: <Ungroup className="size-3.5" />,
      onClick: () => dissolveGroup(activeGroup),
    },
  ];
  React.useEffect(() => {
    return registerShortcut("toggle-right-panel", togglePanel);
  }, [togglePanel]);

  // 滚动容器 ref
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const topbarContentRef = React.useRef<HTMLDivElement>(null);
  const visibleTopBarToolIds = topBarTools
    .filter((tool) => tool.visible)
    .map((tool) => tool.id)
    .join("|");

  // 右侧控件是独立浮层；滚动区只预留它的实际宽度，避免两个矩形布局盒硬拼接。
  React.useLayoutEffect(() => {
    const content = topbarContentRef.current;
    if (!content) return;

    const updateActionsWidth = (): void => {
      const actions = content.querySelector<HTMLElement>(".topbar-actions-slot");
      if (!actions) {
        content.style.removeProperty("--topbar-actions-width");
        return;
      }
      content.style.setProperty("--topbar-actions-width", `${actions.offsetWidth}px`);
    };

    updateActionsWidth();
    const observer = new ResizeObserver(updateActionsWidth);
    observer.observe(content);
    const actions = content.querySelector<HTMLElement>(".topbar-actions-slot");
    if (actions) observer.observe(actions);
    return () => observer.disconnect();
  }, [visibleTopBarToolIds, showTabBarWindowControls]);

  // Tab ??????????????????????????????
  // ????????????? flex-shrink ????????
  type TabCompressionLevel = "full" | "title-only";
  const [tabCompressionLevel, setTabCompressionLevel] =
    React.useState<TabCompressionLevel>("full");
  const fullTabsWidthRef = React.useRef<number | null>(null);
  const tabLayoutKey = tabs
    .map((tab) => `${tab.id}:${tab.type}:${tab.title}`)
    .join("|");

  React.useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const measure = (): void => {
      const availableWidth = el.clientWidth + 2;

      if (tabCompressionLevel === "full") {
        fullTabsWidthRef.current = el.scrollWidth;
        if (el.scrollWidth > availableWidth) {
          setTabCompressionLevel("title-only");
        } else if (el.scrollLeft !== 0) {
          // 内容恢复到单行可见时清除旧的横向滚动位置，避免左端留下无法解释的空白。
          el.scrollLeft = 0;
        }
        return;
      }

      // ??????????????????????????
      if (
        fullTabsWidthRef.current !== null &&
        availableWidth >= fullTabsWidthRef.current
      ) {
        setTabCompressionLevel("full");
      }
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [tabLayoutKey, tabCompressionLevel]);

  // ?? TabBar ?? ref????? tear-off ????????? TabBar ??
  const barRef = React.useRef<HTMLDivElement>(null);

  // 拖出 TabBar 区域时给出视觉提示（仅 preview Tab 可 tear-off）
  const [tearingOff, setTearingOff] = React.useState<string | null>(null);

  /** 落定前需要在标签栏下方越过的距离，避免一次潦草的纵向拖动就误合并 */
  const GROUP_DROP_COMMIT_MARGIN = 8;

  /**
   * 合并手势：把标签向下拖出标签栏，在主区左右投放区里选位置。
   *
   * 关键：合并与标签排序共用同一次 pointerdown，而排序逻辑按 max(|dx|,|dy|) > 5 起手，
   * 所以必须在这里做**轴向判定**——首次位移超阈值时，纵向（向下）→ 合并手势，
   * 横向 → 交回原有排序，本函数此后不再介入。否则向下拖会先被排序接管，
   * 合并永远触发不了（表现为"只有顶栏按钮生效"）。
   */
  const handleGroupTabDrag = React.useCallback(
    (tabId: string, e: React.PointerEvent): void => {
      if (e.button !== 0) return;
      const startX = e.clientX;
      const startY = e.clientY;
      let mode: "pending" | "group" | "sorting" = "pending";
      let hoveredSide: TabGroupSide | null = null;
      let committable = false;

      const clearDropState = (): void => {
        hoveredSide = null;
        committable = false;
        setTabGroupDrag({ draggingTabId: null, hoveredPosition: null });
      };

      const handleMove = (me: PointerEvent): void => {
        const dx = me.clientX - startX;
        const dy = me.clientY - startY;

        if (mode === "pending") {
          if (Math.abs(dx) <= 5 && Math.abs(dy) <= 5) return;
          // 轴向判定：纵向起步 → 合并手势；横向 → 交回排序。
          if (Math.abs(dy) > Math.abs(dx) && dy > 0) {
            mode = "group";
            // 复用高亮反馈：让用户知道这个标签已被"拿起来"
            setTearingOff(tabId);
          } else {
            mode = "sorting";
            onDragStart(tabId, e);
            return;
          }
        }

        const barRect = barRef.current?.getBoundingClientRect();
        if (!barRect) return;
        // 主区把容器坐标发布在 data-group-drop-region 上；不允许组合的视图（规划中心 /
        // Agent 技能页）没有该节点，因此不会出现无效果的投放区。
        const region = document.querySelector<HTMLElement>("[data-group-drop-region]");
        const regionRect = region?.getBoundingClientRect() ?? null;
        const insideRegion =
          !!regionRect &&
          me.clientY >= barRect.bottom &&
          me.clientY <= regionRect.bottom &&
          me.clientX >= regionRect.left &&
          me.clientX <= regionRect.right;

        if (!regionRect) return;

        // 已经进入排序后仍允许"改主意"：指针落到标签栏下方主区 → 取消排序，改为合并手势。
        // 否则横向一动就会被排序占住，再也下拉不到投放区。
        if (mode === "sorting") {
          if (!insideRegion) return;
          mode = "group";
          onCancelSort();
          setTearingOff(tabId);
        }

        if (!insideRegion) {
          if (hoveredSide) clearDropState();
          return;
        }

        // 左右落点以真实分界线为准（由 MainArea 发布在 data-group-drop-split 上）：
        // 比例拖过、或空栏只占 1/3 时，容器中点与两栏实际边界并不重合。
        const splitOffset = Number(region?.dataset.groupDropSplit ?? "");
        const splitX = regionRect.left + (Number.isFinite(splitOffset) ? splitOffset : regionRect.width / 2);
        hoveredSide = me.clientX < splitX ? "left" : "right";
        committable = me.clientY >= barRect.bottom + GROUP_DROP_COMMIT_MARGIN;
        setTabGroupDrag({ draggingTabId: tabId, hoveredPosition: hoveredSide });
      };

      const handleUp = (): void => {
        document.removeEventListener("pointermove", handleMove);
        document.removeEventListener("pointerup", handleUp);
        document.removeEventListener("pointercancel", handleUp);
        setTearingOff(null);

        const side = committable ? hoveredSide : null;
        clearDropState();
        if (mode !== "group" || !side) return;

        // 落定规则集中在 planGroupDrop（纯函数，已单测），此处只负责写状态。
        const groups = store.get(tabGroupsAtom);
        const currentActiveTabId = store.get(activeTabIdAtom);
        const currentGroup = findTabGroup(groups, currentActiveTabId);
        const plan = planGroupDrop({
          group: currentGroup,
          activeTabId: currentActiveTabId,
          draggedTabId: tabId,
          position: side,
        });
        if (!plan) return;
        store.set(tabGroupsAtom, replaceTabGroup(groups, currentGroup, plan.group));
        store.set(activeTabIdAtom, plan.activeTabId);
        // 空栏给一个较小的初始占比；之后用户可以自由拖分栏缝
        const emptySide = emptyGroupSide(plan.group);
        if (emptySide) setTabGroupRatio(ratioForEmptySide(emptySide));
        setTabMru((previous) => promoteMru(previous, plan.activeTabId));
      };

      document.addEventListener("pointermove", handleMove);
      document.addEventListener("pointerup", handleUp);
      document.addEventListener("pointercancel", handleUp);
    },
    [onCancelSort, onDragStart, setTabGroupDrag, setTabGroupRatio, setTabMru],
  );

  /**
   * 标签拖拽入口：可组合的标签统一交给合并手势，落点决定结果。
   * 落入投放区 → 组合；没落入 → 取消。并排分屏统一由组合承担，不再有 tear-off 回落。
   */
  const handleDragStartWithTearOff = React.useCallback(
    (tabId: string, e: React.PointerEvent) => {
      const tab = tabs.find((t) => t.id === tabId);
      if (!tab) {
        onDragStart(tabId, e);
        return;
      }
      if (isGroupEligibleTab(tab)) {
        handleGroupTabDrag(tabId, e);
        return;
      }
      onDragStart(tabId, e);
    },
    [tabs, onDragStart, handleGroupTabDrag],
  );

  // 鼠标滚轮横向滚动（使用原生事件监听器以支持 preventDefault）
  React.useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      el.scrollLeft += e.deltaY || e.deltaX;
    };

    el.addEventListener("wheel", handleWheel, { passive: false });
    return () => el.removeEventListener("wheel", handleWheel);
  }, []);

  // FLIP：标签顺序变化后，从当前视觉位置平滑过渡到新位置，而不是被 Flex 布局瞬移。
  // 每次连续交换都先读取上一段动画的当前位置，避免快速拖动时动画重新跳起。
  const tabRectsRef = React.useRef(new Map<string, DOMRect>());
  const tabAnimationFrameRef = React.useRef<number | null>(null);
  const tabAnimationCleanupRef = React.useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  useLayoutEffect(() => {
    const tabNodes = Array.from(
      scrollRef.current?.querySelectorAll<HTMLElement>("[data-tab-id]") ?? [],
    );
    const hasPreviousLayout = tabRectsRef.current.size > 0;
    const previousRects = new Map<string, DOMRect>();

    // getBoundingClientRect 会包含当前 transform，正好可以作为连续动画的真实起点。
    if (hasPreviousLayout) {
      for (const node of tabNodes) {
        const id = node.dataset.tabId;
        const isDragged = node.dataset.tabDragging === "true";
        if (id && !isDragged)
          previousRects.set(id, node.getBoundingClientRect());
        if (!isDragged) {
          node.style.transition = "none";
          node.style.transform = "none";
        }
      }
      // 清除旧 transform 后强制布局，读取这次数组顺序对应的自然位置。
      void scrollRef.current?.offsetWidth;
    }

    const nextRects = new Map<string, DOMRect>();
    for (const node of tabNodes) {
      const id = node.dataset.tabId;
      if (id) nextRects.set(id, node.getBoundingClientRect());
    }

    if (hasPreviousLayout) {
      let hasMovement = false;
      for (const node of tabNodes) {
        const id = node.dataset.tabId;
        if (node.dataset.tabDragging === "true") continue;
        const previous = id ? previousRects.get(id) : undefined;
        const next = id ? nextRects.get(id) : undefined;
        if (!previous || !next) continue;

        const dx = previous.left - next.left;
        const dy = previous.top - next.top;
        if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
        hasMovement = true;

        node.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
        node.style.willChange = "transform";
      }

      if (hasMovement) {
        if (tabAnimationFrameRef.current !== null) {
          cancelAnimationFrame(tabAnimationFrameRef.current);
        }
        if (tabAnimationCleanupRef.current !== null) {
          clearTimeout(tabAnimationCleanupRef.current);
        }
        tabAnimationFrameRef.current = requestAnimationFrame(() => {
          for (const node of tabNodes) {
            if (node.dataset.tabDragging === "true") continue;
            node.style.transition = "transform 340ms ease-out";
            node.style.transform = "translate3d(0, 0, 0)";
          }
          tabAnimationFrameRef.current = null;
          tabAnimationCleanupRef.current = setTimeout(() => {
            for (const node of tabNodes) {
              if (node.dataset.tabDragging === "true") continue;
              node.style.transition = "";
              node.style.transform = "";
              node.style.willChange = "";
            }
            tabAnimationCleanupRef.current = null;
          }, 360);
        });
      }
    }

    tabRectsRef.current = nextRects;
  }, [tabs]);

  React.useEffect(() => {
    return () => {
      if (tabAnimationFrameRef.current !== null) {
        cancelAnimationFrame(tabAnimationFrameRef.current);
      }
      if (tabAnimationCleanupRef.current !== null) {
        clearTimeout(tabAnimationCleanupRef.current);
      }
    };
  }, []);

  // 新增 tab 时自动滚动到最右；其他布局变化回到左端，避免旧 scrollLeft 把首个 Tab 裁掉。
  const prevTabCount = React.useRef(tabs.length);
  const prevTabLayoutKey = React.useRef(tabLayoutKey);
  React.useLayoutEffect(() => {
    const el = scrollRef.current;
    const layoutChanged = prevTabLayoutKey.current !== tabLayoutKey;
    if (el && tabs.length > prevTabCount.current) {
      el.scrollTo({ left: el.scrollWidth, behavior: "smooth" });
    } else if (el && layoutChanged) {
      el.scrollLeft = 0;
    }
    prevTabCount.current = tabs.length;
    prevTabLayoutKey.current = tabLayoutKey;
  }, [tabLayoutKey, tabs.length]);

  React.useEffect(() => {
    return () => {
      if (enterTimerRef.current) clearTimeout(enterTimerRef.current);
      if (leaveTimerRef.current) clearTimeout(leaveTimerRef.current);
      if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current);
    };
  }, []);

  const handleRenameAgentSession = React.useCallback(
    async (sessionId: string, title: string) => {
      try {
        const updated = await window.electronAPI.updateAgentSessionTitle(
          sessionId,
          title,
        );
        setTabs((previous) =>
          updateTabTitle(previous, updated.id, updated.title),
        );
        setAgentSessions((previous) =>
          replaceAgentSessionInFreshnessOrder(previous, updated),
        );
      } catch (error) {
        console.error("[TabBar] 更新 Agent 会话标题失败:", error);
        toast.error("会话重命名失败，请重试");
        throw error;
      }
    },
    [setAgentSessions, setTabs],
  );

  const handleTabHoverEnter = React.useCallback(
    (tabId: string) => {
      if (leaveTimerRef.current) clearTimeout(leaveTimerRef.current);
      if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current);
      if (enterTimerRef.current) clearTimeout(enterTimerRef.current);
      setIsLeaving(false);

      // 如果已经有面板打开（从一个 Tab 滑到另一个），立即切换
      if (hoveredTabId) {
        setHoveredTabId(tabId);
      } else {
        // 首次 hover，延迟 300ms
        enterTimerRef.current = setTimeout(() => setHoveredTabId(tabId), 300);
      }
    },
    [hoveredTabId],
  );

  const handleTabHoverLeave = React.useCallback(() => {
    if (enterTimerRef.current) clearTimeout(enterTimerRef.current);
    leaveTimerRef.current = setTimeout(() => {
      setIsLeaving(true);
      fadeTimerRef.current = setTimeout(() => {
        setHoveredTabId(null);
        setIsLeaving(false);
      }, 80);
    }, 200);
  }, []);

  // 面板的 hover 进入（阻止关闭）
  const handlePanelHoverEnter = React.useCallback(() => {
    if (leaveTimerRef.current) clearTimeout(leaveTimerRef.current);
    if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current);
    setIsLeaving(false);
  }, []);

  return (
    <div
      ref={barRef}
      className="topbar-editorial relative tabbar-bg"
      style={{ height: TOPBAR_HEIGHT }}
    >
      {/* 顶栏不整条声明 drag：Tab、工具组、窗口按钮都是 no-drag，整条 drag 只能靠
          从大矩形里扣除小块矩形来放行交互，正是 Windows 高 DPI 点击失效的成因。
          这里改为单一拖拽层，并在右侧操作胶囊左缘精确结束（见 .topbar-drag-surface）。 */}

      {tearingOff && (
        <div className="pointer-events-none absolute -bottom-px left-0 right-0 h-px bg-primary/60 shadow-[0_0_8px_rgba(0,0,0,0.2)]" />
      )}

      {/* 40px 外框中的 37px 内容行；偏移取整数（见 TOPBAR_CONTENT_OFFSET），
          Tab viewport 与右侧控件独立，避免两者共享直角接缝。 */}
      <div
        ref={topbarContentRef}
        className="topbar-content absolute inset-x-0 z-10"
        style={{ top: TOPBAR_CONTENT_OFFSET, height: TOPBAR_CONTENT_HEIGHT }}
      >
        <div className="topbar-drag-surface absolute inset-y-0 left-0 titlebar-drag-region" />

        <div className="topbar-tabs-viewport absolute inset-0 overflow-hidden rounded-r-full">
          <div
            ref={scrollRef}
            className="topbar-tabs-scroll flex min-w-0 items-center gap-1 overflow-x-auto pl-2 pr-1 scrollbar-none"
            style={{ height: TOPBAR_CONTENT_HEIGHT }}
          >
            {tabs.map((tab) => {
              // 每个组合的两个成员在顶栏折叠成一个条目：跳过另一个成员，
              // 在锚点（列表中靠前的那个成员）位置渲染组合条目。
              const tabGroup = findTabGroup(tabGroups, tab.id);
              const groupAnchorTabId = groupAnchorByMemberId.get(tab.id);
              if (tabGroup && groupAnchorTabId) {
                if (tab.id !== groupAnchorTabId) return null;
                const leftTab = tabGroup.leftTabId
                  ? tabs.find((item) => item.id === tabGroup.leftTabId) ?? null
                  : null;
                const rightTab = tabGroup.rightTabId
                  ? tabs.find((item) => item.id === tabGroup.rightTabId) ?? null
                  : null;
                if (leftTab || rightTab) {
                  return (
                    <TabGroupItem
                      key={tab.id}
                      id={tab.id}
                      leftTitle={leftTab?.title ?? null}
                      rightTitle={rightTab?.title ?? null}
                      leftStatus={leftTab ? streamingMap.get(leftTab.id) ?? "idle" : "idle"}
                      rightStatus={rightTab ? streamingMap.get(rightTab.id) ?? "idle" : "idle"}
                      isActive={isGroupActive(tabGroup, activeTabId)}
                      focusedSide={rightTab && activeTabId === rightTab.id ? "right" : "left"}
                      onActivate={() => onActivate(tabGroup.focusedTabId)}
                      onDissolve={() => dissolveGroup(tabGroup)}
                      onMiddleClick={() => dissolveGroup(tabGroup)}
                      onCloseGroup={() => closeGroup(tabGroup)}
                      onDragStart={(e) => handleDragStartWithTearOff(tab.id, e)}
                      onHoverEnter={() => handleTabHoverEnter(tab.id)}
                      onHoverLeave={handleTabHoverLeave}
                    />
                  );
                }
              }

              return (
              <TabBarItem
                key={tab.id}
                id={tab.id}
                type={tab.type}
                title={tab.title}
                workspaceName={
                  tab.type === "agent"
                    ? workspaceNameBySessionId.get(tab.sessionId)
                    : undefined
                }
                hideWorkspaceName={tabCompressionLevel === "title-only"}
                hideRenameControl={tabCompressionLevel === "title-only"}
                isAutomation={
                  tab.type === "agent" && automationSessionIds.has(tab.sessionId)
                }
                childKind={
                  tab.type === "agent"
                    ? agentSessions.find((session) => session.id === tab.sessionId)?.explorationParentSessionId
                      ? "exploration"
                      : tab.parentSessionId
                        ? "delegation"
                        : undefined
                    : undefined
                }
                agentOwned={
                  tab.type === "browser" && !!tab.browserTabId
                    ? browserStateMap.get(tab.sessionId)?.tabs.find((page) => page.tabId === tab.browserTabId)?.openedByAgent
                    : undefined
                }
                onRename={
                  tab.type === "agent"
                    ? (title) => handleRenameAgentSession(tab.sessionId, title)
                    : undefined
                }
                isActive={tab.id === activeTabId}
                isStreaming={streamingMap.get(tab.id) ?? "idle"}
                isHovered={hoveredTabId === tab.id}
                isLeaving={hoveredTabId === tab.id && isLeaving}
                isTearingOff={tearingOff === tab.id}
                onActivate={() => onActivate(tab.id)}
                onClose={() => onClose(tab.id)}
                onMiddleClick={() => onClose(tab.id)}
                onDragStart={(e) => handleDragStartWithTearOff(tab.id, e)}
                onHoverEnter={() => handleTabHoverEnter(tab.id)}
                onHoverLeave={handleTabHoverLeave}
                onPanelHoverEnter={handlePanelHoverEnter}
                onPanelHoverLeave={handleTabHoverLeave}
              />
              );
            })}
          </div>
        </div>

        <TopBarActions
          tools={topBarTools}
          showWindowControls={showTabBarWindowControls}
        >
          <WindowControlsHost
            id="tab-bar"
            active={showTabBarWindowControls}
            priority={10}
            className="shrink-0"
          />
        </TopBarActions>
      </div>
    </div>
  );
}

interface TopBarTool {
  id: string;
  visible: boolean;
  label: string;
  tooltip: string;
  icon: React.ReactNode;
  onClick: () => void;
  badge?: React.ReactNode;
  /** 被迫收起（有展开意图但窗口不足）：图标显示为 hover 态高亮，提示存在展开意图 */
  highlighted?: boolean;
}

/** 顶栏右侧操作插槽：内容参与 Grid 布局，并由插槽本体绘制胶囊背景。 */
function TopBarActions({
  tools,
  showWindowControls,
  children,
}: {
  tools: TopBarTool[];
  showWindowControls: boolean;
  children: React.ReactNode;
}): React.ReactElement | null {
  const visibleTools = tools.filter((tool) => tool.visible);
  if (visibleTools.length === 0 && !showWindowControls) return null;

  return (
    <div className="topbar-actions-slot relative z-20 flex items-center gap-1 titlebar-no-drag">
      {visibleTools.length > 0 && (
        <div
          className="topbar-tool-group relative z-10 flex h-[31px] items-center gap-0.5"
          role="toolbar"
          aria-label="顶栏工具"
        >
          {visibleTools.map((tool) => tool.id === "plugin-pages"
            ? <PluginTopBarEntries key={tool.id} />
            : (
              <Tooltip key={tool.id}>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className={cn(
                      "topbar-tool-button relative z-20 h-8 w-8",
                      tool.highlighted &&
                        "topbar-tool-button-highlighted text-accent-foreground",
                    )}
                    aria-label={tool.label}
                    onClick={tool.onClick}
                  >
                    {tool.icon}
                    {tool.badge}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  <p>{tool.tooltip}</p>
                </TooltipContent>
              </Tooltip>
            ))}
        </div>
      )}
      {showWindowControls && children}
    </div>
  );
}
