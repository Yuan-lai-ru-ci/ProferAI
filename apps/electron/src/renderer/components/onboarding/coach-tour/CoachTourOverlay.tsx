/**
 * CoachTourOverlay — 界面蒙层引导（Coach Tour）
 *
 * 触发：coachTourOpenAtom（设置页「重新播放界面引导」/ 教程横幅 / Onboarding 完成后自动接力 /
 * 启动时引导版本偏低的自动重播）。
 *
 * 引擎行为：
 *  - 播放期间 rAF 持续跟踪锚点 rect，侧栏收合、视图切换动画中聚光灯实时跟手
 *  - 带 view 的步骤先把主内容区切到对应视图，退出时恢复用户原视图
 *  - 点击遮罩 / → 前进，Esc / 点击 × 退出；Tab 焦点限制在气泡内
 *  - 锚点缺失（对应面板未打开）时气泡居中降级，不阻断流程
 *  - 尊重 prefers-reduced-motion：关闭聚光灯/气泡位移动画
 */

import * as React from 'react'
import { createPortal } from 'react-dom'
import { useAtom, useStore } from 'jotai'
import { Check, Clock3, Layers, Sparkles, X } from 'lucide-react'
import { toast } from 'sonner'
import { coachTourOpenAtom } from '@/atoms/coach-tour-atoms'
import { activeViewAtom, type ActiveView } from '@/atoms/active-view'
import { Button } from '@profer/ui/primitives/button'
import { cn } from '@/lib/utils'
import { COACH_TOUR_STEPS, CURRENT_COACH_TOUR_VERSION, type CoachTourStep } from './coach-tour-steps'
import { computeCardLayout, unionRects, type AnchorRect, type CardSize } from './coach-tour-position'
import { claimCoachTourOwnership } from './coach-tour-owner'

/** 未测量前的气泡估算尺寸；首个 layout effect 会用真实值收敛，避免跳动 */
const FALLBACK_CARD_SIZE: CardSize = { width: 320, height: 190 }

/** 收尾卡片的三个「接下来」建议 */
const FINALE_ACTIONS = [
  { key: 'task', icon: Sparkles, title: '发一个真实任务', hint: '让它分析工作区里的一个文件并给出结论' },
  { key: 'skill', icon: Layers, title: '把流程存成 Skill', hint: '一次写好，下次一句话调用' },
  { key: 'automation', icon: Clock3, title: '设一个定时任务', hint: '每周一自动整理进展并提醒你' },
] as const
const MOVE_TRANSITION = 'left 0.32s cubic-bezier(0.22,1,0.36,1), top 0.32s cubic-bezier(0.22,1,0.36,1), width 0.32s cubic-bezier(0.22,1,0.36,1), height 0.32s cubic-bezier(0.22,1,0.36,1)'

/** 收集某选择器下所有可见且非零尺寸的元素矩形 */
function collectVisibleRects(selector: string): AnchorRect[] {
  const rects: AnchorRect[] = []
  for (const el of document.querySelectorAll<HTMLElement>(selector)) {
    const rect = el.getBoundingClientRect()
    const style = window.getComputedStyle(el)
    if (rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none') {
      rects.push({ left: rect.left, top: rect.top, width: rect.width, height: rect.height })
    }
  }
  return rects
}

/** 解析步骤锚点：unionSelectors 取多容器外接矩形，否则取第一个可见元素 */
function findStepRect(step: CoachTourStep): AnchorRect | null {
  if (step.unionSelectors && step.unionSelectors.length > 0) {
    return unionRects(step.unionSelectors.flatMap(collectVisibleRects))
  }
  for (const selector of step.selectors) {
    const [first] = collectVisibleRects(selector)
    if (first) return first
  }
  return null
}

