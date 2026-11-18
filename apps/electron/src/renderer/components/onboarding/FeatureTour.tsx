/**
 * FeatureTour — 首次启动的产品导览。
 *
 * 设计原则（v2 重写）：
 *  - **讲能做什么，不讲态度**。旧版每页一个巨型标题（「先问清楚，再动手。」）占掉
 *    半屏，用户看完仍不知道点哪里。现在每页是一句功能说明 + 三条具体能力 +
 *    一张真实界面缩略，标题层级降下来，版面留给「长什么样」。
 *  - **与主界面同一套 token**。不再用暖纸 + 颗粒 + 洗层那套独立视觉：它的配色和
 *    产品实际界面不是同一个东西，进入主界面会有明显的「换了个软件」的断裂感。
 *  - **4 页封顶**。首次进入时用户最大的诉求是开始干活，不是上培训课。
 *  - 不自动翻页：节奏交给用户；←/→/Esc 与底部按钮都能操作。
 */

import * as React from 'react'
import { ArrowRight, X } from 'lucide-react'
import { Button } from '@profer/ui/primitives/button'
import { cn } from '@/lib/utils'
import { AgentMock, ChatMock, PlanningMock, WorkspaceMock } from './tour-mocks'

interface TourSlide {
  key: string
  /** 小标签，用产品里的叫法（Agent / Chat / 工作区 / 规划） */
  kicker: string
  title: string
  summary: string
  bullets: string[]
  /** 一句可以直接照着说的话，降低「不知道从哪问起」的门槛 */
  example: string
  Mock: () => React.ReactElement
}

const FEATURE_TOUR_SLIDES: TourSlide[] = [
  {
    key: 'agent',
    kicker: 'Agent',
    title: '说清目标，它把事做完',
    summary: '拆步骤、读文件、跑命令，做完回来汇报。你只需要说清要什么结果。',
    bullets: ['多步任务自动推进', '改了哪些文件可以直接对照', '结果落到工作区，不只在聊天里'],
    example: '分析 @销售.xlsx，找出下滑原因，写成报告',
    Mock: AgentMock,
  },
  {
    key: 'chat',
    kicker: 'Chat',
    title: '不需要工作区的轻问答',
    summary: '翻译、改写、查资料、想方案。打开就能问，不用先建项目。',
    bullets: ['不绑定工作区', '适合一次性的问答', '和 Agent 会话各自独立'],
    example: '把这段话改成给客户看的正式邮件',
    Mock: ChatMock,
  },
  {
    key: 'workspace',
    kicker: '工作区',
    title: '你的文件就是上下文',
    summary: '用 @ 把文件、文件夹带进对话；每个工作区有自己的记忆和技能。',
    bullets: ['@ 引用文件与目录', '工作区之间互不干扰', '改动可直接对照'],
    example: '按这份模板重写 @季度总结.md',
    Mock: WorkspaceMock,
  },
  {
    key: 'planning',
    kicker: '规划',
    title: '重复的事交给定时任务',
    summary: 'Todo 记要做的、日程排时间、定时任务到点自动跑，结果写回会话。',
    bullets: ['三个入口各自独立', '到点自动执行', '跑完推送提醒'],
    example: '每周一早九点整理上周进展并提醒我',
    Mock: PlanningMock,
  },
]

interface FeatureTourProps {
  onNext: () => void
  onSkip: () => void
  finishLabel: string
}

