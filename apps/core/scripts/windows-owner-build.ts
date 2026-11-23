import { verifyWindowsOwnerBinary } from '../../../packages/session-store/src/windows-core-owner'
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { join, win32 } from 'node:path'

export const OWNER_HELPER = { executable: 'profer-core-owner.exe', protocol: 1 } as const
export function windowsOwnerBuildPlan(systemRoot: string, arch: string, output: string) {
  if (arch !== 'x64') throw new Error(`Windows Core helper 尚未验证支持架构: ${arch}`)
  if (!win32.isAbsolute(systemRoot)) throw new Error('Windows 系统目录必须是绝对路径')
  const compiler = win32.join(systemRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
  return { compiler, args: ['/nologo', '/target:exe', '/platform:x64', '/optimize+', '/reference:System.Web.Extensions.dll', `/out:${win32.join(output, OWNER_HELPER.executable)}`] }
}
export const verifyOwnerBinary = verifyWindowsOwnerBinary
export function assertOwnerProtocol(result: { error?: Error; status: number | null; stdout: string }): void {
  if (result.error || result.status !== 0 || result.stdout.trim() !== 'profer-core-owner/1') throw new Error('Core helper 无法运行或协议不匹配')
}
export function verifyWindowsOwnerExecutable(executable: string): void {
  const file = lstatSync(executable)
  if (!file.isFile() || file.isSymbolicLink() || !file.size) throw new Error(`Core helper 文件无效: ${executable}`)
  verifyOwnerBinary(readFileSync(executable))
  const result = spawnSync(executable, ['--protocol-version'], { encoding: 'utf8', timeout: 5000, maxBuffer: 16384, windowsHide: true })
  assertOwnerProtocol(result)
}
export function buildWindowsOwnerHelper(output: string, nativeSources: string, arch: string = process.arch): void {
  if (process.platform !== 'win32') throw new Error('Core helper 必须在 Windows 原生宿主构建')
  const plan = windowsOwnerBuildPlan(process.env.SystemRoot ?? '', arch, output)
  if (!existsSync(plan.compiler)) throw new Error(`缺少系统 .NET Framework C# 编译器: ${plan.compiler}`)
  const sources = ['NativeOwner.cs', 'Program.cs'].map(name => join(nativeSources, name))
  for (const source of sources) if (!existsSync(source)) throw new Error(`缺少 Core helper 源码: ${source}`)
  const result = spawnSync(plan.compiler, [...plan.args, ...sources], { encoding: 'utf8', windowsHide: true, timeout: 60000 })
  if (result.error || result.status !== 0) throw new Error(`Core helper 编译失败: ${result.error?.message ?? result.stderr + result.stdout}`)
  verifyWindowsOwnerExecutable(join(output, OWNER_HELPER.executable))
}
