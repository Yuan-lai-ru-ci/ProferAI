import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { dialog } from 'electron'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type {
  PluginCapabilityDeclaration,
  PluginPresetMetadata,
  PluginRequestContext,
  PluginRuntimeCapabilityView,
  PluginSecretMetadata,
  PluginSessionMetadata,
} from '@profer/plugin-api'
import { callPluginHost } from './plugin-host'
import { pluginConfirmations } from './plugin-confirmation'
import { configurePluginCapabilityProviders, clearPluginCapabilityProviders } from './provider-registry'
import { PluginRpcError } from './plugin-rpc-errors'
import type { PluginCapabilityProviders, PluginProviderContext, PresetProvider, RuntimeCapabilityProvider, SecretProvider, SessionProvider } from './ports/capabilities'
import { installPluginPackage } from './plugin-manager'
import { authorizePlugin } from './plugin-permissions'
import { setPluginEnabled } from './plugin-manager'
import { configureWorkspaceProvider } from './workspace-provider'
import { createLocalWorkspaceProvider, type WorkspaceProvider } from './ports/workspace'

mock.module('electron', () => ({
  app: { getVersion: () => '0.15.80' },
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
  dialog: { showMessageBox: async () => ({ response: 1 }) },
  shell: {},
}))
Object.assign(dialog, { showMessageBox: async () => ({ response: 1 }) })
mock.module('../main-window-state', () => ({ getMainWindow: () => ({}) }))

const researchId = 'com.example.research'
const taskBoardId = 'com.example.task-board'
const workspaceId = 'shared'
let root = ''

function context(pluginId: string, requestId: string, operation: string): PluginRequestContext {
  return { pluginId, pageId: 'main', ownerId: pluginId === researchId ? 31 : 32, requestId, operation, signal: new AbortController().signal }
}
function request(requestId: string, operation: string, payload: unknown) {
  return { protocol: 'plugin-host.rpc.v1' as const, requestId, operation, payload }
}
function session(id: string, title: string, revision: number): PluginSessionMetadata {
  return { sessionId: id, workspaceId, title, status: 'idle', runtime: 'claude', presetId: 'research', presetVersion: 1, createdAt: 1, updatedAt: 2, revision }
}
function preset(id: string, displayName: string): PluginPresetMetadata {
  return { presetId: id, displayName, version: 1, enabled: true }
}
function runtimeView(references: PluginCapabilityDeclaration['references'], revision: number, outcome: PluginRuntimeCapabilityView['outcome'] = 'committed'): PluginRuntimeCapabilityView {
  return { snapshotId: `snapshot-${revision}`, fingerprint: `fingerprint-${revision}`, runtime: 'claude', references, revision, effectiveFrom: 'next_turn', outcome }
}

const presetProvider: PresetProvider = {
  async list() { return { revision: 1, items: [preset('research', 'Research'), preset('board', 'Task board')] } },
  async get(_input, _context) { return preset('research', 'Research') },
}
const sessions = new Map<string, PluginSessionMetadata>([['session-1', session('session-1', 'Research', 1)]])
const sessionProvider: SessionProvider = {
  async list() { return { revision: 1, items: [...sessions.values()] } },
  async get(input) { const value = sessions.get(input.sessionId); if (!value) throw new Error('missing'); return value },
  async create(input) { const value = session('created', input.title ?? 'Untitled', 1); sessions.set(value.sessionId, value); return value },
  async configure(input) { const current = sessions.get(input.sessionId)!; if (input.expectedRevision !== current.revision) throw new Error('stale'); const value = { ...current, title: input.title ?? current.title, revision: current.revision + 1 }; sessions.set(value.sessionId, value); return value },
  async requestPreset(input) { return { sessionId: input.sessionId, presetId: input.presetId, effectiveFrom: 'next_turn', revision: input.expectedRevision + 1, auditEventId: 'audit-preset-1' } },
  async cancel(input) { const current = sessions.get(input.sessionId)!; const value = { ...current, status: 'cancelled' as const, revision: input.expectedRevision + 1 }; sessions.set(value.sessionId, value); return value },
}
let currentRuntimeView = runtimeView([{ kind: 'service', id: 'old-service', version: 1 }], 2)
const runtimeProvider: RuntimeCapabilityProvider = {
  async resolve() { return currentRuntimeView },
  async inject(input) {
    if (input.declaration.references.some((reference) => reference.id === 'reject')) throw new PluginRpcError('PLUGIN_RUNTIME_INJECTION_FAILED', 'runtime injection failed')
    currentRuntimeView = runtimeView(input.declaration.references, input.expectedRevision + 1)
    return currentRuntimeView
  },
}
const secretMetadata: PluginSecretMetadata = { secretId: 'secret-ref-1', providerId: 'research-api', field: 'token', configured: true, updatedAt: '2026-09-15T00:00:00.000Z' }
const ungrantedSecretMetadata: PluginSecretMetadata = { secretId: 'secret-ref-2', providerId: 'research-api', field: 'password', configured: true, updatedAt: '2026-09-15T00:00:00.000Z' }
let secretRevision = 1
const secretProvider: SecretProvider = {
  async listMetadata() { return { revision: secretRevision, items: [secretMetadata, ungrantedSecretMetadata] } },
  async requestConfigure(input) {
    if (input.expectedRevision !== secretRevision) throw new PluginRpcError('PLUGIN_REVISION_CONFLICT', 'secret revision 冲突', false, { expectedRevision: input.expectedRevision, actualRevision: secretRevision })
    secretRevision += 1
    return { secretId: secretMetadata.secretId, providerId: secretMetadata.providerId, field: secretMetadata.field }
  },
}

