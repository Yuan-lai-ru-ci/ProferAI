import { describe, expect, test } from 'bun:test'
import { CorePermissionService } from './permission-service'

describe('CorePermissionService', () => {
  test('holds a request until same-session approval and returns the approved input', async () => {
    const events: unknown[] = []
    const service = new CorePermissionService((_sessionId, payload) => events.push(payload))
    const controller = new AbortController()
    let requestId = ''
    const pending = service.createCanUseTool({ sessionId: 's1', sendPermissionRequest: request => { requestId = request.requestId } })('Write', { path: 'fixture' }, { signal: controller.signal, toolUseID: 'tool-1' })
    await Promise.resolve()
    expect(service.listPending('s1')).toHaveLength(1)
    expect(service.respond('other', requestId, 'allow')).toBe(false)
    expect(service.respond('s1', requestId, 'allow')).toBe(true)
    await expect(pending).resolves.toMatchObject({ behavior: 'allow', updatedInput: { path: 'fixture' }, toolUseID: 'tool-1' })
    expect(service.listPending('s1')).toHaveLength(0)
    expect(events).toHaveLength(1)
  })

  test('run 身份、宿主取消和等待记账均 fail-closed', async () => {
    const lifecycle: string[] = []
    const service = new CorePermissionService(() => {})
    const run = new AbortController()
    const tool = new AbortController()
    const gate = service.createCanUseTool({ sessionId: 's1', runId: 'run-1', signal: run.signal,
      runLifecycle: { wait: id => lifecycle.push(`wait:${id}`), resume: id => lifecycle.push(`resume:${id}`) }, sendPermissionRequest() {} })
    const pending = gate('Write', { path: 'fixture' }, { signal: tool.signal })
    const request = service.listPending('s1')[0]!
    expect(request.runId).toBe('run-1')
    expect(service.respond('s1', request.requestId, 'allow')).toBe(false)
    expect(service.respond('s1', request.requestId, 'allow', false, 'run-2')).toBe(false)
    expect(service.respond('other', request.requestId, 'allow', false, 'run-1')).toBe(false)
    run.abort()
    await expect(pending).resolves.toMatchObject({ behavior: 'deny' })
    expect(service.respond('s1', request.requestId, 'allow', false, 'run-1')).toBe(false)
    expect(lifecycle).toEqual([`wait:${request.requestId}`, `resume:${request.requestId}`])
    expect(service.listPending('s1')).toEqual([])
  })

  test('运行中权限收紧后旧审批不能允许或写入白名单', async () => {
    let mode: 'auto' | 'plan' | 'bypassPermissions' = 'auto'
    const service = new CorePermissionService(() => {}, () => mode)
    const gate = service.createCanUseTool({ sessionId: 's1', sendPermissionRequest() {} })
    const options = { signal: new AbortController().signal }
    const pending = gate('Write', { path: 'fixture' }, options)
    const request = service.listPending('s1')[0]!
    mode = 'plan'
    expect(service.respond('s1', request.requestId, 'allow', true)).toBe(true)
    await expect(pending).resolves.toMatchObject({ behavior: 'deny' })
    mode = 'auto'
    const retry = gate('Write', { path: 'fixture' }, options)
    expect(service.listPending('s1')).toHaveLength(1)
    service.clearSession('s1')
    await expect(retry).resolves.toMatchObject({ behavior: 'deny' })
  })

  test('恢复记账失败不会产生始终允许白名单', async () => {
    const service = new CorePermissionService(() => {})
    const gate = service.createCanUseTool({ sessionId: 's1', runId: 'run-1', sendPermissionRequest() {},
      runLifecycle: { wait() {}, resume() { throw new Error('ledger write failed') } },
    })
    const options = { signal: new AbortController().signal }
    const pending = gate('Write', { path: 'fixture' }, options)
    const request = service.listPending('s1')[0]!
    expect(service.respond('s1', request.requestId, 'allow', true, 'run-1')).toBe(true)
    await expect(pending).resolves.toMatchObject({ behavior: 'deny', message: expect.stringContaining('恢复记账失败') })
    const retry = gate('Write', { path: 'fixture' }, options)
    expect(service.listPending('s1')).toHaveLength(1)
    service.clearSession('s1')
    await expect(retry).resolves.toMatchObject({ behavior: 'deny' })
  })

  test('通知失败不会遗留可授权请求', async () => {
    const service = new CorePermissionService(() => {})
    const result = await service.createCanUseTool({ sessionId: 's1', sendPermissionRequest() { throw new Error('offline') } })('Write', {}, { signal: new AbortController().signal })
    expect(result.behavior).toBe('deny')
    expect(service.listPending('s1')).toEqual([])
  })

  test('aborts and session close resolve pending requests as deny', async () => {
    const service = new CorePermissionService(() => {})
    const abort = new AbortController()
    const aborted = service.createCanUseTool({ sessionId: 's1', sendPermissionRequest() {} })('Write', {}, { signal: abort.signal })
    abort.abort()
    await expect(aborted).resolves.toMatchObject({ behavior: 'deny' })
    const closing = new AbortController()
    const pending = service.createCanUseTool({ sessionId: 's1', sendPermissionRequest() {} })('Edit', {}, { signal: closing.signal })
    service.clearSession('s1')
    await expect(pending).resolves.toMatchObject({ behavior: 'deny' })
  })
})
