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
        {/* 轻遮罩 — 与 Dialog primitive 统一使用 Surface Contract overlay。 */}
        <DialogPrimitive.Overlay
          className="fixed inset-0 z-[100] bg-overlay/40 backdrop-blur-sm titlebar-no-drag transition-opacity duration-100 data-[state=open]:opacity-100 data-[state=closed]:opacity-0"
        />
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
          className="settings-dialog fixed left-[50%] top-[50%] z-[100] translate-x-[-50%] translate-y-[-50%] h-[calc(100dvh-24px)] w-[calc(100vw-24px)] max-h-[860px] max-w-[1120px] overflow-hidden rounded-lg border border-surface-border/60 bg-dialog text-dialog-foreground shadow-2xl titlebar-no-drag md:h-[88dvh] md:w-[92vw] motion-safe:transition-all motion-safe:duration-100 data-[state=open]:opacity-100 data-[state=closed]:opacity-0"
        >
          <DialogPrimitive.Title className="sr-only">设置</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">应用偏好、模型与连接配置</DialogPrimitive.Description>
          <SettingsPanel onClose={() => setOpen(false)} tabsOverride={tabsOverride} />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
