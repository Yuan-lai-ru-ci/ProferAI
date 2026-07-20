import { describe, expect, test } from 'bun:test'
import {
  hasDangerousPowerShellStructure,
  isSafePowerShellCommand,
} from './permission-rules'

describe('PowerShell permission rules', () => {
  test('Given simple metadata queries When classified Then they are auto-allowable', () => {
    expect(isSafePowerShellCommand('Get-Location')).toBe(true)
    expect(isSafePowerShellCommand('Get-Date')).toBe(true)
    expect(isSafePowerShellCommand('Get-Process -Name explorer')).toBe(true)
    expect(isSafePowerShellCommand('Get-Command git')).toBe(true)
    expect(isSafePowerShellCommand('Test-Path C:\\Windows')).toBe(true)
  })

  test('Given data reads, mutation, or composed scripts When classified Then they require approval', () => {
    expect(isSafePowerShellCommand('Get-Content $HOME\\.ssh\\id_rsa')).toBe(false)
    expect(isSafePowerShellCommand('Remove-Item C:\\temp\\x')).toBe(false)
    expect(isSafePowerShellCommand('Get-Location; Remove-Item C:\\temp\\x')).toBe(false)
    expect(isSafePowerShellCommand('Get-Process | Stop-Process')).toBe(false)
  })

  test('Given PowerShell-only composition syntax When checking structure Then it is considered dangerous', () => {
    expect(hasDangerousPowerShellStructure('Get-Location; Get-Date')).toBe(true)
    expect(hasDangerousPowerShellStructure('Get-Process | Select-Object Name')).toBe(true)
    expect(hasDangerousPowerShellStructure('Get-Item $(Get-Location)')).toBe(true)
    expect(hasDangerousPowerShellStructure('Get-ChildItem > out.txt')).toBe(true)
  })
})
