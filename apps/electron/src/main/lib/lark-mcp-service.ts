import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'
import { basename, join } from 'node:path'
import { getConfigDir, getWorkspaceMcpPath } from './config-paths'
import { decryptToken, encryptToken } from './token-crypto'
import { getWorkspaceMcpConfig, listAgentWorkspaces, saveWorkspaceMcpConfig } from './agent-workspace-manager'
import type { LarkLoginEvent, LarkLoginStartResult, LarkMcpCredentialsInput, LarkMcpSetupResult, LarkMcpStatus, McpServerEntry } from '@profer/shared'

const CONFIG_FILE_NAME = 'lark-mcp.enc.json'
export const LARK_MCP_SERVER_NAME = 'lark-mcp'
// Official lark-mcp reads these names when explicit -a/-s arguments are absent.
const LARK_MCP_ENV_APP_ID = 'APP_ID'
const LARK_MCP_ENV_APP_SECRET = 'APP_SECRET'
// Keep the preset list explicit: the calendar toolset is required for user-requested
// schedule reads/writes and still runs under the user's OAuth identity.
export const LARK_MCP_TOOL_PRESETS = 'preset.light,preset.doc.default,preset.base.default,preset.base.batch,preset.calendar.default'
const LEGACY_LARK_MCP_TOOL_PRESETS = 'preset.light,preset.doc.default,preset.base.default,preset.base.batch'
const LOGIN_TIMEOUT_MS = 90 * 1000
const CONNECTION_TEST_TIMEOUT_MS = 20 * 1000
const URL_PATTERN = /https?:\/\/[^\s<>"']+/ig
const SECRET_PATTERN = /(token|secret|authorization|cookie|password)[=:]\s*[^\s,;]+/gi

let loginProcess: ChildProcess | null = null
let loginTimer: NodeJS.Timeout | null = null
let loginGeneration = 0
let loginEventHandler: ((event: LarkLoginEvent) => void) | null = null

interface StoredLarkMcpCredentials {
  version: 1 | 2
  appId: string
  encryptedAppSecret: string
  configuredAt: number
  /** Private main-process binding; not persisted to workspace mcp.json. */
  enabledWorkspaceSlugs?: string[]
}

function credentialsPath(): string { return join(getConfigDir(), CONFIG_FILE_NAME) }

function redact(value: string): string { return value.replace(SECRET_PATTERN, '$1=[REDACTED]') }
function emitLoginEvent(event: LarkLoginEvent): void { loginEventHandler?.(event) }
function clearLoginState(): void {
  if (loginTimer) clearTimeout(loginTimer)
  loginTimer = null
  loginProcess = null
}

function readStoredCredentials(): StoredLarkMcpCredentials | null {
  const path = credentialsPath()
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<StoredLarkMcpCredentials>
    if ((parsed.version !== 1 && parsed.version !== 2) || typeof parsed.appId !== 'string' || typeof parsed.encryptedAppSecret !== 'string' || typeof parsed.configuredAt !== 'number') return null
    if (parsed.enabledWorkspaceSlugs !== undefined && (!Array.isArray(parsed.enabledWorkspaceSlugs) || !parsed.enabledWorkspaceSlugs.every((slug) => typeof slug === 'string'))) return null
    return parsed as StoredLarkMcpCredentials
  } catch { return null }
}

function writeStoredCredentials(stored: StoredLarkMcpCredentials): void {
  writeFileSync(credentialsPath(), `${JSON.stringify(stored, null, 2)}\n`, 'utf8')
}

function getEnabledWorkspaceSlugs(stored: StoredLarkMcpCredentials | null): string[] {
  return [...new Set(stored?.enabledWorkspaceSlugs?.filter(Boolean) ?? [])]
}

function isKnownWorkspaceSlug(workspaceSlug: string): boolean {
  return listAgentWorkspaces().some((workspace) => workspace.slug === workspaceSlug)
}

function persistWorkspaceBinding(workspaceSlug: string, enabled: boolean): void {
  const stored = readStoredCredentials()
  if (!stored) throw new Error('Lark MCP credentials unavailable')
  const slugs = new Set(getEnabledWorkspaceSlugs(stored))
  if (enabled) slugs.add(workspaceSlug)
  else slugs.delete(workspaceSlug)
  writeStoredCredentials({ ...stored, version: 2, enabledWorkspaceSlugs: [...slugs] })
}

