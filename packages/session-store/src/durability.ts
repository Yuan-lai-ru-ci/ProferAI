/**
 * 落盘持久性的「尽力而为」封装。
 *
 * 背景：原子写（临时文件 → fsync → rename）里的 fsync 是为了防断电后出现
 * 「新文件已就位但内容为空」。但在一些环境里 `FlushFileBuffers` 会被直接拒绝：
 * - Windows + 同步盘（OneDrive/坚果云）或杀软实时扫描正在读那个临时文件；
 * - 部分网络盘/虚拟文件系统不实现 flush。
 * libuv 把这类拒绝映射成 `EPERM`（也见过 `EINVAL`/`ENOTSUP`）。
 *
 * 这时候整个写盘失败是**最差的选择**：功能直接 500（例如回退报
 * `EPERM: operation not permitted, fsync`），而我们唯一损失的是「断电不丢」这一层保证。
 * rename 仍然是原子的，进程正常退出也不会丢数据。
 *
 * 所以这里只吞掉「文件系统不支持/临时拒绝」这几类，其它错误（EBADF 之类真 bug）照常抛。
 */
import { fsyncSync } from 'node:fs'

/** 可安全跳过的 fsync 失败码 */
const SKIPPABLE = new Set(['EPERM', 'EINVAL', 'ENOTSUP', 'EOPNOTSUPP'])

export function fsyncBestEffort(fd: number, fsync: (fd: number) => void = fsyncSync): void {
  try {
    fsync(fd)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    if (code && SKIPPABLE.has(code)) {
      // 只告警不抛：rename 仍是原子的，丢的只是「断电后仍然完整」这一层
      console.warn(`[session-store] fsync 被文件系统拒绝（${code}），已跳过；断电持久性不再保证`)
      return
    }
    throw error
  }
}

/** 只要是「能 sync 的句柄」都行：fs.promises 的 FileHandle 与同步 fd 都走这里。 */
export interface SyncableHandle {
  sync(): Promise<void>
}

/**
 * 异步句柄的尽力 fsync（FileHandle.sync）。
 *
 * **目录句柄在 Windows 上一定失败**：`FlushFileBuffers` 不接受目录句柄，libuv 把它
 * 映射成 `EPERM: operation not permitted, fsync`。而「rename 后 sync 父目录」是 POSIX
 * 的断电保证，Windows 根本不支持 —— 于是这段代码会让所有原子写在 Windows 上直接 500
 * （回退报 EPERM 就是这么来的）。
 *
 * 结论：目录 sync 只能是 best-effort；文件 sync 失败也一样降级 —— rename 仍是原子的。
 */
export async function syncBestEffort(handle: SyncableHandle): Promise<void> {
  try {
    await handle.sync()
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    if (code && SKIPPABLE.has(code)) {
      console.warn(`[session-store] 句柄 fsync 被文件系统拒绝（${code}），已跳过；断电持久性不再保证`)
      return
    }
    throw error
  }
}
