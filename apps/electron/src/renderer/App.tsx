import * as React from 'react'
import { useAtom, useStore } from 'jotai'
import { AppShell } from './components/app-shell/AppShell'
import { PlanningReminderRail } from './components/planning/PlanningReminderRail'
import { TutorialBanner } from './components/tutorial/TutorialBanner'
import { TooltipProvider } from '@profer/ui/primitives/tooltip'
import { conversationsAtom, currentConversationIdAtom } from './atoms/chat-atoms'
import { appModeAtom } from './atoms/app-mode'
import { activeViewAtom } from './atoms/active-view'
import { currentAgentSessionIdAtom } from './atoms/agent-atoms'
import { environmentCheckDialogOpenAtom } from './atoms/environment'
import { tabsAtom, activeTabIdAtom, openTab, TUTORIAL_TAB_ID } from './atoms/tab-atoms'
import { replayIntroEnvironmentTestAtom, replayIntroOpenAtom } from './atoms/intro-atoms'
import { IntroWaterRipple } from './components/onboarding/IntroWaterRipple'
import { CoachTourOverlay } from './components/onboarding/coach-tour/CoachTourOverlay'
import { coachTourOpenAtom } from './atoms/coach-tour-atoms'
import { CURRENT_COACH_TOUR_VERSION } from './components/onboarding/coach-tour/coach-tour-steps'
import type { AppShellContextType } from './contexts/AppShellContext'

/** 懒加载非首屏组件——减少首次渲染的 JS 解析量 */
const OnboardingView = React.lazy(() => import('./components/onboarding/OnboardingView').then(m => ({ default: m.OnboardingView })))
const EnvironmentCheckDialog = React.lazy(() => import('./components/environment/EnvironmentCheckDialog').then(m => ({ default: m.EnvironmentCheckDialog })))
const MigrationImportDialog = React.lazy(() => import('./components/migration/MigrationImportDialog').then(m => ({ default: m.MigrationImportDialog })))
const SettingsDialog = React.lazy(() => import('./components/settings/SettingsDialog').then(m => ({ default: m.SettingsDialog })))

