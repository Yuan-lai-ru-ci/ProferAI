#!/usr/bin/env bun
/** 原生宿主构建；整个输出目录必须一起复制，不能只取可执行文件。 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { syncRuntimeDeps } from '../../electron/scripts/sync-runtime-deps'

const coreDir = resolve(import.meta.dir, '..')
const repoRoot = resolve(coreDir, '../..')
const marker = 'core-runtime.json'
export function coreBuildPlan(output: string, platform: string = process.platform, arch: string = process.arch) {
  if (!['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'win32-x64', 'win32-arm64'].includes(`${platform}-${arch}`)) throw new Error(`不支持的平台: ${platform}-${arch}`)
  const outDir = resolve(output)
  if (outDir === repoRoot || repoRoot.startsWith(outDir + sep) || (outDir.startsWith(repoRoot + sep) && !outDir.startsWith(join(coreDir, 'dist') + sep) && outDir !== join(coreDir, 'dist'))) throw new Error('拒绝覆盖仓库源目录')
  const external = ['@anthropic-ai/claude-agent-sdk', '@anthropic-ai/sdk', '@earendil-works/pi-coding-agent', '@earendil-works/pi-agent-core', '@earendil-works/pi-ai']
  return { outDir, executable: join(outDir, platform === 'win32' ? 'profer-core.exe' : 'profer-core'), nativeClaudePackage: `@anthropic-ai/claude-agent-sdk-${platform}-${arch}`, external, platform, arch }
}

export async function buildCoreRuntime(output = join(coreDir, 'dist')) {
  const plan = coreBuildPlan(output)
  if (existsSync(plan.outDir) && readdirSync(plan.outDir).length && !existsSync(join(plan.outDir, marker))) throw new Error('拒绝覆盖现有非 Core 构建目录')
  mkdirSync(plan.outDir, { recursive: true })
  const bundled = await Bun.build({ entrypoints: [join(coreDir, 'src/index.ts')], outdir: plan.outDir, naming: 'core.js', target: 'bun', external: plan.external })
  if (!bundled.success) throw new AggregateError(bundled.logs, 'Core bundle 失败')
  const result = await Bun.build({ entrypoints: [join(import.meta.dir, 'compiled-launcher.ts')], target: 'bun', compile: { outfile: plan.executable } })
  if (!result.success) throw new AggregateError(result.logs, 'Core 编译失败')
  const deps = syncRuntimeDeps({ targetNodeModules: join(plan.outDir, 'node_modules'), cleanTarget: true, externalRuntimePackages: [...plan.external, plan.nativeClaudePackage] })
  const native = join(plan.outDir, 'node_modules', plan.nativeClaudePackage, process.platform === 'win32' ? 'claude.exe' : 'claude')
  if (!existsSync(native)) throw new Error(`缺少 Claude native: ${native}`)
  if (process.platform === 'darwin') {
    for (const args of [['--force', '--sign', '-', plan.executable], ['--verify', '--strict', plan.executable]]) {
      const signed = Bun.spawnSync(['/usr/bin/codesign', ...args])
      if (signed.exitCode !== 0) throw new Error(signed.stderr.toString())
    }
  }
  const coreVersion = JSON.parse(readFileSync(join(coreDir, 'package.json'), 'utf8')).version as string
  cpSync(join(coreDir, 'resources', 'HEADLESS-README.md'), join(plan.outDir, 'README.md'))
  cpSync(join(coreDir, 'resources', 'profer-core.service.example'), join(plan.outDir, 'profer-core.service.example'))
  cpSync(join(repoRoot, 'LICENSE'), join(plan.outDir, 'LICENSE'))
  writeFileSync(join(plan.outDir, marker), JSON.stringify({ format: 1, coreVersion, platform: plan.platform, arch: plan.arch, bun: Bun.version, executable: 'profer-core' + (process.platform === 'win32' ? '.exe' : ''), copiedPackages: deps.copiedPackageCount }, null, 2) + '\n')
  return plan
}

export function archiveLinuxRuntime(output: string, archive: string) {
  if (process.platform !== 'linux') throw new Error('Linux tar.gz 必须在 Linux 原生构建宿主生成')
  const plan = coreBuildPlan(output)
  if (!existsSync(join(plan.outDir, marker))) throw new Error('缺少 Core 构建清单')
  const target = resolve(archive)
  if (target.startsWith(plan.outDir + sep)) throw new Error('归档不能位于运行目录内')
  mkdirSync(dirname(target), { recursive: true })
  const result = Bun.spawnSync(['tar', '-czf', target, '-C', plan.outDir, '.'])
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return target
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const value = (flag: string) => { const index = args.indexOf(flag); if (index < 0) return undefined; const next = args[index + 1]; if (!next || next.startsWith('--')) throw new Error(`缺少 ${flag} 参数`); return next }
  const plan = await buildCoreRuntime(value('--out'))
  const archive = value('--tar-gz')
  if (archive) archiveLinuxRuntime(plan.outDir, archive)
  console.log(`[Core build] ${plan.outDir}`)
}
