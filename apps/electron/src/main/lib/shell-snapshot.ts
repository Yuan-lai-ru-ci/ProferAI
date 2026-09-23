import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getConfigDir } from './config-paths'
import { getShellEnv } from './shell-env'

export type ShellKind = 'bash' | 'zsh' | 'sh' | 'powershell' | 'cmd' | 'git-bash' | 'wsl'

export interface ShellDescriptor {
  kind: ShellKind
  path: string
  login: boolean
  source: 'detected' | 'configured' | 'fallback'
}

export interface ShellSnapshot {
  id: string
  sessionId: string
  cwd: string
  shell: ShellDescriptor
  env: Record<string, string>
  pathEntries: string[]
  commandPaths: Record<string, string | null>
  envHash: string
  createdAt: number
  capturedAt: number
  source: 'login-shell' | 'runtime-status' | 'process-env'
  version: 1
}

export interface CaptureShellSnapshotOptions {
  sessionId: string
  cwd: string
  platform?: NodeJS.Platform
  processEnv?: NodeJS.ProcessEnv
  shell?: ShellDescriptor
  source?: ShellSnapshot['source']
  persist?: boolean
  snapshotRoot?: string
  now?: number
  getLoginEnv?: (shellPath: string) => Promise<Record<string, string>>
}

export interface GetShellSnapshotOptions extends Omit<CaptureShellSnapshotOptions, 'persist'> {
  rebuild?: boolean
}

const SNAPSHOT_VERSION = 1 as const
const COMMANDS = ['bash', 'sh', 'bun', 'node', 'git', 'tr'] as const
const SENSITIVE_ENV_KEY = /(?:API[_-]?KEY|ACCESS[_-]?TOKEN|AUTH[_-]?TOKEN|PASSWORD|PASSWD|SECRET|PRIVATE[_-]?KEY|CREDENTIAL|COOKIE|BEARER|WEBHOOK)/i
const EXCLUDED_ENV_KEYS = new Set([
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'AWS_SECRET_ACCESS_KEY',
  'GITHUB_TOKEN',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
])
let testSnapshotRoot: string | undefined

export function __setShellSnapshotRootForTest(root: string | undefined): void {
  testSnapshotRoot = root
}

function defaultSnapshotRoot(): string {
  return join(getConfigDir(), 'shell-snapshots')
}

function snapshotPath(sessionId: string, cwd: string, shell: ShellDescriptor, root: string): string {
  const key = createHash('sha256').update(JSON.stringify({ sessionId, cwd, shell })).digest('hex')
  return join(root, `${key}.json`)
}

function getEnvValue(env: NodeJS.ProcessEnv | Record<string, string>, name: string): string | undefined {
  const found = Object.keys(env).find((key) => key.toLowerCase() === name.toLowerCase())
  return found ? env[found] : undefined
}

export function sanitizeShellEnvironment(env: NodeJS.ProcessEnv | Record<string, string | undefined>): Record<string, string> {
  const safe: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || EXCLUDED_ENV_KEYS.has(key.toUpperCase()) || SENSITIVE_ENV_KEY.test(key)) continue
    safe[key] = value
  }
  return safe
}

function inferShell(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): ShellDescriptor {
  if (platform === 'win32') {
    const systemRoot = env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows'
    return {
      kind: 'powershell',
      path: join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      login: false,
      source: 'fallback',
    }
  }

  const shellPath = getEnvValue(env, 'SHELL') ?? (platform === 'darwin' ? '/bin/zsh' : '/bin/sh')
  const name = shellPath.split(/[\\/]/).pop()?.toLowerCase()
  const kind: ShellKind = name === 'bash' ? 'bash' : name === 'zsh' ? 'zsh' : 'sh'
  return { kind, path: shellPath, login: true, source: getEnvValue(env, 'SHELL') ? 'detected' : 'fallback' }
}

function pathEntriesFor(env: Record<string, string>, platform: NodeJS.Platform): string[] {
  const path = getEnvValue(env, 'PATH') ?? ''
  return path.split(platform === 'win32' ? ';' : ':').map((entry) => entry.trim()).filter(Boolean)
}

function resolveCommandPath(command: string, entries: string[], platform: NodeJS.Platform): string | null {
  for (const entry of entries) {
    const base = join(entry, command)
    const candidates = platform === 'win32' ? [base, `${base}.exe`, `${base}.cmd`, `${base}.bat`] : [base]
    const match = candidates.find((candidate) => existsSync(candidate))
    if (match) return match
  }
  return null
}

