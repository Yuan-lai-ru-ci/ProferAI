/**
 * CoachTourOverlay — 界面蒙层引导（Coach Tour）
 *
 * 触发：coachTourOpenAtom（设置页「重新播放界面引导」/ Onboarding 完成后自动接力 /
 * 启动时引导版本偏低的自动重播）。
 *
 * 引擎行为（v9 重写）：
 *  - 只在「切步、窗口尺寸变化、锚点容器尺寸变化」时测量锚点，不再每帧
 *    querySelectorAll + getComputedStyle。旧版用 rAF 逐帧测量，120Hz 屏上每秒
 *    120 次强制样式重算与布局读取，是导览「很卡」的主要来源。
 *  - 切步后连采一小段覆盖侧栏/面板过渡动画，布局稳定后停止采样，静止时零开销。
 *  - 键盘：→/Enter 下一步，← 上一步，Esc 退出；Tab 焦点限制在气泡内。
 *  - 点击遮罩任意处前进（不要求点中高亮区，避免点歪卡住）。
 *  - 不切换主内容区视图：用户在哪就在哪，引导只做说明。
 *  - 尊重 prefers-reduced-motion。
 */

import * as React from 'react'
import { createPortal } from 'react-dom'
import { useAtom } from 'jotai'
import { Check, ChevronLeft, X } from 'lucide-react'
import { toast } from 'sonner'
import { coachTourOpenAtom } from '@/atoms/coach-tour-atoms'
import { Button } from '@profer/ui/primitives/button'
import { cn } from '@/lib/utils'
import { COACH_TOUR_STEPS, CURRENT_COACH_TOUR_VERSION, type CoachTourStep } from './coach-tour-steps'
import { computeCardLayout, unionRects, type AnchorRect, type CardSize } from './coach-tour-position'
import { claimCoachTourOwnership } from './coach-tour-owner'

/** 未测量前的气泡估算尺寸；首个 layout effect 会用真实值收敛 */
const FALLBACK_CARD_SIZE: CardSize = { width: 336, height: 180 }

/**
 * 过渡期间的重测间隔。
 *
 * 侧栏收合、面板展开等动画通常持续 200~320ms；80ms 采样足以让聚光灯跟手，
 * 又比逐帧测量少一个数量级的样式重算。
 */
const FOLLOW_SAMPLE_MS = 80
/** 布局变化后的采样窗口：覆盖动画即可，之后停止，不长期占用主线程。 */
const FOLLOW_TAIL_MS = 480

/** 元素是否真的看得见（尺寸非零、不是 visibility:hidden、不透明、没被折叠容器裁掉）。 */
function isElementVisible(el: HTMLElement, rect: DOMRect): boolean {
  if (rect.width <= 0 || rect.height <= 0) return false
  const style = window.getComputedStyle(el)
  if (style.visibility === 'hidden' || style.display === 'none') return false
  // 侧栏收起时，收起态的入口放在 grid-template-rows: 0fr + opacity: 0 的容器里。
  // 这些元素仍有非零 rect，只按 display/visibility 判断会高亮到用户看不见的按钮。
  if (Number.parseFloat(style.opacity || '1') === 0) return false
  // Chromium 原生可见性判定：同时覆盖 opacity:0 与 content-visibility 隐藏。
  const checkVisibility = (el as HTMLElement & {
    checkVisibility?: (options?: { checkOpacity?: boolean; checkVisibilityCSS?: boolean }) => boolean
  }).checkVisibility
  if (typeof checkVisibility === 'function' && !checkVisibility.call(el, { checkOpacity: true, checkVisibilityCSS: true })) {
    return false
  }
  // 与被裁剪的祖先求交：折叠容器里的元素 rect 可能落在容器外。
  let clipped: DOMRect = rect
  for (let node = el.parentElement; node; node = node.parentElement) {
    const nodeStyle = window.getComputedStyle(node)
    if (nodeStyle.overflow === 'hidden' || nodeStyle.overflowY === 'hidden' || nodeStyle.overflowX === 'hidden') {
      const box = node.getBoundingClientRect()
      const left = Math.max(clipped.left, box.left)
      const top = Math.max(clipped.top, box.top)
      const right = Math.min(clipped.right, box.right)
      const bottom = Math.min(clipped.bottom, box.bottom)
      if (right - left <= 0 || bottom - top <= 0) return false
      clipped = new DOMRect(left, top, right - left, bottom - top)
    }
  }
  return true
}

