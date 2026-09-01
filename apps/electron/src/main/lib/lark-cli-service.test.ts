import { afterEach, describe, expect, test } from 'bun:test'
import {
  __resetLarkCliTestState,
  __setLarkCliCommandRunner,
  detectLarkCli,
  getLarkDiagnostics,
  installLarkCli,
  parseLarkAuthStatus,
  type LarkCliCommandRunner,
} from './lark-cli-service'

afterEach(() => __resetLarkCliTestState())

describe('parseLarkAuthStatus', () => {
  test('parses logged-in JSON without retaining secrets', () => {
    const result = parseLarkAuthStatus(JSON.stringify({
      loggedIn: true,
      email: 'user@example.com',
      scopes: ['drive:drive', 'docx:document'],
      token: 'must-not-be-returned',
    }))
    expect(result).toEqual({ state: 'logged_in', userLabel: 'user@example.com', scopeCount: 2, checkedAt: expect.any(Number) })
  })

  test('recognizes authorization failures', () => {
    expect(parseLarkAuthStatus('login required: token expired', 1).state).toBe('reauthorization_required')
  })

  test('parses the official identities status shape', () => {
    const result = parseLarkAuthStatus(JSON.stringify({
      identities: { user: { status: 'missing', available: false, tokenStatus: 'expired', userName: 'Feishu User', scope: 'drive:file:download docs:document:content:read' } },
    }))
    expect(result.state).toBe('reauthorization_required')
    expect(result.userLabel).toBe('Feishu User')
    expect(result.scopeCount).toBe(2)
  })
})

describe('installLarkCli', () => {
  test('uses npm global install so the CLI is discoverable after installation', async () => {
    const calls: Array<{ command: string; args: string[] }> = []
    const runner: LarkCliCommandRunner = {
      exec: async (command, args) => {
        calls.push({ command, args })
        if (command === 'which' && args[0] === 'npm') return { stdout: '/usr/local/bin/npm\n', stderr: '' }
        return { stdout: '', stderr: '' }
      },
      spawn: () => { throw new Error('spawn is not used in this test') },
    }
    __setLarkCliCommandRunner(runner)

    await expect(installLarkCli()).resolves.toEqual({ success: true, message: 'Official Lark CLI installed' })
    expect(calls).toContainEqual({ command: '/usr/local/bin/npm', args: ['install', '--global', '@larksuite/cli@latest'] })
  })
})

describe('detectLarkCli', () => {
  test('reports prerequisite and CLI versions from injected commands', async () => {
    const runner: LarkCliCommandRunner = {
      exec: async (command, args) => {
        if (command === 'where.exe' || command === 'which') {
          const name = args[0]
          if (name === 'node') return { stdout: 'C:\\node\\node.exe\n', stderr: '' }
          if (name === 'npm') return { stdout: 'C:\\node\\npm.cmd\n', stderr: '' }
          if (name === 'npx') return { stdout: 'C:\\node\\npx.cmd\n', stderr: '' }
          if (name === 'lark-cli') return { stdout: 'C:\\tools\\lark-cli.cmd\n', stderr: '' }
        }
        if (args[0] === '--version') {
          if (command.includes('node.exe')) return { stdout: 'v22.13.1\n', stderr: '' }
          if (command.includes('npm.cmd')) return { stdout: '10.9.2\n', stderr: '' }
          if (command.includes('npx.cmd')) return { stdout: '10.9.2\n', stderr: '' }
          if (command.includes('lark-cli.cmd')) return { stdout: 'lark-cli 1.0.0\n', stderr: '' }
        }
        if (args[0] === 'auth' && args[1] === 'status') {
          return { stdout: '{"loggedIn":true,"userLabel":"test-user","scopes":["drive:drive"]}', stderr: '' }
        }
        throw new Error(`unexpected command ${command} ${args.join(' ')}`)
      },
      spawn: () => { throw new Error('spawn is not used in this test') },
    }
    __setLarkCliCommandRunner(runner)
    const result = await detectLarkCli()
    expect(result.cli.available).toBe(true)
    expect(result.cli.version).toBe('1.0.0')
    expect(result.auth.state).toBe('logged_in')
    expect(result.auth.userLabel).toBe('test-user')
    expect(getLarkDiagnostics(result).authState).toBe('logged_in')
  })
})
