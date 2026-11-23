import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateCoreTargetStore, readCoreTargetStore, writeCoreTargetStore } from './core-target-store'

const legacyTarget = { id: 'remote', name: 'Remote', coreId: 'core-one', baseUrl: 'http://host:1234', encryptedToken: 'encrypted', platform: 'linux' }

describe('Core target OS identity persistence', () => {
  test('migrates old Core records without guessing a distribution', () => {
    const store = migrateCoreTargetStore({ currentId: 'remote', targets: [legacyTarget] })
    expect(store.targets[0]?.platform).toBe('linux')
    expect(store.targets[0]?.osId).toBeUndefined()
  })

  test.each(['ubuntu', 'debian', 'unknown-distro'])('preserves %s across migration and disk round trip', osId => {
    const dir = mkdtempSync(join(tmpdir(), 'core-os-store-'))
    try {
      const store = migrateCoreTargetStore({ currentId: 'remote', targets: [{ ...legacyTarget, osId }] })
      const path = join(dir, 'targets.json')
      writeCoreTargetStore(path, store)
      expect(readCoreTargetStore(path).targets[0]).toMatchObject({ platform: 'linux', osId })
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

 test('配对截止时间按原值持久化，旧设备不补期限', () => {
  expect(migrateCoreTargetStore({ targets: [{ ...legacyTarget, expiresAt: 123456 }] }).targets[0]?.expiresAt).toBe(123456)
  expect(migrateCoreTargetStore({ targets: [legacyTarget] }).targets[0]?.expiresAt).toBeUndefined()
})
