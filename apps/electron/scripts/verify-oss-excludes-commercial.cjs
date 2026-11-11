#!/usr/bin/env node
/**
 * verify-oss-excludes-commercial
 *
 * 校验构建产物里有没有混进商业代码。两条独立证据链：
 *   1. esbuild metafile 的模块清单 —— 压缩改名也改不掉源文件路径，这是主证据。
 *   2. 产物体内的字符串标记 —— 兜住「模块已抽走、但某条商业分支还留在共享文件里」
 *      这种情况，模块级检查看不出来。
 *
 * 基线机制：`commercial-surface.baseline.json` 记录当前已知的商业残留。
 * 脚本只阻断「基线之外的新增违规」，基线内的只报告数量；基线只能缩小不能扩大。
 * 迁移推进时把已清理的条目从基线删掉，最后基线清空 + `--strict` 即可进 CI 硬阻断。
 *
 * 用法：
 *   node scripts/verify-oss-excludes-commercial.cjs [--target oss|commercial]
 *        [--metafile dist/main.meta.json] [--bundle dist/main.cjs]
 *        [--strict] [--update-baseline]
 *   --strict          忽略基线，任何商业残留都算失败（发布前/基线清空后用）
 *   --update-baseline 把当前的商业残留写回基线（只允许新增「已存在」项，不允许掩盖新违规前先人工确认）
 *
 * 退出码：0 通过 / 1 校验失败 / 2 用法或 IO 错误
 */
const { readFileSync, writeFileSync, existsSync } = require('node:fs')
const { resolve } = require('node:path')

const SCRIPT_DIR = __dirname
const CONFIG_PATH = resolve(SCRIPT_DIR, 'commercial-surface.json')
const BASELINE_PATH = resolve(SCRIPT_DIR, 'commercial-surface.baseline.json')

