import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SDKThinkingBlock } from '@profer/shared'
import { ContentBlock } from './ContentBlock'

const thinkingBlock = (thinking: string): SDKThinkingBlock => ({ type: 'thinking', thinking })

describe('思考块渲染', () => {
  test('只有空白字符的思考块不渲染，避免出现空虚线框', () => {
    expect(renderToStaticMarkup(<ContentBlock block={thinkingBlock(' ')} allMessages={[]} />)).toBe('')
    expect(renderToStaticMarkup(<ContentBlock block={thinkingBlock('\n  \n')} allMessages={[]} />)).toBe('')
  })

  test('正常思考块只保留「思考摘要」标题，不加额外说明文案', () => {
    const html = renderToStaticMarkup(
      <ContentBlock block={thinkingBlock('先确认存储路径，再改渲染层。')} allMessages={[]} forceExpandThinking />,
    )

    expect(html).toContain('思考摘要')
    expect(html).not.toContain('本轮没有正文')
  })
})
