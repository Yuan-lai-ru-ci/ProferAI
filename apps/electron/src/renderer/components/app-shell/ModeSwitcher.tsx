/**
 * ModeSwitcher - Chat/Agent 模式切换（带滑动指示器）
 *
 * 切换模式时自动恢复上一次在该模式下查看的对话/会话：
 * 1. 优先恢复上次选中的对话 ID
 * 2. 其次查找已打开的同类型 Tab
 * 3. 兜底打开最近的对话/会话（列表首项）
 * 4. 都没有则仅切换模式
 */

import * as React from 'react'
import { startTransition } from 'react'
import { useAtomValue } from 'jotai'
import { appModeAtom, appModeIntentAtom, type AppMode } from '@/atoms/app-mode'
import { tabsAtom, scratchPadOriginTabIdAtom } from '@/atoms/tab-atoms'
import { Bot, MessageSquare } from 'lucide-react'
import { useSwitchAppMode } from '@/hooks/useSwitchAppMode'
import { cn } from '@/lib/utils'
import { interfaceVariantAtom } from '@/atoms/theme'
import { navigationController } from '@/lib/navigation-controller'

const modes: { value: AppMode; label: string; icon: React.ReactNode }[] = [
  { value: 'agent', label: 'Agent', icon: <Bot size={15} /> },
  { value: 'chat', label: 'Chat', icon: <MessageSquare size={15} /> },
]

export function ModeSwitcher(): React.ReactElement {
  const actualMode = useAtomValue(appModeAtom)
  const intent = useAtomValue(appModeIntentAtom)
  const tabs = useAtomValue(tabsAtom)
  const originId = useAtomValue(scratchPadOriginTabIdAtom)
  const origin = tabs.find(tab => tab.id === originId)
  const scratchMode = origin?.type === 'chat' ? 'chat' : origin?.type === 'agent' || origin?.type === 'preview' || origin?.type === 'browser' ? 'agent' : intent === 'chat' ? 'chat' : 'agent'
  const mode = actualMode === 'scratch' ? scratchMode : actualMode
  const switchAppMode = useSwitchAppMode()
  const interfaceVariant = useAtomValue(interfaceVariantAtom)
  const isClassic = interfaceVariant === 'classic'
  // 预选（preview）模式：普通←/→ 在这个候选间移动，按 Enter 才真正切换；
  // Alt+←/→ 直接切换。初始跟随当前 mode，切换后同步。
  const [previewMode, setPreviewMode] = React.useState<AppMode>(mode)

  // 实际 mode 变化时，让预选跟随，避免脱离现实。
  React.useEffect(() => {
    setPreviewMode(mode)
  }, [mode])

  const handleModeSwitch = React.useCallback((targetMode: AppMode) => {
    if (targetMode === mode && actualMode !== 'scratch') return
    // 先写意图 + 移动滑块，让 UI 立刻响应；会话/标签页的切换在空闲时完成，
    // 避免模式切换动画被内容重渲染卡住。
    // 注意：界面显示的模式最终由活动标签页派生，所以真正“生效”发生在标签页切换后；
    // 这里不写 appModeAtom（那不会改变显示），只写意图。
    setPreviewMode(targetMode)
    startTransition(() => {
      void switchAppMode(targetMode)
    })
  }, [mode, actualMode, switchAppMode])

  const isFocusInModeRegion = (activeElement: Element | null): boolean =>
    activeElement instanceof HTMLElement
    && !!activeElement.closest('[data-profer-navigation-region="mode-switcher"]')

  // 键盘：仅在模式切换区内生效。
  // 普通 ←/→：移动预选（不实际切换）；Enter/Space：应用预选正式切换；
  // Alt+←/→：直接立即切换。project 的左右仍保留给折叠（这里不拦截）。
  const isProjectFocused = (activeElement: Element | null): boolean =>
    activeElement instanceof HTMLElement
    && !!activeElement.closest('[data-profer-navigation-item="project"]')

  const handleAltSwitch = React.useCallback((target: AppMode) => {
    handleModeSwitch(target)
    setPreviewMode(target)
  }, [handleModeSwitch])

  React.useEffect(() => {
    return navigationController.register((action) => {
      const activeElement = document.activeElement
      // project 的左右用于折叠/展开会话列表，不抢作切换。
      if (isProjectFocused(activeElement)) return false
      // 只在 mode 区域内响应。
      if (!isFocusInModeRegion(activeElement)) return false

      if (action === 'altLeft') {
        handleAltSwitch('agent')
        return true
      }
      if (action === 'altRight') {
        handleAltSwitch('chat')
        return true
      }
      if (action === 'left' || action === 'right') {
        // 普通左右：移动预选，Enter 才真正切换。
        setPreviewMode((prev) => (action === 'left' ? 'agent' : 'chat'))
        return true
      }
      if (action === 'confirm' && previewMode) {
        handleModeSwitch(previewMode)
        setPreviewMode(previewMode)
        return true
      }
      return false
    }, 50)
  }, [handleModeSwitch, handleAltSwitch, previewMode, isFocusInModeRegion, isProjectFocused])

  // 切换模式后把焦点放回当前激活的模式按钮，让用户能用左右连续切换、
  // 并能清楚看到当前“选择区域”落在切换按钮上。首次挂载不强抢焦点。
  const firstModeRender = React.useRef(true)
  React.useEffect(() => {
    if (firstModeRender.current) {
      firstModeRender.current = false
      return
    }
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        document.querySelector<HTMLElement>(
          '[data-profer-navigation-item="mode"][data-profer-navigation-active="true"]',
        )?.focus()
      })
    })
  }, [mode])

  return (
    <div data-profer-navigation-region="mode-switcher" className="pt-2 titlebar-drag-region select-none">
      <div
        className={cn(
          'relative flex min-w-0 overflow-hidden rounded-xl p-1 titlebar-drag-region mode-switcher-track',
          isClassic ? 'bg-muted' : 'bg-primary/5'
        )}
      >
        {/* 滑动背景指示器 */}
        <div
          className={cn(
            'mode-slider pointer-events-none absolute top-1 bottom-1 w-[calc(50%-4px)] rounded-lg bg-background shadow-sm transition-transform duration-300 ease-in-out',
            mode === 'agent' ? 'translate-x-0' : 'translate-x-full'
          )}
        />
        {modes.map(({ value, label, icon }) => {
          const isActive = mode === value
          const isPreview = previewMode === value
          return (
            <button
              key={value}
              type="button"
              data-profer-navigation-item="mode"
              data-profer-navigation-active={previewMode === value ? 'true' : undefined}
              aria-pressed={mode === value}
              onClick={() => {
                handleModeSwitch(value)
                setPreviewMode(value)
              }}
              className={cn(
                // min-w-0 + 文字 truncate：列表被拖窄时按钮收缩而不是把整条轨道撑出去
                'mode-btn titlebar-no-drag relative z-[1] flex h-8 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-lg px-1.5 py-0 text-[15px] leading-5 font-medium transition-colors duration-200 select-none',
                isActive
                  ? 'mode-btn-selected text-foreground'
                  : isPreview
                    ? 'text-foreground/70 mode-btn-preview'
                    : 'text-muted-foreground hover:text-foreground'
              )}
            >
              <span className="flex-none">{icon}</span>
              <span className="truncate">{label}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
