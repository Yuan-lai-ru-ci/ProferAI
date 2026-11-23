import * as React from 'react'
import { cn } from '@/lib/utils'
import { attachScrollbarReveal } from './scrollbar-reveal'

/**
 * 普通滚动容器；显隐由共享 reveal 管理，配色与尺寸由全局 token 决定。
 * 转发同一个 DOM ref，保留调用方的测量、滚动与焦点能力。
 */
export const ScrollRegion = React.forwardRef<HTMLDivElement, React.ComponentPropsWithoutRef<'div'>>(
  function ScrollRegion({ className, children, ...props }, forwardedRef): React.ReactElement {
    const ref = React.useRef<HTMLDivElement | null>(null)
    const setRef = React.useCallback((element: HTMLDivElement | null) => {
      ref.current = element
      if (typeof forwardedRef === 'function') forwardedRef(element)
      else if (forwardedRef) forwardedRef.current = element
    }, [forwardedRef])

    React.useLayoutEffect(() => {
      const element = ref.current
      if (!element) return
      const reveal = attachScrollbarReveal(element, { watchElement: element })
      // 惯性滚动不会每帧触发 wheel，仅在已显现时顺延隐藏时间。
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
      <div ref={setRef} className={cn('profer-scroll-region', className)} {...props}>
        {children}
      </div>
    )
  },
)
