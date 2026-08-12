/**
 * MermaidBlock - Mermaid 图表渲染组件
 *
 * 优先使用 beautiful-mermaid 渲染，遇到 beautiful-mermaid 不支持的图型时
 * 自动回退到官方 mermaid 渲染器。
 *
 * 渲染时序：
 *   流式输出 → 源码自然增长（零跳动）
 *   code 稳定 350ms → 后台 renderMermaid
 *   成功 → SVG 替换源码展示
 *   失败 → 保持源码展示
 *
 * 防竞态：generation 计数器，只有最新一代的渲染结果才会生效
 *
 * 缩放交互：仅头部按钮（缩小 / 重置 / 放大）。不响应滚轮和拖拽，
 * 让滚轮事件正常冒泡到页面滚动；放大后用容器原生 overflow scrollbar 浏览。
 *
 * 缩放锚定：缩放以当前视口中心为锚点（缩放后重新对齐滚动位置）。
 * 内容用 translate 平移量实现「未溢出时居中、溢出时顶格」，transform-origin 为左上角，
 * 因此缩放只向右/下扩展，左端（图头）/顶端永不落入不可滚动的负坐标区。
 */

import * as React from 'react'
import type { DiagramColors, RenderOptions } from 'beautiful-mermaid'

interface MermaidBlockProps {
  /** mermaid 源码 */
  code: string
}

/** 防抖间隔（ms） */
const DEBOUNCE_MS = 350
/** 缩放范围 */
const ZOOM_MIN = 0.25
const ZOOM_MAX = 3
const ZOOM_STEP = 0.15
const INITIAL_SCALE = 1
let mermaidRenderId = 0

function isDarkMode(): boolean {
  return document.documentElement.classList.contains('dark')
}

function getThemeOptions(themes: Record<string, DiagramColors>): RenderOptions {
  // 跟随应用明暗模式，从 beautiful-mermaid 内置 15 套主题中挑选
  // 暗色：tokyo-night（霓虹紫蓝） / 亮色：catppuccin-latte（柔和奶油调）
  const themeName = isDarkMode() ? 'tokyo-night' : 'catppuccin-latte'
  const colors = themes[themeName]
  return colors ? { ...colors } : {}
}

function isUsableSvg(svg: unknown): svg is string {
  if (typeof svg !== 'string' || !svg.includes('<svg')) return false
  if (/(?:^|[^a-z])(?:NaN|Infinity|-Infinity)(?:[^a-z]|$)/i.test(svg)) return false
  // mermaid 解析失败时会返回带错误标记的 SVG，需要识别后走兜底
  if (svg.includes('aria-roledescription="error"')) return false
  if (svg.includes('class="error-text"')) return false
  return true
}

/** 官方扩展（ELK 布局 / ZenUML）注册缓存：只注册一次；失败后重置允许下次重试 */
let officialExtensionsReady: Promise<void> | null = null

/**
 * 注册 mermaid 官方增强组件：
 * - @mermaid-js/layout-elk：ELK 布局引擎（复杂流程图自动排版更紧凑）
 * - @mermaid-js/mermaid-zenuml：ZenUML 时序图渲染
 * 只影响官方 mermaid 兑底路径；beautiful-mermaid 优先路径自带 elkjs 布局。
 */
async function ensureOfficialExtensions(): Promise<void> {
  if (!officialExtensionsReady) {
    officialExtensionsReady = (async () => {
      const [{ default: mermaid }, { default: elkLayouts }, { default: zenumlPlugin }] =
        await Promise.all([
          import('mermaid'),
          import('@mermaid-js/layout-elk'),
          import('@mermaid-js/mermaid-zenuml'),
        ])
      mermaid.registerLayoutLoaders(elkLayouts)
      mermaid.registerExternalDiagrams([zenumlPlugin])
    })().catch((error) => {
      // 注册失败（版本不兼容/网络受限等）：不能永久 rejected（此后兜底渲染 100% 失败），
      // 重置缓存允许下一次渲染重试；同时打印错误便于定位。
      officialExtensionsReady = null
      console.error('[Mermaid] 官方扩展注册失败，将在下次渲染时重试:', error)
      throw error
    })
  }
  return officialExtensionsReady
}

/** 小图节点数阈值：≤ 此值时官方路径用 dagre（贝塞尔平滑曲线），否则用 ELK（紧凑） */
const SMALL_GRAPH_NODES = 10

/**
 * 粗略统计 flowchart 节点数（用于布局引擎选择，不需要精确）。
 * 统计边两端的 ID 与显式节点定义，去重。
 */
