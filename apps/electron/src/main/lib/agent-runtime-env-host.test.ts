import { describe, expect, test } from 'bun:test'
import type { RuntimeStatus } from '@profer/shared'
import { resolveHostAgentRuntimeEnv, resolveShellDescriptor } from './agent-runtime-env-host'
import type { ShellSnapshot } from './shell-snapshot'

/**
 * 宿主侧 Pi runtimeEnv 的平台语义 fixture。
 *
 * 当前宿主是 macOS，但 Windows 的 Git Bash / WSL 选择必须在任意宿主上可验证，
 * 因此所有宿主事实（platform / runtimeStatus / shellPreference / proxyUrl / shell 快照）
 * 都以参数注入，不依赖真实 Windows 机器。
 */

function runtimeStatus(overrides: {
  gitBash?: { available: boolean; path: string | null }
  wsl?: { available: boolean; defaultDistro: string | null }
  recommended?: 'git-bash' | 'wsl' | null
} = {}): RuntimeStatus {
  return {
    node: { available: false, path: null, version: null, error: null },
    bun: { available: false, path: null, version: null, source: null, error: null },
    git: { available: false, path: null, version: null, error: null },
    shell: {
      gitBash: { available: overrides.gitBash?.available ?? false, path: overrides.gitBash?.path ?? null, version: null, error: null },
      wsl: {
        available: overrides.wsl?.available ?? false,
        version: 2,
        defaultDistro: overrides.wsl?.defaultDistro ?? null,
        distros: [],
        error: null,
      },
      recommended: overrides.recommended ?? null,
    },
    envLoaded: true,
    initializedAt: 1,
  }
}

function shellSnapshot(env: Record<string, string>): ShellSnapshot {
  return {
    id: 'fixture',
    sessionId: 'session-1',
    cwd: 'C:\\workspace',
    shell: { kind: 'bash', path: '/bin/bash', login: true, source: 'detected' },
    env,
    pathEntries: [],
    commandPaths: {},
    envHash: 'fixture',
    createdAt: 1,
    capturedAt: 1,
    source: 'login-shell',
    version: 1,
  }
}

describe('resolveShellDescriptor（平台判定唯一实现）', () => {
  test('Given Windows + 用户偏好 Git Bash 且可用 Then 描述符为 configured git-bash', () => {
    expect(resolveShellDescriptor('win32', 'git-bash', runtimeStatus({ gitBash: { available: true, path: 'C:\\Program Files\\Git\\bin\\bash.exe' } })))
      .toEqual({ kind: 'git-bash', path: 'C:\\Program Files\\Git\\bin\\bash.exe', login: false, source: 'configured' })
  })

  test('Given Windows + 用户偏好 WSL Then 描述符为 configured wsl（不依赖 Git Bash 状态）', () => {
    expect(resolveShellDescriptor('win32', 'wsl', runtimeStatus({ gitBash: { available: true, path: 'C:\\Git\\bash.exe' } })))
      .toEqual({ kind: 'wsl', path: 'wsl.exe', login: false, source: 'configured' })
  })

  test('Given Windows + auto Then 按 runtime status 推荐值走 detected', () => {
    expect(resolveShellDescriptor('win32', 'auto', runtimeStatus({ gitBash: { available: true, path: 'C:\\Git\\bash.exe' }, recommended: 'git-bash' })))
      .toEqual({ kind: 'git-bash', path: 'C:\\Git\\bash.exe', login: false, source: 'detected' })
    expect(resolveShellDescriptor('win32', 'auto', runtimeStatus({ wsl: { available: true, defaultDistro: 'Ubuntu' }, recommended: 'wsl' })))
      .toEqual({ kind: 'wsl', path: 'wsl.exe', login: false, source: 'detected' })
  })

  test('Given 非 Windows 且无 shell 推荐值 Then 不指定 shell（交给平台推断，不做第二套判定）', () => {
    expect(resolveShellDescriptor('darwin', 'git-bash', runtimeStatus({ gitBash: { available: true, path: '/opt/git/bin/bash' } }))).toBeUndefined()
    expect(resolveShellDescriptor('linux', 'auto', runtimeStatus({}))).toBeUndefined()
  })
})