function parseArgs(argv) {
  const opts = {
    target: 'oss',
    metafile: 'dist/main.meta.json',
    bundle: 'dist/main.cjs',
    strict: false,
    updateBaseline: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--strict') opts.strict = true
    else if (arg === '--update-baseline') opts.updateBaseline = true
    else if (arg === '--target') opts.target = argv[++i]
    else if (arg === '--metafile') opts.metafile = argv[++i]
    else if (arg === '--bundle') opts.bundle = argv[++i]
    else if (arg === '--help' || arg === '-h') {
      console.log(readFileSync(__filename, 'utf8').split('*/')[0].replace(/^#!.*\n/, ''))
      process.exit(0)
    } else {
      console.error(`[commercial-surface] 未知参数: ${arg}`)
      process.exit(2)
    }
  }
  if (!['oss', 'commercial'].includes(opts.target)) {
    console.error('[commercial-surface] --target 只能是 oss 或 commercial')
    process.exit(2)
  }
  return opts
}

function readJson(path, fallback) {
  if (!existsSync(path)) {
    if (fallback !== undefined) return fallback
    console.error(`[commercial-surface] 缺少文件: ${path}`)
    process.exit(2)
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    console.error(`[commercial-surface] 解析失败 ${path}: ${err.message}`)
    process.exit(2)
  }
}

/** 从 metafile 取出所有输入模块路径 */
function readModulePaths(metafilePath) {
  const metafile = readJson(metafilePath)
  const inputs = metafile.inputs ?? {}
  return Object.keys(inputs).map(normalizeModulePath)
}

/** esbuild 输出形如 `../../packages/core/src/x.ts`；统一成仓库内可读形式 */
function normalizeModulePath(raw) {
  const unified = raw.replace(/\\/g, '/')
  const marker = 'packages/'
  const idx = unified.lastIndexOf(marker)
  // 只把跨包路径规整到 packages/...，应用内路径原样保留（与清单里的 ^src/main/lib/ 对得上）
  if (unified.includes('/packages/') && idx !== -1) return unified.slice(idx)
  return unified.replace(/^\.\//, '')
}

function findModuleViolations(modulePaths, patterns) {
  const compiled = patterns.map((pattern) => ({ pattern, re: new RegExp(pattern) }))
  const hits = new Map()
  for (const modulePath of modulePaths) {
    for (const { pattern, re } of compiled) {
      if (re.test(modulePath)) {
        if (!hits.has(modulePath)) hits.set(modulePath, pattern)
        break
      }
    }
  }
  return hits
}

function countMarker(bundle, marker) {
  let count = 0
  let from = 0
  for (;;) {
    const idx = bundle.indexOf(marker, from)
    if (idx === -1) return count
    count += 1
    from = idx + marker.length
  }
}

function findMarkerViolations(bundle, markers) {
  const hits = new Map()
  for (const marker of markers) {
    const count = countMarker(bundle, marker)
    if (count > 0) hits.set(marker, count)
  }
  return hits
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  const config = readJson(CONFIG_PATH)
  const baseline = readJson(BASELINE_PATH, { modules: [], markers: {} })

  const modulePatterns = config.commercialModules ?? []
  const markers = config.commercialStringMarkers ?? []
  if (modulePatterns.length === 0 && markers.length === 0) {
    console.error('[commercial-surface] 清单为空，校验没有意义；请检查 commercial-surface.json')
    process.exit(2)
  }

  if (!existsSync(resolve(opts.metafile))) {
    console.error(`[commercial-surface] 找不到 metafile: ${opts.metafile}`)
    console.error('[commercial-surface] 先执行 `bun run build:main`（或 build:main-commercial）生成，')
    console.error('[commercial-surface] 该脚本只认带 --metafile 的构建产物，字符串扫描不足以证明模块已排除。')
    process.exit(2)
  }
  if (!existsSync(resolve(opts.bundle))) {
    console.error(`[commercial-surface] 找不到产物: ${opts.bundle}`)
    process.exit(2)
  }

  const modulePaths = readModulePaths(resolve(opts.metafile))
  const bundle = readFileSync(resolve(opts.bundle), 'utf8')
  const moduleHits = findModuleViolations(modulePaths, modulePatterns)
  const markerHits = findMarkerViolations(bundle, markers)

  console.log(`[commercial-surface] 目标=${opts.target} 模块数=${modulePaths.length} metafile=${opts.metafile}`)

  if (opts.target === 'commercial') {
    // 反向校验：商业包必须真的包含商业实现，避免「把功能改没了还以为在发商业版」
    const modulePaths = readModulePaths(resolve(opts.metafile))
    const required = config.commercialRequiredModules ?? []
    if (required.length === 0) {
      console.error('[commercial-surface] commercialRequiredModules 为空，反向校验没有意义')
      process.exit(2)
    }
    const missing = required.filter((pattern) => {
      const re = new RegExp(pattern)
      return !modulePaths.some((modulePath) => re.test(modulePath))
    })
    if (missing.length > 0) {
      console.error('[commercial-surface] 商业产物缺少商业模块：')
      for (const pattern of missing) console.error(`  - ${pattern}`)
      process.exit(1)
    }
    console.log(`[commercial-surface] 商业产物包含全部 ${required.length} 个必需商业模块，符合预期`)
    return
  }

  const baselineModules = new Set(baseline.modules ?? [])
  const baselineMarkers = baseline.markers ?? {}
  const newModules = [...moduleHits.keys()].filter((modulePath) => !baselineModules.has(modulePath))
  const newMarkers = [...markerHits.keys()].filter((marker) => baselineMarkers[marker] === undefined)
  const knownModules = [...moduleHits.keys()].filter((modulePath) => baselineModules.has(modulePath))
  const knownMarkers = [...markerHits.keys()].filter((marker) => baselineMarkers[marker] !== undefined)

  if (opts.updateBaseline) {
    const next = {
      $comment: '已知商业残留基线。只允许缩小。清理完某项后从对应数组/对象里删掉，脚本会开始阻断它的回归。',
      modules: [...new Set([...baselineModules, ...moduleHits.keys()])].sort(),
      markers: { ...Object.fromEntries(knownMarkers.map((m) => [m, baselineMarkers[m]])), ...Object.fromEntries(markerHits) },
    }
    for (const marker of newMarkers) next.markers[marker] = markerHits.get(marker)
    next.markers = Object.fromEntries(Object.entries(next.markers).sort(([a], [b]) => a.localeCompare(b)))
    writeFileSync(BASELINE_PATH, `${JSON.stringify(next, null, 2)}\n`)
    console.log(`[commercial-surface] 基线已更新: ${BASELINE_PATH}`)
    return
  }

  const effectiveNewModules = opts.strict ? [...moduleHits.keys()] : newModules
  const effectiveNewMarkers = opts.strict ? [...markerHits.keys()] : newMarkers

  if (knownModules.length > 0 || knownMarkers.length > 0) {
    console.log(`[commercial-surface] 基线内待清理：模块 ${knownModules.length} 个 / 标记 ${knownMarkers.length} 个（不阻断）`)
    for (const modulePath of knownModules) console.log(`  · 模块 ${modulePath}`)
    for (const marker of knownMarkers) console.log(`  · 标记 ${marker} ×${markerHits.get(marker)}`)
  }

  if (effectiveNewModules.length > 0 || effectiveNewMarkers.length > 0) {
    console.error('[commercial-surface] 检出基线之外的商业代码进入 OSS 产物：')
    for (const modulePath of effectiveNewModules) {
      console.error(`  ✗ 模块 ${modulePath}  (匹配 ${moduleHits.get(modulePath)})`)
    }
    for (const marker of effectiveNewMarkers) {
      console.error(`  ✗ 标记 ${marker} ×${markerHits.get(marker)}`)
    }
    console.error('[commercial-surface] 处理方式：把该商业实现移出 OSS 模块图（经 edition 契约间接调用），')
    console.error('[commercial-surface] 或先用 --update-baseline 登记为已知残留并安排清理。')
    process.exit(1)
  }

  if (opts.strict && moduleHits.size === 0 && markerHits.size === 0) {
    console.log('[commercial-surface] OSS 产物不含任何商业模块与商业标记')
    return
  }
  console.log('[commercial-surface] 通过：无新增商业残留进入 OSS 产物')
}

main()
