import { afterEach, describe, expect, test } from 'bun:test'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { resolveConfigDir } from './paths'

const originalProferDev = process.env.PROFER_DEV
const originalPromaDev = process.env.PROMA_DEV
const originalConfigDir = process.env.PROFER_CONFIG_DIR

afterEach(() => {
  if (originalProferDev === undefined) delete process.env.PROFER_DEV
  else process.env.PROFER_DEV = originalProferDev
  if (originalPromaDev === undefined) delete process.env.PROMA_DEV
  else process.env.PROMA_DEV = originalPromaDev
  if (originalConfigDir === undefined) delete process.env.PROFER_CONFIG_DIR
  else process.env.PROFER_CONFIG_DIR = originalConfigDir
})

describe('resolveConfigDir', () => {
  test('defaults to the Profer production directory', () => {
    delete process.env.PROFER_DEV
    delete process.env.PROMA_DEV
    delete process.env.PROFER_CONFIG_DIR
    expect(resolveConfigDir()).toBe(join(homedir(), '.profer'))
  })

  test('uses the Profer development directory for --dev and either development environment variable', () => {
    delete process.env.PROFER_CONFIG_DIR
    expect(resolveConfigDir({ dev: true })).toBe(join(homedir(), '.profer-dev'))
    process.env.PROFER_DEV = '1'
    expect(resolveConfigDir()).toBe(join(homedir(), '.profer-dev'))
    delete process.env.PROFER_DEV
    process.env.PROMA_DEV = '1'
    expect(resolveConfigDir()).toBe(join(homedir(), '.profer-dev'))
  })

  test('gives an explicit config directory precedence', () => {
    process.env.PROFER_DEV = '1'
    expect(resolveConfigDir({ configDir: 'D:/custom-profer' })).toBe('D:/custom-profer')
  })

  test('honors PROFER_CONFIG_DIR like the Electron main process does', () => {
    delete process.env.PROFER_DEV
    process.env.PROFER_CONFIG_DIR = '/tmp/profer-isolated'
    expect(resolveConfigDir()).toBe(resolve('/tmp/profer-isolated'))
    // 显式 --config-dir 仍然优先于环境变量
    expect(resolveConfigDir({ configDir: '/tmp/explicit' })).toBe('/tmp/explicit')
  })
})
