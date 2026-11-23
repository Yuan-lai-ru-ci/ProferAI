/**
 * SettingsPanel - 设置面板
 *
 * 左侧导航（标题 + 分组）+ 右侧内容区域。
 * 使用 Jotai atom 管理当前标签页状态。
 */

import * as React from "react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
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
  Coins,
  CreditCard,
  Database,
  Network,
  UserRound,
  Blocks,
  FlaskConical,
  SlidersHorizontal,
} from "lucide-react";
import { ScrollRegion } from "@/components/ai-elements/scroll-region";
import { Button } from '@profer/ui/primitives/button';
import { settingsTabAtom, channelFormControllerAtom, channelFormDirtyAtom, settingsCloseRequestedAtom, settingsOpenAtom } from "@/atoms/settings-tab";
import type { SettingsTab } from "@/atoms/settings-tab";
import { appModeAtom } from "@/atoms/app-mode";
import { authStatusAtom } from "@/atoms/identity-atoms";
import { hasUpdateAtom } from "@/atoms/updater";
import { tabsAtom, activeTabIdAtom, openTab, TUTORIAL_TAB_ID, TUTORIAL_TAB_TITLE, FRP_GUIDE_TAB_ID, FRP_GUIDE_TAB_TITLE, type OpenTabInput } from "@/atoms/tab-atoms";
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
import { CreditsSettings } from "./CreditsSettings";
import { SubscriptionSettings } from "./SubscriptionSettings";
import { OpenApiSettings } from "./OpenApiSettings";
import { ProxySettings } from "./ProxySettings";
import { PluginSettings } from "./PluginSettings";
import { DeveloperSettings } from "./DeveloperSettings";
import { DevicesSettings } from "./DevicesSettings";
import { ComposerToolbarSettings } from "./ComposerToolbarSettings";
import { SettingsNavigation, type SettingsTabItem, type SettingsTabGroup } from "./SettingsNavigation";
import { filterSettingsGroups } from "./settings-visibility";
import { isCommercialBuild } from "@/lib/build-target";

export type { SettingsTabItem, SettingsTabGroup } from "./SettingsNavigation";

/** 账户：身份、额度、订阅和团队能力。开放 API 暂不开放入口。 */
const ACCOUNT_GROUP_ITEMS: SettingsTabItem[] = [
  { id: "account", label: "账户与资料", icon: <UserRound size={16} />, searchTerms: ["登录", "注册", "用户名", "头像", "个人信息", "团队账户"] },
  { id: "credits", label: "额度与用量", icon: <Coins size={16} />, searchTerms: ["积分", "余额", "用量", "API 请求", "请求历史"] },
  { id: "subscription", label: "订阅方案", icon: <CreditCard size={16} />, searchTerms: ["套餐", "会员", "VIP", "兑换码", "价格"] },
];

/** 模型与能力：渠道 / Agent / 提示词 / Chat 工具 */
const MODEL_GROUP_ITEMS: SettingsTabItem[] = [
  { id: "channels", label: "模型配置", icon: <Radio size={16} />, searchTerms: ["渠道", "供应商", "模型", "API Key", "密钥", "Base URL", "endpoint", "Claude", "OpenAI", "DeepSeek"] },
  { id: "agent", label: "Agent 配置", icon: <Plug size={16} />, searchTerms: ["Agent", "代理", "推理", "内置工具", "运行时", "Claude", "Pi"] },
  { id: "prompts", label: "提示词管理", icon: <BookOpen size={16} />, searchTerms: ["系统提示词", "提示词内容", "prompt", "默认提示词", "用户名", "日期时间"] },
  { id: "tools", label: "Chat 工具", icon: <Wrench size={16} />, searchTerms: ["工具", "联网搜索", "Tavily", "AI 图片生成", "图片", "自定义工具", "HTTP API"] },
];