const providers: PluginCapabilityProviders = { sessions: sessionProvider, presets: presetProvider, runtime: runtimeProvider, secrets: secretProvider }

function install(id: string, permissions: string[]): void {
  const source = join(root, id)
  mkdirSync(join(source, 'dist'), { recursive: true })
  writeFileSync(join(source, 'dist', 'index.html'), '<!doctype html>', 'utf8')
  writeFileSync(join(source, 'profer-plugin.json'), JSON.stringify({
    schemaVersion: 1, id, name: id, version: '1.0.0', permissions,
    workspaceScopes: [{ workspaceId, prefixes: ['notes'] }],
    providerScopes: [{ providerId: 'research-api', fields: ['token'] }],
    contributes: { pages: [{ id: 'main', title: 'Main', entry: 'dist/index.html' }] },
  }), 'utf8')
  expect(installPluginPackage(source).ok).toBe(true)
}
function grant(id: string): Promise<boolean> { return authorizePlugin(id) }

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'profer-plugin-provider-'))
  process.env.PROFER_CONFIG_DIR = join(root, 'config')
  install(researchId, ['presets.read', 'presets.switch', 'sessions.read', 'sessions.create', 'sessions.configure', 'sessions.control', 'runtime.capabilities.read', 'runtime.capabilities.inject', 'secrets.readMetadata', 'secrets.configure'])
  install(taskBoardId, ['presets.read', 'sessions.read', 'runtime.capabilities.read', 'secrets.readMetadata'])
  expect(await grant(researchId)).toBe(true)
  expect(await grant(taskBoardId)).toBe(true)
  const workspaceRoot = join(root, 'workspace')
  mkdirSync(join(workspaceRoot, 'notes'), { recursive: true })
  const workspace: WorkspaceProvider = createLocalWorkspaceProvider([{ workspaceId, displayName: 'Shared workspace', rootPath: workspaceRoot }])
  configureWorkspaceProvider(workspace)
  currentRuntimeView = runtimeView([{ kind: 'service', id: 'research-api', version: 1 }], 2)
  secretRevision = 1
  configurePluginCapabilityProviders(providers)
})

afterEach(() => {
  clearPluginCapabilityProviders()
  configureWorkspaceProvider(undefined)
  delete process.env.PROFER_CONFIG_DIR
  rmSync(root, { recursive: true, force: true })
})

test('research plugin and task-board plugin share opaque session/runtime/secret contracts', async () => {
  const researchPresets = await callPluginHost(request('research-presets', 'sessions.presets.list', { workspaceId }), context(researchId, 'research-presets', 'sessions.presets.list'), null)
  const boardPresets = await callPluginHost(request('board-presets', 'sessions.presets.list', { workspaceId }), context(taskBoardId, 'board-presets', 'sessions.presets.list'), null)
  expect(researchPresets).toEqual(boardPresets)

  const runtime = await callPluginHost(request('research-runtime', 'runtime.capabilities.resolve', { workspaceId, runtime: 'claude', declaration: { references: [{ kind: 'service', id: 'research-api', version: 1 }] } }), context(researchId, 'research-runtime', 'runtime.capabilities.resolve'), null)
  expect(runtime).toMatchObject({ fingerprint: 'fingerprint-2', references: [{ kind: 'service', id: 'research-api', version: 1 }] })

  const secrets = await callPluginHost(request('board-secrets', 'secrets.metadata.list', { providerId: 'research-api' }), context(taskBoardId, 'board-secrets', 'secrets.metadata.list'), null)
  expect(secrets).toEqual({ revision: 1, items: [secretMetadata] })
  expect(JSON.stringify(secrets)).not.toContain('plaintext')
  await expect(callPluginHost(request('outside-secret', 'secrets.metadata.list', { providerId: 'other-api' }), context(taskBoardId, 'outside-secret', 'secrets.metadata.list'), null)).rejects.toMatchObject({ code: 'PLUGIN_PERMISSION_DENIED' })
})

