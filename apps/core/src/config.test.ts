import { describe, expect, test } from 'bun:test'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseCoreConfig } from './config'

describe('parseCoreConfig', () => {
  test('uses safe local defaults', () => {
    expect(parseCoreConfig({ env: {}, homeDir: '/home/tester' })).toEqual({
      host: '127.0.0.1',
      port: 7788,
      configDir: resolve('/home/tester/.profer'),
      workspaceRoot: resolve('/home/tester/.profer/workspaces'),
    })
  })

  test('CLI flags override environment variables', () => {
    expect(parseCoreConfig({
      argv: ['--listen', '0.0.0.0:9000', '--config-dir=/srv/profer'],
      env: { PROFER_CORE_LISTEN: '127.0.0.1:7000', PROFER_CONFIG_DIR: '/tmp/profer' },
      homeDir: '/home/tester',
    })).toEqual({ host: '0.0.0.0', port: 9000, configDir: resolve('/srv/profer'), workspaceRoot: resolve('/srv/profer/workspaces') })
  })

  test('显式解析桌面只读索引路径，默认不启用', () => {
    expect(parseCoreConfig({ env: {}, homeDir: '/home/tester' }).desktopWorkspaceIndexPath).toBeUndefined()
    expect(parseCoreConfig({ env: { PROFER_CORE_DESKTOP_WORKSPACE_INDEX: '/desktop/agent-workspaces.json' } }).desktopWorkspaceIndexPath)
      .toBe(resolve('/desktop/agent-workspaces.json'))
  })

  test('解析本机Core的显式桌面v4索引写权限，默认仍只读', () => {
    expect(parseCoreConfig({ env: { PROFER_CORE_DESKTOP_WORKSPACE_INDEX: '/desktop/agent-workspaces.json' } }).desktopWorkspaceIndexWritable).toBeUndefined()
    expect(parseCoreConfig({ env: { PROFER_CORE_DESKTOP_WORKSPACE_INDEX: '/desktop/agent-workspaces.json', PROFER_CORE_DESKTOP_WORKSPACE_INDEX_WRITABLE: '1' } }))
      .toMatchObject({ desktopWorkspaceIndexPath: resolve('/desktop/agent-workspaces.json'), desktopWorkspaceIndexWritable: true })
  })

  test('parses configured Pi channels', () => {
    expect(parseCoreConfig({
      env: {
        PROFER_CORE_CHANNELS_JSON: JSON.stringify([{ id: 'deepseek', name: 'DeepSeek', provider: 'deepseek', apiKey: 'secret', baseUrl: 'https://example.test' }]),
      },
      homeDir: '/home/tester',
    }).channels).toEqual([{ id: 'deepseek', name: 'DeepSeek', provider: 'deepseek', apiKey: 'secret', baseUrl: 'https://example.test' }])
  })

  test('rejects invalid ports and hosts', () => {
    expect(() => parseCoreConfig({ argv: ['--listen', '127.0.0.1:0'] })).toThrow('invalid listen port')
    expect(() => parseCoreConfig({ argv: ['--listen', 'bad host:7788'] })).toThrow('invalid listen host')
  })

  test('falls back to the current user home when no home override is supplied', () => {
    expect(parseCoreConfig({ env: {} }).configDir).toBe(resolve(join(homedir(), '.profer')))
    expect(parseCoreConfig({ env: {} }).workspaceRoot).toBe(resolve(join(homedir(), '.profer', 'workspaces')))
  })
})
