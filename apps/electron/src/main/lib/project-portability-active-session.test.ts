import { afterAll, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

mock.module('electron', () => ({
  app: { getPath: () => '', getName: () => 'profer-dev', isPackaged: false },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (value: string) => Buffer.from(value) },
  BrowserWindow: { getAllWindows: () => [], fromWebContents: () => undefined },
  dialog: {}, nativeImage: {}, nativeTheme: {}, Notification: class {}, powerMonitor: {},
  powerSaveBlocker: {}, screen: {}, shell: {}, net: {}, protocol: {}, session: {}, systemPreferences: {},
  View: {}, WebContentsView: class {},
}))

const sandbox = mkdtempSync(join(tmpdir(), 'profer-active-project-portability-'))
const configRoot = join(sandbox, 'config')
const root = join(sandbox, 'project')
const workspaceId = 'workspace-portability'
const sessionId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const dataDir = join(root, '.profer', 'sessions', sessionId)
process.env.PROFER_DEV = '1'
process.env.PROFER_CONFIG_DIR = configRoot
mkdirSync(dataDir, { recursive: true })
mkdirSync(join(configRoot, 'agent-sessions'), { recursive: true })
writeFileSync(join(configRoot, 'agent-workspaces.json'), JSON.stringify({
  version: 4,
  workspaces: [{ id: workspaceId, name: 'project', slug: 'project', createdAt: 1, updatedAt: 1, type: 'personal', storageMode: 'project', rootPath: root }],
}))
writeFileSync(join(configRoot, 'agent-sessions.json'), JSON.stringify({
  version: 1,
  sessions: [{ id: sessionId, title: 'legacy active', workspaceId, storageLayout: 'managed', agentRuntime: 'pi', createdAt: 1, updatedAt: 2 }],
}))
writeFileSync(join(configRoot, 'agent-sessions', `${sessionId}.jsonl`), '{"type":"user","uuid":"legacy-message"}\n')
writeFileSync(join(dataDir, 'session.json'), JSON.stringify({ id: sessionId, title: 'legacy active', workspaceId, storageLayout: 'managed' }))

const manager = await import('./agent-session-manager')
const locator = await import('./workspace-locator')

afterAll(() => {
  manager.setAgentSessionActiveChecker(undefined)
  rmSync(sandbox, { recursive: true, force: true })
})

test('portability skips active and incomplete sessions, remains retryable, then promotes after messages arrive', async () => {
  locator.invalidateWorkspaceLocation()
  manager.setAgentSessionActiveChecker((id) => id === sessionId)
  await manager.ensureProjectSessionPortability(workspaceId)
  expect(manager.getAgentSessionMeta(sessionId)?.storageLayout).toBe('managed')

  manager.setAgentSessionActiveChecker(undefined)
  await manager.ensureProjectSessionPortability(workspaceId)
  expect(manager.getAgentSessionMeta(sessionId)?.storageLayout).toBe('managed')

  // A completed move leaves only the project copy; only then may portability promote it.
  unlinkSync(join(configRoot, 'agent-sessions', `${sessionId}.jsonl`))
  writeFileSync(join(dataDir, 'messages.jsonl'), '{"type":"user","uuid":"project-message"}\n')
  await manager.ensureProjectSessionPortability(workspaceId)
  expect(manager.getAgentSessionMeta(sessionId)?.storageLayout).toBe('project')
  expect(existsSync(join(dataDir, 'messages.jsonl'))).toBe(true)
})
