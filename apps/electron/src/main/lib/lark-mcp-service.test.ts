import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { WorkspaceMcpConfig } from '@profer/shared'

let configDir = ''
const workspaceConfigs = new Map<string, WorkspaceMcpConfig>()

// Keep the service test independent from Electron's native safeStorage binding.
// The production service still uses token-crypto; this fake verifies that only its
// encrypted result is persisted or exposed through the workspace configuration.
mock.module('./config-paths', () => ({
  getConfigDir: () => configDir,
  getWorkspaceMcpPath: (slug: string) => join(configDir, `${slug}.mcp.json`),
}))
mock.module('./token-crypto', () => ({
  encryptToken: (value: string) => `encrypted:${Buffer.from(value).toString('base64url')}`,
  decryptToken: (value: string) => Buffer.from(value.replace(/^encrypted:/, ''), 'base64url').toString('utf8'),
}))
mock.module('./agent-workspace-manager', () => ({
  getWorkspaceMcpConfig: (slug: string) => workspaceConfigs.get(slug) ?? { servers: {} },
  saveWorkspaceMcpConfig: (slug: string, config: WorkspaceMcpConfig) => workspaceConfigs.set(slug, config),
  listAgentWorkspaces: () => [{ slug: 'workspace-a' }, { slug: 'workspace-b' }],
}))

const service = await import('./lark-mcp-service')

describe('lark-mcp-service', () => {
  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'profer-lark-mcp-'))
    workspaceConfigs.clear()
  })

  afterEach(() => {
    service.disposeLarkMcpService()
    rmSync(configDir, { recursive: true, force: true })
  })

  test('keeps the App Secret out of workspace mcp.json and only injects it for a private binding', () => {
    const appSecret = 'private-app-secret-must-not-persist-in-mcp-json'
    expect(service.saveLarkMcpCredentials({ appId: 'cli_demo123', appSecret }).success).toBe(true)

    const privateConfig = readFileSync(join(configDir, 'lark-mcp.enc.json'), 'utf8')
    expect(privateConfig).not.toContain(appSecret)
    expect(service.enableLarkMcpForWorkspace('workspace-a').success).toBe(true)

    const entry = workspaceConfigs.get('workspace-a')!.servers['lark-mcp']!
    expect(JSON.stringify(entry)).not.toContain(appSecret)
    expect(entry.env).toBeUndefined()
    expect(entry.args).toEqual([
      '-y', '@larksuiteoapi/lark-mcp', 'mcp', '--oauth', '--token-mode', 'user_access_token',
      '--tools', 'preset.light,preset.doc.default,preset.base.default,preset.base.batch,preset.calendar.default',
    ])

    const runtimeEntry = service.getLarkMcpEntryWithRuntimeEnv('workspace-a', entry)
    expect(runtimeEntry?.env).toMatchObject({ APP_ID: 'cli_demo123', APP_SECRET: appSecret })
    expect(service.getLarkMcpEntryWithRuntimeEnv('workspace-b', entry)).toBeNull()
    expect(service.getLarkMcpStatus().enabledWorkspaces).toEqual(['workspace-a'])
  })

  test('normalizes the short-lived split tool preset config before launching the MCP server', () => {
    expect(service.saveLarkMcpCredentials({ appId: 'cli_demo123', appSecret: 'secret' }).success).toBe(true)
    expect(service.enableLarkMcpForWorkspace('workspace-a').success).toBe(true)
    const splitPresetEntry = {
      type: 'stdio' as const,
      command: 'npx',
      args: [
        '-y', '@larksuiteoapi/lark-mcp', 'mcp', '--oauth', '--token-mode', 'user_access_token', '--tools',
        'preset.light', 'preset.doc.default', 'preset.base.default', 'preset.base.batch', 'preset.calendar.default',
      ],
      enabled: true,
      isBuiltin: true,
    }

    expect(service.isLarkMcpEntry('lark-mcp', splitPresetEntry)).toBe(true)
    const runtimeEntry = service.getLarkMcpEntryWithRuntimeEnv('workspace-a', splitPresetEntry)
    expect(runtimeEntry?.args).toEqual([
      '-y', '@larksuiteoapi/lark-mcp', 'mcp', '--oauth', '--token-mode', 'user_access_token', '--tools',
      'preset.light,preset.doc.default,preset.base.default,preset.base.batch,preset.calendar.default',
    ])
    expect(runtimeEntry?.env).toMatchObject({ APP_ID: 'cli_demo123', APP_SECRET: 'secret' })
  })

  test('upgrades the previously managed document-only entry to include calendar tools', () => {
    expect(service.saveLarkMcpCredentials({ appId: 'cli_demo123', appSecret: 'secret' }).success).toBe(true)
    workspaceConfigs.set('workspace-a', {
      servers: {
        'lark-mcp': {
          type: 'stdio',
          command: 'npx',
          args: [
            '-y', '@larksuiteoapi/lark-mcp', 'mcp', '--oauth', '--token-mode', 'user_access_token',
            '--tools', 'preset.light,preset.doc.default,preset.base.default,preset.base.batch',
          ],
          enabled: true,
          isBuiltin: true,
        },
      },
    })

    expect(service.enableLarkMcpForWorkspace('workspace-a').success).toBe(true)
    expect(workspaceConfigs.get('workspace-a')!.servers['lark-mcp']!.args?.at(-1)).toContain('preset.calendar.default')
  })

  test('does not inject credentials for a lookalike or after disabling the workspace', () => {
    expect(service.saveLarkMcpCredentials({ appId: 'cli_demo123', appSecret: 'secret' }).success).toBe(true)
    const lookalike = {
      type: 'stdio' as const,
      command: 'npx',
      args: ['-y', '@larksuiteoapi/lark-mcp', 'mcp', '--oauth'],
      enabled: true,
      isBuiltin: true,
    }
    expect(service.isLarkMcpEntry('lark-mcp', lookalike)).toBe(false)
    expect(service.getLarkMcpEntryWithRuntimeEnv('workspace-a', lookalike)).toEqual(lookalike)

    const legacy = {
      ...lookalike,
      args: [
        '-y', '@larksuiteoapi/lark-mcp', 'mcp', '--oauth', '--token-mode', 'user_access_token',
        '--tools', 'preset.light,preset.doc.default,preset.base.default,preset.base.batch',
      ],
    }
    expect(service.isLarkMcpEntry('lark-mcp', legacy)).toBe(true)
    expect(service.enableLarkMcpForWorkspace('workspace-a').success).toBe(true)
    expect(service.getLarkMcpEntryWithRuntimeEnv('workspace-a', legacy)?.env).toMatchObject({ APP_ID: 'cli_demo123', APP_SECRET: 'secret' })
    expect(service.disableLarkMcpForWorkspace('workspace-a').success).toBe(true)
    expect(workspaceConfigs.get('workspace-a')!.servers['lark-mcp']).toBeUndefined()
    expect(service.getLarkMcpStatus().enabledWorkspaces).toEqual([])
    expect(existsSync(join(configDir, 'workspace-a.mcp.json'))).toBe(false)
  })
})