function managedEntry(): McpServerEntry {
  return {
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@larksuiteoapi/lark-mcp', 'mcp', '--oauth', '--token-mode', 'user_access_token', '--tools', LARK_MCP_TOOL_PRESETS],
    enabled: true,
    isBuiltin: true,
    timeout: 45,
  }
}

function backupPath(mcpPath: string): string { return `${mcpPath}.lark-mcp-backup-${Date.now()}` }

export function getLarkMcpStatus(): LarkMcpStatus {
  const stored = readStoredCredentials()
  const knownWorkspaces = new Set(listAgentWorkspaces().map((workspace) => workspace.slug))
  const enabledWorkspaces = getEnabledWorkspaceSlugs(stored).filter((slug) => knownWorkspaces.has(slug))
  return { configured: Boolean(stored), appId: stored?.appId ?? null, configuredAt: stored?.configuredAt ?? null, enabledWorkspaces }
}

export function saveLarkMcpCredentials(input: LarkMcpCredentialsInput): LarkMcpSetupResult {
  const appId = input.appId.trim()
  const appSecret = input.appSecret.trim()
  if (!/^cli_[A-Za-z0-9]+$/.test(appId)) return { success: false, message: 'App ID format invalid' }
  if (!appSecret) return { success: false, message: 'App Secret is required' }
  try {
    const encryptedAppSecret = encryptToken(appSecret)
    // token-crypto supports a legacy plaintext fallback for old app data. New MCP
    // credentials must never opt into that fallback because they are app secrets.
    if (!encryptedAppSecret || encryptedAppSecret === appSecret) {
      return { success: false, message: 'Secure system encryption is unavailable; MCP credentials were not saved' }
    }
    const previous = readStoredCredentials()
    const stored: StoredLarkMcpCredentials = {
      version: 2,
      appId,
      encryptedAppSecret,
      configuredAt: Date.now(),
      // Replacing credentials should not silently enable an unrelated workspace,
      // but preserve intentional existing bindings for credential rotation.
      enabledWorkspaceSlugs: getEnabledWorkspaceSlugs(previous),
    }
    writeStoredCredentials(stored)
    return { success: true, message: 'Lark MCP credentials saved securely' }
  } catch { return { success: false, message: 'Unable to save Lark MCP credentials' } }
}

export function __setLarkMcpLoginEventHandler(handler: ((event: LarkLoginEvent) => void) | null): void { loginEventHandler = handler }

export function getLarkMcpRuntimeEnv(): Record<string, string> | null {
  const stored = readStoredCredentials()
  if (!stored) return null
  try {
    const appSecret = decryptToken(stored.encryptedAppSecret)
    if (!appSecret) return null
    return { [LARK_MCP_ENV_APP_ID]: stored.appId, [LARK_MCP_ENV_APP_SECRET]: appSecret }
  } catch { return null }
}

function managedArgs(toolPresets: string): string[] {
  return ['-y', '@larksuiteoapi/lark-mcp', 'mcp', '--oauth', '--token-mode', 'user_access_token', '--tools', toolPresets]
}

function isManagedLarkMcpEntry(name: string, entry: McpServerEntry, toolPresets: string): boolean {
  const expectedArgs = managedArgs(toolPresets)
  // A short-lived development build wrote each tool preset as its own argument.
  // lark-mcp accepts exactly one value after --tools, so preserve recognition of
  // that entry and normalize it before launching the server.
  const legacySplitArgs = [...expectedArgs.slice(0, -1), ...toolPresets.split(',')]
  const hasExpectedArgs = entry.args?.length === expectedArgs.length
    && entry.args.every((argument, index) => argument === expectedArgs[index]) === true
  const hasLegacySplitArgs = entry.args?.length === legacySplitArgs.length
    && entry.args.every((argument, index) => argument === legacySplitArgs[index]) === true
  return name === LARK_MCP_SERVER_NAME
    && entry.isBuiltin === true
    && entry.type === 'stdio'
    && entry.command === 'npx'
    && (hasExpectedArgs || hasLegacySplitArgs)
}

export function isLarkMcpEntry(name: string, entry: McpServerEntry): boolean {
  // Keep recognizing the previous managed entry so existing workspaces receive
  // credentials immediately; re-enabling upgrades its preset list to calendar.
  return isManagedLarkMcpEntry(name, entry, LARK_MCP_TOOL_PRESETS)
    || isManagedLarkMcpEntry(name, entry, LEGACY_LARK_MCP_TOOL_PRESETS)
}

