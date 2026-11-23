import { describe, expect, test } from 'bun:test'
import { createStore, Provider } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import { coreTargetsAtom } from '@/atoms/core-target-atoms'
import type { CoreTargetsSnapshot, CoreTargetSummary } from '@/types/settings'
import { RemoteCoreSettings } from './RemoteCoreSettings'

const remote: CoreTargetSummary = {
  id: 'remote', kind: 'remote', coreId: 'verified', name: '远程开发机', version: '1.2.3', status: 'disconnected', platform: 'linux', osId: 'ubuntu',
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
  test('空态保留添加入口；恢复失败时明确说明回到本机', () => {
    const markup = render({ targets: [], startup: 'fallback' })
    expect(markup).toContain('使用地址 + Token')
    expect(markup).not.toContain('暂无已保存设备')
    expect(markup).toContain('本次已回到本机')
    expect(markup).toContain('下次从本机启动')
  })

  test('同一个内核只有一张卡片，两条线路可见且默认线路不能直接删除', () => {
    const markup = render()
    expect(markup.match(/<article/g)).toHaveLength(1)
    expect(markup).toContain('无期限')
    expect(markup).toContain('已保存')
    expect(markup).toContain('公开入口 · 已选线路')
    expect(markup).toContain('https://b.example')
    expect(markup).toMatch(/<button[^>]+disabled=""[^>]*title="请先选择其他线路"[^>]*>移除线路/)
  })

  test('当前连接在保存列表之前，低频线路管理默认收起', () => {
    const markup = render({ currentId: 'remote', targets: [{ ...remote, status: 'connected', latencyMs: 24 }] })
    expect(markup.indexOf('当前使用：')).toBeLessThan(markup.indexOf('已保存设备'))
    expect(markup).toContain('aria-label="Ubuntu"')
    expect(markup.match(/data-core-system="ubuntu"/g)).toHaveLength(2)
    expect(markup).toContain('当前使用中')
    expect(markup).toContain('管理设备 · 2 条线路')
    expect(markup).not.toContain('<details open=')
    expect(markup).not.toContain('重试连接')
    expect(markup).not.toContain('高级：自建')
  })

  test('恢复连接时禁止切换与新增，离线保留原目标', () => {
    const restoring = render({ startup: 'restoring', currentId: 'remote' })
    expect(restoring).toContain('正在恢复连接')
    expect(restoring).toContain('aria-busy="true"')
    const buttons = restoring.match(/<button[^>]*>/g) ?? []
    expect(buttons.length).toBeGreaterThan(0)
    expect(buttons.filter(button => button.includes('disabled=""')).length).toBeGreaterThan(0)
    const offline = render({ startup: 'offline', currentId: 'remote' })
    expect(offline).toContain('已保留原目标')
    expect(offline).toContain('重试连接')
  })

  test('当前已断开时允许重试，必须先切回本机才能移除连接', () => {
    const markup = render({ currentId: 'remote' })
    expect(markup).toContain('未连接')
    expect(markup).toContain('重试连接')
    expect(markup).toContain('使用本机')
    expect(markup).toMatch(/<button[^>]+disabled=""[^>]*title="请先切回本机"[^>]*>移除连接/)
  })
})
