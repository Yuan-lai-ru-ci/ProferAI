import { mkdirSync, realpathSync, readFileSync, writeFileSync, rmdirSync, unlinkSync, statSync, renameSync, openSync, fstatSync, closeSync, constants } from 'node:fs'
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { holdWindowsCoreOwner, requestWindowsOwner, type WindowsCoreOwnerLease } from './windows-core-owner'

export interface LocalCoreOwnerOptions {
  /** 明确选定的 Core 运行目录；Windows helper 只从此安装定位。 */
  runtimeDir?: string
}

/** 独立 Core 在创建业务 runtime 前获取，在收尾后释放。旧 writer 仍使用同步目录锁。 */
export async function acquireLocalCoreOwner(configDir: string, options: LocalCoreOwnerOptions & { onLockLost?: () => void } = {}): Promise<WindowsCoreOwnerLease> {
  if (process.platform === 'win32') {
    if (!options.runtimeDir) throw new Error('Windows 本机 Core 需要明确选择 Core 安装目录')
    return holdWindowsCoreOwner(options.runtimeDir, configDir, options.onLockLost ?? (() => process.exit(1)))
  }
  const release = acquireCoreExecutionLock(configDir)
  let unpublish: (() => void) | undefined
  return {
    async publish(endpoint) { unpublish = publishLocalCoreOwner(configDir, endpoint) },
    async remove() { const remove = unpublish; unpublish = undefined; remove?.() },
    async release() { release() },
  }
}

const EXECUTION_LOCK = '.core-execution-lock'

/** Core 与旧桌面 writer 共用同一协议；只读宿主不获取此锁。 */
export function acquireCoreExecutionLock(configDir: string): () => void {
  mkdirSync(configDir, { recursive: true })
  const directory = join(realpathSync(configDir), EXECUTION_LOCK)
  const owner = join(directory, 'owner')
  const alive = (pid: number): boolean => {
    try { process.kill(pid, 0); return true }
    catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH' }
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    try { mkdirSync(directory, { mode: 0o700 }) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      let pid: number
      try { pid = Number(readFileSync(owner, 'utf8')) } catch { throw new Error('Core 存储锁正在初始化或损坏，请确认没有 Core 进程后清理 .core-execution-lock') }
      if (!Number.isSafeInteger(pid) || pid < 1 || alive(pid)) throw new Error('同一配置根已有 Core 执行进程')
      const recovery = join(directory, 'recovering')
      try { writeFileSync(recovery, String(process.pid), { flag: 'wx', mode: 0o600 }) } catch { continue }
      try {
        const current = Number(readFileSync(owner, 'utf8'))
        if (!Number.isSafeInteger(current) || current < 1 || alive(current)) throw new Error('Core 存储所有权已改变')
        unlinkSync(owner)
      } finally { unlinkSync(recovery) }
      try { rmdirSync(directory) } catch { continue }
      continue
    }
    try { writeFileSync(owner, String(process.pid), { flag: 'wx', mode: 0o600 }) }
    catch (error) { try { rmdirSync(directory) } catch {} ; throw error }
    let released = false
    return () => {
      if (released) return
      released = true
      if (readFileSync(owner, 'utf8') !== String(process.pid)) return
      unlinkSync(owner); rmdirSync(directory)
    }
  }
  throw new Error('Core 存储锁竞争，请重试')
}

/** 只在已持同根执行锁的独立 Core 与同用户桌面之间传递。 */
export interface LocalCoreOwnerEndpoint {
  version: 1
  pid: number
  port: number
  coreId: string
  token: string
}

export function requireLocalCoreOwnerPlatform(): void {
  if (process.platform === 'win32') throw new Error('Windows 独立 Core 尚未完成双普通账户与成品验收；平台门禁保持关闭')
  if (process.platform !== 'darwin' && process.platform !== 'linux') throw new Error('独立本机 Core 接入仅支持 macOS 和 Linux')
}

