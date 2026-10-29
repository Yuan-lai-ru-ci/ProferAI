export interface ReadingAnchor {
  kind?: 'message' | 'block'
  id: string
  offset: number
  /**
   * 同位置的消息级兜底锚点。
   *
   * 块锚点（`data-scroll-anchor`，如过程块）会在上方内容被 prepend 后重建/消失：
   * 过程组按当前轮次重新分组，旧锚点 id 不再存在于 DOM，`readingTarget` 只能退回
   * 绝对 scrollTop——用户看到的就是「加载更早消息后直接跳到第一条」，并且因为仍停在
   * 顶部，触顶自动加载会连续触发把整段历史拉完。消息组以 uuid 为 key，跨 prepend 稳定，
   * 因此记录同一条消息的 id 作为兜底。
   */
  messageId?: string
  /** 兜底消息锚点相对视口顶部的偏移 */
  messageOffset?: number
}

export interface ReadingPosition {
  anchor: ReadingAnchor | null
  top: number
}

export interface ScrollPort {
  viewport: HTMLElement
  changed: () => void
  reducedMotion?: () => boolean
  requestFrame?: (callback: FrameRequestCallback) => number
  cancelFrame?: (id: number) => void
}

export function captureReadingPosition(viewport: HTMLElement, top = viewport.scrollTop): ReadingPosition {
  const bounds = viewport.getBoundingClientRect()
  const delta = top - viewport.scrollTop
  const blocks = Array.from(viewport.querySelectorAll<HTMLElement>('[data-scroll-anchor]'))
  const messages = Array.from(viewport.querySelectorAll<HTMLElement>('[data-message-id]'))
  const visible = (candidate: HTMLElement): boolean => {
    const rect = candidate.getBoundingClientRect()
    return rect.bottom > bounds.top + delta && rect.top < bounds.bottom + delta
  }
  const message = messages.find(visible)
  const block = blocks.find((candidate) => visible(candidate) && (!message || message.contains(candidate)))
  const node = block ?? message
  const kind = block ? 'block' as const : 'message' as const
  const id = node?.getAttribute(block ? 'data-scroll-anchor' : 'data-message-id')
  const anchor: ReadingAnchor | null = node && id
    ? { kind, id, offset: node.getBoundingClientRect().top - bounds.top - delta }
    : null
  // 块锚点额外记一份所属消息的锚点：块被重建时用它保持阅读位置。
  if (anchor && block && message) {
    const messageId = message.getAttribute('data-message-id')
    if (messageId) {
      anchor.messageId = messageId
      anchor.messageOffset = message.getBoundingClientRect().top - bounds.top - delta
    }
  }
  return { top, anchor }
}

function findAnchorNode(viewport: HTMLElement, attribute: string, id: string): HTMLElement | null {
  const nodes = Array.from(viewport.querySelectorAll<HTMLElement>(`[${attribute}]`))
  return nodes.find((candidate) => candidate.getAttribute(attribute) === id) ?? null
}

export function readingTarget(viewport: HTMLElement, position: ReadingPosition): number {
  if (position.anchor) {
    const { anchor } = position
    const attribute = anchor.kind === 'block' ? 'data-scroll-anchor' : 'data-message-id'
    const node = findAnchorNode(viewport, attribute, anchor.id)
    if (node) {
      return Math.max(0, viewport.scrollTop + node.getBoundingClientRect().top
        - viewport.getBoundingClientRect().top - anchor.offset)
    }
    // 块锚点随内容重建消失：退回同一条消息，仍保持用户正在看的那条回复。
    if (anchor.messageId) {
      const fallback = findAnchorNode(viewport, 'data-message-id', anchor.messageId)
      if (fallback) {
        return Math.max(0, viewport.scrollTop + fallback.getBoundingClientRect().top
          - viewport.getBoundingClientRect().top - (anchor.messageOffset ?? 0))
      }
    }
  }
  // 锚点被裁剪时保持绝对位置，不把同期尾部输出当作顶部插入。
  return Math.max(0, position.top)
}

type ScrollMode = 'following' | 'reading' | 'navigating'