test('session mutation requires host confirmation and integer CAS, then applies next-turn preset semantics', async () => {
  const basePayload = { workspaceId, sessionId: 'session-1', title: 'Updated', expectedRevision: 1 }
  await expect(callPluginHost(request('configure-1', 'sessions.configure', basePayload), context(researchId, 'configure-1', 'sessions.configure'), null)).rejects.toMatchObject({ code: 'PLUGIN_CONFIRMATION_REQUIRED' })
  const token = pluginConfirmations.issue({ pluginId: researchId, pageId: 'main', ownerId: 31, requestId: 'configure-1', operation: 'sessions.configure', resource: `workspace:${workspaceId}/session:session-1`, revision: 1 })
  await expect(callPluginHost(request('configure-1', 'sessions.configure', { ...basePayload, confirmationId: token }), context(researchId, 'configure-1', 'sessions.configure'), null)).resolves.toMatchObject({ title: 'Updated', revision: 2 })

  const presetToken = pluginConfirmations.issue({ pluginId: researchId, pageId: 'main', ownerId: 31, requestId: 'preset-1', operation: 'sessions.preset.request', resource: `workspace:${workspaceId}/session:session-1`, revision: 2 })
  await expect(callPluginHost(request('preset-1', 'sessions.preset.request', { workspaceId, sessionId: 'session-1', presetId: 'board', expectedRevision: 2, confirmationId: presetToken }), context(researchId, 'preset-1', 'sessions.preset.request'), null)).resolves.toMatchObject({ effectiveFrom: 'next_turn', auditEventId: 'audit-preset-1' })
})

test('runtime injection failure does not replace the old view and provider failure is not a fake success', async () => {
  currentRuntimeView = runtimeView([{ kind: 'service', id: 'old-service', version: 1 }], 2)
  const before = await callPluginHost(request('runtime-before', 'runtime.capabilities.resolve', { workspaceId, runtime: 'claude', declaration: { references: [{ kind: 'service', id: 'old-service', version: 1 }] } }), context(researchId, 'runtime-before', 'runtime.capabilities.resolve'), null)
  const token = pluginConfirmations.issue({ pluginId: researchId, pageId: 'main', ownerId: 31, requestId: 'inject-1', operation: 'runtime.capabilities.inject', resource: `workspace:${workspaceId}`, revision: 2 })
  await expect(callPluginHost(request('inject-1', 'runtime.capabilities.inject', { workspaceId, runtime: 'claude', declaration: { references: [{ kind: 'tool', id: 'reject' }] }, expectedRevision: 2, confirmationId: token }), context(researchId, 'inject-1', 'runtime.capabilities.inject'), null)).rejects.toMatchObject({ code: 'PLUGIN_RUNTIME_INJECTION_FAILED' })
  const after = await callPluginHost(request('runtime-after', 'runtime.capabilities.resolve', { workspaceId, runtime: 'claude', declaration: { references: [{ kind: 'service', id: 'old-service', version: 1 }] } }), context(researchId, 'runtime-after', 'runtime.capabilities.resolve'), null)
  expect(after).toEqual(before)
  configurePluginCapabilityProviders({ presets: presetProvider, runtime: runtimeProvider, secrets: secretProvider })
  await expect(callPluginHost(request('missing-1', 'sessions.list', { workspaceId }), context(taskBoardId, 'missing-1', 'sessions.list'), null)).rejects.toMatchObject({ code: 'PLUGIN_OPERATION_NOT_SUPPORTED' })
})

test('secret metadata always applies provider and field scopes, including omitted providerId', async () => {
  const omitted = await callPluginHost(request('secret-list-all', 'secrets.metadata.list', {}), context(researchId, 'secret-list-all', 'secrets.metadata.list'), null)
  expect(omitted).toEqual({ revision: 1, items: [secretMetadata] })
  const selected = await callPluginHost(request('secret-list-one', 'secrets.metadata.list', { providerId: 'research-api' }), context(researchId, 'secret-list-one', 'secrets.metadata.list'), null)
  expect(selected).toEqual({ revision: 1, items: [secretMetadata] })
  const board = await callPluginHost(request('secret-list-board', 'secrets.metadata.list', {}), context(taskBoardId, 'secret-list-board', 'secrets.metadata.list'), null)
  expect(board).toEqual({ revision: 1, items: [secretMetadata] })
})

