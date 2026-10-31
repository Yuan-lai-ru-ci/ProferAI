import * as React from 'react'
import { cn } from '@/lib/utils'
import { attachScrollbarReveal } from './scrollbar-reveal'

/**
 * 普通滚动容器 + 与对话区一致的滚动条按需显隐。
 *
 * 滚动条显隐只该有一套规则：用户主动滚动时露出、停手 1.25s 后淡出、鼠标贴右边缘
 * 热区时露出。对话区由 ConversationScrollProvider 接管了这套逻辑，侧栏这类普通
 * 列表容器没有控制器，之前只能用 CSS :hover —— 鼠标停在列表里条子就一直亮着，
 * 和对话区的观感对不上。这里把同一份 reveal 逻辑复用到任意容器上。
 *
 * 颜色/尺寸仍由 `.profer-scroll-region` 统一决定（见 globals.css），容器只需再叠加
 * 自己的布局类（例如侧栏的 `.sidebar-session-scroll` 负责槽位与留白）。
 */
export function ScrollRegion({ className, children, ...props }: React.ComponentProps<'div'>): React.ReactElement {
  const ref = React.useRef<HTMLDivElement | null>(null)

  React.useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const reveal = attachScrollbarReveal(element)
    // 滚动事件负责顺延隐藏时间：惯性滚动期间不会每帧触发 wheel。
    const onScroll = (): void => {
      if (reveal.isVisible()) reveal.reveal()
    }
    element.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      element.removeEventListener('scroll', onScroll)
      reveal.dispose()
    }
  }, [])

  return (
    <div ref={ref} className={cn('profer-scroll-region', className)} {...props}>
      {children}
    </div>
  )
}
