/**
 * wheel-zoom — 统一的滚轮 / 触控板捏合缩放核心
 *
 * 参考 anvaka/panzoom（事实标准的开源 pan/zoom 库）的成熟模型：
 *
 *   function getScaleMultiplier(delta) {
 *     const sign = Math.sign(delta)
 *     const deltaAdjustedSpeed = Math.min(0.25, Math.abs(speed * delta / 128))
 *     return 1 - sign * deltaAdjustedSpeed
 *   }
 *
 * 三个关键设计（也是之前自拍脑袋实现缺失的）：
 *
 * 1. **delta 按 128 归一化**：鼠标滚轮一格 deltaY ≈ 100~120，接近 128；
 *    触控板捏合（Chromium 里是 ctrlKey: true 的高频小增量 wheel）deltaY 只有 ±1~±10。
 *    用 `speed * delta / 128` 让两类设备共用一套公式，速度天然随滚动量线性变化。
 *
 * 2. **单步乘数上限**：`Math.min(maxStep, ...)` 把单次事件的缩放幅度钳在一个小区间
 *    （默认 ±9%），鼠标猛滚一格不会一步翻倍， pinch 连续流又不会被钳到。
 *
 * 3. **线性乘数 `1 ± step` 而非 exp**：小步长时与 exp 等价，但钳制后行为可预期、
 *    单调、无累积漂移。pinch 与滚轮分离灵敏度，避免互相干扰。
 *
 * 本模块只暴露纯函数，不依赖 React / DOM，方便单元测试与三处图片预览复用。
 * 平滑（rAF 朝目标值过渡）由调用方的渲染层负责，这里只给出每一帧的目标缩放。
 */

export interface WheelZoomOptions {
  /** 缩放灵敏度（panzoom 的 zoomSpeed），默认 0.065 ≈ 鼠标一格 8%。 */
  speed?: number
  /** 单步缩放乘数偏离 1 的上限，默认 0.12（±12%）。 */
  maxStep?: number
  /** 最小 / 最大缩放倍数。 */
  minZoom?: number
  maxZoom?: number
}

export const DEFAULT_WHEEL_ZOOM: Required<WheelZoomOptions> = {
  speed: 0.085,
  maxStep: 0.12,
  minZoom: 0.5,
  maxZoom: 5,
}

/**
 * 把 wheel 事件归一化为「以 128 为基准」的有效 delta。
 * 兼容三种 deltaMode：像素(0) / 行(1) / 页(2)。
 */
export function normalizeWheelDelta(event: {
  deltaY: number
  deltaMode: number
}): number {
  let delta = event.deltaY
  // DOM_DELTA_LINE(1)：按行滚动，一行约等于 1/100 格的像素量，panzoom 直接 *100
  if (event.deltaMode === 1) delta *= 33
  // DOM_DELTA_PAGE(2)：按页滚动，近似一屏
  else if (event.deltaMode === 2) delta *= 400
  return delta
}

/**
 * 由有效 delta 计算本步的缩放乘数（panzoom 模型）。
 * 返回 1 表示无缩放。结果未被 min/max 钳制 —— 钳制交给 applyWheelZoom。
 */
export function wheelZoomMultiplier(
  event: { deltaY: number; deltaMode: number },
  options: WheelZoomOptions = {},
): number {
  const { speed, maxStep } = { ...DEFAULT_WHEEL_ZOOM, ...options }
  const delta = normalizeWheelDelta(event)
  if (delta === 0) return 1
  const sign = Math.sign(delta)
  const step = Math.min(maxStep, Math.abs((speed * delta) / 128))
  // 向下滚（deltaY>0）缩小，向上滚（deltaY<0）放大
  return 1 - sign * step
}

/**
 * 在当前 zoom 上应用一次 wheel 缩放，并钳到 [minZoom, maxZoom]。
 */
export function applyWheelZoom(
  currentZoom: number,
  event: { deltaY: number; deltaMode: number },
  options: WheelZoomOptions = {},
): number {
  const { minZoom, maxZoom } = { ...DEFAULT_WHEEL_ZOOM, ...options }
  const next = currentZoom * wheelZoomMultiplier(event, options)
  return Math.min(maxZoom, Math.max(minZoom, next))
}
