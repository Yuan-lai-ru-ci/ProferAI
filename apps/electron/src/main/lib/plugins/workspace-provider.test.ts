import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { dialog } from 'electron'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createLocalWorkspaceProvider } from './ports/workspace'
import { configureWorkspaceProvider } from './workspace-provider'
import { callPluginHost } from './plugin-host'
import { pluginConfirmations } from './plugin-confirmation'
import type { PluginRequestContext } from '@profer/plugin-api'

let root = ''
const pluginId = 'com.example.workspace-editor'
const workspaceId = 'editor'
const context = (requestId: string, operation: string): PluginRequestContext => ({ pluginId, pageId: 'main', ownerId: 11, requestId, operation, signal: new AbortController().signal })
mock.module('electron', () => ({ app: { getVersion: () => '0.15.80' }, BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null }, dialog: { showMessageBox: async () => ({ response: 1 }) }, shell: {} }))
mock.module('../main-window-state', () => ({ getMainWindow: () => ({}) }))
Object.assign(dialog, { showMessageBox: async () => ({ response: 1 }) })
const manager = await import('./plugin-manager')
const permissions = await import('./plugin-permissions')

afterEach(() => { configureWorkspaceProvider(undefined); delete process.env.PROFER_CONFIG_DIR; rmSync(root, { recursive: true, force: true }) })
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'profer-plugin-provider-'))
  process.env.PROFER_CONFIG_DIR = join(root, 'config')
  const source = join(root, 'plugin'); mkdirSync(join(source, 'dist'), { recursive: true })
  writeFileSync(join(source, 'dist', 'index.html'), '<!doctype html>')
  writeFileSync(join(source, 'profer-plugin.json'), JSON.stringify({ schemaVersion: 1, id: pluginId, name: 'Workspace editor', version: '1.0.0', permissions: ['workspace.read', 'workspace.files.read', 'workspace.files.write'], workspaceScopes: [{ workspaceId, prefixes: ['notes'] }], contributes: { pages: [{ id: 'main', title: 'Main', entry: 'dist/index.html' }] } }))
  expect(manager.installPluginPackage(source).ok).toBe(true)
  expect(await permissions.authorizePlugin(pluginId)).toBe(true)
  mkdirSync(join(root, 'workspace', 'notes'), { recursive: true })
  writeFileSync(join(root, 'workspace', 'notes', 'old.txt'), 'old')
  configureWorkspaceProvider(createLocalWorkspaceProvider([{ workspaceId, displayName: 'Editor', rootPath: join(root, 'workspace') }]))
})

test('宿主通过注入 provider 返回通用 workspace/file DTO，并拒绝越权前缀', async () => {
  const listed = await callPluginHost({ protocol: 'plugin-host.rpc.v1', requestId: 'list-1', operation: 'workspace.list', payload: {} }, context('list-1', 'workspace.list'), null)
  expect(listed).toEqual({ items: [{ workspaceId, displayName: 'Editor', revision: 0 }], revision: 0 })
  const files = await callPluginHost({ protocol: 'plugin-host.rpc.v1', requestId: 'files-1', operation: 'workspace.files.list', payload: { workspaceId, path: 'notes', depth: 1 } }, context('files-1', 'workspace.files.list'), null)
  expect(files).toMatchObject({ entries: [{ path: 'notes/old.txt', kind: 'file' }] })
  await expect(callPluginHost({ protocol: 'plugin-host.rpc.v1', requestId: 'outside-1', operation: 'workspace.files.read', payload: { workspaceId, path: 'other.txt' } }, context('outside-1', 'workspace.files.read'), null)).rejects.toMatchObject({ code: 'PLUGIN_PERMISSION_DENIED' })
})

test('宿主写入要求绑定的一次性确认令牌，并保留 CAS 冲突', async () => {
  const binding = { pluginId, pageId: 'main', ownerId: 11, requestId: 'write-1', operation: 'workspace.files.write', resource: `workspace:${workspaceId}/notes/new.txt`, revision: 0 }
  await expect(callPluginHost({ protocol: 'plugin-host.rpc.v1', requestId: 'write-1', operation: 'workspace.files.write', payload: { workspaceId, path: 'notes/new.txt', content: 'new', mode: 'create', expectedRevision: 0 } }, context('write-1', 'workspace.files.write'), null)).rejects.toMatchObject({ code: 'PLUGIN_CONFIRMATION_REQUIRED' })
  const token = pluginConfirmations.issue(binding)
  await expect(callPluginHost({ protocol: 'plugin-host.rpc.v1', requestId: 'write-1', operation: 'workspace.files.write', payload: { workspaceId, path: 'notes/new.txt', content: 'new', mode: 'create', expectedRevision: 0, confirmationId: token } }, context('write-1', 'workspace.files.write'), null)).resolves.toMatchObject({ committed: true, revision: 1 })
  await expect(callPluginHost({ protocol: 'plugin-host.rpc.v1', requestId: 'write-2', operation: 'workspace.files.write', payload: { workspaceId, path: 'notes/new.txt', content: 'stale', mode: 'replace', expectedRevision: 0 } }, context('write-2', 'workspace.files.write'), null)).rejects.toMatchObject({ code: 'PLUGIN_CONFIRMATION_REQUIRED' })
})