test('secret configure passes expectedRevision to provider and rejects stale concurrent revisions', async () => {
  const firstToken = pluginConfirmations.issue({ pluginId: researchId, pageId: 'main', ownerId: 31, requestId: 'secret-1', operation: 'secrets.configure.request', resource: 'provider:research-api/field:token', revision: 1 })
  const first = await callPluginHost(request('secret-1', 'secrets.configure.request', { providerId: 'research-api', field: 'token', expectedRevision: 1, confirmationId: firstToken }), context(researchId, 'secret-1', 'secrets.configure.request'), null)
  expect(first).toEqual({ secretId: 'secret-ref-1', providerId: 'research-api', field: 'token' })
  expect(JSON.stringify(first)).not.toContain('plaintext')

  const staleToken = pluginConfirmations.issue({ pluginId: researchId, pageId: 'main', ownerId: 31, requestId: 'secret-stale', operation: 'secrets.configure.request', resource: 'provider:research-api/field:token', revision: 1 })
  await expect(callPluginHost(request('secret-stale', 'secrets.configure.request', { providerId: 'research-api', field: 'token', expectedRevision: 1, confirmationId: staleToken }), context(researchId, 'secret-stale', 'secrets.configure.request'), null)).rejects.toMatchObject({ code: 'PLUGIN_REVISION_CONFLICT' })
  await expect(callPluginHost(request('secret-missing-revision', 'secrets.configure.request', { providerId: 'research-api', field: 'token' }), context(researchId, 'secret-missing-revision', 'secrets.configure.request'), null)).rejects.toMatchObject({ code: 'PLUGIN_INVALID_ARGUMENT' })
})

test('session projection rejects provider metadata from another workspace or session', async () => {
  const foreignProvider: SessionProvider = {
    ...sessionProvider,
    async get() { return { ...session('foreign', 'Foreign', 1), workspaceId: 'other-workspace' } },
  }
  configurePluginCapabilityProviders({ ...providers, sessions: foreignProvider })
  await expect(callPluginHost(request('foreign-session', 'sessions.get', { workspaceId, sessionId: 'session-1' }), context(researchId, 'foreign-session', 'sessions.get'), null)).rejects.toMatchObject({ code: 'PLUGIN_INTERNAL_ERROR' })

  const foreignListProvider: SessionProvider = {
    ...sessionProvider,
    async list() { return { revision: 1, items: [{ ...session('foreign', 'Foreign', 1), workspaceId: 'other-workspace' }] } },
  }
  configurePluginCapabilityProviders({ ...providers, sessions: foreignListProvider })
  await expect(callPluginHost(request('foreign-list', 'sessions.list', { workspaceId }), context(researchId, 'foreign-list', 'sessions.list'), null)).rejects.toMatchObject({ code: 'PLUGIN_INTERNAL_ERROR' })
})

test('runtime projection rejects unknown outcome with stable error mapping', async () => {
  const invalidProvider: RuntimeCapabilityProvider = { ...runtimeProvider, async resolve() { return { ...currentRuntimeView, outcome: 'partial' as never } } }
  configurePluginCapabilityProviders({ ...providers, runtime: invalidProvider })
  await expect(callPluginHost(request('runtime-invalid-resolve', 'runtime.capabilities.resolve', { workspaceId, runtime: 'claude', declaration: { references: [] } }), context(researchId, 'runtime-invalid-resolve', 'runtime.capabilities.resolve'), null)).rejects.toMatchObject({ code: 'PLUGIN_INVALID_ARGUMENT' })

  const invalidInjectionProvider: RuntimeCapabilityProvider = { ...runtimeProvider, async inject() { return { ...currentRuntimeView, outcome: 'partial' as never } } }
  configurePluginCapabilityProviders({ ...providers, runtime: invalidInjectionProvider })
  const token = pluginConfirmations.issue({ pluginId: researchId, pageId: 'main', ownerId: 31, requestId: 'runtime-invalid-inject', operation: 'runtime.capabilities.inject', resource: `workspace:${workspaceId}`, revision: 2 })
  await expect(callPluginHost(request('runtime-invalid-inject', 'runtime.capabilities.inject', { workspaceId, runtime: 'claude', declaration: { references: [] }, expectedRevision: 2, confirmationId: token }), context(researchId, 'runtime-invalid-inject', 'runtime.capabilities.inject'), null)).rejects.toMatchObject({ code: 'PLUGIN_RUNTIME_INJECTION_FAILED' })

  const missingOutcomeProvider: RuntimeCapabilityProvider = { ...runtimeProvider, async resolve() { const { outcome: _outcome, ...withoutOutcome } = currentRuntimeView; return withoutOutcome } }
  configurePluginCapabilityProviders({ ...providers, runtime: missingOutcomeProvider })
  await expect(callPluginHost(request('runtime-missing-outcome', 'runtime.capabilities.resolve', { workspaceId, runtime: 'claude', declaration: { references: [] } }), context(researchId, 'runtime-missing-outcome', 'runtime.capabilities.resolve'), null)).rejects.toMatchObject({ code: 'PLUGIN_INVALID_ARGUMENT' })
})