export function FeatureTour({ onNext, onSkip, finishLabel }: FeatureTourProps): React.ReactElement {
  const [activeIndex, setActiveIndex] = React.useState(0)
  const isLast = activeIndex === FEATURE_TOUR_SLIDES.length - 1
  const slide = FEATURE_TOUR_SLIDES[activeIndex]!

  const goTo = React.useCallback((nextIndex: number) => {
    setActiveIndex(Math.max(0, Math.min(FEATURE_TOUR_SLIDES.length - 1, nextIndex)))
  }, [])

  const next = React.useCallback(() => {
    if (isLast) {
      onNext()
      return
    }
    goTo(activeIndex + 1)
  }, [activeIndex, goTo, isLast, onNext])

  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      // 焦点在控件上时，Enter/Space 交给控件自身，避免抢掉原生激活
      const target = event.target as HTMLElement | null
      const onControl = Boolean(target?.closest('button, [role="tab"], a, input, textarea, select'))
      if (event.key === 'ArrowRight') {
        event.preventDefault()
        next()
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault()
        goTo(activeIndex - 1)
      } else if ((event.key === 'Enter' || event.key === ' ') && !onControl) {
        event.preventDefault()
        next()
      } else if (event.key === 'Escape') {
        event.preventDefault()
        onSkip()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [activeIndex, goTo, next, onSkip])

  return (
    <div className="flex h-screen w-screen flex-col bg-content-area text-foreground" aria-label="Profer 功能导览">
      {/* 顶栏：品牌 + 跳过。窄顶栏，别让 chrome 抢注意力。 */}
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-border px-6">
        <div className="flex items-center gap-2.5">
          <span className="text-[12px] font-semibold tracking-tight">Profer</span>
          <span className="text-[11px] text-muted-foreground">产品导览</span>
        </div>
        <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-[11px] text-muted-foreground" onClick={onSkip}>
          跳过
          <X className="size-3" />
        </Button>
      </header>

      {/* 进度条：4 段，点击可跳 */}
      <div className="flex shrink-0 gap-1 px-6 pt-3" role="tablist" aria-label="导览进度">
        {FEATURE_TOUR_SLIDES.map((item, index) => (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-label={`第 ${index + 1} 页：${item.kicker}`}
            aria-selected={index === activeIndex}
            onClick={() => goTo(index)}
            className="group h-1 flex-1 overflow-hidden rounded-full bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span
              className={cn(
                'block h-full rounded-full bg-foreground transition-all duration-300',
                index <= activeIndex ? 'w-full opacity-80' : 'w-0 opacity-0',
              )}
            />
          </button>
        ))}
      </div>

      {/* 主体：40/60 分栏。视觉区填满整栏高度，缩略不悬空；文案区顶部对齐，避免大留白 */}
      <main className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,400px)_minmax(0,1fr)]">
        <div className="flex flex-col justify-center border-border px-12 py-10 lg:border-r">
          <div key={`${slide.key}-copy`} className="max-w-sm animate-in fade-in-0 duration-200">
            <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
              {slide.kicker} · {activeIndex + 1}/{FEATURE_TOUR_SLIDES.length}
            </span>
            <h2 className="mt-3 text-[30px] font-semibold leading-[1.2] tracking-[-0.025em]">{slide.title}</h2>
            <p className="mt-3 text-[13.5px] leading-relaxed text-muted-foreground">{slide.summary}</p>
            <ul className="mt-5 space-y-2">
              {slide.bullets.map((bullet) => (
                <li key={bullet} className="flex items-start gap-2.5 text-[12.5px] leading-relaxed text-foreground/85">
                  <span className="mt-[7px] size-1 shrink-0 rounded-full bg-muted-foreground/50" aria-hidden="true" />
                  {bullet}
                </li>
              ))}
            </ul>
            <div className="mt-5 flex items-start gap-2 rounded-lg border border-border bg-background/60 px-3 py-2.5">
              <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">示例</span>
              <span className="text-[11.5px] leading-relaxed text-foreground/80">{slide.example}</span>
            </div>
          </div>
        </div>

        {/* 视觉区：做成“工作台”底板（点阵网格 + 垂直居中），让留白读作画布而不是空白 */}
        <div
          key={`${slide.key}-mock`}
          className="relative flex min-h-0 items-center justify-center overflow-hidden bg-muted/40 p-12 animate-in fade-in-0 duration-200"
          style={{
            backgroundImage: 'radial-gradient(hsl(var(--border)) 1px, transparent 1px)',
            backgroundSize: '18px 18px',
          }}
        >
          <div className="w-full max-w-[540px]">
            <slide.Mock />
          </div>
        </div>
      </main>

      <footer className="flex h-16 shrink-0 items-center justify-between border-t border-border px-6">
        <span className="text-[11px] text-muted-foreground">
          {isLast ? '看完就可以开始了' : '← → 切换，Esc 跳过'}
        </span>
        <div className="flex items-center gap-2">
          {activeIndex > 0 && (
            <Button variant="ghost" size="sm" className="h-8 text-[12px]" onClick={() => goTo(activeIndex - 1)}>
              上一页
            </Button>
          )}
          <Button size="sm" className="h-8 gap-1.5 px-3 text-[12px]" onClick={next}>
            {isLast ? finishLabel : '继续'}
            <ArrowRight className="size-3.5" />
          </Button>
        </div>
      </footer>
    </div>
  )
}

export { FEATURE_TOUR_SLIDES }
