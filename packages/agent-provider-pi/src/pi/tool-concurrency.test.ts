/**
 * 工具并发策略：只读工具交回全局调度（parallel），有副作用的工具强制 sequential。
 *
 * 背景：Pi 的 `executeToolCalls` 里，只要 `config.toolExecution === 'sequential'`
 * 或任一工具 `executionMode === 'sequential'`，整批工具串行执行。
 * Profer 之前两处都设了，导致 read/grep/find/ls 也被串行化。
 */
import { describe, expect, test } from 'bun:test'
import { platform } from 'node:os'
import { buildBuiltinToolDefinitions, wrapToolWithPermission } from '../pi-agent-adapter'

interface FakeTool {
  name: string
  label: string
  description: string
  parameters: unknown
  executionMode?: string
  execute: () => Promise<{ content: unknown[] }>
}

function makeTool(name: string): FakeTool {
  return {
    name,
    label: name,
    description: `${name} tool`,
    parameters: { type: 'object', properties: {} },
    execute: async () => ({ content: [] }),
  }
}

function makeSdk(): Record<string, unknown> {
  return {
    defineTool: (definition: unknown) => definition,
    createReadToolDefinition: () => makeTool('read'),
    createGrepToolDefinition: () => makeTool('grep'),
    createFindToolDefinition: () => makeTool('find'),
    createLsToolDefinition: () => makeTool('ls'),
    createEditToolDefinition: () => makeTool('edit'),
    createWriteToolDefinition: () => makeTool('write'),
    createBashToolDefinition: () => makeTool('bash'),
  }
}

function build(): FakeTool[] {
  return buildBuiltinToolDefinitions(
    makeSdk() as never,
    'session-fixture',
    '/tmp/fixture',
    undefined,
    undefined,
  ) as unknown as FakeTool[]
}

describe('内置工具的并发模式', () => {
  test('只读工具不设 executionMode，交回全局 parallel 调度', () => {
    const tools = build()
    for (const name of ['read', 'grep', 'find', 'ls']) {
      const tool = tools.find((t) => t.name === name)
      expect(tool).toBeDefined()
      expect(tool!.executionMode).toBeUndefined()
    }
  })

  test('有副作用的工具保持 sequential，避免写入竞态与权限乱序', () => {
    const tools = build()
    for (const name of ['bash', 'edit', 'write']) {
      const tool = tools.find((t) => t.name === name)
      expect(tool).toBeDefined()
      expect(tool!.executionMode).toBe('sequential')
    }
  })

  test('只读与写入工具的划分覆盖了全部内置工具，没有遗漏', () => {
    const tools = build()
    const parallel = tools.filter((t) => t.executionMode === undefined).map((t) => t.name).sort()
    const sequential = tools.filter((t) => t.executionMode === 'sequential').map((t) => t.name).sort()
    expect(parallel).toEqual(['find', 'grep', 'ls', 'read'])
    expect(sequential).toEqual(platform() === 'win32'
      ? ['PowerShell', 'bash', 'edit', 'write']
      : ['bash', 'edit', 'write'])
    expect(parallel.length + sequential.length).toBe(tools.length)
  })
})

describe('wrapToolWithPermission 的 allowParallel', () => {
  test('默认包装后强制 sequential', () => {
    const wrapped = wrapToolWithPermission(makeTool('edit') as never, {})
    expect((wrapped as unknown as FakeTool).executionMode).toBe('sequential')
  })

  test('allowParallel 时不覆盖工具自带并发模式', () => {
    const wrapped = wrapToolWithPermission(makeTool('read') as never, { allowParallel: true })
    expect((wrapped as unknown as FakeTool).executionMode).toBeUndefined()
  })

  test('allowParallel 仍保留权限回调与工具名', () => {
    const wrapped = wrapToolWithPermission(makeTool('read') as never, { allowParallel: true })
    const tool = wrapped as unknown as FakeTool
    expect(tool.name).toBe('read')
    expect(typeof tool.execute).toBe('function')
  })
})
