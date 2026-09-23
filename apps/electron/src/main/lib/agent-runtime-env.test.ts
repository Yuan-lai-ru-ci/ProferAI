import { describe, expect, test } from 'bun:test'
import type { RuntimeStatus } from '@profer/shared'
import { buildAgentRuntimeEnv, mergeRuntimeEnv, resolvePosixShellPath } from './agent-runtime-env'

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

  test('Given detected Bun outside the inherited PATH When building Pi env Then Bun directory is prepended and Bash stays explicit', () => {
    const result = buildAgentRuntimeEnv({
      bundledCliPath: '/Applications/Profer.app/Contents/Resources/bin/profer',
      platform: 'darwin',
      pathDelimiter: ':',
      processEnv: { PATH: '/usr/bin:/bin', SHELL: '/bin/zsh' },
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
    expect(result.shellPath).toBe('/bin/bash')
    // `shellPath` selects the Agent Bash executable; the runtime override preserves the base SHELL.
    expect(result.env.SHELL).toBeUndefined()
    expect(mergeRuntimeEnv({ PATH: '/usr/bin', SHELL: '/bin/zsh' }, result.env).SHELL).toBe('/bin/zsh')
  })

  test('Given zsh as the user environment shell When building Agent env Then uses Bash for command execution without rewriting SHELL', () => {
    const result = buildAgentRuntimeEnv({
      platform: 'darwin',
      pathDelimiter: ':',
      processEnv: { PATH: '/usr/bin', SHELL: '/bin/zsh' },
      pathExists: (path) => path === '/bin/bash',
    })

    expect(result.shellKind).toBe('posix')
    expect(result.shellPath).toBe('/bin/bash')
    expect(result.env.SHELL).toBeUndefined()
  })

  test('Given a stale user SHELL path When building Agent env Then still resolves the system Bash', () => {
    const result = buildAgentRuntimeEnv({
      platform: 'darwin',
      pathDelimiter: ':',
      processEnv: { PATH: '/usr/bin', SHELL: '/Users/mac/.missing-shell' },
      pathExists: (path) => path === '/bin/bash',
    })

    expect(result.shellPath).toBe('/bin/bash')
    expect(result.env.SHELL).toBeUndefined()
  })

  test('Given Bash only on PATH When resolving Then uses its verified PATH entry instead of returning a bare command', () => {
    expect(resolvePosixShellPath(
      { PATH: '/custom/bin:/usr/bin', SHELL: '/bin/zsh' },
      'darwin',
      ':',
      (path) => path === '/custom/bin/bash',
    )).toBe('/custom/bin/bash')
  })

  test('Given no verified Bash When resolving Then does not silently fall back to sh', () => {
    expect(resolvePosixShellPath(
      { PATH: '/usr/local/bin', SHELL: '/bin/zsh' },
      'linux',
      ':',
      () => false,
    )).toBeUndefined()
  })
})
