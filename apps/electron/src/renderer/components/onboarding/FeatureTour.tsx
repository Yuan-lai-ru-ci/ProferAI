import * as React from 'react'
import {
  ArrowUpRight,
  Bot,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock3,
  FolderOpen,
  MessageSquare,
  Mic,
  Puzzle,
  X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { IntroFluidBackground } from './IntroFluidBackground'

interface FeatureSlide {
  title: string
  summary: string
  example: string
}

const TOUR_INTERVAL_MS = 7000
const TOUR_TRANSITION_MS = 600

const FEATURE_TOUR_SLIDES: FeatureSlide[] = [
  { title: 'Chat', summary: '问任何事。', example: '把这段话改成正式邮件' },
  { title: 'Agent', summary: '把事情交给它。', example: '分析 @销售.xlsx，给我一份报告' },
  { title: '工作区', summary: '让文件成为上下文。', example: '按模板重写 @报告.md' },
  { title: 'Skills', summary: '把重复工作留下来。', example: '创建一个写周报的 Skill' },
  { title: '自动化', summary: '让任务自己发生。', example: '每周一整理项目进展并提醒我' },
  { title: '手机操作', summary: '随时继续你的工作。', example: '在手机上继续处理这个任务' },
]

interface FeatureTourProps {
  onNext: () => void
  onSkip: () => void
  finishLabel: string
}

export function FeatureTour({ onNext, onSkip, finishLabel }: FeatureTourProps): React.ReactElement {
  const [activeIndex, setActiveIndex] = React.useState(0)
  const [pendingIndex, setPendingIndex] = React.useState<number | null>(null)
  const [phase, setPhase] = React.useState<'idle' | 'exiting' | 'entering'>('idle')
  const [direction, setDirection] = React.useState<1 | -1>(1)
  const [backgroundEpoch, setBackgroundEpoch] = React.useState(0)
  const isTransitioning = phase !== 'idle'
  const isLast = activeIndex === FEATURE_TOUR_SLIDES.length - 1

  const navigate = React.useCallback((nextIndex: number) => {
    if (isTransitioning || nextIndex === activeIndex) return
    setDirection(nextIndex > activeIndex ? 1 : -1)
    setPendingIndex(nextIndex)
    setPhase('exiting')
  }, [activeIndex, isTransitioning])

  const previous = React.useCallback(() => {
    navigate(Math.max(0, activeIndex - 1))
  }, [activeIndex, navigate])

  const next = React.useCallback(() => {
    if (isLast) {
      onNext()
      return
    }
    navigate(activeIndex + 1)
  }, [activeIndex, isLast, navigate, onNext])

  React.useEffect(() => {
    if (phase === 'exiting') {
      const timer = window.setTimeout(() => {
        setActiveIndex(pendingIndex!)
        setPhase('entering')
      }, TOUR_TRANSITION_MS)
      return () => window.clearTimeout(timer)
    }
    if (phase === 'entering') {
      const timer = window.setTimeout(() => {
        setPendingIndex(null)
        setPhase('idle')
        setBackgroundEpoch(epoch => epoch + 1)
      }, TOUR_TRANSITION_MS)
      return () => window.clearTimeout(timer)
    }
  }, [pendingIndex, phase])

  React.useEffect(() => {
    if (phase !== 'idle') return
    const timer = window.setTimeout(next, TOUR_INTERVAL_MS)
    return () => window.clearTimeout(timer)
  }, [activeIndex, next, phase])

  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        previous()
      } else if (event.key === 'ArrowRight' || event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        next()
      } else if (event.key === 'Escape') {
        event.preventDefault()
        onSkip()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [next, onSkip, previous])

  return (
    <section className="relative -m-8 flex h-screen w-screen overflow-hidden bg-black text-white" aria-label="Profer 功能导览">
      <IntroFluidBackground key={backgroundEpoch} durationMs={TOUR_INTERVAL_MS} />
      <div key={`veil-${backgroundEpoch}`} className="feature-tour-veil pointer-events-none absolute inset-0 z-[1] bg-[linear-gradient(90deg,rgba(0,0,0,.82)_0%,rgba(0,0,0,.52)_42%,rgba(0,0,0,.12)_100%)]" />
      <div className="pointer-events-none absolute inset-0 z-[1] bg-[radial-gradient(ellipse_at_64%_50%,transparent_4%,rgba(0,0,0,.26)_76%,rgba(0,0,0,.55)_100%)]" />

      <div className="relative z-10 flex w-full flex-col px-8 py-7 sm:px-14 sm:py-10">
        <header className="flex items-center justify-between">
          <span className="font-mono text-[10px] tracking-[0.3em] text-white/45">PROFER / 00{activeIndex + 1}</span>
          <Button variant="ghost" size="icon" onClick={onSkip} className="text-white/55 hover:bg-white/10 hover:text-white" aria-label="跳过介绍">
            <X className="h-4 w-4" />
          </Button>
        </header>

        <main className="flex flex-1 items-center">
          <div className="relative w-full max-w-xl sm:ml-[10vw]">
            <TourSlide
              key={`${activeIndex}-${phase}`}
              index={activeIndex}
              direction={direction}
              phase={phase === 'exiting' ? 'outgoing' : phase === 'entering' ? 'incoming' : 'idle'}
            />
          </div>
        </main>

        <footer className="flex items-center justify-between gap-4">
          <Button variant="ghost" onClick={previous} disabled={activeIndex === 0 || isTransitioning} className="text-white/65 hover:bg-white/10 hover:text-white disabled:text-white/20">
            <ChevronLeft className="mr-1 h-4 w-4" />
            上一步
          </Button>
          <div className="flex items-center gap-2" role="tablist" aria-label="功能导览进度">
            {FEATURE_TOUR_SLIDES.map((item, index) => (
              <button
                key={item.title}
                type="button"
                role="tab"
                aria-label={`查看第 ${index + 1} 项：${item.title}`}
                aria-selected={index === activeIndex}
                onClick={() => navigate(index)}
                disabled={isTransitioning}
                className={cn(
                  'h-1.5 rounded-full transition-all duration-300 disabled:cursor-default',
                  index === activeIndex ? 'w-8 bg-white shadow-[0_0_12px_rgba(255,255,255,.7)]' : 'w-1.5 bg-white/30 hover:bg-white/55',
                )}
              />
            ))}
          </div>
          <Button onClick={next} disabled={isTransitioning} className="bg-white text-black hover:bg-white/85">
            {isLast ? finishLabel : '继续'}
            {isLast ? <Check className="ml-1 h-4 w-4" /> : <ChevronRight className="ml-1 h-4 w-4" />}
          </Button>
        </footer>
      </div>
    </section>
  )
}

