import { describe, expect, test } from 'bun:test'
import { captureReadingPosition, ConversationScrollController, readingTarget } from './conversation-scroll-controller'

class GeometryViewport {
  scrollTop = 80
  scrollHeight = 2000
  clientHeight = 400
  nodes = [{ id: 'old-message', top: 0, height: 500 }]
  getBoundingClientRect() { return { top: 100, bottom: 100 + this.clientHeight } }
  querySelectorAll(selector: string) {
    if (selector === '[data-scroll-anchor]') return []
    return this.nodes.map((node) => ({
      getAttribute: () => node.id,
      contains: () => false,
      getBoundingClientRect: () => ({
        top: 100 + node.top - this.scrollTop,
        bottom: 100 + node.top + node.height - this.scrollTop,
      }),
    }))
  }
  scrollTo(options: ScrollToOptions) { this.scrollTop = options.top ?? this.scrollTop }
}

function setup() {
  const geometry = new GeometryViewport()
  const viewport = geometry as unknown as HTMLElement
  let tick = 0
  let nextId = 0
  const frames = new Map<number, FrameRequestCallback>()
  const controller = new ConversationScrollController({
    viewport,
    changed: () => {},
    requestFrame: (callback) => { frames.set(++nextId, callback); return nextId },
    cancelFrame: (id) => { frames.delete(id) },
  })
  const drain = (count = 60): void => {
    for (let i = 0; i < count; i++) {
      tick += 16
      const queued = [...frames.values()]
      frames.clear()
      queued.forEach(callback => callback(tick))
    }
  }
  return { geometry, viewport, controller, drain, frames }
}

describe('Conversation reading anchors', () => {
  test('preserves nonzero old top after prepend without counting simultaneous tail growth', () => {
    const { geometry, viewport } = setup()
    const saved = captureReadingPosition(viewport)
    geometry.nodes[0]!.top += 600
    geometry.scrollHeight += 720
    expect(readingTarget(viewport, saved)).toBe(680)
  })

  test('native browser anchoring is not compensated a second time', () => {
    const { geometry, viewport } = setup()
    const saved = captureReadingPosition(viewport)
    geometry.nodes[0]!.top += 600
    geometry.scrollTop += 600
    expect(readingTarget(viewport, saved)).toBe(680)
  })

  test('missing anchor falls back to absolute top, not distance from growing tail', () => {
    const { geometry, viewport } = setup()
    const saved = captureReadingPosition(viewport)
    geometry.nodes = []
    geometry.scrollHeight += 1000
    expect(readingTarget(viewport, saved)).toBe(80)
  })

  test('stable block anchor holds a reply while a process region above it collapses', () => {
    const { geometry, viewport } = setup()
    let replyTop = 200
    const message = {
      getAttribute: () => 'old-message',
      getBoundingClientRect: () => ({ top: 100 - geometry.scrollTop, bottom: 1000 - geometry.scrollTop }),
      contains: () => true,
    }
    const reply = {
      getAttribute: () => 'turn:block:21',
      getBoundingClientRect: () => ({ top: replyTop - geometry.scrollTop, bottom: replyTop + 300 - geometry.scrollTop }),
    }
    viewport.querySelectorAll = ((selector: string) => selector === '[data-scroll-anchor]' ? [reply] : [message]) as unknown as HTMLElement['querySelectorAll']
    const saved = captureReadingPosition(viewport)
    expect(saved.anchor?.kind).toBe('block')
    replyTop -= 60
    expect(readingTarget(viewport, saved)).toBe(20)
  })

  test('viewport moved on the page does not alter the relative anchor offset', () => {
    const { viewport } = setup()
    const saved = captureReadingPosition(viewport)
    viewport.getBoundingClientRect = () => ({ top: 300, bottom: 700 }) as DOMRect
    const node = { getAttribute: () => 'old-message', getBoundingClientRect: () => ({ top: 220, bottom: 720 }) }
    viewport.querySelectorAll = (() => [node]) as unknown as HTMLElement['querySelectorAll']
    expect(readingTarget(viewport, saved)).toBe(80)
  })
})

