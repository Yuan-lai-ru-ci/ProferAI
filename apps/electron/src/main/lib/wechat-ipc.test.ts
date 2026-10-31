import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { WECHAT_IPC_CHANNELS } from '@profer/shared'

const source = readFileSync(resolve(import.meta.dir, 'wechat-ipc.ts'), 'utf8')
const ipc = readFileSync(resolve(import.meta.dir, '..', 'ipc.ts'), 'utf8')

describe('WeChat IPC 注册（结构检查）', () => {
  test('覆盖配置、登录、Bridge 生命周期和状态通道', () => {
    for (const key of ['GET_CONFIG', 'START_LOGIN', 'LOGOUT', 'START_BRIDGE', 'STOP_BRIDGE', 'GET_STATUS', 'LIST_BINDINGS', 'UPDATE_BINDING', 'REMOVE_BINDING'] as const) {
      expect(source).toContain(`WECHAT_IPC_CHANNELS.${key}`)
      expect(WECHAT_IPC_CHANNELS[key]).toBeDefined()
    }
    expect(source).toContain('wechatBridge.startLogin()')
    expect(source).toContain('wechatBridge.logout()')
    expect(source).toContain('wechatBridge.start()')
    expect(source).toContain('wechatBridge.stop()')
    expect(source).toContain('wechatBridge.getStatus()')
    expect(source).toContain('wechatBridge.listBindings()')
    expect(source).toContain('wechatBridge.removeBinding(chatId)')
  })

  test('ipc.ts 只保留注册入口', () => {
    expect(source).toContain('export function registerWeChatIpc(): void')
    expect(ipc).toContain('registerWeChatIpc()')
    expect(ipc).not.toContain('ipcMain.handle(\n    WECHAT_IPC_CHANNELS.GET_CONFIG')
  })
})
