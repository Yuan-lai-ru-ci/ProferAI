import { app, BrowserWindow, protocol, WebContentsView, type WebContents } from 'electron'
import { strict as assert } from 'node:assert'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createChannel } from '../src/main/lib/channel-manager'
import { setMainWindow } from '../src/main/lib/main-window-state'
import { installPluginPackage } from '../src/main/lib/plugins/plugin-manager'
import { revokePluginPermissions } from '../src/main/lib/plugins/plugin-permissions'
import { pluginRequests } from '../src/main/lib/plugins/plugin-requests'
import { pluginViewManager, registerPluginHostIpc } from '../src/main/lib/plugins/plugin-view-manager'

interface RpcFailure {
  protocol: 'plugin-host.rpc.v1'
  ok: false
  requestId: string
  operation: string
  error: { code: string }
}
interface RpcSuccess {
  protocol: 'plugin-host.rpc.v1'
  ok: true
  requestId: string
  operation: string
  value: unknown
}
type RpcResponse = RpcFailure | RpcSuccess

process.on('uncaughtException', (error) => { console.error('PLUGIN_RPC_SMOKE_UNCAUGHT', error); app.exit(1) })
const root = mkdtempSync(join(tmpdir(), 'profer-plugin-rpc-electron-'))
process.env.PROFER_CONFIG_DIR = join(root, 'config')
mkdirSync(process.env.PROFER_CONFIG_DIR, { recursive: true })
app.setPath('userData', join(root, 'electron'))
protocol.registerSchemesAsPrivileged([{ scheme: 'profer-plugin', privileges: { standard: true, secure: true, supportFetchAPI: true } }])
const deadline = setTimeout(() => { console.error('PLUGIN_RPC_SMOKE_TIMEOUT'); app.exit(1) }, 45_000)

let requestCount = 0
let abortedCount = 0
let delayedResponseCount = 0
let resolveRequest: (() => void) | null = null
const waitForRequest = (): Promise<void> => new Promise((resolve) => { resolveRequest = resolve })
const server = createServer((request: IncomingMessage, response: ServerResponse) => {
  requestCount += 1
  resolveRequest?.(); resolveRequest = null
  request.on('aborted', () => { abortedCount += 1 })
  request.on('close', () => { if (request.aborted) abortedCount += 1 })
  setTimeout(() => {
    delayedResponseCount += 1
    if (!response.destroyed) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.end('data: {"choices":[{"delta":{"content":"late result"}}]}\n\ndata: [DONE]\n\n')
    }
  }, 250)
})

function createFixture(): string {
  const source = join(root, 'plugin-source')
  mkdirSync(source, { recursive: true })
  writeFileSync(join(source, 'profer-plugin.json'), JSON.stringify({
    schemaVersion: 1,
    id: 'com.profer.rpc-smoke',
    name: 'RPC Smoke',
    version: '1.0.0',
    permissions: ['models.read', 'models.invoke', 'workspace.read'],
    contributes: {
      pages: [
        { id: 'one', title: 'One', entry: 'one.html' },
        { id: 'two', title: 'Two', entry: 'two.html' },
      ],
    },
  }), 'utf8')
  for (const page of ['one', 'two']) writeFileSync(join(source, `${page}.html`), `<!doctype html><title>${page}</title>`, 'utf8')
  return source
}

function grant(pluginId: string): void {
  writeFileSync(join(process.env.PROFER_CONFIG_DIR!, 'plugin-permissions.json'), JSON.stringify({
    [pluginId]: { permissions: ['models.read', 'models.invoke', 'workspace.read'], origins: [], revoked: false },
  }), 'utf8')
}

function request(id: string, operation: string, payload: unknown, timeoutMs?: number): Record<string, unknown> {
  return { protocol: 'plugin-host.rpc.v1', requestId: id, operation, payload, ...(timeoutMs === undefined ? {} : { timeoutMs }) }
}

async function raw(contents: WebContents, value: Record<string, unknown>): Promise<RpcResponse> {
  return contents.executeJavaScript(`window.__pluginRpcSmoke.call(${JSON.stringify(value)})`) as Promise<RpcResponse>
}

async function openPage(window: BrowserWindow, pageId: 'one' | 'two'): Promise<WebContents> {
  const before = new Set(window.contentView.children.flatMap((host) => host.children).map((child) => child instanceof WebContentsView ? child.webContents.id : -1))
  pluginViewManager.activate('com.profer.rpc-smoke', pageId, null)
  const view = window.contentView.children.flatMap((host) => host.children)
    .find((child) => child instanceof WebContentsView && !before.has(child.webContents.id)) as WebContentsView | undefined
  assert(view, `插件页 ${pageId} 未创建`)
  await new Promise<void>((resolve, reject) => {
    view.webContents.once('did-finish-load', () => resolve())
    view.webContents.once('did-fail-load', (_event, code, message) => reject(new Error(`${code}: ${message}`)))
  })
  return view.webContents
}

