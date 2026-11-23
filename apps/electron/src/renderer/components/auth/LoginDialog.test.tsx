import { expect, mock, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
mock.module('jotai', () => ({ useAtom: () => [null, () => {}] }))
mock.module('@/atoms/identity-atoms', () => ({ authStatusAtom: {} }))
const Slot = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>
mock.module('@profer/ui/primitives/dialog', () => ({ Dialog: Slot, DialogContent: Slot, DialogHeader: Slot, DialogTitle: Slot, DialogDescription: Slot }))
const { LoginDialog } = await import('./LoginDialog')
test('Given 初始登录 When 渲染 Then 模式组命名且选中状态在真实按钮上', () => {
  const html = renderToStaticMarkup(<LoginDialog open onOpenChange={() => {}} />)
  expect(html).toContain('role="group" aria-label="账户访问方式"')
  const buttons = html.match(/<button[^>]*aria-pressed="(?:true|false)"[^>]*>/g) ?? []
  expect(buttons).toHaveLength(2)
  expect(buttons[0]).toContain('aria-pressed="true"')
  expect(buttons[1]).toContain('aria-pressed="false"')
  for (const button of buttons) expect(button).toContain('focus-visible:ring-2')
  expect(html).toContain('使用服务端渠道和协作功能')
})
