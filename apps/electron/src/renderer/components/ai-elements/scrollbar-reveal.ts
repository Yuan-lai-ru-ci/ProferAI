/**
 * 滚动条的按需显隐（对话区原生滚动条、右侧滚动进度条共用）。
 *
 * macOS 习惯：滚动条只在用户主动滚动时出现，停手后淡出。
 * 这里只负责给目标元素打 `data-scrolling` 标记，具体样式见 globals.css：
 * - 原生滚动条：`.profer-scroll-region[data-scrolling='true']`
 * - 进度条：`.scroll-progress-track[data-scrolling='true']`
 *
 * 注意：程序性滚动（流式输出自动跟随、内容变高）不算用户滚动，
 * 只有 wheel / 触摸滑动 / 键盘翻页 / 直接操作滚动条才会露出滚动条。
 */

/** 最后一次滚动后保持可见的时长，给用户一个"刚滚过"的视觉落点。
 * 1250ms：700ms 在长文快速扫读时几乎“刚停手就消失”，想回看位置只能再滚一下。 */
export const SCROLLBAR_REVEAL_IDLE_MS = 1250

/** 右边缘滚动条热区的最小宽度：macOS overlay 条只有 6px，按 6px 判定等于要求用户压中线。 */
const SCROLLBAR_HOVER_MIN_PX = 12

/** 与浏览器滚动行为一致的翻页键。 */
const SCROLL_KEYS = ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']

export interface ScrollbarReveal {
  /** 标记为滚动中；重复调用会顺延隐藏时间。 */
  reveal: () => void
  /** 当前是否处于可见状态。 */
  isVisible: () => boolean
  /** 清理计时器、解绑监听并移除标记。 */
  dispose: () => void
}

interface ScrollbarRevealOptions {
  idleMs?: number
  /** 便于测试注入；默认 setTimeout。 */
  schedule?: (callback: () => void, ms: number) => number
  cancel?: (id: number) => void
  /**
   * 在这个元素上监听用户滚动交互。
   *
   * 原生滚动条的标记就打在滚动容器自己身上，调用方已经在处理交互事件，
   * 所以不传；进度条渲染在滚动容器外面（Conversation 的兄弟节点），
   * 需要它自己监听容器上的滚轮/触摸/翻页键。
   */
  watchElement?: HTMLElement | null
}

/**
 * 事件目标是否落在容器内部的另一个可滚动区域（代码块、嵌套列表等）。
 * 这类滚动不该让外层滚动条亮起来。
 */
export function isNestedScroller(target: EventTarget | null, boundary: HTMLElement): boolean {
  const elementCtor = typeof HTMLElement === 'undefined' ? null : HTMLElement
  let node = elementCtor && target instanceof elementCtor ? target : null
  while (node && node !== boundary) {
    const overflow = getComputedStyle(node).overflowY
    if (/auto|scroll/.test(overflow) && node.scrollHeight > node.clientHeight) return true
    node = node.parentElement
  }
  return false
}

function bindUserScroll(el: HTMLElement, reveal: () => void): () => void {
  const onWheel = (event: WheelEvent): void => {
    if (!isNestedScroller(event.target, el)) reveal()
  }
  const onTouchMove = (event: TouchEvent): void => {
    if (!isNestedScroller(event.target, el)) reveal()
  }
  // 只有直接点/拖滚动条本体（target 为容器自身）才算，避免点消息时进度条闪一下。
  const onPointerDown = (event: PointerEvent): void => {
    if (event.target === el) reveal()
  }
  const onKeyDown = (event: KeyboardEvent): void => {
    if (SCROLL_KEYS.includes(event.key)) reveal()
  }
  el.addEventListener('wheel', onWheel, { passive: true })
  el.addEventListener('touchmove', onTouchMove, { passive: true })
  el.addEventListener('pointerdown', onPointerDown, { passive: true })
  el.addEventListener('keydown', onKeyDown)
  return () => {
    el.removeEventListener('wheel', onWheel)
    el.removeEventListener('touchmove', onTouchMove)
    el.removeEventListener('pointerdown', onPointerDown)
    el.removeEventListener('keydown', onKeyDown)
  }
}

/** 指针是否落在容器右边缘的滚动条热区。
 * 只算右边缘：不能把“鼠标在整个对话区”都当成悬停滚动条——那样条子等于常驻。 */
function isPointerOnScrollbarArea(el: HTMLElement, event: PointerEvent): boolean {
  const rect = el.getBoundingClientRect()
  if (event.clientY < rect.top || event.clientY > rect.bottom) return false
  let size = 6
  try {
    const parsed = Number.parseFloat(getComputedStyle(el).getPropertyValue('--scrollbar-size'))
    if (parsed > 0) size = parsed
  } catch {
    /* 非浏览器环境（单测 mock）取不到 token，回退到 6px */
  }
  return event.clientX >= rect.right - Math.max(size, SCROLLBAR_HOVER_MIN_PX)
}

/** 鼠标进入/离开右侧滚动条热区时给容器打 data-scrollbar-hover（纯 CSS 控不到的 overlay 滚动条需要）。
 * 滚动条本身是伪元素，`:hover` 只会在滑块上触发、盖不到整条轨道，所以用指针坐标自己判。 */
function bindScrollbarHover(el: HTMLElement): () => void {
  /* Windows 的条常驻可见，不需要指针追踪；省掉每帧 getBoundingClientRect。 */
  if (typeof document !== 'undefined' && document.documentElement?.getAttribute('data-platform') === 'win32') {
    return () => {}
  }
  const onPointerMove = (event: PointerEvent): void => {
    const onBar = isPointerOnScrollbarArea(el, event)
    if (onBar) {
      if (el.dataset.scrollbarHover !== 'true') el.dataset.scrollbarHover = 'true'
    } else if (el.dataset.scrollbarHover) {
      delete el.dataset.scrollbarHover
    }
  }
  const onPointerLeave = (): void => {
    delete el.dataset.scrollbarHover
  }
  el.addEventListener('pointermove', onPointerMove, { passive: true })
  el.addEventListener('pointerleave', onPointerLeave, { passive: true })
  return () => {
    el.removeEventListener('pointermove', onPointerMove)
    el.removeEventListener('pointerleave', onPointerLeave)
    delete el.dataset.scrollbarHover
  }
}

export function attachScrollbarReveal(
  el: HTMLElement,
  options: ScrollbarRevealOptions = {}
): ScrollbarReveal {
  const idleMs = options.idleMs ?? SCROLLBAR_REVEAL_IDLE_MS
  const schedule = options.schedule ?? ((callback, ms) => setTimeout(callback, ms) as unknown as number)
  const cancel = options.cancel ?? ((id) => clearTimeout(id))
  let timer: number | null = null

  const clear = (): void => {
    if (timer !== null) cancel(timer)
    timer = null
  }

  const reveal = (): void => {
    el.dataset.scrolling = 'true'
    clear()
    timer = schedule(() => {
      timer = null
      delete el.dataset.scrolling
    }, idleMs)
  }

  const detach = options.watchElement ? bindUserScroll(options.watchElement, reveal) : null
  /* 自己就是滚动容器（对话区原生滚动条）时，补一条右边缘悬停检测；
   * 进度条场景（传了 watchElement）不需要——它自己就是 11px 的 DOM 元素，CSS :hover 足够。 */
  const detachHover = options.watchElement ? null : bindScrollbarHover(el)

  return {
    reveal,
    isVisible: () => el.dataset.scrolling === 'true',
    dispose: () => {
      detach?.()
      detachHover?.()
      clear()
      delete el.dataset.scrolling
    },
  }
}
