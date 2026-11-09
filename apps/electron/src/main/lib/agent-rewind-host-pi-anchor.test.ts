/**
 * Pi 回退锚点必须精确：只接受「目标消息 uuid 自己」的 entry 绑定。
 *
 * 历史行为是「从保留历史末尾往前找第一个能解析的 uuid」。目标 uuid 没有绑定时，
 * 它会静默截到更早的一轮——真机会话里丢过 8 条 assistant + 10 条 toolResult，还报 ok:true。
 *
 * 这个用例刻意让**更早**的消息有绑定、目标消息没有绑定，并给 Pi 文件一个可截断的合法
 * transcript：旧实现会成功截断（状态 committed、两份文件都被改写），新实现必须整体失败、
 * 且 Profer JSONL 与 Pi transcript 的字节都不变。
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

mock.module('electron', () => ({
  BrowserWindow: { getAllWindows: () => [], fromWebContents: () => undefined },
  app: { getPath: () => '', isPackaged: false },
  clipboard: { readText: () => '', writeText: () => undefined },
  dialog: {},
  nativeImage: {},
  nativeTheme: {},
  Notification: class {},
  powerMonitor: {},
  powerSaveBlocker: {},
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (v: string) => Buffer.from(v), decryptString: (v: Buffer) => v.toString() },
  screen: {},
  shell: {},
  systemPreferences: {},
}))

const SESSION_ID = 'session-pi-anchor'
const SDK_SESSION_ID = 'pi-sdk-anchor'

let root = ''
let messagesPath = ''
let piFilePath = ''
let host: typeof import('./agent-rewind-host')

function message(type: 'user' | 'assistant', uuid: string): string {
  return JSON.stringify({ type, uuid, message: { role: type, content: [{ type: 'text', text: uuid }] } })
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'profer-pi-anchor-'))
  process.env.PROFER_CONFIG_DIR = root
  // 目标消息 a2 没有绑定；更早的 a1 有绑定。旧实现会退到 a1 的锚点。
  writeFileSync(
    join(root, 'agent-sessions.json'),
    JSON.stringify({
      version: 1,
      sessions: [
        {
          id: SESSION_ID,
          workspaceId: 'workspace-pi-anchor',
          agentRuntime: 'pi',
          sdkSessionId: SDK_SESSION_ID,
          piEntryBindings: { a1: 'entry-1' },
          title: 'Pi 锚点测试',
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    }),
    'utf8',
  )
  mkdirSync(join(root, 'agent-sessions'), { recursive: true })
  messagesPath = join(root, 'agent-sessions', `${SESSION_ID}.jsonl`)
  writeFileSync(
    messagesPath,
    [message('user', 'u1'), message('assistant', 'a1'), message('user', 'u2'), message('assistant', 'a2')].join('\n') + '\n',
    'utf8',
  )
  // 合法 Pi transcript：entry-1 存在且祖先链完整，所以「退到 entry-1」是能截断成功的。
  const piDir = join(root, 'sdk-config', 'sessions', 'pi')
  mkdirSync(piDir, { recursive: true })
  piFilePath = join(piDir, `2026-01-01T00-00-00-000Z_${SDK_SESSION_ID}.jsonl`)
  writeFileSync(
    piFilePath,
    [
      JSON.stringify({ type: 'session', id: SDK_SESSION_ID }),
      JSON.stringify({ id: 'entry-0', parentId: null, type: 'message', message: { role: 'user', content: 'u1' } }),
      JSON.stringify({ id: 'entry-1', parentId: 'entry-0', type: 'message', message: { role: 'assistant', content: 'a1' } }),
    ].join('\n') + '\n',
    'utf8',
  )
  const cacheKey = `${Date.now()}-${Math.random()}`
  host = await import(`./agent-rewind-host?pi-anchor-test=${cacheKey}`)
})

afterEach(() => {
  delete process.env.PROFER_CONFIG_DIR
  if (root) rmSync(root, { recursive: true, force: true })
})

describe('Pi 回退锚点必须精确到目标消息', () => {
  test('目标消息没有绑定：回退失败，Profer JSONL 与 Pi transcript 字节都不变', async () => {
    const service = host.createElectronAgentRewindService()
    const proferBefore = readFileSync(messagesPath)
    const piBefore = readFileSync(piFilePath)

    const { plan } = await service.prepare({
      sessionId: SESSION_ID,
      mode: 'conversation',
      target: { kind: 'message', messageUuid: 'a2' },
    })
    const result = await service.execute({
      sessionId: SESSION_ID,
      planId: plan.planId,
      expectedRevision: plan.revision,
    })

    // 不做「截到更早一轮」的静默降级：整次回退失败。
    expect(result.status).toBe('recovery-required')
    expect(readFileSync(messagesPath).equals(proferBefore)).toBe(true)
    expect(readFileSync(piFilePath).equals(piBefore)).toBe(true)
    // 失败发生在任何写盘之前：Pi 文件甚至没有被重写。
    expect(existsSync(piFilePath)).toBe(true)
  })
})
