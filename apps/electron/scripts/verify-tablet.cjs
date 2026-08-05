#!/usr/bin/env node
/**
 * 验证平板 UI 构建产物是否存在。
 * 在 build 链末尾调用，确保 dist/renderer/tablet/index.html 已由 vite 多入口产出。
 */
const fs = require('fs')
const path = require('path')

// 兼容从 apps/electron 或仓库根运行
const host = process.cwd()
const candidates = [
  path.join(host, 'dist', 'renderer', 'tablet', 'index.html'),
  path.join(host, 'apps', 'electron', 'dist', 'renderer', 'tablet', 'index.html'),
]

const found = candidates.find((p) => fs.existsSync(p))
if (!found) {
  console.error('[verify:tablet] 未找到平板 UI 产物 index.html。请先运行 build:renderer。')
  process.exit(1)
}
console.log(`[verify:tablet] 平板 UI 产物已就绪: ${found}`)
