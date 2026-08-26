import { describe, expect, test } from 'bun:test'
import type { RuntimeStatus } from '@profer/shared'
import { buildAgentRuntimeEnv, prependBundledBunToPath } from './agent-runtime-env'

function runtimeWithBundledBun(path: string): RuntimeStatus {
  return {
    node: { available: false, path: null, version: null, error: null },
    bun: { available: true, path, version: '1.3.14', source: 'bundled', error: null },
    git: { available: false, path: null, version: null, error: null },
    envLoaded: true,
    initializedAt: 1,
  }
}

describe('Agent runtime bundled Bun PATH', () => {
  test('Given packaged Bun on Windows When building Pi env Then Bun directory is first PATH entry', () => {
    const runtimeStatus = runtimeWithBundledBun('C:\\Program Files\\Profer\\resources\\vendor\\bun\\bun.exe')
    const result = buildAgentRuntimeEnv({
      runtimeStatus,
      bundledCliPath: 'C:\\Program Files\\Profer\\resources\\bin\\profer.exe',
      platform: 'win32',
      pathDelimiter: ';',
      processEnv: { Path: 'C:\\Windows\\System32;C:\\Program Files\\Git\\bin' },
    })

    expect(result.env.Path).toBe([
      'C:\\Program Files\\Profer\\resources\\bin',
      'C:\\Program Files\\Profer\\resources\\vendor\\bun',
      'C:\\Windows\\System32',
      'C:\\Program Files\\Git\\bin',
    ].join(';'))
  })

  test('Given bundled Bun directory already exists with different casing When prepending Then it is deduplicated', () => {
    const result = prependBundledBunToPath(
      'c:\\program files\\profer\\resources\\vendor\\bun;C:\\Windows\\System32',
      runtimeWithBundledBun('C:\\Program Files\\Profer\\resources\\vendor\\bun\\bun.exe'),
      ';',
      'win32',
    )

    expect(result).toBe('c:\\program files\\profer\\resources\\vendor\\bun;C:\\Windows\\System32')
  })

  test('Given system Bun instead of packaged Bun When building env Then PATH is not modified for Bun', () => {
    const runtimeStatus = {
      ...runtimeWithBundledBun('C:\\Users\\yuan\\.bun\\bin\\bun.exe'),
      bun: {
        available: true,
        path: 'C:\\Users\\yuan\\.bun\\bin\\bun.exe',
        version: '1.3.14',
        source: 'system' as const,
        error: null,
      },
    }
    expect(prependBundledBunToPath('C:\\Windows\\System32', runtimeStatus, ';', 'win32'))
      .toBe('C:\\Windows\\System32')
  })
})
