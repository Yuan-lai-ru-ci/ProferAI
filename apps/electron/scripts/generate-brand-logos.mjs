#!/usr/bin/env node
/**
 * 生成 Profer 品牌 Logo 变体与 macOS 菜单栏托盘图标。
 *
 * 背景：应用主图标在 2026-09-14 换成了新的「P」形标记（resources/icon.svg），
 * 但 profer-logos/ 下那批 logo 还是更早的「阶梯条纹」版本 —— 菜单栏托盘图标、
 * 「远程连接 → 品牌素材」和外观设置里的应用图标变体都在用它，属于换标后的残留。
 * 本脚本用新标记的几何把整批资源一次性重做，保证只有一处几何定义、可重复生成。
 *
 * 光栅化后端用 macOS 自带 sips（CoreGraphics 的 SVG 渲染），
 * 不依赖 rsvg-convert / ImageMagick —— 新版 macOS 上 sips 可直接读 SVG，
 * 且对同一份 icon.svg 的输出与仓库里已提交的 icon.png 字节一致。
 *
 * 用法：node scripts/generate-brand-logos.mjs
 */

import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const ELECTRON_DIR = join(SCRIPT_DIR, '..')
const LOGO_DIR = join(ELECTRON_DIR, 'resources', 'profer-logos')
const TRAY_SVG = join(LOGO_DIR, 'icon.svg')
const RENDERER_LOGO_DIR = join(ELECTRON_DIR, 'src', 'renderer', 'assets', 'bots', 'profer-logos')

// ─────────────────────────── 几何定义 ───────────────────────────

/**
 * 新标记的几何，坐标取自 resources/icon.svg（标记自身 100×100 包围盒，比例与原图一致）。
 * 原始数值：主体 689×689 / 圆角 150，缺口 336×509 起点 (579,376)，竖条 187×370 起点 (728,515)，
 * 全部相对主体左上角 (226,196) 归一化到 0..100。
 */
const MARK_BOX = 100
const MARK_BODY_RADIUS = 21.77
const MARK_NOTCH = { x: 51.23, y: 26.13, w: 48.77, h: 73.87 }
const MARK_BAR = { x: 72.86, y: 46.3, w: 27.14, h: 53.7 }

/** 主体路径：圆角方块减去右下缺口后剩下的 Γ 形（缺口与竖条在缺口内的位置见上） */
const MARK_BODY_PATH = [
  'M21.77 0H78.23A21.77 21.77 0 0 1 100 21.77V26.13H51.23V100H21.77',
  'A21.77 21.77 0 0 1 0 78.23V21.77A21.77 21.77 0 0 1 21.77 0Z',
].join('')

/** 竖条相对主体的不透明度：复刻主图标里「米白主体 + 灰色竖条」的两段式关系 */
const MARK_BAR_OPACITY = 0.55

/** 底板沿用 macOS Big Sur 图标规范：1024 画布内 824×824 圆角矩形，边距 100，圆角 185 */
const CANVAS = 1024
const PLATE = { x: 100, y: 100, size: 824, radius: 185 }
/** 标记在底板上的边长（px），约合底板的 51% */
const MARK_SIZE = 420

/** 托盘图标：66×66 画布（22pt @3x），图形占 77%，四周留安全边距 */
const TRAY_CANVAS = 66
const TRAY_MARK_SIZE = 51

// ─────────────────────────── 变体定义 ───────────────────────────

/**
 * 14 个变体，id 必须与 resolveAppIconPath / ProferLogoSettings / AppearanceSettings 中的一致，
 * 否则「应用图标变体」和「品牌素材下载」会找不到文件。
 * bg 为 null 表示透明底；gradient 与 bg 二选一。
 */
const VARIANTS = [
  { id: 'black', bg: '#000000', mark: '#F2F0EC' },
  { id: 'white', bg: '#FFFFFF', mark: '#111111' },
  { id: 'blue', bg: '#1A306C', mark: '#FFFFFF' },
  { id: 'purple', bg: '#411A84', mark: '#FFFFFF' },
  { id: 'gradient', gradient: ['#1263F2', '#7C3AED'], mark: '#FFFFFF' },
  { id: 'transparent', bg: null, mark: '#111111' },
  { id: 'coral', bg: '#FD6E5C', mark: '#FFFFFF' },
  { id: 'veri-peri', bg: '#656BA9', mark: '#FFFFFF' },
  { id: 'viva-magenta', bg: '#B02544', mark: '#FFFFFF' },
  { id: 'mocha-mousse', bg: '#A2745D', mark: '#FFFFFF' },
  { id: 'emerald', bg: '#059071', mark: '#FFFFFF' },
  { id: '8bit', bg: '#010101', mark: '#FFFFFF', style: 'pixel' },
  { id: 'cyberpunk', bg: '#0F061D', mark: '#22D3EE', style: 'neon' },
  { id: 'futuristic', bg: '#84817E', mark: '#FFFFFF', style: 'metal' },
]

// ─────────────────────────── 几何工具 ───────────────────────────

