#!/usr/bin/env node
/**
 * 离线验证 Windows packaged Pi runtime 闭包。
 *
 * 必须使用刚生成的 packaged Electron 自带 Node ABI 运行：
 *   $env:ELECTRON_RUN_AS_NODE='1'
 *   .\out\win-unpacked\Profer.exe .\scripts\packaged-pi-probe.cjs .\out\win-unpacked\resources
 *
 * 该 probe 只验证 app.asar 的 ESM 导入、当前 Pi 0.80.3 的内存 registry/session
 * 初始化，以及 native/WASM 是否位于 app.asar.unpacked。它不发送真实渠道请求。
 */
const { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { extname, join, resolve, sep } = require('node:path')
const { pathToFileURL } = require('node:url')

const PI_PACKAGES = [
  '@earendil-works/pi-agent-core',
  '@earendil-works/pi-ai',
  '@earendil-works/pi-coding-agent',
  '@earendil-works/pi-tui',
]
const NATIVE_SCOPES = [
  '@earendil-works/pi-tui/native',
  '@silvia-odwyer',
  '@mariozechner',
  '@napi-rs',
]
const NATIVE_EXTENSIONS = new Set(['.node', '.wasm', '.dll', '.dylib', '.so'])

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function walkFiles(root) {
  if (!existsSync(root)) return []
  const files = []
  const stack = [root]
  while (stack.length > 0) {
    const current = stack.pop()
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) stack.push(path)
      else if (entry.isFile()) files.push(path)
    }
  }
  return files
}

function findUnpackedNativeFiles(nodeModulesRoot) {
  const roots = NATIVE_SCOPES.map((scope) => join(nodeModulesRoot, ...scope.split('/')))
  return roots.flatMap(walkFiles)
    .filter((path) => NATIVE_EXTENSIONS.has(extname(path).toLowerCase()))
    .sort()
}

function resolvePackageImportEntry(appArchive, packageName) {
  const packageDir = join(appArchive, 'node_modules', ...packageName.split('/'))
  const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
  const exportRoot = manifest.exports?.['.']
  const entry = typeof exportRoot === 'string'
    ? exportRoot
    : exportRoot?.import ?? manifest.main
  assert(typeof entry === 'string', `${packageName} 缺少可导入的 ESM 入口`)
  return join(packageDir, entry)
}

async function importFromArchive(appArchive, packageName) {
  return import(pathToFileURL(resolvePackageImportEntry(appArchive, packageName)).href)
}

async function runProbe(resourcesDir) {
  const resources = resolve(resourcesDir)
  const appArchive = join(resources, 'app.asar')
  const unpackedNodeModules = join(resources, 'app.asar.unpacked', 'node_modules')
  assert(existsSync(appArchive), `缺少 packaged app.asar: ${appArchive}`)
  assert(existsSync(unpackedNodeModules), `缺少 app.asar.unpacked/node_modules: ${unpackedNodeModules}`)

  const imported = new Map()
  for (const packageName of PI_PACKAGES) {
    imported.set(packageName, await importFromArchive(appArchive, packageName))
  }

  const sdk = imported.get('@earendil-works/pi-coding-agent')
  assert(typeof sdk.AuthStorage?.inMemory === 'function', 'Pi AuthStorage.inMemory 不可用')
  assert(typeof sdk.ModelRegistry?.inMemory === 'function', 'Pi ModelRegistry.inMemory 不可用')
  assert(typeof sdk.SessionManager?.create === 'function', 'Pi SessionManager.create 不可用')

  const authStorage = sdk.AuthStorage.inMemory()
  const registry = sdk.ModelRegistry.inMemory(authStorage)
  const providerId = 'profer-packaged-probe'
  registry.registerProvider(providerId, {
    name: 'Profer packaged probe',
    apiKey: 'offline-probe-key',
    api: 'openai-completions',
    baseUrl: 'http://127.0.0.1:1',
    models: [{
      id: 'offline-model',
      name: 'Offline model',
      api: 'openai-completions',
      baseUrl: 'http://127.0.0.1:1',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 4096,
      maxTokens: 1024,
    }],
  })
  assert(registry.find(providerId, 'offline-model'), '临时 Pi provider 注册失败')

  const tempRoot = mkdtempSync(join(tmpdir(), 'profer-packaged-pi-'))
  try {
    const cwd = join(tempRoot, 'workspace')
    const sessionDir = join(tempRoot, 'sessions')
    const sessionManager = sdk.SessionManager.create(cwd, sessionDir)
    assert(sessionManager.getSessionId(), 'SessionManager 未生成 session ID')
    assert(sessionManager.getCwd() === cwd, 'SessionManager cwd 初始化不一致')
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }

  const nativeFiles = findUnpackedNativeFiles(unpackedNodeModules)
  assert(nativeFiles.length > 0, 'app.asar.unpacked 中未找到 Pi native/WASM 文件')
  const normalizedRoot = unpackedNodeModules.endsWith(sep) ? unpackedNodeModules : `${unpackedNodeModules}${sep}`
  assert(nativeFiles.every((path) => path.startsWith(normalizedRoot)), 'native 文件逸出 app.asar.unpacked')

  console.log(JSON.stringify({
    ok: true,
    resources,
    imported: PI_PACKAGES,
    nativeFileCount: nativeFiles.length,
    nativeFiles: nativeFiles.map((path) => path.slice(normalizedRoot.length)),
  }, null, 2))
}

module.exports = { findUnpackedNativeFiles, resolvePackageImportEntry, runProbe }

if (require.main === module) {
  const resourcesDir = process.argv[2]
  if (!resourcesDir) {
    console.error('用法: packaged-pi-probe.cjs <packaged resources 目录>')
    process.exitCode = 2
  } else {
    runProbe(resourcesDir).catch((error) => {
      console.error(`[packaged-pi-probe] ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
      process.exitCode = 1
    })
  }
}
