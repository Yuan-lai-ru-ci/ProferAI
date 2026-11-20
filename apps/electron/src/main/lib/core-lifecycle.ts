import { randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'
import { CoreClient } from './core-client'
import type { ProviderType } from '@profer/shared'

export interface CoreLaunchSpec {
  command: string
  args: string[]
  cwd?: string
}

export interface CoreLifecycleOptions {
  configDir: string
  workspaceRoot: string
  coreBinary?: string
  coreEntry?: string
  bunCommand?: string
  resourcesPath?: string
  packaged?: boolean
  env?: NodeJS.ProcessEnv
  /** 明文凭据只在启动子进程时短暂放入环境，不写入 Core 配置文件。 */
  channels?: Array<{
    id: string
    name: string
    provider: ProviderType
    apiKey: string
    baseUrl?: string
    agentBaseUrl?: string
    credentialMode?: 'api-key' | 'oauth'
    apiProtocol?: 'responses' | 'chat-completions'
    codexOAuthCredentials?: Record<string, unknown>
    xaiOAuthCredentials?: Record<string, unknown>
  }>
  spawnImpl?: typeof spawn
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>
  healthTimeoutMs?: number
  onOutput?: (line: string) => void
}

export interface StartedCore {
  baseUrl: string
  client: CoreClient
}

function isExecutableFile(path: string | undefined): path is string {
  return Boolean(path && existsSync(path))
}

const WINDOWS_SHELL_ENV_KEYS = ['CLAUDE_CODE_SHELL', 'PROFER_WINDOWS_SHELL', 'PROFER_WSL_DISTRO'] as const

function pickCoreEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = process.platform === 'win32'
    ? ['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']
    : ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'PROFER_ANTHROPIC_API_KEY']
  const selected = Object.fromEntries(allowed.flatMap(key => {
    const entry = Object.entries(source).find(([name]) => name.toLowerCase() === key.toLowerCase())
    return entry?.[1] ? [[entry[0], entry[1]]] : []
  }))
  if (process.platform === 'win32') {
    for (const key of WINDOWS_SHELL_ENV_KEYS) {
      const value = Object.entries(source).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1]
      if (value) selected[key] = value
    }
  }
  return selected
}

export function resolveCoreLaunchSpec(options: Pick<CoreLifecycleOptions, 'coreBinary' | 'coreEntry' | 'bunCommand' | 'resourcesPath' | 'packaged' | 'env'>): CoreLaunchSpec {
  const env = options.env ?? process.env
  const configuredBinary = options.coreBinary ?? env.PROFER_CORE_BIN
  if (configuredBinary) return { command: configuredBinary, args: [] }

  if (options.packaged) {
    const bundled = join(options.resourcesPath ?? '', 'bin', process.platform === 'win32' ? 'profer-core.exe' : 'profer-core')
    if (isExecutableFile(bundled)) return { command: bundled, args: [] }
    throw new Error('打包应用缺少 Profer Core 二进制，请设置 PROFER_CORE_BIN')
  }

  const configuredEntry = options.coreEntry
  const entryCandidates = configuredEntry
    ? [configuredEntry]
    : [resolve(process.cwd(), 'apps/core/src/index.ts'), resolve(process.cwd(), '../core/src/index.ts')]
  const entry = entryCandidates.find(candidate => existsSync(candidate))
  if (!entry) throw new Error('开发环境未找到 apps/core/src/index.ts，请从 Profer 仓库启动 Electron')
  // Windows 的 npm 全局安装常只把 bun.cmd 放进 PATH；spawn 不经 shell，必须定位真正的 exe。
  const pathValue = Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? ''
  const pathBun = process.platform === 'win32'
    ? pathValue.split(delimiter).filter(Boolean)
      .flatMap(directory => [join(directory, 'bun.exe'), join(directory, 'node_modules', 'bun', 'bin', 'bun.exe')])
      .find(candidate => isExecutableFile(candidate))
    : undefined
  return { command: options.bunCommand ?? env.PROFER_BUN_PATH ?? pathBun ?? 'bun', args: [entry] }
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolvePromise())
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise<void>(resolvePromise => server.close(() => resolvePromise()))
  if (!port) throw new Error('无法分配 Core 端口')
  return port
}