/** 把 Tab/Shift+Tab 循环限制在气泡内部，焦点不逃逸到被遮罩的真实 UI */
function trapTabKey(event: KeyboardEvent, card: HTMLElement | null): void {
  if (!card) return
  const focusables = Array.from(
    card.querySelectorAll<HTMLElement>('button, [href], input, [tabindex]:not([tabindex="-1"])'),
  ).filter((el) => !el.hasAttribute('disabled') && el.getClientRects().length > 0)
  if (focusables.length === 0) {
    event.preventDefault()
    return
  }
  const first = focusables[0]
  const last = focusables[focusables.length - 1]
  if (!first || !last) return
  const active = document.activeElement
  if (event.shiftKey && (active === first || !card.contains(active))) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && (active === last || !card.contains(active))) {
    event.preventDefault()
    first.focus()
  }
}

/**
 * 把聚光灯几何钳制进视口：锚点本身顶满窗口时（如规划/技能全屏页），
 * ±8px padding 会把白圈画到屏幕外导致框缺边；钳制后四边贴屏幕缘完整可见。
 * 遮罩阴影（9999px 巨影）不受钳制影响。
 */
function clampFrameToViewport(rect: AnchorRect): { left: number; top: number; width: number; height: number } {
  const pad = 8
  const vw = window.innerWidth
  const vh = window.innerHeight
  const left = Math.min(Math.max(rect.left - pad, 0), vw)
  const top = Math.min(Math.max(rect.top - pad, 0), vh)
  const right = Math.max(Math.min(rect.left + rect.width + pad, vw), left)
  const bottom = Math.max(Math.min(rect.top + rect.height + pad, vh), top)
  return { left, top, width: right - left, height: bottom - top }
}

