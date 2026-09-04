import { describe, expect, test } from 'bun:test'
import { AgentFilePreviewSessionManager } from './agent-file-preview-session'

const openEvent = {
  type: 'preview_requested' as const,
  requestId: 'request-1',
  sessionId: 'session-1',
  filePath: '/safe/deck.pptx',
  revision: 'sha256:one',
  readOnly: true,
}

describe('AgentFilePreviewSessionManager', () => {
  test('Given a visible viewer When the matching revision becomes ready Then open resolves', async () => {
    const manager = new AgentFilePreviewSessionManager(100)
    const emitted: unknown[] = []
    const promise = manager.waitUntilReady(openEvent, (event) => emitted.push(event))
    expect(emitted).toEqual([openEvent])
    expect(manager.reportReady({
      requestId: openEvent.requestId,
      sessionId: openEvent.sessionId,
      filePath: openEvent.filePath,
      revision: openEvent.revision,
      status: 'ready',
      slideCount: 3,
      currentSlide: 1,
      scale: 0.8,
    })).toBe(true)
    await expect(promise).resolves.toMatchObject({ status: 'ready', slideCount: 3 })
  })

  test('Given renderer claims ready without a valid slide count When reported Then open rejects', async () => {
    const manager = new AgentFilePreviewSessionManager(100)
    const promise = manager.waitUntilReady(openEvent, () => {})
    manager.reportReady({ ...openEvent, status: 'ready', slideCount: 0, currentSlide: 1 })
    await expect(promise).rejects.toThrow('缺少有效页数')
  })

  test('Given the viewer fails When renderer reports error Then open rejects', async () => {
    const manager = new AgentFilePreviewSessionManager(100)
    const promise = manager.waitUntilReady(openEvent, () => {})
    manager.reportReady({ ...openEvent, status: 'error', error: 'WASM parse failed' })
    await expect(promise).rejects.toThrow('WASM parse failed')
  })

  test('Given a stale renderer When its revision differs Then open rejects', async () => {
    const manager = new AgentFilePreviewSessionManager(100)
    const promise = manager.waitUntilReady(openEvent, () => {})
    manager.reportReady({ ...openEvent, revision: 'sha256:stale', status: 'ready' })
    await expect(promise).rejects.toThrow('viewer revision 与磁盘文件不一致')
  })

  test('Given no renderer acknowledgement When timeout elapses Then open rejects', async () => {
    const manager = new AgentFilePreviewSessionManager(5)
    await expect(manager.waitUntilReady(openEvent, () => {})).rejects.toThrow('加载超时')
  })

  test('Given a ready visible viewer When inspection returns matching images Then inspection resolves', async () => {
    const manager = new AgentFilePreviewSessionManager(100)
    const request = {
      requestId: 'inspect-1',
      sessionId: 'session-1',
      filePath: '/safe/deck.pptx',
      revision: 'sha256:one',
      scope: 'all' as const,
    }
    const emitted: unknown[] = []
    const promise = manager.inspect(request, (event) => emitted.push(event))
    expect(emitted).toEqual([{ type: 'preview_inspection_requested', request }])
    manager.reportInspection({
      ...request,
      slideCount: 1,
      currentSlide: 1,
      images: [{ page: 1, data: 'PNG', mediaType: 'image/png' }],
    })
    await expect(promise).resolves.toMatchObject({ slideCount: 1, images: [{ page: 1 }] })
  })
})
