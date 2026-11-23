import { randomUUID } from 'node:crypto'
import { accessSync, constants, realpathSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import { ensureIndependentOwner, readLocalCoreOwner, type LocalCoreOwnerOptions } from '@profer/session-store/execution-lock'
import { resolveConfigDir, type PathOptions } from './paths'

const LOCAL_CORE_PROTOCOL_VERSION = 1

function requireCompatibleLocalCoreIdentity<T extends { coreId?: string; protocolVersion?: unknown } | null>(identity: T, coreId: string): asserts identity is T & { coreId: string; protocolVersion: number } {
  if (identity?.coreId !== coreId) throw new Error('本机 Core 身份与连接文件不一致')
  if (identity.protocolVersion !== LOCAL_CORE_PROTOCOL_VERSION) throw new Error(`本机 Core 协议版本不兼容: ${String(identity.protocolVersion)}`)
}

export function resolveCoreLaunch(platform: NodeJS.Platform = process.platform, execPath = process.execPath, env = process.env) {
  const explicit = env.PROFER_CORE_BIN?.trim()
  if (explicit) {
    if (!isAbsolute(explicit)) throw new Error('PROFER_CORE_BIN 必须是绝对路径')
    return { command: explicit, args: [], runtimeDir: dirname(explicit) }
  }
  const executable = platform === 'win32' ? 'profer-core.exe' : 'profer-core'
  const adjacent = join(dirname(realpathSync(execPath)), executable)
  // Windows helper 的安装选择不能被 PATH 中同名文件劫持；POSIX 保留既有 CLI 用法。
  const candidates = platform === 'win32' ? [adjacent]
    : [adjacent, ...(env.PATH ?? '').split(delimiter).filter(isAbsolute).map(dir => join(dir, executable))]
  for (const command of candidates) {
    try { accessSync(command, constants.X_OK); return { command, args: [], runtimeDir: dirname(command) } } catch {}
  }
  throw new Error('未找到 profer-core；请安装 Core 或设置 PROFER_CORE_BIN')
}

/** Windows 的 status/stop 也必须明确同一 Core 安装，但绝不启动它。 */
export function localCoreOwnerOptions(): LocalCoreOwnerOptions {
  return process.platform === 'win32' ? { runtimeDir: resolveCoreLaunch().runtimeDir } : {}
}

export async function connectLocalCore(pathOpts: PathOptions, options: { autoStart?: boolean } = {}) {
  const configDir = resolveConfigDir(pathOpts)
  const ownerOptions = localCoreOwnerOptions()
  const { port, token, coreId } = options.autoStart
    ? await ensureIndependentOwner(configDir, { ...ownerOptions, launch: resolveCoreLaunch })
    : readLocalCoreOwner(configDir, ownerOptions)
  const baseUrl = `http://127.0.0.1:${port}`
  const request = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers)
    headers.set('authorization', `Bearer ${token}`)
    const response = await fetch(`${baseUrl}${path}`, { ...init, headers, redirect: 'error' })
    if (!response.ok) {
      const detail = await response.json().catch(() => null) as { error?: unknown } | null
      throw new Error(`本机 Core ${path} 请求失败 (${response.status})${typeof detail?.error === 'string' ? `：${detail.error}` : ''}`)
    }
    return response
  }
  const json = async <T>(path: string, body?: object, signal = AbortSignal.timeout(5000)): Promise<T> => {
    const response = await request(path, body === undefined ? { signal } : {
      signal, method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    return response.json() as Promise<T>
  }
  const identity = await json<{ coreId?: string; version?: string; protocolVersion?: number; platform?: string } | null>('/identity')
  requireCompatibleLocalCoreIdentity(identity, coreId)
  const command = (input: object, signal?: AbortSignal): Promise<unknown> => new Promise((resolve, reject) => {
    const stop = signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000)
    if (stop.aborted) { reject(stop.reason); return }
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { protocols: ['profer.v1'], headers: { authorization: `Bearer ${token}` } })
    const id = randomUUID()
    const finish = (error?: Error, result?: unknown) => {
      stop.removeEventListener('abort', abort)
      if (error) reject(error)
      else resolve(result)
      socket.close()
    }
    const abort = () => finish(new Error('Core 操作未确认'))
    stop.addEventListener('abort', abort, { once: true })
    socket.addEventListener('open', () => socket.send(JSON.stringify({ ...input, _cmdId: id })), { once: true })
    socket.addEventListener('message', event => {
      let frame: { kind?: string; commandId?: string; ok?: boolean; data?: unknown; error?: string }
      try { frame = JSON.parse(String(event.data)) } catch { finish(new Error('Core 操作返回无效消息')); return }
      if (frame.kind !== 'command_result' || frame.commandId !== id) return
      if (frame.ok) finish(undefined, frame.data)
      else finish(new Error(frame.error ?? 'Core 操作失败'))
    })
    socket.addEventListener('error', () => finish(new Error('Core 操作连接失败')), { once: true })
    socket.addEventListener('close', () => finish(new Error('Core 操作连接已关闭')), { once: true })
  })
  return { identity: { coreId, version: identity.version, protocolVersion: identity.protocolVersion, platform: identity.platform }, json, request, command }
}
