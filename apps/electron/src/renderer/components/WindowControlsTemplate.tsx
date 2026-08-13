import * as React from 'react'
import { WindowControls } from '@/components/WindowControls'
import { detectIsWindows } from '@/lib/platform'

interface WindowControlsHostRegistration {
  id: string
  active: boolean
  priority: number
}

interface WindowControlsTemplateContextValue {
  registerHost: (registration: WindowControlsHostRegistration) => () => void
  updateHost: (registration: WindowControlsHostRegistration) => void
  activeHostId: string | null
}

const WindowControlsTemplateContext = React.createContext<WindowControlsTemplateContextValue | null>(null)

/**
 * 全局窗口按钮模板：同一时刻只将 Windows 最小化/最大化/关闭按钮渲染给优先级最高的可见宿主。
 *
 * 页面只需放置 WindowControlsHost 并声明 active/priority，不再各自判断平台或维护重复按钮。
 * priority 按物理窗口右缘排序：右侧文件栏 > 右侧浏览器 > 团队工作区 > 普通内容顶栏。
 */
export function WindowControlsTemplateProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [hosts, setHosts] = React.useState<Map<string, WindowControlsHostRegistration>>(() => new Map())

  const registerHost = React.useCallback((registration: WindowControlsHostRegistration) => {
    setHosts((previous) => {
      const next = new Map(previous)
      next.set(registration.id, registration)
      return next
    })
    return () => {
      setHosts((previous) => {
        if (!previous.has(registration.id)) return previous
        const next = new Map(previous)
        next.delete(registration.id)
        return next
      })
    }
  }, [])

  const updateHost = React.useCallback((registration: WindowControlsHostRegistration) => {
    setHosts((previous) => {
      const current = previous.get(registration.id)
      if (current?.active === registration.active && current.priority === registration.priority) return previous
      const next = new Map(previous)
      next.set(registration.id, registration)
      return next
    })
  }, [])

  const activeHostId = React.useMemo(() => {
    let selected: WindowControlsHostRegistration | null = null
    for (const host of hosts.values()) {
      if (!host.active || (selected && host.priority <= selected.priority)) continue
      selected = host
    }
    return selected?.id ?? null
  }, [hosts])

  const value = React.useMemo(() => ({ registerHost, updateHost, activeHostId }), [registerHost, updateHost, activeHostId])
  return <WindowControlsTemplateContext.Provider value={value}>{children}</WindowControlsTemplateContext.Provider>
}

interface WindowControlsHostProps {
  id: string
  active?: boolean
  priority: number
  className?: string
}

/** 在页面自身顶栏声明一个窗口控制按钮插槽。 */
export function WindowControlsHost({ id, active = true, priority, className }: WindowControlsHostProps): React.ReactElement | null {
  const context = React.useContext(WindowControlsTemplateContext)
  const { registerHost, updateHost, activeHostId } = context ?? {}
  const isWindows = React.useMemo(() => detectIsWindows(), [])

  React.useEffect(() => {
    if (!registerHost) return
    return registerHost({ id, active, priority })
  }, [registerHost, id])

  React.useEffect(() => {
    updateHost?.({ id, active, priority })
  }, [updateHost, id, active, priority])

  if (!isWindows || !context || activeHostId !== id) return null
  return <WindowControls variant="inline" className={className} />
}
