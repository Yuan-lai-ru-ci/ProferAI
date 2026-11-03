/**
 * MCP 表单条目合并：锁住「自动保存不能抹掉非表单字段」这条行为。
 *
 * 现场来源：编辑任意字段触发自动保存，把 enabled 写成 false、把 lastTestResult 与
 * externalStatePaths 一起清空，导致 MCP server 静默停止加载。
 */
import { describe, expect, test } from 'bun:test'
import type { McpServerEntry } from '@profer/shared'
import { mergeEntryWithExisting } from './mcp-form-entry'

const EXISTING: McpServerEntry = {
  type: 'stdio',
  command: 'npx',
  args: ['-y', 'github-mcp'],
  enabled: true,
  externalStatePaths: ['/home/user/.rcf/environments.toml'],
  lastTestResult: {
    success: true,
    message: '连接成功，发现 46 个工具',
    timestamp: 1_790_000_000_000,
    fingerprint: 'abc123',
  },
}

function formEntry(overrides: Partial<McpServerEntry> = {}): McpServerEntry {
  return {
    type: 'stdio',
    command: 'npx',
    args: ['-y', 'github-mcp'],
    enabled: true,
    ...overrides,
  }
}

describe('mergeEntryWithExisting', () => {
  test('保留外部配置声明（表单不编辑它，自动保存不能抹掉）', () => {
    const merged = mergeEntryWithExisting(EXISTING, formEntry())

    expect(merged.externalStatePaths).toEqual(EXISTING.externalStatePaths)
  })

  test('表单没有测试结果时，清除磁盘上的旧结果（配置已改，旧指纹作废）', () => {
    const merged = mergeEntryWithExisting(EXISTING, formEntry({ lastTestResult: undefined }))

    expect(merged.lastTestResult).toBeUndefined()
  })

  test('表单带了新测试结果时，以表单值为准', () => {
    const fresh = { success: false, message: '握手超时', timestamp: 2, reason: 'handshake-timeout' as const }
    const merged = mergeEntryWithExisting(EXISTING, formEntry({ lastTestResult: fresh }))

    expect(merged.lastTestResult).toEqual(fresh)
  })

  test('表单字段以表单值为准：改 command 后旧命令不残留', () => {
    const merged = mergeEntryWithExisting(EXISTING, formEntry({ command: 'uvx', args: undefined }))

    expect(merged.command).toBe('uvx')
    expect(merged.args).toBeUndefined()
  })

  test('关闭开关不会被磁盘上的旧值覆盖', () => {
    const merged = mergeEntryWithExisting(EXISTING, formEntry({ enabled: false }))

    expect(merged.enabled).toBe(false)
  })

  test('没有既有条目时原样返回', () => {
    const entry = formEntry()

    expect(mergeEntryWithExisting(undefined, entry)).toBe(entry)
  })
})
