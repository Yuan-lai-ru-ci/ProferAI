#!/usr/bin/env node
/**
 * 验证未签名 Windows 正式发布资产。
 * 保留版本、大小、SHA-512、CLI 和 unpacked 目录完整性校验，跳过签名门禁。
 */
const { spawnSync } = require('node:child_process')
const path = require('node:path')

const verifier = path.join(__dirname, 'verify-release-assets.cjs')
const result = spawnSync(process.execPath, [verifier], {
  cwd: path.resolve(__dirname, '..'),
  stdio: 'inherit',
  env: { ...process.env, PROFER_UNSIGNED_RELEASE: '1' },
})

if (result.error) throw result.error
process.exit(result.status ?? 1)
