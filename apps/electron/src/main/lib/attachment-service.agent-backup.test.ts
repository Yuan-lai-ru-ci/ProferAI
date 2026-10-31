import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

mock.module('electron', () => ({
  app: { getPath: () => '', isPackaged: false },
  dialog: {},
  BrowserWindow: {},
}))

const { backupAgentAttachment } = await import('./agent-attachment-backup')
const { readAttachmentAsBase64 } = await import('./attachment-service')

let root = ''
let previousConfigRoot: string | undefined

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'profer-attachment-read-'))
  previousConfigRoot = process.env.PROFER_CONFIG_DIR
  process.env.PROFER_CONFIG_DIR = join(root, 'config')
})

afterEach(() => {
  if (previousConfigRoot === undefined) delete process.env.PROFER_CONFIG_DIR
  else process.env.PROFER_CONFIG_DIR = previousConfigRoot
  rmSync(root, { recursive: true, force: true })
})

function writeSessionAttachment(sessionId: string, filename: string, content: string): string {
  const path = join(root, 'config', 'agent-workspaces', 'ws', sessionId, filename)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  return path
}

describe('读取用户附件', () => {
  test('会话附件被模型删掉后，readAttachment 回退到备份', () => {
    const source = writeSessionAttachment('session-1', 'image.png', 'screenshot-bytes')
    backupAgentAttachment('session-1', source)
    rmSync(source)

    const base64 = readAttachmentAsBase64(source)

    expect(Buffer.from(base64, 'base64').toString('utf-8')).toBe('screenshot-bytes')
  })

  test('修复前落盘的旧附件：第一次读取后自动补建备份', () => {
    const source = writeSessionAttachment('session-1', 'legacy.png', 'legacy-bytes')

    expect(readAttachmentAsBase64(source)).toBe(Buffer.from('legacy-bytes').toString('base64'))
    rmSync(source)

    expect(Buffer.from(readAttachmentAsBase64(source), 'base64').toString('utf-8')).toBe('legacy-bytes')
  })

  test('既没有原文件也没有备份时仍然明确报错', () => {
    const source = writeSessionAttachment('session-1', 'image.png', 'bytes')
    rmSync(source)

    expect(() => readAttachmentAsBase64(source)).toThrow('附件文件不存在')
  })
})
