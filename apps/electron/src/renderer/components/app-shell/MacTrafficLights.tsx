/**
 * macOS 自定义红绿灯。
 *
 * Electron 原生 traffic lights 只支持调整位置，不支持调整尺寸；主窗口使用 110% 页面缩放后，
 * 原生按钮与左侧 rail 的比例会失真，因此在渲染层用可控尺寸的按钮替代。
 */

import * as React from 'react'
import { cn } from '@/lib/utils'

interface MacTrafficLightsProps {
  /** 经典界面的外层侧栏有 8px 内边距，按钮需要扣除这段偏移。 */
  classic?: boolean
  /** 侧边栏收起时缩小控制区，避免窄 rail 裁掉第三个按钮。 */
  collapsed?: boolean
  className?: string
}

const trafficLights = [
  { color: 'bg-[#ff5f57]', hoverColor: 'group-hover:bg-[#ff756e]', label: '关闭', action: 'close' as const },
  { color: 'bg-[#febc2e]', hoverColor: 'group-hover:bg-[#ffca4f]', label: '最小化', action: 'minimize' as const },
  { color: 'bg-[#28c840]', hoverColor: 'group-hover:bg-[#42d65a]', label: '最大化', action: 'maximize' as const },
]

export function MacTrafficLights({ classic = false, collapsed = false, className }: MacTrafficLightsProps): React.ReactElement {
  const handleAction = (action: (typeof trafficLights)[number]['action']): void => {
    if (action === 'close') void window.electronAPI.windowClose()
    else if (action === 'minimize') void window.electronAPI.windowMinimize()
    else void window.electronAPI.windowMaximize()
  }

  return (
    <div
      className={cn(
        'mac-traffic-lights titlebar-no-drag pointer-events-auto absolute z-[999] flex items-center gap-[3px]',
        collapsed
          ? 'left-1/2 top-[18px] -translate-x-1/2 gap-[2px]'
          : classic ? 'left-2.5 top-2.5' : 'left-[18px] top-[18px]',
        className,
      )}
      role="group"
      aria-label="窗口控制"
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      style={{
        WebkitAppRegion: 'no-drag',
        pointerEvents: 'auto',
        position: 'absolute',
        zIndex: 999,
      } as React.CSSProperties}
    >
      {trafficLights.map((light) => (
        <button
          key={light.action}
          type="button"
          aria-label={light.label}
          title={light.label}
          onClick={(event) => {
            event.stopPropagation()
            handleAction(light.action)
          }}
          onPointerDown={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
          style={{
            WebkitAppRegion: 'no-drag',
            pointerEvents: 'auto',
          } as React.CSSProperties}
          className={cn(
            'mac-traffic-light-hitbox group pointer-events-auto flex shrink-0 cursor-pointer items-center justify-center rounded-full',
            collapsed ? 'size-3.5' : 'size-5',
            'hover:bg-black/[0.05] active:bg-black/[0.1] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring',
          )}
        >
          <span
            aria-hidden="true"
            className={cn(
              'pointer-events-none rounded-full border border-black/10 shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.08)] transition-[filter,transform] duration-100',
              collapsed ? 'size-2' : 'size-3',
              light.color,
              light.hoverColor,
            )}
          />
        </button>
      ))}
    </div>
  )
}
