import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

mock.module('electron', () => ({
  app: { getVersion: () => '0.15.80' },
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  shell: { openPath: async () => '' },
}))

const { canonicalizePluginScopePrefix, canonicalizePluginWorkspaceScopes } = await import('./plugin-capability-boundary')
const { PluginConfirmations } = await import('./plugin-confirmation')
const { validatePluginRpcRequest, dispatchPluginRpc } = await import('./plugin-host-rpc')
const { PluginRequests } = await import('./plugin-requests')
const { callPluginHost } = await import('./plugin-host')
const { installPluginPackage, setPluginEnabled } = await import('./plugin-manager')
const { revokePluginPermissions } = await import('./plugin-permissions')

type PluginHostContext = Parameters<typeof callPluginHost>[1]
const pluginId = 'com.example.priority'
let fixtureRoot = ''

const binding = { pluginId: 'com.example.plugin', pageId: 'main', ownerId: 7, requestId: 'request-1', operation: 'workspace.files.write', resource: 'workspace:demo', revision: 3 }

function request(requestId = 'priority-request') {
  return { protocol: 'plugin-host.rpc.v1' as const, requestId, operation: 'workspace.list' as const, payload: {} }
}

function context(): PluginHostContext {
  return { pluginId, pageId: 'main', ownerId: 7, requestId: 'priority-request', operation: 'workspace.list', signal: new AbortController().signal }
}

function installPriorityPlugin(): void {
  const source = join(fixtureRoot, 'source')
  mkdirSync(join(source, 'dist'), { recursive: true })
  writeFileSync(join(source, 'dist', 'index.html'), '<!doctype html><title>Priority</title>', 'utf8')
  writeFileSync(join(source, 'profer-plugin.json'), JSON.stringify({
    schemaVersion: 1, id: pluginId, name: 'Priority Plugin', version: '1.0.0', permissions: ['workspace.read'],
    contributes: { pages: [{ id: 'main', title: 'Main', entry: 'dist/index.html' }] },
  }), 'utf8')
  expect(installPluginPackage(source).ok).toBe(true)
}

function grantPriorityPlugin(): void {
  mkdirSync(join(process.env.PROFER_CONFIG_DIR!, 'plugins'), { recursive: true })
  writeFileSync(join(process.env.PROFER_CONFIG_DIR!, 'plugin-permissions.json'), JSON.stringify({
    [pluginId]: { permissions: ['workspace.read'], origins: [], revoked: false },
  }), 'utf8')
}

beforeEach(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'profer-plugin-priority-'))
  process.env.PROFER_CONFIG_DIR = join(fixtureRoot, 'config')
})

afterEach(() => {
  delete process.env.PROFER_CONFIG_DIR
  rmSync(fixtureRoot, { recursive: true, force: true })
})

afterEach(() => mock.restore())

test('scope canonicalizer rejects absolute, traversal, NUL and backslash paths', () => {
  expect(canonicalizePluginScopePrefix('./notes/')).toBe('notes')
  for (const value of ['/notes', '../notes', 'notes/../private', 'notes\\private', 'notes\0x']) {
    expect(() => canonicalizePluginScopePrefix(value)).toThrow()
  }
})

test('workspace scopes are normalized and duplicate declarations rejected', () => {
  expect(canonicalizePluginWorkspaceScopes([{ workspaceId: ' demo ', prefixes: ['./notes/', 'notes'] }])).toEqual([{ workspaceId: 'demo', prefixes: ['notes'] }])
  expect(() => canonicalizePluginWorkspaceScopes([{ workspaceId: 'demo', prefixes: ['notes'] }, { workspaceId: 'demo', prefixes: ['notes'] }])).toThrow()
})

test('confirmation token is one-shot and bound to owner/request/resource/revision', () => {
  const confirmations = new PluginConfirmations()
  const token = confirmations.issue(binding)
  expect(() => confirmations.consume(token, { ...binding, ownerId: 8 })).toThrow()
  // 绑定不匹配会消费令牌，避免攻击者反复试探令牌内容。
  expect(() => confirmations.consume(token, binding)).toThrow()
})

test('RPC request schema requires version, stable requestId, operation and payload', () => {
  expect(validatePluginRpcRequest({ protocol: 'plugin-host.rpc.v1', requestId: 'request-1', operation: 'workspace.list', payload: {} })).toMatchObject({ requestId: 'request-1' })
  expect(() => validatePluginRpcRequest({ protocol: 'wrong', requestId: 'request-1', operation: 'workspace.list', payload: {} })).toThrow()
  expect(() => validatePluginRpcRequest({ protocol: 'plugin-host.rpc.v1', requestId: 'bad id', operation: 'workspace.list', payload: {} })).toThrow()
  expect(() => validatePluginRpcRequest({ protocol: 'plugin-host.rpc.v1', requestId: 'request-1', operation: 'workspace.list' })).toThrow()
})

