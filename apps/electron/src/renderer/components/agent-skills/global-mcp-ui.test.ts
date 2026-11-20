import { expect, test } from 'bun:test'
const source = (file: string) => Bun.file(new URL(file, import.meta.url)).text()
test('全局编辑禁用防抖保存及跨工作区连接操作', async () => {
  const form = await source('../settings/McpServerForm.tsx')
  expect(form).toContain('if (!isEdit || !workspaceSlug) return')
  expect(form).toContain('isEdit && workspaceSlug && (')
  expect(form).toContain('await onGlobalSave(serverName, buildGlobalFormEntry(entry, server?.entry))')
})
test('工作区摘要不读取全局定义或调用配置写入口', async () => {
  const summary = await source('./WorkspaceGlobalMcpList.tsx')
  expect(summary).toContain('listWorkspaceGlobalMcpServers(workspaceSlug)')
  expect(summary).not.toMatch(/listGlobalMcpServers|saveWorkspaceMcpConfig|deleteGlobalMcpServer/)
})

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveGlobalMcpServer, listGlobalMcpServers } from '../../../main/lib/global-mcp-store'
import { buildGlobalFormEntry } from '../settings/mcp-form-entry'

test('全局表单生成的对象原样通过 store 的严格校验，不靠 JSON 删除 undefined', () => {
  const dir = mkdtempSync(join(tmpdir(), 'profer-mcp-form-'))
  const path = join(dir, 'test.json')
  try {
    const entry = buildGlobalFormEntry({ type: 'http', enabled: true, url: 'https://example.invalid', lastTestResult: undefined, isBuiltin: true }, undefined)
    const definition = { name: 'sample', workspaceIds: ['ws-id'], entry }
    saveGlobalMcpServer(definition, 'create', path)
    expect(listGlobalMcpServers(path)).toEqual([definition])
    expect(buildGlobalFormEntry(entry, { ...entry, externalStatePaths: ['/example/config'] }).externalStatePaths).toEqual(['/example/config'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
