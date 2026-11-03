import { existsSync } from 'node:fs'
import { delimiter, dirname, join, win32 } from 'node:path'
import type { RuntimeStatus } from '@profer/shared'

export type AgentRuntimeShellKind = 'posix' | 'git-bash' | 'wsl'

export interface AgentRuntimeEnv {
  env: Record<string, string>
  shellKind?: AgentRuntimeShellKind
  shellPath?: string
  wslCommand?: string
  wslDistro?: string
}

const PROXY_ENV_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY'] as const
const CASE_INSENSITIVE_MERGE_KEYS = new Set([
  'path',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
  'profer_cli',
  'claude_code_shell',
  'shell',
  'profer_windows_shell',
  'profer_wsl_distro',
])

function getCaseInsensitiveEnvValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const exact = env[key]
  if (exact) return exact
  const foundKey = Object.keys(env).find((name) => name.toLowerCase() === key.toLowerCase())
  const value = foundKey ? env[foundKey] : undefined
  return value || undefined
}

function getPathKey(env: NodeJS.ProcessEnv): string {
  return Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH'
}

function hasPathEntry(entries: string[], entry: string, platform: NodeJS.Platform): boolean {
  if (platform === 'win32') {
    const normalizedEntry = entry.toLowerCase()
    return entries.some((item) => item.toLowerCase() === normalizedEntry)
  }
  return entries.includes(entry)
}

export function prependPathEntry(
  currentPath: string | undefined,
  entry: string | undefined,
  pathDelimiter: string,
  platform: NodeJS.Platform,
): string | undefined {
  const entries = (currentPath ?? '').split(pathDelimiter).filter(Boolean)
  if (!entry) return entries.join(pathDelimiter) || undefined
  if (hasPathEntry(entries, entry, platform)) return entries.join(pathDelimiter) || entry
  return [entry, ...entries].join(pathDelimiter)
}

export function dirnameForPlatform(path: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? win32.dirname(path) : dirname(path)
}

/**
 * 解析 Agent Bash 的 POSIX 执行路径。
 *
 * 环境加载 shell 与 Agent Bash 执行 shell 必须分离：macOS 用户默认 shell
 * 通常是 zsh，但 Bash 工具的语义应保持 Bash。Codex/Profer 都采用“用用户
 * shell 准备环境、用确定的 Bash 执行命令”的边界，避免把 zsh glob/options
 * 隐式带进名为 Bash 的工具。
 *
 * 只返回经过存在性校验的绝对路径，避免 GUI 进程的 PATH 或失效 SHELL 配置
 * 把 child_process.spawn 的真实错误压扁成难以诊断的 ENOENT。
 */
export function resolvePosixShellPath(
  processEnv: NodeJS.ProcessEnv,
  _platform: NodeJS.Platform,
  pathDelimiter: string,
  pathExists: (path: string) => boolean = existsSync,
): string | undefined {
  const pathKey = getPathKey(processEnv)
  const candidates = ['/bin/bash', '/usr/bin/bash']

  for (const directory of (processEnv[pathKey] ?? '').split(pathDelimiter)) {
    const trimmedDirectory = directory.trim()
    if (trimmedDirectory) candidates.push(join(trimmedDirectory, 'bash'))
  }

  return candidates.find(pathExists)
}

function collectProxyEnv(proxyUrl: string | undefined, processEnv: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {}
  const trimmedProxyUrl = proxyUrl?.trim()
  const setProxyEnv = (key: string, value: string): void => {
    env[key] = value
    env[key.toLowerCase()] = value
  }

  if (trimmedProxyUrl) {
    for (const key of PROXY_ENV_KEYS) {
      setProxyEnv(key, trimmedProxyUrl)
    }
  } else {
    for (const key of PROXY_ENV_KEYS) {
      const value = getCaseInsensitiveEnvValue(processEnv, key)
      if (value) setProxyEnv(key, value)
    }
  }

  const noProxy = getCaseInsensitiveEnvValue(processEnv, 'NO_PROXY')
  if (noProxy) setProxyEnv('NO_PROXY', noProxy)

  return env
}

