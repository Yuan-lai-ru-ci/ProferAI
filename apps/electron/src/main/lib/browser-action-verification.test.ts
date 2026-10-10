import { expect, test } from 'bun:test'
import { BrowserActionGuard } from './browser-action-guards'
import { browserActionSnapshotChanged, classifyBrowserClickRisk, createBrowserActionSnapshot, isBrowserActionResultUncertain, resolveBrowserActionStatus } from './browser-action-verification'

test('控件风险分类默认允许一次 fallback，明显不可逆操作禁止重试', () => {
  expect(classifyBrowserClickRisk('button「打开菜单」')).toBe('safe-retry')
  expect(classifyBrowserClickRisk('button「提交订单」')).toBe('non-retryable')
})

test('受限页面摘要只用于判断变化，不暴露正文', () => {
  const before = createBrowserActionSnapshot({ url: 'https://example.com', title: '示例', text: '菜单' })
  const after = createBrowserActionSnapshot({ url: 'https://example.com', title: '示例', text: '菜单已打开' })
  expect(browserActionSnapshotChanged(before, after)).toBe(true)
  expect(after).not.toHaveProperty('text')
})
test('动作未派发或明确被拒绝时为 failed', () => {
  expect(resolveBrowserActionStatus('click', { dispatched: false })).toBe('failed')
  expect(resolveBrowserActionStatus('click', { dispatched: true, rejected: true })).toBe('failed')
})

test('动作已派发但没有因果证据时为 unknown', () => {
  const status = resolveBrowserActionStatus('click', { dispatched: true })
  expect(status).toBe('unknown')
  expect(isBrowserActionResultUncertain(status)).toBe(true)
})

test('页面变化提供明确因果证据时才为 verified', () => {
  expect(resolveBrowserActionStatus('click', { dispatched: true, effect: 'url-changed' })).toBe('verified')
  expect(resolveBrowserActionStatus('fill', { dispatched: true, effect: 'dom-confirmed' })).toBe('verified')
})

test('关闭标签时清理该标签的未知动作记录', () => {
  const guard = new BrowserActionGuard()
  const action = { sessionId: 's1', tabId: 't1', ref: 'r1', action: 'click' as const }
  guard.markUncertain(action)
  guard.clearTab('s1', 't1')
  expect(guard.size).toBe(0)
  expect(guard.isBlocked(action)).toBe(false)
})
