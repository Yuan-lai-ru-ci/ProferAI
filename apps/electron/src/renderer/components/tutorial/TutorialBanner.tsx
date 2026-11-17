/**
 * TutorialBanner - 教程推荐卡片
 *
 * 从右下角浮出，给三条真正能点的上手路径：
 *  - 打开教程（设置 → 帮助 → Profer 教程 的同一入口）
 *  - 重播界面导览（Coach Tour）
 *  - 直接看常见任务示例
 *
 * 关闭按钮放在标题行内，与卡片内边距同一条基线；不再绝对定位到角落。
 * 点击任意路径或「稍后」都会写入 tutorialBannerDismissed，之后不再出现。
 */

import * as React from 'react'
import { useAtom, useSetAtom } from 'jotai'
import { BookOpen, ChevronRight, Compass, ListChecks, X } from 'lucide-react'
import { Button } from '@profer/ui/primitives/button'
import { tabsAtom, activeTabIdAtom, openTab, TUTORIAL_TAB_ID } from '@/atoms/tab-atoms'
import { coachTourOpenAtom } from '@/atoms/coach-tour-atoms'

export interface TutorialBannerProps {
  /**
   * 本次启动刚走完首次引导。
   *
   * 这种情况下界面上已经有界面蒙层引导在播，再叠一张教程卡会互相遮挡，
   * 用户也不知道该看哪一个；直接标记为已读，之后仍可从设置与顶栏打开教程。
   */
  skip?: boolean
}

export function TutorialBanner({ skip = false }: TutorialBannerProps = {}): React.ReactElement | null {
  const [visible, setVisible] = React.useState(false)
  const [dismissed, setDismissed] = React.useState(true)
  const [tabs, setTabs] = useAtom(tabsAtom)
  const setActiveTabId = useSetAtom(activeTabIdAtom)
  const setCoachTourOpen = useSetAtom(coachTourOpenAtom)

  React.useEffect(() => {
    let cancelled = false
    void window.electronAPI
      .getSettings()
      .then((settings) => {
        if (cancelled) return
        if (skip) {
          void window.electronAPI.updateSettings({ tutorialBannerDismissed: true }).catch(console.error)
          return
        }
        if (settings.tutorialBannerDismissed) return
        setDismissed(false)
        setTimeout(() => {
          if (!cancelled) setVisible(true)
        }, 1500)
      })
      .catch(console.error)
    return () => {
      cancelled = true
    }
  }, [skip])

  const handleDismiss = async () => {
    setVisible(false)
    await window.electronAPI.updateSettings({ tutorialBannerDismissed: true })
  }

  const openTutorial = async () => {
    const result = openTab(tabs, { type: 'tutorial', sessionId: TUTORIAL_TAB_ID, title: 'Profer 使用教程' })
    setTabs(result.tabs)
    setActiveTabId(result.activeTabId)
    await handleDismiss()
  }

  const replayTour = async () => {
    setCoachTourOpen(true)
    await handleDismiss()
  }

  if (dismissed) return null

  return (
    <div
      className={`fixed bottom-6 right-6 z-[100] w-[352px] transition-all duration-500 ease-out ${
        visible ? 'translate-y-0 opacity-100' : 'translate-y-3 opacity-0 pointer-events-none'
      }`}
    >
      <div className="titlebar-no-drag overflow-hidden rounded-2xl border border-border/80 bg-popover/95 shadow-[0_24px_60px_-20px_rgba(0,0,0,0.45)] backdrop-blur-xl">
        {/* 标题行：关闭按钮在流内，与图标、标题同一垂直中线 */}
        <div className="flex items-center gap-3 px-4 pb-3 pt-4">
          <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
            <BookOpen size={17} aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="text-[13px] font-semibold text-foreground">用 5 分钟，把 Profer 用起来</h3>
            <p className="mt-0.5 truncate text-[11px] text-muted-foreground">三条上手路径，随时可以回来</p>
          </div>
          <button
            type="button"
            onClick={handleDismiss}
            aria-label="关闭教程推荐"
            className="-mr-1 grid size-7 shrink-0 place-items-center rounded-lg text-muted-foreground/60 transition-colors hover:bg-foreground/[0.06] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>

        <div className="px-2">
          <PathRow icon={<BookOpen size={14} />} title="5 分钟上手" hint="从 Chat 到 Agent 的最短路径" onClick={openTutorial} />
          <PathRow icon={<Compass size={14} />} title="重播界面导览" hint="高亮每一个入口，跟着点一遍" onClick={replayTour} />
          <PathRow icon={<ListChecks size={14} />} title="看看常见任务" hint="10 个可以直接复制的提示词" onClick={openTutorial} />
        </div>

        <div className="flex items-center gap-2 px-4 pb-4 pt-2">
          <Button size="sm" onClick={openTutorial} className="h-8 flex-1 text-xs">
            打开教程
          </Button>
          <Button size="sm" variant="ghost" onClick={handleDismiss} className="h-8 text-xs text-muted-foreground">
            稍后
          </Button>
        </div>

        <p className="border-t border-border/60 px-4 py-2 text-center text-[10px] text-muted-foreground/60">
          之后可从「设置 → 帮助 → Profer 教程」重新打开
        </p>
      </div>
    </div>
  )
}

function PathRow({
  icon,
  title,
  hint,
  onClick,
}: {
  icon: React.ReactNode
  title: string
  hint: string
  onClick: () => void
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left transition-colors hover:bg-foreground/[0.04]"
    >
      <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-muted/60 text-muted-foreground group-hover:text-foreground">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[12px] font-medium text-foreground/90">{title}</span>
        <span className="block truncate text-[10.5px] text-muted-foreground">{hint}</span>
      </span>
      <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/40 transition-colors group-hover:text-foreground/70" aria-hidden="true" />
    </button>
  )
}