function estimateNodeCount(code: string): number {
  const ids = new Set<string>()
  const edges = code.match(/[A-Za-z_][\w-]*\s*[-.][-.][->]\s*[A-Za-z_][\w-]*/g) || []
  for (const e of edges) {
    const parts = e.split(/\s*[-.][-.][->]\s*/)
    if (parts.length >= 2 && parts[0] !== undefined && parts[1] !== undefined) {
      ids.add(parts[0].trim())
      ids.add(parts[1].trim())
    }
  }
  const defs = code.match(/[A-Za-z_][\w-]*\s*[[({]/g) || []
  for (const d of defs) ids.add(d.trim().slice(0, -1))
  return ids.size
}

/**
 * 把 beautiful-mermaid 输出的正交折线边（polyline）转成圆角平滑 path。
 *
 * 背景：beautiful-mermaid 用 polyline 画边，子图/跨层连接多时会出现大量直角折线，
 * 视觉上“走线拐弯很奇怪”。本函数保持布局结构不变，仅把每个直角拐弯替换为
 * 二次贝塞尔圆角过渡（draw.io 默认风格），箭头 marker 与虚线样式原样保留。
 */
function smoothPolylineEdges(svg: string): string {
  const polylineRe = /<polyline([^>]*?)\spoints="([^"]*)"([^>]*?)\/>/g
  return svg.replace(polylineRe, (whole, prefix: string, pointsAttr: string, suffix: string) => {
    const pts = pointsAttr.trim().split(/\s+/)
      .map((p) => p.split(',').map(Number))
      .filter((p) => p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1])) as Array<[number, number]>
    if (pts.length < 3) return whole // 直线无需处理
    const first = pts[0]
    const last = pts[pts.length - 1]
    if (!first || !last) return whole

    const radius = 10 // 圆角半径上限（px），按线段长度自适应收缩
    let d = `M ${fmt(first[0])},${fmt(first[1])}`
    for (let i = 1; i < pts.length - 1; i++) {
      const prev = pts[i - 1]
      const cur = pts[i]
      const next = pts[i + 1]
      if (!prev || !cur || !next) continue
      const [ax, ay] = prev
      const [bx, by] = cur
      const [cx, cy] = next
      const seg1 = Math.hypot(bx - ax, by - ay)
      const seg2 = Math.hypot(cx - bx, cy - by)
      if (seg1 < 1 || seg2 < 1) continue
      const r = Math.min(radius, seg1 / 2, seg2 / 2)
      const px = bx - ((bx - ax) / seg1) * r // 拐点前 r 处
      const py = by - ((by - ay) / seg1) * r
      const qx = bx + ((cx - bx) / seg2) * r // 拐点后 r 处
      const qy = by + ((cy - by) / seg2) * r
      d += ` L ${fmt(px)},${fmt(py)} Q ${fmt(bx)},${fmt(by)} ${fmt(qx)},${fmt(qy)}`
    }
    d += ` L ${fmt(last[0])},${fmt(last[1])}`

    return `<path${prefix} d="${d}"${suffix} />`
  })
}

function fmt(n: number): string {
  return Number(n.toFixed(1)).toString()
}

async function renderWithOfficialMermaid(code: string): Promise<string> {
  await ensureOfficialExtensions()
  const { default: mermaid } = await import('mermaid')
  const dark = isDarkMode()
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    // 解析/绘制失败时清理临时节点并抛错，而非把错误图注入 document.body
    // （后者会在页面底部残留一条孤立的 "Syntax error in text" bar）
    suppressErrorRendering: true,
    // 智能布局：小图用 dagre（贝塞尔平滑曲线、层级感强），大图用 ELK（紧凑、交叉线少）
    flowchart: { defaultRenderer: estimateNodeCount(code) <= SMALL_GRAPH_NODES ? 'dagre-wrapper' : 'elk' },
    theme: dark ? 'dark' : 'default',
    themeVariables: {
      background: dark ? '#0f172a' : '#ffffff',
      mainBkg: dark ? '#1e293b' : '#f8fafc',
      primaryColor: dark ? '#1e293b' : '#f8fafc',
      primaryTextColor: dark ? '#e2e8f0' : '#0f172a',
      primaryBorderColor: dark ? '#475569' : '#cbd5e1',
      lineColor: dark ? '#94a3b8' : '#64748b',
      textColor: dark ? '#e2e8f0' : '#0f172a',
    },
  })

  const id = `proma-mermaid-${Date.now()}-${mermaidRenderId++}`
  const { svg } = await mermaid.render(id, code)
  if (!isUsableSvg(svg)) throw new Error('Mermaid 输出了无效 SVG')
  return svg
}

