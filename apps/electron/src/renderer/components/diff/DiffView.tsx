/**
 * DiffView — @pierre/diffs 渲染组件
 *
 * 接收 old/new 文件内容，使用 @pierre/diffs/react 的 MultiFileDiff 渲染。
 * 背景使用 Proma 主题色（disableBackground），滚动条自定义样式。
 */

import * as React from 'react'
import { MultiFileDiff } from '@pierre/diffs/react'
import type { FileContents } from '@pierre/diffs'
import './diff-scroll.css'

interface DiffViewProps {
  oldContent: string
  newContent: string
  filePath: string
  viewMode: 'split' | 'unified'
}

export const DiffView = React.memo(function DiffView({ oldContent, newContent, filePath, viewMode }: DiffViewProps): React.ReactElement {
  const oldFile: FileContents = React.useMemo(() => ({
    name: filePath,
    contents: oldContent,
  }), [filePath, oldContent])

  const newFile: FileContents = React.useMemo(() => ({
    name: filePath,
    contents: newContent,
  }), [filePath, newContent])

  const options = React.useMemo(() => ({
    diffStyle: viewMode,
    theme: { dark: 'pierre-dark' as const, light: 'pierre-light' as const },
    disableFileHeader: true,
    disableBackground: true,
    hunkSeparators: 'line-info' as const,
    overflow: 'scroll' as const,
  }), [viewMode])

  return (
    <div className="h-full diff-scroll bg-[hsl(var(--background))] overflow-auto">
      <MultiFileDiff oldFile={oldFile} newFile={newFile} options={options} className="h-full" />
    </div>
  )
})
