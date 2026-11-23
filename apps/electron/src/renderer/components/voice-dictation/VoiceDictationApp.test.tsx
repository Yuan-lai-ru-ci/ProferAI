import { expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { VoiceDictationApp } from './VoiceDictationApp'

test('语音待机展示使用统一滚动区，保留写入目标与取消名称', () => {
  const html = renderToStaticMarkup(<VoiceDictationApp />)
  expect(html).toContain('aria-label="取消并关闭"')
  expect(html).toContain('profer-scroll-region')
  expect(html).toContain('Profer 激活时写入 Chat / Agent')
  expect(html).toContain('等待 Ctrl+～ 唤起')
  expect(html).not.toContain('scrollbar-width:none')
  expect(html).not.toContain('aria-label="停止录音"')
})
