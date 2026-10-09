/**
 * SettingsPanel - 设置面板
 *
 * 左侧导航（标题 + 分组）+ 右侧内容区域。
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
  Users,
  Coins,
  CreditCard,
  Database,
  Network,
  UserRound,
  Blocks,
  FlaskConical,
  SlidersHorizontal,
  Search,
} from "lucide-react";
import { ScrollArea } from "@profer/ui/primitives/scroll-area";
import { Button } from '@profer/ui/primitives/button';
import { settingsTabAtom, channelFormControllerAtom, channelFormDirtyAtom, settingsCloseRequestedAtom, settingsOpenAtom } from "@/atoms/settings-tab";
import type { SettingsTab } from "@/atoms/settings-tab";
import { appModeAtom } from "@/atoms/app-mode";
import { authStatusAtom } from "@/atoms/identity-atoms";
import { hasUpdateAtom } from "@/atoms/updater";
import { tabsAtom, activeTabIdAtom, openTab, TUTORIAL_TAB_ID } from "@/atoms/tab-atoms";
import { hasEnvironmentIssuesAtom } from "@/atoms/environment";
import { developerModeEnabledAtom } from "@/atoms/developer-mode";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@profer/ui/primitives/alert-dialog";
import { ChannelSettings } from "./ChannelSettings";
import { GeneralSettings } from "./GeneralSettings";
import { UsageSettings } from "./UsageSettings";
import { AccountSettings } from "./AccountSettings";
import { AppearanceSettings } from "./AppearanceSettings";
import { AboutSettings } from "./AboutSettings";
import { AgentSettings } from "./AgentSettings";
import { PromptSettings } from "./PromptSettings";
import { ToolSettings } from "./ToolSettings";
import { BotHubSettings } from "./BotHubSettings";
import { ShortcutSettings } from "./ShortcutSettings";
import { DataManagementSettings } from "./DataManagementSettings";
import { TeamWorkspaceSettings } from "./TeamWorkspaceSettings";
import { CreditsSettings } from "./CreditsSettings";
import { SubscriptionSettings } from "./SubscriptionSettings";
import { OpenApiSettings } from "./OpenApiSettings";
import { ProxySettings } from "./ProxySettings";
import { PluginSettings } from "./PluginSettings";
import { DeveloperSettings } from "./DeveloperSettings";
import { TEAM_WORKSPACE_UI_ENABLED } from "@/lib/product-feature-flags";
import { DevicesSettings } from "./DevicesSettings";
import { matchesSettingsSearch } from "./settings-search";

/** 设置 Tab 定义 */
export interface SettingsTabItem {
  id: SettingsTab;
  label: string;
  icon: React.ReactNode;
  /** 页面内的常用配置名称和同义词，用于设置导航搜索。 */
  searchTerms?: readonly string[];
}

/** 导航分组：标题 + 该分组内的 tab */
export interface SettingsTabGroup {
  /** 分组标题；为空则不渲染分组标题（用于不带标题的起始组） */
  title?: string;
  items: SettingsTabItem[];
}

/** 账户：身份、额度、订阅和团队能力。开放 API 暂不开放入口。 */
const ACCOUNT_GROUP_ITEMS: SettingsTabItem[] = [
  { id: "account", label: "账户与资料", icon: <UserRound size={16} />, searchTerms: ["登录", "注册", "用户名", "头像", "个人信息", "团队账户"] },
  { id: "credits", label: "额度与用量", icon: <Coins size={16} />, searchTerms: ["积分", "余额", "用量", "API 请求", "请求历史"] },
  { id: "subscription", label: "订阅方案", icon: <CreditCard size={16} />, searchTerms: ["套餐", "会员", "VIP", "兑换码", "价格"] },
  ...(TEAM_WORKSPACE_UI_ENABLED
    ? [{ id: "team" as const, label: "团队管理", icon: <Users size={16} />, searchTerms: ["团队工作区", "成员", "邀请", "邀请码", "权限"] }]
    : []),
];

/** 模型与能力：渠道 / Agent / 提示词 / Chat 工具 */
const MODEL_GROUP_ITEMS: SettingsTabItem[] = [
  { id: "channels", label: "模型配置", icon: <Radio size={16} />, searchTerms: ["渠道", "供应商", "模型", "API Key", "密钥", "Base URL", "endpoint", "Claude", "OpenAI", "DeepSeek"] },
  { id: "agent", label: "Agent 配置", icon: <Plug size={16} />, searchTerms: ["Agent", "代理", "推理", "内置工具", "运行时", "Claude", "Pi"] },
  { id: "prompts", label: "提示词管理", icon: <BookOpen size={16} />, searchTerms: ["系统提示词", "提示词内容", "prompt", "默认提示词", "用户名", "日期时间"] },
  { id: "tools", label: "Chat 工具", icon: <Wrench size={16} />, searchTerms: ["工具", "联网搜索", "Tavily", "AI 图片生成", "图片", "自定义工具", "HTTP API"] },
];

