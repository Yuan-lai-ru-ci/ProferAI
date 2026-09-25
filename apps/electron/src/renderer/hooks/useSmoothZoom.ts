import * as React from 'react'
import { applyWheelZoom, DEFAULT_WHEEL_ZOOM, type WheelZoomOptions } from '@/lib/wheel-zoom'

export interface SmoothZoomOptions extends WheelZoomOptions {
  /** 每帧向目标值逼近的比例（指数平滑），默认 0.35。越大越跟手，越小越柔。 */
  easing?: number
}

export interface SmoothZoom {
  /** 当前渲染用的缩放值（已被 rAF 平滑）。 */
  zoom: number
  /** 当前平移量（像素，供 translate）。 */
  pan: { x: number; y: number }
  /** 绑定到目标元素的原生 wheel 监听器（non-passive）。 */
  bindRef: <T extends HTMLElement>(node: T | null) => void
  /** 直接设置缩放（如重置为 1）。 */
  reset: (zoom?: number) => void
  /** 按钮缩放：乘 step（>1 放大，<1 缩小），围绕元素中心。 */
  zoomBy: (step: number) => void
  /** 指针按下开始拖拽平移（绑定到元素 onMouseDown）。任何缩放级别都可拖。 */
  onPanMouseDown: (event: React.MouseEvent) => void
}

interface View {
  scale: number
  tx: number
  ty: number
}

/**
 * useSmoothZoom — 带 rAF 平滑、指针锚定的滚轮/捏合缩放 hook。
 *
 * 变换模型：`transform: translate(tx, ty) scale(s)`，`transform-origin: 0 0`。
 * 在这个模型下，元素未变换内容坐标 v 与屏幕坐标的关系是：
 *     screen = T + s · v        （T = (tx, ty)，s = scale）
 *
 * 指针锚定：缩放前后让指针下的内容点保持不动。
 *   缩放前：P = T + s · v   =>   v = (P − T) / s
 *   缩放后：P = T′ + s′ · v  =>   T′ = P − s′ · v = P − (P − T) · (s′/s)
 *   即：T′ = P − (P − T) · ratio，其中 ratio = s′/s
 *
 * P、T 都以「元素未变换左上角」为原点。关键是不动点选取：
 * 对 `translate + scale(origin 0 0)`，元素的**未变换左上角**经变换后落在
 * `rect.left/top − 0` …… 实际上变换后元素左上角恰好就是 T 作用后的位置，
 * 而 rect（getBoundingClientRect）的 left/top 就是变换后元素包围盒左上角。
 * 因为 scale origin 是 0 0，左上角仅受 translate 影响，故：
 *     未变换左上角屏幕位置 = rect.left − tx, rect.top − ty
 * 由此可把指针的视口坐标换算到「相对未变换左上角」的坐标 P，参与上式。
 *
 * 这个模型不依赖 transform-origin 的百分比语义（那会在 scale 后错位），
 * 因此缩放锚点精确、不漂移。
 *
 * - 滚轮 / 捏合（ctrlKey wheel）→ 更新目标 view（applyWheelZoom 归一化 + 钳制）
 * - rAF 循环 → current += (target − current) · easing，差值足够小即停帧
 */
