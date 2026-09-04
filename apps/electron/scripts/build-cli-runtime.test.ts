import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  cleanCliBuildArtifacts,
  createBuildCliInvocation,
  createTemporaryBunPath,
  formatCliBuildArtifactNames,
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

  test('Given 曾在不同宿主构建 CLI When 新构建开始 Then 删除两种已知二进制残留', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'profer-cli-build-'))
    const unixCli = join(outDir, 'profer')
    const windowsCli = join(outDir, 'profer.exe')
    const unrelatedFile = join(outDir, 'keep.txt')
    try {
      writeFileSync(unixCli, 'mac')
      writeFileSync(windowsCli, 'windows')
      writeFileSync(unrelatedFile, 'keep')

      expect(cleanCliBuildArtifacts(outDir)).toEqual([unixCli, windowsCli])
      expect(existsSync(unixCli)).toBe(false)
      expect(existsSync(windowsCli)).toBe(false)
      expect(existsSync(unrelatedFile)).toBe(true)
    } finally {
      rmSync(outDir, { recursive: true, force: true })
    }
  })

  test('Given 清理了多个平台 CLI When 生成日志 Then 只展示文件名且不把数组下标当作扩展名', () => {
    expect(formatCliBuildArtifactNames([
      join('/workspace/resources/bin', 'profer'),
      join('/workspace/resources/bin', 'profer.exe'),
    ])).toBe('profer, profer.exe')
  })
})
