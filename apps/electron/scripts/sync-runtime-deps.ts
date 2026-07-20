#!/usr/bin/env bun
/**
 * 同步 Electron 主进程 external runtime 的依赖闭包到 apps/electron/node_modules。
 * Bun workspace 会将依赖提升到根目录；打包时 appDir 是 apps/electron，
 * 所以必须复制这些运行时依赖，避免安装包中出现 MODULE_NOT_FOUND。
 */

import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

interface PackageManifest {
  name?: string
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

interface RuntimeDependency {
  name: string
  optional: boolean
}

interface SyncContext {
  sourceNodeModules: string
  targetNodeModules: string
  copiedPackages: Map<string, string>
  topLevelPackageSources: Map<string, string>
  skippedOptionalPackages: string[]
}

export interface SyncRuntimeDepsOptions {
  sourceNodeModules?: string
  targetNodeModules?: string
  externalRuntimePackages?: readonly string[]
  /** 打包时清空目标；开发场景可传 false，避免破坏调试环境。 */
  cleanTarget?: boolean
}

export interface SyncRuntimeDepsResult {
  copiedPackageCount: number
  copiedPackages: string[]
  skippedOptionalPackages: string[]
}

export const EXTERNAL_RUNTIME_PACKAGES: readonly string[] = [
  '@anthropic-ai/claude-agent-sdk',
  '@earendil-works/pi-coding-agent',
  '@earendil-works/pi-agent-core',
  '@earendil-works/pi-ai',
  'pdfjs-dist',
]

const appDir = resolve(import.meta.dir, '..')
const repoRoot = resolve(appDir, '../..')
const repoNodeModules = join(repoRoot, 'node_modules')
const bunVirtualNodeModules = join(repoNodeModules, '.bun', 'node_modules')
const defaultSourceNodeModules = existsSync(bunVirtualNodeModules) ? bunVirtualNodeModules : repoNodeModules
const defaultTargetNodeModules = join(appDir, 'node_modules')

function getPackageDir(nodeModulesDir: string, packageName: string): string {
  if (packageName.startsWith('@')) {
    const [scope, name] = packageName.split('/')
    if (!scope || !name) throw new Error(`非法 scoped package 名称: ${packageName}`)
    return join(nodeModulesDir, scope, name)
  }
  return join(nodeModulesDir, packageName)
}

function resolvePackageFromNodeModules(nodeModulesDir: string, packageName: string): string | undefined {
  const packageDir = getPackageDir(nodeModulesDir, packageName)
  return existsSync(join(packageDir, 'package.json')) ? realpathSync(packageDir) : undefined
}

function resolvePackageUpwards(startDir: string, packageName: string): string | undefined {
  let currentDir = resolve(startDir)
  while (true) {
    const resolved = resolvePackageFromNodeModules(join(currentDir, 'node_modules'), packageName)
    if (resolved) return resolved
    const parentDir = dirname(currentDir)
    if (parentDir === currentDir) return undefined
    currentDir = parentDir
  }
}

function resolvePackageSourceDir(ctx: SyncContext, packageName: string, resolveFromDir?: string): string | undefined {
  if (resolveFromDir) {
    const resolved = resolvePackageUpwards(resolveFromDir, packageName)
    if (resolved) return resolved
  }
  for (const nodeModulesDir of [ctx.sourceNodeModules, bunVirtualNodeModules, repoNodeModules]) {
    const resolved = resolvePackageFromNodeModules(nodeModulesDir, packageName)
    if (resolved) return resolved
  }
  return undefined
}

function readPackageManifest(sourceDir: string): PackageManifest {
  return JSON.parse(readFileSync(join(sourceDir, 'package.json'), 'utf-8')) as PackageManifest
}

function listRuntimeDependencies(manifest: PackageManifest): RuntimeDependency[] {
  return [
    ...Object.keys(manifest.dependencies ?? {}).map(name => ({ name, optional: false })),
    ...Object.keys(manifest.optionalDependencies ?? {}).map(name => ({ name, optional: true })),
  ]
}

function copyPackage(
  ctx: SyncContext,
  packageName: string,
  optional = false,
  resolveFromDir?: string,
  targetNodeModules = ctx.targetNodeModules,
  sourceAncestors = new Set<string>(),
): void {
  const sourceDir = resolvePackageSourceDir(ctx, packageName, resolveFromDir)
  if (!sourceDir) {
    if (optional) {
      ctx.skippedOptionalPackages.push(packageName)
      return
    }
    throw new Error(`缺少运行时依赖: ${packageName} (${getPackageDir(ctx.sourceNodeModules, packageName)})`)
  }

  const targetDir = getPackageDir(targetNodeModules, packageName)
  const targetKey = resolve(targetDir)
  const existingSource = ctx.copiedPackages.get(targetKey)
  if (existingSource) {
    if (existingSource === sourceDir) return
    throw new Error(`运行时依赖版本冲突: ${packageName} 已复制自 ${existingSource}，又解析到 ${sourceDir}`)
  }

  ctx.copiedPackages.set(targetKey, sourceDir)
  if (targetNodeModules === ctx.targetNodeModules) ctx.topLevelPackageSources.set(packageName, sourceDir)

  mkdirSync(dirname(targetDir), { recursive: true })
  rmSync(targetDir, { recursive: true, force: true })
  cpSync(sourceDir, targetDir, { recursive: true, dereference: true, force: true, preserveTimestamps: true })

  const nextAncestors = new Set(sourceAncestors)
  nextAncestors.add(sourceDir)
  for (const dependency of listRuntimeDependencies(readPackageManifest(sourceDir))) {
    copyDependency(ctx, dependency, sourceDir, targetDir, nextAncestors)
  }
}

function copyDependency(
  ctx: SyncContext,
  dependency: RuntimeDependency,
  parentSourceDir: string,
  parentTargetDir: string,
  sourceAncestors: Set<string>,
): void {
  const sourceDir = resolvePackageSourceDir(ctx, dependency.name, parentSourceDir)
  if (!sourceDir) {
    if (dependency.optional) {
      ctx.skippedOptionalPackages.push(dependency.name)
      return
    }
    throw new Error(`缺少运行时依赖: ${dependency.name} (${parentSourceDir})`)
  }
  if (sourceAncestors.has(sourceDir)) return

  const topLevelSource = ctx.topLevelPackageSources.get(dependency.name)
  if (!topLevelSource || topLevelSource === sourceDir) {
    copyPackage(ctx, dependency.name, dependency.optional, parentSourceDir, ctx.targetNodeModules, sourceAncestors)
    return
  }
  copyPackage(ctx, dependency.name, dependency.optional, parentSourceDir, join(parentTargetDir, 'node_modules'), sourceAncestors)
}

function assertNoAbsoluteSymlinks(dir: string): void {
  if (!existsSync(dir)) return
  const stack = [dir]
  const offenders: string[] = []
  while (stack.length > 0) {
    const currentDir = stack.pop()!
    for (const entry of readdirSync(currentDir)) {
      const fullPath = join(currentDir, entry)
      const stat = lstatSync(fullPath)
      if (stat.isSymbolicLink()) {
        if (readlinkSync(fullPath).startsWith('/')) offenders.push(fullPath)
        continue
      }
      if (stat.isDirectory()) stack.push(fullPath)
    }
  }
  if (offenders.length > 0) {
    throw new Error(`检测到绝对 symlink，会导致打包后模块解析失效: ${offenders.slice(0, 10).join(', ')}`)
  }
}

function prepareTargetNodeModules(sourceNodeModules: string, targetNodeModules: string): void {
  if (resolve(sourceNodeModules) === resolve(targetNodeModules)) {
    throw new Error('sourceNodeModules 与 targetNodeModules 不能相同，避免误删源依赖')
  }
  if (basename(targetNodeModules) !== 'node_modules') throw new Error(`拒绝清理非 node_modules 目录: ${targetNodeModules}`)
  rmSync(targetNodeModules, { recursive: true, force: true })
  mkdirSync(targetNodeModules, { recursive: true })
}

export function syncRuntimeDeps(options: SyncRuntimeDepsOptions = {}): SyncRuntimeDepsResult {
  const ctx: SyncContext = {
    sourceNodeModules: options.sourceNodeModules ?? defaultSourceNodeModules,
    targetNodeModules: options.targetNodeModules ?? defaultTargetNodeModules,
    copiedPackages: new Map(),
    topLevelPackageSources: new Map(),
    skippedOptionalPackages: [],
  }

  if (options.cleanTarget ?? true) {
    prepareTargetNodeModules(ctx.sourceNodeModules, ctx.targetNodeModules)
  } else {
    if (resolve(ctx.sourceNodeModules) === resolve(ctx.targetNodeModules)) throw new Error('sourceNodeModules 与 targetNodeModules 不能相同，避免覆盖源依赖')
    if (basename(ctx.targetNodeModules) !== 'node_modules') throw new Error(`拒绝同步到非 node_modules 目录: ${ctx.targetNodeModules}`)
    mkdirSync(ctx.targetNodeModules, { recursive: true })
  }

  for (const packageName of options.externalRuntimePackages ?? EXTERNAL_RUNTIME_PACKAGES) copyPackage(ctx, packageName)
  assertNoAbsoluteSymlinks(ctx.targetNodeModules)
  return {
    copiedPackageCount: ctx.copiedPackages.size,
    copiedPackages: [...ctx.copiedPackages.keys()],
    skippedOptionalPackages: [...ctx.skippedOptionalPackages],
  }
}

if (import.meta.main) {
  const result = syncRuntimeDeps({ cleanTarget: !process.argv.includes('--no-clean') })
  const skipped = result.skippedOptionalPackages.length ? `，跳过未安装 optional 依赖 ${result.skippedOptionalPackages.length} 个` : ''
  console.log(`[runtime-deps] 已同步 ${result.copiedPackageCount} 个主进程运行时依赖${skipped}`)
}
