#!/usr/bin/env node
/**
 * Skin Surface Contract v2 审计。
 *
 * 内置皮肤必须声明 manifest.contractVersion=2，并覆写完整 v2 token 集；
 * 用户皮肤始终由运行时默认 token 兼容，不参与本脚本门禁。
 *
 * 用法：node scripts/check-skin-surface-contract.mjs
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, relative } from 'node:path'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SKINS_DIR = join(ROOT, 'resources', 'skins')
const TEMPLATE_DIR = join(ROOT, 'resources', 'skin-template')
const RENDERER_COMPONENTS_DIR = join(ROOT, 'src', 'renderer', 'components')
const REQUIRED_TOKENS = [
  'shell-surface', 'raised-surface', 'sunken-surface',
  'surface-border', 'surface-border-strong',
  'input-surface', 'input-hover', 'control-surface', 'control-hover',
  'selected-surface', 'selected-foreground', 'focus-ring',
  'popover', 'dialog', 'tooltip', 'overlay', 'overlay-foreground',
  'message-surface', 'message-user-surface', 'code-bg', 'code-fg',
  'blockquote-surface', 'table-header-surface',
  'diff-addition-bg', 'diff-addition-fg', 'diff-deletion-bg', 'diff-deletion-fg',
  'browser-host-surface',
  'success', 'success-foreground', 'warning', 'warning-foreground',
  'info', 'info-foreground',
]
const SKIN_ID_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const FORBIDDEN_CSS_RE = /@import\b|@font-face\b|url\(\s*(['"]?)(?:https?:|file:|data:|\/\/)/i

function parseTokens(css) {
  const tokens = new Map()
  for (const match of css.matchAll(/--([a-z0-9-]+)\s*:\s*([^;{}]+);/gi)) {
    tokens.set(match[1], match[2].trim())
  }
  return tokens
}

function uncommentedCss(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

if (!existsSync(SKINS_DIR)) {
  console.error(`✗ 找不到内置皮肤目录：${SKINS_DIR}`)
  process.exit(2)
}

let failures = 0
const directories = readdirSync(SKINS_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()

for (const id of directories) {
  const dir = join(SKINS_DIR, id)
  const manifestPath = join(dir, 'manifest.json')
  const cssPath = join(dir, 'skin.css')
  const errors = []
  let manifest

  if (!SKIN_ID_RE.test(id)) errors.push('目录名不是 kebab-case id')
  if (!existsSync(manifestPath)) {
    errors.push('缺少 manifest.json')
  } else {
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''))
      if (manifest.id !== id) errors.push(`manifest.id=${JSON.stringify(manifest.id)} 与目录名不一致`)
      if (manifest.contractVersion !== 2) errors.push('manifest.contractVersion 必须为数字 2')
      if (manifest.tone !== 'light' && manifest.tone !== 'dark') errors.push('manifest.tone 必须为 light 或 dark')
    } catch (error) {
      errors.push(`manifest.json 无法解析：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  if (!existsSync(cssPath)) {
    errors.push('缺少 skin.css')
  } else {
    const css = readFileSync(cssPath, 'utf8')
    const executable = uncommentedCss(css)
    if (FORBIDDEN_CSS_RE.test(executable)) errors.push('skin.css 包含禁止的 @import/@font-face/外链/file/data URL')
    const tokens = parseTokens(css)
    const missing = REQUIRED_TOKENS.filter((token) => !tokens.has(token) || !tokens.get(token))
    if (missing.length) errors.push(`缺少 ${missing.length} 个 v2 token：${missing.join(', ')}`)
    for (const [token, value] of tokens) {
      if (!value || /[{}]/.test(value)) errors.push(`--${token} 值无效`)
    }
  }

  if (errors.length) {
    failures += 1
    console.error(`✗ ${id}`)
    for (const error of errors) console.error(`  - ${error}`)
  } else {
    const bytes = statSync(cssPath).size
    console.log(`✓ ${id}: Surface Contract v2（${bytes} bytes）`)
  }
}

// 官方模板也是公开合约的一部分：它必须与内置皮肤一样完整，避免新皮肤从一开始就退化到 v1 fallback。
{
  const manifestPath = join(TEMPLATE_DIR, 'manifest.json')
  const cssPath = join(TEMPLATE_DIR, 'skin.css')
  const errors = []
  if (!existsSync(manifestPath) || !existsSync(cssPath)) {
    errors.push('缺少 manifest.json 或 skin.css')
  } else {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''))
      if (manifest.contractVersion !== 2) errors.push('manifest.contractVersion 必须为数字 2')
      if (manifest.tone !== 'light' && manifest.tone !== 'dark') errors.push('manifest.tone 必须为 light 或 dark')
    } catch (error) {
      errors.push(`manifest.json 无法解析：${error instanceof Error ? error.message : String(error)}`)
    }
    const css = readFileSync(cssPath, 'utf8')
    const executable = uncommentedCss(css)
    if (FORBIDDEN_CSS_RE.test(executable)) errors.push('skin.css 包含禁止的 @import/@font-face/外链/file/data URL')
    const tokens = parseTokens(css)
    const missing = REQUIRED_TOKENS.filter((token) => !tokens.has(token) || !tokens.get(token))
    if (missing.length) errors.push(`缺少 ${missing.length} 个 v2 token：${missing.join(', ')}`)
  }
  if (errors.length) {
    failures += 1
    console.error('✗ skin-template')
    for (const error of errors) console.error(`  - ${error}`)
  } else {
    console.log('✓ skin-template: Surface Contract v2')
  }
}

// 业务普通表面硬编码只报告、不阻断：首次迁移保留品牌、图表、Shiki、媒体和状态语义例外，
// 但报告可在 CI 日志中暴露未来新增的中性色热点。
function collectTsxFiles(dir) {
  const files = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...collectTsxFiles(file))
    else if (entry.isFile() && /\.tsx$/.test(entry.name)) files.push(file)
  }
  return files
}

const hardcodedSurfaceRe = /(?:bg|border|text|from|to|via)-(?:slate|zinc|neutral|gray|white|black)(?:-|['"`\s])/g
const hardcodedSurfaceHits = []
for (const file of collectTsxFiles(RENDERER_COMPONENTS_DIR)) {
  const source = readFileSync(file, 'utf8')
  const matches = source.match(hardcodedSurfaceRe)
  if (matches?.length) hardcodedSurfaceHits.push(`${relative(join(ROOT, 'src', 'renderer'), file)} (${matches.length})`)
}
if (hardcodedSurfaceHits.length) {
  console.log(`\nℹ 普通中性色审计（非阻断，品牌/媒体/代码高亮等需按域复核）：${hardcodedSurfaceHits.length} 个文件`)
  for (const line of hardcodedSurfaceHits.slice(0, 20)) console.log(`  - ${line}`)
  if (hardcodedSurfaceHits.length > 20) console.log(`  - … 另有 ${hardcodedSurfaceHits.length - 20} 个文件`)
} else {
  console.log('\n✓ 普通中性色审计未发现匹配项')
}

if (failures) {
  console.error(`\n${failures}/${directories.length + 1} 个内置皮肤或官方模板不满足 Surface Contract v2。`)
  process.exit(1)
}
console.log(`\n全部 ${directories.length} 个内置皮肤与官方模板满足 Surface Contract v2 ✓`)