async function expectFailure(promise: Promise<RpcResponse>, requestId: string, operation: string, code: string): Promise<RpcFailure> {
  const response = await promise
  assert.deepEqual(
    { protocol: response.protocol, ok: response.ok, requestId: response.requestId, operation: response.operation, code: response.ok ? undefined : response.error.code },
    { protocol: 'plugin-host.rpc.v1', ok: false, requestId, operation, code },
  )
  assert.equal(response.ok, false)
  return response
}

async function main(): Promise<void> {
  await app.whenReady()
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address(); assert(address && typeof address !== 'string')
  const pluginId = 'com.profer.rpc-smoke'
  assert.equal(installPluginPackage(createFixture()).ok, true)
  grant(pluginId)
  const smokeChannel = createChannel({ name: 'RPC smoke model', provider: 'openai', baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'rpc-smoke-secret', models: [{ id: 'rpc-smoke-model', name: 'RPC smoke', enabled: true }], enabled: true })

  const window = new BrowserWindow({ show: false, width: 1000, height: 800, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
  setMainWindow(window); pluginViewManager.setOwnerWindow(window); registerPluginHostIpc()
  const first = await openPage(window, 'one')
  const second = await openPage(window, 'two')

  // 生产 preload 的公开 API 与真实 IPC 链路：provider 缺失错误保留 requestId/operation。
  const publicFailure = await first.executeJavaScript(`window.profer.workspace.list().then(() => null, (error) => ({ message: error.message, name: error.name }))`) as { message: string; name: string }
  assert.deepEqual(publicFailure, { message: '该插件能力尚未配置宿主 provider', name: 'Error' })

  // test-only observability bridge 不替代宿主；它只读取同一真实 IPC 的完整 response envelope。
  await expectFailure(raw(first, request('envelope', 'workspace.list', {})), 'envelope', 'workspace.list', 'PLUGIN_OPERATION_NOT_SUPPORTED')

  const channel = (await first.executeJavaScript('window.profer.models.list()')) as Array<{ channelId: string; modelId: string }>
  assert(channel.some((model) => model.channelId === smokeChannel.id && model.modelId === 'rpc-smoke-model'))
  const modelPayload = { requestId: 'model-payload', channelId: smokeChannel.id, modelId: 'rpc-smoke-model', prompt: 'wait', maxTokens: 1 }

  const ownerRequest = raw(first, request('owner-request', 'models.generate', modelPayload))
  await waitForRequest()
  await expectFailure(raw(second, request('cross-cancel', 'requests.cancel', 'owner-request')), 'cross-cancel', 'requests.cancel', 'PLUGIN_INVALID_ARGUMENT')
  const cancellation = raw(first, request('same-owner-cancel', 'requests.cancel', 'owner-request'))
  const cancelled = await cancellation
  assert.deepEqual(cancelled, { protocol: 'plugin-host.rpc.v1', ok: true, requestId: 'same-owner-cancel', operation: 'requests.cancel', value: { requestId: 'owner-request', cancelled: true } })
  await expectFailure(ownerRequest, 'owner-request', 'models.generate', 'PLUGIN_REQUEST_CANCELLED')

  const timeoutRequest = raw(first, request('timeout-request', 'models.generate', { ...modelPayload, requestId: 'timeout-payload' }, 10))
  await waitForRequest()
  await expectFailure(timeoutRequest, 'timeout-request', 'models.generate', 'PLUGIN_REQUEST_TIMEOUT')

  const revokeRequest = raw(first, request('revoke-request', 'models.generate', { ...modelPayload, requestId: 'revoke-payload' }))
  await waitForRequest()
  revokePluginPermissions(pluginId); pluginRequests.cancelPlugin(pluginId)
  await expectFailure(revokeRequest, 'revoke-request', 'models.generate', 'PLUGIN_REVOKED')

  // 页面销毁会取消该 WebContents owner 的真实在途请求。销毁后 renderer 无法安全接收 IPC response，
  // 所以这里验证实际网络 abort；typed response 已由同一 dispatcher 的 cancel/revoke/timeout 用例覆盖。
  grant(pluginId)
  const closeRequest = raw(first, request('page-close-request', 'models.generate', { ...modelPayload, requestId: 'page-close-payload' }))
  await waitForRequest()
  pluginViewManager.close(pluginId, 'one')
  void closeRequest.catch(() => undefined)
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert(abortedCount > 0, '页面关闭未终止在途宿主请求')

  // 上游延迟返回发生在取消/超时之后，不会把已稳定的 typed failure 改写为成功。
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert(requestCount >= 4)
  assert(delayedResponseCount >= 4)

  pluginViewManager.dispose(); window.destroy()
  console.log('PLUGIN_RPC_SMOKE_OK: 真实 preload/IPC envelope、sender owner、跨页拒绝、同 owner cancel、timeout、revoke、page-close abort、late-result')
}

main().then(() => finish(0), (error) => { console.error('PLUGIN_RPC_SMOKE_FAILED', error); finish(1) })
function finish(code: number): void {
  clearTimeout(deadline); server.close(); pluginViewManager.dispose()
  try { rmSync(root, { recursive: true, force: true }) } catch { /* Electron 文件句柄退出时释放 */ }
  app.exit(code)
}
