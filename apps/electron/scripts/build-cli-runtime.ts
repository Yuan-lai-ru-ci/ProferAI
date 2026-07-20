import { join } from 'node:path'

export interface BuildCliInvocationInput {
  bunExecutablePath: string
  outFile: string
  cliEntry: string
  compileExecutablePath?: string
}

/**
 * 生成 Bun compile 调用参数。
 * 子进程始终复用运行本脚本的 Bun，避免 Windows PATH 中的 bun/cmd 解析差异。
 */
export function createBuildCliInvocation(input: BuildCliInvocationInput) {
  const args = ['build', '--compile', '--outfile', input.outFile, input.cliEntry]
  if (input.compileExecutablePath) {
    args.splice(2, 0, '--compile-executable-path', input.compileExecutablePath)
  }
  return { command: input.bunExecutablePath, args }
}

/** 为 Windows compile-executable-path 生成唯一、较短的临时 Bun 路径。 */
export function createTemporaryBunPath(tempDir: string, now: number, pid: number): string {
  return join(tempDir, `bun-temp-${now}-${pid}.exe`)
}

/**
 * 清理临时 Bun 副本。删除失败不能覆盖主构建结果，交由调用者决定是否记录 warning。
 */
export function tryRemoveTemporaryBun(removeFile: (path: string) => void, path: string): boolean {
  try {
    removeFile(path)
    return true
  } catch {
    return false
  }
}