/** 体验：外观 / 快捷键 */
const EXPERIENCE_GROUP_ITEMS: SettingsTabItem[] = [
  { id: "appearance", label: "外观设置", icon: <Palette size={16} />, searchTerms: ["主题", "深色", "浅色", "暗色", "亮色", "缩放", "字体", "字号", "皮肤", "Logo", "图标", "Dock"] },
  { id: "shortcuts", label: "快捷键管理", icon: <Keyboard size={16} />, searchTerms: ["快捷键", "键盘", "快捷方式", "录制"] },
];

/** 连接：远程连接 / 代理 */
const CONNECTION_GROUP_ITEMS: SettingsTabItem[] = [
  { id: "bots", label: "远程连接", icon: <Bot size={16} />, searchTerms: ["机器人", "Bot", "飞书", "钉钉", "微信", "远程", "工作区", "默认工作区", "绑定"] },
  { id: "proxy", label: "代理设置", icon: <Network size={16} />, searchTerms: ["网络代理", "HTTP proxy", "HTTPS proxy", "代理地址", "端口"] },
];

/** 系统：数据管理 / 隐藏插件入口 */
const SYSTEM_GROUP_ITEMS: SettingsTabItem[] = [
  { id: "data-management", label: "数据管理", icon: <Database size={16} />, searchTerms: ["备份", "导入", "导出", "迁移", "存储", "自动清理", "孤儿数据", "历史数据"] },
];

/** 帮助：教程 / 关于与更新 */
const HELP_GROUP_ITEMS: SettingsTabItem[] = [
  { id: "tutorial", label: "Profer 教程", icon: <GraduationCap size={16} />, searchTerms: ["教程", "帮助", "入门", "使用说明"] },
  { id: "about", label: "关于/更新", icon: <Info size={16} />, searchTerms: ["版本", "更新", "运行环境", "反馈", "关于 Profer"] },
];

const DEVELOPER_MODE_ITEM: SettingsTabItem = {
  id: "developer",
  label: "开发者",
  icon: <FlaskConical size={16} />,
  searchTerms: ["开发者模式", "开放认识论", "实验性能力", "运行时边界"],
};

const PLUGIN_SYSTEM_ITEM: SettingsTabItem = {
  id: "plugins",
  label: "插件",
  icon: <Blocks size={16} />,
  searchTerms: ["插件系统", "安装插件", "已安装插件", "扩展"],
};

/** 依赖团队账号登录的 Tab（未登录时不展示） */
const AUTH_REQUIRED_TABS: ReadonlySet<SettingsTab> = new Set([
  "credits",
  "subscription",
  "team",
]);

/** 根据标签页 id 渲染对应内容 */
function renderTabContent(tab: SettingsTab): React.ReactElement {
  switch (tab) {
    case "general":
      return <GeneralSettings />;
    case "usage":
      return <UsageSettings />;
    case "account":
      return <AccountSettings />;
    case "devices":
      return <DevicesSettings />;
    case "channels":
      return <ChannelSettings />;
    case "prompts":
      return <PromptSettings />;
    case "agent":
      return <AgentSettings />;
    case "tools":
      return <ToolSettings />;
    case "appearance":
      return <AppearanceSettings />;
    case "about":
      return <AboutSettings />;
    case "bots":
      return <BotHubSettings />;
    case "shortcuts":
      return <ShortcutSettings />;
    case "data-management":
      return <DataManagementSettings />;
    case "developer":
      return <DeveloperSettings />;
    case "plugins":
      return <PluginSettings />;
    case "team":
      return <TeamWorkspaceSettings />;
    case "credits":
      return <CreditsSettings />;
    case "subscription":
      return <SubscriptionSettings />;
    // 开放 API 暂无导航入口；保留渲染分支以兼容既有内部跳转和后续恢复。
    case "openapi":
      return <OpenApiSettings />;
    case "proxy":
      return <ProxySettings />;
    default:
      // tutorial 等特殊 tab 由 handleTabChange 拦截打开主区 Tab，不会在此渲染
      return <GeneralSettings />;
  }
}

