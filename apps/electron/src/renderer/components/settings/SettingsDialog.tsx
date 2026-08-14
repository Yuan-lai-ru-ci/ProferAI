/**
 * SettingsDialog - 设置浮窗
 *
 * 以 Dialog 浮窗形式展示设置面板，不覆盖主内容区。
 * 使用低级 Dialog 原语实现轻遮罩 + 无默认关闭按钮（关闭按钮由 SettingsPanel 内部提供）。
 */

import * as React from 'react'
import { useAtom } from 'jotai'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { settingsOpenAtom } from '@/atoms/settings-tab'
import { SettingsPanel, type SettingsTabItem } from './SettingsPanel'

export interface SettingsDialogProps {
  /** 受限环境（如平板）传入的 tab 白名单，透传给 SettingsPanel */
  tabsOverride?: SettingsTabItem[]
}

export function SettingsDialog({ tabsOverride }: SettingsDialogProps): React.ReactElement {
  const [open, setOpen] = useAtom(settingsOpenAtom)

  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Portal>
        {/* 轻遮罩 — 与新 Dialog overlay 对齐：bg-black/40 + backdrop-blur-sm */}
        <DialogPrimitive.Overlay
          className="fixed inset-0 z-[100] bg-black/40 backdrop-blur-sm titlebar-no-drag transition-opacity duration-100 data-[state=open]:opacity-100 data-[state=closed]:opacity-0"
        />
        <DialogPrimitive.Content
          className="tablet-settings-dialog fixed left-[50%] top-[50%] z-[100] translate-x-[-50%] translate-y-[-50%] w-[90vw] max-w-[1080px] h-[88vh] max-h-[820px] bg-dialog text-dialog-foreground shadow-2xl rounded-xl overflow-hidden titlebar-no-drag transition-all duration-100 data-[state=open]:opacity-100 data-[state=open]:scale-100 data-[state=closed]:opacity-0 data-[state=closed]:scale-[0.98]"
        >
          <DialogPrimitive.Title className="sr-only">设置</DialogPrimitive.Title>
          <SettingsPanel onClose={() => setOpen(false)} tabsOverride={tabsOverride} />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
