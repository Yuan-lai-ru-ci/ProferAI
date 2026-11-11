#!/usr/bin/env node
/**
 * 验证 macOS 签名契约（ad-hoc + 钉死 designated requirement）。
 *
 * 这是 Squirrel.Mac 自更新能否安装的**唯一**硬门槛：包必须完整有效，且满足
 * `identifier "<bundleId>"` 这个跨版本稳定的 DR。发布前必须通过。
 *
 * 不校验 notarization / Gatekeeper（spctl）——ad-hoc 签名必然 `rejected`，
 * 而 Squirrel.Mac 安装更新不依赖 spctl。
 *
 * 用法：node scripts/verify-macos-signature.cjs
 *      PROFER_ELECTRON_OUTPUT_DIR=<outDir> node scripts/verify-macos-signature.cjs
 */
const fs = require('node:fs')
const path = require('node:path')
const { PRODUCT_APP_NAME, assertMacSignatureContract } = require('./macos-signature.cjs')

if (process.platform !== 'darwin') {
  throw new Error(`verify:mac-signature 仅支持 macOS，当前为 ${process.platform}`)
}

const appRoot = path.resolve(__dirname, '..')
const outputDir = process.env.PROFER_ELECTRON_OUTPUT_DIR
  ? path.resolve(appRoot, process.env.PROFER_ELECTRON_OUTPUT_DIR)
  : path.join(appRoot, 'out')

function findAppBundle() {
  const direct = path.join(outputDir, PRODUCT_APP_NAME)
  if (fs.existsSync(direct)) return direct
  if (!fs.existsSync(outputDir)) return null
  for (const entry of fs.readdirSync(outputDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const candidate = path.join(outputDir, entry.name, PRODUCT_APP_NAME)
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

const appBundle = findAppBundle()
if (!appBundle) throw new Error(`未找到 macOS Profer.app 解包产物: ${outputDir}`)

const result = assertMacSignatureContract(appBundle)

// CI 里「提供了证书但产物仍是 ad-hoc」是最危险的静默降级：
// 自签名证书会被 afterSign 钩子判为无效并重签成 ad-hoc，签完看起来一切正常，
// 只有发布后用户下载才会发现没有发布者身份。用显式期望模式把这件事变成硬验证。
const expectedMode = process.env.PROFER_EXPECT_MAC_SIGNATURE_MODE
if (expectedMode && expectedMode !== result.signatureMode) {
  throw new Error(
    `macOS 签名模式不符合预期：期望 ${expectedMode}，实际 ${result.signatureMode}` +
    `（TeamIdentifier=${result.teamIdentifier ?? '未设置'}）。` +
    '自签名证书不能当发布证书用；要么换成 Developer ID，要么去掉证书走 ad-hoc。',
  )
}

console.log(JSON.stringify(result, null, 2))
