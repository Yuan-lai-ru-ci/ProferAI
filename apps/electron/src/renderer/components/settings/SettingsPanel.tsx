/**
 * SettingsPanel - 设置面板
 *
 * 顶部 Header（标题 + 关闭按钮）+ 下方（左侧导航 + 右侧 ScrollArea 内容区域）。
 * 使用 Jotai atom 管理当前标签页状态。
 */

import * as React from "react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { cn } from "@/lib/utils";
import {
  Settings,
  Radio,
  Palette,
  Info,
  Plug,
  BookOpen,
  Wrench,
  Bot,
  GraduationCap,
  X,
  Keyboard,
  Mic,
  Users,
  Coins,
  CreditCard,
  KeyRound,
  Database,
  Network,
  MonitorSmartphone,
  } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { settingsTabAtom, channelFormDirtyAtom, settingsCloseRequestedAtom, settingsOpenAtom } from "@/atoms/settings-tab";
import type { SettingsTab } from "@/atoms/settings-tab";
import { appModeAtom } from "@/atoms/app-mode";
import { authStatusAtom } from "@/atoms/identity-atoms";
import { hasUpdateAtom } from "@/atoms/updater";
import { tabsAtom, activeTabIdAtom, openTab, TUTORIAL_TAB_ID } from "@/atoms/tab-atoms";
import { hasEnvironmentIssuesAtom } from "@/atoms/environment";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ChannelSettings } from "./ChannelSettings";
import { GeneralSettings } from "./GeneralSettings";
import { AppearanceSettings } from "./AppearanceSettings";
import { AboutSettings } from "./AboutSettings";
import { AgentSettings } from "./AgentSettings";
import { PromptSettings } from "./PromptSettings";
import { ToolSettings } from "./ToolSettings";
import { BotHubSettings } from "./BotHubSettings";
import { ShortcutSettings } from "./ShortcutSettings";
import { VoiceInputSettings } from "./VoiceInputSettings";
import { DataManagementSettings } from "./DataManagementSettings";
import { TeamWorkspaceSettings } from "./TeamWorkspaceSettings";
import { CreditsSettings } from "./CreditsSettings";
import { SubscriptionSettings } from "./SubscriptionSettings";
import { TabletConnectionSettings } from "./TabletConnectionSettings";
import { TabletNotificationSettings } from "./TabletNotificationSettings";
import { OpenApiSettings } from "./OpenApiSettings";
import { ProxySettings } from "./ProxySettings";
import { DevicesSettings } from "./DevicesSettings";

/** 设置 Tab 定义 */
export interface SettingsTabItem {
  id: SettingsTab;
  label: string;
  icon: React.ReactNode;
}

/** 导航分组：标题 + 该分组内的 tab */
export interface SettingsTabGroup {
  /** 分组标题；为空则不渲染分组标题（用于不带标题的起始组） */
  title?: string;
  items: SettingsTabItem[];
}

/** 账户相关：额度 / 订阅 / 开放 API（位于导航顶部「账户」分组） */
const ACCOUNT_GROUP_ITEMS: SettingsTabItem[] = [
  { id: "credits", label: "额度与用量", icon: <Coins size={16} /> },
  { id: "subscription", label: "立即订阅", icon: <CreditCard size={16} /> },
  { id: "openapi", label: "开放 API", icon: <KeyRound size={16} /> },
];

/** 模型与能力：渠道 / Agent / 提示词 / Chat 工具 */
const MODEL_GROUP_ITEMS: SettingsTabItem[] = [
  { id: "channels", label: "模型配置", icon: <Radio size={16} /> },
  { id: "tools", label: "Chat 工具", icon: <Wrench size={16} /> },
  { id: "prompts", label: "提示词管理", icon: <BookOpen size={16} /> },
];

/** Agent 模式专属 Tab */
const AGENT_TAB: SettingsTabItem = {
  id: "agent",
  label: "Agent 配置",
  icon: <Plug size={16} />,
};

/** 体验：外观 / 语音 / 快捷键 / 教程 */
const EXPERIENCE_GROUP_ITEMS: SettingsTabItem[] = [
  { id: "appearance", label: "外观设置", icon: <Palette size={16} /> },
  { id: "voice-input", label: "语音输入", icon: <Mic size={16} /> },
  { id: "shortcuts", label: "快捷键管理", icon: <Keyboard size={16} /> },
  { id: "tutorial", label: "Profer 教程", icon: <GraduationCap size={16} /> },
];

/** 连接：远程连接 / 代理 / 登录设备 */
const CONNECTION_GROUP_ITEMS: SettingsTabItem[] = [
  { id: "bots", label: "远程连接", icon: <Bot size={16} /> },
  { id: "proxy", label: "代理设置", icon: <Network size={16} /> },
  { id: "devices", label: "登录设备", icon: <MonitorSmartphone size={16} /> },
];

/** 系统：数据管理 / 团队 / 关于 */
const SYSTEM_GROUP_ITEMS: SettingsTabItem[] = [
  { id: "data-management", label: "数据管理", icon: <Database size={16} /> },
  { id: "team", label: "团队管理", icon: <Users size={16} /> },
  { id: "about", label: "关于/更新", icon: <Info size={16} /> },
];