/** 单一状态来源和帧执行器：内容观察、主动导航、恢复共用此控制器。 */
export class ConversationScrollController {
  private mode: ScrollMode = 'following'
  private position: ReadingPosition | null = null
  private destination: ReadingPosition | null = null
  private revision = 0
  private previousTop: number
  private height: number
  private viewportHeight: number
  private writtenTop: number | null = null
  private layoutAnchor: { element: HTMLElement; top: number } | null = null
  /** prepend 事务基线：内容在上方插入时按 scrollHeight 增量保持视口，不依赖 DOM 锚点。 */
  private prependBaseline: { height: number; top: number } | null = null
  /** prepend 收尾定时器：加载稳定后释放基线，避免后续尾部增长被误当插入补偿。 */
  private prependTimer: ReturnType<typeof setTimeout> | null = null
  private userIntent = false
  private frame: number | null = null
  private lastTick: number | null = null
  private disposed = false

  constructor(private readonly port: ScrollPort) {
    this.previousTop = port.viewport.scrollTop
    this.height = port.viewport.scrollHeight
    this.viewportHeight = port.viewport.clientHeight
  }

  get following(): boolean { return this.mode === 'following' }
  get navigating(): boolean { return this.mode === 'navigating' }

  pause(): void {
    this.cancelAnimation()
    this.revision++
    this.layoutAnchor = null
    this.destination = null
    this.mode = 'reading'
    this.position = captureReadingPosition(this.port.viewport)
    this.port.changed()
  }

  /**
   * 开始一次「向顶部插入历史」的事务。
   *
   * 分页 prepend 会重新分组过程块：块锚点可能消失、消息组也可能被重建，
   * 此时按锚点恢复会退回绝对位置，用户看到的就是「加载更早消息后跳到第一条」。
   * 因此 prepend 期间改用 scrollHeight 增量补偿——插入多少、视口就下移多少。
   * 基线只在加载停稳（1.2s 无新增长）或主动导航/跟随最新时释放：
   * 滚轮惯性会在加载过程中持续产生 scroll/resize，此时清基线会退回归锚点并跳回顶部。
   */
  beginPrepend(): void {
    this.pause()
    const el = this.port.viewport
    this.prependBaseline = { height: el.scrollHeight, top: el.scrollTop }
  }

  endPrepend(): void {
    this.clearPrepend()
  }

  private clearPrepend(): void {
    this.prependBaseline = null
    if (this.prependTimer !== null) {
      clearTimeout(this.prependTimer)
      this.prependTimer = null
    }
  }

  /**
   * 补偿后顺延收尾：滚轮惯性期间会连续产生 resize，
   * 只要还在长高就继续按增量保持；停稳 1.2s 后释放基线。
   */
  private schedulePrependSettle(): void {
    if (this.prependTimer !== null) clearTimeout(this.prependTimer)
    this.prependTimer = setTimeout(() => {
      this.prependBaseline = null
      this.prependTimer = null
    }, 1200)
  }

  follow(smooth = true): void {
    this.cancelAnimation()
    this.revision++
    this.layoutAnchor = null
    this.clearPrepend()
    this.destination = null
    this.mode = 'following'
    this.position = null
    this.port.changed()
    this.scroll(smooth)
  }

  userInput(): void {
    if (this.navigating) this.pause()
    this.userIntent = true
  }

  navigate(top: number, smooth = true): void {
    this.clearPrepend()
    this.pause()
    const target = this.clamp(top)
    this.destination = captureReadingPosition(this.port.viewport, target)
    this.mode = 'navigating'
    this.scroll(smooth)
  }

  restore(position: ReadingPosition): void {
    this.clearPrepend()
    this.pause()
    this.position = position
    this.write(readingTarget(this.port.viewport, position))
  }

  snapshot(): ReadingPosition | null {
    return this.following ? null : (this.destination ?? this.position)
  }

  /** 事务完成和取消均以代次隔离；用户操作优先于旧的异步布局。 */
  beginLayout(element?: HTMLElement): () => void {
    this.pause()
    const revision = this.revision
    if (element) this.layoutAnchor = { element, top: element.getBoundingClientRect().top }
    return () => {
      if (this.disposed || revision !== this.revision) return
      this.resized(false)
      this.layoutAnchor = null
      this.position = captureReadingPosition(this.port.viewport)
    }
  }

  dispose(): void {
    this.disposed = true
    this.clearPrepend()
    this.revision++
    this.cancelAnimation()
  }

