#!/usr/bin/env node
/** Linux 解包闭包验证。CLI 仅在 linux-x64 运行；纯结构函数供跨平台 fixture 测试。 */
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { findUnpackedNativeFiles } = require('./packaged-pi-probe.cjs')

function assertFile(file) {
  if (!fs.statSync(file).isFile() || fs.statSync(file).size === 0) throw new Error(`缺少非空文件: ${file}`)
}
function assertElfX64(file) {
  assertFile(file)
  const header = Buffer.alloc(20)
  const fd = fs.openSync(file, 'r')
  try { fs.readSync(fd, header, 0, header.length, 0) } finally { fs.closeSync(fd) }
  if (header.subarray(0, 4).toString('hex') !== '7f454c46' || header[4] !== 2 || header[5] !== 1 || header.readUInt16LE(18) !== 62) {
    throw new Error(`不是 ELF x64: ${file}`)
  }
}
function assertExecutable(file) {
  assertElfX64(file)
  if (!(fs.statSync(file).mode & 0o111)) throw new Error(`缺少执行权限: ${file}`)
  fs.accessSync(file, fs.constants.X_OK)
}
/** 明确带平台/架构标签的 prebuild 只选择 linux-x64；无标签 native 仍须验证。 */
function isLinuxX64Native(file) {
  const segments = file.split(path.sep)
  for (const segment of segments) {
    if (/^(darwin|win32|windows|android|freebsd)(?:[-.]|$)/.test(segment)) return false
    if (/^(?:linux-)?(?:arm64|armv7l|arm|ia32|riscv64|ppc64|s390x)(?:[-.]|$)/.test(segment)) return false
    // npm 平台子包也可能把平台标签放在包名末尾。
    if (/(?:^|-)(darwin|win32|windows|android|freebsd)-(?:x64|arm64|ia32)(?:-|$)/.test(segment)) return false
    if (/(?:^|-)linux-(?:arm64|armv7l|arm|ia32|riscv64|ppc64|s390x)(?:-|$)/.test(segment)) return false
  }
  return true
}
/** 禁止依赖链接逃逸到构建机；非目标 prebuild 仍遍历链接，但不做 ELF 断言。 */
function verifyDependencyTree(root) {
  const base = fs.realpathSync(root)
  const visited = new Set()
  function walk(current) {
    const real = fs.realpathSync(current)
    if (real !== base && !real.startsWith(base + path.sep)) throw new Error(`依赖逃逸: ${current}`)
    if (visited.has(real)) return
    visited.add(real)
    if (fs.statSync(real).isDirectory()) {
      for (const name of fs.readdirSync(real)) walk(path.join(real, name))
    } else if (/\.(node|so)$/.test(real) && isLinuxX64Native(path.relative(base, current))) assertElfX64(real)
  }
  walk(base)
}
function verifyLinuxPackageStructure(packageDir) {
  const root = path.resolve(packageDir)
  const resources = path.join(root, 'resources')
  const modules = path.join(resources, 'app.asar.unpacked', 'node_modules')
  const bin = path.join(resources, 'bin')
  const claude = path.join(modules, '@anthropic-ai', 'claude-agent-sdk-linux-x64', 'claude')
  for (const file of [path.join(root, 'profer'), path.join(bin, 'profer'), path.join(bin, 'profer-core'), claude,
    path.join(bin, 'node_modules', '@anthropic-ai', 'claude-agent-sdk-linux-x64', 'claude')]) assertExecutable(file)
  for (const file of [path.join(resources, 'app.asar'), path.join(resources, 'app.asar.unpacked', 'dist', 'session-persistence-worker.cjs')]) assertFile(file)
  for (const tree of [modules, path.join(bin, 'node_modules')]) verifyDependencyTree(tree)
  const nativeFiles = findUnpackedNativeFiles(modules).filter((file) => isLinuxX64Native(path.relative(modules, file)))
  if (!nativeFiles.length) throw new Error('缺少 Pi native/WASM 闭包')
  return { root, resources, claude, nativeFileCount: nativeFiles.length }
}
function verifyLinuxPackage(packageDir) {
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('真实产物验证仅支持 linux-x64 宿主')
  const result = verifyLinuxPackageStructure(packageDir)
  const run = (binary, args, env = process.env) => execFileSync(binary, args, { env, encoding: 'utf8', timeout: 60000, stdio: 'pipe' })
  run(result.claude, ['--version'])
  run(path.join(result.resources, 'bin', 'profer'), ['--help'])
  // Core 当前没有 --help 的退出契约，结构检查包含 ELF/权限；真实 Core 启停由独立 headless smoke 验证。
  const electron = path.join(result.root, 'profer')
  const nodeEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  // 使用成品 Electron 的 ASAR 感知解析器验证主包，而非构建机 node_modules。
  const sdkProbe = `const {createRequire}=require('node:module'); const {pathToFileURL}=require('node:url'); const r=createRequire(process.argv[1]+'/app.asar/dist/main.cjs'); import(pathToFileURL(r.resolve('@anthropic-ai/claude-agent-sdk')).href).catch(e=>{console.error(e);process.exitCode=1});`
  run(electron, ['-e', sdkProbe, result.resources], nodeEnv)
  run(electron, [path.join(__dirname, 'packaged-pi-probe.cjs'), result.resources], nodeEnv)
  return { ok: true, ...result }
}
module.exports = { assertElfX64, verifyDependencyTree, verifyLinuxPackageStructure, verifyLinuxPackage }
if (require.main === module) {
  try {
    if (!process.argv[2]) throw new Error('用法: node scripts/verify-linux-package.cjs <linux-unpacked 目录>')
    console.log(JSON.stringify(verifyLinuxPackage(process.argv[2]), null, 2))
  } catch (error) {
    console.error(`[verify-linux-package] ${error.message}`)
    process.exitCode = 1
  }
}