function stableHash(input: Omit<ShellSnapshot, 'envHash' | 'id' | 'createdAt' | 'capturedAt'>): string {
  const stable = JSON.stringify({
    version: input.version,
    sessionId: input.sessionId,
    cwd: input.cwd,
    shell: input.shell,
    env: Object.fromEntries(Object.entries(input.env).sort(([a], [b]) => a.localeCompare(b))),
    pathEntries: input.pathEntries,
    commandPaths: input.commandPaths,
    source: input.source,
  })
  return createHash('sha256').update(stable).digest('hex')
}

export async function captureShellSnapshot(options: CaptureShellSnapshotOptions): Promise<ShellSnapshot> {
  const platform = options.platform ?? process.platform
  const baseEnv = options.processEnv ?? process.env
  const shell = options.shell ?? inferShell(baseEnv, platform)
  let env = sanitizeShellEnvironment(baseEnv)
  let source = options.source ?? (platform === 'win32' ? 'runtime-status' : 'process-env')

  if (platform !== 'win32' && shell.login) {
    try {
      const loginEnv = await (options.getLoginEnv ?? getShellEnv)(shell.path)
      env = sanitizeShellEnvironment({ ...baseEnv, ...loginEnv })
      source = 'login-shell'
    } catch (error) {
      console.warn(`[Shell 快照] login shell 读取失败，降级使用 process.env: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const pathEntries = pathEntriesFor(env, platform)
  const commandPaths = Object.fromEntries(COMMANDS.map((command) => [command, resolveCommandPath(command, pathEntries, platform)]))
  const now = options.now ?? Date.now()
  const payload = {
    id: randomUUID(),
    sessionId: options.sessionId,
    cwd: options.cwd,
    shell,
    env,
    pathEntries,
    commandPaths,
    createdAt: now,
    capturedAt: now,
    source,
    version: SNAPSHOT_VERSION,
  } satisfies Omit<ShellSnapshot, 'envHash'>
  const snapshot: ShellSnapshot = { ...payload, envHash: stableHash(payload) }

  if (options.persist !== false) {
    persistShellSnapshot(snapshot, options.snapshotRoot)
  }
  return snapshot
}

function isSnapshot(value: unknown): value is ShellSnapshot {
  if (!value || typeof value !== 'object') return false
  const snapshot = value as Partial<ShellSnapshot>
  return snapshot.version === SNAPSHOT_VERSION
    && typeof snapshot.id === 'string'
    && typeof snapshot.sessionId === 'string'
    && typeof snapshot.cwd === 'string'
    && !!snapshot.shell
    && typeof snapshot.envHash === 'string'
    && !!snapshot.env
    && typeof snapshot.env === 'object'
}

export function persistShellSnapshot(snapshot: ShellSnapshot, root = testSnapshotRoot ?? defaultSnapshotRoot()): boolean {
  const target = snapshotPath(snapshot.sessionId, snapshot.cwd, snapshot.shell, root)
  const temp = `${target}.${process.pid}.tmp`
  try {
    mkdirSync(root, { recursive: true })
    writeFileSync(temp, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
    renameSync(temp, target)
    return true
  } catch (error) {
    console.warn(`[Shell 快照] 写入失败，继续使用内存快照: ${error instanceof Error ? error.message : String(error)}`)
    try { if (existsSync(temp)) unlinkSync(temp) } catch { /* best effort */ }
    return false
  }
}

export async function getOrCreateShellSnapshot(options: GetShellSnapshotOptions): Promise<ShellSnapshot | undefined> {
  const root = options.snapshotRoot ?? testSnapshotRoot ?? defaultSnapshotRoot()
  const shell = options.shell ?? inferShell(options.processEnv ?? process.env, options.platform ?? process.platform)
  const path = snapshotPath(options.sessionId, options.cwd, shell, root)
  if (!options.rebuild) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
      if (isSnapshot(parsed) && parsed.sessionId === options.sessionId && parsed.cwd === options.cwd
        && parsed.envHash === stableHash(parsed)) return parsed
    } catch {
      // 首次启动、旧版本或损坏快照都走重建；不阻断 Agent turn。
    }
  }

  try {
    return await captureShellSnapshot({ ...options, shell, snapshotRoot: root, persist: true })
  } catch (error) {
    console.warn(`[Shell 快照] 创建失败，执行层将回退到临时环境: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

export async function rebuildShellSnapshot(options: GetShellSnapshotOptions): Promise<ShellSnapshot | undefined> {
  return getOrCreateShellSnapshot({ ...options, rebuild: true })
}
