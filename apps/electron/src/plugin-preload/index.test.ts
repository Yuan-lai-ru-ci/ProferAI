/**
 * plugin-preload `call()` 的 rejection 形状测试。
 *
 * contextBridge 跨世界传递 Error 实例会丢弃自定义属性（Electron 官方行为），
 * 因此 call() 必须以 ProferPluginError 纯对象 reject。本测试固化该契约：
 * code / retryable / details / requestId / operation 必须完整保留，
 * 且 rejection 不是 Error 实例（显式的行为变化）。
 *
 * 注意：--isolate 下测试文件无法对 'electron' 二次 mock（见根 bunfig.toml 与
 * test/preload-electron-mock.ts），electron 行为统一通过
 * __proferElectronTestHooks 控制。
 */
import { afterEach, expect, test } from 'bun:test'
import { PROFER_PLUGIN_HOST_CHANNELS, isProferPluginError, type ProferPluginHostApi } from '@profer/plugin-api'

// preload 统一 electron mock 的测试钩子（类型声明与 test/preload-electron-mock.ts 保持一致）
declare global {
  var __proferElectronTestHooks: {
    createdWindows: Array<{ destroyed: boolean; visible: boolean; opts: Record<string, unknown> }>
    registeredAccelerators: string[]
    exposedApi: Record<string, unknown>
    ipcRendererInvoke: ((channel: string, ...args: unknown[]) => Promise<unknown>) | null
    reset: () => void
  }
}

// preload 顶层的 contextBridge.exposeInMainWorld 仅在主框架世界执行，测试环境需显式模拟。
// 必须先于动态 import 设置，否则 exposeInMainWorld 不会调用。
;(process as unknown as { isMainFrame: boolean }).isMainFrame = true
await import('./index')

const api = globalThis.__proferElectronTestHooks.exposedApi.profer as ProferPluginHostApi
const setInvoke = (impl: (channel: string, ...args: unknown[]) => Promise<unknown>): void => {
  globalThis.__proferElectronTestHooks.ipcRendererInvoke = impl
}

afterEach(() => {
  globalThis.__proferElectronTestHooks.ipcRendererInvoke = null
})

const failureEnvelope = (overrides?: Partial<{ code: string; message: string; retryable: boolean; details: Record<string, string | number | boolean> }>) => ({
  protocol: 'plugin-host.rpc.v1',
  ok: false,
  requestId: 'r1',
  operation: 'models.list',
  error: {
    code: 'PLUGIN_REVOKED',
    message: '插件授权已撤销',
    retryable: false,
    details: { reason: 'revoked' },
    ...overrides,
  },
})

test('失败信封 reject 出完整 ProferPluginError 纯对象', async () => {
  setInvoke(async () => failureEnvelope())
  const error = await api.models.list().then(() => null, (value: unknown) => value)
  expect(isProferPluginError(error)).toBe(true)
  expect(error).toEqual({
    name: 'ProferPluginError',
    code: 'PLUGIN_REVOKED',
    message: '插件授权已撤销',
    retryable: false,
    details: { reason: 'revoked' },
    requestId: 'r1',
    operation: 'models.list',
  })
  // 显式行为变化：rejection 不再是 Error 实例（contextBridge 会丢失自定义属性）
  expect(error).not.toBeInstanceOf(Error)
  expect(typeof (error as { stack?: unknown }).stack).toBe('undefined')
})

test('错误缺少 details 时不携带 details 字段', async () => {
  const envelope = failureEnvelope() as { error: Record<string, unknown> } & Record<string, unknown>
  delete envelope.error.details
  setInvoke(async () => envelope)
  const error = await api.models.list().then(() => null, (value: unknown) => value)
  expect(isProferPluginError(error)).toBe(true)
  expect(error).not.toHaveProperty('details')
})

test('成功信封返回 value', async () => {
  const value = [{ id: 'm1' }]
  setInvoke(async () => ({
    protocol: 'plugin-host.rpc.v1',
    ok: true,
    requestId: 'r2',
    operation: 'models.list',
    value,
  }))
  const result: unknown = await api.models.list()
  expect(result).toEqual(value)
})

test('响应为空时兜底为 PLUGIN_INTERNAL_ERROR', async () => {
  setInvoke(async () => null)
  const error = await api.models.list().then(() => null, (value: unknown) => value)
  expect(error).toMatchObject({
    name: 'ProferPluginError',
    code: 'PLUGIN_INTERNAL_ERROR',
    message: '插件宿主操作失败',
    retryable: false,
    requestId: 'unknown',
    operation: 'models.list',
  })
})

test('operation 与错误透传与请求一致（routing.get）', async () => {
  setInvoke(async (channel, request) => {
    expect(channel).toBe(PROFER_PLUGIN_HOST_CHANNELS.CALL)
    const { requestId, operation } = request as { requestId: string; operation: string }
    expect(operation).toBe('routing.get')
    return { protocol: 'plugin-host.rpc.v1', ok: false, requestId, operation, error: { code: 'PLUGIN_PERMISSION_DENIED', message: '未授权', retryable: false } }
  })
  const error = await api.routing.getRules().then(() => null, (value: unknown) => value)
  expect(error).toMatchObject({ code: 'PLUGIN_PERMISSION_DENIED', operation: 'routing.get' })
  expect((error as { requestId: string }).requestId).toMatch(/^[0-9a-f_]+$/)
})