/** 点是否落在圆角矩形内（圆角半径 r，矩形左上角在原点） */
function inRoundedRect(x, y, w, h, r) {
  if (x < 0 || y < 0 || x > w || y > h) return false
  // 四个角的圆心
  const cx = x < r ? r : x > w - r ? w - r : x
  const cy = y < r ? r : y > h - r ? h - r : y
  if (cx === x && cy === y) return true
  const dx = x - cx
  const dy = y - cy
  return dx * dx + dy * dy <= r * r
}

/** 点是否属于标记实体（主图标里「主体 + 竖条」的并集，缺口为镂空） */
function inMark(x, y) {
  const inBody = inRoundedRect(x, y, MARK_BOX, MARK_BOX, MARK_BODY_RADIUS)
  const inNotch =
    x >= MARK_NOTCH.x && y >= MARK_NOTCH.y && x <= MARK_NOTCH.x + MARK_NOTCH.w && y <= MARK_NOTCH.y + MARK_NOTCH.h
  if (inBody && !inNotch) return true
  return x >= MARK_BAR.x && y >= MARK_BAR.y && x <= MARK_BAR.x + MARK_BAR.w && y <= MARK_BAR.y + MARK_BAR.h
}

// ─────────────────────────── SVG 片段 ───────────────────────────

/**
 * 标记主体 + 竖条，按 size 缩放到 (x,y) 处。
 * stroke 只接受单层：同一元素上重复出现 stroke 属性会被 sips 的 SVG 解析器拒绝。
 * options.scale 围绕标记中心缩放（做外发光时用），options.opacity 作用于整组。
 */
function markGroup(x, y, size, fill, options = {}) {
  const scale = (size / MARK_BOX) * (options.scale ?? 1)
  const center = size / 2
  const tx = x + center - (MARK_BOX / 2) * scale
  const ty = y + center - (MARK_BOX / 2) * scale
  const barOpacity = options.solidBar ? 1 : MARK_BAR_OPACITY
  const barFill = options.barFill ?? fill
  const groupOpacity = options.opacity == null ? '' : ` opacity="${options.opacity}"`
  const stroke = options.stroke
    ? ` stroke="${options.stroke.color}" stroke-width="${options.stroke.width}" stroke-opacity="${options.stroke.opacity}"`
    : ''
  return [
    `<g transform="translate(${tx.toFixed(2)} ${ty.toFixed(2)}) scale(${scale.toFixed(4)})"${groupOpacity}>`,
    `<path d="${MARK_BODY_PATH}" fill="${fill}"${stroke} />`,
    `<rect x="${MARK_BAR.x}" y="${MARK_BAR.y}" width="${MARK_BAR.w}" height="${MARK_BAR.h}" fill="${barFill}" fill-opacity="${barOpacity}"${stroke} />`,
    `</g>`,
  ].join('\n    ')
}

/** 像素风：把标记按网格二值化后逐格填充 */
function markPixelGroup(x, y, size, fill, cells = 16) {
  // 直接在输出像素坐标里取整：相邻格子共享同一条整数边界，否则浮点边界会在
  // 相邻矩形之间留下亚像素级细缝，1024 下会看到明显的网格线。
  const step = size / cells
  const edge = (index) => Math.round(x + index * step)
  const rects = []
  for (let row = 0; row < cells; row += 1) {
    for (let col = 0; col < cells; col += 1) {
      const unit = MARK_BOX / cells
      if (!inMark((col + 0.5) * unit, (row + 0.5) * unit)) continue
      const [x0, x1, y0, y1] = [edge(col), edge(col + 1), edge(row), edge(row + 1)]
      rects.push(`<rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" fill="${fill}" />`)
    }
  }
  return `<g>\n      ${rects.join('\n      ')}\n    </g>`
}

/** 把 0..100 的标记坐标映射到画布上的实际位置 */
function markOrigin() {
  const offset = Math.round((CANVAS - MARK_SIZE) / 2)
  return { x: offset, y: offset }
}

