#!/usr/bin/env node
/**
 * 验证移动端 UI 构建产物完整性。
 * 在 build 链末尾调用，确保 dist/renderer/tablet/index.html 已由 vite 多入口产出，
 * 并且引用的入口 chunk 确实包含平板特有代码。
 *
 * 背景（2026-08-05 事故）：tablet/index.html 曾误写 <script src="/main.tsx">，
 * vite 把它解析成桌面入口，移动端 UI 代码完全未打包，但旧校验只看 index.html 存在，
 * 导致平板页面一直加载桌面应用而无人发现。因此这里必须检查入口 chunk 内容特征。
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
  console.error('[verify:tablet] 未找到移动端 UI 产物 index.html。请先运行 build:renderer。')
  process.exit(1)
}
console.log(`[verify:tablet] 移动端 UI 产物已就绪: ${found}`)

// ---- 解析入口 chunk：<script type="module" crossorigin src="..."> ----
const html = fs.readFileSync(found, 'utf-8')
const scriptMatch = html.match(/<script[^>]*src="([^"]+)"/)
if (!scriptMatch) {
  console.error('[verify:tablet] tablet/index.html 中未找到模块脚本引用。')
  process.exit(1)
}
const scriptSrc = scriptMatch[1]
const chunkPath = path.resolve(path.dirname(found), scriptSrc)
if (!fs.existsSync(chunkPath)) {
  console.error(`[verify:tablet] 入口 chunk 缺失: ${chunkPath}`)
  process.exit(1)
}
console.log(`[verify:tablet] 入口 chunk 存在: ${path.relative(process.cwd(), chunkPath)}`)

// ---- 检查 chunk 内容特征（平板特有字符串；缺失说明又发生了入口错配） ----
const TABLEt_MARKERS = ['profer-remote-token', 'emitTabletAgentStreamEvent', 'tablet-error-banner']
const chunk = fs.readFileSync(chunkPath, 'utf-8')
// 入口 chunk 可能只含平板特有代码；共享组件在其它 chunk。任一特征命中即认为平板代码已打包。
const matched = TABLEt_MARKERS.filter((marker) => chunk.includes(marker))
if (matched.length === 0) {
  console.error(`[verify:tablet] 入口 chunk 中未发现平板特有代码（${TABLEt_MARKERS.join(', ')}）。`)
  console.error('  很可能 tablet/index.html 的 script src 又指回了桌面入口（/main.tsx）。')
  process.exit(1)
}
console.log(`[verify:tablet] 平板代码特征命中: ${matched.join(', ')}`)
console.log('[verify:tablet] OK')
