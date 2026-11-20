import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { deleteGlobalMcpServer as remove, listGlobalMcpServers as list, resolveGlobalMcpForWorkspace as resolve, saveGlobalMcpServer as save, summarizeGlobalMcpForWorkspace as summary } from './global-mcp-store'

let dir: string, path: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'global-mcp-')); path = join(dir, 'global-mcp.json') })
afterEach(() => rmSync(dir, { recursive: true, force: true }))
const definition = { name: 'demo', entry: { type: 'http' as const, enabled: true, url: 'https://example.test', headers: { Authorization: 'fixture' } }, workspaceIds: ['ws-a'] }
const empty = { servers: {} }
test('仅分配到的工作区可用；禁用的本地同名项也整条优先', () => {
  expect(list(path)).toEqual([])
  save(definition, 'create', path)
  expect(list(path)).toEqual([definition])
  if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600)
  expect(resolve('ws-a', empty, path).servers.demo).toEqual(definition.entry)
  expect(resolve('ws-b', empty, path)).toEqual(empty)
  expect(summary('ws-b', empty, path)).toEqual([])
  const local = { servers: { demo: { type: 'stdio' as const, enabled: false, command: 'local' } } }
  expect(resolve('ws-a', local, path)).toEqual(local)
  expect(summary('ws-a', local, path)).toEqual([{ name: 'demo', enabled: true, shadowed: true }])
  expect(() => save(definition, 'create', path)).toThrow()
  save({ ...definition, workspaceIds: [] }, 'update', path)
  expect(resolve('ws-a', empty, path)).toEqual(empty)
  remove('demo', path)
  expect(list(path)).toEqual([])
  expect(() => save(definition, 'update', path)).toThrow()
})
test('拒绝保留名和配置注入', () => {
  for (const name of ['agent-presets', 'agent-preview', 'lark-mcp', 'clipboard', 'plugin_0123456789abcdef', 'prototype', 'constructor', '../other', '__proto__']) expect(() => save({ ...definition, name }, 'create', path)).toThrow()
  for (const extra of [{ type: 'sdk' }, { instance: {} }, { command: 'other' }, { isBuiltin: true }]) expect(() => save({ ...definition, entry: Object.assign({}, definition.entry, extra) }, 'create', path)).toThrow()
  expect(list(path)).toEqual([])
})
test('管理操作拒绝损坏文件；运行不阻塞本地服务', () => {
  for (const text of ['{broken', '{}', JSON.stringify([definition, definition])]) {
    writeFileSync(path, text)
    expect(() => list(path)).toThrow()
    expect(() => save(definition, 'create', path)).toThrow()
    expect(() => remove('demo', path)).toThrow()
    expect(resolve('ws-a', empty, path)).toEqual(empty)
    expect(readFileSync(path, 'utf8')).toBe(text)
  }
})

test('三种传输都保留绝对路径列表，拒绝无效路径且不回显内容', () => {
  const externalStatePaths = [join(dir, 'private.json')]
  for (const type of ['stdio', 'http', 'sse'] as const) {
    const entry = type === 'stdio' ? { type, command: 'demo', enabled: true } : { ...definition.entry, type }
    save({ ...definition, name: type, entry: { ...entry, externalStatePaths } }, 'create', path)
    expect(resolve('ws-a', empty, path).servers[type]?.externalStatePaths).toEqual(externalStatePaths)
    expect(list(path).find(row => row.name === type)?.entry.externalStatePaths).toEqual(externalStatePaths)
    for (const paths of ['private', ['../private'], [''], [123]]) {
      const invalid = JSON.stringify({ ...definition, entry: { ...entry, externalStatePaths: paths } })
      expect(() => save(JSON.parse(invalid), 'create', path)).toThrow('外部状态路径必须是绝对路径字符串列表')
    }
  }
})
test('旧内置名不可复用，测试结果不允许注入', () => {
  expect(() => save({ ...definition, name: 'memos-cloud' }, 'create', path)).toThrow('名称')
  expect(() => save({ ...definition, entry: { ...definition.entry, lastTestResult: undefined } }, 'create', path)).toThrow('字段')
})