  scrolled(): void {
    if (this.disposed || this.port.viewport.clientHeight <= 0) return
    const el = this.port.viewport
    // 明确用户输入后的微小位移不能被程序写入的 1px 容差吞掉。
    const ownWrite = this.writtenTop !== null && (this.userIntent
      ? el.scrollTop === this.writtenTop
      : Math.abs(el.scrollTop - this.writtenTop) < 1)
    const geometryChanged = this.height !== el.scrollHeight || this.viewportHeight !== el.clientHeight
    const topChanged = Math.abs(el.scrollTop - this.previousTop) > (this.userIntent ? 0 : 1)
    if (topChanged && !ownWrite && (!geometryChanged || this.userIntent) && !this.navigating) {
      if (this.following && el.scrollTop < this.previousTop) this.pause()
      else if (!this.following) {
        this.revision++
        this.layoutAnchor = null
        this.position = captureReadingPosition(el)
        if (el.scrollTop > this.previousTop && this.bottom() - el.scrollTop <= 4) this.follow(false)
      }
    }
    this.userIntent = false
    this.writtenTop = null
    this.previousTop = el.scrollTop
  }

  resized(smooth = true): void {
    if (this.disposed) return
    const el = this.port.viewport
    if (el.clientHeight <= 0) return
    // 浏览器可能先更新 scrollTop，再派发 resize，最后才通知 scroll。
    // 先接纳已发生的用户滚动，避免下方阅读锚点恢复把首个向上动作拉回底部。
    if (this.userIntent && el.scrollTop !== this.previousTop) this.scrolled()
    const viewportChanged = this.viewportHeight !== el.clientHeight
    this.height = el.scrollHeight
    this.viewportHeight = el.clientHeight
    if (this.mode === 'reading') {
      if (this.prependBaseline) {
        const growth = el.scrollHeight - this.prependBaseline.height
        if (growth > 0) {
          this.write(this.prependBaseline.top + growth)
          this.prependBaseline = { height: el.scrollHeight, top: el.scrollTop }
          this.schedulePrependSettle()
        }
      } else if (this.layoutAnchor) {
        this.write(el.scrollTop + this.layoutAnchor.element.getBoundingClientRect().top - this.layoutAnchor.top)
      } else if (this.position) this.write(readingTarget(el, this.position))
    } else {
      // 目标在每帧根据锚点/当前底部重算，导航不会在第一帧被resize终止。
      this.scroll(viewportChanged ? false : smooth)
    }
    this.previousTop = el.scrollTop
  }

  private bottom(): number {
    return Math.max(0, this.port.viewport.scrollHeight - this.port.viewport.clientHeight)
  }

  private clamp(top: number): number { return Math.max(0, Math.min(top, this.bottom())) }

  private target(): number {
    return this.following ? this.bottom()
      : this.clamp(this.destination ? readingTarget(this.port.viewport, this.destination) : this.port.viewport.scrollTop)
  }

  private scroll(smooth: boolean): void {
    if (this.disposed || this.port.viewport.clientHeight <= 0) return
    if (!smooth || this.port.reducedMotion?.()) {
      this.cancelAnimation()
      this.write(this.target())
      this.arrived()
      return
    }
    if (this.frame !== null) return
    const request = this.port.requestFrame ?? requestAnimationFrame
    const step: FrameRequestCallback = (tick) => {
      this.frame = null
      if (this.disposed || this.mode === 'reading' || this.port.viewport.clientHeight <= 0) return
      const target = this.target()
      const difference = target - this.port.viewport.scrollTop
      const dt = Math.max(1, Math.min(64, this.lastTick === null ? 16 : tick - this.lastTick))
      this.lastTick = tick
      if (Math.abs(difference) <= 1) {
        this.write(target)
        this.lastTick = null
        this.arrived()
        return
      }
      this.write(this.port.viewport.scrollTop + difference * (1 - Math.exp(-dt / 55)))
      this.frame = request(step)
    }
    this.frame = request(step)
  }

  private arrived(): void {
    if (!this.navigating) return
    this.mode = 'reading'
    this.destination = null
    this.position = captureReadingPosition(this.port.viewport)
    this.port.changed()
  }

  private cancelAnimation(): void {
    if (this.frame !== null) (this.port.cancelFrame ?? cancelAnimationFrame)(this.frame)
    this.frame = null
    this.lastTick = null
  }

  private write(top: number): void {
    this.port.viewport.scrollTop = this.clamp(top)
    this.writtenTop = this.port.viewport.scrollTop
    this.previousTop = this.port.viewport.scrollTop
    if (this.position) this.position = { ...this.position, top: this.previousTop }
  }
}
