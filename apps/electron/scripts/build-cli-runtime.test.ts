import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import {
  createBuildCliInvocation,
  createTemporaryBunPath,
  tryRemoveTemporaryBun,
} from './build-cli-runtime'

describe('Windows CLI 编译调用', () => {
  test('Given Windows 临时 Bun 副本 When 构造调用 Then 复用当前 Bun 并传入 compile-executable-path', () => {
    const temporaryBunPath = createTemporaryBunPath('C:\\Temp', 123, 456)
    const invocation = createBuildCliInvocation({
      bunExecutablePath: 'C:\\Users\\yuan\\bin\\bun.exe',
      outFile: 'D:\\profer\\Profer-main\\apps\\electron\\resources\\bin\\profer.exe',
      cliEntry: 'D:\\profer\\Profer-main\\apps\\cli\\src\\index.ts',
      compileExecutablePath: temporaryBunPath,
    })

    expect(temporaryBunPath).toBe(join('C:\\Temp', 'bun-temp-123-456.exe'))
    expect(invocation.command).toBe('C:\\Users\\yuan\\bin\\bun.exe')
    expect(invocation.args).toEqual([
      'build',
      '--compile',
      '--compile-executable-path', temporaryBunPath,
      '--outfile', 'D:\\profer\\Profer-main\\apps\\electron\\resources\\bin\\profer.exe',
      'D:\\profer\\Profer-main\\apps\\cli\\src\\index.ts',
    ])
  })

  test('Given non-Windows 调用 When 未传临时副本 Then 保持既有 compile 参数语义', () => {
    expect(createBuildCliInvocation({
      bunExecutablePath: '/usr/local/bin/bun',
      outFile: '/tmp/profer',
      cliEntry: '/workspace/apps/cli/src/index.ts',
    })).toEqual({
      command: '/usr/local/bin/bun',
      args: ['build', '--compile', '--outfile', '/tmp/profer', '/workspace/apps/cli/src/index.ts'],
    })
  })

  test('Given 临时副本已不存在 When 清理 Then 不掩盖主构建结果', () => {
    expect(tryRemoveTemporaryBun(() => {
      throw new Error('ENOENT')
    }, 'C:\\Temp\\bun-temp.exe')).toBe(false)
    expect(tryRemoveTemporaryBun(() => {}, 'C:\\Temp\\bun-temp.exe')).toBe(true)
  })
})