/** 工作偏好：通用、使用偏好和界面呈现。 */
const PREFERENCE_GROUP_ITEMS: SettingsTabItem[] = [
  { id: "general", label: "通用", icon: <Settings size={16} />, searchTerms: ["语言", "启动", "开机启动", "快速任务", "快捷任务", "引导", "Shell", "终端", "新标签页", "URL", "悬浮预览", "迷你地图", "悬停", "侧栏预览"] },
  { id: "usage", label: "使用偏好", icon: <SlidersHorizontal size={16} />, searchTerms: ["通知", "声音", "音效", "归档", "会话", "对话", "用户消息", "头像", "左右", "输入框", "粘贴", "Markdown", "预览", "紧凑模式", "侧栏", "侧边栏", "当前会话", "显示", "隐藏", "语音", "豆包", "Goal", "空闲自检", "滚动", "已读"] },
  { id: "appearance", label: "外观设置", icon: <Palette size={16} />, searchTerms: ["主题", "深色", "浅色", "暗色", "亮色", "缩放", "字体", "字号", "皮肤", "Logo", "图标", "Dock"] },
  { id: "shortcuts", label: "快捷键管理", icon: <Keyboard size={16} />, searchTerms: ["快捷键", "键盘", "快捷方式", "录制"] },
  { id: "composer-toolbar", label: "输入工具栏", icon: <SlidersHorizontal size={16} />, searchTerms: ["工具栏", "排序", "显示", "隐藏", "输入区", "Chat", "Agent"] },
];

/** 连接：远程连接 / 代理（公网 FRP 暂不开放） */
const CONNECTION_GROUP_ITEMS: SettingsTabItem[] = [
  { id: "bots", label: "设备与连接", icon: <Bot size={16} />, searchTerms: ["机器人", "Bot", "飞书", "钉钉", "微信", "远程", "工作区", "默认工作区", "绑定", "远程内核", "Core", "HTTPS", "Token", "线路"] },
  { id: "proxy", label: "代理设置", icon: <Network size={16} />, searchTerms: ["网络代理", "HTTP proxy", "HTTPS proxy", "代理地址", "端口"] },
];

/**
 * 设置里的文档入口：不渲染在设置右侧，而是打开主区单例 Tab。
 * 与 `openTab` 的类型/标题保持一致，避免两处各自演化。
 */
const DOC_SETTINGS_TABS: Partial<Record<SettingsTab, OpenTabInput>> = {
  tutorial: { type: "tutorial", sessionId: TUTORIAL_TAB_ID, title: TUTORIAL_TAB_TITLE },
  "frp-guide": { type: "frp-guide", sessionId: FRP_GUIDE_TAB_ID, title: FRP_GUIDE_TAB_TITLE },
};

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
  searchTerms: ["开发者模式", "实验性能力", "运行时边界"],
};

const PLUGIN_SYSTEM_ITEM: SettingsTabItem = {
  id: "plugins",
  label: "插件",
  icon: <Blocks size={16} />,
  searchTerms: ["插件系统", "安装插件", "已安装插件", "扩展"],
};

