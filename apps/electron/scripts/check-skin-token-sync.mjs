/**
 * 皮肤 token 双写一致性校验（只读）
 *
 * 背景：globals.css 的 theme-* 块与 resources/skins 各目录 skin.css 定义同一批主题 token。
 * 双写是设计必要——平板端/无皮肤注册场景无法通过 IPC 注入 skin.css，需要 globals.css
 * 内置 fallback（见 renderer/atoms/theme.ts applyThemeToDOM 的 theme-* 分支）。
 * 但双写必须同步维护：本脚本校验交集 token 的值完全一致，防漂移。
 *
 * 用法：node scripts/check-skin-token-sync.mjs
 * 退出码：0=一致；1=存在漂移（打印差异）；2=结构错误（块缺失）
 */
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url)) // 指向 apps/electron/
const GLOBALS = `${ROOT}src/renderer/styles/globals.css`
const SKINS = `${ROOT}resources/skins`

const THEMES = ['ocean-light', 'ocean-dark', 'forest-light', 'forest-dark', 'slate-light', 'slate-dark', 'terminal-dark', 'mist-paper-dark']

function parseTokens(css) {
  const tokens = {}
  for (const m of css.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) tokens[m[1]] = m[2].trim()
  return tokens
}

/** 提取 .theme-NAME 顶层块（按花括号深度扫描，容忍嵌套） */
function themeBlock(css, name) {
  const start = css.indexOf(`.theme-${name} {`)
  if (start === -1) return null
  let depth = 0
  let i = start
  for (; i < css.length; i++) {
    const ch = css[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) break
    }
  }
  return css.slice(start, i + 1)
}

let failures = 0
for (const t of THEMES) {
  const block = themeBlock(readFileSync(GLOBALS, 'utf8'), t)
  if (!block) {
    console.error(`✗ ${t}: globals.css 缺少 .theme-${t} 块`)
    failures++
    continue
  }
  const skinFile = `${SKINS}/${t}/skin.css`
  if (!existsSync(skinFile)) {
    console.warn(`⚠ ${t}: 无 skin 目录（纯 fallback 主题，跳过 skin 对比）`)
    continue
  }
  const g = parseTokens(block)
  const s = parseTokens(readFileSync(skinFile, 'utf8'))
  const drift = Object.entries(g).filter(([k, v]) => s[k] && s[k] !== v)
  const onlyGlobals = Object.keys(g).filter((k) => !(k in s))
  if (drift.length > 0 || onlyGlobals.length > 0) {
    console.error(`✗ ${t}: 双写漂移`)
    for (const [k, gv, sv] of drift.slice(0, 8)) console.error(`    --${k}: globals=${gv} | skin=${sv}`)
    for (const k of onlyGlobals.slice(0, 8)) console.error(`    --${k}: 仅 globals 定义，skin 缺失`)
    failures++
  } else {
    console.log(`✓ ${t}: 交集 token 一致（globals ${Object.keys(g).length} / skin ${Object.keys(s).length}）`)
  }
}

if (failures > 0) {
  console.error(`\n${failures} 个主题双写漂移。修改 token 时必须同步 globals.css 与 resources/skins/*/skin.css。`)
  process.exit(1)
}
console.log('\n全部主题双写一致 ✓')
