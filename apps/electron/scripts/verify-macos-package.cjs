#!/usr/bin/env node
/**
 * 验证 Apple Silicon macOS 解包产物的基础运行时闭包。
 *
 * 仅应在 darwin-arm64 上运行，并由 dist:mac 在 electron-builder 成功后调用。
 * 它不替代真实 UI/Agent 冒烟，也不做签名或 notarization 断言（P1 明确无签名）。
 */
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { getPlatformTarget } = require('./prepare-bundled-bun.cjs')
const { findUnpackedNativeFiles } = require('./packaged-pi-probe.cjs')

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  throw new Error(`verify:mac-package 仅支持 darwin-arm64，当前为 ${process.platform}-${process.arch}`)
}

const appRoot = path.resolve(__dirname, '..')
const outputDir = process.env.PROFER_ELECTRON_OUTPUT_DIR
  ? path.resolve(appRoot, process.env.PROFER_ELECTRON_OUTPUT_DIR)
  : path.join(appRoot, 'out')
const target = getPlatformTarget()
const expectedBunVersion = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8')).proma?.bun?.version
if (!expectedBunVersion) throw new Error('package.json 缺少 proma.bun.version')

function assertExists(filePath, description) {
  if (!fs.existsSync(filePath)) throw new Error(`macOS 安装包缺少 ${description}: ${filePath}`)
}

function findAppBundle() {
  const direct = path.join(outputDir, 'Profer.app')
  if (fs.existsSync(direct)) return direct
  if (!fs.existsSync(outputDir)) return null
  for (const entry of fs.readdirSync(outputDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const candidate = path.join(outputDir, entry.name, 'Profer.app')
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

const appBundle = findAppBundle()
if (!appBundle) throw new Error(`未找到 macOS Profer.app 解包产物: ${outputDir}`)
const contents = path.join(appBundle, 'Contents')
const resources = path.join(contents, 'Resources')
const macOsDir = path.join(contents, 'MacOS')
const appArchive = path.join(resources, 'app.asar')
const unpackedNodeModules = path.join(resources, 'app.asar.unpacked', 'node_modules')
const bunPath = path.join(resources, 'vendor', 'bun', target.binary)
const cliPath = path.join(resources, 'bin', 'profer')
const claudePath = path.join(unpackedNodeModules, '@anthropic-ai', 'claude-agent-sdk-darwin-arm64', 'claude')

assertExists(path.join(macOsDir, 'Profer'), '应用可执行文件')
assertExists(appArchive, 'app.asar')
assertExists(unpackedNodeModules, 'app.asar.unpacked/node_modules')
assertExists(bunPath, 'bundled Bun')
assertExists(cliPath, 'Profer CLI')
assertExists(claudePath, 'Claude Agent SDK darwin-arm64 CLI')

for (const [binary, description] of [[bunPath, 'bundled Bun'], [cliPath, 'Profer CLI'], [claudePath, 'Claude CLI']]) {
  try {
    fs.accessSync(binary, fs.constants.X_OK)
  } catch {
    throw new Error(`${description} 不具备 macOS 可执行权限: ${binary}`)
  }
}

const bunVersion = execFileSync(bunPath, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 }).trim()
if (bunVersion !== expectedBunVersion) {
  throw new Error(`安装包 Bun 版本不匹配: expected ${expectedBunVersion}, received ${bunVersion}`)
}

const nativeFiles = findUnpackedNativeFiles(unpackedNodeModules)
if (nativeFiles.length === 0) throw new Error('app.asar.unpacked 中未找到 Pi native/WASM 文件')
const appBinaryInfo = execFileSync('file', ['-b', path.join(macOsDir, 'Profer')], { encoding: 'utf8' }).trim()
if (!/arm64|arm64e/i.test(appBinaryInfo)) throw new Error(`Profer.app 主二进制不是 arm64: ${appBinaryInfo}`)

console.log(JSON.stringify({
  ok: true,
  appBundle,
  bunVersion,
  claudePath,
  nativeFileCount: nativeFiles.length,
  appBinaryInfo,
}, null, 2))
