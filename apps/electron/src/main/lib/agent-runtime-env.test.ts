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
})
