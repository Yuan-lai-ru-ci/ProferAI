import { afterAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const root = mkdtempSync(join(tmpdir(), 'profer-session-owner-'))
const previous = process.env.PROFER_CONFIG_DIR
const enabled = process.env.PROFER_CORE_LOCAL
process.env.PROFER_CONFIG_DIR = root
delete process.env.PROFER_CORE_LOCAL
let attached = false
mock.module('./core-local-mode', () => ({ isLocalCoreEnabled: () => process.env.PROFER_CORE_LOCAL === '1' }))
mock.module('./core-local-bridge', () => ({ getLocalCoreClient: () => attached ? {} : null }))
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


const sessions = await import('./agent-session-manager')
afterAll(() => {
 if (previous === undefined) delete process.env.PROFER_CONFIG_DIR; else process.env.PROFER_CONFIG_DIR = previous
 if (enabled === undefined) delete process.env.PROFER_CORE_LOCAL; else process.env.PROFER_CORE_LOCAL = enabled
 rmSync(root, { recursive: true, force: true })
})
test('旧链可保存；Core 接管后 meta/messages/queue/布局不得修改文件或缓存', async () => {
 const meta = sessions.createAgentSession('legacy')
 const indexPath = join(root, 'agent-sessions.json')
 const before = readFileSync(indexPath, 'utf8')
 const files = readdirSync(root, { recursive: true }).sort()
 for (const mode of ['enabled', 'attached']) {
   process.env.PROFER_CORE_LOCAL = mode === 'enabled' ? '1' : '0'; attached = mode === 'attached'
   expect(() => sessions.updateAgentSessionMeta(meta.id, { title: 'must not mutate' })).toThrow('CORE_SESSION_STORE_OWNED')
   expect(() => sessions.createAgentSession('blocked')).toThrow('CORE_SESSION_STORE_OWNED')
   expect(() => sessions.appendSDKMessages(meta.id, [])).toThrow('CORE_SESSION_STORE_OWNED')
   expect(() => sessions.enqueueSDKMessages(meta.id, [])).toThrow('CORE_SESSION_STORE_OWNED')
   expect(() => sessions.ensureAgentSessionWriteLayout('default', meta.id)).toThrow('CORE_SESSION_STORE_OWNED')
   expect(readFileSync(indexPath, 'utf8')).toBe(before)
   expect(sessions.getAgentSessionMeta(meta.id)?.title).toBe('legacy')
   expect(readdirSync(root, { recursive: true }).sort()).toEqual(files)
 }
 attached = false; delete process.env.PROFER_CORE_LOCAL
 expect(() => sessions.updateAgentSessionMeta(meta.id, { title: 'disconnect' })).toThrow('CORE_SESSION_STORE_OWNED')
 expect(await sessions.flushSDKMessagePersistence()).toBe(false)
})
