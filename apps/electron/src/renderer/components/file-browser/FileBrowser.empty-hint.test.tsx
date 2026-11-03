import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { FileBrowser } from './FileBrowser'

const PROJECT_HINT = '这里是工作区产物目录（.profer/workspace-files）。项目源码请查看左侧文件浏览器或「会话文件」。'

describe('FileBrowser 空目录说明', () => {
  test('未传 emptyHint 时保持原文案', () => {
    const html = renderToStaticMarkup(<FileBrowser rootPath="/tmp/profer-empty" embedded hideToolbar />)
    expect(html).toContain('目录为空')
    expect(html).not.toContain('工作区产物目录')
  })

  test('project 工作区传入产物区说明后不再显示「目录为空」', () => {
    const html = renderToStaticMarkup(
      <FileBrowser rootPath="/tmp/profer-empty" embedded hideToolbar emptyHint={PROJECT_HINT} />,
    )
    expect(html).toContain('工作区产物目录')
    expect(html).not.toContain('目录为空')
  })
})
