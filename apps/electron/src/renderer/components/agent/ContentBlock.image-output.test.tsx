import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SDKToolUseBlock } from '@profer/shared'
import { ContentBlock } from './ContentBlock'

const imageTool = (): SDKToolUseBlock => ({
  type: 'tool_use',
  id: 'image-1',
  name: 'generate_image',
  input: { prompt: 'a pelican on a bicycle' },
})

const image = { localPath: '/tmp/render.png', filename: 'render.png', mediaType: 'image/png' as const }

describe('过程阶段图片就地渲染', () => {
  test('传入 imageAttachments 时在工具行下方渲染图片块', () => {
    const html = renderToStaticMarkup(
      <ContentBlock block={imageTool()} allMessages={[]} imageAttachments={[image]} />,
    )

    expect(html).toContain('data-agent-image-output')
    // 工具行保留，图片就近可溯源（SSR 阶段图片本体是加载骨架）。
    expect(html).toContain('生成图片')
  })

  test('不传 imageAttachments 时不渲染图片块（尾部交付由 turn 级内容块渲染）', () => {
    const html = renderToStaticMarkup(<ContentBlock block={imageTool()} allMessages={[]} />)

    expect(html).not.toContain('data-agent-image-output')
  })
})
