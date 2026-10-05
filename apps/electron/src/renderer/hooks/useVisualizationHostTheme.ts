import * as React from 'react'
import { useAtomValue } from 'jotai'

import { activeSkinIdAtom, resolvedThemeAtom, skinCssAppliedRevisionAtom, whenSkinCssApplied } from '@/atoms/theme'
import { createVisualizationThemeChannel, readVisualizationHostTheme, type VisualizationHostTheme } from '@/lib/visualization-host-theme'

/**
 * 订阅宿主主题，供会话内可视化使用（iframe 片段 + 原生图表）。
 *
 * 三条订阅缺一不可：
 * - `documentElement` 属性（class/style/data-theme）：明暗切换、皮肤类切换是同步的，立即重发；
 * - `skinCssAppliedRevisionAtom` + `whenSkinCssApplied`：皮肤 CSS 是异步 IPC 注入的，
 *   注入落地后必须**再取一次值**（此时 documentElement 属性已经没变化了，Observer 收不到）；
 * - `activeSkinIdAtom` / `resolvedThemeAtom`：换肤/换明暗时即使 CSS 已在途也要重新排队等待。
 *
 * 只订阅 atom 不订阅 DOM 属性会漏掉非皮肤路径（如直接改 `:root` 内联变量）；
 * 只订阅 DOM 属性则正是「换肤后颜色不跟随」那个 bug 的成因，别退回那种写法。
 */
export function useVisualizationHostTheme(): VisualizationHostTheme {
  const skinId = useAtomValue(activeSkinIdAtom)
  const resolvedTheme = useAtomValue(resolvedThemeAtom)
  const skinCssRevision = useAtomValue(skinCssAppliedRevisionAtom)
  const [theme, setTheme] = React.useState<VisualizationHostTheme>(readVisualizationHostTheme)
  const skinIdRef = React.useRef(skinId)
  skinIdRef.current = skinId
  const channel = React.useMemo(
    () =>
      createVisualizationThemeChannel({
        read: readVisualizationHostTheme,
        skinId: () => skinIdRef.current,
        whenSkinCssApplied,
        publish: setTheme,
      }),
    [],
  )

  React.useEffect(() => {
    const observer = new MutationObserver(() => channel.publishNow())
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] })
    return () => observer.disconnect()
  }, [channel])

  React.useEffect(() => {
    void channel.refresh()
  }, [channel, skinId, resolvedTheme, skinCssRevision])

  return theme
}

export default useVisualizationHostTheme
