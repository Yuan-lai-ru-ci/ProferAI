import { expect, test } from 'bun:test'
import { BrowserStabilityProbe } from './browser-stabilization'
import { createBrowserPageSnapshot } from './browser-page-snapshot'

function snapshot(overrides: Partial<Parameters<typeof createBrowserPageSnapshot>[0]> = {}) {
  return createBrowserPageSnapshot({ url: 'https://example.com', title: '示例', text: '稳定页面', ...overrides })
}

test('连续两个相同且无加载/网络请求的样本才算稳定', () => {
  const probe = new BrowserStabilityProbe({ requiredUnchangedSamples: 2 })
  expect(probe.push({ snapshot: snapshot(), now: 1 }).stable).toBe(false)
  expect(probe.push({ snapshot: snapshot(), now: 2 }).stable).toBe(true)
})

test('加载中或网络请求未完成时不报告稳定', () => {
  const probe = new BrowserStabilityProbe({ requiredUnchangedSamples: 2 })
  probe.push({ snapshot: snapshot({ loading: true, pendingNetworkRequests: 1 }), now: 1 })
  expect(probe.push({ snapshot: snapshot({ loading: true, pendingNetworkRequests: 1 }), now: 2 }).stable).toBe(false)
  expect(probe.push({ snapshot: snapshot({ loading: false, pendingNetworkRequests: 1 }), now: 3 }).stable).toBe(false)
  expect(probe.push({ snapshot: snapshot({ loading: false, pendingNetworkRequests: 0 }), now: 4 }).stable).toBe(false)
  expect(probe.push({ snapshot: snapshot({ loading: false, pendingNetworkRequests: 0 }), now: 5 }).stable).toBe(true)
})

test('页面内容或 frame 变化会重置稳定样本计数', () => {
  const probe = new BrowserStabilityProbe({ requiredUnchangedSamples: 2 })
  expect(probe.push({ snapshot: snapshot(), now: 1 }).unchangedSamples).toBe(1)
  expect(probe.push({ snapshot: snapshot({ frameCount: 2 }), now: 2 }).unchangedSamples).toBe(1)
  expect(probe.push({ snapshot: snapshot({ frameCount: 2 }), now: 3 }).stable).toBe(true)
})