function localCoreOwnerPath(configDir: string): string {
  requireLocalCoreOwnerPlatform()
  const root = realpathSync(configDir)
  const stat = statSync(root)
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o022)) throw new Error('Core 配置根必须由当前用户拥有且不可被其他用户写入')
  return join(root, '.core-owner.json')
}

export function publishLocalCoreOwner(configDir: string, endpoint: LocalCoreOwnerEndpoint): () => void {
  const path = localCoreOwnerPath(configDir)
  const temp = `${path}.${randomUUID()}.tmp`
  writeFileSync(temp, JSON.stringify(endpoint), { flag: 'wx', mode: 0o600 })
  try { renameSync(temp, path) } catch (error) { unlinkSync(temp); throw error }
  // 调用方须先撤下描述符，再释放同根写锁。
  return () => { unlinkSync(path) }
}

export function readLocalCoreOwner(configDir: string, options: LocalCoreOwnerOptions = {}): LocalCoreOwnerEndpoint {
  if (process.platform === 'win32') {
    requireLocalCoreOwnerPlatform()
    if (!options.runtimeDir) throw new Error('Windows 本机 Core 需要明确选择 Core 安装目录')
    return validateLocalCoreEndpoint(requestWindowsOwner(options.runtimeDir, 'read', configDir))
  }
  const path = localCoreOwnerPath(configDir)
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  let value: Partial<LocalCoreOwnerEndpoint>
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) || stat.size > 4096) throw new Error('本机 Core 连接文件权限或大小无效')
    value = JSON.parse(readFileSync(fd, 'utf8')) as Partial<LocalCoreOwnerEndpoint>
  } finally { closeSync(fd) }
  const endpoint = validateLocalCoreEndpoint(value)
  if (readFileSync(join(dirname(path), EXECUTION_LOCK, 'owner'), 'utf8') !== String(endpoint.pid)) throw new Error('本机 Core 未持有同根执行锁')
  process.kill(endpoint.pid, 0)
  return endpoint
}

export function validateLocalCoreEndpoint(candidate: unknown): LocalCoreOwnerEndpoint {
  const value = candidate as Partial<LocalCoreOwnerEndpoint> | null
  if (!value || value.version !== 1 || !Number.isSafeInteger(value.pid) || !value.pid || value.pid < 1
    || !Number.isInteger(value.port) || !value.port || value.port < 1 || value.port > 65535
    || typeof value.coreId !== 'string' || !value.coreId || typeof value.token !== 'string' || !value.token) throw new Error('本机 Core 连接文件无效')
  return { version: 1, pid: value.pid, port: value.port, coreId: value.coreId, token: value.token }
}

/** 只能请求已发现且身份匹配的本机 Core 关机。接单成功后还需等写锁释放。 */
export async function shutdownIndependentCore(configDir: string, options: LocalCoreOwnerOptions & {
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>
  timeoutMs?: number
} = {}): Promise<{ coreId: string } | null> {
  requireLocalCoreOwnerPlatform()
  let root: string
  let endpoint: LocalCoreOwnerEndpoint
  try {
    root = process.platform === 'win32' ? resolve(configDir) : realpathSync(configDir)
    endpoint = readLocalCoreOwner(root, options)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ESRCH') return null
    throw error
  }
  const timeout = options.timeoutMs ?? 10_000
  const signal = AbortSignal.timeout(timeout)
  const request = (path: '/identity' | '/connection/shutdown', method: 'GET' | 'POST') => (options.fetchImpl ?? fetch)(
    `http://127.0.0.1:${endpoint.port}${path}`,
    { method, headers: { authorization: `Bearer ${endpoint.token}` }, redirect: 'error', signal },
  )
  const identity = await request('/identity', 'GET')
  if (!identity.ok) throw new Error(`本机 Core 身份校验失败 (${identity.status})`)
  const candidate = await identity.json() as { coreId?: string } | null
  if (candidate?.coreId !== endpoint.coreId) throw new Error('本机 Core 身份与连接文件不一致')
  const response = await request('/connection/shutdown', 'POST')
  if (response.status !== 202) throw new Error(`本机 Core 拒绝停服 (${response.status})`)
  const accepted = await response.json() as { accepted?: boolean } | null
  if (accepted?.accepted !== true) throw new Error('本机 Core 未确认停服请求')

  const lock = join(root, EXECUTION_LOCK)
  while (!signal.aborted) {
    if (process.platform === 'win32') {
      const released = requestWindowsOwner(options.runtimeDir!, 'released', root, endpoint.pid)
      if (typeof released !== 'boolean') throw new Error('Windows Core helper 返回无效写锁状态')
      if (released) return { coreId: endpoint.coreId }
      await new Promise(resolveDelay => setTimeout(resolveDelay, 50))
      continue
    }
    if (!statSync(lock, { throwIfNoEntry: false })) return { coreId: endpoint.coreId }
    try {
      const pid = readFileSync(join(lock, 'owner'), 'utf8')
      if (pid !== String(endpoint.pid)) return { coreId: endpoint.coreId }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 50))
  }
  throw new Error('Core 已接受停服请求，等待释放数据写锁超时')
}