async function renderMermaidSvg(code: string): Promise<string> {
  try {
    const { renderMermaidSVGAsync, THEMES } = await import('beautiful-mermaid')
    const svg = await renderMermaidSVGAsync(code, getThemeOptions(THEMES))
    if (isUsableSvg(svg)) return smoothPolylineEdges(svg)
  } catch {
    // beautiful-mermaid 只覆盖部分图型，不支持时交给官方 mermaid 兜底。
  }

  return renderWithOfficialMermaid(code)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

// ===== 图标（与 CodeBlock 一致） =====

const ICON_ATTRS = {
  width: 14, height: 14, viewBox: '0 0 24 24',
  fill: 'none', stroke: 'currentColor', strokeWidth: 2,
  strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const,
}
const copyIconPath = (
  <>
    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </>
)
const checkIconPath = <polyline points="20 6 9 17 4 12" />
const zoomInPath = (
  <>
    <circle cx="11" cy="11" r="8" />
    <line x1="21" y1="21" x2="16.65" y2="16.65" />
    <line x1="11" y1="8" x2="11" y2="14" />
    <line x1="8" y1="11" x2="14" y2="11" />
  </>
)
const zoomOutPath = (
  <>
    <circle cx="11" cy="11" r="8" />
    <line x1="21" y1="21" x2="16.65" y2="16.65" />
    <line x1="8" y1="11" x2="14" y2="11" />
  </>
)

// ===== 主组件 =====

export function MermaidBlock({ code }: MermaidBlockProps): React.ReactElement {
  const [renderedSvg, setRenderedSvg] = React.useState<string | null>(null)
  const [copied, setCopied] = React.useState(false)
  const [scale, setScale] = React.useState<number>(INITIAL_SCALE)
  /** SVG 原始尺寸（取 width/height 属性，不受 max-w-full/滚动条影响，稳定），用于「未溢出时居中、溢出时顶格」的平移量计算 */
  const [svgSize, setSvgSize] = React.useState({ w: 0, h: 0 })
  /** 缩放容器（frame）内容盒尺寸 */
  const [frameSize, setFrameSize] = React.useState({ w: 0, h: 0 })

  const codeRef = React.useRef(code)
  const debounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  /** generation 计数器：每次 code 变化递增，防止异步竞态 */
  const generationRef = React.useRef(0)

  /** 滚动容器与缩放内容 DOM（用于视口中心锚定的滚动计算） */
  const scrollRef = React.useRef<HTMLDivElement | null>(null)
  const frameRef = React.useRef<HTMLDivElement | null>(null)
  const contentRef = React.useRef<HTMLDivElement | null>(null)
  /** 缩放后待应用的滚动位置：useLayoutEffect 里在 transform 提交生效后应用 */
  const pendingScrollRef = React.useRef<{ x: number; y: number } | null>(null)

  codeRef.current = code

  const renderCurrentCode = React.useCallback(async (generation: number) => {
    try {
      const svg = await renderMermaidSvg(codeRef.current)
      if (generationRef.current !== generation) return
      setRenderedSvg(svg)
    } catch {
      if (generationRef.current === generation) setRenderedSvg(null)
    }
  }, [])

  // ==== 唯一的渲染 effect：全部走防抖，generation 防竞态 ====
  React.useEffect(() => {
    // 每次 code 变化递增 generation，作废所有旧的异步渲染
    generationRef.current++
    const currentGen = generationRef.current

    if (debounceRef.current) clearTimeout(debounceRef.current)
    setRenderedSvg(null)
    setScale(INITIAL_SCALE)
    debounceRef.current = setTimeout(() => {
      void renderCurrentCode(currentGen)
    }, DEBOUNCE_MS)

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [code, renderCurrentCode])

  // ---- 主题变化：重新渲染当前 code ----
  React.useEffect(() => {
    const observer = new MutationObserver(() => {
      generationRef.current++
      void renderCurrentCode(generationRef.current)
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [renderCurrentCode])

  // ---- 缩放平移量：内容未溢出视口时居中，溢出时顶格（左上角），保证头部/顶端始终可滚动 ----
  // 展示尺寸 = min(SVG 原始尺寸, 容器内容盒)；高度按原始宽高比等比换算（对应 svg 的 h-auto）
  const displayW = svgSize.w > 0 && frameSize.w > 0 ? Math.min(svgSize.w, frameSize.w) : svgSize.w
  const displayH = displayW > 0 && svgSize.w > 0 ? (svgSize.h * displayW) / svgSize.w : svgSize.h
  const scaledW = displayW * scale
  const scaledH = displayH * scale
  const tx = svgSize.w > 0 && scaledW <= frameSize.w && frameSize.w > 0 ? (frameSize.w - scaledW) / 2 : 0
  const ty = svgSize.h > 0 && scaledH <= frameSize.h && frameSize.h > 0 ? (frameSize.h - scaledH) / 2 : 0

  /**
   * 按「视口中心锚定」缩放：先读取当前视口中心对应的内容点（未缩放坐标系），
   * 改变 scale 后由下方 useLayoutEffect 把该点重新对齐到视口中心。
   * transform-origin 为 top left，缩放只向右/下扩展；配合 translate 平移量
   * 使未溢出时居中、溢出时顶格，左端（图头）/顶端永不落入不可滚动的负坐标区。
   */
  const applyZoom = React.useCallback((newScale: number) => {
    const scrollEl = scrollRef.current
    const contentEl = contentRef.current
    // 图表未渲染或尚未测得尺寸时直接改缩放即可
    if (!scrollEl || !contentEl || !svgSize.w || !frameSize.w) {
      setScale(newScale)
      return
    }
    const oldScale = scale
    const scrollRect = scrollEl.getBoundingClientRect()
    const contentRect = contentEl.getBoundingClientRect()
    // 内容可视区左上角在滚动内容坐标系中的位置（含当前滚动偏移与平移量）
    const left = contentRect.left - scrollRect.left + scrollEl.scrollLeft
    const top = contentRect.top - scrollRect.top + scrollEl.scrollTop
    // 布局位置（不含平移量）：可视左上角 - 当前平移量
    const baseLeft = left - tx
    const baseTop = top - ty
    // 当前视口中心对应的内容点（未缩放坐标系）
    const vpCx = scrollEl.clientWidth / 2
    const vpCy = scrollEl.clientHeight / 2
    const itemX = (scrollEl.scrollLeft + vpCx - left) / oldScale
    const itemY = (scrollEl.scrollTop + vpCy - top) / oldScale
    // 新缩放下的平移量与可视左上角
    const newScaledW = displayW * newScale
    const newScaledH = displayH * newScale
    const newTx = newScaledW <= frameSize.w ? (frameSize.w - newScaledW) / 2 : 0
    const newTy = newScaledH <= frameSize.h ? (frameSize.h - newScaledH) / 2 : 0
    const newLeft = baseLeft + newTx
    const newTop = baseTop + newTy
    // 新缩放下使该点仍落在视口中心所需的滚动位置
    pendingScrollRef.current = {
      x: newLeft + itemX * newScale - vpCx,
      y: newTop + itemY * newScale - vpCy,
    }
    setScale(newScale)
  }, [scale, tx, ty, displayW, displayH, svgSize, frameSize])

  // ---- 缩放后应用滚动锚定（本次提交里 transform 已生效，scrollWidth 为缩放后尺寸）----
  React.useLayoutEffect(() => {
    const scrollEl = scrollRef.current
    const pending = pendingScrollRef.current
    if (!scrollEl || !pending) return
    pendingScrollRef.current = null
    scrollEl.scrollLeft = clamp(pending.x, 0, Math.max(0, scrollEl.scrollWidth - scrollEl.clientWidth))
    scrollEl.scrollTop = clamp(pending.y, 0, Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight))
  })

  // ---- 测量 SVG 原始尺寸 / 容器尺寸：只在图表渲染时执行一次，缩放不触发，避免 setState 反馈循环 ----
  // 注意：不在这里监听内容元素的布局尺寸变化——放大溢出时滚动条出现会让容器变窄，
  // 若反复读 offsetWidth 并回写 state 会形成无限重渲染（Maximum update depth exceeded）。
  // SVG 原始尺寸取 width/height 属性（稳定），容器尺寸仅跟随窗口 resize（滚动条出现不触发）。
  React.useLayoutEffect(() => {
    const frame = frameRef.current
    const content = contentRef.current
    if (!frame || !content) return
    const svg = content.querySelector('svg')
    let iw = 0
    let ih = 0
    if (svg) {
      iw = parseFloat(svg.getAttribute('width') ?? '')
      ih = parseFloat(svg.getAttribute('height') ?? '')
    }
    if (!Number.isFinite(iw) || !Number.isFinite(ih) || iw <= 0 || ih <= 0) {
      // 属性缺失时退回布局尺寸（此时仅测一次，足够稳定）
      iw = content.offsetWidth
      ih = content.offsetHeight
    }
    setSvgSize({ w: iw, h: ih })
    const measureFrame = () =>
      setFrameSize((prev) => {
        const w = frame.clientWidth
        const h = frame.clientHeight
        return prev.w === w && prev.h === h ? prev : { w, h }
      })
    measureFrame()
    window.addEventListener('resize', measureFrame)
    return () => window.removeEventListener('resize', measureFrame)
  }, [renderedSvg])

  const handleZoomIn = React.useCallback(() => {
    applyZoom(clamp(scale + ZOOM_STEP, ZOOM_MIN, ZOOM_MAX))
  }, [applyZoom])
  const handleZoomOut = React.useCallback(() => {
    applyZoom(clamp(scale - ZOOM_STEP, ZOOM_MIN, ZOOM_MAX))
  }, [applyZoom])
  const handleZoomReset = React.useCallback(() => {
    // 已是 100% 无需处理；否则回滚到 100% 并回到左上角（露出图头）
    if (scale === INITIAL_SCALE) return
    pendingScrollRef.current = { x: 0, y: 0 }
    setScale(INITIAL_SCALE)
  }, [scale])

  const handleCopy = React.useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (error) {
      console.error('[MermaidBlock] 复制失败:', error)
    }
  }, [code])

  const zoomPercent = Math.round(scale * 100)

  return (
    // 事件隔离：阻止 mousedown/双击冒泡到宿主编辑器（如 md 预览中的 ProseMirror），
    // 否则在只读 md 预览里双击缩放/复制按钮会被识别为“请求编辑”而切入编辑模式，
    // 导致 mermaid 预览被隐藏、看起来像渲染失败。
    <div
      className="mermaid-block-wrapper group/mermaid rounded-lg overflow-hidden my-2 border border-border/50"
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {/* 头部栏 */}
      <div className="flex items-center justify-between h-[34px] px-2 py-1 bg-muted/60 text-muted-foreground text-xs">
        <span className="font-medium select-none">Mermaid</span>
        <div className="flex items-center gap-1">
          {renderedSvg && (
            <div className="flex items-center gap-0.5 mr-2">
              <button type="button" onClick={handleZoomOut} onMouseDown={(e) => e.preventDefault()} className="p-0.5 rounded hover:bg-foreground/10 transition-colors" title="缩小">
                <svg {...ICON_ATTRS}>{zoomOutPath}</svg>
              </button>
              <button type="button" onClick={handleZoomReset} onMouseDown={(e) => e.preventDefault()} className="px-1 py-0.5 rounded hover:bg-foreground/10 transition-colors min-w-[40px] text-center tabular-nums" title="重置缩放">
                {zoomPercent}%
              </button>
              <button type="button" onClick={handleZoomIn} onMouseDown={(e) => e.preventDefault()} className="p-0.5 rounded hover:bg-foreground/10 transition-colors" title="放大">
                <svg {...ICON_ATTRS}>{zoomInPath}</svg>
              </button>
            </div>
          )}
          <button type="button" onClick={handleCopy} onMouseDown={(e) => e.preventDefault()} className="flex items-center gap-1.5 px-1.5 py-0.5 rounded hover:bg-foreground/10 transition-colors text-muted-foreground hover:text-foreground">
            <svg {...ICON_ATTRS}>{copied ? checkIconPath : copyIconPath}</svg>
            <span>{copied ? '已复制' : '复制'}</span>
          </button>
        </div>
      </div>

      <div className="overflow-hidden">
        {!renderedSvg ? (
          <pre
            className="mermaid-block-scroll overflow-x-auto p-4 m-0 text-[13px] leading-[1.6] bg-muted/30 text-foreground/80"
          >
            <code>{code}</code>
          </pre>
        ) : (
          <div ref={scrollRef} className="mermaid-block-scroll bg-background overflow-auto min-h-[180px]">
            <div ref={frameRef} className="flex items-start min-h-[180px] p-4">
              <div
                ref={contentRef}
                className="mermaid-svg [&>svg]:max-w-full [&>svg]:h-auto"
                style={{
                  transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
                  transformOrigin: 'top left',
                }}
                dangerouslySetInnerHTML={{ __html: renderedSvg }}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
