/**
 * SettingsDialog - 设置浮窗
 *
 * 以 Dialog 浮窗形式展示设置面板，不覆盖主内容区。
 * 使用低级 Dialog 原语实现轻遮罩 + 无默认关闭按钮（关闭按钮由 SettingsPanel 内部提供）。
 */

import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { settingsOpenAtom, channelFormDirtyAtom, settingsCloseRequestedAtom } from '@/atoms/settings-tab'
import { SettingsPanel, type SettingsTabItem } from './SettingsPanel'

export interface SettingsDialogProps {
  /** 受限环境（如外部嵌入入口）传入的 tab 白名单，透传给 SettingsPanel */
  tabsOverride?: SettingsTabItem[]
}

export function SettingsDialog({ tabsOverride }: SettingsDialogProps): React.ReactElement {
  const [open, setOpen] = useAtom(settingsOpenAtom)
  const channelFormDirty = useAtomValue(channelFormDirtyAtom)
  const setCloseRequested = useSetAtom(settingsCloseRequestedAtom)
  const dialogRef = React.useRef<HTMLDivElement>(null)

  // 遮罩点击和 Esc 与面板关闭按钮共用未保存确认流程。
  const handleOpenChange = (nextOpen: boolean): void => {
    if (!nextOpen && channelFormDirty) {
      setCloseRequested(true)
      return
    }
    setOpen(nextOpen)
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={handleOpenChange}>
      <DialogPrimitive.Portal>
        {/* 变暗不再用独立的整屏 Overlay：改由内容层的 .dialog-dim 扩散阴影承担。
         *
         * 两个已知原因都不允许再走独立的 fixed 遮罩层：
         * 1. 加 backdrop-blur 会让背景任何重绘触发整张背景纹理重新采样，遮罩区域周期性闪动
         *    （v0.9.11 #340、v0.9.40、#873 都因此移除过）；
         * 2. 即使不加模糊，整屏固定遮罩在 macOS 高刷屏上滚动时也会偶发整层漏画一帧，
         *    表现为“遮罩消失、页面亮一下”（2026-11-13 逐帧定位）。 */}
        <DialogPrimitive.Content
          ref={dialogRef}
          onOpenAutoFocus={(event) => {
            // 按实际可见控件选初始焦点，避免隐藏侧栏或跳转按钮抢占开窗焦点。
            const controls = dialogRef.current?.querySelectorAll<HTMLInputElement | HTMLSelectElement>('#settings-nav-search, #settings-mobile-nav')
            for (const control of controls ?? []) {
              if (control.disabled || control.getClientRects().length === 0) continue
              control.focus({ preventScroll: true })
              if (control.ownerDocument.activeElement === control) {
                event.preventDefault()
                break
              }
            }
          }}
          data-browser-blocking
          className="settings-dialog dialog-dim fixed left-[50%] top-[50%] z-[100] translate-x-[-50%] translate-y-[-50%] h-[calc(100dvh-24px)] w-[calc(100vw-24px)] max-h-[860px] max-w-[1120px] overflow-hidden rounded-lg border border-surface-border/60 bg-dialog text-dialog-foreground titlebar-no-drag md:h-[88dvh] md:w-[92vw] motion-safe:transition-all motion-safe:duration-100 data-[state=open]:opacity-100 data-[state=closed]:opacity-0"
        >
          <DialogPrimitive.Title className="sr-only">设置</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">应用偏好、模型与连接配置</DialogPrimitive.Description>
          <SettingsPanel onClose={() => setOpen(false)} tabsOverride={tabsOverride} />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
