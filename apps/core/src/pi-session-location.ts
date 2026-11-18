import { closeSync, existsSync, openSync, readSync, readdirSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'

function isWithin(root: string, file: string): boolean {
  const rel = relative(root, file)
  return Boolean(rel) && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(rel)
}

/** 只读首行，不把大型 transcript 整体载入内存。 */
function headerId(file: string): string | undefined {
  let fd: number | undefined
  try {
    fd = openSync(file, 'r')
    const buffer = Buffer.alloc(16 * 1024)
    const bytes = readSync(fd, buffer, 0, buffer.length, 0)
    const firstLine = buffer.toString('utf8', 0, bytes).replace(/^\uFEFF/, '').split('\n', 1)[0]
    const header = JSON.parse(firstLine ?? '') as { type?: unknown; id?: unknown }
    return header.type === 'session' && typeof header.id === 'string' ? header.id : undefined
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/**
 * 只在当前数据根内恢复 Pi 上下文。迁移索引里的绝对 piSessionFile 可能仍指向正式版，
 * 不使用它打开或复制文件；以当前根下 transcript header 的精确 ID 为准。
 */
export function resolveCorePiSessionDir(configDir: string, resumeSessionId?: string): string {
  const current = resolve(configDir, 'pi-sessions')
  if (!resumeSessionId) return current
  const configRoot = realpathSync(configDir)
  const matches: string[] = []
  for (const root of [current, resolve(configDir, 'sdk-config', 'sessions', 'pi')]) {
    if (!existsSync(root)) continue
    const realRoot = realpathSync(root)
    if (!isWithin(configRoot, realRoot)) continue
    const walk = (directory: string, depth = 0): void => {
      if (depth > 24) throw new Error('Pi 上下文目录过深，无法安全确认恢复文件')
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        // 不跟随目录/文件符号链接；普通路径也验证 realpath，防止祖先目录跳出数据根。
        const file = join(directory, entry.name)
        if (!isWithin(realRoot, realpathSync(file))) continue
        if (entry.isDirectory()) walk(file, depth + 1)
        else if (entry.isFile() && entry.name.endsWith('.jsonl') && headerId(file) === resumeSessionId) matches.push(root)
      }
    }
    walk(root)
  }
  if (matches.length > 1) throw new Error(`找到多个 Pi 上下文，无法确定恢复文件: ${resumeSessionId}`)
  if (!matches[0]) throw new Error(`当前数据目录中未找到 Pi 上下文，请恢复对应原生会话文件: ${resumeSessionId}`)
  return matches[0]
}
