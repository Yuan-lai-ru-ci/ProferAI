import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

test('渠道读取失败显示错误且不持久化空的派生渠道名单', () => {
  const source = readFileSync(new URL('./ChannelSettings.tsx', import.meta.url), 'utf8')
  expect(source).toContain("setLoadError('模型配置加载失败，当前数据未改变，请重试')")
  expect(source).toContain('if (loading || loadError || remoteCore) return')
  expect(source).toContain('[channels, loading, loadError, remoteCore, setAgentChannelIds]')
  expect(source).toContain('disabled={loading || Boolean(loadError)}')
  expect(source).toContain('role="alert"')
  expect(source).toContain('onClick={() => { void loadChannels() }}')
  expect(source.indexOf(') : loadError ? (')).toBeLessThan(source.indexOf(') : channels.length === 0 ? ('))
})
