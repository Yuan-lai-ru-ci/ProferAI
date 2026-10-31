import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DINGTALK_IPC_CHANNELS } from '@profer/shared'

const source = readFileSync(resolve(import.meta.dir, 'dingtalk-ipc.ts'), 'utf8')
const ipc = readFileSync(resolve(import.meta.dir, '..', 'ipc.ts'), 'utf8')

describe('DingTalk IPC 注册（结构检查）', () => {
  test('覆盖旧 API 与多 Bot v2 全部通道', () => {
    for (const key of [
      'GET_CONFIG',
      'GET_DECRYPTED_SECRET',
      'SAVE_CONFIG',
      'TEST_CONNECTION',
      'START_BRIDGE',
      'STOP_BRIDGE',
      'GET_STATUS',
      'GET_MULTI_CONFIG',
      'SAVE_BOT_CONFIG',
      'REMOVE_BOT',
      'GET_BOT_DECRYPTED_SECRET',
      'START_BOT',
      'STOP_BOT',
      'GET_MULTI_STATUS',
      'LIST_BINDINGS',
      'UPDATE_BINDING',
      'REMOVE_BINDING',
    ] as const) {
      expect(source).toContain(`DINGTALK_IPC_CHANNELS.${key}`)
      expect(DINGTALK_IPC_CHANNELS[key]).toBeDefined()
    }
  })

  test('保留 Bridge 启停、Bot 重启和状态回退语义', () => {
    expect(source).toContain('dingtalkBridgeManager.startAll()')
    expect(source).toContain('dingtalkBridgeManager.stopAll()')
    expect(source).toContain('dingtalkBridgeManager.restartBot(saved.id)')
    expect(source).toContain('dingtalkBridgeManager.stopBot(saved.id)')
    expect(source).toContain("{ status: 'disconnected' }")
  })

  test('ipc.ts 只保留注册入口', () => {
    expect(source).toContain('export function registerDingTalkIpc(): void')
    expect(ipc).toContain('registerDingTalkIpc()')
    expect(ipc).not.toContain('ipcMain.handle(\n    DINGTALK_IPC_CHANNELS.GET_CONFIG')
  })
})
