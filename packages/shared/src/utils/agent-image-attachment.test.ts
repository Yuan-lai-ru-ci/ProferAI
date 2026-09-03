import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_IMAGE_ATTACHMENT_PROMPT,
  isImageAttachmentMediaType,
  resolveAgentAttachmentPrompt,
} from './agent-image-attachment'

describe('Agent 图片附件默认行为', () => {
  test('Given 仅图片附件且无文字 When 构造任务 Then 要求读图并结合上下文推断任务', () => {
    expect(resolveAgentAttachmentPrompt('', ['image'])).toBe(DEFAULT_IMAGE_ATTACHMENT_PROMPT)
    expect(resolveAgentAttachmentPrompt('   ', ['image', 'image'])).toContain('立即使用 Read 工具读取所有图片')
    expect(DEFAULT_IMAGE_ATTACHMENT_PROMPT).toContain('结合当前对话上下文、用户近期目标和图片内容')
    expect(DEFAULT_IMAGE_ATTACHMENT_PROMPT).toContain('不要将“描述图片”作为默认目标')
    expect(DEFAULT_IMAGE_ATTACHMENT_PROMPT).toContain('仅当上下文和图片内容均不足以可靠推断任务时')
  })

  test('Given 用户提供文字任务 When 构造任务 Then 保留用户任务', () => {
    expect(resolveAgentAttachmentPrompt('提取图片里的表格', ['image'])).toBe('提取图片里的表格')
  })

  test('Given 非图片或混合附件且无文字 When 构造任务 Then 保持查看附件语义', () => {
    expect(resolveAgentAttachmentPrompt('', ['file'])).toBe('请查看上面附加的文件。')
    expect(resolveAgentAttachmentPrompt('', ['image', 'file'])).toBe('请查看上面附加的文件。')
  })

  test('Given MIME type When 判断图片附件 Then 正确识别 image 类型', () => {
    expect(isImageAttachmentMediaType('image/png')).toBe(true)
    expect(isImageAttachmentMediaType('IMAGE/WEBP')).toBe(true)
    expect(isImageAttachmentMediaType('application/pdf')).toBe(false)
    expect(isImageAttachmentMediaType(undefined)).toBe(false)
  })
})
