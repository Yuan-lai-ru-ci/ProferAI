import { describe, expect, test } from 'bun:test'
import { buildShellEnvInvocation, getShellEnv } from './shell-env'

describe('shell environment loading', () => {
  test('uses a non-interactive login shell invocation', () => {
    const invocation = buildShellEnvInvocation()

    expect(invocation.args[0]).toBe('-l')
    expect(invocation.args[1]).toBe('-c')
    expect(invocation.args).not.toContain('-i')
    expect(invocation.args[2]).toContain(invocation.marker)
    expect(invocation.args[2]).toContain('env')
  })

  test('loads environment from macOS zsh without interactive zle initialization', async () => {
    const env = await getShellEnv('/bin/zsh')

    expect(env.PATH).toBeString()
    expect(env.SHELL).toBe('/bin/zsh')
  })
})
