/**
 * WindowControls - Windows 自定义窗口控制按钮（最小化/最大化/关闭）
 * 仅 Windows 平台渲染，替换 Electron 原生 titleBarOverlay 按钮。
 */

import * as React from 'react'
import { Copy, Minus, Square, X } from 'lucide-react'
import { detectIsWindows } from '@/lib/platform'
import { cn } from '@/lib/utils'

interface WindowControlsProps {
  variant?: 'fixed' | 'inline'
  className?: string
}

export function WindowControls({
  variant = 'fixed',
  className,
}: WindowControlsProps): React.ReactElement | null {
  const isWindows = React.useMemo(() => detectIsWindows(), [])
  const [isMaximized, setIsMaximized] = React.useState(false)

  // 初始化最大化状态并监听窗口 resize 事件
  React.useEffect(() => {
    if (!isWindows) return
    window.electronAPI.windowIsMaximized().then(setIsMaximized)
    const unsub = window.electronAPI.onWindowResize(() => {
      window.electronAPI.windowIsMaximized().then((next) => {
        // 只在状态实际变化时 setState，避免每次 resize 都触发重渲染——
        // Windows 上每次重渲染都会让 Chromium 重算可拖拽区域，期间存在数十 ms 的 stale 窗口，
        // 用户在此窗口内点击按钮会被 OS 误判为标题栏点击。
        setIsMaximized((prev) => (prev === next ? prev : next))
      })
    })
    return unsub
  }, [isWindows])

  if (!isWindows) return null

  return (
    <div className={cn(
      'window-controls flex select-none',
      variant === 'fixed' ? 'fixed top-[2px] right-[8px] z-[100]' : 'relative z-30 shrink-0',
      className,
    )}>
      {/* Windows 原生语义顺序：最小化 → 最大化/还原 → 关闭。图标来自 Lucide 开源图标集。 */}
      <button
        type="button"
        className="window-control-btn"
        aria-label="最小化"
        onClick={() => window.electronAPI.windowMinimize()}
      >
        <Minus className="size-3.5" strokeWidth={1.5} aria-hidden="true" />
      </button>

      <button
        type="button"
        className="window-control-btn"
        aria-label={isMaximized ? '还原' : '最大化'}
        onClick={() => window.electronAPI.windowMaximize()}
      >
        {isMaximized ? (
          <Copy className="size-3.5" strokeWidth={1.5} aria-hidden="true" />
        ) : (
          <Square className="size-3.5" strokeWidth={1.5} aria-hidden="true" />
        )}
      </button>

      <button
        type="button"
        className="window-control-btn window-control-close"
        aria-label="关闭"
        onClick={() => window.electronAPI.windowClose()}
      >
        <X className="size-3.5" strokeWidth={1.5} aria-hidden="true" />
      </button>
    </div>
  )
}
