import { describe, expect, test } from 'bun:test'
import {
  createPowerShellInvocation,
  createWindowsPowerShellToolDefinition,
  executePowerShellCommand,
  getWindowsPowerShellPath,
} from './pi-powershell-tool'

const WINDOWS_POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

describe('Pi Windows PowerShell tool', () => {
  test('Given SystemRoot and a system PowerShell executable When resolving Then returns the absolute system path without PATH lookup', () => {
    expect(getWindowsPowerShellPath(
      { SystemRoot: 'C:\\Windows', PATH: '' },
      (candidate) => candidate === WINDOWS_POWERSHELL,
    )).toBe(WINDOWS_POWERSHELL)
  })

  test('Given a missing system component When resolving Then returns null instead of falling back to an arbitrary PATH executable', () => {
    expect(getWindowsPowerShellPath({ SystemRoot: 'C:\\Windows', PATH: 'C:\\untrusted' }, () => false)).toBeNull()
    expect(getWindowsPowerShellPath({}, () => true)).toBeNull()
  })

  test('Given a command When creating invocation Then uses non-interactive safe host arguments', () => {
    expect(createPowerShellInvocation(WINDOWS_POWERSHELL, 'Get-Location')).toEqual({
      executable: WINDOWS_POWERSHELL,
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', 'Get-Location'],
    })
  })

  test('Given a native Windows PowerShell command When executing Then returns its stdout without requiring PATH lookup', async () => {
    const result = await executePowerShellCommand('[Environment]::OSVersion.Platform', {
      cwd: 'C:\\',
      executable: WINDOWS_POWERSHELL,
      timeoutSeconds: 10,
    })

    expect(result.exitCode).toBe(0)
    expect(result.timedOut).toBe(false)
    expect(result.aborted).toBe(false)
    expect(result.output).toContain('Win32NT')
  })

  test('Given stderr and a non-zero exit code When executing Then preserves both for the tool result', async () => {
    const result = await executePowerShellCommand("[Console]::Error.WriteLine('expected-error'); exit 7", {
      cwd: 'C:\\',
      executable: WINDOWS_POWERSHELL,
      timeoutSeconds: 10,
    })

    expect(result.exitCode).toBe(7)
    expect(result.output).toContain('expected-error')
  })

  test('Given a command exceeding its timeout When executing Then terminates it and reports the timeout', async () => {
    const result = await executePowerShellCommand('Start-Sleep -Seconds 10', {
      cwd: 'C:\\',
      executable: WINDOWS_POWERSHELL,
      timeoutSeconds: 1,
    })

    expect(result.timedOut).toBe(true)
    expect(result.aborted).toBe(false)
  }, 5_000)

  test('Given an aborted signal When executing Then terminates the command and reports cancellation', async () => {
    const controller = new AbortController()
    const pending = executePowerShellCommand('Start-Sleep -Seconds 10', {
      cwd: 'C:\\',
      executable: WINDOWS_POWERSHELL,
      timeoutSeconds: 10,
      signal: controller.signal,
    })
    controller.abort()

    const result = await pending
    expect(result.aborted).toBe(true)
    expect(result.timedOut).toBe(false)
  }, 5_000)

  test('Given a non-Windows runtime When creating the tool Then it is not registered', () => {
    const sdk = { defineTool: () => { throw new Error('should not define') } } as never
    expect(createWindowsPowerShellToolDefinition(sdk, 'C:\\workspace', undefined, { platform: 'linux' })).toBeUndefined()
  })

  test('Given Windows and the system component When creating the tool Then it is named PowerShell with command and timeout parameters', () => {
    let definition: Record<string, unknown> | undefined
    const sdk = { defineTool: (value: Record<string, unknown>) => { definition = value; return value } } as never

    const tool = createWindowsPowerShellToolDefinition(sdk, 'C:\\workspace', undefined, {
      platform: 'win32',
      environment: { SystemRoot: 'C:\\Windows' },
      pathExists: (candidate) => candidate === WINDOWS_POWERSHELL,
    })

    expect(tool).toBeDefined()
    expect(definition).toMatchObject({
      name: 'PowerShell',
      label: '执行 PowerShell',
    })
    expect((definition?.parameters as { properties: Record<string, unknown> }).properties).toHaveProperty('command')
    expect((definition?.parameters as { properties: Record<string, unknown> }).properties).toHaveProperty('timeout')
  })
})
