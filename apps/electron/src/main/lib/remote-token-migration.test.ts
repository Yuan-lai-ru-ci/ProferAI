import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { migrateRemoteToken, type TokenMigrationIO } from './remote-token-migration'
const target = 'C:/test-target/remote-token.json', source = 'C:/test-source/remote-token.json'
/** 真实 fs 按当前工作目录解析相对路径；fixture 用同一规则建键，避免把 Windows 盘符路径当成 POSIX 相对路径。 */
const key = (p: string): string => resolve(p)
function fixture() {
  const files = new Map([[key(source), JSON.stringify({ token: 'OLD_TEST_SECRET' })]])
  let writeFail = false, removeFail = false, revealFail = false
  const fs: TokenMigrationIO = { exists: (p) => files.has(key(p)), read: (p) => files.get(key(p))!, atomic: (p, value) => { if (writeFail) throw new Error('write failed'); files.set(key(p), JSON.stringify(value)) }, remove: (p) => { if (removeFail) throw new Error('access denied'); files.delete(key(p)) } }
  return { files, fs, protect: (s: string) => Buffer.from(s).toString('base64'), reveal: (s: string) => revealFail ? 'wrong' : Buffer.from(s, 'base64').toString(), failWrite: (v: boolean) => { writeFail = v }, failRemove: (v: boolean) => { removeFail = v }, failReveal: (v: boolean) => { revealFail = v } }
}
describe('cross-directory migration', () => {
  test('real temporary cross-directory files: no source plaintext left after verified atomic write', () => {
    const root = mkdtempSync(join(tmpdir(), 'token-migrate-test-')); const old = join(root, 'old', 'remote-token.json'); const next = join(root, 'new', 'remote-token.json')
    mkdirSync(join(root, 'old')); writeFileSync(old, JSON.stringify({ token: 'TEMP_ONLY_SECRET' }))
    try { expect(migrateRemoteToken(next, old, (s) => Buffer.from(s).toString('base64'), (s) => Buffer.from(s, 'base64').toString())).toBe('TEMP_ONLY_SECRET'); expect(existsSync(old)).toBe(false); expect(readFileSync(next, 'utf8')).not.toContain('TEMP_ONLY_SECRET') } finally { rmSync(root, { recursive: true, force: true }) }
  })
  test('writes atomically, verifies decryption, only then deletes plaintext source', () => { const f = fixture(); expect(migrateRemoteToken(target, source, f.protect, f.reveal, f.fs)).toBe('OLD_TEST_SECRET'); expect(f.files.has(key(source))).toBe(false); expect(f.files.get(key(target))).not.toContain('OLD_TEST_SECRET') })
  test('write or decrypt verification failure preserves source for recovery', () => { const f = fixture(); f.failWrite(true); expect(() => migrateRemoteToken(target, source, f.protect, f.reveal, f.fs)).toThrow(); expect(f.files.has(key(source))).toBe(true); f.failWrite(false); f.failReveal(true); expect(() => migrateRemoteToken(target, source, f.protect, f.reveal, f.fs)).toThrow('核验'); expect(f.files.has(key(source))).toBe(true) })
  test('encrypted target from previous implementation still cleans matching plaintext source', () => { const f = fixture(); f.files.set(key(target), JSON.stringify({ encrypted: f.protect('OLD_TEST_SECRET') })); expect(migrateRemoteToken(target, source, f.protect, f.reveal, f.fs)).toBe('OLD_TEST_SECRET'); expect(f.files.has(key(source))).toBe(false) })
  test('cleanup failure fails closed and retries recorded source even when target exists', () => { const f = fixture(); f.failRemove(true); expect(() => migrateRemoteToken(target, source, f.protect, f.reveal, f.fs)).toThrow('重试'); expect(f.files.has(key(source))).toBe(true); expect(f.files.get(key(target))).toContain('pendingCleanup'); f.failRemove(false); expect(migrateRemoteToken(target, source, f.protect, f.reveal, f.fs)).toBe('OLD_TEST_SECRET'); expect(f.files.has(key(source))).toBe(false); expect(f.files.get(key(target))).not.toContain('pendingCleanup') })
})
