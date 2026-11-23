#!/usr/bin/env bun
/** 从本次桌面产物定位完整 Core 目录，复用独立成品冒烟。 */
import { existsSync, readdirSync } from 'node:fs'
import { resolveWindowsOwnerHelper } from '../../../packages/session-store/src/windows-core-owner'
import { verifyWindowsOwnerExecutable } from '../../core/scripts/windows-owner-build'
import { join, resolve } from 'node:path'

export function resolvePackagedCoreRuntime(outputDir: string, platform: NodeJS.Platform): string {
  if (platform === 'darwin') {
    const direct = join(outputDir, 'Profer.app')
    const bundle = existsSync(direct) ? direct : (existsSync(outputDir)
      ? readdirSync(outputDir, { withFileTypes: true }).filter(entry => entry.isDirectory())
        .map(entry => join(outputDir, entry.name, 'Profer.app')).find(existsSync)
      : undefined)
    if (!bundle) throw new Error(`未找到 macOS 桌面产物: ${outputDir}`)
    return join(bundle, 'Contents', 'Resources', 'bin')
  }
  if (platform !== 'win32' && platform !== 'linux') throw new Error(`不支持的桌面平台: ${platform}`)
  return join(outputDir, platform === 'win32' ? 'win-unpacked' : 'linux-unpacked', 'resources', 'bin')
}

export function verifyPackagedCoreRuntime(runtime: string, platform: NodeJS.Platform, arch = process.arch): void {
  for (const file of ['core.js', 'core-runtime.json', platform === 'win32' ? 'profer-core.exe' : 'profer-core']) {
    if (!existsSync(join(runtime, file))) throw new Error(`桌面包缺少 Core 运行资源: ${join(runtime, file)}`)
  }
  if (platform === 'win32') {
    if (arch !== 'x64') throw new Error(`Windows Core helper 尚未验证支持架构: ${arch}`)
    verifyWindowsOwnerExecutable(resolveWindowsOwnerHelper(runtime, arch))
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const targetIndex = args.indexOf('--target')
  const target = targetIndex < 0 ? 'oss' : args[targetIndex + 1]
  if (target !== 'oss' && target !== 'commercial') throw new Error('--target 只能为 oss 或 commercial')
  const appDir = resolve(import.meta.dir, '..')
  const outputDir = resolve(appDir, process.env.PROFER_ELECTRON_OUTPUT_DIR ?? (target === 'commercial' ? 'out-commercial' : 'out'))
  const runtime = resolvePackagedCoreRuntime(outputDir, process.platform)
  verifyPackagedCoreRuntime(runtime, process.platform)
  const child = Bun.spawn([process.execPath, resolve(appDir, '../core/scripts/smoke-runtime.ts'), runtime], { stdout: 'inherit', stderr: 'inherit' })
  process.exitCode = await child.exited
}