export default function App(): React.ReactElement {
  // [FLASH-DEBUG] 监控 App 组件重渲染（如果看到频繁日志，说明根组件被频繁重渲染）
  const appRenderCountRef = React.useRef(0)
  appRenderCountRef.current++
  if (appRenderCountRef.current > 1) {
    console.warn(`[FLASH-DEBUG] App re-render #${appRenderCountRef.current}, isLoading/showOnboarding may have changed`)
  }

  const store = useStore()
  const [isLoading, setIsLoading] = React.useState(true)
  const [showOnboarding, setShowOnboarding] = React.useState(false)
  const [showOnboardingEnvironmentTest, setShowOnboardingEnvironmentTest] = useAtom(replayIntroEnvironmentTestAtom)
  /** 本次启动刚走完首次引导：主界面已有界面蒙层引导在播，不再叠教程横幅 */
  const [justFinishedOnboarding, setJustFinishedOnboarding] = React.useState(false)

  // 初始化：检查是否需要显示 Onboarding
  // macOS/Linux 上 SDK 自带 claude native binary 不依赖宿主 Node/Git；
  // Windows 上仍需 Git Bash/WSL，由 Onboarding Step 2 与聊天错误卡片引导用户安装。
  React.useEffect(() => {
    const initialize = async () => {
      try {
        const settings = await window.electronAPI.getSettings()
        if (!settings.onboardingCompleted) {
          setShowOnboarding(true)
        } else if ((settings.coachTourVersion ?? 0) < CURRENT_COACH_TOUR_VERSION) {
          // 界面引导版本化接力：Onboarding 已完成的用户（含升级后版本偏低的老用户）
          // 等主界面首帧稳定后自动播放一次；退出时写入版本，不会重复出现。
          window.setTimeout(() => store.set(coachTourOpenAtom, true), 800)
        }
      } catch (error) {
        console.error('[App] 初始化失败:', error)
      } finally {
        setIsLoading(false)
      }
    }

    initialize()
  }, [])

  // 等 React 真正提交掉“正在初始化...”后，再允许主进程撤掉原生启动页。
  React.useEffect(() => {
    if (!isLoading) window.electronAPI.notifyRendererReady()
  }, [isLoading])

  // 完成 onboarding 回调：创建欢迎对话，可选打开教程 Tab
  const handleOnboardingComplete = async (openTutorial?: boolean) => {
    setShowOnboarding(false)
    setJustFinishedOnboarding(true)

    if (openTutorial) {
      const tabs = store.get(tabsAtom)
      const result = openTab(tabs, { type: 'tutorial', sessionId: TUTORIAL_TAB_ID, title: 'Profer 使用教程' })
      store.set(tabsAtom, result.tabs)
      store.set(activeTabIdAtom, result.activeTabId)
      return
    }

    try {
      const meta = await window.electronAPI.createWelcomeConversation()
      if (meta) {
        const conversations = store.get(conversationsAtom)
        store.set(conversationsAtom, [meta, ...conversations])

        const tabs = store.get(tabsAtom)
        const result = openTab(tabs, {
          type: 'chat',
          sessionId: meta.id,
          title: meta.title,
        })
        store.set(tabsAtom, result.tabs)
        store.set(activeTabIdAtom, result.activeTabId)

        // 只开 Tab 不同步 appMode，会留下「当前是 Agent 模式、激活的却是 Chat 会话」的撕裂态：
        // 左侧栏仍渲染 Agent 会话列表，欢迎对话又出现在 Agent 的 Tab 里，用户无法判断自己在哪种模式。
        // 走 openSession 的语义，把模式与当前会话一起切到 Chat。
        store.set(appModeAtom, 'chat')
        store.set(activeViewAtom, 'conversations')
        store.set(currentConversationIdAtom, meta.id)
        store.set(currentAgentSessionIdAtom, null)

        // Onboarding 接力：进入主界面后自动播放一次界面蒙层引导。
        // 等首帧渲染稳定再启动，保证锚点（输入区/侧栏入口）已挂载。
        window.setTimeout(() => store.set(coachTourOpenAtom, true), 600)
      }
    } catch (error) {
      console.error('[App] 创建欢迎对话失败:', error)
    }
  }

  // 加载中状态
  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-4">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="text-sm text-muted-foreground">正在初始化...</p>
        </div>
      </div>
    )
  }

  // 主界面开屏测试结束后，复用首次 onboarding 的完整环境配置页；不写持久化状态。
  if (showOnboardingEnvironmentTest) {
    return (
      <TooltipProvider delayDuration={200}>
        <React.Suspense fallback={null}>
          <OnboardingView
            initialStep="welcome"
            persistCompletion={false}
            onComplete={() => setShowOnboardingEnvironmentTest(false)}
          />
        </React.Suspense>
      </TooltipProvider>
    )
  }

  // 显示首次 onboarding 界面
  if (showOnboarding) {
    return (
      <TooltipProvider delayDuration={200}>
        <React.Suspense fallback={null}>
          <OnboardingView onComplete={handleOnboardingComplete} />
        </React.Suspense>
        <React.Suspense fallback={null}>
          <MigrationImportDialog />
        </React.Suspense>
      </TooltipProvider>
    )
  }

  // Placeholder context value
  const contextValue: AppShellContextType = {}

  // 显示主界面
  return (
    <TooltipProvider delayDuration={200}>
      <PlanningReminderRail />
      <AppShell contextValue={contextValue} />
      <React.Suspense fallback={null}>
        <SettingsDialog />
      </React.Suspense>
      <TutorialBanner skip={justFinishedOnboarding} />
      <GlobalEnvironmentCheckDialog />
      <React.Suspense fallback={null}>
        <MigrationImportDialog />
      </React.Suspense>
      <IntroReplayOverlay />
      <CoachTourOverlay />
    </TooltipProvider>
  )
}

/**
 * 全屏开屏动画重播遮罩：
 * 主界面顶栏点按钮 → replayIntroOpenAtom=true → 渲染 IntroWaterRipple
 * 动画结束（或点按跳过）后重置 atom，回到主界面。
 * 不改动 onboardingCompleted，纯重播/测试用途。
 */
function IntroReplayOverlay(): React.ReactElement | null {
  const [open, setOpen] = useAtom(replayIntroOpenAtom)
  const [, setShowOnboardingEnvironmentTest] = useAtom(replayIntroEnvironmentTestAtom)
  if (!open) return null
  return (
    <div
      className="fixed inset-0 z-[9999]"
      role="dialog"
      aria-modal="true"
      aria-label="Profer 开屏动画"
      data-profer-intro-overlay
    >
      <IntroWaterRipple
        onDone={() => {
          setOpen(false)
          // 复用首次安装时的完整环境配置页，不触碰 onboardingCompleted。
          setShowOnboardingEnvironmentTest(true)
        }}
      />
    </div>
  )
}

/**
 * 全局环境检测 Dialog，由错误卡片的 recovery action 按钮打开。
 */
function GlobalEnvironmentCheckDialog(): React.ReactElement {
  const [open, setOpen] = useAtom(environmentCheckDialogOpenAtom)
  return <EnvironmentCheckDialog open={open} onOpenChange={setOpen} />
}