function getWslCommandPath(
  processEnv: NodeJS.ProcessEnv,
  pathExists: (path: string) => boolean,
): string {
  const systemRoot = processEnv.SystemRoot ?? processEnv.SYSTEMROOT ?? processEnv.windir ?? processEnv.WINDIR
  const candidates = systemRoot
    ? [
        join(systemRoot, 'System32', 'wsl.exe'),
        join(systemRoot, 'Sysnative', 'wsl.exe'),
      ]
    : []

  return candidates.find(pathExists) ?? 'wsl.exe'
}

function collectWindowsShellEnv(
  runtimeStatus: RuntimeStatus | null | undefined,
  processEnv: NodeJS.ProcessEnv,
  pathExists: (path: string) => boolean,
  shellPreference?: 'auto' | 'git-bash' | 'wsl',
): Omit<AgentRuntimeEnv, 'env'> & { env: Record<string, string> } {
  const shellStatus = runtimeStatus?.shell
  const env: Record<string, string> = {}
  const pref = shellPreference ?? 'auto'

  // 用户明确偏好 + 该 shell 可用 → 直接使用，无需 fallback
  if (pref === 'git-bash' && shellStatus?.gitBash.available && shellStatus.gitBash.path) {
    const shellPath = shellStatus.gitBash.path
    env.PROFER_WINDOWS_SHELL = 'git-bash'
    env.CLAUDE_CODE_SHELL = shellPath
    env.SHELL = shellPath
    return { env, shellKind: 'git-bash', shellPath }
  }

  if (pref === 'wsl' && shellStatus?.wsl.available) {
    const wslCommand = getWslCommandPath(processEnv, pathExists)
    env.PROFER_WINDOWS_SHELL = 'wsl'
    env.CLAUDE_CODE_SHELL = wslCommand
    env.SHELL = wslCommand
    if (shellStatus.wsl.defaultDistro) {
      env.PROFER_WSL_DISTRO = shellStatus.wsl.defaultDistro
    }
    return { env, shellKind: 'wsl', wslCommand, ...(shellStatus.wsl.defaultDistro && { wslDistro: shellStatus.wsl.defaultDistro }) }
  }

  // 用户指定了 shell 但该 shell 不可用 → 仍然先尝试用户偏好，然后 fallback
  // 'auto' 模式或 fallback：优先 Git Bash > WSL
  if (pref === 'auto' || pref === 'git-bash') {
    if (shellStatus?.gitBash.available && shellStatus.gitBash.path) {
      const shellPath = shellStatus.gitBash.path
      env.PROFER_WINDOWS_SHELL = 'git-bash'
      env.CLAUDE_CODE_SHELL = shellPath
      env.SHELL = shellPath
      return { env, shellKind: 'git-bash', shellPath }
    }
  }

  if (pref === 'auto' || pref === 'wsl') {
    if (shellStatus?.wsl.available) {
      const wslCommand = getWslCommandPath(processEnv, pathExists)
      env.PROFER_WINDOWS_SHELL = 'wsl'
      env.CLAUDE_CODE_SHELL = wslCommand
      env.SHELL = wslCommand
      if (shellStatus.wsl.defaultDistro) {
        env.PROFER_WSL_DISTRO = shellStatus.wsl.defaultDistro
      }
      return { env, shellKind: 'wsl', wslCommand, ...(shellStatus.wsl.defaultDistro && { wslDistro: shellStatus.wsl.defaultDistro }) }
    }
  }

  return { env }
}

export function mergeRuntimeEnv(
  baseEnv: NodeJS.ProcessEnv | Record<string, string | undefined> | undefined,
  overrideEnv: Record<string, string | undefined> | undefined,
): Record<string, string> {
  const merged: Record<string, string> = {}
  const overrideLowerKeys = new Set(Object.keys(overrideEnv ?? {}).map((key) => key.toLowerCase()))

  for (const [key, value] of Object.entries(baseEnv ?? {})) {
    if (value !== undefined) merged[key] = value
  }

  for (const existingKey of Object.keys(merged)) {
    const lowerKey = existingKey.toLowerCase()
    if (overrideLowerKeys.has(lowerKey) && CASE_INSENSITIVE_MERGE_KEYS.has(lowerKey)) {
      delete merged[existingKey]
    }
  }

  for (const [key, value] of Object.entries(overrideEnv ?? {})) {
    if (value === undefined) continue
    merged[key] = value
  }

  return merged
}
