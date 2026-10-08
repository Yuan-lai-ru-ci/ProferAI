import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

test('渠道读取失败不当空配置，也不持久化空的派生渠道名单', () => {
  const source = readFileSync(new URL('./ChannelSettings.tsx', import.meta.url), 'utf8')
  expect(source).toContain("setLoadError('模型配置加载失败")
  expect(source).toContain('if (loading || loadError) return')
  expect(source).toContain('[channels, loading, loadError, setAgentChannelIds]')
  expect(source).toContain('disabled={loading || Boolean(loadError) || !capsReady}')
  expect(source).toContain('role="alert"')
  expect(source).toContain('void loadChannels()')
  expect(source.indexOf(') : loadError ? (')).toBeLessThan(source.indexOf(') : channels.length === 0 ? ('))
})
