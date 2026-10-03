export interface ReadingAnchor {
  kind?: 'message' | 'block'
  id: string
  offset: number
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
  return {
    top,
    anchor: node && id ? { kind, id, offset: node.getBoundingClientRect().top - bounds.top - delta } : null,
  }
}

export function readingTarget(viewport: HTMLElement, position: ReadingPosition): number {
  if (position.anchor) {
    const id = position.anchor.id
    const attribute = position.anchor.kind === 'block' ? 'data-scroll-anchor' : 'data-message-id'
    const nodes = Array.from(viewport.querySelectorAll<HTMLElement>(`[${attribute}]`))
    const node = nodes.find((candidate) => candidate.getAttribute(attribute) === id)
    if (node) {
      return Math.max(0, viewport.scrollTop + node.getBoundingClientRect().top
        - viewport.getBoundingClientRect().top - position.anchor.offset)
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

  follow(smooth = true): void {
    this.cancelAnimation()
    this.revision++
    this.layoutAnchor = null
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
    this.pause()
    const target = this.clamp(top)
    this.destination = captureReadingPosition(this.port.viewport, target)
    this.mode = 'navigating'
    this.scroll(smooth)
  }

  restore(position: ReadingPosition): void {
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
    this.revision++
    this.cancelAnimation()
  }

  scrolled(): void {
    if (this.disposed || this.port.viewport.clientHeight <= 0) return
    const el = this.port.viewport
    const ownWrite = this.writtenTop !== null && Math.abs(el.scrollTop - this.writtenTop) < 1
    const geometryChanged = this.height !== el.scrollHeight || this.viewportHeight !== el.clientHeight
    const topChanged = Math.abs(el.scrollTop - this.previousTop) > 1
    if (topChanged && !ownWrite && (!geometryChanged || this.userIntent) && !this.navigating) {
      if (this.following && el.scrollTop < this.previousTop - 1) this.pause()
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
    const viewportChanged = this.viewportHeight !== el.clientHeight
    this.height = el.scrollHeight
    this.viewportHeight = el.clientHeight
    if (this.mode === 'reading') {
      if (this.layoutAnchor) {
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