export class LocalCoreLifecycle {
  private readonly options: CoreLifecycleOptions
  private readonly spawnImpl: typeof spawn
  private child: ChildProcess | null = null
  private started: StartedCore | null = null
  private token: string | null = null
  private startupError: Error | null = null

  constructor(options: CoreLifecycleOptions) {
    this.options = options
    this.spawnImpl = options.spawnImpl ?? spawn
  }

  async start(): Promise<StartedCore> {
    if (this.started) return this.started
    const port = await reserveLoopbackPort()
    const token = randomUUID()
    const spec = resolveCoreLaunchSpec(this.options)
    const env = {
      ...pickCoreEnvironment(this.options.env ?? process.env),
      PROFER_CORE_LISTEN: `127.0.0.1:${port}`,
      PROFER_CORE_API_KEY: token,
      PROFER_CONFIG_DIR: resolve(this.options.configDir),
      PROFER_CORE_WORKSPACE_ROOT: resolve(this.options.workspaceRoot),
      PROFER_CORE_DESKTOP_WORKSPACE_INDEX: join(resolve(this.options.configDir), 'agent-workspaces.json'),
      PROFER_CORE_DESKTOP_WORKSPACE_INDEX_WRITABLE: '1',
      PROFER_CORE_DESKTOP_AUTOMATION_TIME_ZONE: Intl.DateTimeFormat().resolvedOptions().timeZone,
      ...(this.options.channels && this.options.channels.length > 0 ? { PROFER_CORE_CHANNELS_JSON: JSON.stringify(this.options.channels) } : {}),
    }
    const child = this.spawnImpl(spec.command, spec.args, {
      cwd: spec.cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.child = child
    this.startupError = null
    child.on('error', error => { this.startupError = error })
    child.stdout?.on('data', chunk => this.options.onOutput?.(String(chunk).trim()))
    child.stderr?.on('data', chunk => this.options.onOutput?.(String(chunk).trim()))
    const baseUrl = `http://127.0.0.1:${port}`
    const client = new CoreClient({ baseUrl, token, fetchImpl: this.options.fetchImpl, recoverEvents: true })
    try {
      await this.waitForHealth(client)
      await client.connect()
    } catch (error) {
      await this.stop()
      throw error
    }
    this.token = token
    this.started = { baseUrl, client }
    return this.started
  }

  async stop(): Promise<void> {
    const child = this.child
    this.child = null
    this.started?.client.close()
    this.started = null
    this.token = null
    if (!child || child.exitCode !== null || this.startupError) return
    await new Promise<void>(resolvePromise => {
      let settled = false
      const finish = (): void => { if (!settled) { settled = true; resolvePromise() } }
      child.once('exit', finish)
      if (process.platform === 'win32' && child.pid) {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
        killer.once('exit', finish)
        killer.once('error', finish)
      } else {
        try { child.kill('SIGTERM') } catch { finish() }
        setTimeout(() => { try { child.kill('SIGKILL') } catch {} ; finish() }, 2_000).unref()
      }
    })
  }

  private async waitForHealth(client: CoreClient): Promise<void> {
    const deadline = Date.now() + (this.options.healthTimeoutMs ?? 15_000)
    let lastError: unknown
    while (Date.now() < deadline) {
      if (this.startupError) throw this.startupError
      if (this.child?.exitCode !== null) throw new Error('Profer Core 在健康检查前退出')
      try {
        const health = await client.health()
        if (health.status === 'ok') return
      } catch (error) { lastError = error }
      await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
    }
    throw new Error(`Profer Core 健康检查超时${lastError instanceof Error ? `: ${lastError.message}` : ''}`)
  }
}
