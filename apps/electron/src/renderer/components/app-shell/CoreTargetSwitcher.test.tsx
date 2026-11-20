import { describe, expect, test } from 'bun:test'
import { createStore, Provider } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import { TooltipProvider } from '@profer/ui/primitives/tooltip'
import { coreTargetsAtom } from '@/atoms/core-target-atoms'
import type { CoreTargetsSnapshot, CoreTargetSummary } from '@/types/settings'
import { CoreTargetPanel, CoreTargetSwitcher, getCoreSwitcherTargets } from './CoreTargetSwitcher'

const local: CoreTargetSummary = { id: 'local', kind: 'local', name: '本机内核', status: 'connected' }
const remote: CoreTargetSummary = { id: 'remote', kind: 'remote', name: '远程开发机', coreId: 'core-1', status: 'disconnected' }

function renderSwitcher(targets: CoreTargetSummary[], currentId = local.id): string {
  const store = createStore()
  store.set(coreTargetsAtom, { targets, currentId, generation: 0 })
  return renderToStaticMarkup(<Provider store={store}><CoreTargetSwitcher /></Provider>)
}

function renderPanel(current: CoreTargetSummary, busy = false, restoring = false): string {
  const targets = current.kind === 'remote' ? [local, current] : [current, remote]
  return renderToStaticMarkup(
    <TooltipProvider>
      <CoreTargetPanel targets={targets} current={current} busy={busy} restoring={restoring} onSelect={() => {}} />
    </TooltipProvider>,
  )
}

function dot(markup: string, label: string): string | undefined {
  return markup.match(/<button[^>]+>/g)?.find(button => button.includes(`aria-label="${label}"`))
}

describe('Rail Core 切换器', () => {
  test('只有已验证远程存在时显示；断线不隐藏，移除最后一个后隐藏', () => {
    expect(renderSwitcher([local, { ...remote, coreId: undefined }])).toBe('')
    expect(renderSwitcher([local, remote], remote.id)).toContain('aria-label="当前内核：远程开发机"')
    expect(renderSwitcher([local])).toBe('')
  })

  test('本机排第一，同一已验证 Core 的多条线路只占一点', () => {
    const target = { ...remote, endpoints: [{ id: 'a', label: 'A', baseUrl: 'https://a.example' }, { id: 'b', label: 'B', baseUrl: 'https://b.example' }] }
    const snapshot: CoreTargetsSnapshot = { generation: 1, currentId: 'local', targets: [target, local] }
    expect(getCoreSwitcherTargets(snapshot)).toEqual([local, target])
    const markup = renderPanel(target)
    expect(markup.match(/<button[^>]+>/g)).toHaveLength(2)
    expect(markup).not.toContain('https://a.example')
    expect(markup).toContain('scrollbar-none overflow-x-auto')
  })

  test('等待时旧点保持选中；收到已切换快照后新点选中', () => {
    const pending = renderPanel(local, true)
    expect(dot(pending, '本机内核')).toContain('aria-pressed="true"')
    expect(dot(pending, '远程开发机')).toContain('aria-pressed="false" aria-disabled="true"')
    const settled = renderPanel({ ...remote, status: 'connected' })
    expect(dot(settled, '远程开发机')).toContain('aria-pressed="true"')
    expect(dot(settled, '本机内核')).toContain('aria-pressed="false" aria-disabled="false"')
  })

  test('已断开的当前远程可重试；恢复中暂不接受切换', () => {
    expect(dot(renderPanel(remote), '重试连接 远程开发机')).toContain('aria-pressed="true" aria-disabled="false"')
    const restoring = renderPanel(remote, false, true)
    expect(restoring).toContain('正在恢复连接')
    expect(dot(restoring, '重试连接 远程开发机')).toContain('aria-disabled="true"')
  })

  test('仅已连接的当前远程显示 WebSocket 延迟', () => {
    expect(renderPanel({ ...remote, status: 'connected', latencyMs: 24.4 })).toContain('WebSocket 延迟 24 毫秒')
    expect(renderPanel({ ...remote, latencyMs: 24 })).not.toContain('24 ms')
    expect(renderPanel({ ...local, latencyMs: 24 })).not.toContain('24 ms')
  })
})
