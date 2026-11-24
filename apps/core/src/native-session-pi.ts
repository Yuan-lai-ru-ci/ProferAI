import { closeSync, existsSync, openSync, readSync, readdirSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'

function contained(root: string, file: string): boolean {
  const path = relative(root, file)
  return Boolean(path) && path !== '..' && !path.startsWith('../') && !path.startsWith('..\\') && !isAbsolute(path)
}

/** 启动恢复只检查存在回退日志的会话；一次遍历目录，不逐会话重扫全部 transcript。 */
export function listNativePiRewindSessionIds(configDir: string): ReadonlySet<string> {
  const configRoot = realpathSync(configDir)
  const ids = new Set<string>()
  for (const candidate of [resolve(configDir, 'pi-sessions'), resolve(configDir, 'sdk-config', 'sessions', 'pi')]) {
    if (!existsSync(candidate)) continue
    const root = realpathSync(candidate)
    if (!contained(configRoot, root)) throw new Error('Pi 原生会话根目录越出所属 Core')
    const walk = (directory: string, depth: number): void => {
      if (depth > 24) throw new Error('Pi 原生会话目录过深')
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue
        const file = join(directory, entry.name)
        if (entry.isDirectory()) { walk(file, depth + 1); continue }
        if (!entry.isFile() || !entry.name.endsWith('.jsonl.profer-rewind.json')) continue
        const transcript = file.slice(0, -'.profer-rewind.json'.length)
        const actual = realpathSync(transcript)
        if (!contained(root, actual)) throw new Error('Pi 原生会话路径越出所属 Core')
        const fd = openSync(actual, 'r')
        try {
          const buffer = Buffer.alloc(16 * 1024)
          const length = readSync(fd, buffer, 0, buffer.length, 0)
          const header = JSON.parse(buffer.toString('utf8', 0, length).replace(/^\uFEFF/, '').split('\n', 1)[0] ?? '')
          if (header?.type !== 'session' || typeof header.id !== 'string' || !header.id.trim()) throw new Error('Pi 回退日志所属原生会话身份无效')
          ids.add(header.id)
        } finally { closeSync(fd) }
      }
    }
    walk(root, 0)
  }
  return ids
}

export function findNativePiRewindJournal(configDir: string, sessionId: string): string | undefined {
  try {
    const transcript = resolveNativePiSessionFile(configDir, sessionId)
    const journal = `${transcript}.profer-rewind.json`
    return existsSync(journal) ? journal : undefined
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('所属 Core 缺少 Pi 原生会话:')) return undefined
    throw error
  }
}

/** 在所属 Core 数据根中定位唯一原生文件，不信任从其他机器迁入的绝对路径。 */
export function resolveNativePiSessionFile(configDir: string, sessionId: string): string {
  if (!sessionId.trim()) throw new Error('Pi 原生会话身份不能为空')
  const configRoot = realpathSync(configDir)
  const matches = new Set<string>()
  for (const candidate of [resolve(configDir, 'pi-sessions'), resolve(configDir, 'sdk-config', 'sessions', 'pi')]) {
    if (!existsSync(candidate)) continue
    const root = realpathSync(candidate)
    if (!contained(configRoot, root)) throw new Error('Pi 原生会话根目录越出所属 Core')
    const walk = (directory: string, depth: number): void => {
      if (depth > 24) throw new Error('Pi 原生会话目录过深')
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue
        const file = join(directory, entry.name)
        const realFile = realpathSync(file)
        if (!contained(root, realFile)) throw new Error('Pi 原生会话路径越出所属 Core')
        if (entry.isDirectory()) walk(realFile, depth + 1)
        else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          let fd: number | undefined
          try {
            fd = openSync(realFile, 'r')
            const buffer = Buffer.alloc(16 * 1024)
            const length = readSync(fd, buffer, 0, buffer.length, 0)
            const header: unknown = JSON.parse(buffer.toString('utf8', 0, length).replace(/^\uFEFF/, '').split('\n', 1)[0] ?? '')
            if (header && typeof header === 'object' && (header as { type?: unknown }).type === 'session'
              && (header as { id?: unknown }).id === sessionId) matches.add(realFile)
          } catch (error) {
            // 非目标的损坏 transcript 不影响其他会话；I/O 错误不能被当成找不到会话。
            if (!(error instanceof SyntaxError)) throw error
          } finally { if (fd !== undefined) closeSync(fd) }
        }
      }
    }
    walk(root, 0)
  }
  if (matches.size !== 1) throw new Error(matches.size ? `Pi 原生会话身份重复: ${sessionId}` : `所属 Core 缺少 Pi 原生会话: ${sessionId}`)
  return [...matches][0]!
}
