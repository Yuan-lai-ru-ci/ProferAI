/**
 * 手动交接「先确认、再执行」的接线契约。
 *
 * 这里钉住三件以后很容易被顺手改坏的事，它们靠运行时测试成本很高
 * （要 mock Jotai / Radix / useOpenSession 一整条链），但都是静态接线：
 * 1. 工具栏按钮点击只请求确认，绝不能直接跑交接；
 * 2. 真正执行只在确认弹窗的「开始交接」里，且要先关弹窗；
 * 3. 弹窗必须挂在 AgentView 顶层 —— 挂在按钮组件里会随工具栏「更多」
 *    Popover 一起卸载，窄窗口下确认框一闪就没了。
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const read = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8')
const button = read('./HandoffToolbarButton.tsx')
const dialog = read('./HandoffConfirmDialog.tsx')
const view = read('./AgentView.tsx')

describe('手动交接确认链路', () => {
  test('Given 工具栏按钮 When 点击 Then 只发出确认请求，不直接交接', () => {
    expect(button).toContain('onRequest()')
    expect(button).toContain('onRequest: () => void')
    expect(button).not.toContain('startHandoff')
    expect(button).not.toContain('createAgentHandoffSession')
    expect(view).toContain('setHandoffConfirmOpen(true)')
  })

  test('Given 确认弹窗 When 点「开始交接」Then 先关弹窗再执行唯一一次交接', () => {
    expect(dialog).toContain('event.preventDefault()')
    expect(dialog).toContain('onOpenChange(false)')
    expect(dialog).toContain('void startHandoff()')
    // 取消入口不能带任何执行动作
    expect(dialog).toContain('<AlertDialogCancel>先不交接</AlertDialogCancel>')
  })

  test('Given 按钮可能被折进工具栏 overflow When 渲染 Then 弹窗挂在 AgentView 顶层', () => {
    expect(view).toContain('<HandoffConfirmDialog')
    expect(view).toContain('sessionTitle={sessionMeta?.title}')
    expect(button).not.toContain('<AlertDialog')
    // 注释里会提到这个组件名，所以只断言「没有把它渲染进按钮子树」
    expect(button).not.toContain('<HandoffConfirmDialog')
    expect(button).not.toContain("from './HandoffConfirmDialog'")
  })

  test('Given 独立会话窗口 When 渲染 Then 两个交接入口都不出现', () => {
    expect(view).toContain('!standalone && <HandoffSuggestion')
    expect(view).toContain('visible: !standalone')
  })
})