export function useSmoothZoom(options: SmoothZoomOptions = {}): SmoothZoom {
  const { easing = 0.35, minZoom, maxZoom, speed, maxStep } = options
  // 与 DEFAULT_WHEEL_ZOOM 合并成必填，供 zoomBy 等需要明确 min/max 的地方使用
  const zoomOptions = React.useMemo<Required<WheelZoomOptions>>(
    () => ({
      minZoom: minZoom ?? DEFAULT_WHEEL_ZOOM.minZoom,
      maxZoom: maxZoom ?? DEFAULT_WHEEL_ZOOM.maxZoom,
      speed: speed ?? DEFAULT_WHEEL_ZOOM.speed,
      maxStep: maxStep ?? DEFAULT_WHEEL_ZOOM.maxStep,
    }),
    [minZoom, maxZoom, speed, maxStep],
  )

  const [view, setView] = React.useState<View>({ scale: 1, tx: 0, ty: 0 })

  const elementRef = React.useRef<HTMLElement | null>(null)
  // 用 state 跟踪绑定元素：wheel effect 依赖它，元素异步挂载/卸载时能重新绑定。
  // （若只用 ref，effect 在元素挂载前 return 后就不再重跑，导致 wheel 永不生效 ——
  //  DiffTabContent 的 imageDataUrl 异步加载正是这个场景。）
  const [boundEl, setBoundEl] = React.useState<HTMLElement | null>(null)
  const targetRef = React.useRef<View>({ scale: 1, tx: 0, ty: 0 })
  const currentRef = React.useRef<View>({ scale: 1, tx: 0, ty: 0 })
  const rafRef = React.useRef<number | null>(null)

  const stopRaf = React.useCallback((): void => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
  }, [])

  const tick = React.useCallback((): void => {
    const t = targetRef.current
    const c = currentRef.current
    const dScale = t.scale - c.scale
    const dTx = t.tx - c.tx
    const dTy = t.ty - c.ty
    if (Math.abs(dScale) < 0.0005 && Math.abs(dTx) < 0.5 && Math.abs(dTy) < 0.5) {
      currentRef.current = { ...t }
      setView({ ...t })
      rafRef.current = null
      return
    }
    const next: View = {
      scale: c.scale + dScale * easing,
      tx: c.tx + dTx * easing,
      ty: c.ty + dTy * easing,
    }
    currentRef.current = next
    setView(next)
    rafRef.current = requestAnimationFrame(tick)
  }, [easing])

  const scheduleRaf = React.useCallback((): void => {
    if (rafRef.current === null) rafRef.current = requestAnimationFrame(tick)
  }, [tick])

  // 原生 non-passive wheel：React 合成事件在部分 Electron 环境是 passive，无法 preventDefault
  React.useEffect(() => {
    const el = boundEl
    if (!el) return

    const handleWheel = (event: WheelEvent): void => {
      event.preventDefault()

      // getBoundingClientRect 是浏览器当前帧的渲染结果，对应「平滑中的当前值」
      // currentRef（而非 targetRef）。统一用 current 反推未变换左上角，避免快速
      // 滚动时目标值与渲染值脱节导致锚点漂移。
      const cur = currentRef.current
      const rect = el.getBoundingClientRect()
      // 变换后元素包围盒左上角 = 未变换左上角 + T（scale origin 0 0 不动左上角）。
      // 故指针相对「未变换左上角」的坐标 = 视口坐标 − (rect.left − tx, rect.top − ty)。
      const untransformedLeft = rect.left - cur.tx
      const untransformedTop = rect.top - cur.ty
      const px = event.clientX - untransformedLeft
      const py = event.clientY - untransformedTop

      // 锚定以「未变换内容坐标 v」为不变量：v = (P − T) / s，缩放前后 v 不变。
      const vX = (px - cur.tx) / cur.scale
      const vY = (py - cur.ty) / cur.scale

      const nextScale = applyWheelZoom(cur.scale, event, zoomOptions)
      // T′ = P − s′ · v
      const nextTx = px - nextScale * vX
      const nextTy = py - nextScale * vY

      targetRef.current = { scale: nextScale, tx: nextTx, ty: nextTy }
      scheduleRaf()
    }

    el.addEventListener('wheel', handleWheel, { passive: false })
    return () => {
      el.removeEventListener('wheel', handleWheel)
      stopRaf()
    }
    // boundEl 变化（元素挂载/卸载/更换）时重新绑定
  }, [zoomOptions, scheduleRaf, stopRaf, boundEl])

  // 围绕元素中心按步缩放（工具栏 ± 按钮用）。缩放围绕未变换盒子的中心。
  const zoomBy = React.useCallback(
    (step: number): void => {
      const el = elementRef.current
      const cur = targetRef.current
      const nextScale = Math.min(zoomOptions.maxZoom, Math.max(zoomOptions.minZoom, cur.scale * step))
      if (!el || nextScale === cur.scale) {
        targetRef.current = { ...cur, scale: nextScale }
        scheduleRaf()
        return
      }
      // 以元素中心为不动点：center 内容点不变。
      // 未变换中心相对未变换左上角的偏移 = (offsetWidth/2, offsetHeight/2)（不受 transform 影响）
      const cx = el.offsetWidth / 2
      const cy = el.offsetHeight / 2
      // 屏幕关系：center_screen = T + s·(cx,cy)。要求缩放前后 center_screen 不变：
      // T + s·c = T′ + s′·c  =>  T′ = T + (s − s′)·c
      const nextTx = cur.tx + (cur.scale - nextScale) * cx
      const nextTy = cur.ty + (cur.scale - nextScale) * cy
      targetRef.current = { scale: nextScale, tx: nextTx, ty: nextTy }
      scheduleRaf()
    },
    [zoomOptions, scheduleRaf],
  )

  // 拖拽平移：mousedown 后跟踪 window mousemove/mouseup，直接改 translate。
  const onPanMouseDown = React.useCallback(
    (event: React.MouseEvent): void => {
      if (event.button !== 0) return
      const start = targetRef.current
      // 任何缩放级别都可拖拽平移（小于 100% 时图片也可能超出容器，或用户想挪位置）
      event.preventDefault()
      const startX = event.clientX
      const startY = event.clientY
      const startTx = start.tx
      const startTy = start.ty

      const onMove = (ev: MouseEvent): void => {
        const next: View = {
          scale: targetRef.current.scale,
          tx: startTx + (ev.clientX - startX),
          ty: startTy + (ev.clientY - startY),
        }
        targetRef.current = next
        currentRef.current = next // 拖拽跟手，不走平滑
        setView(next)
      }
      const onUp = (): void => {
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
      }
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    },
    [],
  )

  const bindRef = React.useCallback(<T extends HTMLElement>(node: T | null): void => {
    elementRef.current = node
    // 同步到 state：让 wheel effect 在元素异步挂载（如数据加载后才渲染）时重新绑定
    setBoundEl((prev) => (prev === node ? prev : node))
  }, [])

  const reset = React.useCallback(
    (nextZoom = 1): void => {
      stopRaf()
      const v: View = { scale: nextZoom, tx: 0, ty: 0 }
      targetRef.current = { ...v }
      currentRef.current = { ...v }
      setView({ ...v })
    },
    [stopRaf],
  )

  return {
    zoom: view.scale,
    pan: { x: view.tx, y: view.ty },
    bindRef,
    reset,
    zoomBy,
    onPanMouseDown,
  }
}

export { DEFAULT_WHEEL_ZOOM }