test('requests.cancel 只能取消宿主解析出的同一 owner 请求', async () => {
  const requests = new PluginRequests()
  const first = requests.run('com.example.plugin', 'request-1', async () => new Promise(() => undefined), 5_000, 7)
  expect(requests.cancel('com.example.plugin', 'request-1', 8)).toBe(false)
  expect(requests.cancel('com.example.plugin', 'request-1', 7)).toBe(true)
  await expect(first).rejects.toMatchObject({ code: 'PLUGIN_REQUEST_CANCELLED' })
})

test('直接 host handler 在 provider 缺失时保持生命周期和权限错误优先级', async () => {
  installPriorityPlugin()

  grantPriorityPlugin()
  setPluginEnabled(pluginId, false)
  await expect(callPluginHost(request(), context(), null)).rejects.toMatchObject({ code: 'PLUGIN_DISABLED' })

  setPluginEnabled(pluginId, true)
  revokePluginPermissions(pluginId)
  await expect(callPluginHost(request('revoked-request'), { ...context(), requestId: 'revoked-request' }, null)).rejects.toMatchObject({ code: 'PLUGIN_REVOKED' })

  // 新装插件声明了 workspace.read，但尚未获得宿主授权；provider 缺失不能遮蔽权限拒绝。
  const missingPermissionRoot = join(fixtureRoot, 'missing-permission')
  mkdirSync(join(missingPermissionRoot, 'dist'), { recursive: true })
  writeFileSync(join(missingPermissionRoot, 'dist', 'index.html'), '<!doctype html>', 'utf8')
  writeFileSync(join(missingPermissionRoot, 'profer-plugin.json'), JSON.stringify({
    schemaVersion: 1, id: 'com.example.missing-permission', name: 'Missing Permission', version: '1.0.0', permissions: ['workspace.read'],
    contributes: { pages: [{ id: 'main', title: 'Main', entry: 'dist/index.html' }] },
  }), 'utf8')
  expect(installPluginPackage(missingPermissionRoot).ok).toBe(true)
  await expect(callPluginHost({ ...request('permission-request'), requestId: 'permission-request' }, { ...context(), pluginId: 'com.example.missing-permission', requestId: 'permission-request' }, null)).rejects.toMatchObject({ code: 'PLUGIN_PERMISSION_DENIED' })

  grantPriorityPlugin()
  await expect(callPluginHost({ ...request('provider-request'), requestId: 'provider-request' }, { ...context(), requestId: 'provider-request' }, null)).rejects.toMatchObject({ code: 'PLUGIN_OPERATION_NOT_SUPPORTED' })
})

test('统一 dispatcher 为成功、校验失败和超时返回完整 response envelope', async () => {
  const base = { pluginId: 'com.example.plugin', pageId: 'main', ownerId: 7, requestId: 'request-1', operation: 'workspace.list', signal: new AbortController().signal }
  const success = await dispatchPluginRpc({ protocol: 'plugin-host.rpc.v1', requestId: 'request-1', operation: 'workspace.list', payload: {} }, base, async () => ({ items: [] }))
  expect(success).toMatchObject({ protocol: 'plugin-host.rpc.v1', ok: true, requestId: 'request-1', operation: 'workspace.list' })
  const invalid = await dispatchPluginRpc({ protocol: 'wrong', requestId: 'request-2', operation: 'workspace.list', payload: {} }, { ...base, requestId: 'request-2' }, async () => ({}))
  expect(invalid).toMatchObject({ protocol: 'plugin-host.rpc.v1', ok: false, requestId: 'request-2', operation: 'workspace.list', error: { code: 'PLUGIN_INVALID_ARGUMENT' } })
  const timeout = await dispatchPluginRpc({ protocol: 'plugin-host.rpc.v1', requestId: 'request-3', operation: 'workspace.list', timeoutMs: 1, payload: {} }, { ...base, requestId: 'request-3' }, async () => new Promise(() => undefined))
  expect(timeout).toMatchObject({ protocol: 'plugin-host.rpc.v1', ok: false, requestId: 'request-3', operation: 'workspace.list', error: { code: 'PLUGIN_REQUEST_TIMEOUT' } })
})
