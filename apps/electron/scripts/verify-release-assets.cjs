#!/usr/bin/env node
/**
 * 验证 Windows 发布资产完整性。
 *
 * 仅检查本地 out/，不访问网络、不写入文件，可由本地发布与 CI 共用。
 */
const fs = require('node:fs')
const path = require('node:path')

const appRoot = path.resolve(__dirname, '..')
const out = path.join(appRoot, 'out')
const version = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8')).version
const expected = [
  'latest.yml',
  `Profer-Setup-${version}.exe`,
  `Profer-Setup-${version}.exe.blockmap`,
]

for (const name of expected) {
  const filePath = path.join(out, name)
  if (!fs.existsSync(filePath)) {
    throw new Error(`缺少 Windows 发布资产: ${filePath}`)
  }
  if (fs.statSync(filePath).size <= 0) {
    throw new Error(`Windows 发布资产为空: ${filePath}`)
  }
  console.log(`[verify:release-assets] ${name} OK`)
}