interface SettingsPanelProps {
  onClose?: () => void;
  /** 受限环境（如外部嵌入入口）传入的 tab 白名单；不传时按 appMode 推导完整列表 */
  tabsOverride?: SettingsTabItem[];
}

export function SettingsPanel({
  onClose,
  tabsOverride,
}: SettingsPanelProps): React.ReactElement {
  const [activeTab, setActiveTab] = useAtom(settingsTabAtom);
  const channelFormDirty = useAtomValue(channelFormDirtyAtom);
  const formController = useAtomValue(channelFormControllerAtom);
  const [closeRequested, setCloseRequested] = useAtom(settingsCloseRequestedAtom);
  const setSettingsOpen = useSetAtom(settingsOpenAtom);
  const appMode = useAtomValue(appModeAtom);
  const hasUpdate = useAtomValue(hasUpdateAtom);
  const hasEnvironmentIssues = useAtomValue(hasEnvironmentIssuesAtom);
  const developerModeEnabled = useAtomValue(developerModeEnabledAtom);
  const [mainTabs, setMainTabs] = useAtom(tabsAtom);
  const setMainActiveTabId = useSetAtom(activeTabIdAtom);
  const authStatus = useAtomValue(authStatusAtom);

  /** 统一的退出拦截对话框状态 */
  type PendingAction = { type: 'tab'; tabId: SettingsTab } | { type: 'close' } | null
  const [pendingAction, setPendingAction] = React.useState<PendingAction>(null)
  const [navQuery, setNavQuery] = React.useState('')
  const [navigationSaving, setNavigationSaving] = React.useState(false)
  const showNavDialog = pendingAction !== null

  /** 完成导航（仅在无需确认或用户明确放弃后调用）。 */
  const navigateToTab = (tabId: SettingsTab): void => {
    if (tabId === 'tutorial') {
      const result = openTab(mainTabs, { type: 'tutorial', sessionId: TUTORIAL_TAB_ID, title: 'Profer 使用教程' })
      setMainTabs(result.tabs)
      setMainActiveTabId(result.activeTabId)
      setSettingsOpen(false)
      return
    }
    setActiveTab(tabId)
  }

  /** 执行待处理的操作 */
  const executePendingAction = (): void => {
    if (!pendingAction) return
    if (pendingAction.type === 'tab') {
      navigateToTab(pendingAction.tabId)
    } else {
      onClose?.()
    }
    setPendingAction(null)
  }

  /** 取消待处理的操作 */
  const cancelPendingAction = (): void => {
    if (navigationSaving) return
    setPendingAction(null)
  }

  const completePendingAction = async (save: boolean): Promise<void> => {
    if (navigationSaving || !formController || formController.busy) return
    setNavigationSaving(true)
    try {
      if (save) {
        if (!(await formController.flush())) return
      } else {
        await formController.discard()
      }
      executePendingAction()
    } finally {
      setNavigationSaving(false)
    }
  }

  // 受限环境传入白名单时直接使用（无分组标题）；否则按语义分组组装导航。
  // 未登录时过滤掉需要团队账号的 Tab；账户页始终保留，用于登录入口。
  const groups = React.useMemo<SettingsTabGroup[]>(() => {
    if (tabsOverride) {
      return [{ items: tabsOverride }]
    }

    const modelItems = appMode === "agent"
      ? MODEL_GROUP_ITEMS
      : MODEL_GROUP_ITEMS.filter((item) => item.id !== "agent")

    const systemItems = developerModeEnabled
      ? [SYSTEM_GROUP_ITEMS[0]!, DEVELOPER_MODE_ITEM, PLUGIN_SYSTEM_ITEM, ...SYSTEM_GROUP_ITEMS.slice(1)]
      : SYSTEM_GROUP_ITEMS

    const allGroups: SettingsTabGroup[] = [
      { items: [{ id: "general", label: "通用", icon: <Settings size={16} />, searchTerms: ["语言", "启动", "开机启动", "Shell", "终端", "新标签页", "URL"] }, { id: "usage", label: "使用偏好", icon: <SlidersHorizontal size={16} />, searchTerms: ["通知", "声音", "归档", "会话", "对话", "输入框", "粘贴", "Markdown", "预览", "紧凑模式"] }] },
      { title: "账户", items: ACCOUNT_GROUP_ITEMS },
      { title: "模型与能力", items: modelItems },
      { title: "体验", items: EXPERIENCE_GROUP_ITEMS },
      { title: "连接", items: CONNECTION_GROUP_ITEMS },
      { title: "系统", items: systemItems },
      { title: "帮助", items: HELP_GROUP_ITEMS },
    ]

    if (authStatus.isLoggedIn) return allGroups

    // 未登录：过滤需要鉴权的页面，并清理空分组
    return allGroups
      .map((g) => ({ ...g, items: g.items.filter((t) => !AUTH_REQUIRED_TABS.has(t.id)) }))
      .filter((g) => g.items.length > 0)
  }, [appMode, tabsOverride, authStatus.isLoggedIn, developerModeEnabled]);

  // 将所有可见 tab 拍平成列表，用于 activeTab 回落与标题查找
  const tabs: SettingsTabItem[] = React.useMemo(
    () => groups.flatMap((g) => g.items),
    [groups]
  )

  const filteredGroups = React.useMemo(() => {
    if (!navQuery.trim()) return groups
    return groups
      .map((group) => ({
        ...group,
        items: group.items.filter((item) => matchesSettingsSearch(item, group.title, navQuery)),
      }))
      .filter((group) => group.items.length > 0)
  }, [groups, navQuery]);

  // 统一回落：activeTab 不在当前可见列表（白名单过滤 / 未登录过滤）时回落到首项，
  // 避免渲染未暴露的设置页（如登录/订阅/团队管理）。
  // tabs 为空数组（tabsOverride 传空）时整体不渲染，避免解引用崩溃。
  const effectiveTab: SettingsTab = tabs.some((t) => t.id === activeTab) ? activeTab : (tabs[0]?.id ?? 'general')

  /** 切换标签页时检测是否有未保存内容，tutorial 特殊处理：打开 New Tab 并关闭设置 */
  const handleTabChange = (tabId: SettingsTab): void => {
    if (tabId === effectiveTab) return
    if (effectiveTab === 'channels' && channelFormDirty) {
      setPendingAction({ type: 'tab', tabId })
      return
    }
    navigateToTab(tabId)
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
    if (!closeRequested) return
    setCloseRequested(false)
    if (channelFormDirty) {
      setPendingAction({ type: 'close' })
    } else {
      onClose?.()
    }
  }, [closeRequested, channelFormDirty, setCloseRequested, onClose])

  // 保持所有 Hook 在空列表回落之前执行。
  if (tabs.length === 0) return (
    <div className="flex h-full flex-col items-center justify-center gap-4 text-sm text-muted-foreground">
      <p>没有可用的设置项</p>
      {onClose && (
        <button type="button" onClick={handleClose} className="rounded-md px-3 py-2 text-foreground hover:bg-control focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-focus/15">
          关闭设置
        </button>
      )}
    </div>
  )

  // 当前 tab 标题
  const activeTabLabel = tabs.find((t) => t.id === effectiveTab)?.label ?? "设置";

  return (
    <div className="settings-body relative flex h-full min-h-0 flex-col md:flex-row">
      <button
        type="button"
        onClick={() => document.getElementById('settings-main-content')?.focus()}
        className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-10 focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:ring-2 focus:ring-focus"
      >
        跳到设置内容
      </button>
      {/* 窄窗口使用顶部分类选择器，桌面保留固定侧栏。 */}
      <div className="flex shrink-0 items-center gap-2 border-b border-surface-border/50 bg-surface-sunken/30 px-4 py-3 md:hidden">
        <label htmlFor="settings-mobile-nav" className="sr-only">设置分类</label>
        <select
          id="settings-mobile-nav"
          value={effectiveTab}
          onChange={(event) => handleTabChange(event.target.value as SettingsTab)}
          className="h-9 min-w-0 flex-1 rounded-md border border-surface-border/60 bg-input/40 px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-focus/15"
        >
          {tabs.map((tab) => <option key={tab.id} value={tab.id}>{tab.label}</option>)}
        </select>
        {onClose && (
          <button
            type="button"
            onClick={handleClose}
            aria-label="关闭设置"
            title="关闭设置"
            className="rounded-md p-2 text-muted-foreground/70 transition-colors hover:bg-control hover:text-foreground focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-focus/15"
          >
            <X size={18} aria-hidden="true" />
          </button>
        )}
      </div>

      <aside className="settings-nav hidden w-[240px] flex-shrink-0 flex-col overflow-y-auto border-r border-surface-border/50 bg-surface-sunken/30 px-2.5 py-4 scrollbar-thin md:flex">
        <div className="settings-nav-header flex items-center justify-between px-3 pb-4">
          <h2 className="text-base font-semibold text-foreground">设置</h2>
        </div>
        <div className="relative mb-2 px-1">
          <Search size={15} aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground/70" />
          <label htmlFor="settings-nav-search" className="sr-only">搜索设置</label>
          <input
            id="settings-nav-search"
            value={navQuery}
            onChange={(event) => setNavQuery(event.target.value)}
            placeholder="搜索设置"
            className="h-9 w-full rounded-md border border-surface-border/50 bg-input/30 pl-8 pr-3 text-sm text-foreground placeholder:text-muted-foreground/60 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-focus/15"
          />
        </div>
        <nav
          className="flex flex-col gap-0.5"
          aria-label="设置分类"
          onKeyDown={(event) => {
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
            const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button'))
            const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
            if (index < 0) return
            event.preventDefault()
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
            buttons[next]?.focus()
          }}
        >
          {filteredGroups.map((group) => (
            <React.Fragment key={group.title ?? "__root__"}>
              {group.title && (
                <div className="px-3 pt-3 pb-1 text-xs font-medium text-muted-foreground">
                  {group.title}
                </div>
              )}
              {group.items.map((tab) => (
                <button
                  type="button"
                  key={tab.id}
                  onClick={() => handleTabChange(tab.id)}
                  aria-current={effectiveTab === tab.id ? 'page' : undefined}
                  className={cn(
                    "group flex min-h-9 items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-focus/15",
                    effectiveTab === tab.id
                      ? "bg-surface-selected text-foreground font-medium shadow-sm"
                      : "text-muted-foreground hover:bg-surface-selected/50 hover:text-foreground",
                  )}
                >
                  <span className={cn(
                    "flex-shrink-0 transition-colors",
                    effectiveTab === tab.id ? "text-primary" : "text-muted-foreground/70 group-hover:text-foreground"
                  )} aria-hidden="true">{tab.icon}</span>
                  <span className="min-w-0 flex-1 truncate text-left">{tab.label}</span>
                  {tab.id === "about" && (hasUpdate || hasEnvironmentIssues) && (
                    <span className="ml-auto size-2 flex-shrink-0 rounded-full bg-destructive" aria-label="有待处理事项" />
                  )}
                </button>
              ))}
            </React.Fragment>
          ))}
          {filteredGroups.length === 0 && (
            <p className="px-3 py-6 text-center text-xs text-muted-foreground">没有匹配的设置</p>
          )}
        </nav>
      </aside>

      <section className="settings-main flex min-h-0 min-w-0 flex-1 flex-col" aria-label={`${activeTabLabel}设置`}>
        <div className="settings-main-header hidden min-h-[72px] flex-shrink-0 items-center justify-between px-8 py-5 md:flex">
          <div className="min-w-0">
            <p className="mb-1 text-xs font-medium text-muted-foreground">设置</p>
            <h2 className="truncate text-xl font-semibold text-foreground">{activeTabLabel}</h2>
          </div>
          {onClose && (
            <button
              type="button"
              onClick={handleClose}
              aria-label="关闭设置"
              title="关闭设置"
              className="rounded-md p-2 text-muted-foreground/60 transition-colors hover:bg-control hover:text-foreground focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-focus/15"
            >
              <X size={18} aria-hidden="true" />
            </button>
          )}
        </div>
        <ScrollArea key={effectiveTab} className="min-h-0 flex-1">
          <main id="settings-main-content" tabIndex={-1} className="settings-content px-4 pb-8 pt-5 outline-none sm:px-6 md:px-8 md:pt-1">
            <div className="mx-auto w-full max-w-3xl">
              {renderTabContent(effectiveTab)}
            </div>
          </main>
        </ScrollArea>
      </section>

      {/* 退出拦截弹窗（侧边栏导航 / X 关闭 / Cmd+W） */}
      <AlertDialog open={showNavDialog} onOpenChange={(open) => { if (!open) cancelPendingAction() }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>放弃未保存的更改？</AlertDialogTitle>
            <AlertDialogDescription>
              当前渠道有未保存的更改。可以留在此页重试保存，或明确放弃尚未发送的更改；已保存的内容不会撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={cancelPendingAction} disabled={navigationSaving}>留在当前页</AlertDialogCancel>
            <Button type="button" variant="outline" disabled={navigationSaving || formController?.busy} onClick={() => { void completePendingAction(false) }}>
              放弃并离开
            </Button>
            <AlertDialogAction disabled={navigationSaving || formController?.busy} onClick={(event) => { event.preventDefault(); void completePendingAction(true) }}>
              {navigationSaving ? '处理中…' : '保存并离开'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
