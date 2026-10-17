import { describe, expect, test } from 'bun:test'
import {
  createNavigationController,
  hasOpenAlertDialog,
  isEditableTarget,
} from './navigation-controller'

describe('navigation controller', () => {
  test('offers actions to consumers by descending priority until one consumes it', () => {
    const controller = createNavigationController()
    const calls: string[] = []
    controller.register((action) => { calls.push(`low:${action}`); return true }, 1)
    controller.register((action) => { calls.push(`high:${action}`); return false }, 10)

    expect(controller.dispatch('next')).toBe(true)
    expect(calls).toEqual(['high:next', 'low:next'])
  })

  test('stops dispatching after a consumer handles the action and supports unregister', () => {
    const controller = createNavigationController()
    const calls: string[] = []
    const unregister = controller.register((action) => { calls.push(action); return true }, 10)
    controller.register(() => { calls.push('unexpected'); return true }, 1)

    expect(controller.dispatch('confirm')).toBe(true)
    expect(calls).toEqual(['confirm'])
    unregister()
    expect(controller.dispatch('confirm')).toBe(true)
    expect(calls).toEqual(['confirm', 'unexpected'])
  })
})

describe('isEditableTarget', () => {
  test('recognizes native and rich text editors without requiring a DOM implementation', () => {
    expect(isEditableTarget({ tagName: 'INPUT' } as unknown as EventTarget)).toBe(true)
    expect(isEditableTarget({ tagName: 'TEXTAREA' } as unknown as EventTarget)).toBe(true)
    expect(isEditableTarget({ isContentEditable: true } as unknown as EventTarget)).toBe(true)
    expect(isEditableTarget({ closest: (selector: string) => selector.includes('.ProseMirror') ? {} : null } as unknown as EventTarget)).toBe(true)
    expect(isEditableTarget({ tagName: 'BUTTON', closest: () => null } as unknown as EventTarget)).toBe(false)
  })
})

describe('hasOpenAlertDialog', () => {
  test('Given 打开的 AlertDialog When 查询 Then 命中 alertdialog 且 data-state=open', () => {
    expect(hasOpenAlertDialog({
      querySelector: (selector: string) => selector.includes('[role="alertdialog"]') ? {} : null,
    } as unknown as Document)).toBe(true)
  })

  test('Given 普通弹层（role=dialog）或已关闭确认框 When 查询 Then 不命中', () => {
    expect(hasOpenAlertDialog({
      querySelector: (selector: string) => selector.includes('[data-state="open"]') && selector.includes('dialog]') && !selector.includes('alertdialog') ? {} : null,
    } as unknown as Document)).toBe(false)
    expect(hasOpenAlertDialog({ querySelector: () => null } as unknown as Document)).toBe(false)
  })
})
