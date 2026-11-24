import { expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { createCoreAgentRuntime } from './runtime'
import { closeCoreServer, createCoreServer, listenCoreServer } from './server'

async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'core-resource-http-')))
  const runtime = createCoreAgentRuntime({ host: '127.0.0.1', port: 0, configDir: root, workspaceRoot: join(root, 'workspaces'), mockAgent: true })
  const workspace = runtime.workspaces.createManaged('Owned')
  const server = createCoreServer({ version: 'resource-fixture', runtime, apiKey: 'resource-fixture' })
  await listenCoreServer(server, '127.0.0.1', 0)
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { root, runtime, workspace, base,
    async call(operation: string, args: unknown[] = [], auth = true) {
      const response = await fetch(`${base}/resources/operations`, { method: 'POST',
        headers: { 'content-type': 'application/json', ...(auth ? { authorization: 'Bearer resource-fixture' } : {}) },
        body: JSON.stringify({ operation, args }) })
      return { status: response.status, body: await response.json() as { result?: unknown; error?: string } }
    },
    async close() { await closeCoreServer(server); await runtime.shutdown(); rmSync(root, { recursive: true, force: true }) },
  }
}

test('Core资源HTTP必须鉴权、声明能力且在所属Core读写，同名slug不回本机', async () => {
  const a = await fixture(), b = await fixture()
  try {
    const identity = await fetch(`${a.base}/identity`, { headers: { authorization: 'Bearer resource-fixture' } }).then(response => response.json()) as { capabilities: string[] }
    expect(identity.capabilities).toContain('resources.manage')
    expect((await a.call('getWorkspaceMcpConfig', [a.workspace.slug], false)).status).toBe(401)
    expect((await a.call('saveWorkspaceMcpConfig', [a.workspace.slug, { servers: { owned: { type: 'http', url: 'https://fixture.invalid/mcp', enabled: true } } }])).status).toBe(200)
    expect((await a.call('getWorkspaceMcpConfig', [a.workspace.slug])).body.result).toMatchObject({ servers: { owned: { url: 'https://fixture.invalid/mcp' } } })
    expect((await b.call('getWorkspaceMcpConfig', [b.workspace.slug])).body.result).toMatchObject({ servers: {} })
    expect((await a.call('constructor')).status).toBe(400)
    expect((await a.call('getWorkspaceMcpConfig', ['missing'])).status).toBe(400)
    expect((await a.call('getWorkspaceMcpConfig', ['../escape'])).status).toBe(400)
  } finally { await a.close(); await b.close() }
})

test('Given HTTP 资源管理 When 查询删除全局Skill并提升预设 Then 不再返回不支持且严格验证确认参数', async () => {
  const f = await fixture()
  try {
    const created = await f.call('globalSkill.createUser', ['http-skill', 'HTTP skill', '', 'body'])
    expect(created.status).toBe(200)
    const id = (created.body.result as { skillId: string }).skillId
    expect((await f.call('globalSkill.getDeleteBlockers', [id])).body.result).toMatchObject({ references: [{ blocksDeletion: true }] })
    expect((await f.call('globalSkill.deleteUser', [id, `delete:${id}`])).status).toBe(400)
    expect((await f.call('globalSkill.setEnabled', [f.workspace.slug, id, false])).status).toBe(200)
    expect((await f.call('globalSkill.deleteUser', [id])).status).toBe(400)
    expect((await f.call('globalSkill.deleteUser', [id, `delete:${id}`])).status).toBe(200)
    const preset = await f.call('createAgentPreset', [f.workspace.slug, { name: 'HTTP preset', description: '' }])
    const promoted = await f.call('promoteWorkspacePresetToGlobal', [f.workspace.slug, (preset.body.result as { id: string }).id, [f.workspace.slug], true])
    expect(promoted.status).toBe(200)
    expect(promoted.body.result).toMatchObject({ name: 'HTTP preset', scope: 'user-global' })
  } finally { await f.close() }
})