export function getLarkMcpEntryWithRuntimeEnv(workspaceSlug: string, entry: McpServerEntry): McpServerEntry | null {
  if (!isLarkMcpEntry(LARK_MCP_SERVER_NAME, entry)) return entry
  const stored = readStoredCredentials()
  if (!getEnabledWorkspaceSlugs(stored).includes(workspaceSlug)) return null
  const env = getLarkMcpRuntimeEnv()
  if (!env) return null
  // Always launch a canonical argument list. This both protects old split-preset
  // workspace configs and prevents the CLI treating extra preset values as args.
  return { ...entry, args: managedArgs(LARK_MCP_TOOL_PRESETS), env: { ...entry.env, ...env } }
}

export function enableLarkMcpForWorkspace(workspaceSlug: string): LarkMcpSetupResult {
  if (!isKnownWorkspaceSlug(workspaceSlug)) return { success: false, message: 'Workspace not found' }
  if (!getLarkMcpRuntimeEnv()) return { success: false, message: 'Configure Lark MCP App ID and App Secret first' }
  const mcpPath = getWorkspaceMcpPath(workspaceSlug)
  const hadOriginal = existsSync(mcpPath)
  const backup = hadOriginal ? backupPath(mcpPath) : null
  try {
    if (backup) renameSync(mcpPath, backup)
    const config = hadOriginal ? JSON.parse(readFileSync(backup!, 'utf8')) : { servers: {} }
    const servers = config.servers && typeof config.servers === 'object' ? config.servers : {}
    if (servers[LARK_MCP_SERVER_NAME] && !isLarkMcpEntry(LARK_MCP_SERVER_NAME, servers[LARK_MCP_SERVER_NAME] as McpServerEntry)) {
      throw new Error('An unrelated lark-mcp entry already exists')
    }
    servers[LARK_MCP_SERVER_NAME] = managedEntry()
    saveWorkspaceMcpConfig(workspaceSlug, { ...config, servers })
    persistWorkspaceBinding(workspaceSlug, true)
    if (backup && existsSync(backup)) unlinkSync(backup)
    return { success: true, message: 'Official Lark MCP enabled for this workspace', workspaceSlug }
  } catch (error) {
    try {
      if (existsSync(mcpPath)) unlinkSync(mcpPath)
      if (backup && existsSync(backup)) renameSync(backup, mcpPath)
    } catch { /* preserve the original failure */ }
    return { success: false, message: error instanceof Error ? error.message : 'Unable to enable Lark MCP' }
  }
}

