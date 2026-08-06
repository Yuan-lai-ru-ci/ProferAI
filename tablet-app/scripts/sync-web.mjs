/**
 * 从 Profer 桌面仓库的构建产物生成 Capacitor webDir（自包含单页）。
 *
 * 背景：vite 多入口构建把 tablet/index.html 输出到 dist/renderer/tablet/，
 * 资源引用 ../assets/...（与桌面版共享 assets 目录）。Capacitor webDir 必须是
 * 自包含的静态目录（Android 侧最终由 WebViewAssetLoader 提供），因此：
 *   1. 拷贝 dist/renderer/tablet/index.html → web/index.html
 *   2. 拷贝 dist/renderer/assets → web/assets
 *   3. 修正 index.html 内 ../assets/ 引用 → assets/
 *
 * 用法：node scripts/sync-web.mjs [--src <dist/renderer 路径>]
 */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const appRoot = resolve(here, '..')
const argSrc = process.argv.find((a, i) => a === '--src' && process.argv[i + 1])
  ? process.argv[process.argv.indexOf('--src') + 1]
  : null

// 默认指向 Profer 桌面仓库的构建产物（本仓库同级 apps/electron/dist/renderer）
const defaultSrc = resolve(appRoot, '../apps/electron/dist/renderer')
const src = argSrc ? resolve(process.cwd(), argSrc) : defaultSrc
const webDir = resolve(appRoot, 'web')

const tabletIndex = resolve(src, 'tablet/index.html')
if (!existsSync(tabletIndex)) {
  console.error(`[sync-web] 未找到平板产物: ${tabletIndex}`)
  console.error('[sync-web] 请先执行 Profer 桌面仓库的 bun run build:renderer')
  process.exit(1)
}

// 1. 清空并重建 webDir
rmSync(webDir, { recursive: true, force: true })
mkdirSync(webDir, { recursive: true })

// 2. 拷贝 tablet/index.html 为 web/index.html
cpSync(tabletIndex, resolve(webDir, 'index.html'))

// 3. 拷贝共享 assets
const assetsSrc = resolve(src, 'assets')
if (existsSync(assetsSrc)) {
  cpSync(assetsSrc, resolve(webDir, 'assets'), { recursive: true })
}

// 4. 修正 ../assets/ 引用（html 内 script/link，以及 js 内运行时相对路径不涉及）
const indexPath = resolve(webDir, 'index.html')
let html = readFileSync(indexPath, 'utf-8')
html = html.replace(/\.\.\/assets\//g, 'assets/')
writeFileSync(indexPath, html, 'utf-8')

// 5. 报告产物统计
function dirSize(p) {
  let total = 0
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = resolve(d, e.name)
      if (e.isDirectory()) walk(full)
      else total += statSync(full).size
    }
  }
  walk(p)
  return total
}
console.log(`[sync-web] 平板产物已同步到 ${webDir}`)
console.log(`[sync-web] index.html: ${(statSync(indexPath).size / 1024).toFixed(1)} KB, assets: ${(dirSize(resolve(webDir, 'assets')) / 1024 / 1024).toFixed(2)} MB`)
console.log('[sync-web] 引用修正完成（../assets/ → assets/）')