/** 收集某选择器下所有可见且非零尺寸的元素矩形 */
function collectVisibleRects(selector: string): AnchorRect[] {
  const rects: AnchorRect[] = []
  for (const el of document.querySelectorAll<HTMLElement>(selector)) {
    const rect = el.getBoundingClientRect()
    if (isElementVisible(el, rect)) {
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
 * 把聚光灯几何钳制进视口：锚点本身顶满窗口时（如技能/记忆全屏页），
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

function rectKey(rect: AnchorRect | null): string {
  return rect
    ? `${rect.left.toFixed(1)}|${rect.top.toFixed(1)}|${rect.width.toFixed(1)}|${rect.height.toFixed(1)}`
    : 'none'
}

export function CoachTourOverlay(): React.ReactElement | null {
  const [open, setOpen] = useAtom(coachTourOpenAtom)
  const [stepIndex, setStepIndex] = React.useState(0)
  const [rect, setRect] = React.useState<AnchorRect | null>(null)
  const [cardSize, setCardSize] = React.useState<CardSize>(FALLBACK_CARD_SIZE)
  const cardRef = React.useRef<HTMLDivElement>(null)

  const totalSteps = COACH_TOUR_STEPS.length
  const step = COACH_TOUR_STEPS[stepIndex]
  const isLast = stepIndex === totalSteps - 1

  // 打开时回到第一步
  React.useEffect(() => {
    if (!open) return
    setStepIndex(0)
  }, [open])

  // 关闭（完成 / Esc / 点击 ×）即视为看过：写入当前引导版本
  const close = React.useCallback(() => {
    setOpen(false)
    window.electronAPI.updateSettings({ coachTourVersion: CURRENT_COACH_TOUR_VERSION }).catch((error) => {
      console.error('[CoachTour] 持久化引导版本失败:', error)
    })
  }, [setOpen])

  const finish = React.useCallback(() => {
    close()
    toast.success('引导完成，可从 设置 → 通用 → 重新播放界面引导')
  }, [close])

  // 跨窗口单例：另一窗口正在播放时静默让位（写版本与正常退出同路径）。
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

  const previous = React.useCallback(() => {
    setStepIndex((current) => Math.max(0, current - 1))
  }, [])

  /**
   * 锚点测量：切步 / 窗口尺寸变化 / 锚点容器尺寸变化时重测。
   *
   * 布局静止时这里零开销 —— 旧版是每帧都跑。
   */
  React.useEffect(() => {
    if (!open || !step) return
    let cancelled = false
    let lastKey = ''
    let timer: number | null = null
    let observer: ResizeObserver | null = null

    const measure = (): void => {
      if (cancelled) return
      const found = findStepRect(step)
      const key = rectKey(found)
      if (key !== lastKey) {
        lastKey = key
        setRect(found)
      }
    }

    const sampleFor = (durationMs: number): void => {
      const deadline = performance.now() + durationMs
      const tick = (): void => {
        if (cancelled) return
        measure()
        timer = performance.now() < deadline ? window.setTimeout(tick, FOLLOW_SAMPLE_MS) : null
      }
      tick()
    }

    measure()
    sampleFor(FOLLOW_TAIL_MS)

    window.addEventListener('resize', measure)
    if (typeof ResizeObserver === 'function') {
      observer = new ResizeObserver(() => {
        measure()
        // 尺寸真的变了（侧栏收合、面板展开）时补一段采样覆盖过渡动画
        if (timer === null) sampleFor(FOLLOW_TAIL_MS)
      })
      observer.observe(document.body)
    }

    return () => {
      cancelled = true
      if (timer !== null) window.clearTimeout(timer)
      window.removeEventListener('resize', measure)
      observer?.disconnect()
    }
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

  // 键盘：Esc 退出，→/Enter 前进，← 后退，Tab 困在气泡内
  React.useEffect(() => {
    if (!open) return
    const handleKeyDown = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null
      const onControl = Boolean(target?.closest('button, a, input, textarea, select'))
      if (event.key === 'Escape') {
        event.preventDefault()
        close()
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault()
        previous()
      } else if (event.key === 'Tab') {
        trapTabKey(event, cardRef.current)
      } else if (event.key === 'ArrowRight' || (event.key === 'Enter' && !onControl)) {
        event.preventDefault()
        next()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [open, close, next, previous])

  if (!open || !step) return null

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const isFinale = step.finale === true
  const cardLayout = computeCardLayout(rect, cardSize, step.placement, {
    width: window.innerWidth,
    height: window.innerHeight,
  })
  const transition = reduceMotion
    ? 'none'
    : 'left 0.28s cubic-bezier(0.22,1,0.36,1), top 0.28s cubic-bezier(0.22,1,0.36,1)'
  const frame = rect ? clampFrameToViewport(rect) : null

  return createPortal(
    <div className="titlebar-no-drag pointer-events-none fixed inset-0 z-[9800]">
      {/* 点击遮罩任意处前进：比旧版「必须点中高亮区」宽容，也不会卡住流程 */}
      <div className="pointer-events-auto absolute inset-0" onClick={next} aria-hidden="true" />

      {/* 聚光灯：box-shadow 巨影形成遮罩镂空；pointer-events-none 让点击穿透到捕获层。
          几何钳制进视口，否则顶满窗口的锚点会让白圈缺边 */}
      {frame ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute rounded-lg"
          style={{
            left: frame.left,
            top: frame.top,
            width: frame.width,
            height: frame.height,
            // 环用 foreground 而不是白色：浅色主题下白环贴在被点亮区域上完全不可见。
            boxShadow: '0 0 0 2px hsl(var(--primary)), 0 0 0 9999px rgba(0,0,0,0.52)',
            transition,
          }}
        />
      ) : (
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-black/52" />
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
          'titlebar-no-drag pointer-events-auto absolute w-[336px] rounded-xl border border-border bg-popover p-4 text-popover-foreground shadow-xl outline-none',
          isFinale && 'w-[360px]',
          !reduceMotion && 'animate-in fade-in-0 duration-150',
        )}
        onClick={(event) => event.stopPropagation()}
      >
        {isFinale ? (
          <FinaleCard step={step} onFinish={finish} />
        ) : (
          <>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <span className="font-mono text-[10px] tracking-[0.14em] text-muted-foreground">
                  {String(stepIndex + 1).padStart(2, '0')} / {String(totalSteps).padStart(2, '0')}
                </span>
                <h3 className="mt-1 text-[13px] font-semibold leading-tight">{step.title}</h3>
              </div>
              <button
                type="button"
                aria-label="退出引导"
                onClick={close}
                className="-mr-1 -mt-0.5 grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X size={13} />
              </button>
            </div>

            <p className="mt-2 text-[12px] leading-[1.65] text-muted-foreground">{step.body}</p>

            <div className="mt-3.5 flex items-center justify-between border-t border-border pt-2.5">
              <div className="flex items-center gap-1" aria-hidden="true">
                {COACH_TOUR_STEPS.map((item, index) => (
                  <span
                    key={item.key}
                    className={cn(
                      'h-1 rounded-full transition-all duration-200',
                      index === stepIndex ? 'w-3.5 bg-foreground' : 'w-1 bg-muted-foreground/30',
                    )}
                  />
                ))}
              </div>
              <div className="flex items-center gap-1">
                {stepIndex > 0 && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-[11px] text-muted-foreground"
                    onClick={previous}
                  >
                    <ChevronLeft className="mr-0.5 size-3" />
                    上一步
                  </Button>
                )}
                <Button type="button" size="sm" className="h-7 px-2.5 text-[11px]" onClick={next}>
                  {isLast ? '完成' : '下一步'}
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  )
}

/** 收尾卡片：确认引导结束，并告诉用户下次从哪再找到它 */
function FinaleCard({
  step,
  onFinish,
}: {
  step: CoachTourStep
  onFinish: () => void
}): React.ReactElement {
  return (
    <div>
      <div className="flex items-start gap-3">
        <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground">
          <Check className="size-4" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h3 className="text-[13px] font-semibold leading-tight">{step.title}</h3>
          <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">{step.body}</p>
        </div>
      </div>

      <div className="mt-3.5 border-t border-border pt-3">
        <Button type="button" size="sm" className="h-8 w-full text-[12px]" onClick={onFinish}>
          开始使用
        </Button>
        <p className="mt-2 text-center text-[10px] text-muted-foreground">
          随时可在 设置 → 通用 → 重新播放界面引导
        </p>
      </div>
    </div>
  )
}
