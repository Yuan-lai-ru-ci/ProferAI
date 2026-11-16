/**
 * fsync 降级的行为测试。
 *
 * 这条路径只有在「文件系统拒绝 flush」的机器上才会走到（Windows + 同步盘/杀软），
 * 在开发机上永远复现不了 —— 所以用注入的 fsync 把它固定下来。
 */
import { describe, expect, test } from 'bun:test'
import { fsyncBestEffort, syncBestEffort } from './durability'

function throwCode(code: string): (fd: number) => void {
  return () => {
    const error = new Error(`${code}: operation not permitted, fsync`) as NodeJS.ErrnoException
    error.code = code
    throw error
  }
}

describe('fsync 降级', () => {
  test('Given fsync 正常 When 调用 Then 透传一次', () => {
    let calls = 0
    fsyncBestEffort(1, () => { calls += 1 })
    expect(calls).toBe(1)
  })

  test('Given 文件系统拒绝 flush（EPERM） When 调用 Then 不抛错（否则整个写盘失败）', () => {
    for (const code of ['EPERM', 'EINVAL', 'ENOTSUP']) {
      expect(() => fsyncBestEffort(1, throwCode(code))).not.toThrow()
    }
  })

  test('Given 真 bug（EBADF） When 调用 Then 照常抛出，不掩盖问题', () => {
    expect(() => fsyncBestEffort(-1, throwCode('EBADF'))).toThrow('EBADF')
  })

  test('Given 非系统错误 When 调用 Then 照常抛出', () => {
    expect(() => fsyncBestEffort(1, () => { throw new Error('boom') })).toThrow('boom')
  })
})

describe('异步句柄 sync 降级（目录句柄在 Windows 上必失败）', () => {
  const handle = (impl: () => Promise<void>) => ({ sync: impl })

  test('Given 目录句柄 sync 抛 EPERM When 调用 Then 不抛错（回退曾因此整单失败）', async () => {
    const error = Object.assign(new Error('EPERM: operation not permitted, fsync'), { code: 'EPERM' })
    await expect(syncBestEffort(handle(async () => { throw error }))).resolves.toBeUndefined()
  })

  test('Given 句柄 sync 正常 When 调用 Then 透传', async () => {
    let calls = 0
    await syncBestEffort(handle(async () => { calls += 1 }))
    expect(calls).toBe(1)
  })

  test('Given 真 bug（EIO） When 调用 Then 照常抛出', async () => {
    const error = Object.assign(new Error('EIO'), { code: 'EIO' })
    await expect(syncBestEffort(handle(async () => { throw error }))).rejects.toThrow('EIO')
  })
})