/** 本机 Core 两种启动方式共用环境白名单；不把桌面的业务配置隐式传入。 */
export function pickLocalCoreEnvironment(source: NodeJS.ProcessEnv, platform = process.platform, foldCase = platform === 'win32'): NodeJS.ProcessEnv {
  const windowsShell = ['CLAUDE_CODE_SHELL', 'PROFER_WINDOWS_SHELL', 'PROFER_WSL_DISTRO']
  const allowed = platform === 'win32'
    ? ['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', ...windowsShell]
    : ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'PROFER_ANTHROPIC_API_KEY']
  const entries = Object.entries(source)
  return Object.fromEntries(allowed.flatMap(key => {
    const entry = foldCase ? entries.find(([name]) => name.toUpperCase() === key) : [key, source[key]]
    return entry?.[1] ? [windowsShell.includes(key) ? [key, entry[1]] : entry] : []
  }))
}

/** Start only when discovery is absent/stale; never bypass a rejected owner file. */
export async function ensureIndependentOwner(configDir: string, options: LocalCoreOwnerOptions & {
  launch: () => { command: string; args: readonly string[]; cwd?: string; runtimeDir?: string }
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  cancelled?: () => boolean
  spawnImpl?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess
}): Promise<LocalCoreOwnerEndpoint> {
  const readReady = () => {
    try { return readLocalCoreOwner(configDir, options) }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ESRCH') throw error
    }
  }
  const existing = readReady()
  if (existing) return existing
  if (options.cancelled?.()) throw new Error('本机 Core 接入已取消')
  const spec = options.launch()
  const env = pickLocalCoreEnvironment(options.env ?? process.env)
  if (spec.runtimeDir) env.PROFER_CORE_RUNTIME_DIR = spec.runtimeDir
  const child = (options.spawnImpl ?? spawn)(spec.command, [...spec.args, '--desktop-independent', '--config-dir', resolve(configDir)], {
    cwd: spec.cwd, env, detached: true, stdio: 'ignore',
  })
  let launchError: Error | undefined
  child.once('error', error => { launchError = error })
  child.unref()
  // 竞争的启动进程可能先退出；等持有同根锁的一方发布入口。
  const deadline = Date.now() + (options.timeoutMs ?? 10_000)
  while (!options.cancelled?.() && Date.now() < deadline) {
    const endpoint = readReady()
    if (endpoint) return endpoint
    if (launchError) throw launchError
    await new Promise(resolveDelay => setTimeout(resolveDelay, 100))
  }
  if (options.cancelled?.()) throw new Error('本机 Core 接入已取消')
  throw new Error(`独立本机 Core 未在限定时间内发布连接入口（启动进程状态：${child.signalCode ?? child.exitCode ?? '运行中'}）`)
}
