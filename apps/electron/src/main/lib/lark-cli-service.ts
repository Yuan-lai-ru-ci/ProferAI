/** Secure wrapper around the official Lark CLI. OAuth credentials stay in the CLI store. */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import type { LarkCliOperationResult, LarkCliStatus, LarkDiagnostics, LarkLoginEvent, LarkLoginStartResult } from '@profer/shared'

const execFileAsync = promisify(execFile)
const COMMAND_TIMEOUT_MS = 10_000
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000
const URL_PATTERN = /https?:\/\/[^\s<>"']+/i
const SECRET_PATTERN = /(token|secret|authorization|cookie|password)[=:]\s*[^\s,;]+/gi

export interface LarkCliCommandRunner {
  exec: (command: string, args: string[], timeoutMs?: number) => Promise<{ stdout: string; stderr: string }>
  spawn: (command: string, args: string[]) => ChildProcess
}

function quoteWindowsArg(value: string): string {
  if (!/[\s"^&|<>]/.test(value)) return value
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`
}

const defaultRunner: LarkCliCommandRunner = {
  exec: async (command, args, timeoutMs = COMMAND_TIMEOUT_MS) => {
    // Node's Windows shell handling breaks absolute .cmd paths containing spaces.
    // The executable was already resolved by `where`; using its basename lets cmd
    // resolve the same trusted PATH entry without interpolating user input.
    const executable = process.platform === 'win32' && /\.(cmd|bat|ps1)$/i.test(command) ? basename(command) : command
    const result = await execFileAsync(executable, args, {
      encoding: 'utf8', timeout: timeoutMs, windowsHide: true,
      shell: process.platform === 'win32' && /\.(cmd|bat|ps1)$/i.test(command),
      maxBuffer: 1024 * 1024,
      env: getCommandEnv(),
    })
    return { stdout: result.stdout, stderr: result.stderr }
  },
  spawn: (command, args) => {
    const isWindowsScript = process.platform === 'win32' && /\.(cmd|bat|ps1)$/i.test(command)
    return spawn(isWindowsScript ? basename(command) : command, args, {
      windowsHide: true,
      shell: isWindowsScript,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: getCommandEnv(),
    })
  },
}

let runner = defaultRunner
let loginProcess: ChildProcess | null = null
let loginTimer: NodeJS.Timeout | null = null
let loginEventHandler: ((event: LarkLoginEvent) => void) | null = null

export function __setLarkCliCommandRunner(next: LarkCliCommandRunner | null): void { runner = next ?? defaultRunner }
export function __setLarkLoginEventHandler(handler: ((event: LarkLoginEvent) => void) | null): void { loginEventHandler = handler }
export function __resetLarkCliTestState(): void { disposeLarkCliService() }

function getMacToolDirectories(): string[] {
  if (process.platform !== 'darwin') return []

  const home = homedir()
  return [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    join(home, '.local', 'share', 'mise', 'shims'),
    join(home, '.local', 'share', 'mise', 'installs', 'node', 'latest', 'bin'),
    join(home, '.npm-global', 'bin'),
    join(home, '.bun', 'bin'),
  ]
}

function getFallbackCommandPaths(name: string): string[] {
  return getMacToolDirectories().map((directory) => join(directory, name))
}

function getCommandEnv(): NodeJS.ProcessEnv {
  const pathEntries = [...getMacToolDirectories(), process.env.PATH ?? '']
  return { ...process.env, PATH: [...new Set(pathEntries.filter(Boolean))].join(':') }
}

async function findCommand(name: string): Promise<string | null> {
  try {
    const { stdout } = await runner.exec(process.platform === 'win32' ? 'where.exe' : 'which', [name], 5_000)
    const candidates = stdout.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    const path = (process.platform === 'win32' ? candidates.find((line) => /\.(cmd|exe)$/i.test(line)) : candidates[0]) ?? candidates[0] ?? null
    if (path) return path
  } catch { /* GUI 启动时 PATH 可能尚未包含用户的 Node 安装目录 */ }

  const fallbackPath = getFallbackCommandPaths(name).find((path) => existsSync(path))
  if (fallbackPath) return fallbackPath

  // npm 的全局 bin 不一定是固定目录（mise、Homebrew、nvm 都可能不同）。
  // 安装后优先从 npm prefix 解析，避免只依赖 GUI 进程继承的 PATH。
  if (process.platform === 'darwin' && name === 'lark-cli') {
    const npmPath = await findCommand('npm')
    if (npmPath) {
      try {
        const { stdout } = await runner.exec(npmPath, ['prefix', '--global'])
        const globalPath = join(stdout.trim(), 'bin', name)
        if (existsSync(globalPath)) return globalPath
      } catch { /* npm prefix 不可用时保留其他检测结果 */ }
    }
  }

  return null
}

async function inspectCommand(name: string): Promise<{ available: boolean; version: string | null; path: string | null }> {
  const path = await findCommand(name)
  if (!path) return { available: false, version: null, path: null }
  try {
    const { stdout, stderr } = await runner.exec(path, ['--version'])
    const version = `${stdout}\n${stderr}`.match(/\d+\.\d+(?:\.\d+)?(?:[-+][\w.-]+)?/)?.[0] ?? null
    return { available: Boolean(version), version, path }
  } catch { return { available: false, version: null, path } }
}

export function redactLarkOutput(value: string): string { return value.replace(SECRET_PATTERN, '$1=[REDACTED]') }

export function parseLarkAuthStatus(output: string, exitCode = 0): LarkCliStatus['auth'] {
  const checkedAt = Date.now()
  try {
    const parsed = JSON.parse(output) as Record<string, unknown>
    const user = parsed.user ?? parsed.account ?? parsed.profile
    const record = user && typeof user === 'object' ? user as Record<string, unknown> : null
    const identities = parsed.identities && typeof parsed.identities === 'object' ? parsed.identities as Record<string, unknown> : null
    const userIdentity = identities?.user && typeof identities.user === 'object' ? identities.user as Record<string, unknown> : null
    const userStatus = typeof userIdentity?.status === 'string' ? userIdentity.status.toLowerCase() : ''
    const tokenStatus = typeof userIdentity?.tokenStatus === 'string' ? userIdentity.tokenStatus.toLowerCase() : ''
    const loggedIn = parsed.loggedIn === true || parsed.logged_in === true || parsed.authenticated === true || userIdentity?.available === true || userStatus === 'ready' || userStatus === 'active'
    const requiresAuth = tokenStatus === 'expired' || userStatus === 'missing' || userStatus === 'expired' || userStatus === 'reauthorization_required'
    const userLabel = typeof parsed.userLabel === 'string' ? parsed.userLabel : typeof parsed.email === 'string' ? parsed.email : typeof userIdentity?.userName === 'string' ? userIdentity.userName : typeof record?.email === 'string' ? record.email : typeof record?.name === 'string' ? record.name : null
    const scopes = parsed.scopes ?? parsed.grantedScopes ?? userIdentity?.scope
    const scopeCount = Array.isArray(scopes) ? scopes.length : typeof scopes === 'string' ? scopes.trim().split(/\s+/).filter(Boolean).length : typeof parsed.scopeCount === 'number' ? parsed.scopeCount : null
    return { state: requiresAuth || exitCode !== 0 ? 'reauthorization_required' : loggedIn ? 'logged_in' : 'logged_out', userLabel, scopeCount, checkedAt }
  } catch {
    const safeOutput = redactLarkOutput(output).toLowerCase()
    const needsAuth = /re-?author|unauthor|expired|login required|not logged|tokenstatus.*expired|status.*missing/.test(safeOutput)
    const loggedIn = /logged\s*in|authenticated|status.*ready/.test(safeOutput) && !needsAuth
    const userLabel = redactLarkOutput(output).match(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/)?.[0] ?? null
    return { state: loggedIn ? 'logged_in' : needsAuth || exitCode !== 0 ? 'reauthorization_required' : 'logged_out', userLabel, scopeCount: null, checkedAt }
  }
}

async function getAuthStatus(cliPath: string | null): Promise<LarkCliStatus['auth']> {
  if (!cliPath) return { state: 'unknown', userLabel: null, scopeCount: null, checkedAt: null }
  try { const result = await runner.exec(cliPath, ['auth', 'status']); return parseLarkAuthStatus(result.stdout, 0) }
  catch (error) { const e = error as { stdout?: string; stderr?: string; code?: number }; return parseLarkAuthStatus(`${e.stdout ?? ''}\n${e.stderr ?? ''}`, typeof e.code === 'number' ? e.code : 1) }
}

export async function detectLarkCli(): Promise<LarkCliStatus> {
  const [node, npm, npx, cli] = await Promise.all([inspectCommand('node'), inspectCommand('npm'), inspectCommand('npx'), inspectCommand('lark-cli')])
  const auth = await getAuthStatus(cli.path)
  return { node, npm, npx, cli, auth, checkedAt: Date.now(), error: !node.available || !npm.available || !npx.available ? 'Node.js/npm/npx unavailable' : !cli.available ? 'lark-cli unavailable' : null }
}

export async function installLarkCli(): Promise<LarkCliOperationResult> {
  const npm = await findCommand('npm')
  if (!npm) return { success: false, message: 'npm unavailable; install Node.js first' }
  try {
    // 使用全局安装，而不是 `npx ... install`：后者只运行一次安装向导，
    // 不会可靠地把 lark-cli 放入用户的全局 bin，GUI 启动时尤其容易表现为“安装成功但仍检测不到”。
    await runner.exec(npm, ['install', '--global', '@larksuite/cli@latest'], 5 * 60 * 1000)
    return { success: true, message: 'Official Lark CLI installed' }
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string }
    const detail = redactLarkOutput(`${e.stderr ?? ''} ${e.stdout ?? ''}`).trim()
    return { success: false, message: detail ? `Install failed: ${detail.slice(0, 300)}` : 'Official Lark CLI installation failed' }
  }
}

function emitLoginEvent(event: LarkLoginEvent): void { loginEventHandler?.(event) }
export async function startLarkLogin(): Promise<LarkLoginStartResult> {
  if (loginProcess) return { started: false, authorizationUrl: null, message: 'Login flow already running' }
  const cliPath = await findCommand('lark-cli')
  if (!cliPath) return { started: false, authorizationUrl: null, message: 'Lark CLI unavailable; install it first' }

  const child = runner.spawn(cliPath, ['auth', 'login', '--recommend'])
  loginProcess = child
  let output = ''
  const onData = (chunk: Buffer | string) => { output += chunk.toString(); const url = output.match(URL_PATTERN)?.[0]; if (url) emitLoginEvent({ type: 'url', authorizationUrl: url, message: 'Open the authorization URL to finish Lark login' }) }
  child.stdout?.on('data', onData); child.stderr?.on('data', onData)
  child.once('error', (error) => { clearLoginState(); emitLoginEvent({ type: 'failed', message: redactLarkOutput(error.message).slice(0, 300) || 'Failed to start login' }) })
  child.once('close', (code) => { clearLoginState(); emitLoginEvent(code === 0 ? { type: 'completed', message: 'Lark login completed' } : { type: 'failed', message: 'Lark login did not complete' }) })
  loginTimer = setTimeout(() => { cancelLarkLogin(); emitLoginEvent({ type: 'failed', message: 'Lark login timed out' }) }, LOGIN_TIMEOUT_MS)
  return { started: true, authorizationUrl: output.match(URL_PATTERN)?.[0] ?? null, message: 'Login flow started' }
}

function clearLoginState(): void { if (loginTimer) clearTimeout(loginTimer); loginTimer = null; loginProcess = null }
export function cancelLarkLogin(): void { const child = loginProcess; clearLoginState(); if (child && !child.killed) child.kill() }
export function getLarkDiagnostics(status: LarkCliStatus): LarkDiagnostics { return { nodeVersion: status.node.version, npmVersion: status.npm.version, npxVersion: status.npx.version, cliVersion: status.cli.version, cliPath: status.cli.path, authState: status.auth.state, userLabel: status.auth.userLabel, scopeCount: status.auth.scopeCount, checkedAt: status.checkedAt, error: status.error } }
export function disposeLarkCliService(): void { cancelLarkLogin(); loginEventHandler = null; runner = defaultRunner }