function buildVariantSvg(variant) {
  const { x, y } = markOrigin()
  const defs = []
  const layers = []

  // 底板
  if (variant.gradient) {
    defs.push(
      `<linearGradient id="plate" x1="0" y1="0" x2="1" y2="1">` +
        `<stop offset="0" stop-color="${variant.gradient[0]}"/>` +
        `<stop offset="1" stop-color="${variant.gradient[1]}"/></linearGradient>`,
    )
    layers.push(
      `<rect x="${PLATE.x}" y="${PLATE.y}" width="${PLATE.size}" height="${PLATE.size}" rx="${PLATE.radius}" fill="url(#plate)" />`,
    )
  } else if (variant.bg) {
    layers.push(
      `<rect x="${PLATE.x}" y="${PLATE.y}" width="${PLATE.size}" height="${PLATE.size}" rx="${PLATE.radius}" fill="${variant.bg}" />`,
    )
  }

  // 标记
  if (variant.style === 'pixel') {
    layers.push(markPixelGroup(x, y, MARK_SIZE, variant.mark))
  } else if (variant.style === 'metal') {
    defs.push(
      `<linearGradient id="metal" x1="0" y1="0" x2="0.35" y2="1">` +
        `<stop offset="0" stop-color="#FFFFFF"/>` +
        `<stop offset="0.34" stop-color="#D5DAE1"/>` +
        `<stop offset="0.52" stop-color="#8B929C"/>` +
        `<stop offset="0.68" stop-color="#E9EDF2"/>` +
        `<stop offset="1" stop-color="#A8B0BA"/></linearGradient>`,
    )
    layers.push(markGroup(x, y, MARK_SIZE, 'url(#metal)', { barFill: 'url(#metal)' }))
  } else if (variant.style === 'neon') {
    defs.push(
      `<linearGradient id="neon" x1="0" y1="0" x2="1" y2="1">` +
        `<stop offset="0" stop-color="#22D3EE"/>` +
        `<stop offset="1" stop-color="#E879F9"/></linearGradient>`,
    )
    // 霓虹外发光：围绕标记中心叠两层半透明放大副本。
    // 不用描边——主体和竖条各自描边会套出同心轮廓，看着像描边不像发光。
    const halo = [
      { scale: 1.14, opacity: 0.1 },
      { scale: 1.07, opacity: 0.2 },
    ]
    for (const layer of halo) {
      layers.push(
        markGroup(x, y, MARK_SIZE, '#22D3EE', { scale: layer.scale, opacity: layer.opacity, solidBar: true }),
      )
    }
    layers.push(markGroup(x, y, MARK_SIZE, 'url(#neon)', { barFill: 'url(#neon)' }))
  } else {
    layers.push(markGroup(x, y, MARK_SIZE, variant.mark))
  }

  const defsBlock = defs.length ? `\n  <defs>\n    ${defs.join('\n    ')}\n  </defs>` : ''
  return `<svg width="${CANVAS}" height="${CANVAS}" viewBox="0 0 ${CANVAS} ${CANVAS}" xmlns="http://www.w3.org/2000/svg">${defsBlock}\n  ${layers.join('\n  ')}\n</svg>\n`
}

// ─────────────────────────── 光栅化 ───────────────────────────

function render(svgContent, outPath, size, label) {
  const tmp = mkdtempSync(join(tmpdir(), 'profer-logo-'))
  try {
    const svgPath = join(tmp, 'in.svg')
    writeFileSync(svgPath, svgContent)
    try {
      execFileSync('sips', ['-s', 'format', 'png', svgPath, '--out', outPath], { stdio: 'pipe' })
      if (size && size !== CANVAS) {
        execFileSync('sips', ['-z', String(size), String(size), outPath], { stdio: 'pipe' })
      }
    } catch (error) {
      // sips 的失败信息在 stderr 里，默认会被 Node 打印成一大坨 Buffer，这里解出来方便定位
      const stderr = error?.stderr?.toString?.('utf8') ?? String(error)
      throw new Error(`sips 渲染 ${label ?? outPath} 失败：\n${stderr.trim()}`)
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

function main() {
  if (!existsSync(TRAY_SVG)) throw new Error(`缺少托盘图标源文件：${TRAY_SVG}`)
  mkdirSync(RENDERER_LOGO_DIR, { recursive: true })

  console.log('🎨 生成 Profer 品牌 Logo…\n')

  // 1) 托盘图标：22 / 44 / 66，直接从矢量按目标尺寸渲染，避免缩放糊边
  const traySvg = readFileSync(TRAY_SVG, 'utf8')
  const trayTargets = [
    { file: 'iconTemplate.png', size: 22 },
    { file: 'iconTemplate@2x.png', size: 44 },
    { file: 'iconTemplate@3x.png', size: 66 },
  ]
  for (const target of trayTargets) {
    const scaled = traySvg
      .replace(/width="\d+"/, `width="${target.size}"`)
      .replace(/height="\d+"/, `height="${target.size}"`)
    const outPath = join(LOGO_DIR, target.file)
    render(scaled, outPath, null, `托盘图标 ${target.file}`)
    console.log(`  ✅ 托盘 ${target.file} (${target.size}×${target.size})`)
  }

  // 2) 品牌素材 / 应用图标变体：1024×1024，同时写入 resources 与 renderer 资源目录
  for (const variant of VARIANTS) {
    const svg = buildVariantSvg(variant)
    const primary = join(LOGO_DIR, `profer-${variant.id}.png`)
    render(svg, primary, CANVAS, `变体 ${variant.id}`)
    copyFileSync(primary, join(RENDERER_LOGO_DIR, `profer-${variant.id}.png`))
    const bytes = statSync(primary).size
    console.log(`  ✅ profer-${variant.id}.png (${CANVAS}×${CANVAS}, ${(bytes / 1024).toFixed(1)} KB)`)
  }

  console.log(`\n✅ 完成：3 个托盘图标 + ${VARIANTS.length} 个变体，已同步到 renderer 资源目录`)
}

main()