function TourSlide({
  index,
  direction,
  phase,
}: {
  index: number
  direction: 1 | -1
  phase: 'idle' | 'incoming' | 'outgoing'
}): React.ReactElement {
  const slide = FEATURE_TOUR_SLIDES[index]!
  return (
    <div
      className={cn(
        'feature-tour-slide flex w-full flex-col items-start text-left',
        phase === 'incoming' ? 'feature-tour-slide-incoming' : phase === 'outgoing' ? 'feature-tour-slide-outgoing' : 'feature-tour-slide-idle',
        direction === 1 ? 'feature-tour-forward' : 'feature-tour-backward',
      )}
    >
      <p className="feature-tour-kicker font-mono text-[11px] tracking-[0.24em] text-white/45">WHAT PROFER CAN DO</p>
      <h2 className="feature-tour-title mt-4 text-5xl font-semibold tracking-normal sm:text-7xl">{slide.title}</h2>
      <p className="feature-tour-summary mt-5 text-lg text-white/70 sm:text-xl">{slide.summary}</p>
      <div className="feature-tour-example mt-11 flex items-center gap-3 border-b border-white/30 pb-3 text-sm text-white/90 sm:text-base">
        <ArrowUpRight className="h-4 w-4 shrink-0 text-white/50" />
        <span>“{slide.example}”</span>
      </div>
    </div>
  )
}

export { FEATURE_TOUR_SLIDES }