export function CoachTourOverlay(): React.ReactElement | null {
  const store = useStore()
  const [open, setOpen] = useAtom(coachTourOpenAtom)
  const [stepIndex, setStepIndex] = React.useState(0)
  const [rect, setRect] = React.useState<AnchorRect | null>(null)
  const [cardSize, setCardSize] = React.useState<CardSize>(FALLBACK_CARD_SIZE)
  const cardRef = React.useRef<HTMLDivElement>(null)
  /** 打开引导时用户所在的主内容区视图，退出时恢复 */
  const restoreViewRef = React.useRef<ActiveView | null>(null)
  /** 交互步骤中已排定的自动前进定时器，防止连点锚点跳两步 */
  const advanceTimerRef = React.useRef<number | null>(null)

  const totalSteps = COACH_TOUR_STEPS.length
  const step = COACH_TOUR_STEPS[stepIndex]
  const isLast = stepIndex === totalSteps - 1
  /** 交互步骤：镂空放行真实点击，等用户点击锚点后自动前进；锚点缺失时降级为手动下一步 */
  const isClickToAdvance = step?.advanceOn === 'click-anchor'
  const interactive = isClickToAdvance && rect !== null

  // 打开时：回到第一步 + 记住当前视图（退出恢复）
  React.useEffect(() => {
    if (!open) return
    setStepIndex(0)
    restoreViewRef.current = store.get(activeViewAtom)
  }, [open, store])

  // 关闭（完成 / Esc / 点击 ×）即视为看过：恢复原视图 + 写入当前引导版本
  const close = React.useCallback(() => {
    setOpen(false)
    if (restoreViewRef.current) {
      store.set(activeViewAtom, restoreViewRef.current)
      restoreViewRef.current = null
    }
    window.electronAPI.updateSettings({ coachTourVersion: CURRENT_COACH_TOUR_VERSION }).catch((error) => {
      console.error('[CoachTour] 持久化引导版本失败:', error)
    })
  }, [setOpen, store])

  // 最后一步「完成」/遮罩点击/→ 走这里：收尾反馈 + 关团
  const finish = React.useCallback(() => {
    close()
    toast.success('引导完成，随时可从顶栏指南针按钮重播')
  }, [close])

  // 跨窗口单例：另一窗口正在播放时静默让位（并恢复视图/写版本，与正常退出同路径）；
  // 持有期间被后来的窗口抢走锁时同样让位。依赖 open，close 置 false 时 cleanup 释放锁。
  React.useEffect(() => {
    if (!open) return
    const claim = claimCoachTourOwnership(() => close())
    if (!claim) {
      toast.info('另一个窗口正在播放界面引导')
      close()
      return
    }
    return () => claim.release()
  }, [open, close])

  const next = React.useCallback(() => {
    if (isLast) {
      finish()
      return
    }
    setStepIndex((current) => current + 1)
  }, [finish, isLast])
  const restart = React.useCallback(() => setStepIndex(0), [])

  // 切步/退出时清掉未触发的交互前进定时器
  React.useEffect(() => {
    return () => {
      if (advanceTimerRef.current !== null) {
        window.clearTimeout(advanceTimerRef.current)
        advanceTimerRef.current = null
      }
    }
  }, [stepIndex, open])

  // 交互步骤：capture 阶段侦测落在锚点镂空区的真实点击，稍作停顿让视图切换动画启动，再进下一步
  React.useEffect(() => {
    if (!open || !interactive || !rect) return
    const pad = 14 // 聚光灯 padding(8) + 点击容差
    const zone = {
      left: rect.left - pad,
      top: rect.top - pad,
      right: rect.left + rect.width + pad,
      bottom: rect.top + rect.height + pad,
    }
    const handleClick = (event: MouseEvent): void => {
      const inZone =
        event.clientX >= zone.left && event.clientX <= zone.right &&
        event.clientY >= zone.top && event.clientY <= zone.bottom
      if (!inZone || advanceTimerRef.current !== null) return
      advanceTimerRef.current = window.setTimeout(() => {
        advanceTimerRef.current = null
        next()
      }, 350)
    }
    window.addEventListener('click', handleClick, true)
    return () => window.removeEventListener('click', handleClick, true)
  }, [open, interactive, rect, next])

  // 步骤声明了 view 时先切主内容区，聚光灯跟随新视图里的锚点
  React.useEffect(() => {
    if (!open || !step?.view) return
    if (store.get(activeViewAtom) !== step.view) {
      store.set(activeViewAtom, step.view)
    }
  }, [open, step, store])

  // 播放期间 rAF 持续跟踪锚点：视图切换、侧栏收合、布局动画都会实时跟手；
  // rect 未变化时不 setState，不引入额外渲染。
  React.useEffect(() => {
    if (!open || !step) return
    let raf = 0
    let lastKey = ''
    const tick = (): void => {
      const found = findStepRect(step)
      const key = found
        ? `${found.left.toFixed(1)}|${found.top.toFixed(1)}|${found.width.toFixed(1)}|${found.height.toFixed(1)}`
        : 'none'
      if (key !== lastKey) {
        lastKey = key
        setRect(found)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [open, step])

  // 测量气泡真实尺寸，供定位收敛
  React.useLayoutEffect(() => {
    if (!open) return
    const card = cardRef.current
    if (!card) return
    const { offsetWidth, offsetHeight } = card
    if (offsetWidth > 0 && offsetHeight > 0 && (offsetWidth !== cardSize.width || offsetHeight !== cardSize.height)) {
      setCardSize({ width: offsetWidth, height: offsetHeight })
    }
  }, [open, stepIndex, rect, cardSize])

  // 步骤切换后把焦点放进气泡，保证键盘与读屏上下文连续
  React.useEffect(() => {
    if (!open) return
    cardRef.current?.focus()
  }, [open, stepIndex])

  // 键盘：Esc 退出，→ 前进，Tab 困在气泡内（Enter/Space 留给聚焦按钮自身）
  React.useEffect(() => {
    if (!open) return
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        close()
      } else if (event.key === 'ArrowRight') {
        event.preventDefault()
        next()
      } else if (event.key === 'Tab') {
        trapTabKey(event, cardRef.current)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [open, close, next])

  if (!open || !step) return null

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const isFinale = step.finale === true
  const cardLayout = computeCardLayout(rect, cardSize, step.placement, {
    width: window.innerWidth,
    height: window.innerHeight,
  })
  const transition = reduceMotion ? 'none' : MOVE_TRANSITION
  const frame = rect ? clampFrameToViewport(rect) : null

  return createPortal(
    <div className="titlebar-no-drag pointer-events-none fixed inset-0 z-[9800]">
      {/* 点击捕获：手动步骤为整屏点击前进；交互步骤拆成锚点四周的四块惰性挡板，镂空区放行真实点击 */}
      {!interactive && (
        <div
          className={cn('pointer-events-auto absolute inset-0', !rect && 'bg-black/55')}
          onClick={next}
          aria-hidden="true"
        />
      )}
      {interactive && rect && (
        <CaptureAround rect={rect} />
      )}

      {/* 聚光灯：box-shadow 巨影形成遮罩镂空；pointer-events-none 让点击穿透到捕获层。
          几何钳制进视口，否则顶满窗口的锚点会让白圈缺边 */}
      {frame && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute rounded-xl"
          style={{
            left: frame.left,
            top: frame.top,
            width: frame.width,
            height: frame.height,
            boxShadow:
              '0 0 0 2px rgba(255,255,255,0.85), 0 0 24px rgba(255,255,255,0.22), 0 0 0 9999px rgba(0,0,0,0.55)',
            transition,
          }}
        />
      )}

      {/* 交互步骤的呼吸脉冲环：提示「点这里」；reduced-motion 下由 CSS 关闭动画 */}
      {frame && interactive && (
        <div
          aria-hidden="true"
          className="coach-tour-pulse-ring pointer-events-none absolute rounded-xl"
          style={{
            left: frame.left,
            top: frame.top,
            width: frame.width,
            height: frame.height,
            transition,
          }}
        />
      )}

      {/* 引导气泡：普通步骤是标题 + 正文 + 页脚；最后一步换成完成卡片 */}
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-label={`界面引导，第 ${stepIndex + 1} 步，共 ${totalSteps} 步`}
        tabIndex={-1}
        style={{ left: cardLayout.left, top: cardLayout.top, transition }}
        className={cn(
          'titlebar-no-drag pointer-events-auto absolute rounded-2xl border border-border/80 bg-popover/95 text-popover-foreground shadow-[0_28px_80px_-24px_rgba(0,0,0,0.55)] outline-none backdrop-blur-xl',
          isFinale ? 'w-[380px] p-5' : 'w-[344px] p-4',
          !reduceMotion && 'animate-in fade-in-0 zoom-in-95 duration-200',
        )}
        onClick={(event) => event.stopPropagation()}
      >
        {isFinale ? (
          <FinaleCard step={step} onFinish={finish} onRestart={restart} />
        ) : (
          <>
            {/* 内容区按步 key 重挂，切步时交叉淡入，避免文案瞬跳 */}
            <div
              key={step.key}
              className={cn(!reduceMotion && 'animate-in fade-in-0 slide-in-from-bottom-1 duration-200')}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 font-mono text-[9.5px] tracking-[0.1em] text-primary">
                    {String(stepIndex + 1).padStart(2, '0')} / {String(totalSteps).padStart(2, '0')}
                  </span>
                  <h3 className="truncate text-[13.5px] font-semibold">{step.title}</h3>
                </div>
                <button
                  type="button"
                  aria-label="退出引导"
                  onClick={close}
                  className="-mr-1 grid size-7 shrink-0 place-items-center rounded-lg text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                >
                  <X size={14} />
                </button>
              </div>

              <p className="mt-2.5 text-[12.5px] leading-[1.7] text-muted-foreground">{step.body}</p>

              {interactive && (
                <p className="mt-2.5 flex items-center gap-1.5 text-[11px] font-medium text-primary">
                  <span className="inline-block size-1.5 animate-pulse rounded-full bg-primary" aria-hidden="true" />
                  点击高亮区域继续
                </p>
              )}
            </div>

            <div className="mt-4 flex items-center justify-between border-t border-border/60 pt-3">
              {/* 步骤指示点 */}
              <div className="flex items-center gap-1.5" aria-hidden="true">
                {COACH_TOUR_STEPS.map((s, index) => (
                  <span
                    key={s.key}
                    className={cn(
                      'h-1.5 rounded-full transition-all duration-200',
                      index === stepIndex ? 'w-4 bg-primary' : 'w-1.5 bg-muted-foreground/25',
                    )}
                  />
                ))}
              </div>

              <div className="flex items-center gap-1">
                {/* 交互步骤等用户亲自点击锚点；锚点缺失（降级）时恢复手动下一步 */}
                {!interactive && (
                  <Button type="button" size="sm" className="h-7 px-3 text-xs" onClick={next}>
                    {isLast ? '完成' : '下一步'}
                  </Button>
                )}
              </div>
            </div>
          </>
        )}
      </div>

    </div>,
    document.body,
  )
}

/** 收尾卡片：比普通气泡更宽、居中，给出三条下一步建议和两个出口 */
function FinaleCard({
  step,
  onFinish,
  onRestart,
}: {
  step: CoachTourStep
  onFinish: () => void
  onRestart: () => void
}): React.ReactElement {
  return (
    <div className="relative">
      <div
        className="pointer-events-none absolute -inset-x-6 -top-24 h-40 bg-[radial-gradient(ellipse_at_center,hsl(var(--primary)/0.16),transparent_70%)]"
        aria-hidden="true"
      />

      <div className="relative text-center">
        <span className="mx-auto grid size-12 place-items-center rounded-2xl bg-primary text-primary-foreground shadow-[0_16px_40px_-14px_hsl(var(--primary)/0.55)]">
          <Check className="size-5" aria-hidden="true" />
        </span>
        <h3 className="mt-4 text-[18px] font-semibold tracking-[-0.01em]">{step.title}</h3>
        <p className="mx-auto mt-1.5 max-w-[300px] text-[12.5px] leading-relaxed text-muted-foreground">{step.body}</p>
      </div>

      <ul className="relative mt-5 space-y-1.5">
        {FINALE_ACTIONS.map((action) => (
          <li
            key={action.key}
            className="flex items-start gap-3 rounded-xl border border-border/60 bg-muted/30 px-3 py-2.5"
          >
            <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-lg bg-background text-muted-foreground">
              <action.icon className="size-3.5" aria-hidden="true" />
            </span>
            <span className="min-w-0">
              <span className="block text-[12px] font-medium text-foreground/90">{action.title}</span>
              <span className="block text-[10.5px] leading-relaxed text-muted-foreground">{action.hint}</span>
            </span>
          </li>
        ))}
      </ul>

      <div className="relative mt-5 flex items-center gap-2">
        <Button type="button" size="sm" className="h-9 flex-1 text-xs" onClick={onFinish}>
          开始使用
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-9 px-3 text-xs text-muted-foreground"
          onClick={onRestart}
        >
          再看一遍
        </Button>
      </div>
      <p className="relative mt-3 text-center text-[10px] text-muted-foreground/60">随时可从顶栏指南针重播</p>
    </div>
  )
}

/**
 * 交互步骤的镂空挡板：锚点四周四块惰性区域拦截误点，
 * 镂空区不放任何元素，真实 UI 的点击/悬停（含按钮 hover 态）原样生效。
 */
function CaptureAround({ rect }: { rect: AnchorRect }): React.ReactElement {
  const pad = 8
  const vw = window.innerWidth
  const vh = window.innerHeight
  const left = Math.max(0, rect.left - pad)
  const top = Math.max(0, rect.top - pad)
  const right = Math.min(vw, rect.left + rect.width + pad)
  const bottom = Math.min(vh, rect.top + rect.height + pad)
  const panels: Array<{ key: string; left: number; top: number; width: number; height: number }> = [
    { key: 'top', left: 0, top: 0, width: vw, height: top },
    { key: 'bottom', left: 0, top: bottom, width: vw, height: Math.max(0, vh - bottom) },
    { key: 'left', left: 0, top, width: left, height: Math.max(0, bottom - top) },
    { key: 'right', left: right, top, width: Math.max(0, vw - right), height: Math.max(0, bottom - top) },
  ]
  return (
    <>
      {panels
        .filter((panel) => panel.width > 0 && panel.height > 0)
        .map((panel) => (
          <div
            key={panel.key}
            aria-hidden="true"
            className="pointer-events-auto absolute"
            style={{ left: panel.left, top: panel.top, width: panel.width, height: panel.height }}
          />
        ))}
    </>
  )
}
