#!/usr/bin/env node

const { existsSync, readFileSync } = require('node:fs')
const { builtinModules, createRequire } = require('node:module')
const { resolve } = require('node:path')

const expectedTarget = process.argv[2]
const bundlePath = process.argv[3] || 'dist/main.cjs'

if (!['oss', 'commercial'].includes(expectedTarget)) {
  console.error('Usage: node scripts/verify-build-target.cjs <oss|commercial> [bundlePath]')
  process.exit(2)
}

const bundle = readFileSync(resolve(bundlePath), 'utf8')
// build:main 使用 --minify-whitespace --minify-identifiers（不启用 --minify-syntax，
// 避免 esbuild 折叠三元表达式导致下面的字面量消失），匹配时对空白不敏感。
const ossLiteral = /false\s*\?\s*"oss"\s*:\s*"oss"/
const commercialLiteral = /false\s*\?\s*"oss"\s*:\s*"commercial"/
const updateFeed = 'https://updates.profer.cn/'

const hasOssTarget = ossLiteral.test(bundle)
const hasCommercialTarget = commercialLiteral.test(bundle)
const hasUpdateFeed = bundle.includes(updateFeed)

/**
 * 纯 ESM 包在 CJS 主进程 bundle 里只能走动态 `await import()`。
 * 静态 import 会被 esbuild 保留成顶层 `require()`，应用加载阶段直接抛
 * `ERR_PACKAGE_PATH_NOT_EXPORTED`（exports 只有 import 条件）——0.16.27 就是这样起不来的。
 *
 * 校验方式：从 esbuild 的 metafile 取所有 external 的 require-call，逐字尝试 `require.resolve()`。
 * 这一步与 Electron 加载产物时的解析行为一致，所以不靠硬编码包名——新引入的纯 ESM SDK、
 * 以及 `pkg/subpath` 形式的子路径导出（如 `@earendil-works/pi-ai/compat`）都会被抓到。
 * 只有 metafile 不存在时才退回扫描 bundle 源码（regex，可能包含字符串字面量中的假阳性）。
 */
const nodeBuiltins = new Set(builtinModules)
const appRequire = createRequire(__filename)

function readBundleExternalRequires(resolvedBundlePath) {
  const metaPath = resolvedBundlePath.replace(/\.cjs$/, '.meta.json')
  if (existsSync(metaPath)) {
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
    const specifiers = new Set()
    for (const output of Object.values(meta.outputs ?? {})) {
      for (const item of output.imports ?? []) {
        if (item.external && item.kind === 'require-call') specifiers.add(item.path)
      }
    }
    return { specifiers: [...specifiers], source: `metafile ${metaPath}` }
  }
  const source = readFileSync(resolvedBundlePath, 'utf8')
  const pattern = /require\(\s*(["'])([^"'()]+)\1\s*\)/g
  const specifiers = new Set()
  for (const match of source.matchAll(pattern)) {
    const specifier = match[2]
    if (specifier.startsWith('.') || specifier.startsWith('/')) continue
    specifiers.add(specifier)
  }
  return { specifiers: [...specifiers], source: 'bundle 源码扫描（metafile 缺失）' }
}

const { specifiers, source } = readBundleExternalRequires(resolve(bundlePath))
const notRequireable = []
const unresolvedOptional = []
for (const specifier of specifiers) {
  if (specifier === 'electron' || specifier.startsWith('node:')) continue
  if (nodeBuiltins.has(specifier)) continue
  try {
    appRequire.resolve(specifier)
  } catch (error) {
    if (error && error.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') notRequireable.push({ specifier, message: error.message.split('\n')[0] })
    // 可选依赖（ws 的 bufferutil / utf-8-validate）本来就可能不存在，且调用方包了 try/catch。
    else if (error && (error.code === 'MODULE_NOT_FOUND' || error.code === 'ERR_MODULE_NOT_FOUND')) unresolvedOptional.push(specifier)
    else throw error
  }
}
// 源码扫描模式会把字符串字面量里的 require("ajv/...") 之类当成 specifier，这类噪声不报。
if (unresolvedOptional.length > 0 && source.startsWith('metafile')) {
  console.warn(`[verify-build-target] 这些 external 当前未安装（仅当调用方包了 try/catch 才安全）：${unresolvedOptional.join(', ')}`)
}
if (notRequireable.length > 0) {
  console.error(
    '[verify-build-target] 主进程 bundle 顶层 require 了无法 require 的纯 ESM external（来源: ' + source + '）：',
  )
  for (const item of notRequireable) console.error(`  - ${item.specifier}: ${item.message}`)
  console.error('  改用 await import()；否则应用加载阶段会抛 ERR_PACKAGE_PATH_NOT_EXPORTED，窗口根本起不来。')
  process.exit(1)
}

if (expectedTarget === 'oss') {
  if (!hasOssTarget || hasCommercialTarget) {
    console.error('[verify-build-target] OSS build target mismatch: expected oss bundle.')
    process.exit(1)
  }
  if (!hasUpdateFeed) {
    console.error('[verify-build-target] OSS build is missing the configured updater feed.')
    process.exit(1)
  }
}

if (expectedTarget === 'commercial') {
  if (!hasCommercialTarget || hasOssTarget) {
    console.error('[verify-build-target] Commercial build target mismatch: expected commercial bundle.')
    process.exit(1)
  }
  if (!hasUpdateFeed) {
    console.error('[verify-build-target] Commercial build is missing the configured updater feed.')
    process.exit(1)
  }
}

console.log(`[verify-build-target] ${expectedTarget} bundle verified: ${bundlePath}`)
