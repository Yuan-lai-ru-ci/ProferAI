import * as React from 'react'
import type { NavigationAction } from '@/lib/navigation-actions'
import { isEditableTarget, navigationController } from '@/lib/navigation-controller'
import { findSpatialNavigationTarget } from '@/lib/spatial-navigation'
import { useGamepadNavigation } from '@/hooks/useGamepadNavigation'

function keyboardAction(event: KeyboardEvent): NavigationAction | null {
  if (event.key === 'ArrowUp') return 'previous'
  if (event.key === 'ArrowDown') return 'next'
  if (event.key === 'ArrowLeft') return 'left'
  if (event.key === 'ArrowRight') return 'right'
  if (event.key === 'Enter' || event.key === ' ') return 'confirm'
  if (event.key === 'Escape') return 'back'
  return null
}

/** 当前激活输入框的 ProseMirror（Agent 或 Chat） */
function focusInput(): boolean {
  const mirror = document.querySelector<HTMLElement>(
    '[data-input-mode="agent"] .ProseMirror, [data-input-mode="chat"] .ProseMirror',
  )
  if (mirror) {
    mirror.focus()
    return true
  }
  return false
}

function activeConversationRegion(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-profer-navigation-region="conversation"]')
}

/** 顶部标题栏（TabBar 第一个标签） */
function focusTitlebar(): boolean {
  const tab = document.querySelector<HTMLElement>('[role="tab"]')
  if (tab) {
    tab.focus()
    return true
  }
  return false
}

/** 左栏当前/首个项目标题 */
function focusProject(): boolean {
  const project = document.querySelector<HTMLElement>(
    '[data-profer-navigation-item="project"][data-profer-navigation-active="true"], [data-profer-navigation-item="project"]',
  )
  if (project) {
    project.focus()
    project.scrollIntoView({ block: 'nearest' })
    return true
  }
  return false
}

/** 右侧边栏首个真实控件；无右栏则回输入框 */
function focusRightPanel(): boolean {
  const panel = document.querySelector<HTMLElement>('[data-profer-navigation-region="right-panel"]')
  if (panel && panel.offsetParent !== null) {
    window.dispatchEvent(new CustomEvent('proma:focus-right-panel'))
    return true
  }
  return focusInput()
}

/** 对话区滚动容器在当前 conversation region 内的可滚动体 */
function conversationScroller(): HTMLElement | null {
  const region = activeConversationRegion()
  if (!region) return null
  return region.querySelector<HTMLElement>('.profer-scroll-region')
}

/** 聚焦对话区（region 容器；滚动体无 tabindex 不可聚焦，由裸上下通过 closest 判定后滚动） */
function focusConversation(): boolean {
  const region = activeConversationRegion()
  if (region) {
    region.focus()
    return true
  }
  return false
}

