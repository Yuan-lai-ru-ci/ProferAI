import { expect, mock, test } from 'bun:test'
import * as React from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { atom } from 'jotai/vanilla'
import { createLoadedHost } from '../../../../scripts/settings-loaded-visual-host'

// 执行真实弹窗回调；布局尺寸与聚焦结果为内存 fixture，不冒充真实 DOM 验收。
mock.module('jotai', () => ({ atom, useAtom: () => [true, () => {}], useAtomValue: () => false, useSetAtom: () => () => {} }))
mock.module('./SettingsPanel', () => ({ SettingsPanel: () => null }))
const { SettingsDialog } = await import('./SettingsDialog')

test.each(['desktop', 'narrow', 'fallback', 'empty', 'failed', 'disabled'] as const)(
  '设置开窗焦点：%s 控件选择与 Radix 回退', async (scenario) => {
    const host = createLoadedHost(() => <SettingsDialog />, new Set(['SettingsDialog']))
    try {
      await host.settle()
      const content = host.elements().find((node) => node.type === DialogPrimitive.Content)!
      const props = content.props as React.ComponentProps<typeof DialogPrimitive.Content>
      const ownerDocument = { activeElement: null as unknown }
      const calls: string[] = []
      const control = (name: string, visible: boolean, disabled = false) => ({
        disabled, ownerDocument, getClientRects: () => visible ? [{}] : [],
        focus: (options: FocusOptions) => {
          expect(options.preventScroll).toBe(true)
          calls.push(name)
          if (scenario !== 'failed') ownerDocument.activeElement = name === 'search' ? search : mobile
        },
      })
      const search = control('search', scenario !== 'fallback', scenario === 'disabled')
      const mobile = control('mobile', scenario === 'narrow' || scenario === 'fallback')
      const ref = (content as React.ReactElement & { ref: React.MutableRefObject<unknown> }).ref
      ref.current = { querySelectorAll: (selector: string) => {
        expect(selector).toBe('#settings-nav-search, #settings-mobile-nav')
        return scenario === 'empty' ? [] : [search, mobile]
      } }
      let prevented = false
      props.onOpenAutoFocus!({ preventDefault: () => { prevented = true } } as Event)
      expect(calls).toEqual(scenario === 'empty' || scenario === 'disabled' ? [] : [scenario === 'fallback' ? 'mobile' : 'search'])
      expect(prevented).toBe(scenario === 'desktop' || scenario === 'narrow' || scenario === 'fallback')
    } finally { host.dispose() }
  },
)

test('设置 Esc 捕获：非空搜索先清空，其余目标交给 Radix 关闭', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'HTMLInputElement')
  class InputFixture {
    constructor(public id: string, public value: string) {}
  }
  Object.defineProperty(globalThis, 'HTMLInputElement', { configurable: true, value: InputFixture })
  const host = createLoadedHost(() => <SettingsDialog />, new Set(['SettingsDialog']))
  try {
    await host.settle()
    const content = host.elements().find((node) => node.type === DialogPrimitive.Content)!
    const props = content.props as React.ComponentProps<typeof DialogPrimitive.Content>
    for (const [target, expected] of [
      [new InputFixture('settings-nav-search', '归档'), true],
      [new InputFixture('settings-nav-search', ''), false],
      [new InputFixture('other-setting', '归档'), false],
      [{ id: 'settings-nav-search', value: '归档' }, false],
    ] as const) {
      let prevented = false
      props.onEscapeKeyDown!({ target, preventDefault: () => { prevented = true } } as unknown as KeyboardEvent)
      expect(prevented).toBe(expected)
    }
  } finally {
    host.dispose()
    if (original) Object.defineProperty(globalThis, 'HTMLInputElement', original)
    else Reflect.deleteProperty(globalThis, 'HTMLInputElement')
  }
})
