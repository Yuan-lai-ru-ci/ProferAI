import { describe, expect, test } from 'bun:test'
import { AgentPermissionService, type CanUseToolOptions } from './agent-permission-service'

const OPTIONS: CanUseToolOptions = {
  signal: new AbortController().signal,
  toolUseID: 'tool-use-id',
}

function createWorkerOptions(): CanUseToolOptions {
  return { ...OPTIONS, agentID: 'worker-id' }
}

describe('AgentPermissionService PowerShell handling', () => {
  test('Given a main-agent read-only PowerShell query When permission is checked Then it is allowed without an approval request', async () => {
    const service = new AgentPermissionService()
    const result = await service.createCanUseTool('session', () => {
      throw new Error('read-only command must not request approval')
    })('PowerShell', { command: 'Get-Location' }, OPTIONS)

    expect(result.behavior).toBe('allow')
  })

  test('Given a main-agent PowerShell content read or mutation When permission is checked Then it requests approval instead of auto-allowing', async () => {
    const service = new AgentPermissionService()
    const pending = service.createCanUseTool('session', () => {})('PowerShell', {
      command: 'Get-Content $HOME\\.ssh\\id_rsa',
    }, OPTIONS)

    expect(service.getPendingRequests()).toHaveLength(1)
    const request = service.getPendingRequests()[0]!
    expect(request.command).toBe('Get-Content $HOME\\.ssh\\id_rsa')
    expect(request.description).toContain('执行 PowerShell')
    service.respondToPermission(request.requestId, 'deny', false)
    expect((await pending).behavior).toBe('deny')
  })

  test('Given a worker PowerShell mutation When permission is checked Then it is rejected because workers cannot request interactive approval', async () => {
    const service = new AgentPermissionService()
    const result = await service.createCanUseTool('session', () => {})('PowerShell', {
      command: 'Remove-Item C:\\temp\\x',
    }, createWorkerOptions())

    expect(result).toMatchObject({ behavior: 'deny', interrupt: true })
  })

  test('Given a worker read-only PowerShell query When permission is checked Then it remains allowed', async () => {
    const service = new AgentPermissionService()
    const result = await service.createCanUseTool('session', () => {})('PowerShell', {
      command: 'Get-Process -Name explorer',
    }, createWorkerOptions())

    expect(result.behavior).toBe('allow')
  })
})
