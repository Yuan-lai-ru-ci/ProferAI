import { readFileSync } from 'node:fs'

/** 只读取 Linux 发行版 ID，不执行 os-release 中的 shell 内容。 */
export function readCoreOsId(
  platform: string = process.platform,
  readText: (path: string) => string = path => readFileSync(path, 'utf8'),
): string | undefined {
  if (platform !== 'linux') return undefined
  for (const path of ['/etc/os-release', '/usr/lib/os-release']) {
    let text: string
    try { text = readText(path) }
    catch { continue }
    const match = text.match(/^ID=(?:"([a-z0-9._-]+)"|'([a-z0-9._-]+)'|([a-z0-9._-]+))\s*$/m)
    return match?.[1] ?? match?.[2] ?? match?.[3]
  }
  return undefined
}
