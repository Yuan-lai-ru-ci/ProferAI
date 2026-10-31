import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { backupAgentAttachment, resolveAgentAttachmentBackup } from './agent-attachment-backup'

let root = ''
let previousConfigRoot: string | undefined

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'profer-attachment-backup-'))
  previousConfigRoot = process.env.PROFER_CONFIG_DIR
  process.env.PROFER_CONFIG_DIR = join(root, 'config')
})

afterEach(() => {
  if (previousConfigRoot === undefined) delete process.env.PROFER_CONFIG_DIR
  else process.env.PROFER_CONFIG_DIR = previousConfigRoot
  rmSync(root, { recursive: true, force: true })
})

const sessionAttachmentPath = (sessionId: string, filename: string): string =>
  join(root, 'config', 'agent-workspaces', 'ws', sessionId, filename)

function writeSessionAttachment(sessionId: string, filename: string, content: string): string {
  const path = sessionAttachmentPath(sessionId, filename)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  return path
}

describe('用户附件备份', () => {
  test('备份是独立副本，Agent 覆盖原文件后仍保留原始内容', () => {
    const source = writeSessionAttachment('session-1', 'image.png', 'first-bytes')

    const backup = backupAgentAttachment('session-1', source)

    expect(backup).toBeDefined()
    expect(statSync(backup!).nlink).toBe(1)
    writeFileSync(source, 'overwritten-by-agent')
    expect(readFileSync(backup!, 'utf-8')).toBe('first-bytes')
  })

  test('Agent 删掉会话 cwd 里的附件后，仍能按原路径找回备份', () => {
    const source = writeSessionAttachment('session-1', 'image.png', 'screenshot-bytes')
    backupAgentAttachment('session-1', source)
    rmSync(source)

    const resolved = resolveAgentAttachmentBackup(source)

    expect(resolved).toBeDefined()
    expect(existsSync(resolved!)).toBe(true)
  })

  test('非会话目录路径不会被重定向到备份目录', () => {
    const outside = join(root, 'elsewhere', 'image.png')
    mkdirSync(dirname(outside), { recursive: true })
    writeFileSync(outside, 'bytes')

    expect(resolveAgentAttachmentBackup(outside)).toBeUndefined()
  })

  test('同名附件再次写入时备份跟随最新内容', () => {
    const source = writeSessionAttachment('session-1', 'image.png', 'first-bytes')
    backupAgentAttachment('session-1', source)

    writeFileSync(source, 'second-bytes')
    backupAgentAttachment('session-1', source)
    rmSync(source)

    const resolved = resolveAgentAttachmentBackup(source)
    expect(resolved).toBeDefined()
    expect(readFileSync(resolved!, 'utf-8')).toBe('second-bytes')
  })

  test('缺少会话 ID 时不备份', () => {
    const source = writeSessionAttachment('session-1', 'image.png', 'bytes')

    expect(backupAgentAttachment('', source)).toBeUndefined()
  })
})
