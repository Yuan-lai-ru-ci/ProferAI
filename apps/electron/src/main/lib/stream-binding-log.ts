import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

/** 每个进程最多维护当前文件及一份轮转副本；日志失败绝不阻断流交接。 */
export function createStreamBindingLog(path: () => string, maxBytes = 1_000_000) {
  let size: number | undefined
  let failures = 0
  return (event: Record<string, unknown>): void => {
    if (failures >= 3) return
    try {
      const file = path()
      if (size === undefined) {
        mkdirSync(dirname(file), { recursive: true })
        size = existsSync(file) ? statSync(file).size : 0
      }
      const stack = new Error().stack?.split('\n').slice(2, 9).join(' | ') ?? ''
      const line = `${JSON.stringify({ ...event, at: Date.now(), stack })}\n`
      const bytes = Buffer.byteLength(line)
      if (bytes > maxBytes) return
      if (size + bytes > maxBytes) {
        renameSync(file, `${file}.1`)
        size = 0
      }
      appendFileSync(file, line, 'utf8')
      size += bytes
      failures = 0
    } catch {
      size = undefined // 权限/文件锁短暂失败后重查实际大小。
      failures++
    }
  }
}
