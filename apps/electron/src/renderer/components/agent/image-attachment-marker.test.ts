import { describe, expect, test } from 'bun:test'
import { parseAgentImageAttachmentMarkers } from './image-attachment-marker'

const validMarker = '[PROMA_IMAGE_ATTACHMENT:{"localPath":"C:/Users/test/.profer/agent-workspaces/ws/session/.context/agent-output-images/id.png","filename":"chart.png","mediaType":"image/png"}]'

describe('parseAgentImageAttachmentMarkers', () => {
  test('Given a supported image marker in final text When parsing Then it returns an image and clean text', () => {
    const parsed = parseAgentImageAttachmentMarkers(`图片已准备好。\n${validMarker}\n请查看。`)

    expect(parsed.images).toEqual([{
      localPath: 'C:/Users/test/.profer/agent-workspaces/ws/session/.context/agent-output-images/id.png',
      filename: 'chart.png',
      mediaType: 'image/png',
    }])
    // 保持既有解析器的 Markdown 段落间距：移除独占 marker 行后留下一个空行。
    expect(parsed.cleanText).toBe('图片已准备好。\n\n请查看。')
  })

  test('Given an SVG or malformed marker When parsing Then it removes the marker without exposing an image', () => {
    const svg = '[PROMA_IMAGE_ATTACHMENT:{"localPath":"C:/unsafe.svg","filename":"unsafe.svg","mediaType":"image/svg+xml"}]'
    const malformed = '[PROMA_IMAGE_ATTACHMENT:not-json]'

    const parsed = parseAgentImageAttachmentMarkers(`before ${svg} ${malformed} after`)

    expect(parsed.images).toEqual([])
    expect(parsed.cleanText).toBe('before   after')
  })

  test('Given a marker missing mandatory fields When parsing Then it does not pass it to the image loader', () => {
    const parsed = parseAgentImageAttachmentMarkers('[PROMA_IMAGE_ATTACHMENT:{"localPath":"C:/safe.png","mediaType":"image/png"}]')

    expect(parsed.images).toEqual([])
    expect(parsed.cleanText).toBe('')
  })
})
