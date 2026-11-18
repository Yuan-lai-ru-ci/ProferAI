import { mkdir, open, rename, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'

/**
 * 原子写：同目录临时文件 → fsync → rename 覆盖。
 *
 * 文件 fsync 失败必须抛错（否则断电后可能是空文件）；目录项 fsync 只能尽力而为：
 * Windows 上目录句柄 fsync 必定返回 EPERM（FlushFileBuffers 不支持），macOS 部分
 * 文件系统同样不支持。rename 已不可回滚，此时再抛错只会让调用方误判「写盘失败」。
 */
export async function atomicWriteFile(path: string, content: string | Uint8Array, mode = 0o600): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const tempPath = `${path}.${randomUUID()}.tmp`
  const handle = await open(tempPath, 'wx', mode)
  try {
    await handle.writeFile(content)
    await handle.sync()
  } catch (error) {
    await handle.close()
    await unlinkMissing(tempPath)
    throw error
  }
  await handle.close()
  try {
    await rename(tempPath, path)
  } catch (error) {
    await unlinkMissing(tempPath)
    throw error
  }
  await syncDirectoryBestEffort(dirname(path))
}

export async function atomicWriteJson(path: string, value: unknown, mode = 0o600): Promise<void> {
  await atomicWriteFile(path, `${JSON.stringify(value, null, 2)}\n`, mode)
}

async function syncDirectoryBestEffort(path: string): Promise<void> {
  try {
    const dir = await open(path, 'r')
    try { await dir.sync() } finally { await dir.close() }
  } catch {
    // 平台不支持目录 fsync：放弃目录项的断电持久性，但本次写入已经提交。
  }
}

async function unlinkMissing(path: string): Promise<void> {
  try { await unlink(path) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}
