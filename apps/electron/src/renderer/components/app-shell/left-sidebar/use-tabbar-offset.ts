import * as React from 'react'

/**
 * 读取「TabBar 外框下沿」相对侧栏顶部的距离。
 *
 * 侧栏列表容器的顶边必须与整个顶栏的底边重合，包含 37px 内容行下方的留白。
 * 主区有 8px 内边距，TabBar 外框为 40px；直接量外框，避免把标签本体当作顶栏高度。
 *
 * 量不到时（首帧、主区尚未挂载）回退到常量，量到后立即校正。
 */
export function useTabBarBottomOffset(fallback: number): number {
  const [offset, setOffset] = React.useState(fallback)

  React.useEffect(() => {
    const measure = (): void => {
      const tabbar = document.querySelector<HTMLElement>('.topbar-editorial')
      const sidebar = document.querySelector<HTMLElement>('[data-profer-sidebar]')
      if (!tabbar || !sidebar) return
      const next = Math.round(
        tabbar.getBoundingClientRect().bottom - sidebar.getBoundingClientRect().top,
      )
      // 只接受正数：窗口最小化/隐藏时 rect 可能全为 0，避免把侧栏顶到负偏移。
      if (next <= 0) return
      setOffset((previous) => (previous === next ? previous : next))
    }

    measure()
    const observer = new ResizeObserver(measure)
    const tabbar = document.querySelector<HTMLElement>('.topbar-editorial')
    const sidebar = document.querySelector<HTMLElement>('[data-profer-sidebar]')
    if (tabbar) observer.observe(tabbar)
    if (sidebar) observer.observe(sidebar)
    window.addEventListener('resize', measure)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [])

  return offset
}