/** Main-window bridge for keyboard and Gamepad API navigation actions. */
export function NavigationInputProvider(): null {
  useGamepadNavigation()

  React.useEffect(() => {
    const unregister = navigationController.register((action) => {
      if (action === 'voiceDictation') {
        window.electronAPI.toggleVoiceDictation().catch(console.error)
        return true
      }
      if (action === 'stopGeneration') {
        window.dispatchEvent(new CustomEvent('proma:stop-generation'))
        return true
      }
      // 左栏 roving 纵向向下到达主链末尾后，把焦点穿出回主内容/编辑框，形成循环。
      // 键盘与手柄共用此最低优先级兜底出口；向上到顶不做无意义动作。
      if (action === 'next') {
        const focused = document.activeElement
        if (focused instanceof HTMLElement && focused.closest('[data-profer-navigation-item]')) {
          const masterItems = Array.from(document.querySelectorAll<HTMLElement>('[data-profer-navigation-item]'))
            .filter((item) => item.dataset.proferNavigationItem !== 'mode')
          const last = masterItems[masterItems.length - 1]
          if (last && (last === focused || last.contains(focused))) {
            focusInput()
            return true
          }
        }
      }
      return false
    }, -100)
    return unregister
  }, [])

  React.useEffect(() => {
    const moveWithinNavigationRegion = (origin: HTMLElement, action: NavigationAction): boolean => {
      if (!['previous', 'next', 'left', 'right'].includes(action)) return false
      const direction = action as Extract<NavigationAction, 'previous' | 'next' | 'left' | 'right'>
      const region = origin.closest<HTMLElement>('[data-profer-navigation-region]')
      if (!region) return false
      // 模式切换器：左右切 Agent/Chat（放行给 ModeSwitcher）；向下离开模式区进下方新建按钮；
      // 向上到标题栏（用户要求 mode 也能“上得去”）。
      if (region.dataset.proferNavigationRegion === 'mode-switcher') {
        if (action === 'next') {
          document.querySelector<HTMLElement>('[data-profer-navigation-item="new-session"]')?.focus()
          return true
        }
        if (action === 'previous') {
          focusTitlebar()
          return true
        }
        if (action === 'left' || action === 'right') return false
      }
      // 工具栏向上返回写作区域。
      if (region.dataset.proferNavigationRegion === 'toolbar' && action === 'previous') {
        focusInput()
        return true
      }
      const elements = Array.from(region.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )).filter((element) => element.offsetParent !== null)
      const index = elements.indexOf(origin)
      if (index < 0) return false
      const items = elements.map((element, itemIndex) => ({
        id: String(itemIndex),
        rect: element.getBoundingClientRect(),
        element,
      }))
      const spatialTarget = findSpatialNavigationTarget(
        { id: String(index), rect: origin.getBoundingClientRect() },
        items,
        direction,
      )
      const target = spatialTarget
        ? items.find((item) => item.id === spatialTarget.id)?.element
        : elements[action === 'left' || action === 'previous' ? index - 1 : index + 1]
      if (!target) return true
      target.focus()
      target.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      return true
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing) return
      const action = keyboardAction(event)
      if (!action) return

      const isDirection = action === 'previous' || action === 'next' || action === 'left' || action === 'right'

      // ===== 1. Alt/Option + 方向：全局跨区跳转（最高优先） =====
      if (event.altKey && isDirection) {
        event.preventDefault()
        event.stopPropagation()
        if (action === 'previous') {
          // alt+↑：在对话区 → 标题栏；否则 → 对话区
          const target = event.target
          const inConversation = target instanceof HTMLElement
            && Boolean(target.closest('[data-profer-navigation-region="conversation"]'))
          if (inConversation) focusTitlebar()
          else focusConversation()
        } else if (action === 'next') {
          focusInput()
        } else if (action === 'left' || action === 'right') {
          // 在 mode 区：Alt+左右 = 直接切换 Agent↔Chat（交给 ModeSwitcher）；
          // 在别处：Alt+←=project、Alt+→=右栏。
          const target = event.target
          const inMode = target instanceof HTMLElement
            && Boolean(target.closest('[data-profer-navigation-region="mode-switcher"]'))
          if (inMode) {
            navigationController.dispatch(action === 'left' ? 'altLeft' : 'altRight')
          } else if (action === 'left') {
            focusProject()
          } else {
            focusRightPanel()
          }
        }
        return
      }

      // ===== 2. 输入框内裸方向键保留给光标 =====
      if (isEditableTarget(event.target)) return

      // ===== 3. 对话区裸上下 = 滚动消息页面（仅当最近的 region 就是对话区，
      // 排除嵌套在对话区内的工具栏等自身有专属上下语义的区域） =====
      if (isDirection && (action === 'previous' || action === 'next')
        && event.target instanceof HTMLElement) {
        const nearestRegion = event.target.closest<HTMLElement>('[data-profer-navigation-region]')
        if (nearestRegion?.dataset.proferNavigationRegion === 'conversation') {
          const scroller = conversationScroller()
          if (scroller) {
            scroller.scrollBy({ top: action === 'next' ? 96 : -96 })
            event.preventDefault()
            event.stopPropagation()
            return
          }
        }
      }

      // ===== 4. 区域内空间导航（mode/toolbar region 特判 + 通用空间） =====
      if (event.target instanceof HTMLElement && moveWithinNavigationRegion(event.target, action)) {
        event.preventDefault()
        event.stopPropagation()
        return
      }

      // ===== 5. 左栏 roving：交给 controller（键盘/手柄一致） =====
      if (event.target instanceof HTMLElement && event.target.closest('[data-profer-navigation-item]')) {
        if (navigationController.dispatch(action)) {
          event.preventDefault()
          event.stopPropagation()
        }
        return
      }

      // ===== 6. 全局空间兜底（非左栏项的真实控件） =====
      if (event.target instanceof HTMLElement && ['previous', 'next', 'left', 'right'].includes(action)) {
        const direction = action as Extract<NavigationAction, 'previous' | 'next' | 'left' | 'right'>
        const origin = event.target
        const items = Array.from(document.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        )).filter((element) => element !== origin && element.offsetParent !== null && element.getAttribute('aria-hidden') !== 'true')
          .map((element, index) => ({ id: String(index), rect: element.getBoundingClientRect(), element }))
        const target = findSpatialNavigationTarget(
          { id: '__origin__', rect: origin.getBoundingClientRect() },
          items,
          direction,
        )
        const targetItem = target && items.find((item) => item.id === target.id)
        if (targetItem) {
          event.preventDefault()
          event.stopPropagation()
          targetItem.element.focus()
          targetItem.element.scrollIntoView({ block: 'nearest', inline: 'nearest' })
          return
        }
      }

      // ===== 7. 最终交给 controller（confirm/back 等） =====
      if (navigationController.dispatch(action)) {
        event.preventDefault()
        event.stopPropagation()
      }
    }
    // Capture is required because ProseMirror may stop bubbling Alt+Arrow events.
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [])

  return null
}