export async function testLarkMcpConnection(): Promise<LarkMcpSetupResult> {
  const env = getLarkMcpRuntimeEnv()
  if (!env) return { success: false, message: 'Configure Lark MCP App ID and App Secret first' }

  return await new Promise((resolve) => {
    const command = process.platform === 'win32' ? 'npx.cmd' : 'npx'
    const child = spawn(process.platform === 'win32' ? basename(command) : command, [
      '-y', '@larksuiteoapi/lark-mcp', 'mcp', '--oauth', '--token-mode', 'user_access_token', '--tools', LARK_MCP_TOOL_PRESETS,
    ], {
      env: { ...process.env, ...env },
      windowsHide: true,
      shell: process.platform === 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let settled = false
    let output = ''
    const finish = (success: boolean, message: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (!child.killed) child.kill()
      resolve({ success, message: redact(message).slice(0, 300) })
    }
    const timeout = setTimeout(() => finish(false, 'Lark MCP connection test timed out'), CONNECTION_TEST_TIMEOUT_MS)
    const onData = (chunk: Buffer | string): void => { output += chunk.toString() }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.once('error', (error) => finish(false, error.message || 'Unable to start Lark MCP'))
    child.once('close', (code) => {
      if (!settled) finish(false, code === 0 ? 'Lark MCP stopped before responding to the handshake' : 'Lark MCP failed to start; check the App ID, App Secret, network, and app permissions')
    })
    child.stdin?.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'Profer connection test', version: '1.0.0' } },
    })}\n`)
    child.stdout?.on('data', () => {
      if (!output.includes('"id":1')) return
      try {
        const response = JSON.parse(output.split(/\r?\n/).find((line) => line.includes('"id":1')) ?? '{}') as { result?: { serverInfo?: { name?: string } } }
        if (response.result?.serverInfo?.name) finish(true, `Official Lark MCP handshake succeeded (${response.result.serverInfo.name})`)
      } catch { /* wait for additional framed output or timeout */ }
    })
  })
}

export function startLarkMcpLogin(): LarkLoginStartResult {
  if (loginProcess) return { started: false, authorizationUrl: null, message: 'Lark MCP OAuth login is already running' }
  const env = getLarkMcpRuntimeEnv()
  if (!env) return { started: false, authorizationUrl: null, message: 'Configure Lark MCP App ID and App Secret first' }
  const generation = ++loginGeneration

  // Pass credentials via the child environment rather than CLI args: this prevents
  // the App Secret appearing in process command lines, shell history, or diagnostics.
  const command = process.platform === 'win32' ? 'npx.cmd' : 'npx'
  const child = spawn(process.platform === 'win32' ? basename(command) : command, ['-y', '@larksuiteoapi/lark-mcp', 'login'], {
    env: { ...process.env, ...env },
    windowsHide: true,
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  loginProcess = child
  let output = ''
  let emittedUrl: string | null = null
  const onData = (chunk: Buffer | string): void => {
    output += chunk.toString()
    // The official CLI prints callback and console URLs before the actual OAuth
    // URL. It also opens the real authorization URL itself, so expose the last
    // URL only after the output has progressed to the authorization line.
    if (!/authorization url/i.test(output)) return
    const urls = output.match(URL_PATTERN) ?? []
    const url = urls[urls.length - 1]
    if (url && url !== emittedUrl) {
      emittedUrl = url
      emitLoginEvent({ type: 'url', authorizationUrl: url, message: '在浏览器中完成 Lark MCP 用户授权' })
    }
  }
  child.stdout?.on('data', onData)
  child.stderr?.on('data', onData)
  child.once('error', (error) => {
    if (generation !== loginGeneration) return
    clearLoginState()
    emitLoginEvent({ type: 'failed', message: redact(error.message).slice(0, 300) || '无法启动 Lark MCP OAuth 登录' })
  })
  child.once('close', (code) => {
    if (generation !== loginGeneration) return
    clearLoginState()
    emitLoginEvent(code === 0
      ? { type: 'completed', message: 'Lark MCP 用户授权已完成' }
      : { type: 'failed', message: 'Lark MCP 用户授权未完成；请检查应用回调地址、权限与网络' })
  })
  loginTimer = setTimeout(() => {
    if (generation !== loginGeneration) return
    cancelLarkMcpLogin()
    emitLoginEvent({ type: 'failed', message: 'Lark MCP 用户授权超时，请重试' })
  }, LOGIN_TIMEOUT_MS)
  return { started: true, authorizationUrl: null, message: 'Lark MCP OAuth 登录已启动' }
}

export function cancelLarkMcpLogin(): void {
  const child = loginProcess
  // Invalidate all pending process callbacks before killing the child. Otherwise a
  // Windows shell close event can turn an intentional cancel into a false failure.
  loginGeneration += 1
  clearLoginState()
  if (child && !child.killed) child.kill()
}

export function disposeLarkMcpService(): void {
  cancelLarkMcpLogin()
  loginEventHandler = null
}

export function disableLarkMcpForWorkspace(workspaceSlug: string): LarkMcpSetupResult {
  if (!isKnownWorkspaceSlug(workspaceSlug)) return { success: false, message: 'Workspace not found' }
  const config = getWorkspaceMcpConfig(workspaceSlug)
  const current = config.servers[LARK_MCP_SERVER_NAME]
  if (!current) {
    try {
      persistWorkspaceBinding(workspaceSlug, false)
      return { success: true, message: 'Lark MCP is not enabled for this workspace', workspaceSlug }
    } catch { return { success: false, message: 'Unable to clear the Lark MCP workspace binding' } }
  }
  if (!isLarkMcpEntry(LARK_MCP_SERVER_NAME, current)) return { success: false, message: 'Existing lark-mcp entry is not managed by Profer' }
  try {
    const servers = { ...config.servers }
    delete servers[LARK_MCP_SERVER_NAME]
    saveWorkspaceMcpConfig(workspaceSlug, { ...config, servers })
    try {
      persistWorkspaceBinding(workspaceSlug, false)
    } catch (error) {
      // Do not leave a file/config binding disagreement if the private state
      // cannot be written after the workspace file was changed.
      saveWorkspaceMcpConfig(workspaceSlug, config)
      throw error
    }
    return { success: true, message: 'Lark MCP disabled for this workspace', workspaceSlug }
  } catch { return { success: false, message: 'Unable to disable Lark MCP' } }
}
