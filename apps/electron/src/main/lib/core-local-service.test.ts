import { expect, test } from 'bun:test'
import { getLocalCoreState, updateLocalCoreStatus } from './core-local-service'

test('内置 Core 只有运行状态，不再提供启用或升级开关', () => {
  expect(getLocalCoreState()).toEqual({ status: 'starting' })
  updateLocalCoreStatus('running')
  expect(getLocalCoreState()).toEqual({ status: 'running' })
  updateLocalCoreStatus('failed', '启动失败原因')
  expect(getLocalCoreState()).toEqual({ status: 'failed', error: '启动失败原因' })
  updateLocalCoreStatus('starting')
  expect(getLocalCoreState()).toEqual({ status: 'starting' })
})