/** 根据标签页 id 渲染对应内容 */
function renderTabContent(tab: SettingsTab, revealAdvanced: boolean): React.ReactElement {
  switch (tab) {
    case "general":
      return <GeneralSettings revealAdvanced={revealAdvanced} />;
    case "usage":
      return <UsageSettings revealAdvanced={revealAdvanced} />;
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
    case "composer-toolbar":
      return <ComposerToolbarSettings />;
    case "appearance":
      return <AppearanceSettings revealAdvanced={revealAdvanced} />;
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
      // tutorial / frp-guide 等文档 tab 由 handleTabChange 拦截打开主区 Tab，不会在此渲染
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
    const docTab = DOC_SETTINGS_TABS[tabId]
    if (docTab) {
      const result = openTab(mainTabs, docTab)
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
  // 可见性统一走 filterSettingsGroups：开源版没有账号体系，账户/额度/订阅/团队整组不出现；
  // 商业版未登录时隐藏需要登录的页面，账户页保留作为登录入口。
  const commercial = isCommercialBuild()
  const groups = React.useMemo<SettingsTabGroup[]>(() => {
    if (tabsOverride) {
      const [only] = filterSettingsGroups([{ items: tabsOverride }], {
        isLoggedIn: authStatus.isLoggedIn,
        commercial,
      })
      return only ? [only] : []
    }

    const modelItems = appMode === "agent"
      ? MODEL_GROUP_ITEMS
      : MODEL_GROUP_ITEMS.filter((item) => item.id !== "agent")

    const systemItems = developerModeEnabled
      ? [SYSTEM_GROUP_ITEMS[0]!, DEVELOPER_MODE_ITEM, PLUGIN_SYSTEM_ITEM, ...SYSTEM_GROUP_ITEMS.slice(1)]
      : SYSTEM_GROUP_ITEMS

    const allGroups: SettingsTabGroup[] = [
      { title: "工作偏好", items: PREFERENCE_GROUP_ITEMS },
      { title: "模型与能力", items: modelItems },
      { title: "连接", items: CONNECTION_GROUP_ITEMS },
      { title: "账户", items: ACCOUNT_GROUP_ITEMS },
      { title: "应用", items: [...systemItems, ...HELP_GROUP_ITEMS] },
    ]

    return filterSettingsGroups(allGroups, { isLoggedIn: authStatus.isLoggedIn, commercial })
  }, [appMode, tabsOverride, authStatus.isLoggedIn, developerModeEnabled, commercial]);

  // 将所有可见 tab 拍平成列表，用于 activeTab 回落与标题查找
  const tabs: SettingsTabItem[] = React.useMemo(
    () => groups.flatMap((g) => g.items),
    [groups]
  )

  // 统一回落：activeTab 不在当前可见列表（白名单过滤 / 未登录过滤）时回落到首项，
  // 避免渲染未暴露的设置页（如登录/订阅/团队管理）。
  // tabs 为空数组（tabsOverride 传空）时整体不渲染，避免解引用崩溃。
  const effectiveTab: SettingsTab = tabs.some((t) => t.id === activeTab) ? activeTab : (tabs[0]?.id ?? 'general')

  /** 切换标签页时检测是否有未保存内容，文档入口（tutorial / frp-guide）特殊处理：打开主区 Tab 并关闭设置 */
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
  const activeGroupLabel = groups.find((group) => group.items.some((tab) => tab.id === effectiveTab))?.title;

  return (
    <div className="settings-body relative flex h-full min-h-0 flex-col md:flex-row">
      <button
        type="button"
        onClick={() => document.getElementById('settings-main-content')?.focus()}
        className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-10 focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:ring-2 focus:ring-focus"
      >
        跳到设置内容
      </button>
      <SettingsNavigation
        groups={groups}
        activeTab={effectiveTab}
        query={navQuery}
        onQueryChange={setNavQuery}
        onTabChange={handleTabChange}
        onClose={onClose ? handleClose : undefined}
        needsAttention={hasUpdate || hasEnvironmentIssues}
      />

      <section className="settings-main flex min-h-0 min-w-0 flex-1 flex-col" aria-label={`${activeTabLabel}设置`}>
        <div className="settings-main-header flex min-h-[88px] shrink-0 items-start justify-between gap-4 px-4 py-5 sm:px-6 md:px-8 md:pt-6">
          <div className="min-w-0">
            {activeGroupLabel && <p className="mb-1 text-xs font-medium text-muted-foreground">{activeGroupLabel}</p>}
            <h2 className="truncate text-xl font-semibold text-foreground">{activeTabLabel}</h2>
          </div>
          {onClose && (
            <button
              type="button"
              onClick={handleClose}
              aria-label="关闭设置"
              title="关闭设置"
              className="hidden rounded-md p-2 text-muted-foreground transition-colors hover:bg-control hover:text-foreground focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-focus/15 md:inline-flex"
            >
              <X size={18} aria-hidden="true" />
            </button>
          )}
        </div>
        <ScrollRegion key={effectiveTab} className="min-h-0 flex-1 overflow-y-auto">
          <main id="settings-main-content" tabIndex={-1} className="settings-content px-4 pb-8 pt-1 outline-none sm:px-6 md:px-8">
            <div className="mx-auto w-full max-w-3xl">
              {renderTabContent(effectiveTab, Boolean(navQuery.trim()))}
            </div>
          </main>
        </ScrollRegion>
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
