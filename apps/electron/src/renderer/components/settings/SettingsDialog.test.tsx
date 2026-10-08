import { expect, mock, test } from 'bun:test'
import * as React from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { atom } from 'jotai/vanilla'
import { createLoadedHost } from '../../../../scripts/settings-loaded-visual-host'

// 执行真实弹窗回调；布局尺寸与聚焦结果为内存 fixture，不冒充真实 DOM 验收。
mock.module('jotai', () => ({ atom, useAtom: () => [true, () => {}], useAtomValue: () => false, useSetAtom: () => () => {} }))
mock.module('./SettingsPanel', () => ({ SettingsPanel: () => null }))
const { SettingsDialog } = await import('./SettingsDialog')

test.each(['desktop', 'narrow', 'empty', 'failed', 'disabled'] as const)(
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
      const search = control('search', scenario !== 'narrow', scenario === 'disabled')
      const mobile = control('mobile', scenario === 'narrow')
      const ref = (content as React.ReactElement & { ref: React.MutableRefObject<unknown> }).ref
      ref.current = { querySelectorAll: (selector: string) => {
        expect(selector).toBe('#settings-nav-search, #settings-mobile-nav')
        return scenario === 'empty' ? [] : [mobile, search]
      } }
      let prevented = false
      props.onOpenAutoFocus!({ preventDefault: () => { prevented = true } } as Event)
      expect(calls).toEqual(scenario === 'empty' || scenario === 'disabled' ? [] : [scenario === 'narrow' ? 'mobile' : 'search'])
      expect(prevented).toBe(scenario === 'desktop' || scenario === 'narrow')
    } finally { host.dispose() }
  },
)
