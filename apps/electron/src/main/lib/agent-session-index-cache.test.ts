import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

mock.module('electron', () => ({
  BrowserWindow: { getAllWindows: () => [], fromWebContents: () => undefined },
  app: { getPath: () => '', isPackaged: false },
  clipboard: { readText: () => '', writeText: () => undefined },
  dialog: {},
  nativeImage: {},
  nativeTheme: {},
  Notification: class {},
  powerMonitor: {},
  powerSaveBlocker: {},
  safeStorage: {},
  screen: {},
  shell: {},
  systemPreferences: {},
}))

let root = ''
let sessions: typeof import('./agent-session-manager')
let configPaths: typeof import('./config-paths')

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'profer-session-index-cache-test-'))
  process.env.PROFER_CONFIG_DIR = root
  const cacheKey = `${Date.now()}-${Math.random()}`
  sessions = await import(`./agent-session-manager?index-cache-test=${cacheKey}`)
  configPaths = await import(`./config-paths?index-cache-test=${cacheKey}`)
})

afterEach(() => {
  delete process.env.PROFER_CONFIG_DIR
  if (root) rmSync(root, { recursive: true, force: true })
})

describe('Agent session index cache', () => {
  test('Given an external index replacement When reading metadata Then invalidates the cached index', () => {
    const session = sessions.createAgentSession('cached title')
    const indexPath = configPaths.getAgentSessionsIndexPath()

    writeFileSync(indexPath, JSON.stringify({
      version: 1,
      sessions: [{ ...session, title: 'externally replaced title', updatedAt: session.updatedAt + 1 }],
    }, null, 2), 'utf-8')

    expect(sessions.getAgentSessionMeta(session.id)?.title).toBe('externally replaced title')
  })

  test('Given a cached index When the index file is deleted Then does not return stale metadata', () => {
    const session = sessions.createAgentSession('stale cache guard')
    const indexPath = configPaths.getAgentSessionsIndexPath()
    expect(existsSync(indexPath)).toBe(true)

    unlinkSync(indexPath)

    expect(sessions.getAgentSessionMeta(session.id)).toBeUndefined()
  })
})