/** 依赖团队账号登录的 Tab（未登录时不展示） */
const ACCOUNT_TABS: ReadonlySet<SettingsTab> = new Set([
  "team",
  "credits",
  "subscription",
  "openapi",
  "devices",
]);

/** 根据标签页 id 渲染对应内容 */
function renderTabContent(tab: SettingsTab, tabletMode = false): React.ReactElement {
  switch (tab) {
    case "general":
      return <GeneralSettings />;
    case "channels":
      return <ChannelSettings />;
    case "prompts":
      return <PromptSettings />;
    case "agent":
      return <AgentSettings />;
    case "tools":
      return <ToolSettings />;
    case "appearance":
      // 平板（tabsOverride 非空）：界面大小裁剪到 150%、隐藏 Agent 预览展开方式（功能不可用）
      return <AppearanceSettings tabletMode={tabletMode} />;
    case "connection":
      return <TabletConnectionSettings />;
    case "notifications":
      return <TabletNotificationSettings />;
    case "about":
      return <AboutSettings />;
    case "bots":
      return <BotHubSettings />;
    case "shortcuts":
      return <ShortcutSettings />;
    case "voice-input":
      return <VoiceInputSettings />;
    case "data-management":
      return <DataManagementSettings />;
    case "team":
      return <TeamWorkspaceSettings />;
    case "credits":
      return <CreditsSettings />;
    case "subscription":
      return <SubscriptionSettings />;
    case "openapi":
      return <OpenApiSettings />;
    case "proxy":
      return <ProxySettings />;
    case "devices":
      return <DevicesSettings />;
    default:
      // tutorial 等特殊 tab 由 handleTabChange 拦截打开主区 Tab，不会在此渲染
      return <GeneralSettings />;
  }
}

interface SettingsPanelProps {
  onClose?: () => void;
  /** 受限环境（如平板）传入的 tab 白名单；不传时按 appMode 推导完整列表 */
  tabsOverride?: SettingsTabItem[];
}

