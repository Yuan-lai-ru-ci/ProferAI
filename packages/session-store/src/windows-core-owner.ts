import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import type { LocalCoreOwnerEndpoint } from './execution-lock'

const HELPER_NAME = 'profer-core-owner.exe'
const MAX_FRAME_BYTES = 16_384
const HELPER_TIMEOUT_MS = 5_000
const failureCodes = new Set(['ENOENT', 'ESRCH', 'BUSY', 'UNSAFE', 'PROTOCOL', 'IO'])

function failure(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code })
}

/** 安装由宿主明确选择；绝不从 PATH、cwd 或用户配置目录搜索 helper。 */
export function resolveWindowsOwnerHelper(runtimeDir: string | undefined, arch = process.arch): string {
  if (!runtimeDir) throw failure('EHELPER', 'Windows 本机 Core 需要明确选择 Core 安装目录')
  if (!isAbsolute(runtimeDir)) throw failure('EHELPER', 'Core 安装目录必须是绝对路径')
  let root: string
  let manifest: { format?: unknown; platform?: unknown; arch?: unknown; ownerHelper?: { executable?: unknown; protocol?: unknown } }
  try {
    root = realpathSync(runtimeDir)
    manifest = JSON.parse(readFileSync(join(root, 'core-runtime.json'), 'utf8'))
  } catch { throw failure('EHELPER', '缺少 Windows Core 安装清单或清单无效') }
  if (manifest?.format !== 1 || manifest.platform !== 'win32' || manifest.arch !== arch) throw failure('EHELPER', 'Core 安装平台或架构不匹配')
  if (manifest.ownerHelper?.executable !== HELPER_NAME || manifest.ownerHelper.protocol !== 1) throw failure('EHELPER', 'Windows Core helper 协议不匹配')
  const path = join(root, HELPER_NAME)
  try {
    const file = lstatSync(path)
    if (!file.isFile() || file.isSymbolicLink() || file.size === 0) throw new Error('invalid helper')
  } catch { throw failure('EHELPER', '缺少 Windows Core 原生 helper 或文件无效') }
  return path
}

export function decodeOwnerResponse(line: string): unknown {
  let value: { version?: unknown; ok?: unknown; data?: unknown; code?: unknown }
  try { value = JSON.parse(line) } catch { throw failure('PROTOCOL', 'Windows Core helper 返回无效协议') }
  if (!value || value.version !== 1 || typeof value.ok !== 'boolean') throw failure('PROTOCOL', 'Windows Core helper 返回无效协议')
  if (value.ok) return value.data
  if (typeof value.code !== 'string' || !failureCodes.has(value.code)) throw failure('PROTOCOL', 'Windows Core helper 返回无效协议')
  const messages: Record<string, string> = {
    ENOENT: '未发现本机 Core 连接文件', ESRCH: '本机 Core 已退出', BUSY: '同一配置根已有 Core 执行进程或正在初始化',
    UNSAFE: 'Windows Core 配置根、写锁或连接文件未通过安全校验', PROTOCOL: 'Windows Core helper 协议不匹配', IO: 'Windows Core 原生文件操作失败',
  }
  throw failure(value.code, messages[value.code]!)
}

interface OwnerRequest {
  version: 1
  op: 'read' | 'hold' | 'publish' | 'remove' | 'released' | 'release'
  root: string
  pid?: number
  endpoint?: LocalCoreOwnerEndpoint
}

function frame(request: OwnerRequest): string {
  const value = JSON.stringify(request) + '\n'
  if (Buffer.byteLength(value) > MAX_FRAME_BYTES) throw failure('PROTOCOL', 'Windows Core helper 请求过大')
  return value
}

export function verifyWindowsOwnerBinary(bytes: Buffer): void {
  if (bytes.length < 64 || bytes.toString('ascii', 0, 2) !== 'MZ') throw failure('EHELPER', 'Core helper 不是有效 PE 文件')
  const offset = bytes.readUInt32LE(60)
  if (offset > bytes.length - 6 || bytes.toString('ascii', offset, offset + 4) !== 'PE\0\0') throw failure('EHELPER', 'Core helper PE 头无效')
  if (bytes.readUInt16LE(offset + 4) !== 0x8664) throw failure('EHELPER', 'Core helper 架构必须为 x64')
}

function verifiedHelper(runtimeDir: string): string {
  const path = resolveWindowsOwnerHelper(runtimeDir)
  verifyWindowsOwnerBinary(readFileSync(path))
  const result = spawnSync(path, ['--protocol-version'], { encoding: 'utf8', windowsHide: true, timeout: HELPER_TIMEOUT_MS, maxBuffer: MAX_FRAME_BYTES })
  if (result.error || result.status !== 0 || result.stdout.trim() !== 'profer-core-owner/1') throw failure('EHELPER', 'Windows Core helper 无法运行或协议不匹配')
  return path
}

