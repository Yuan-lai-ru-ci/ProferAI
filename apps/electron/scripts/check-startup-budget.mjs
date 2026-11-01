#!/usr/bin/env node
/**
 * 启动关键路径预算检查
 *
 * 为什么需要它：Vite 的 `chunkSizeWarningLimit` 是**逐块**阈值，默认 500kB 是按浏览器
 * 首屏设计的。Profer 是 Electron 应用，大量块（mermaid / three / heic2any / zenuml /
 * shiki 语言包 / pdf / xlsx …）只在用户真的用到对应功能时才动态加载，把它们拆小既不减包
 * 也不提速，却会持续触发警告，最后所有人都学会无视它。
 *
 * 所以逐块警告放宽（见 vite.config.ts 的 chunkSizeWarningLimit），真正要守的边界改成
 * 「入口图」：index.html 里同步加载的 script + modulepreload + stylesheet。
 * 谁往入口里重新塞一个大依赖（例如又把 @open-file-viewer/core 或图标表静态 import 回来），
 * 这里会直接让构建失败。
 *
 * 用法：vite build 之后运行 `node scripts/check-startup-budget.mjs`
 * 退出码：0 = 在预算内；1 = 超预算或产物缺失
 */

import { readFileSync, statSync, existsSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const distDir = resolve(here, '../dist/renderer')
const indexPath = resolve(distDir, 'index.html')

/** 预算（kB）。当前实测约 3.4MB / 1.06MB gzip，留约 20% 余量。 */
const BUDGET_RAW_KB = 4096
const BUDGET_GZIP_KB = 1280

if (!existsSync(indexPath)) {
  console.error(`[启动预算] 找不到 ${indexPath}，请先执行 vite build`)
  process.exit(1)
}

const html = readFileSync(indexPath, 'utf8')

/** 收集 index.html 中会阻塞首屏的本地资源 */
function collectStartupAssets(source) {
  const assets = []
  for (const match of source.matchAll(/<(script|link)\b[^>]*>/gi)) {
    const tag = match[0]
    if (/^<script/i.test(tag)) {
      const src = tag.match(/\ssrc="([^"]+)"/)
      if (src) assets.push(src[1])
      continue
    }
    const rel = tag.match(/\srel="([^"]+)"/)?.[1] ?? ''
    if (!/(?:^|\s)(?:modulepreload|stylesheet)(?:\s|$)/.test(rel)) continue
    const href = tag.match(/\shref="([^"]+)"/)
    if (href) assets.push(href[1])
  }
  return [...new Set(assets)]
}

const assets = collectStartupAssets(html).map((ref) => ref.replace(/^\.\//, ''))
if (assets.length === 0) {
  console.error('[启动预算] index.html 里没有找到任何 script/modulepreload/stylesheet，检查解析逻辑')
  process.exit(1)
}

const rows = []
let rawTotal = 0
let gzipTotal = 0
const missing = []

for (const rel of assets) {
  const file = resolve(distDir, rel)
  if (!existsSync(file)) {
    missing.push(rel)
    continue
  }
  const raw = statSync(file).size
  const gzip = gzipSync(readFileSync(file)).length
  rawTotal += raw
  gzipTotal += gzip
  rows.push({ rel, raw, gzip })
}

if (missing.length > 0) {
  console.error(`[启动预算] 以下入口资源缺失：\n  ${missing.join('\n  ')}`)
  process.exit(1)
}

rows.sort((a, b) => b.raw - a.raw)
const kb = (bytes) => (bytes / 1024).toFixed(1)

console.log('[启动预算] 入口图（index.html 同步加载的资源）：')
for (const row of rows) {
  console.log(`  ${kb(row.raw).padStart(9)} kB  (gzip ${kb(row.gzip).padStart(7)} kB)  ${row.rel}`)
}
console.log(`  ${'-'.repeat(58)}`)
console.log(`  ${kb(rawTotal).padStart(9)} kB  (gzip ${kb(gzipTotal).padStart(7)} kB)  合计，${rows.length} 个文件`)

const overRaw = rawTotal / 1024 > BUDGET_RAW_KB
const overGzip = gzipTotal / 1024 > BUDGET_GZIP_KB

if (overRaw || overGzip) {
  console.error(
    `\n[启动预算] 超出预算：上限 ${BUDGET_RAW_KB} kB / ${BUDGET_GZIP_KB} kB(gzip)，` +
      `实际 ${kb(rawTotal)} kB / ${kb(gzipTotal)} kB(gzip)。`,
  )
  console.error(
    '  入口里多半又静态引入了本该按需加载的东西：检查新增的顶层 import，' +
      '必要时改成 React.lazy / 动态 import。',
  )
  process.exit(1)
}

console.log(`\n[启动预算] 通过（预算 ${BUDGET_RAW_KB} kB / ${BUDGET_GZIP_KB} kB gzip）`)