describe('Conversation scroll policy', () => {
  test('viewport-only shrinking follows when pinned', () => {
    const { geometry, controller } = setup()
    geometry.scrollTop = 1600
    geometry.clientHeight = 300
    controller.resized()
    expect(geometry.scrollTop).toBe(1700)
  })

  test('content growth after pause keeps the anchor and does not restart following', () => {
    const { geometry, controller } = setup()
    controller.pause()
    geometry.scrollHeight += 120
    controller.resized()
    expect(geometry.scrollTop).toBe(80)
    expect(controller.following).toBe(false)
  })

  test('shrinking content to near-bottom does not unlock explicitly paused reading', () => {
    const { geometry, controller } = setup()
    controller.pause()
    geometry.scrollHeight = 540
    controller.resized()
    expect(controller.following).toBe(false)
    expect(geometry.scrollTop).toBe(80)
  })

  test('prepended content preserves the reading position throughout a pending transaction', () => {
    const { geometry, controller } = setup()
    const finish = controller.beginLayout()
    geometry.nodes[0]!.top = 600
    geometry.scrollHeight += 720
    controller.resized()
    expect(geometry.scrollTop).toBe(680)
    controller.scrolled()
    finish()
    expect(geometry.scrollTop).toBe(680)
  })

  test('user navigation invalidates old async completion', () => {
    const { geometry, controller } = setup()
    const finish = controller.beginLayout()
    controller.navigate(250, false)
    finish()
    expect(geometry.scrollTop).toBe(250)
  })

  test('unmount invalidates old async completion', () => {
    const { geometry, controller } = setup()
    const finish = controller.beginLayout()
    controller.dispose()
    geometry.nodes[0]!.top += 600
    finish()
    expect(geometry.scrollTop).toBe(80)
  })

  test('anchor chosen by a user scroll replaces the old reading position', () => {
    const { geometry, controller } = setup()
    controller.pause()
    geometry.scrollTop = 100
    controller.scrolled()
    geometry.nodes[0]!.top += 600
    geometry.scrollHeight += 600
    controller.resized()
    expect(geometry.scrollTop).toBe(700)
  })

  test('programmatic restoration scroll event does not discard the saved anchor', () => {
    const { geometry, controller } = setup()
    controller.pause()
    geometry.nodes[0]!.top = 600
    geometry.scrollHeight += 600
    controller.resized()
    controller.scrolled()
    geometry.nodes[0]!.top += 20
    geometry.scrollHeight += 20
    controller.resized()
    expect(geometry.scrollTop).toBe(700)
  })

  test('manual scroll up pauses, explicit follow resumes', () => {
    const { geometry, controller, drain } = setup()
    geometry.scrollTop = 40
    controller.scrolled()
    expect(controller.following).toBe(false)
    controller.follow()
    expect(controller.following).toBe(true)
    drain()
    expect(geometry.scrollTop).toBe(1600)
  })

  test('scrolling down to bottom can resume, layout shrink alone cannot', () => {
    const { geometry, controller } = setup()
    controller.pause()
    geometry.scrollTop = 1600
    controller.scrolled()
    expect(controller.following).toBe(true)
  })

  test('folded region uses its bottom anchor rather than the encompassing message', () => {
    const { geometry, controller } = setup()
    let anchorTop = 300
    const anchor = { getBoundingClientRect: () => ({ top: anchorTop }) } as HTMLElement
    const finish = controller.beginLayout(anchor)
    anchorTop += 600
    geometry.scrollHeight += 600
    controller.resized()
    expect(geometry.scrollTop).toBe(680)
    // 模拟真实scrollTop写入对临时锚点视口坐标的影响。
    anchorTop -= 600
    finish()
    expect(geometry.scrollTop).toBe(680)
    expect(controller.following).toBe(false)
  })

  test('content shrink clamping scrollTop does not count as a user escape from follow', () => {
    const { geometry, controller } = setup()
    controller.follow(false)
    controller.scrolled()
    geometry.scrollHeight = 1400
    geometry.scrollTop = 1000
    controller.scrolled()
    controller.resized()
    expect(controller.following).toBe(true)
  })

  test('native prepend scroll anchoring does not update the reading choice before observer', () => {
    const { geometry, controller } = setup()
    controller.pause()
    geometry.nodes[0]!.top += 600
    geometry.scrollHeight += 720
    geometry.scrollTop += 600
    controller.scrolled()
    controller.resized()
    expect(geometry.scrollTop).toBe(680)
    expect(controller.snapshot()?.anchor?.offset).toBe(-80)
  })

  test('tail growth and user scrolling in the same frame preserve the new reading choice', () => {
    const { geometry, controller } = setup()
    controller.pause()
    geometry.scrollTop = 140
    geometry.scrollHeight += 120
    controller.userInput()
    controller.scrolled()
    controller.resized()
    expect(geometry.scrollTop).toBe(140)
    expect(controller.following).toBe(false)
  })

  test('instant navigation establishes its target anchor before any resize event', () => {
    const { geometry, controller } = setup()
    controller.navigate(250, false)
    geometry.scrollHeight += 120
    controller.scrolled()
    controller.resized()
    expect(geometry.scrollTop).toBe(250)
  })

  test('hidden tab resizing does not write its stored reading position', () => {
    const { geometry, controller } = setup()
    controller.pause()
    const snapshot = controller.snapshot()
    geometry.clientHeight = 0
    geometry.scrollTop = 0
    controller.resized()
    expect(geometry.scrollTop).toBe(0)
    expect(controller.snapshot()).toEqual(snapshot)
  })

  test('controller effect replay can restore both reading mode and position', () => {
    const { geometry, viewport, controller } = setup()
    controller.pause()
    const snapshot = controller.snapshot()!
    controller.dispose()
    const replayed = new ConversationScrollController({ viewport, changed: () => {} })
    replayed.restore(snapshot)
    expect(replayed.following).toBe(false)
    expect(replayed.snapshot()).toEqual(snapshot)
    geometry.scrollHeight += 120
    replayed.resized()
    expect(geometry.scrollTop).toBe(80)
  })

  test('smooth navigation survives the first frame and a concurrent content resize', () => {
    const { geometry, controller, drain } = setup()
    controller.navigate(600, true)
    drain(1)
    expect(controller.navigating).toBe(true)
    const firstStep = geometry.scrollTop
    expect(firstStep).toBeGreaterThan(80)
    expect(firstStep).toBeLessThan(600)
    controller.scrolled()
    geometry.scrollHeight += 100
    controller.resized()
    expect(controller.navigating).toBe(true)
    drain()
    expect(geometry.scrollTop).toBe(600)
    expect(controller.navigating).toBe(false)
    expect(controller.following).toBe(false)
  })

  test('navigation destination moves with prepend rather than drifting to an unrelated coordinate', () => {
    const { geometry, controller, drain } = setup()
    geometry.nodes[0]!.height = 1200
    controller.navigate(600, true)
    drain(1)
    geometry.nodes[0]!.top += 200
    geometry.scrollHeight += 200
    controller.resized()
    drain()
    expect(geometry.scrollTop).toBe(800)
  })

  test('user input cancels navigation and old frames cannot move the new reading position', () => {
    const { geometry, controller, drain, frames } = setup()
    controller.navigate(600, true)
    drain(1)
    controller.userInput()
    expect(controller.navigating).toBe(false)
    expect(frames.size).toBe(0)
    geometry.scrollTop = 120
    controller.scrolled()
    drain()
    expect(geometry.scrollTop).toBe(120)
  })

  test('selection pause is the same reading mode used by resize and bottom button', () => {
    const { geometry, controller, drain, frames } = setup()
    controller.follow()
    controller.pause()
    geometry.scrollHeight += 120
    controller.resized()
    drain()
    expect(controller.following).toBe(false)
    expect(frames.size).toBe(0)
    expect(geometry.scrollTop).toBe(80)
  })

  test('reduced motion applies both navigation and continuous bottom follow instantly', () => {
    const geometry = new GeometryViewport()
    const controller = new ConversationScrollController({
      viewport: geometry as unknown as HTMLElement, changed: () => {}, reducedMotion: () => true,
    })
    controller.navigate(600, true)
    expect(geometry.scrollTop).toBe(600)
    expect(controller.navigating).toBe(false)
    controller.follow()
    expect(geometry.scrollTop).toBe(1600)
    geometry.scrollHeight += 100
    controller.resized()
    expect(geometry.scrollTop).toBe(1700)
  })

  test('unmount cancels animation frames', () => {
    const { controller, frames, geometry, drain } = setup()
    controller.navigate(600, true)
    controller.dispose()
    expect(frames.size).toBe(0)
    drain()
    expect(geometry.scrollTop).toBe(80)
  })

  test('reading snapshot remains stable even after hidden DOM geometry changes', () => {
    const { geometry, controller } = setup()
    controller.pause()
    const saved = controller.snapshot()
    geometry.clientHeight = 0
    expect(controller.snapshot()).toEqual(saved)
  })
})