/** 同步一次性请求保留已有只读 API；凭据仅走受控标准流。 */
export function requestWindowsOwner(runtimeDir: string, op: 'read' | 'released', root: string, pid?: number): unknown {
  const helper = verifiedHelper(runtimeDir)
  const result = spawnSync(helper, [], {
    input: frame({ version: 1, op, root: resolve(root), ...(pid === undefined ? {} : { pid }) }),
    encoding: 'utf8', windowsHide: true, timeout: HELPER_TIMEOUT_MS, maxBuffer: MAX_FRAME_BYTES,
  })
  if (result.error || result.signal || !result.stdout.trim()) throw failure('EHELPER', 'Windows Core helper 未完成操作')
  const lines = result.stdout.trim().split('\n')
  if (lines.length !== 1) throw failure('PROTOCOL', 'Windows Core helper 返回无效协议')
  const data = decodeOwnerResponse(lines[0]!)
  if (result.status !== 0) throw failure('EHELPER', 'Windows Core helper 异常退出')
  return data
}

export interface WindowsCoreOwnerLease {
  publish(endpoint: LocalCoreOwnerEndpoint): Promise<void>
  remove(): Promise<void>
  release(): Promise<void>
}

/** helper 持有原生句柄直至业务 Core 收尾；意外失锁必须立即终止 writer。 */
export async function holdWindowsCoreOwner(runtimeDir: string, root: string, onLockLost: () => void): Promise<WindowsCoreOwnerLease> {
  const child: ChildProcessWithoutNullStreams = spawn(verifiedHelper(runtimeDir), [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  let buffer = Buffer.alloc(0)
  let pending: { op: OwnerRequest['op']; resolve: (data: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | undefined
  let held = false
  let released = false
  let failed: Error | undefined
  let queue: Promise<unknown> = Promise.resolve()
  let releasePromise: Promise<void> | undefined
  const fail = (error: Error) => {
    if (failed) return
    failed = error
    if (pending) { clearTimeout(pending.timer); pending.reject(error); pending = undefined }
    if (held && !released) onLockLost()
    child.kill()
  }
  child.on('error', () => fail(failure('EHELPER', 'Windows Core helper 无法启动')))
  child.on('exit', () => {
    if (!released || pending) fail(failure('EHELPER', 'Windows Core helper 在释放写锁前退出'))
  })
  child.stdin.on('error', () => fail(failure('EHELPER', 'Windows Core helper 控制流已关闭')))
  // 原生端只返回固定错误；stderr 不转发，避免进程错误携带载荷。
  child.stderr.resume()
  child.stdout.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk])
    if (buffer.length > MAX_FRAME_BYTES) { fail(failure('PROTOCOL', 'Windows Core helper 响应过大')); return }
    let end: number
    while ((end = buffer.indexOf(10)) >= 0) {
      const line = buffer.subarray(0, end).toString('utf8')
      buffer = buffer.subarray(end + 1)
      const request = pending
      if (!request) { fail(failure('PROTOCOL', 'Windows Core helper 返回未请求的响应')); return }
      clearTimeout(request.timer)
      pending = undefined
      try {
        const data = decodeOwnerResponse(line)
        if (request.op === 'hold') held = true
        if (request.op === 'release') { released = true; held = false }
        request.resolve(data)
      } catch (error) {
        request.reject(error as Error)
        // 原生 release 的失败收尾也可能已关闭句柄，不能继续把租约视为有效。
        if (request.op === 'release') fail(error as Error)
      }
    }
  })
  const request = (op: OwnerRequest['op'], endpoint?: LocalCoreOwnerEndpoint): Promise<unknown> => {
    const operation = queue.then(() => new Promise<unknown>((resolveRequest, reject) => {
      if (failed || released) { reject(failed ?? failure('EHELPER', 'Windows Core 写锁已释放')); return }
      let input: string
      try { input = frame({ version: 1, op, root: resolve(root), pid: process.pid, ...(endpoint ? { endpoint } : {}) }) }
      catch (error) { reject(error); return }
      pending = { op, resolve: resolveRequest, reject, timer: setTimeout(() => fail(failure('EHELPER', 'Windows Core helper 操作超时')), HELPER_TIMEOUT_MS) }
      child.stdin.write(input)
    }))
    queue = operation.catch(() => undefined)
    return operation
  }
  try { await request('hold'); if (failed) throw failed }
  catch (error) { released = true; child.stdin.end(); child.kill(); throw error }
  return {
    async publish(endpoint) { await request('publish', endpoint) },
    async remove() { await request('remove') },
    release() {
      if (releasePromise) return releasePromise
      if (released) return Promise.resolve()
      releasePromise = request('release').then(() => { child.stdin.end() })
      return releasePromise
    },
  }
}