describe('resolveHostAgentRuntimeEnv（新链 Pi runtimeEnv 与旧链同源）', () => {
  test('Given Windows Git Bash 环境 Then runtimeEnv 带 shellKind / shellPath / PATH / 代理 / 快照环境', async () => {
    const result = await resolveHostAgentRuntimeEnv({
      sessionId: 'session-1',
      cwd: 'C:\\workspace',
      platform: 'win32',
      pathDelimiter: ';',
      processEnv: { Path: 'C:\\Windows\\System32', SHELL: 'C:\\Windows\\System32\\cmd.exe' },
      shellPreference: 'auto',
      runtimeStatus: runtimeStatus({ gitBash: { available: true, path: 'C:\\Program Files\\Git\\bin\\bash.exe' }, recommended: 'git-bash' }),
      proxyUrl: 'http://127.0.0.1:7890',
      bundledCliPath: 'C:\\Program Files\\Profer\\resources\\bin\\profer.exe',
      shellSnapshot: shellSnapshot({ Path: 'C:\\Program Files\\Git\\cmd;C:\\Windows\\System32' }),
      pathExists: () => false,
    })

    expect(result.shellKind).toBe('git-bash')
    expect(result.shellPath).toBe('C:\\Program Files\\Git\\bin\\bash.exe')
    expect(result.env.PROFER_WINDOWS_SHELL).toBe('git-bash')
    expect(result.env.CLAUDE_CODE_SHELL).toBe('C:\\Program Files\\Git\\bin\\bash.exe')
    expect(result.env.SHELL).toBe('C:\\Program Files\\Git\\bin\\bash.exe')
    expect(result.env.PROFER_CLI).toBe('C:\\Program Files\\Profer\\resources\\bin\\profer.exe')
    expect(result.env.HTTP_PROXY).toBe('http://127.0.0.1:7890')
    expect(result.env.http_proxy).toBe('http://127.0.0.1:7890')
    // 登录 shell 快照的 PATH 参与合并：CLI 目录与快照条目都在。
    expect(result.env.Path?.split(';')[0]).toBe('C:\\Program Files\\Profer\\resources\\bin')
    expect(result.env.Path).toContain('C:\\Program Files\\Git\\cmd')
  })

  test('Given Windows WSL 偏好 Then runtimeEnv 带 wslCommand 与默认发行版', async () => {
    const result = await resolveHostAgentRuntimeEnv({
      sessionId: 'session-1',
      cwd: 'C:\\workspace',
      platform: 'win32',
      pathDelimiter: ';',
      processEnv: { Path: 'C:\\Windows\\System32', SystemRoot: 'C:\\Windows' },
      shellPreference: 'wsl',
      runtimeStatus: runtimeStatus({ wsl: { available: true, defaultDistro: 'Ubuntu-22.04' } }),
      shellSnapshot: shellSnapshot({}),
      pathExists: (path) => path.endsWith('wsl.exe'),
    })

    expect(result.shellKind).toBe('wsl')
    // 目标为 Windows 时必须使用 Windows 路径，不受执行测试的宿主平台影响。
    expect(result.wslCommand).toBe('C:\\Windows\\System32\\wsl.exe')
    expect(result.wslDistro).toBe('Ubuntu-22.04')
    expect(result.env.PROFER_WINDOWS_SHELL).toBe('wsl')
    expect(result.env.PROFER_WSL_DISTRO).toBe('Ubuntu-22.04')
    expect(result.env.CLAUDE_CODE_SHELL).toBe(result.wslCommand)
  })

  test('Given Windows 未检测到任何 shell Then 不伪造 shellKind（保持旧链的缺失语义）', async () => {
    const result = await resolveHostAgentRuntimeEnv({
      sessionId: 'session-1',
      cwd: 'C:\\workspace',
      platform: 'win32',
      pathDelimiter: ';',
      processEnv: { Path: 'C:\\Windows\\System32' },
      shellPreference: 'auto',
      runtimeStatus: runtimeStatus({}),
      shellSnapshot: shellSnapshot({}),
    })

    expect(result.shellKind).toBeUndefined()
    expect(result.shellPath).toBeUndefined()
    expect(result.env.CLAUDE_CODE_SHELL).toBeUndefined()
  })

  test('Given macOS/Linux 宿主 Then 使用存在性校验过的 Bash 绝对路径且不覆盖 SHELL', async () => {
    const result = await resolveHostAgentRuntimeEnv({
      sessionId: 'session-1',
      cwd: '/Users/alice/workspace',
      platform: 'darwin',
      pathDelimiter: ':',
      processEnv: { PATH: '/usr/bin:/bin', SHELL: '/bin/zsh' },
      shellPreference: 'auto',
      runtimeStatus: runtimeStatus({}),
      shellSnapshot: shellSnapshot({ PATH: '/usr/local/bin:/usr/bin' }),
      pathExists: (path) => path === '/bin/bash',
    })

    expect(result.shellKind).toBe('posix')
    expect(result.shellPath).toBe('/bin/bash')
    expect(result.env.SHELL).toBeUndefined()
    expect(result.env.PATH).toContain('/usr/local/bin')
  })

  test('Given Linux 宿主 Then 同样解析 posix shell（不因平台不同退回裸 bash）', async () => {
    const result = await resolveHostAgentRuntimeEnv({
      sessionId: 'session-1',
      cwd: '/home/mac/workspace',
      platform: 'linux',
      pathDelimiter: ':',
      processEnv: { PATH: '/usr/bin:/bin' },
      shellPreference: 'auto',
      runtimeStatus: runtimeStatus({}),
      shellSnapshot: shellSnapshot({}),
      pathExists: (path) => path === '/usr/bin/bash',
    })

    expect(result.shellKind).toBe('posix')
    expect(result.shellPath).toBe('/usr/bin/bash')
  })
})
