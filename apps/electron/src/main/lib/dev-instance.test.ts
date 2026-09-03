import { describe, expect, test } from 'bun:test'
import { win32 } from 'node:path'
import { resolveDevAppName, resolveDevUserDataPath, resolveDevVitePort } from './dev-instance'

describe('开发隔离实例', () => {
  test('Given instance id When resolving Then userData and lock name are isolated', () => {
    const env = { PROFER_DEV_INSTANCE: 'migration-preview-20260902' }

    expect(resolveDevUserDataPath('C:\\Users\\tester\\AppData\\Local', false, env, win32))
      .toBe('C:\\Users\\tester\\AppData\\Local\\@profer\\electron-dev-migration-preview-20260902')
    expect(resolveDevAppName(env)).toBe('profer-dev-migration-preview-20260902')
  })

  test('Given explicit userData When resolving Then it wins over generated instance path', () => {
    const env = {
      PROFER_DEV_INSTANCE: 'preview',
      PROFER_USER_DATA_DIR: 'C:\\temp\\profer-preview-user-data',
    }

    expect(resolveDevUserDataPath('C:\\Users\\tester\\AppData\\Local', false, env, win32))
      .toBe('C:\\temp\\profer-preview-user-data')
  })

  test('Given packaged app When resolving Then development overrides are ignored', () => {
    const env = {
      PROFER_DEV_INSTANCE: 'preview',
      PROFER_USER_DATA_DIR: 'C:\\temp\\must-not-use',
    }

    expect(resolveDevUserDataPath('C:\\Users\\tester\\AppData\\Local', true, env, win32))
      .toBe('C:\\Users\\tester\\AppData\\Local\\@profer\\electron')
  })

  test('Given invalid or absent port When resolving Then default port is retained', () => {
    expect(resolveDevVitePort({})).toBe(5174)
    expect(resolveDevVitePort({ PROFER_VITE_PORT: '80' })).toBe(5174)
    expect(resolveDevVitePort({ PROFER_VITE_PORT: 'not-a-port' })).toBe(5174)
    expect(resolveDevVitePort({ PROFER_VITE_PORT: '5187' })).toBe(5187)
  })
})
