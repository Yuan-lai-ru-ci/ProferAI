#!/usr/bin/env node
/**
 * 把 WebUI 前端产物同步进 Electron 资源目录，并生成预压缩副本。
 *
 * 为什么需要这一步：前端源码在 Profer-pocket 仓的独立子工程 `webui/`（独立 vite 配置），
 * 而桌面端要从 `resources/webui` 托管静态页。中间没有任何自动衔接 —— 之前只能靠手工拷贝，
 * 结果就是「本地能打开、安装包里 503」。现在由本脚本负责搬运，缺产物时**默认构建失败**，
 * 不再静默产出没有 WebUI 的安装包。
 *
 * 用法：
 *   node scripts/sync-webui-assets.mjs             # 严格模式（打包用）：缺产物直接失败
 *   node scripts/sync-webui-assets.mjs --optional  # 宽松模式（日常开发）：缺产物只告警
 *
 * 环境变量：
 *   PROFER_WEBUI_SRC  指定源目录（默认 ../../../Profer-pocket/webui/dist）
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliCompressSync, constants as zlibConstants, gzipSync } from 'node:zlib'

const here = dirname(fileURLToPath(import.meta.url))
const appDir = resolve(here, '..')
const destDir = join(appDir, 'resources', 'webui')
const optional = process.argv.includes('--optional')
const sourceDir = resolve(
  process.env.PROFER_WEBUI_SRC?.trim()
  || join(appDir, '..', '..', '..', 'Profer-pocket', 'webui', 'dist'),
)

function fail(message) {
  if (optional) {
    console.warn(`[webui-assets] 跳过同步：${message}`)
    console.warn('[webui-assets] 开发期可忽略；打包前必须先在 Profer-pocket 执行 `bun run build:webui`。')
    process.exit(0)
  }
  console.error(`[webui-assets] ${message}`)
  console.error('')
  console.error('修复方式（二选一）：')
  console.error('  1. 在 Profer-pocket 仓执行 `bun run build:webui`，然后重新构建；')
  console.error('  2. 用 PROFER_WEBUI_SRC=<webui/dist 目录> 指向已有产物。')
  console.error('')
  console.error('确实要出一个不带 WebUI 的包时，显式设置 PROFER_WEBUI_OPTIONAL=1。')
  process.exit(1)
}

if (process.env.PROFER_WEBUI_OPTIONAL === '1') {
  console.warn('[webui-assets] PROFER_WEBUI_OPTIONAL=1：本次构建不要求 WebUI 产物')
  process.exit(0)
}

const indexPath = join(sourceDir, 'index.html')
if (!existsSync(indexPath)) fail(`找不到 WebUI 产物：${indexPath}`)

const assetsDir = join(sourceDir, 'assets')
const hashedEntry = existsSync(assetsDir)
  && readdirSync(assetsDir).some((name) => /^index-.*\.js$/.test(name))
if (!hashedEntry) fail(`产物缺少 assets/index-*.js：${assetsDir}`)

rmSync(destDir, { recursive: true, force: true })
mkdirSync(destDir, { recursive: true })
cpSync(sourceDir, destDir, { recursive: true })

/** 文本类产物才值得预压缩；图片/字体压不动，白白多占体积。 */
const COMPRESSIBLE = /\.(html|js|mjs|css|json|svg|map)$/i

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(full)
      continue
    }
    if (!COMPRESSIBLE.test(entry.name)) continue
    const body = readFileSync(full)
    // 太小的文件压缩后反而更大，且收益可以忽略
    if (body.byteLength < 1024) continue
    writeFileSync(`${full}.br`, brotliCompressSync(body, {
      params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 },
    }))
    writeFileSync(`${full}.gz`, gzipSync(body, { level: 9 }))
  }
}

walk(destDir)

/** 汇总给构建日志：出问题时一眼能看出「拷的是哪一版」。 */
const stamp = readdirSync(join(destDir, 'assets'))
  .filter((name) => /^index-.*\.js$/.test(name))
  .join(', ')
let total = 0
const stack = [destDir]
while (stack.length > 0) {
  const dir = stack.pop()
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) stack.push(full)
    else total += statSync(full).size
  }
}
console.log(`[webui-assets] 已同步 ${sourceDir} → ${destDir}`)
console.log(`[webui-assets] 入口: ${stamp || '(未找到)'}；合计 ${(total / 1024).toFixed(0)} KB（含预压缩副本）`)