export function SettingsPanel({
  onClose,
  tabsOverride,
}: SettingsPanelProps): React.ReactElement {
  const [activeTab, setActiveTab] = useAtom(settingsTabAtom);
  const channelFormDirty = useAtomValue(channelFormDirtyAtom);
  const [closeRequested, setCloseRequested] = useAtom(settingsCloseRequestedAtom);
  const setSettingsOpen = useSetAtom(settingsOpenAtom);
  const appMode = useAtomValue(appModeAtom);
  const hasUpdate = useAtomValue(hasUpdateAtom);
  const hasEnvironmentIssues = useAtomValue(hasEnvironmentIssuesAtom);
  const [mainTabs, setMainTabs] = useAtom(tabsAtom);
  const setMainActiveTabId = useSetAtom(activeTabIdAtom);
  const authStatus = useAtomValue(authStatusAtom);

  /** 统一的退出拦截对话框状态 */
  type PendingAction = { type: 'tab'; tabId: SettingsTab } | { type: 'close' } | null
  const [pendingAction, setPendingAction] = React.useState<PendingAction>(null)
  const showNavDialog = pendingAction !== null

  /** 执行待处理的操作 */
  const executePendingAction = (): void => {
    if (!pendingAction) return
    if (pendingAction.type === 'tab') {
      setActiveTab(pendingAction.tabId)
    } else {
      onClose?.()
    }
    setPendingAction(null)
  }

  /** 取消待处理的操作 */
  const cancelPendingAction = (): void => {
    setPendingAction(null)
  }

  // 受限环境（平板）传入白名单时直接使用（无分组标题）；否则按语义分组组装导航。
  // 未登录时过滤掉依赖团队账号的 Tab（额度 / 订阅 / 开放 API / 团队管理 / 登录设备）。
  const groups = React.useMemo<SettingsTabGroup[]>(() => {
    if (tabsOverride) {
      return [{ items: tabsOverride }]
    }

    const modelItems = appMode === "agent"
      ? [...MODEL_GROUP_ITEMS, AGENT_TAB]
      : MODEL_GROUP_ITEMS

    const allGroups: SettingsTabGroup[] = [
      // 首个无标题组：「通用设置」入口（用户档案 + 账户登录 + 通用偏好），不属于任何分组
      { items: [{ id: "general", label: "通用设置", icon: <Settings size={16} /> }] },
      { title: "账户", items: ACCOUNT_GROUP_ITEMS },
      { title: "模型", items: modelItems },
      { title: "体验", items: EXPERIENCE_GROUP_ITEMS },
      { title: "连接", items: CONNECTION_GROUP_ITEMS },
      { title: "系统", items: SYSTEM_GROUP_ITEMS },
    ]

    if (authStatus.isLoggedIn) return allGroups

    // 未登录：过滤 ACCOUNT_TABS，并清理空分组
    return allGroups
      .map((g) => ({ ...g, items: g.items.filter((t) => !ACCOUNT_TABS.has(t.id)) }))
      .filter((g) => g.items.length > 0)
  }, [appMode, tabsOverride, authStatus.isLoggedIn]);

  // 将所有可见 tab 拍平成列表，用于 activeTab 回落与标题查找
  const tabs: SettingsTabItem[] = React.useMemo(
    () => groups.flatMap((g) => g.items),
    [groups]
  );

  // 统一回落：activeTab 不在当前可见列表（平板白名单 / 未登录过滤）时回落到首项，
  // 避免渲染未暴露的设置页（如登录/订阅/团队管理）。
  // tabs 为空数组（tabsOverride 传空）时整体不渲染，避免解引用崩溃。
  if (tabs.length === 0) return <div className="flex flex-col h-full items-center justify-center text-sm text-muted-foreground">没有可用的设置项</div>
  const effectiveTab: SettingsTab = tabs.some((t) => t.id === activeTab) ? activeTab : tabs[0]!.id

  /** 切换标签页时检测是否有未保存内容，tutorial 特殊处理：打开 New Tab 并关闭设置 */
  const handleTabChange = (tabId: SettingsTab): void => {
    if (tabId === 'tutorial') {
      const result = openTab(mainTabs, { type: 'tutorial', sessionId: TUTORIAL_TAB_ID, title: 'Profer 使用教程' })
      setMainTabs(result.tabs)
      setMainActiveTabId(result.activeTabId)
      setSettingsOpen(false)
      return
    }
    if (tabId === effectiveTab) return
    if (effectiveTab === 'channels' && channelFormDirty) {
      setPendingAction({ type: 'tab', tabId })
      return
    }
    setActiveTab(tabId)
  }

  /** 关闭设置面板时检测是否有未保存内容 */
  const handleClose = (): void => {
    if (effectiveTab === 'channels' && channelFormDirty) {
      setPendingAction({ type: 'close' })
      return
    }
    onClose?.()
  }

  // Cmd+W 等外部关闭请求：弹出确认对话框
  React.useEffect(() => {
    if (closeRequested && effectiveTab === 'channels') {
      setPendingAction({ type: 'close' })
      setCloseRequested(false)
    }
  }, [closeRequested, effectiveTab, setCloseRequested])

  // 当前 tab 标题
  const activeTabLabel = tabs.find((t) => t.id === effectiveTab)?.label ?? "设置";

  return (
    <div className="flex flex-col h-full">
      {/* 顶部 Header 栏 */}
      <div className="h-12 flex items-center justify-between px-5 border-b border-border/50 flex-shrink-0">
        <h2 className="text-sm font-medium text-foreground">
          {activeTabLabel}
        </h2>
        {onClose && (
          <button
            onClick={handleClose}
            className="rounded-md p-1.5 text-muted-foreground/60 hover:text-foreground hover:bg-muted transition-colors"
          >
            <X size={16} />
          </button>
        )}
      </div>

      {/* 下方主体：左导航 + 右内容（竖屏由 globals.css 改为纵向布局：顶部横条 tab + 内容） */}
      <div className="settings-body flex flex-1 min-h-0">
        {/* 左侧 Tab 导航 */}
        <div className="settings-nav w-[160px] border-r border-border/50 pt-3 px-2 flex-shrink-0 overflow-y-auto scrollbar-thin">
          <nav className="flex flex-col gap-0.5">
            {groups.map((group) => (
              <React.Fragment key={group.title ?? "__root__"}>
                {group.title && (
                  <div className="px-3 pt-3 pb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/50">
                    {group.title}
                  </div>
                )}
                {group.items.map((tab) => (
                  <button
                    key={tab.id}
                    onClick={() => handleTabChange(tab.id)}
                    className={cn(
                      "flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors",
                      effectiveTab === tab.id
                        ? "bg-muted text-foreground font-medium"
                        : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                    )}
                  >
                    {tab.icon}
                    <span>{tab.label}</span>
                    {tab.id === "about" && (hasUpdate || hasEnvironmentIssues) && (
                      <span className="w-2 h-2 rounded-full bg-red-500" />
                    )}
                  </button>
                ))}
              </React.Fragment>
            ))}
          </nav>
        </div>

        {/* 右侧内容区域（竖屏 flex-col 布局下需要 min-h-0 保持滚动约束） */}
        <ScrollArea className="flex-1 min-h-0">
          <div className="px-6 py-4">{renderTabContent(effectiveTab, Boolean(tabsOverride))}</div>
        </ScrollArea>
      </div>

      {/* 退出拦截弹窗（侧边栏导航 / X 关闭 / Cmd+W） */}
      <AlertDialog open={showNavDialog} onOpenChange={(open) => { if (!open) cancelPendingAction() }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>放弃未保存的更改？</AlertDialogTitle>
            <AlertDialogDescription>
              当前渠道配置尚未保存，确定要离开吗？
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={cancelPendingAction}>留在当前页</AlertDialogCancel>
            <AlertDialogAction onClick={executePendingAction}>放弃并离开</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
