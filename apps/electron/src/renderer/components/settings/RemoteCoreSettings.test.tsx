import { describe, expect, test } from 'bun:test'
import { createStore, Provider } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import { coreTargetsAtom } from '@/atoms/core-target-atoms'
import type { CoreTargetsSnapshot, CoreTargetSummary } from '@/types/settings'
import { RemoteCoreSettings } from './RemoteCoreSettings'

const remote: CoreTargetSummary = {
  id: 'remote', kind: 'remote', coreId: 'verified', name: '远程开发机', version: '1.2.3', status: 'disconnected',
  selectedEndpointId: 'a', endpoints: [
    { id: 'a', label: '公开入口', baseUrl: 'https://a.example' },
    { id: 'b', label: '备用线路', baseUrl: 'https://b.example' },
  ],
}

function render(snapshot: Partial<CoreTargetsSnapshot> = {}): string {
  const store = createStore()
  store.set(coreTargetsAtom, { currentId: 'local', generation: 1, targets: [remote], ...snapshot })
  return renderToStaticMarkup(<Provider store={store}><RemoteCoreSettings /></Provider>)
}

describe('远程内核设置', () => {
  test('空态同时提供添加与已有部署指引；恢复失败时明确说明回到本机', () => {
    const markup = render({ targets: [], startup: 'fallback' })
    expect(markup).toContain('添加远程内核')
    expect(markup).toContain('如何连接已部署的 Core')
    expect(markup).toContain('本次已回到本机')
    expect(markup).toContain('下次从本机启动')
  })

  test('同一个内核只有一张卡片，两条线路可见且默认线路不能直接删除', () => {
    const markup = render()
    expect(markup.match(/<article/g)).toHaveLength(1)
    expect(markup).toContain('版本 1.2.3')
    expect(markup).toContain('已保存')
    expect(markup).toContain('公开入口 · 已选线路')
    expect(markup).toContain('https://b.example')
    expect(markup).toMatch(/<button[^>]+disabled=""[^>]*title="请先选择其他线路"[^>]*>移除线路/)
  })

  test('当前已断开时允许重试，必须先切回本机才能移除连接', () => {
    const markup = render({ currentId: 'remote' })
    expect(markup).toContain('当前已断开')
    expect(markup).toContain('重试连接')
    expect(markup).toContain('切回本机')
    expect(markup).toMatch(/<button[^>]+disabled=""[^>]*title="请先切回本机"[^>]*>移除连接/)
  })
})
