/**
 * 回退后的派生缓存修复：只验证两件会真正「残留」的东西。
 *
 * - 导航索引是内存缓存，必须显式失效（文件 size/mtime 未变时不会自动重建）；
 * - 回溯抽取水位是单调计数，回退删掉尾部轮次后必须跟着退，否则新轮次永远追不上。
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
let cache: typeof import('./agent-rewind-cache')
let navigation: typeof import('./agent-navigation-index')

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'profer-rewind-cache-test-'))
  process.env.PROFER_CONFIG_DIR = root
  const cacheKey = `${Date.now()}-${Math.random()}`
  sessions = await import(`./agent-session-manager?rewind-cache-test=${cacheKey}`)
  configPaths = await import(`./config-paths?rewind-cache-test=${cacheKey}`)
  cache = await import(`./agent-rewind-cache?rewind-cache-test=${cacheKey}`)
  navigation = await import(`./agent-navigation-index?rewind-cache-test=${cacheKey}`)
})

afterEach(() => {
  delete process.env.PROFER_CONFIG_DIR
  if (root) rmSync(root, { recursive: true, force: true })
})

const userMsg = (text: string) => ({ type: 'user', uuid: `u-${text}`, message: { content: [{ type: 'text', text }] } })
const assistantMsg = (uuid: string) => ({ type: 'assistant', uuid, message: { content: [{ type: 'text', text: '回复' }] } })

function seedMessages(sessionId: string, lines: unknown[]): void {
  const dir = configPaths.getAgentSessionsDir()
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${sessionId}.jsonl`), lines.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf-8')
}

describe('repairAgentSessionCachesAfterRewind', () => {
  test('pulls the retrospective watermark back to the truncated turn count', () => {
    const meta = sessions.createAgentSession('缓存修复', undefined, undefined, undefined, 'claude')
    seedMessages(meta.id, [userMsg('一问'), assistantMsg('a1')])
    sessions.updateAgentSessionMeta(meta.id, { lastAnalyzedTurn: 9 })

    const result = cache.repairAgentSessionCachesAfterRewind(meta.id)

    // user + assistant-turn 两条可分析条目
    expect(result.analyzedEntries).toBe(2)
    expect(result.clampedAnalyzedTurn).toBe(2)
    expect(sessions.getAgentSessionMeta(meta.id)?.lastAnalyzedTurn).toBe(2)
  })

  test('never raises the watermark and is idempotent', () => {
    const meta = sessions.createAgentSession('水位只降不升', undefined, undefined, undefined, 'claude')
    seedMessages(meta.id, [userMsg('一问'), assistantMsg('a1'), userMsg('二问'), assistantMsg('a2')])
    sessions.updateAgentSessionMeta(meta.id, { lastAnalyzedTurn: 1 })

    expect(cache.repairAgentSessionCachesAfterRewind(meta.id).clampedAnalyzedTurn).toBeUndefined()
    expect(sessions.getAgentSessionMeta(meta.id)?.lastAnalyzedTurn).toBe(1)

    sessions.updateAgentSessionMeta(meta.id, { lastAnalyzedTurn: 8 })
    expect(cache.repairAgentSessionCachesAfterRewind(meta.id).clampedAnalyzedTurn).toBe(4)
    expect(cache.repairAgentSessionCachesAfterRewind(meta.id).clampedAnalyzedTurn).toBeUndefined()
  })

  test('invalidates the navigation index so it is rebuilt from the truncated file', () => {
    const meta = sessions.createAgentSession('索引失效', undefined, undefined, undefined, 'claude')
    seedMessages(meta.id, [userMsg('一问'), assistantMsg('a1'), userMsg('二问'), assistantMsg('a2')])
    const before = navigation.getAgentSessionNavigationIndex(meta.id)
    expect(before.total).toBeGreaterThan(0)

    // 同尺寸改写：size/mtime 都不保证变化，只有显式失效能避免读回旧索引。
    seedMessages(meta.id, [userMsg('一问'), assistantMsg('a1')])
    cache.repairAgentSessionCachesAfterRewind(meta.id)

    const after = navigation.getAgentSessionNavigationIndex(meta.id)
    expect(after.entries.length).toBeLessThan(before.entries.length)
  })

  test('a deleted session is skipped instead of throwing', () => {
    const result = cache.repairAgentSessionCachesAfterRewind('missing-session')
    expect(result).toEqual({ analyzedEntries: 0 })
  })
})
