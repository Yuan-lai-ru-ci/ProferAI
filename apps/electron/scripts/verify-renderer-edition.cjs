#!/usr/bin/env node
/**
 * 校验 renderer 产物确实属于对应发行版。
 *
 * 背景：renderer 由 Vite 打包，发行版常量 `__PROFER_BUILD_TARGET__` 来自
 * `vite build --mode commercial`（见 vite.config.ts）。商业版脚本一旦漏传 `--mode`，
 * 产物会静默变成开源版界面 —— 功能没坏，但商业包看不到登录/额度/官方生图，属于典型
 * 「构建参数写错但没人发现」的事故。
 *
 * 这里用一条**只在商业版分支里存在**的界面文案作为哨兵：开源版必须消失（死代码折叠），
 * 商业版必须存在。哨兵一旦被产品文案改动，两边都会红，正好提醒同步更新。
 *
 * 用法：node scripts/verify-renderer-edition.cjs --target oss|commercial
 */
const fs = require('node:fs')
const path = require('node:path')

const appRoot = path.resolve(__dirname, '..')
const rendererDir = process.env.PROFER_RENDERER_DIR
  ? path.join(path.resolve(process.env.PROFER_RENDERER_DIR), 'assets')
  : path.join(appRoot, 'dist', 'renderer', 'assets')

const args = process.argv.slice(2)
const targetIndex = args.indexOf('--target')
const target = targetIndex === -1 ? 'oss' : args[targetIndex + 1]
if (target !== 'oss' && target !== 'commercial') {
  throw new Error(`--target 只能是 oss 或 commercial，实际为 ${target ?? '(缺失)'}`)
}

if (!fs.existsSync(rendererDir)) {
  throw new Error(`未找到 renderer 产物目录：${rendererDir}（先运行 build:renderer）`)
}

const bundles = fs
  .readdirSync(rendererDir)
  .filter((name) => name.endsWith('.js'))
  .map((name) => ({ name, text: fs.readFileSync(path.join(rendererDir, name), 'utf8') }))

if (bundles.length === 0) {
  throw new Error(`renderer 产物里没有 JS 文件：${rendererDir}`)
}

/** 只在商业版渲染的界面文案（ToolSettings 的「Profer 官方生图」开关）。 */
const COMMERCIAL_ONLY_MARKERS = ['官方生图']

function findMarker(marker) {
  return bundles.filter((bundle) => bundle.text.includes(marker)).map((bundle) => bundle.name)
}

if (target === 'oss') {
  for (const marker of COMMERCIAL_ONLY_MARKERS) {
    const found = findMarker(marker)
    if (found.length > 0) {
      throw new Error(
        `开源版 renderer 产物里出现了商业版界面文案「${marker}」（${found.join(', ')}）。` +
        '检查是否有人把商业逻辑移出了 __PROFER_BUILD_TARGET__ 分支。',
      )
    }
  }
  console.log(`[verify:renderer-edition] oss 产物不含商业版界面文案（检查 ${bundles.length} 个 JS 文件）`)
} else {
  for (const marker of COMMERCIAL_ONLY_MARKERS) {
    if (findMarker(marker).length === 0) {
      throw new Error(
        `商业版 renderer 产物缺少界面文案「${marker}」。` +
        '最常见原因是构建时没传 --mode commercial（应走 build:renderer:commercial）。',
      )
    }
  }
  console.log(`[verify:renderer-edition] commercial 产物含商业版界面文案（检查 ${bundles.length} 个 JS 文件）`)
}
