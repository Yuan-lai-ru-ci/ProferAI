#!/usr/bin/env node

const { readFileSync } = require('node:fs')
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
 * 纯 ESM 的 SDK 包在 CJS 主进程 bundle 里只能走动态 `await import()`。
 * 静态 import 会被 esbuild 保留成顶层 `require()`，应用加载阶段直接抛
 * `ERR_PACKAGE_PATH_NOT_EXPORTED`（exports 只有 import 条件）——0.16.27 就是这样起不来的。
 * 构建时拦住，比发出去再回滚便宜得多。
 */
const esmOnlyPackages = [
  '@earendil-works/pi-coding-agent',
  '@earendil-works/pi-agent-core',
  '@earendil-works/pi-ai',
  '@earendil-works/pi-tui',
]
const staticRequires = esmOnlyPackages.filter((pkg) => (
  bundle.includes(`require("${pkg}")`) || bundle.includes(`require('${pkg}')`)
))
if (staticRequires.length > 0) {
  console.error(
    `[verify-build-target] 主进程 bundle 静态 require 了纯 ESM 包：${staticRequires.join(', ')}；` +
    '请改用 await import()（CJS 顶层 require 会在启动时抛 ERR_PACKAGE_PATH_NOT_EXPORTED）。',
  )
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
