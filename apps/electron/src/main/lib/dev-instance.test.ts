import { describe, expect, test } from 'bun:test'
import { resolve, win32 } from 'node:path'
import { readUserDataDirSwitch, resolveDevAppName, resolveDevUserDataPath, resolveDevVitePort } from './dev-instance'

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

  // 发布前的启动冒烟靠 `--user-data-dir` 隔离：主进程若把它覆盖回 appData，
  // 单实例锁会落回真实用户数据目录，冒烟会被当作重复实例直接退出（实测踩过）。
  test('Given --user-data-dir switch When parsing Then it is honoured; absent/empty is ignored', () => {
    expect(readUserDataDirSwitch(['/Applications/Profer.app/Contents/MacOS/Profer', '--user-data-dir=/tmp/profer-smoke'])).toBe(resolve('/tmp/profer-smoke'))
    expect(readUserDataDirSwitch(['Profer.exe', '--user-data-dir=C:\\temp\\profer-smoke'])).toBe(resolve('C:\\temp\\profer-smoke'))
    expect(readUserDataDirSwitch(['Profer.exe'])).toBeUndefined()
    expect(readUserDataDirSwitch(['Profer.exe', '--user-data-dir='])).toBeUndefined()
  })
})
