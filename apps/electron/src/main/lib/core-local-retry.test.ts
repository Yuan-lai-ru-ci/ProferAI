import { expect, test } from 'bun:test'
import * as service from './core-local-service'

test('启动失败可在应用内重试，并发请求共用一次恢复', async () => {
  service.updateLocalCoreStatus('failed', 'initial failure')
  let calls = 0
  service.configureLocalCoreRetry(async () => {
    calls++
    await Bun.sleep(5)
    if (calls === 1) throw new Error('sync failed')
    service.updateLocalCoreStatus('running')
  })
  await expect(service.retryLocalCore()).rejects.toThrow('sync failed')
  expect(service.getLocalCoreState()).toEqual({ status: 'failed', error: 'sync failed' })
  await Promise.all([service.retryLocalCore(), service.retryLocalCore()])
  expect(calls).toBe(2)
  expect(service.getLocalCoreState()).toEqual({ status: 'running' })
})
