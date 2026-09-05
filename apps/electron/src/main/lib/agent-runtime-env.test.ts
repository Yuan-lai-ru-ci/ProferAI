import { describe, expect, test } from 'bun:test'
import type { RuntimeStatus } from '@profer/shared'
import { buildAgentRuntimeEnv } from './agent-runtime-env'

describe('Agent runtime CLI PATH', () => {
  test('Given packaged CLI on Windows When building Agent env Then only CLI directory is prepended', () => {
    const result = buildAgentRuntimeEnv({
      bundledCliPath: 'C:\\Program Files\\Profer\\resources\\bin\\profer.exe',
      platform: 'win32',
      pathDelimiter: ';',
      processEnv: { Path: 'C:\\Windows\\System32;C:\\Program Files\\Git\\bin' },
    })

    expect(result.env.Path).toBe([
      'C:\\Program Files\\Profer\\resources\\bin',
      'C:\\Windows\\System32',
      'C:\\Program Files\\Git\\bin',
    ].join(';'))
  })

  test('Given detected Bun outside the inherited PATH When building Pi env Then Bun directory is prepended', () => {
    const result = buildAgentRuntimeEnv({
      bundledCliPath: '/Applications/Profer.app/Contents/Resources/bin/profer',
      platform: 'darwin',
      pathDelimiter: ':',
      processEnv: { PATH: '/usr/bin:/bin' },
      runtimeStatus: {
        node: { available: false, path: null, version: null, error: null },
        bun: { available: true, path: '/Users/mac/.bun/bin/bun', version: '1.4.0', source: 'system', error: null },
        git: { available: true, path: '/usr/bin/git', version: '2.50.1', error: null },
        envLoaded: true,
        initializedAt: Date.now(),
      },
    })

    expect(result.env.PATH).toBe([
      '/Users/mac/.bun/bin',
      '/Applications/Profer.app/Contents/Resources/bin',
      '/usr/bin',
      '/bin',
    ].join(':'))
    expect(result.shellKind).toBe('posix')
    expect(result.shellPath).toBe('/bin/zsh')
    expect(result.env.SHELL).toBe('/bin/zsh')
  })

  test('Given a custom POSIX shell When building Agent env Then preserves the explicit shell path', () => {
    const result = buildAgentRuntimeEnv({
      platform: 'darwin',
      pathDelimiter: ':',
      processEnv: { PATH: '/usr/bin', SHELL: '/opt/homebrew/bin/fish' },
    })

    expect(result.shellKind).toBe('posix')
    expect(result.shellPath).toBe('/opt/homebrew/bin/fish')
    expect(result.env.SHELL).toBe('/opt/homebrew/bin/fish')
  })
})
