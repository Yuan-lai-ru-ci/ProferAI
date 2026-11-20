import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

mock.module('electron', () => ({
  app: { getPath: () => '', isPackaged: false },
  dialog: {},
  BrowserWindow: {},
}))

const { readAttachmentAsBase64 } = await import('./attachment-service')
const { invalidateWorkspaceLocation } = await import('./workspace-locator')

let root = ''
let previousConfigRoot: string | undefined

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'profer-attachment-project-')))
  previousConfigRoot = process.env.PROFER_CONFIG_DIR
  process.env.PROFER_CONFIG_DIR = join(root, 'config')
  invalidateWorkspaceLocation()
})

afterEach(() => {
  if (previousConfigRoot === undefined) delete process.env.PROFER_CONFIG_DIR
  else process.env.PROFER_CONFIG_DIR = previousConfigRoot
  rmSync(root, { recursive: true, force: true })
  invalidateWorkspaceLocation()
})

function writeFileAt(path: string, content: string): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  return path
}

function writeProjectWorkspace(slug: string, projectRoot: string): void {
  const indexPath = join(root, 'config', 'agent-workspaces.json')
  mkdirSync(dirname(indexPath), { recursive: true })
  writeFileSync(indexPath, JSON.stringify({
    version: 4,
    workspaces: [{
      id: `id-${slug}`,
      name: slug,
      slug,
      createdAt: 1,
      updatedAt: 1,
      type: 'personal',
      storageMode: 'project',
      rootPath: projectRoot,
    }],
  }))
  invalidateWorkspaceLocation()
}

function decode(base64: string): string {
  return Buffer.from(base64, 'base64').toString('utf-8')
}

describe('project 布局的绝对路径附件', () => {
  test('生图产物/会话附件位于项目内 .profer/sessions 时可读取', () => {
    const projectRoot = join(root, 'projects', 'vibrobot')
    writeProjectWorkspace('vibrobot', projectRoot)
    const image = writeFileAt(
      join(projectRoot, '.profer', 'sessions', 'session-1', '.context', 'agent-output-images', 'crop.png'),
      'project-bytes',
    )

    expect(decode(readAttachmentAsBase64(image))).toBe('project-bytes')
  })

  test('项目根其它位置仍然拒绝', () => {
    const projectRoot = join(root, 'projects', 'vibrobot')
    writeProjectWorkspace('vibrobot', projectRoot)
    const outside = writeFileAt(join(projectRoot, 'data', 'overlay.png'), 'bytes')

    expect(() => readAttachmentAsBase64(outside)).toThrow('附件路径不在安全目录内')
  })

  test('同前缀目录不算安全目录（sessions-evil / config-evil）', () => {
    const projectRoot = join(root, 'projects', 'vibrobot')
    writeProjectWorkspace('vibrobot', projectRoot)
    const sessionsEvil = writeFileAt(join(projectRoot, '.profer', 'sessions-evil', 'x.png'), 'bytes')
    const configEvil = writeFileAt(join(root, 'config-evil', 'x.png'), 'bytes')

    expect(() => readAttachmentAsBase64(sessionsEvil)).toThrow('附件路径不在安全目录内')
    expect(() => readAttachmentAsBase64(configEvil)).toThrow('附件路径不在安全目录内')
  })

  test('未注册工作区的 .profer/sessions 不放行', () => {
    const stranger = writeFileAt(
      join(root, 'other-project', '.profer', 'sessions', 'session-1', 'x.png'),
      'bytes',
    )

    expect(() => readAttachmentAsBase64(stranger)).toThrow('附件路径不在安全目录内')
  })

  test('全局配置目录内的绝对路径保持可读', () => {
    const managed = writeFileAt(
      join(root, 'config', 'agent-workspaces', 'ws', 'session-1', 'x.png'),
      'managed-bytes',
    )

    expect(decode(readAttachmentAsBase64(managed))).toBe('managed-bytes')
  })
})
