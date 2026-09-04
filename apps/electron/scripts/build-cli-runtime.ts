import { existsSync, unlinkSync } from 'node:fs'
import { basename, join } from 'node:path'

const CLI_ARTIFACT_NAMES = ['profer', 'profer.exe'] as const

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
 * 删除其他宿主遗留的 CLI，确保后续打包不会同时携带 profer 与 profer.exe。
 */
export function cleanCliBuildArtifacts(outDir: string): string[] {
  const removed: string[] = []
  for (const name of CLI_ARTIFACT_NAMES) {
    const artifactPath = join(outDir, name)
    if (!existsSync(artifactPath)) continue
    unlinkSync(artifactPath)
    removed.push(artifactPath)
  }
  return removed
}

/** 将已清理产物转换为适合日志展示的文件名。 */
export function formatCliBuildArtifactNames(paths: readonly string[]): string {
  return paths.map((path) => basename(path)).join(', ')
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
