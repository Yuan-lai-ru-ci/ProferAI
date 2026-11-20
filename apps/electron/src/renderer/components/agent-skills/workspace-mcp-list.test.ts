import { expect, test } from 'bun:test'
import { workspaceMcpList } from './workspace-mcp-list'
const global = { name: 'Shared', enabled: true, shadowed: false }
const entry = { type: 'stdio', command: 'example', enabled: true } as const

test('只有全局命中时既计数也不显示空态', () => {
  expect(workspaceMcpList({}, [global], 'sha')).toEqual({ total: 1, local: [], global: [global], empty: null })
})
test('同名只计一次，但保留遮蔽说明和独立的本地条目', () => {
  const shadowed = { ...global, shadowed: true }
  expect(workspaceMcpList({ Shared: entry }, [shadowed], '')).toEqual({ total: 1, local: [['Shared', entry]], global: [shadowed], empty: null })
})
test('两类服务均无结果时区分没有配置与没有匹配', () => {
  expect(workspaceMcpList({}, [], '').empty).toBe('unconfigured')
  expect(workspaceMcpList({ Other: entry }, [global], 'absent').empty).toBe('unmatched')
})
